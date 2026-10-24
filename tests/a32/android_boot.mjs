#!/usr/bin/env node
// The official Android 7.1.1 emulator image (armeabi-v7a-25_r18, Google
// APIs) on cpu_type "arm32" and the ranchu machine (docs/aarch32-plan.md
// R7.1): its kernel-ranchu, ramdisk.img, system.img (read-only, vda), an
// empty /cache (vdb, src/android/ext4.js) and userdata.img (vdc, its
// changes kept in memory), the emulator's kernel command line
// (src/virt/ranchu.js). The test waits for the console's shell
// (userdebug), then asks it for sys.boot_completed until it is 1, and
// takes a screenshot of the framebuffer.
//
// The image (build/a32-android/armeabi-v7a-25_r18.zip, from Google's SDK
// repository) is unpacked into build/a32-android/armeabi-v7a/ once.
// A32_ANDROID_CORES (default 2), A32_ANDROID_MEMORY_MB (1024),
// A32_ANDROID_TIMEOUT (ms), A32_JIT=0 the interpreter only, A32_ANDROID_TAG the run's
// directory's name, A32_ANDROID_SAVE_STATE=<file> a state saved after
// boot_completed, A32_ANDROID_RESTORE_STATE=<file> that state restored
// instead of booting (the same disks), A32_ANDROID_LOGCAT=1
// the log's warnings and errors on the console. A32_ANDROID_DISK=1: as the
// VM manager boots an imported image (docs/android-images-plan.md I6): the
// zip made into one disk (tools/android_import.mjs's, build/a32-android/
// disk.img, its changes in memory), booted by the android option (device
// model ranchu_25_armeabi_v7a: the kernel and ramdisk from its partitions,
// the system, cache and userdata partitions as the virtio disks).
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ROOT } from "../lib/alpine_image.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";
import { make_empty_ext4 } from "../../src/android/ext4.js";
import { ranchu_cmdline } from "../../src/virt/ranchu.js";

const directory = ROOT + "build/a32-android/";
const image = directory + "armeabi-v7a/";
const zip = directory + "armeabi-v7a-25_r18.zip";
const FILES = ["kernel-ranchu", "ramdisk.img", "system.img", "userdata.img", "build.prop"];
if(!FILES.every(f => fs.existsSync(image + f)))
{
    assert.ok(fs.existsSync(zip), zip + " is missing (Google's SDK repository: system-images/android-25/google_apis/armeabi-v7a)");
    const unpack = spawnSync("bsdtar", ["-xf", zip, "-C", directory, ...FILES.map(f => "armeabi-v7a/" + f)], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
}
const cores = Number(process.env.A32_ANDROID_CORES || 2);
const memory_mb = Number(process.env.A32_ANDROID_MEMORY_MB || 1024);
const timeout = Number(process.env.A32_ANDROID_TIMEOUT || 3600000);
const jit = process.env.A32_JIT !== "0";
const from_disk = process.env.A32_ANDROID_DISK === "1";
const tag = process.env.A32_ANDROID_TAG || `v86-${jit ? "jit-" : ""}${from_disk ? "disk-" : ""}${cores}c`;
const disk = directory + "disk.img";
if(from_disk && !fs.existsSync(disk))
{
    const made = spawnSync(process.execPath, [ROOT + "tools/android_import.mjs", zip, disk], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stdout + made.stderr);
}
const run_directory = directory + "runs/" + tag + "/";
fs.mkdirSync(run_directory, { recursive: true });

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const sink = new PictureSink();
const cmdline = ranchu_cmdline({ arm32: true, bootanim: false, extra: process.env.A32_ANDROID_CMDLINE });
const restore = process.env.A32_ANDROID_RESTORE_STATE, save = process.env.A32_ANDROID_SAVE_STATE;
const emulator = new V86({
    cpu_type: "arm32", machine_type: "ranchu", cpu_cores: cores, memory_size: memory_mb << 20, log_level: 0, autostart: !restore,
    wasm_path: process.env.A32_WASM || ROOT + "build/v86-arm64.wasm",
    ...(from_disk ? {
        android: { device: "ranchu_25_armeabi_v7a" }, cmdline: process.env.A32_ANDROID_CMDLINE,
        virtio_disks: [{ url: disk, async: true, size: fs.statSync(disk).size }],
    } : {
        kernel: { url: image + "kernel-ranchu" }, initrd: { url: image + "ramdisk.img" }, cmdline,
        virtio_disks: [
            { url: image + "system.img", async: true, size: fs.statSync(image + "system.img").size, readonly: true },
            { buffer: make_empty_ext4(64 << 20, "cache", 1595289711).buffer },
            { url: image + "userdata.img", async: true, size: fs.statSync(image + "userdata.img").size },
        ],
    }),
    net_device: { type: "virtio", relay_url: "fetch" },
    // (ranchu's display: the goldfish framebuffer, no display adapter)
    graphics_adapter: "none", screen_adapter: sink,
    // (A32_PARALLEL=1: the cores in vCPU workers)
    ...(process.env.A32_PARALLEL === "1" ? { parallel: true, parallel_wasm_path: ROOT + "build/v86-arm64-parallel.wasm" } : {}),
    // (A32_JIT_SWITCHES: more of them, "name=value,...")
    ...(jit ? { jit_switches: { a64_page: 1, ...Object.fromEntries((process.env.A32_JIT_SWITCHES || "").split(",").filter(Boolean)
        .map(p => [p.split("=")[0], +p.split("=")[1]])) } } : {}),
});
emulator.add_listener("emulator-error", error => { console.error("emulator-error:", error); process.exit(1); });
let transcript = "";
emulator.add_listener("serial0-output-byte", byte => { transcript += String.fromCharCode(byte); });
const log = run_directory + "serial.log";
const flush = setInterval(() => fs.writeFileSync(log, transcript), 2000);
const started = performance.now();
const seconds = () => ((performance.now() - started) / 1000).toFixed(0);
const wait = (test, what, limit = timeout) => new Promise((resolve, reject) => {
    const deadline = performance.now() + limit;
    const poll = setInterval(() => {
        const found = test();
        if(found) { clearInterval(poll); resolve(found); }
        else if(performance.now() > deadline)
        {
            clearInterval(poll);
            reject(new Error(`no ${what} after ${seconds()} s: ` + JSON.stringify(emulator.v86?.cpu?.get_diagnostics?.() ?? {}).slice(0, 3000) +
                "\n" + transcript.slice(-4000)));
        }
    }, 250);
});
const marks = {};
const mark = name => { if(!marks[name]) { marks[name] = Math.round(performance.now() - started); console.log(`${seconds()} s: ${name}`); } };
try
{
    if(restore)
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        const bytes = fs.readFileSync(restore);
        await emulator.restore_state(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        await emulator.run();
        mark("restored");
    }
    else
    {
        await wait(() => /Freeing unused kernel memory/.test(transcript), "the kernel's init");
        mark("kernel");
        await wait(() => /init: .*(starting|Starting) service|init: .*console/.test(transcript) || /\n[^\n]*[$#] $/.test(transcript), "Android's init");
        mark("init");
        // the console's shell (ro.debuggable): until it answers (the typed line's
        // echo cannot match: the answer is computed)
        let tick = 0;
        await wait(() => {
            if(/A32_SHELL_42/.test(transcript)) return true;
            if(tick++ % 20 === 0) emulator.serial0_send("\necho A32_SHELL_$((40+2))\n");
            return false;
        }, "the console's shell");
        mark("shell");
        // (A32_ANDROID_LOGCAT=1: the log's warnings and errors on the console too)
        if(process.env.A32_ANDROID_LOGCAT === "1") emulator.serial0_send("logcat -b main -b system -b crash -v brief '*:W' &\n");
        tick = 0;
        await wait(() => {
            if(/A32_BOOT_1_X/.test(transcript)) return true;
            if(tick++ % 40 === 0) emulator.serial0_send("echo A32_BOOT_$(getprop sys.boot_completed)_X\n");
            return false;
        }, "sys.boot_completed");
        mark("boot_completed");
        // (the launcher's first frames)
        await new Promise(resolve => setTimeout(resolve, 20000));
        save_png(sink, run_directory, "boot-completed");
        if(save)
        {
            fs.writeFileSync(save, new Uint8Array(await emulator.save_state()));
            console.log("saved " + save);
        }
    }
    // the screen woken and unlocked, the home screen; what the system says of them
    const fb = emulator.v86.cpu.devices.goldfish_fb;
    const ask = async (command, marker, limit = 120000) =>
    {
        const from = transcript.length;
        emulator.serial0_send(command + "; echo " + marker + "_$((1+1))\n");
        await wait(() => transcript.indexOf(marker + "_2", from) >= 0, marker, limit);
        return transcript.slice(from, transcript.indexOf(marker + "_2", from));
    };
    const state = await ask("dumpsys power | grep -E 'mWakefulness=|mScreenOn|Display Power' ; dumpsys window | grep -E 'mCurrentFocus|mShowingLockscreen|mScreenOnFully'", "A32_STATE");
    console.log("before: " + state.replace(/\s+/g, " ").slice(0, 600) + "; frames " + fb.frames);
    await ask("input keyevent 224; sleep 2; wm dismiss-keyguard; sleep 2; input keyevent 3", "A32_HOME");
    await new Promise(resolve => setTimeout(resolve, 40000));
    const after = await ask("dumpsys window | grep -E 'mCurrentFocus|mShowingLockscreen'", "A32_AFTER");
    console.log("after: " + after.replace(/\s+/g, " ").slice(0, 400) + "; frames " + fb.frames);
    const shot = save_png(sink, run_directory, "home");
    console.log(JSON.stringify({ tag, marks, screenshot: shot, cmdline }));
    console.log("A32_ANDROID_BOOT_OK " + tag);
}
finally
{
    clearInterval(flush);
    fs.writeFileSync(log, transcript);
    save_png(sink, run_directory, "last");
    await emulator.destroy();
}
process.exit(0);
