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
// A32_ANDROID_APP=1: after the home screen, a touch on its hotseat
// (goldfish_events) opens an app (the focused window changes), and a 32-bit
// APK (tests/a32/android/v86arm32.c as armeabi-v7a, tests/a64/apk.mjs) goes
// over the console (base64), is installed (pm install) and started: its log
// line and its frame. A32_ANDROID_PROBE: shell commands (";;" between
// them) whose output is printed after boot or restore.
// A32_ANDROID_GPU=host: the device model's GPU mode "host" (qemu.gles=1,
// ranchu_gpu "host": the GLES host, docs/gles-proxy-plan.md); the GLES
// calls' counts go to the run's gles.json, its batches to gles-batches.bin
// (read by tools/gles/batches.mjs), and an opcode the host does not know,
// or a command it cannot decode, fails the test. A32_ANDROID_RENDERER=chrome:
// the renderer is a real GPU's (headless Chrome, tests/gles/chrome_renderer.mjs),
// the screen SurfaceFlinger's frames; otherwise nothing is drawn.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ROOT } from "../lib/alpine_image.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";
import { make_empty_ext4 } from "../../src/android/ext4.js";
import { ranchu_cmdline } from "../../src/virt/ranchu.js";
import { build_apk, build_native_lib } from "../a64/apk.mjs";
import { RANCHU_25_ARMEABI_V7A, ranchu_gpu_mode } from "../../src/android/devices.js";
import { recording_renderer } from "../gles/lib.mjs";
import { chrome_renderer } from "../gles/chrome_renderer.mjs";
import { ramdisk_overlay } from "../../src/android/ramdisk_overlay.js";

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
const gpu_mode = process.env.A32_ANDROID_GPU || "guest";
const gpu = ranchu_gpu_mode(RANCHU_25_ARMEABI_V7A, gpu_mode);
const tag = process.env.A32_ANDROID_TAG || `v86-${jit ? "jit-" : ""}${from_disk ? "disk-" : ""}${gpu.gles ? "gles-" : ""}${cores}c`;
const disk = directory + "disk.img";
if(from_disk && !fs.existsSync(disk))
{
    const made = spawnSync(process.execPath, [ROOT + "tools/android_import.mjs", zip, disk], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stdout + made.stderr);
}
const run_directory = directory + "runs/" + tag + "/";
fs.mkdirSync(run_directory, { recursive: true });

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const gles_renderer = !gpu.gles ? null : process.env.A32_ANDROID_RENDERER === "chrome" ?
    await chrome_renderer({ record: run_directory + "gles-batches.bin" }) : recording_renderer(run_directory + "gles-batches.bin");
const sink = new PictureSink();
const cmdline = ranchu_cmdline({ arm32: true, bootanim: false, gles: gpu.gles, extra: process.env.A32_ANDROID_CMDLINE });
const restore = process.env.A32_ANDROID_RESTORE_STATE, save = process.env.A32_ANDROID_SAVE_STATE;
const ramdisk = await ramdisk_overlay(new Uint8Array(fs.readFileSync(image + "ramdisk.img")), RANCHU_25_ARMEABI_V7A);
const emulator = new V86({
    cpu_type: "arm32", machine_type: "ranchu", cpu_cores: cores, memory_size: memory_mb << 20, log_level: 0, autostart: !restore,
    wasm_path: process.env.A32_WASM || ROOT + "build/v86-arm64.wasm",
    ...(from_disk ? {
        android: { device: "ranchu_25_armeabi_v7a", gpu_mode }, cmdline: process.env.A32_ANDROID_CMDLINE,
        virtio_disks: [{ url: disk, async: true, size: fs.statSync(disk).size }],
    } : {
        // (the ramdisk with the device model's init additions, as the bootloader gives it)
        kernel: { url: image + "kernel-ranchu" }, initrd: { buffer: ramdisk.buffer.slice(ramdisk.byteOffset, ramdisk.byteOffset + ramdisk.length) }, cmdline,
        ranchu_properties: Object.assign({}, RANCHU_25_ARMEABI_V7A.properties, gpu.properties), ranchu_gpu: gpu.ranchu_gpu,
        // (the device model's clock rate, as the bootloader hands it over; A32_ANDROID_RATE another)
        ...(process.env.A32_PARALLEL === "1" ? {} : { cpu_clock: { rate: Number(process.env.A32_ANDROID_RATE || RANCHU_25_ARMEABI_V7A.clock_rate) } }),
        virtio_disks: [
            { url: image + "system.img", async: true, size: fs.statSync(image + "system.img").size, readonly: true },
            { buffer: make_empty_ext4(64 << 20, "cache", 1595289711).buffer },
            { url: image + "userdata.img", async: true, size: fs.statSync(image + "userdata.img").size },
        ],
    }),
    net_device: { type: "virtio", relay_url: "fetch" },
    // (the GLES host's batches into the run's directory; drawn by Chrome's GPU, or not)
    ...(gpu.gles ? { graphics_adapter_renderer_channel: gles_renderer } : {}),
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
// (the GLES host's counts, A32_ANDROID_GPU=host)
const gles_summary = () => emulator.v86?.cpu?.devices?.gles?.device["summary"]();
const write_gles = () => { const summary = gles_summary(); if(summary) fs.writeFileSync(run_directory + "gles.json", JSON.stringify(summary, null, 1)); };
const flush = setInterval(() => { fs.writeFileSync(log, transcript); write_gles(); }, 2000);
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
    // (the page tier's steps and helper calls: what is not compiled natively)
    const cpu = emulator.v86.cpu;
    if(cpu.step_stats) fs.writeFileSync(run_directory + "steps.json", JSON.stringify(cpu.step_stats(40), null, 1));
    // the screen woken and unlocked, the home screen; what the system says of them
    const fb = emulator.v86.cpu.devices.goldfish_fb;
    const ask = async (command, marker, limit = 120000) =>
    {
        const from = transcript.length;
        emulator.serial0_send(command + "; echo " + marker + "_$((1+1))\n");
        await wait(() => transcript.indexOf(marker + "_2", from) >= 0, marker, limit);
        return transcript.slice(from, transcript.indexOf(marker + "_2", from));
    };
    // (A32_ANDROID_PROBE: shell commands, ";;" between them, run and printed first)
    for(const command of (process.env.A32_ANDROID_PROBE || "").split(";;").filter(c => c.trim()))
    {
        console.log(`probe: ${command}\n` + (await ask(command, "A32_PROBE", 600000)).split("\n").slice(1).join("\n").slice(0, 8000));
    }
    const state = await ask("getprop ro.config.low_ram; getprop qemu.gles; getprop qemu.sf.lcd_density; " +
        "dumpsys power | grep -E 'mWakefulness=|mScreenOn|Display Power' ; dumpsys window | grep -E 'mCurrentFocus|mShowingLockscreen|mScreenOnFully'", "A32_STATE", 600000);
    console.log("before: " + state.replace(/\s+/g, " ").slice(0, 600) + "; frames " + fb.frames);
    // (each input or wm starts a Dalvik VM: a minute or more here)
    await ask("input keyevent 224; sleep 2; wm dismiss-keyguard; sleep 2; input keyevent 3", "A32_HOME", 900000);
    await new Promise(resolve => setTimeout(resolve, 40000));
    const after = await ask("dumpsys window | grep -E 'mCurrentFocus|mShowingLockscreen'", "A32_AFTER", 600000);
    console.log("after: " + after.replace(/\s+/g, " ").slice(0, 400) + "; frames " + fb.frames);
    const shot = save_png(sink, run_directory, "home");
    if(process.env.A32_ANDROID_APP === "1")
    {
        const focus = async () => (await ask("dumpsys window | grep mCurrentFocus", "A32_FOCUS", 600000)).match(/mCurrentFocus=\S+ \S+ ([^}]+)\}/)?.[1] || "";
        // (background ANRs are shown, not killed: their dialogs' Wait, found by uiautomator)
        const dismiss_dialogs = async () =>
        {
            for(let i = 0; i < 8 && /Not Responding/.test(await focus()); i++)
            {
                const dump = await ask("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; grep -o 'text=\"Wait\"[^>]*bounds=\"[^\"]*\"' /data/local/tmp/ui.xml",
                    "A32_UI", 900000);
                const m = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump);
                if(!m) break;
                await ask(`input tap ${(+m[1] + +m[3]) >> 1} ${(+m[2] + +m[4]) >> 1}`, "A32_TAP", 600000);
            }
        };
        await dismiss_dialogs();
        // a touch: the hotseat's icons, from the left, until one opens its app
        const home = await focus();
        const events = emulator.v86.cpu.devices.goldfish_events;
        let opened = "";
        for(const column of [0, 1, 3, 4])
        {
            events.tap(fb.width * (column + 0.5) / 5, fb.height * 0.86, fb.width, fb.height);
            await new Promise(resolve => setTimeout(resolve, 60000));
            opened = await focus();
            if(/Not Responding/.test(opened)) { await dismiss_dialogs(); opened = await focus(); }
            if(opened && opened !== home) break;
        }
        console.log(`touch: ${home} -> ${opened}`);
        save_png(sink, run_directory, "touched");
        assert.ok(opened && opened !== home, "a touch on the hotseat opens an app");
        await ask("input keyevent 3", "A32_HOME2", 600000);

        // the 32-bit APK, base64 over the console
        const lib = build_native_lib(4096, "v86arm32", ["-landroid", "-llog", "-lm"],
            { abi: "armeabi-v7a", source: ROOT + "tests/a32/android/v86arm32.c" });
        const apk = build_apk({ label: "v86 arm32", package_name: "org.v86.arm32", min_sdk: 21, target_sdk: 25,
            native: { name: "v86arm32", lib, extract: true, abi: "armeabi-v7a", software: true } });
        const text = apk.toString("base64");
        await ask("rm -f /data/local/tmp/app.b64", "A32_RM", 600000);
        for(let at = 0; at < text.length; at += 768) await ask(`echo ${text.slice(at, at + 768)} >> /data/local/tmp/app.b64`, "A32_PUT", 600000);
        const installed = await ask("base64 -d /data/local/tmp/app.b64 > /data/local/tmp/app.apk && pm install -r /data/local/tmp/app.apk", "A32_INSTALL", 900000);
        console.log("install: " + installed.replace(/\s+/g, " ").slice(-200));
        assert.match(installed, /Success/, "pm install");
        await dismiss_dialogs();
        const started = await ask("am start -W -n org.v86.arm32/android.app.NativeActivity", "A32_START", 900000);
        console.log("start: " + started.replace(/\s+/g, " ").slice(-300));
        let drew = "";
        for(let i = 0; i < 20 && !drew; i++)
        {
            await new Promise(resolve => setTimeout(resolve, 10000));
            drew = (await ask("logcat -d -s v86arm32:I", "A32_LOG", 600000)).match(/V86_ARM32_DREW \S+ sum=\S+ bits=\d+/)?.[0] || "";
        }
        console.log("app: " + drew + "; focus " + await focus() + "; frames " + fb.frames);
        assert.ok(drew, "the 32-bit app drew its frame");
        await new Promise(resolve => setTimeout(resolve, 20000));
        save_png(sink, run_directory, "app");
    }
    const gles = gles_summary();
    if(gles)
    {
        write_gles();
        const calls = Object.values(gles.counts).reduce((n, c) => n + c, 0);
        console.log(`gles: ${gles.connections} connections, ${gles.processes} processes, ${calls} calls of ${Object.keys(gles.counts).length} kinds; ` +
            "renderControl " + JSON.stringify(gles.render_control) + "; " + run_directory + "gles.json");
        assert.deepEqual(gles.unknown, {}, "no opcode the GLES host does not know");
        assert.deepEqual(gles.malformed, {}, "every command decoded");
        assert.equal(gles.broken, 0, "no broken stream");
    }
    console.log(JSON.stringify({ tag, marks, screenshot: shot, cmdline }));
    console.log("A32_ANDROID_BOOT_OK " + tag);
}
finally
{
    clearInterval(flush);
    fs.writeFileSync(log, transcript);
    write_gles();
    if(gles_renderer && gles_renderer.close) gles_renderer.close();
    save_png(sink, run_directory, "last");
    await emulator.destroy();
}
process.exit(0);
