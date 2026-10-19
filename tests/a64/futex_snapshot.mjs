#!/usr/bin/env node
// Condition variables across snapshots (docs/aarch64.md's known defects:
// Android stalled after a restore, a thread waiting for good for a task the
// others had finished): tests/a64/android/futex_stress.c, bionic's mutexes
// and condition variables in ping-pong pairs and in ANGLE's worker pool's
// pattern, runs in Alpine's initramfs on v86's cores while this test saves
// and restores the machine in place every few seconds; any group that
// stops making progress for 10 s fails it.
//
//   node tests/a64/futex_snapshot.mjs
//
// A64_CORES (4), A64_PARALLEL (1: cores in vCPU workers), A64_JIT (1: the
// page tier), A64_FUTEX_SECONDS (the stress's run, 120),
// A64_FUTEX_SNAPSHOT_MS (between snapshots, 3000; 0: none),
// A64_FUTEX_SNAPSHOT=inplace (save and restore into this machine, the
// default), fresh (into a new machine each time) or pause (only stopped),
// A64_FUTEX_ARGS (pairs, workers, tasks: "4 4 8"), A64_KERNEL_FILE (another
// Image, e.g. Android's GKI kernel), A64_VERBOSE=1 (the serial console).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { prepare, ROOT } from "../lib/alpine_image.mjs";

const cores = +(process.env.A64_CORES || 4);
const parallel = !!+(process.env.A64_PARALLEL ?? 1);
const jit = !!+(process.env.A64_JIT ?? 1);
const seconds = +(process.env.A64_FUTEX_SECONDS || 120);
const period = +(process.env.A64_FUTEX_SNAPSHOT_MS ?? 3000);
const mode = process.env.A64_FUTEX_SNAPSHOT || "inplace";
assert.ok(["inplace", "fresh", "pause"].includes(mode), "A64_FUTEX_SNAPSHOT: inplace, fresh or pause");
const verbose = !!+process.env.A64_VERBOSE;

function run(program, args)
{
    const result = spawnSync(program, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr || result.error}`);
    return result.stdout;
}

const prepared = await prepare("aarch64-virt", ["boot/vmlinuz-virt", "boot/initramfs-virt"]);
const directory = prepared.directory + "futex/";
fs.mkdirSync(directory + "root", { recursive: true });
const ndk = process.env.ANDROID_NDK_HOME || os.homedir() + "/Library/Android/sdk/ndk/26.1.10909125";
run(ndk + "/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android29-clang",
    ["-static", "-O2", "-Wall", ROOT + "tests/a64/android/futex_stress.c", "-o", directory + "root/futex-stress"]);
fs.writeFileSync(directory + "root/futex-init", [
    "#!/bin/busybox sh",
    "B=/bin/busybox",
    "$B mount -t proc proc /proc; $B mount -t sysfs sys /sys; $B mount -t devtmpfs dev /dev",
    // (the CPUs' clocks before and after: tests/a64/android/futex_stress.c's clock mode)
    `/futex-stress clock ${cores}; $B echo FS_START; /futex-stress ${seconds} ${process.env.A64_FUTEX_ARGS || "4 4 8"}; $B echo FS_EXIT=$?; ` +
        `/futex-stress clock ${cores}; $B echo FS_CLOCKS_DONE`,
    "$B poweroff -f",
    ""].join("\n"), { mode: 0o755 });
run("bsdtar", ["--format", "newc", "--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata", "-cf", directory + "futex.cpio",
    "-C", directory + "root", "futex-init", "futex-stress"]);
const initrd = directory + "initramfs-virt+futex.cpio";
fs.writeFileSync(initrd, Buffer.concat([fs.readFileSync(prepared.initrd), fs.readFileSync(directory + "futex.cpio")]));

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const options = {
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: 512 << 20, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: process.env.A64_KERNEL_FILE || prepared.kernel }, initrd: { url: initrd },
    cmdline: "console=ttyAMA0 nokaslr panic=-1 rdinit=/futex-init",
    ...(jit ? { jit_switches: { a64_page: 1 } } : {}),
    ...(parallel ? { parallel: true, parallel_wasm_path: process.env.A64_PARALLEL_WASM || ROOT + "build/v86-arm64-parallel.wasm" } : {}),
};

let transcript = "";
const on_byte = byte => {
    const c = String.fromCharCode(byte);
    transcript += c;
    if(verbose) process.stdout.write(c);
    else if(c === "\n")
    {
        const line = transcript.slice(transcript.lastIndexOf("\n", transcript.length - 2) + 1, -1);
        if(/^FS(_STALL|_DONE|_EXIT|_START|_CLOCK)/.test(line)) console.log(line);
    }
};
let emulator = new V86({ ...options, autostart: true });
emulator.add_listener("serial0-output-byte", on_byte);

const started = performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshots = [];
async function snapshot()
{
    await emulator.stop();
    const t0 = performance.now();
    if(mode === "pause")
    {
        await sleep(500);
    }
    else if(mode === "inplace")
    {
        const state = await emulator.save_state();
        await emulator.restore_state(state);
    }
    else
    {
        const state = await emulator.save_state();
        await emulator.destroy();
        emulator = new V86({ ...options, autostart: false });
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        await emulator.restore_state(state);
        emulator.add_listener("serial0-output-byte", on_byte);
    }
    snapshots.push(Math.round(performance.now() - t0));
    emulator.run();
}

const deadline = started + (seconds + 240) * 1000;
let next = 0;
while(!/FS_CLOCKS_DONE/.test(transcript))
{
    assert.ok(performance.now() < deadline, "deadline; the console's last lines:\n" + transcript.split("\n").slice(-20).join("\n"));
    await sleep(100);
    if(period && /^FS 2 /m.test(transcript) && !/FS_DONE/.test(transcript) && performance.now() >= next)
    {
        if(next) await snapshot();
        next = performance.now() + period;
    }
}
await emulator.destroy();
const stalls = transcript.split("\n").filter(line => line.startsWith("FS_STALL"));
const last = transcript.split("\n").filter(line => /^FS \d+ /.test(line)).pop();
// (each CPU's largest clock step, before the stress and after its snapshots)
const clock_steps = [...transcript.matchAll(/^FS_CLOCK cpu=(\d+) reads=\d+ max_step_us=(\d+)/gm)].map(m => +m[2]);
const result = { cores, parallel, jit, mode, period, snapshots: snapshots.length, snapshot_ms_median: snapshots.sort((a, b) => a - b)[snapshots.length >> 1] ?? null,
    last, stalls, clock_steps_us: { before: clock_steps.slice(0, cores), after: clock_steps.slice(cores) }, ms: Math.round(performance.now() - started) };
console.log(JSON.stringify(result));
assert.equal(stalls.length, 0, "a group stopped making progress: " + stalls.join("; "));
assert.match(transcript, /FS_EXIT=0/);
console.log("futex_snapshot: passed");
process.exit(0);
