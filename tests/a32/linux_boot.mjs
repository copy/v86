#!/usr/bin/env node
// Unmodified Alpine Linux 3.24.3 armv7 on cpu_type "arm32" (docs/aarch32-plan.md
// R5.2) and on the reference, QEMU 9.2's cortex-a15 on the 32-bit virt board
// (tests/a32/runner.mjs's machine): the netboot release's kernel (a zImage),
// initramfs and modloop, pinned and downloaded once into build/a32-linux/.
// A32_STAGE:
//
// - "initramfs" (the default): the initramfs and a cpio of /a32-init and the
//   32-bit workload (tests/lib/aarch32_workload.mjs: the probe built for A32
//   and T32, Alpine's armv7 programs in a chroot), rdinit=/a32-init: the
//   workload, /proc/interrupts, poweroff. The workload's lines must be the
//   reference's but where the CPUs differ on purpose: profile arm32-v1 has
//   the crypto instructions and CRC32, QEMU's cortex-a15 not (HWCAP2, the
//   Features, the probe's AES, SHA and VMULL.P64 answers, which must be
//   the known ones of the 64-bit reference's compat tasks instead).
// - "single": Alpine's init in single mode to its shell (a root that does
//   not exist), /proc/interrupts, A32_SINGLE_OK, poweroff.
// - "lifecycle" (v86): single mode, a snapshot saved there and restored
//   into a new machine whose shell goes on, "reboot -f" (PSCI SYSTEM_RESET)
//   back to single mode, "poweroff -f" (SYSTEM_OFF) stopping the machine.
// - "live": boot media on a virtio-blk disk (a FAT image: the rpi
//   release's apks/ and the netboot modloop); Alpine's init installs
//   alpine-base from it, OpenRC boots to "localhost login:", root logs in,
//   uname, /proc/cpuinfo and a few commands, poweroff.
//
// A32_LINUX_TARGET=qemu|v86|both (both: the reference first, its transcript
// kept for the comparison), A32_CORES (1, 2, 4), A32_LINUX_TIMEOUT (ms),
// A32_JIT=1 the page tier (once it runs arm32's code, R5.3).
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, sha256 } from "../lib/alpine_image.mjs";
import { aarch32_workload } from "../lib/aarch32_workload.mjs";
import { qemu_binary, smp } from "../a64/guest_runner.mjs";
import { QEMU_MACHINE32, QEMU_CPU32 } from "./runner.mjs";

const RELEASE = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/armv7/";
// (the SHA-256s of 2026-10-24's downloads; the rpi tarball's matches its published .sha256)
const FILES = {
    "vmlinuz-lts": { url: RELEASE + "netboot-3.24.3/vmlinuz-lts", sha256: "e8dc515bbd3b7eaff8839c1c99acf85abf7b1c38eeeb5f18f97adf326fa6b137" },
    "initramfs-lts": { url: RELEASE + "netboot-3.24.3/initramfs-lts", sha256: "f46df12efee6e009a59649b7ff75a53b341d469806bf017ec8db3c8d3ea3379f" },
    "modloop-lts": { url: RELEASE + "netboot-3.24.3/modloop-lts", sha256: "5caa967c2613c0d44b5febc402052dc6950dfc207e157ce41aa7146010f55acb" },
    "alpine-rpi-3.24.3-armv7.tar.gz": { url: RELEASE + "alpine-rpi-3.24.3-armv7.tar.gz",
        sha256: "555ce15b7fc1460ce1286dc9f2e3c1875d4235a21e19c963be1650cd32bfef95" },
};
// the crypto instructions' answers (tests/a64/linux_probe32.c; QEMU's cortex-a35 running the probe as a compat task)
const KNOWN = { aes: "02833fe0ccba6526f2e061546d959bd4", sha: "2c0657a2c2d6e0dfc2c43f321a2a21ec", pmull: "02ecfcfc0154ff4403fcfdec0044fe54" };
// (and ThumbEE, which the cortex-a15 has and ARMv8 not; HWCAP's bit 11)
const DIFFERENT_FEATURES = ["thumbee", "aes", "pmull", "sha1", "sha2", "crc32"];
const HWCAP_THUMBEE = 1 << 11;
// v86's HWCAP2: AES, PMULL, SHA1, SHA2, CRC32
const V86_HWCAP2 = 0x1F;

const stage = process.env.A32_STAGE || "initramfs";
assert.ok(["initramfs", "single", "lifecycle", "live"].includes(stage), "A32_STAGE is initramfs, single, lifecycle or live");
const cores = Number(process.env.A32_CORES || 1);
assert.ok([1, 2, 4].includes(cores), "A32_CORES is 1, 2 or 4");
const target = process.env.A32_LINUX_TARGET || (stage === "lifecycle" ? "v86" : "both");
assert.ok(["qemu", "v86", "both"].includes(target), "A32_LINUX_TARGET is qemu, v86 or both");
assert.ok(stage !== "lifecycle" || target === "v86", "the lifecycle stage is v86's");
const jit = !!+process.env.A32_JIT;
const timeout = Number(process.env.A32_LINUX_TIMEOUT || (stage === "initramfs" || stage === "live" ? 1800000 : 600000));
const directory = ROOT + "build/a32-linux/";
fs.mkdirSync(directory, { recursive: true });

function run(program, args, options = {})
{
    const result = spawnSync(program, args, { encoding: "utf8", ...options });
    assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr || result.error}`);
    return result.stdout.trim();
}

for(const [name, file] of Object.entries(FILES))
{
    if(name.startsWith("alpine-rpi") && stage !== "live") continue;
    const local = directory + name;
    if(!fs.existsSync(local))
    {
        const response = await fetch(file.url);
        assert.ok(response.ok, `${file.url}: HTTP ${response.status}`);
        fs.writeFileSync(local + ".tmp", Buffer.from(await response.arrayBuffer()));
        fs.renameSync(local + ".tmp", local);
    }
    assert.equal(sha256(fs.readFileSync(local)), file.sha256, "the pinned " + name);
}
const kernel = directory + "vmlinuz-lts";
const tar_args = ["--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata"];

// the initramfs stage's initrd: Alpine's and the workload's cpio after it
let initrd = directory + "initramfs-lts";
if(stage === "initramfs")
{
    const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
    const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
    const staging = directory + "root/";
    await aarch32_workload({ staging, objects: directory, run, lld, prefix: "a32" });
    fs.writeFileSync(staging + "a32-init", [
        "#!/bin/busybox sh",
        "B=/bin/busybox",
        "$B mount -t proc proc /proc; $B mount -t sysfs sys /sys; $B mount -t devtmpfs dev /dev",
        "$B mkdir -p /tmp; $B mount -t tmpfs tmp /tmp",
        "$B echo A32_INIT_START cpus=$($B nproc) machine=$($B uname -m)",
        "/a32-aarch32-workload",
        "$B cat /proc/interrupts",
        "$B echo A32_INIT_DONE",
        "$B poweroff -f",
        ""].join("\n"), { mode: 0o755 });
    run("bsdtar", ["--format", "newc", ...tar_args, "-cf", directory + "root.cpio", "-C", staging, "."]);
    initrd = directory + "initramfs-lts+root.cpio";
    // (the next archive starts 4-byte aligned after a compressed one: init/initramfs.c)
    const alpine = fs.readFileSync(directory + "initramfs-lts");
    fs.writeFileSync(initrd, Buffer.concat([alpine, Buffer.alloc(-alpine.length & 3), fs.readFileSync(directory + "root.cpio")]));
}

// the live stage's boot media: a FAT disk of the rpi release's apks and the modloop
const media = directory + "media.img";
if(stage === "live" && !fs.existsSync(media))
{
    const tree = directory + "media/";
    fs.rmSync(tree, { recursive: true, force: true });
    fs.mkdirSync(tree + "boot", { recursive: true });
    run("bsdtar", ["-xf", directory + "alpine-rpi-3.24.3-armv7.tar.gz", "-C", tree, "./apks", "./.alpine-release"]);
    fs.copyFileSync(directory + "modloop-lts", tree + "boot/modloop-lts");
    // (macOS: a raw MBR disk with one FAT32 partition of the tree)
    run("hdiutil", ["create", "-quiet", "-size", "256m", "-fs", "MS-DOS FAT32", "-volname", "ALPINE", "-srcfolder", tree,
        "-format", "UDTO", "-layout", "MBRSPUD", "-ov", directory + "media"]);
    fs.renameSync(directory + "media.cdr", media);
}

const EARLY = "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1";
// (v86 interpreted on more than one core: the soft lockup detector's threshold at 60 s)
const watchdog = !jit && cores > 1 ? " watchdog_thresh=30" : "";
const CMDLINES = {
    initramfs: EARLY + " rdinit=/a32-init",
    // (a root that does not exist: init looks for it, then enters single mode before mounting it)
    single: EARLY + " single root=/dev/vda",
    lifecycle: EARLY + " single root=/dev/vda",
    live: EARLY + " modules=loop,squashfs,virtio_mmio,virtio_blk,vfat modloop=/boot/modloop-lts",
};
const SINGLE_COMMANDS = "cat /proc/interrupts; echo A32_SINGLE_$((6*7)) && echo A32_SINGLE_OK; /bin/busybox poweroff -f\n";
const LIVE_COMMANDS = "uname -m; grep -m1 Features /proc/cpuinfo; cat /etc/alpine-release; rc-status -s 2>/dev/null | head -3; " +
    "echo $((6*7)) | md5sum; cat /proc/interrupts; echo A32_LIVE_DONE; poweroff -f\n";
const DONE = { initramfs: /A32_INIT_DONE/, single: /A32_SINGLE_42\r?\nA32_SINGLE_OK/, live: /A32_LIVE_DONE/ };

/** The serial console's driver: what to type when the transcript reaches a prompt */
function driver(write)
{
    let ran = false, logged_in = false, login_ms;
    const started = performance.now();
    return {
        output(transcript)
        {
            if((stage === "single" || stage === "lifecycle") && !ran && /Entering single mode[^\n]*\n/.test(transcript))
            {
                ran = true;
                if(stage === "single") write(SINGLE_COMMANDS);
            }
            if(stage === "live" && !logged_in && /localhost login: ?$/.test(transcript))
            {
                logged_in = true;
                login_ms = Math.round(performance.now() - started);
                write("root\n");
            }
            if(stage === "live" && logged_in && !ran && /localhost:~# ?$/.test(transcript))
            {
                ran = true;
                write(LIVE_COMMANDS);
            }
        },
        get login_ms() { return login_ms; },
        get shell() { return ran; },
    };
}

async function reference()
{
    const qemu = qemu_binary();
    const args = ["-machine", QEMU_MACHINE32, "-cpu", QEMU_CPU32, "-m", "512M", "-smp", smp(cores),
        "-global", "virtio-mmio.force-legacy=false", "-display", "none", "-no-reboot", "-serial", "stdio", "-monitor", "none",
        "-kernel", kernel, "-initrd", initrd, "-append", CMDLINES[stage],
        ...(stage === "live" ? ["-drive", `if=none,id=media,file=${media},format=raw,readonly=on`, "-device", "virtio-blk-device,drive=media"] : [])];
    const child = spawn(qemu, args, { stdio: ["pipe", "pipe", "pipe"] });
    let transcript = "";
    const d = driver(text => child.stdin.write(text));
    const started = performance.now();
    let timer;
    try
    {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`QEMU ${stage} deadline (${timeout} ms)\n${transcript.slice(-3000)}`)), timeout);
            child.on("error", reject);
            child.on("exit", code => (DONE[stage].test(transcript) ? resolve() : reject(new Error(`QEMU exited ${code}\n${transcript.slice(-3000)}`))));
            const output = bytes => { transcript += bytes; d.output(transcript); };
            child.stdout.on("data", output);
            child.stderr.on("data", output);
        });
    }
    finally
    {
        clearTimeout(timer);
        child.kill();
        fs.writeFileSync(directory + `qemu-${stage}-${cores}c.log`, transcript);
    }
    return { transcript, ms: Math.round(performance.now() - started), login_ms: d.login_ms };
}

const v86_options = () => ({
    cpu_type: "arm32", graphics_adapter: "none", cpu_cores: cores, memory_size: 512 << 20, log_level: 0,
    wasm_path: process.env.A32_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: kernel }, initrd: { url: initrd }, cmdline: CMDLINES[stage] + watchdog,
    ...(stage === "live" ? { virtio_disks: [{ buffer: new Uint8Array(fs.readFileSync(media)).buffer, readonly: true }] } : {}),
    ...(jit ? { jit_switches: { a64_page: 1 } } : {}),
    // (A32_PARALLEL=1: the cores in vCPU workers)
    ...(process.env.A32_PARALLEL === "1" ? { parallel: true, parallel_wasm_path: ROOT + "build/v86-arm64-parallel.wasm" } : {}),
});

async function actual()
{
    const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
    let emulator = new V86({ ...v86_options(), autostart: true });
    let transcript = "";
    const attach = e => e.add_listener("serial0-output-byte", byte => { transcript += String.fromCharCode(byte); d.output(transcript); });
    const d = driver(text => emulator.serial0_send(text));
    attach(emulator);
    const started = performance.now();
    // (the transcript so far, every 2 s: a run that hangs shows where)
    const log = directory + `v86-${stage}-${cores}c${jit ? "-jit" : ""}.log`;
    const flush = setInterval(() => fs.writeFileSync(log, transcript), 2000);
    const wait = (pattern, from = 0, what = String(pattern)) => new Promise((resolve, reject) => {
        const limit = performance.now() + timeout;
        const poll = setInterval(() => {
            if(pattern.test(transcript.slice(from))) { clearInterval(poll); resolve(); }
            else if(performance.now() > limit)
            {
                clearInterval(poll);
                reject(new Error(`v86 ${stage}: no ${what} after ${timeout} ms: ` + JSON.stringify(emulator.v86?.cpu?.get_diagnostics?.() ?? {}) +
                    "\n" + transcript.slice(-3000)));
            }
        }, 50);
    });
    const result = {};
    try
    {
        if(stage !== "lifecycle")
        {
            await wait(DONE[stage]);
        }
        else
        {
            // (the shell's prompt, with the kernel's messages maybe after it)
            await wait(/Entering single mode[^\n]*\n[\s\S]*# /);
            await new Promise(r => setTimeout(r, 2000));
            // a snapshot in the shell, restored into a new machine
            await emulator.stop();
            const state = await emulator.save_state();
            await emulator.destroy();
            emulator = new V86({ ...v86_options(), autostart: false });
            await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
            await emulator.restore_state(state);
            attach(emulator);
            let mark = transcript.length;
            emulator.run();
            emulator.serial0_send("echo A32_RESTORED_$((6*7))\n");
            await wait(/A32_RESTORED_42/, mark, "the restored shell's answer");
            result.snapshot_bytes = state.byteLength;
            // reboot -f (SYSTEM_RESET): single mode again
            mark = transcript.length;
            emulator.serial0_send("reboot -f\n");
            await wait(/Booting Linux[\s\S]*Entering single mode[^\n]*\n[\s\S]*# /, mark, "single mode after reboot -f");
            await new Promise(r => setTimeout(r, 2000));
            // poweroff -f (SYSTEM_OFF): the machine stops
            mark = transcript.length;
            emulator.serial0_send("poweroff -f\n");
            await wait(/reboot: Power down/, mark, "the power down");
            const cpu = emulator.v86.cpu;
            const off_limit = performance.now() + 30000;
            while(!(cpu.powered_off?.() ?? true) && performance.now() < off_limit) await new Promise(r => setTimeout(r, 100));
            result.powered_off = cpu.powered_off?.() ?? null;
            assert.ok(result.powered_off !== false, "the machine is off after poweroff -f");
        }
    }
    finally
    {
        clearInterval(flush);
        fs.writeFileSync(log, transcript);
        result.diagnostics = emulator.v86?.cpu?.get_diagnostics?.();
        await emulator.destroy();
    }
    return { transcript, ms: Math.round(performance.now() - started), login_ms: d.login_ms, ...result };
}

/** The workload's lines, the CPUs' intended differences taken out */
function workload_lines(transcript, side)
{
    const text = transcript.replace(/\r/g, "");
    const begin = text.indexOf("A32_WORKLOAD_BEGIN\n"), end = text.indexOf("A32_WORKLOAD_END");
    assert.ok(begin >= 0 && end > begin, side + ": no workload between its markers");
    return text.slice(begin, end).split("\n").filter(line => !/^\[ *\d+\.\d+\]/.test(line)).map(line => {
        if(line.startsWith("A32_PROBE "))
        {
            if(side === "v86")
            {
                for(const [name, value] of Object.entries(KNOWN)) assert.ok(line.includes(` ${name}=${value}`), `v86's ${name} answer: ${line}`);
                assert.equal(parseInt(line.match(/ hwcap2=(0x[0-9a-f]+)/)[1], 16), V86_HWCAP2, "v86's HWCAP2");
            }
            line = line.replace(/ hwcap2=0x[0-9a-f]+/, "").replace(/ (aes|sha|pmull)=([0-9a-f]+|none)/g, "")
                .replace(/ hwcap=(0x[0-9a-f]+)/, (_, v) => ` hwcap=${(parseInt(v, 16) & ~HWCAP_THUMBEE) >>> 0}`);
        }
        return line.replace(new RegExp(` (${DIFFERENT_FEATURES.join("|")})(?= |"|$)`, "g"), "");
    });
}

const results = {};
if(target !== "v86") results.qemu = await reference();
if(target !== "qemu") results.v86 = await actual();
const summary = { stage, cores, jit };
for(const [side, r] of Object.entries(results))
{
    summary[side] = { ms: r.ms, login_ms: r.login_ms, snapshot_bytes: r.snapshot_bytes, powered_off: r.powered_off };
    if(stage === "initramfs")
    {
        assert.match(r.transcript, new RegExp(`A32_INIT_START cpus=${cores} machine=armv7l`), side + ": the cores and the machine");
        assert.ok(!/A32_PROBE_FAIL/.test(r.transcript), side + ": " + r.transcript.match(/A32_PROBE_FAIL[^\n]*/)?.[0]);
    }
}
if(stage === "initramfs")
{
    // (the reference's transcript of an earlier run, when this one is v86's alone)
    const qemu_log = directory + `qemu-${stage}-${cores}c.log`;
    const qemu_text = results.qemu?.transcript ?? (fs.existsSync(qemu_log) ? fs.readFileSync(qemu_log, "latin1") : null);
    if(results.v86) workload_lines(results.v86.transcript, "v86");
    if(qemu_text && results.v86)
    {
        const a = workload_lines(qemu_text, "qemu"), b = workload_lines(results.v86.transcript, "v86");
        for(let i = 0; i < Math.max(a.length, b.length); i++) assert.equal(b[i], a[i], `workload line ${i + 1}`);
        summary.workload_lines = a.length;
    }
}
if(stage === "live") for(const [side, r] of Object.entries(results)) assert.ok(r.login_ms, side + ": no login prompt");
fs.writeFileSync(directory + `result-${stage}-${cores}c${jit ? "-jit" : ""}.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
console.log(`A32_LINUX_BOOT_OK ${stage} ${cores}c`);
process.exit(0);
