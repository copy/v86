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
// them) whose output is printed after boot or restore (A32_ANDROID_PROBE_HOME:
// after the home screen's screenshot). A32_ANDROID_SCREEN:
// am start's arguments (-a android.settings.SETTINGS): after the home
// screen the activity is started and its screen taken (screen.png), then
// swiped up and down for a minute: the frames a second the screen shows
// (A32_ANDROID_RATE_AFTER=<rate>: the clock's rate changed first).
// A32_ANDROID_GPU=host: the device model's GPU mode "host" (qemu.gles=1,
// ranchu_gpu "host": the GLES host, docs/gles-proxy-plan.md); the GLES
// calls' counts go to the run's gles.json, its batches to gles-batches.bin
// (read by tools/gles/batches.mjs), and an opcode the host does not know,
// or a command it cannot decode, fails the test. A32_ANDROID_RENDERER=chrome:
// the renderer is a real GPU's (headless Chrome, tests/gles/chrome_renderer.mjs),
// the screen SurfaceFlinger's frames; otherwise nothing is drawn.
// A32_ANDROID_PROPS="name=value,...": boot properties changed (an empty
// value removes one: "ro.config.low_ram="); A32_ANDROID_BOOTANIM=1: the boot
// animation on (both for the files' boot, not A32_ANDROID_DISK).
// A32_ANDROID_GLES_APP=1 (with A32_ANDROID_GPU=host): after the home screen,
// tests/a32/android/v86gles.c's APK (GLES 2.0 and 1.1 scenes read back with
// glReadPixels: docs/gles-proxy-plan.md E4) is installed and started, and
// the pixels it logs are checked against GLES's rules.
// A32_ANDROID_DEQP=1 (with A32_ANDROID_GPU=host): dEQP-GLES2 and dEQP-EGL
// from CTS 7.1_r29 (tools/a32_cts.mjs fetches them) on a fourth virtio disk
// (ext2, mke2fs -d), copied in with su, installed, run by its
// instrumentation in chunks (the results from its status lines); the subset (docs/gles-proxy-plan.md E4): every
// state_query and negative_api case, dEQP-EGL.info, and every ninth other
// functional case (A32_ANDROID_DEQP_STEP another; A32_ANDROID_DEQP_FILTER a
// pattern of cases to keep); each case's status into the run's deqp.json.
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
const cmdline = ranchu_cmdline({ arm32: true, bootanim: process.env.A32_ANDROID_BOOTANIM === "1", gles: gpu.gles, extra: process.env.A32_ANDROID_CMDLINE });
const properties = Object.assign({}, RANCHU_25_ARMEABI_V7A.properties, gpu.properties);
for(const pair of (process.env.A32_ANDROID_PROPS || "").split(",").filter(Boolean))
{
    const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
    if(value) properties[name] = value;
    else delete properties[name];
}
const restore = process.env.A32_ANDROID_RESTORE_STATE, save = process.env.A32_ANDROID_SAVE_STATE;
// (dEQP: its files on an ext2 disk of their own, and the cases to run)
let deqp = null;
if(process.env.A32_ANDROID_DEQP === "1")
{
    const { fetch_files, DEQP_FILES } = await import("../../tools/a32_cts.mjs");
    const [apk, gles2, egl] = await fetch_files(DEQP_FILES, true);
    const step = Number(process.env.A32_ANDROID_DEQP_STEP || 9);
    const filter = new RegExp(process.env.A32_ANDROID_DEQP_FILTER || ".");
    const all = fs.readFileSync(gles2, "utf8").split("\n").filter(Boolean);
    const sampled = all.filter((c, i) => /\.(state_query|negative_api)\./.test(c) || /^dEQP-GLES2\.(info|functional)\./.test(c) && i % step === 0);
    const cases = { "dEQP-GLES2": sampled.filter(c => filter.test(c)),
        "dEQP-EGL": fs.readFileSync(egl, "utf8").split("\n").filter(c => c.startsWith("dEQP-EGL.info.") && filter.test(c)) };
    const root = run_directory + "deqp-disk/";
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(apk, root + "deqp.apk");
    const chunks = [];
    for(const [pkg, list] of Object.entries(cases))
    {
        for(let i = 0; i < list.length; i += 150) chunks.push({ pkg, cases: list.slice(i, i + 150), name: `${pkg}-${chunks.length}.txt` });
    }
    for(const chunk of chunks) fs.writeFileSync(root + chunk.name, chunk.cases.join("\n") + "\n");
    const image = run_directory + "deqp.img";
    fs.rmSync(image, { force: true });
    const made = spawnSync("/opt/homebrew/opt/e2fsprogs/sbin/mke2fs", ["-q", "-t", "ext2", "-b", "4096", "-d", root, image, "160M"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    deqp = { image, chunks };
    console.log(`dEQP: ${cases["dEQP-GLES2"].length} GLES 2 and ${cases["dEQP-EGL"].length} EGL cases in ${chunks.length} runs`);
}
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
        ranchu_properties: properties, ranchu_gpu: gpu.ranchu_gpu,
        // (the device model's clock rate, as the bootloader hands it over; A32_ANDROID_RATE another)
        ...(process.env.A32_PARALLEL === "1" ? {} : { cpu_clock: { rate: Number(process.env.A32_ANDROID_RATE || RANCHU_25_ARMEABI_V7A.clock_rate) } }),
        virtio_disks: [
            { url: image + "system.img", async: true, size: fs.statSync(image + "system.img").size, readonly: true },
            { buffer: make_empty_ext4(64 << 20, "cache", 1595289711).buffer },
            { url: image + "userdata.img", async: true, size: fs.statSync(image + "userdata.img").size },
            // (dEQP's disk: vdd)
            ...(deqp ? [{ url: deqp.image, async: true, size: fs.statSync(deqp.image).size, readonly: true }] : []),
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
    // (A32_ANDROID_PROBE_HOME: likewise, with the home screen up)
    for(const command of (process.env.A32_ANDROID_PROBE_HOME || "").split(";;").filter(c => c.trim()))
    {
        console.log(`probe (home): ${command}\n` + (await ask(command, "A32_PROBE", 600000)).split("\n").slice(1).join("\n").slice(0, 8000));
    }
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
    // (A32_ANDROID_SCREEN: an activity started, its screen taken: the same
    // picture in both GPU modes, docs/gles-proxy-plan.md E3's comparison)
    // (A32_ANDROID_RATE_AFTER: the machine clock's rate from here on, e.g. 1
    // after a boot at the device model's tenth: how fast the screen can go)
    if(process.env.A32_ANDROID_RATE_AFTER)
    {
        emulator.v86.cpu.clock.rate = Number(process.env.A32_ANDROID_RATE_AFTER);
        console.log("clock rate now " + emulator.v86.cpu.clock.rate);
    }
    if(process.env.A32_ANDROID_SCREEN)
    {
        await dismiss_dialogs();
        const started = await ask("am start -W " + process.env.A32_ANDROID_SCREEN, "A32_SCREEN", 900000);
        console.log("screen: " + started.replace(/\s+/g, " ").slice(-200));
        await new Promise(resolve => setTimeout(resolve, 60000));
        await dismiss_dialogs();
        await new Promise(resolve => setTimeout(resolve, 20000));
        console.log("screen focus: " + await focus() + "; frames " + fb.frames);
        save_png(sink, run_directory, "screen");
        // (the frames a scrolled list draws: swipes up and down for a minute,
        // the screen's frames counted, in the host's seconds)
        const events = emulator.v86.cpu.devices.goldfish_events;
        const swipe = async (y0, y1) =>
        {
            events.absolute([fb.width / 2, y0, fb.width, fb.height]);
            events.click([true]);
            for(let i = 1; i <= 10; i++)
            {
                await new Promise(resolve => setTimeout(resolve, 50));
                events.absolute([fb.width / 2, y0 + (y1 - y0) * i / 10, fb.width, fb.height]);
            }
            events.click([false]);
            await new Promise(resolve => setTimeout(resolve, 2500));
        };
        const frames_before = fb.frames, gles_before = gles_summary(), fps_start = performance.now();
        for(let i = 0; i < 12; i++) await swipe(i % 2 ? fb.height * 0.3 : fb.height * 0.8, i % 2 ? fb.height * 0.8 : fb.height * 0.3);
        const fps_seconds = (performance.now() - fps_start) / 1000;
        const gles_after = gles_summary();
        console.log(`fps: ${((fb.frames - frames_before) / fps_seconds).toFixed(2)} frames a second over ${fps_seconds.toFixed(0)} s of swipes` +
            (gles_after ? `; GLES host ${(gles_after.batches.cpu_ms - gles_before.batches.cpu_ms).toFixed(0)} ms of CPU, ` +
                `${gles_after.batches.batches - gles_before.batches.batches} batches, ${((gles_after.batches.bytes - gles_before.batches.bytes) / 1048576).toFixed(1)} MiB` : ""));
        save_png(sink, run_directory, "screen-scrolled");
        await ask("input keyevent 3", "A32_SCREEN_HOME", 600000);
    }
    if(process.env.A32_ANDROID_APP === "1")
    {
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
    if(process.env.A32_ANDROID_GLES_APP === "1")
    {
        const lib = build_native_lib(4096, "v86gles", ["-landroid", "-llog", "-lEGL", "-lGLESv2", "-lGLESv1_CM"],
            { abi: "armeabi-v7a", source: ROOT + "tests/a32/android/v86gles.c" });
        const apk = build_apk({ label: "v86 gles", package_name: "org.v86.gles", min_sdk: 21, target_sdk: 25,
            native: { name: "v86gles", lib, extract: true, abi: "armeabi-v7a" } });
        const text = apk.toString("base64");
        await ask("rm -f /data/local/tmp/gles.b64", "A32_RM", 600000);
        for(let at = 0; at < text.length; at += 768) await ask(`echo ${text.slice(at, at + 768)} >> /data/local/tmp/gles.b64`, "A32_PUT", 600000);
        const installed = await ask("base64 -d /data/local/tmp/gles.b64 > /data/local/tmp/gles.apk && pm install -r /data/local/tmp/gles.apk", "A32_INSTALL", 900000);
        assert.match(installed, /Success/, "pm install");
        await ask("logcat -c; am start -n org.v86.gles/android.app.NativeActivity", "A32_START", 900000);
        let log = "";
        for(let i = 0; i < 60 && !/V86_GLES_DONE/.test(log); i++)
        {
            await new Promise(resolve => setTimeout(resolve, 10000));
            log = await ask("logcat -d -s v86gles:I", "A32_GLES_LOG", 600000);
        }
        console.log(log.split("\n").filter(l => /V86_GLES/.test(l)).join("\n"));
        assert.match(log, /V86_GLES_DONE/, "the GLES app finished");
        // each scene's pixels: GL's rows (y from the bottom), RGB within 3
        const scenes = {};
        for(const m of log.matchAll(/V86_GLES (\w+)((?: \d+,\d+=\d+,\d+,\d+,\d+)+) glerror=(\w+)/g))
        {
            scenes[m[1]] = { error: m[3], pixels: [...m[2].matchAll(/(\d+),(\d+)=(\d+),(\d+),(\d+),(\d+)/g)].map(p => p.slice(3, 6).map(Number)) };
        }
        const expect = (scene, colors) =>
        {
            const got = scenes[scene];
            assert.ok(got, "scene " + scene);
            assert.equal(got.error, "0", scene + ": no GL error");
            colors.forEach((color, i) => assert.ok(color.every((v, j) => Math.abs(v - got.pixels[i][j]) <= 3),
                `${scene} pixel ${i}: ${got.pixels[i]} is not ${color}`));
        };
        expect("clear", [[0, 255, 0], [255, 0, 0]]);
        expect("draw", [[128, 0, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 0, 0]]);
        expect("fbo", [[0, 255, 255], [255, 255, 0], [255, 255, 0]]);
        expect("etc1", [[138, 138, 138]]);
        expect("gles1", [[255, 128, 0], [0, 255, 0]]);
        expect("light", [[128, 128, 128]]);
        expect("drawtex", [[0, 0, 255], [128, 128, 128]]);
        save_png(sink, run_directory, "gles-app");
        console.log("gles app: every scene as GLES draws it");
    }
    if(deqp)
    {
        // copied in as root (the shell cannot read another filesystem's files), installed, run
        // (each step on its own: the files then belong to the shell, which pm install's reads need)
        for(const step of ["mkdir -p /data/local/tmp/deqp-disk", "mount -t ext2 -o ro /dev/block/vdd /data/local/tmp/deqp-disk",
            "cp /data/local/tmp/deqp-disk/deqp.apk /data/local/tmp/deqp-disk/dEQP-* /data/local/tmp/", "umount /data/local/tmp/deqp-disk",
            "chown shell:shell /data/local/tmp/deqp.apk /data/local/tmp/dEQP-*", "chmod 644 /data/local/tmp/deqp.apk /data/local/tmp/dEQP-*"])
        {
            const out = await ask(`su 0 sh -c '${step}' 2>&1`, "A32_DEQP_COPY", 900000);
            if(/denied|No such|failed|Invalid/i.test(out)) console.log("dEQP copy: " + out.replace(/\s+/g, " ").slice(-300));
        }
        console.log(await ask("ls -l /data/local/tmp | head", "A32_DEQP_LS", 600000));
        const installed = await ask("pm install -r -g /data/local/tmp/deqp.apk", "A32_DEQP_INSTALL", 1800000);
        assert.match(installed, /Success/, "dEQP installed");
        const results = {}, details_of = {};
        const started_deqp = performance.now();
        for(const chunk of deqp.chunks)
        {
            const command_line = `--deqp-caselist-file=/sdcard/deqp-cases.txt --deqp-gl-config-name=rgba8888d24s8ms0 --deqp-surface-type=window ` +
                `--deqp-screen-rotation=unspecified --deqp-log-images=disable --deqp-log-shader-sources=disable --deqp-watchdog=enable`;
            // (the console's shell has no access to /sdcard, which the tester reads and writes: as root)
            await ask(`su 0 sh -c 'cp /data/local/tmp/${chunk.name} /sdcard/deqp-cases.txt'`, "A32_DEQP_CASES", 600000);
            const run = await ask(`am instrument -w -e deqpLogFileName /sdcard/deqp.qpa -e deqpCmdLine "${command_line}" -e deqpLogData false ` +
                `com.drawelements.deqp/com.drawelements.deqp.testercore.DeqpInstrumentation`, "A32_DEQP_RUN", 7200000);
            // (the results: the instrumentation's status lines, as CTS's runner reads them; no log file is written)
            let current = null;
            for(const line of run.replace(/\r/g, "").split("\n"))
            {
                const begin = /dEQP-BeginTestCase-TestCasePath=(\S+)/.exec(line);
                if(begin) { current = begin[1]; results[current] = "Crash"; continue; }
                const code = /dEQP-TestCaseResult-Code=(\w+)/.exec(line);
                if(code && current) results[current] = code[1];
                const terminated = /dEQP-TerminateTestCase-Reason=(.*)/.exec(line);
                if(terminated && current) results[current] = "Terminated";
                const details = /dEQP-TestCaseResult-Details=(.*)/.exec(line);
                if(details && current && results[current] !== "Pass") details_of[current] = details[1].slice(0, 200);
            }
            for(const c of chunk.cases) if(!(c in results)) results[c] = "NotRun";
            const counts = {};
            for(const c of chunk.cases) counts[results[c]] = (counts[results[c]] || 0) + 1;
            console.log(`${chunk.name}: ${JSON.stringify(counts)} (${((performance.now() - started_deqp) / 1000).toFixed(0)} s)` +
                (/INSTRUMENTATION_FAILED|Process crashed|Exception=/.test(run) ? " " + run.replace(/\s+/g, " ").slice(-300) : ""));
            // (a run that ran nothing: its tester's crash, if any, from the log)
            if(chunk.cases.every(c => results[c] === "NotRun"))
            {
                console.log((await ask("logcat -d -v brief -b crash -b main '*:E' | grep -i -E 'deqp|drawelements|Fatal|backtrace|#0[0-9] pc' | tail -25",
                    "A32_DEQP_CRASH", 600000)).replace(/\r/g, "").split("\n").slice(1).join("\n").slice(0, 3000));
            }
            fs.writeFileSync(run_directory + "deqp.json", JSON.stringify(results, null, 1));
            fs.writeFileSync(run_directory + "deqp-details.json", JSON.stringify(details_of, null, 1));
        }
        const by_status = {};
        for(const status of Object.values(results)) by_status[status] = (by_status[status] || 0) + 1;
        const supported = Object.values(results).filter(s => s !== "NotSupported").length;
        const passed = Object.values(results).filter(s => s === "Pass" || s === "QualityWarning" || s === "CompatibilityWarning").length;
        console.log(`dEQP: ${JSON.stringify(by_status)}; ${passed} of ${supported} supported cases pass (${(100 * passed / supported).toFixed(1)}%)`);
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
