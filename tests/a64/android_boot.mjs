#!/usr/bin/env node
// Android 16 on the virt machine (docs/arm64-virt-android16-plan.md P10.3,
// P10.7): tools/a64_android.mjs's Image, initrd.img and disk.img (the pinned
// Cuttlefish arm64-only phone, direct kernel boot, unlocked, permissive)
// booted on the QEMU reference or on v86. The first boot each time: the
// disk's writes stay in memory (QEMU's snapshot=on, v86's buffer).
//
// QEMU (A64_ANDROID_TARGET=qemu, the default): tests/a64/android_qemu.mjs's
// machine, cortex-a35 under TCG (A64_ANDROID_ACCEL=hvf: the host's CPU, for
// quick runs). Passes when the Android console answers
// `getprop sys.boot_completed` with 1. A64_QEMU_PLUGINS=1 counts the
// instructions to that point (libinsn, and libhowvec's classes), for
// P10.3's budget.
//
// v86 (A64_ANDROID_TARGET=v86): the same materials and the devices in the
// same PCI order (virtio-blk 00:01.0, virtio-gpu 00:02.0, then 18 console
// ports with the kernel's console on hvc0 and logcat on hvc2, rng, input,
// vsock), RAM above 2 GiB as extended RAM. Passes when system_server has
// started and adbd answers over vsock:5555 (tests/a64/adb.mjs; A8's
// acceptance), and reports how far the boot got by the deadline
// (A64_ANDROID_WAIT=boot_completed: until sys.boot_completed=1).
//
//   A64_CORES (4), A64_MEMORY_MB (1536: about 1 GiB is the least that boots, P10.3), A64_JIT=1 (the page tier),
//   A64_PARALLEL=1 (vCPU workers), A64_ANDROID_TIMEOUT (ms),
//   TEST_RELEASE_BUILD=1 (build/libv86.mjs)
// Logs: build/a64-android/runs/<tag>/ (kernel.log, logcat.log, console.log)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { android_qemu_args, AndroidConsole } from "./android_qemu.mjs";
import { qemu_binary } from "./guest_runner.mjs";
import { AdbClient } from "./adb.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const OUT = ROOT + "build/a64-android/out/";
for(const file of ["Image", "initrd.img", "disk.img", "cmdline.txt"])
{
    assert.ok(fs.existsSync(OUT + file), OUT + file + " is missing: node tools/a64_android.mjs --download");
}
const target = process.env.A64_ANDROID_TARGET || "qemu";
assert.ok(target === "qemu" || target === "v86", "A64_ANDROID_TARGET: qemu or v86");
const accel = process.env.A64_ANDROID_ACCEL || "tcg";
const cores = +process.env.A64_CORES || 4;
const memory_mb = +process.env.A64_MEMORY_MB || 1536;
const plugins = !!+process.env.A64_QEMU_PLUGINS;
const jit = !!+process.env.A64_JIT;
const parallel = !!+process.env.A64_PARALLEL;
const wait_for_boot_completed = target === "qemu" || process.env.A64_ANDROID_WAIT === "boot_completed";
const tag = target === "qemu" ? `qemu-${accel}${plugins ? "-plugins" : ""}-${memory_mb}m-${cores}c` :
    `v86${jit ? "-jit" : ""}${parallel ? "-par" : ""}-${memory_mb}m-${cores}c`;
const timeout = +process.env.A64_ANDROID_TIMEOUT || (target === "qemu" ? (accel === "hvf" ? 600000 : plugins ? 14400000 : 3600000) : 14400000);
const directory = ROOT + `build/a64-android/runs/${tag}/`;
fs.mkdirSync(directory, { recursive: true });
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const marks = {};
const mark = (name, text) =>
{
    if(marks[name] === undefined)
    {
        marks[name] = elapsed();
        console.log(`${(marks[name] / 1000).toFixed(1)} s: ${name}${text ? " " + text : ""}`);
    }
};
/** boot milestones in the kernel's log (hvc0) and logcat (hvc2) */
const MILESTONES = [
    ["first_stage", /init: init first stage started/],
    ["second_stage", /init: init second stage started/],
    ["zygote", /init: starting service 'zygote'/],
    ["system_server", /SystemServer: Entered the Android system server/],
    ["adbd", /init: starting service 'adbd'/],
    ["boot_animation", /init: starting service 'bootanim'/],
    ["boot_completed", /init: processing action \(sys\.boot_completed=1\)/],
];
const watch = (name, file) =>
{
    let text = "";
    const out = fs.openSync(directory + file, "w");
    return bytes =>
    {
        fs.writeSync(out, bytes);
        // (the new bytes with the end of the old ones, for lines split between them)
        const window = text + Buffer.from(bytes).toString("latin1");
        for(const [milestone, pattern] of MILESTONES) if(marks[milestone] === undefined && pattern.test(window)) mark(milestone);
        const panic = /Kernel panic[^\n]*/.exec(window);
        if(panic) fail(new Error(panic[0]));
        text = window.slice(-512);
    };
};
let fail;
const failed = new Promise((_, reject) => { fail = reject; });
failed.catch(() => {});

if(target === "qemu")
{
    const qemu = qemu_binary();
    const socket = `/tmp/v86-a64-android-${process.pid}.sock`;
    const args = android_qemu_args(OUT, { accel, memory_mb, cores, console_socket: socket,
        kernel_log: directory + "kernel.log", logcat: directory + "logcat.log" });
    const plugin_log = directory + "plugins.log";
    if(plugins)
    {
        assert.equal(accel, "tcg", "A64_QEMU_PLUGINS: under TCG");
        const qemu_build = path.dirname(qemu) + "/../../qemu-9.2.0/build/";
        const library = name => [".dylib", ".so"].map(suffix => qemu_build + name + suffix).find(file => fs.existsSync(file));
        const insn = library("tests/tcg/plugins/libinsn"), howvec = library("contrib/plugins/libhowvec");
        assert.ok(insn && howvec, "QEMU's insn and howvec plugins are missing: tools/a64_qemu/build.sh");
        // (libinsn counting inline; no -icount, which would serialize the
        // four vCPUs onto one thread: hours under the plugins. Time-driven
        // waits then run longer than without them, so the counts are an
        // upper bound)
        args.push("-plugin", insn + ",inline=on", "-plugin", howvec, "-d", "plugin", "-D", plugin_log);
    }
    const child = spawn(qemu, args, { stdio: ["ignore", "inherit", "inherit"] });
    const exited = new Promise(resolve => child.on("exit", resolve));
    // (the logs are QEMU's files: followed by polling)
    const follow = (file, on_bytes) =>
    {
        let at = 0;
        return setInterval(() => {
            if(!fs.existsSync(directory + file)) return;
            const size = fs.statSync(directory + file).size;
            if(size <= at) return;
            const fd = fs.openSync(directory + file, "r"), bytes = Buffer.alloc(size - at);
            fs.readSync(fd, bytes, 0, bytes.length, at);
            fs.closeSync(fd);
            at = size;
            on_bytes(bytes);
        }, 1000);
    };
    const kernel_watch = watch("kernel", "kernel-watch.log"), logcat_watch = watch("logcat", "logcat-watch.log");
    const timers = [follow("kernel.log", kernel_watch), follow("logcat.log", logcat_watch)];
    const terminal = new AndroidConsole(socket);
    try
    {
        await terminal.open();
        const poll = async () =>
        {
            for(;;)
            {
                const r = await terminal.run("getprop sys.boot_completed", 30000);
                if(r && r.output.trim() === "1") return;
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        };
        await Promise.race([poll(), failed, exited.then(code => { throw new Error("QEMU exited " + code); }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`no sys.boot_completed=1 in ${timeout} ms`)), timeout))]);
        mark("boot_completed_getprop");
        const fingerprint = (await terminal.run("getprop ro.build.fingerprint")).output.trim();
        fs.writeFileSync(directory + "console.log", terminal.text);
        terminal.close();
        child.kill(plugins ? "SIGINT" : "SIGKILL");
        await exited;
        const result = { tag, fingerprint, ms: elapsed(), marks };
        if(plugins)
        {
            // (libinsn: "total insns: N"; libhowvec: the classes and their
            // counts, which QEMU may still be writing as it exits)
            await new Promise(resolve => setTimeout(resolve, 2000));
            const log = fs.readFileSync(plugin_log, "utf8");
            result.instructions = Number(/total insns: (\d+)/.exec(log)?.[1]);
            result.classes = Object.fromEntries([...log.matchAll(/^Class: (.+?)\s+\((\d+) hits\)/gm)].map(m => [m[1].trim(), +m[2]]));
        }
        fs.writeFileSync(directory + "result.json", JSON.stringify(result, null, 2) + "\n");
        console.log(JSON.stringify(result));
        console.log(`A64_ANDROID_BOOT_OK ${tag}`);
        process.exit(0);
    }
    catch(e)
    {
        fs.writeFileSync(directory + "console.log", terminal.text);
        child.kill("SIGKILL");
        console.error(e);
        process.exit(1);
    }
    finally
    {
        timers.forEach(clearInterval);
    }
}

// v86
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
// (RAM: below 2 GiB with the display adapter's device memory, the rest extended RAM from 4 GiB)
const LOW_LIMIT_MB = 1536;
const low_mb = Math.min(memory_mb, LOW_LIMIT_MB);
const sink = {
    set_mode() {}, set_size_text() {}, set_size_graphical() {}, put_char() {}, update_cursor() {}, update_cursor_scanline() {},
    set_font_bitmap() {}, set_font_page() {}, clear_screen() {}, clear_text_state() {}, update_buffer() {},
    pause() {}, continue() {}, destroy() {}, set_scale() {}, get_text_screen: () => [], get_text_row: () => "",
};
const emulator = new V86({
    cpu_type: "arm64", cpu_cores: cores, memory_size: low_mb * 1048576, log_level: 0, autostart: true,
    ...(memory_mb > low_mb ? { extended_memory_size: (memory_mb - low_mb) * 1048576 } : {}),
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: OUT + "Image" }, initrd: { url: OUT + "initrd.img" },
    cmdline: fs.readFileSync(OUT + "cmdline.txt", "utf8").trim(),
    virtio_transport: "pci", virtio_disks: [{ url: OUT + "disk.img", async: true, size: fs.statSync(OUT + "disk.img").size }],
    graphics_adapter: "virtio_gpu", virtio_gpu_pci_slot: 2, screen_adapter: sink,
    virtio_console: true, virtio_console_ports: 18, virtio_rng: true, virtio_input: ["keyboard", "tablet"], virtio_vsock: true,
    net_device: { type: "none" },
    ...(jit ? { jit_switches: { a64_page: 1 } } : {}),
    ...(parallel ? { parallel: true, parallel_wasm_path: process.env.A64_PARALLEL_WASM || ROOT + "build/v86-arm64-parallel.wasm" } : {}),
});
const kernel_watch = watch("kernel", "kernel.log"), logcat_watch = watch("logcat", "logcat.log");
let serial = "";
const serial_out = fs.openSync(directory + "console.log", "w");
emulator.add_listener("serial0-output-byte", byte => { serial = (serial + String.fromCharCode(byte)).slice(-65536); fs.writeSync(serial_out, Buffer.from([byte])); });
emulator.add_listener("virtio-console0-output-bytes", kernel_watch);
emulator.add_listener("virtio-console2-output-bytes", logcat_watch);
const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error(`deadline (${timeout} ms)`)), timeout));
const progress = setInterval(() => {
    const retired = emulator.get_instruction_counter?.();
    console.log(`${(elapsed() / 1000).toFixed(0)} s: ${Object.keys(marks).join(", ") || "booting"}${retired ? ", " + Math.round(retired / 1e9) + "G instructions" : ""}`);
}, 60000);

/** adbd over vsock:5555: its banner and a shell command's answer */
async function adb(command)
{
    const stream = await emulator.vsock_connect(5555);
    const client = new AdbClient({ write: bytes => stream.write(Uint8Array.from(bytes)), set on_data(fn) { stream.on_data = bytes => fn(Buffer.from(bytes)); } });
    try
    {
        const banner = await client.connect(60000);
        const output = await client.shell(command, 120000);
        return { banner, output };
    }
    finally
    {
        stream.close();
    }
}

try
{
    // system_server, then adbd's answer (retried: adbd starts before its vsock listener is ready)
    await Promise.race([new Promise(resolve => { const t = setInterval(() => { if(marks.system_server !== undefined && marks.adbd !== undefined) { clearInterval(t); resolve(); } }, 1000); }),
        failed, deadline]);
    let answer;
    for(let attempt = 0; !answer; attempt++)
    {
        try
        {
            answer = await Promise.race([adb("echo B=$(getprop sys.boot_completed) P=$(pidof system_server) F=$(getprop ro.build.fingerprint)"),
                failed, deadline]);
        }
        catch(e)
        {
            if(attempt > 30 || /deadline|panic/.test(e.message)) throw e;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    mark("adb");
    console.log("adb banner: " + answer.banner.slice(0, 120));
    console.log("adb: " + JSON.stringify(answer.output));
    const fields = /B=(\S*) P=(\d*) F=(\S*)/.exec(answer.output);
    assert.ok(fields && fields[2], "system_server's pid over adb: " + JSON.stringify(answer.output));
    assert.ok(/:16\/BP4A\.251205\.006\//.test(fields[3]), "the build's fingerprint over adb");
    if(wait_for_boot_completed)
    {
        for(;;)
        {
            const r = await Promise.race([adb("getprop sys.boot_completed"), failed, deadline]);
            if(r.output.trim() === "1") break;
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
        mark("boot_completed_adb");
    }
    clearInterval(progress);
    const result = { tag, ms: elapsed(), marks, system_server_pid: +fields[2], fingerprint: fields[3] };
    fs.writeFileSync(directory + "result.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
    console.log(`A64_ANDROID_BOOT_OK ${tag}`);
    await emulator.destroy();
    process.exit(0);
}
catch(e)
{
    clearInterval(progress);
    console.error(e);
    console.error("marks: " + JSON.stringify(marks));
    process.exit(1);
}
