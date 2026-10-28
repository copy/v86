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
// (A32_ANDROID_RATE_AFTER=<rate>: the clock's rate changed first;
// A32_ANDROID_PROBE_SCREEN: shell commands run with it up).
// A32_ANDROID_GPU=host: the device model's GPU mode "host" (qemu.gles=1,
// ranchu_gpu "host": the GLES host, docs/gles-proxy-plan.md); the GLES
// calls' counts go to the run's gles.json, its batches to gles-batches.bin
// (read by tools/gles/batches.mjs), and an opcode the host does not know,
// or a command it cannot decode, fails the test. A32_ANDROID_RENDERER=chrome:
// the renderer is a real GPU's (headless Chrome, tests/gles/chrome_renderer.mjs),
// the screen SurfaceFlinger's frames; otherwise nothing is drawn.
// A32_ANDROID_PROPS="name=value,...": boot properties changed (an empty
// value removes one: "ro.config.low_ram="); A32_ANDROID_BOOTANIM=1: the boot
// animation on (both for the files' boot, not A32_ANDROID_DISK);
// A32_ANDROID_BOOT_SHOTS=1: a screenshot every 20 s until the boot completes.
// A32_ANDROID_GLES_APP=1 (with A32_ANDROID_GPU=host): after the home screen,
// tests/a32/android/v86gles.c's APK (GLES 2.0, 1.1 and 3.0 scenes read back with
// glReadPixels: docs/gles-proxy-plan.md E4) is installed and started, and
// the pixels it logs are checked against GLES's rules.
// A32_ANDROID_DEQP=1 (with A32_ANDROID_GPU=host): dEQP-GLES2 and dEQP-EGL
// from CTS 7.1_r29 (tools/a32_cts.mjs fetches them) on a fourth virtio disk
// (ext2, mke2fs -d), copied in with su, installed, run by its
// instrumentation in chunks (the results from its status lines); the subset (docs/gles-proxy-plan.md E4): every
// state_query and negative_api case, dEQP-EGL.info, and every ninth other
// functional case (A32_ANDROID_DEQP_STEP another; A32_ANDROID_DEQP_FILTER a
// pattern of cases to keep; A32_ANDROID_DEQP_IMAGES=1 the log with its images
// and shader sources in the instrumentation's output, kept); each case's status into the run's deqp.json.
// A32_ANDROID_DEQP_SUITE=gles3 (or gles31): that suite's case list in GLES 2's
// place (docs/gles3-plan.md L4). A32_ANDROID_DEQP_RESUME: an earlier run's
// deqp.json, whose passed and unsupported cases are not run again (the rest,
// failures among them, are); the run's deqp.json has both. A32_ANDROID_GLES_VERSION: the GLES version
// the host announces (src/android/devices.js's default otherwise).
// A32_ANDROID_MEDIA=1 (with A32_ANDROID_GPU=host): Replica Island (GLES 1)
// and Shattered Pixel Dungeon (libGDX, GLES 2) from F-Droid on a fourth
// disk, each played for a minute; a green H.264 clip in Gallery's player
// (the decoder's YUV frames, converted by gralloc).
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
// (A32_ANDROID_GLES_VERSION: the version the GLES host announces, the device model's default unless given)
const gpu = ranchu_gpu_mode(RANCHU_25_ARMEABI_V7A, gpu_mode, process.env.A32_ANDROID_GLES_VERSION);
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

/**
 * A copy of system.img (a clone: APFS shares its blocks) whose
 * libEGL_emulation names EGL_KHR_create_context: dEQP wants the name for a
 * GLES 3.x context. The guest's EGL takes the extension's attributes (the
 * major and minor versions, "no ES 3.1 support") but its extension string is
 * a constant without the name; the name goes over the native sync
 * extensions' names after the constant, which it uses only with a host that
 * announces native sync (ours does not).
 * @return {string} the copy's path
 */
function create_context_system(source, target)
{
    const constant = "EGL_ANDROID_image_native_buffer EGL_KHR_fence_sync EGL_KHR_image_base EGL_KHR_gl_texture_2d_image ";
    const old = Buffer.from(constant + "\0EGL_ANDROID_native_fence_sync \0EGL_KHR_wait_sync \0", "latin1");
    const patched = Buffer.alloc(old.length);
    Buffer.from(constant + "EGL_KHR_create_context ", "latin1").copy(patched);
    if(fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs) return target;
    const partial = target + ".partial";
    fs.copyFileSync(source, partial, fs.constants.COPYFILE_FICLONE);
    const fd = fs.openSync(partial, "r+");
    const chunk = Buffer.alloc(64 << 20);
    let found = 0;
    for(let at = 0; ; at += chunk.length - old.length)
    {
        const n = fs.readSync(fd, chunk, 0, chunk.length, at);
        for(let i = chunk.subarray(0, n).indexOf(old); i >= 0; i = chunk.subarray(0, n).indexOf(old, i + 1))
        {
            fs.writeSync(fd, patched, 0, patched.length, at + i);
            found++;
        }
        if(n < chunk.length) break;
    }
    fs.closeSync(fd);
    assert.ok(found > 0, "libEGL_emulation's extension string in system.img");
    fs.renameSync(partial, target);
    return target;
}

// (dEQP: its files on an ext2 disk of their own, and the cases to run)
let deqp = null;
/** The dEQP results a resumed run does not run again */
const DEQP_DONE = new Set(["Pass", "NotSupported", "QualityWarning", "CompatibilityWarning"]);
if(process.env.A32_ANDROID_DEQP === "1")
{
    const { fetch_files, DEQP_FILES } = await import("../../tools/a32_cts.mjs");
    // (A32_ANDROID_DEQP_SUITE: gles2, or gles3 / gles31 (docs/gles3-plan.md L4): its case list instead of GLES 2's)
    const suite = process.env.A32_ANDROID_DEQP_SUITE || "gles2";
    const [apk, list, egl] = await fetch_files([DEQP_FILES[0], suite + "-master.txt", ...DEQP_FILES.slice(2)], true);
    const prefix = "dEQP-" + suite.toUpperCase();
    const step = Number(process.env.A32_ANDROID_DEQP_STEP || 9);
    const filter = new RegExp(process.env.A32_ANDROID_DEQP_FILTER || ".");
    const all = fs.readFileSync(list, "utf8").split("\n").filter(Boolean);
    const sampled = all.filter((c, i) => /\.(state_query|negative_api)\./.test(c) || c.startsWith(prefix + ".info.") ||
        c.startsWith(prefix + ".functional.") && i % step === 0);
    // (A32_ANDROID_DEQP_RESUME: an earlier run's results; its passed and unsupported cases kept, not run)
    const earlier = process.env.A32_ANDROID_DEQP_RESUME ? JSON.parse(fs.readFileSync(process.env.A32_ANDROID_DEQP_RESUME, "utf8")) : {};
    const kept = Object.fromEntries(Object.entries(earlier).filter(([, status]) => DEQP_DONE.has(status)));
    const keep = c => filter.test(c) && !(c in kept);
    const cases = { [prefix]: sampled.filter(keep),
        "dEQP-EGL": fs.readFileSync(egl, "utf8").split("\n").filter(c => c.startsWith("dEQP-EGL.info.") && keep(c)) };
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
    // (GLES 3.x's suites: EGL_KHR_create_context named, create_context_system)
    deqp = { image, chunks, kept, system: suite === "gles2" ? null : create_context_system(directory + "armeabi-v7a/system.img",
        directory + "system-egl-create-context.img") };
    console.log(`dEQP: ${cases[prefix].length} ${prefix} and ${cases["dEQP-EGL"].length} EGL cases in ${chunks.length} runs` +
        (Object.keys(kept).length ? `, ${Object.keys(kept).length} kept from ${process.env.A32_ANDROID_DEQP_RESUME}` : ""));
}
// A32_ANDROID_MEDIA=1: two open-source games from F-Droid (Replica Island
// 1.4, archive; Shattered Pixel Dungeon 4.0.2, F-Droid's build) and a green
// H.264 clip (ffmpeg) on a fourth virtio disk, as dEQP's
let media = null;
if(process.env.A32_ANDROID_MEDIA === "1")
{
    assert.ok(!deqp, "A32_ANDROID_MEDIA and A32_ANDROID_DEQP both want the fourth disk");
    const apks = ROOT + "build/a32-android/apks/";
    const games = [
        // (steps, each with a screenshot after it: into the game. [x, y] a tap in the screen's pixels; {view} the
        // view uiautomator finds by that pattern (its text or resource id) tapped, wherever the app's slow start
        // left it ({at} the tap when it finds none). Replica Island's menus are views, in landscape: the control
        // setup's "Leave it this way", the news' "Rock on!", Start, the middle difficulty, then the first
        // conversation; playing: its game activity, or the conversations it opens over the level, the arrow keys
        // (the control scheme it picks for the emulator's keyboard). Shattered Pixel Dungeon draws everything
        // itself: "Enter the Dungeon", the warrior, Start, the story's Continue (four times: it shows once the
        // level is made, but has never answered a tap here), the story's fold arrow (it hides the text: taps do
        // reach the scene), a tap that brings the text back, and Enter (a key's release is Continue too: into the
        // level, where taps walk); {key} set-1 scancodes)
        { name: "replicaisland", package: "com.replica.replicaisland", file: "replicaisland_14.apk",
            steps: [{ view: 'text="Leave it this way"', at: [90, 225] }, { view: 'text="Rock on!"', at: [90, 365] },
                { view: 'resource-id="[^"]*startButton"' }, { view: 'resource-id="[^"]*kidsButton"' }, [240, 400]],
            playing: /AndouKun|ConversationDialogActivity/, keys: true,
            url: "https://f-droid.org/archive/com.replica.replicaisland_14.apk", sha256: "35d900fabe6bbc05899c3fcc0fb5926a5a901d807889d0d111b34a1e87d7acde" },
        { name: "shatteredpixeldungeon", package: "com.shatteredpixel.shatteredpixeldungeon", file: "shatteredpixeldungeon_921.apk",
            steps: [[240, 750], [40, 770], [240, 700], [240, 565], [240, 565], [240, 565], [240, 565], [370, 570], [240, 400],
                { key: [0x1C, 0x9C] }], log: true,
            url: "https://f-droid.org/repo/com.shatteredpixel.shatteredpixeldungeon_921.apk", sha256: "dbd8205680e89758babf608212a1fb3f498f732118b1e3c0b9fd33bf67486a99" },
    ];
    const root = run_directory + "media-disk/";
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    for(const game of games)
    {
        if(!fs.existsSync(apks + game.file))
        {
            fs.mkdirSync(apks, { recursive: true });
            const response = await fetch(game.url);
            assert.equal(response.status, 200, game.url);
            fs.writeFileSync(apks + game.file, Buffer.from(await response.arrayBuffer()));
        }
        const { createHash: create_hash } = await import("node:crypto");
        assert.equal(create_hash("sha256").update(fs.readFileSync(apks + game.file)).digest("hex"), game.sha256, game.file);
        fs.copyFileSync(apks + game.file, root + game.name + ".apk");
    }
    // (3 s of green, 176 by 144, H.264 baseline: the software decoder's YUV frames through gralloc)
    const clip = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x00FF00:s=176x144:d=3:r=15", "-c:v", "libx264",
        "-profile:v", "baseline", "-pix_fmt", "yuv420p", root + "green.mp4"], { encoding: "utf8" });
    assert.equal(clip.status, 0, clip.stderr);
    const image = run_directory + "media.img";
    fs.rmSync(image, { force: true });
    const made = spawnSync("/opt/homebrew/opt/e2fsprogs/sbin/mke2fs", ["-q", "-t", "ext2", "-b", "4096", "-d", root, image, "96M"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    media = { image, games };
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
        ranchu_properties: properties, ranchu_gpu: gpu.ranchu_gpu, ...(gpu.gles_version ? { ranchu_gles_version: gpu.gles_version } : {}),
        // (the device model's clock rate, as the bootloader hands it over; A32_ANDROID_RATE another)
        ...(process.env.A32_PARALLEL === "1" ? {} : { cpu_clock: { rate: Number(process.env.A32_ANDROID_RATE || RANCHU_25_ARMEABI_V7A.clock_rate) } }),
        virtio_disks: [
            { url: deqp && deqp.system || image + "system.img", async: true, size: fs.statSync(image + "system.img").size, readonly: true },
            { buffer: make_empty_ext4(64 << 20, "cache", 1595289711).buffer },
            { url: image + "userdata.img", async: true, size: fs.statSync(image + "userdata.img").size },
            // (dEQP's disk: vdd)
            ...(deqp ? [{ url: deqp.image, async: true, size: fs.statSync(deqp.image).size, readonly: true }] : []),
            ...(media ? [{ url: media.image, async: true, size: fs.statSync(media.image).size, readonly: true }] : []),
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
        // (A32_ANDROID_BOOT_SHOTS=1: the screen every 20 s until the boot completes: the boot animation)
        let shot_number = 0;
        const boot_shots = process.env.A32_ANDROID_BOOT_SHOTS === "1" ?
            setInterval(() => save_png(sink, run_directory, "boot-" + String(++shot_number).padStart(2, "0")), 20000) : null;
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
        if(boot_shots) clearInterval(boot_shots);
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
    const focus = async () =>
    {
        // (between two windows there is none: asked again)
        for(let i = 0; i < 3; i++)
        {
            const now = (await ask("dumpsys window | grep mCurrentFocus", "A32_FOCUS", 600000)).match(/mCurrentFocus=\S+ \S+ ([^}]+)\}/)?.[1];
            if(now) return now;
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        return "";
    };
    // (background ANRs are shown, not killed: their dialogs' Wait, found by uiautomator)
    const dismiss_dialogs = async () =>
    {
        for(let i = 0; i < 8 && /Not Responding|Application Error/.test(await focus()); i++)
        {
            // (an ANR's Wait; a crash's "Close app")
            const dump = await ask("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; " +
                "grep -o -E 'text=\"(Wait|Close app|OK)\"[^>]*bounds=\"[^\"]*\"' /data/local/tmp/ui.xml | head -1", "A32_UI", 900000);
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
        // (until the screen below its app bar has content: more than a few
        // colors in the middle rows; the guest's clock is slow, a list loads
        // late; at most ten minutes)
        const colors = () =>
        {
            const seen = new Set();
            for(let y = Math.round(fb.height * 0.2); y < fb.height * 0.85; y += 4)
            {
                for(let x = 0; x < fb.width; x += 4)
                {
                    const at = (y * sink.width + x) * 4;
                    seen.add(sink.rgba[at] << 16 | sink.rgba[at + 1] << 8 | sink.rgba[at + 2]);
                }
            }
            return seen.size;
        };
        const loaded_by = performance.now() + 600000;
        while(colors() < 16 && performance.now() < loaded_by)
        {
            await new Promise(resolve => setTimeout(resolve, 15000));
            await dismiss_dialogs();
        }
        console.log("screen focus: " + await focus() + "; frames " + fb.frames + "; " + colors() + " colors");
        save_png(sink, run_directory, "screen");
        // (A32_ANDROID_PROBE_SCREEN: shell commands with the activity up)
        for(const command of (process.env.A32_ANDROID_PROBE_SCREEN || "").split(";;").filter(c => c.trim()))
        {
            console.log(`probe (screen): ${command}\n` + (await ask(command, "A32_PROBE", 900000)).split("\n").slice(1).join("\n").slice(0, 8000));
        }
        const events = emulator.v86.cpu.devices.goldfish_events;
        const swipe = async (y0, y1, settle = 2500) =>
        {
            events.absolute([fb.width / 2, y0, fb.width, fb.height]);
            events.click([true]);
            for(let i = 1; i <= 10; i++)
            {
                await new Promise(resolve => setTimeout(resolve, 50));
                events.absolute([fb.width / 2, y0 + (y1 - y0) * i / 10, fb.width, fb.height]);
            }
            events.click([false]);
            await new Promise(resolve => setTimeout(resolve, settle));
        };
        // (a scroll: Android's own swipe up inside the list, 1 s of the guest's
        // time; the harness's swipes are 50 ms of it at the slowed clock,
        // which Android takes for other gestures), the list's rows moved
        await dismiss_dialogs();
        const before_scroll = sink.rgba.slice();
        await ask(`input swipe ${fb.width / 2} ${fb.height * 0.75 | 0} ${fb.width / 2} ${fb.height * 0.35 | 0} 1000`, "A32_SCROLL", 900000);
        await new Promise(resolve => setTimeout(resolve, 20000));
        let moved = 0;
        for(let i = 0; i < sink.rgba.length; i += 4) if(sink.rgba[i] !== before_scroll[i] || sink.rgba[i + 1] !== before_scroll[i + 1]) moved++;
        console.log(`scroll: ${(100 * moved / (sink.rgba.length / 4)).toFixed(1)}% of the pixels changed`);
        save_png(sink, run_directory, "screen-scrolled-once");
        // (the frames a scrolled list draws: swipes up and down inside it for
        // a minute, the screen's frames counted, in the host's seconds)
        const pipe = emulator.v86.cpu.devices.goldfish_pipe, pipe_before = { ...pipe.stats };
        const instructions_before = emulator.get_instruction_counter();
        const frames_before = fb.frames, gles_before = gles_summary(), fps_start = performance.now();
        for(let i = 0; i < 12; i++) await swipe(i % 2 ? fb.height * 0.35 : fb.height * 0.75, i % 2 ? fb.height * 0.75 : fb.height * 0.35);
        const fps_seconds = (performance.now() - fps_start) / 1000;
        const gles_after = gles_summary();
        console.log(`fps: ${((fb.frames - frames_before) / fps_seconds).toFixed(2)} frames a second over ${fps_seconds.toFixed(0)} s of swipes` +
            (gles_after ? `; GLES host ${(gles_after.batches.cpu_ms - gles_before.batches.cpu_ms).toFixed(0)} ms of CPU, ` +
                `${gles_after.batches.batches - gles_before.batches.batches} batches, ${((gles_after.batches.bytes - gles_before.batches.bytes) / 1048576).toFixed(1)} MiB` : ""));
        // (the pipe's traps and transfers in that time: what pipe v2 would save)
        const delta = name => pipe.stats[name] - pipe_before[name];
        console.log(`pipe: ${(delta("mmio") / fps_seconds).toFixed(0)} register accesses a second, ${(delta("writes") / fps_seconds).toFixed(0)} writes ` +
            `(${(delta("bytes_written") / fps_seconds / 1024).toFixed(0)} KiB/s) and ${(delta("reads") / fps_seconds).toFixed(0)} reads a second; ` +
            `${(((emulator.get_instruction_counter() - instructions_before + 0x100000000) % 0x100000000) / fps_seconds / 1e6).toFixed(1)} M guest instructions a second`);
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
        const lib = build_native_lib(4096, "v86gles", ["-landroid", "-llog", "-lm", "-lEGL", "-lGLESv3", "-lGLESv2", "-lGLESv1_CM"],
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
        // EGL: both swap intervals taken, a fence signaled (EGL_CONDITION_SATISFIED_KHR, EGL_SIGNALED_KHR),
        // a pbuffer cleared, a texture of a share group sampled in its other context
        const egl = /V86_GLES egl intervals=(\d+),(\d+) sync=(\d+) wait=(\w+) status=(\w+)/.exec(log);
        assert.ok(egl, "the EGL scene");
        assert.deepEqual(egl.slice(1), ["1", "1", "1", "30f6", "30f2"], "swap intervals, the fence");
        expect("pbuffer", [[255, 255, 0]]);
        expect("shared", [[255, 0, 255]]);
        // GLES 3.0's scenes (docs/gles3-plan.md L4) where the host announces it
        if(gpu.gles_version !== "2.0")
        {
            assert.match(log, /V86_GLES gles3 OpenGL ES 3\./, "a GLES 3 context");
            expect("instanced", [[255, 128, 0], [255, 128, 0], [0, 0, 0]]);
            expect("mrt1", [[0, 0, 255]]);
            expect("mrtclear", [[0, 255, 0]]);
            expect("mrt0", [[255, 0, 0]]);
            assert.match(log, /V86_GLES integer 4000000000,0,0,1 glerror=0/, "an unsigned integer buffer read as integers");
            assert.match(log, /V86_GLES feedback -2,-2,2,-2,-2,2 glerror=0/, "transform feedback, mapped");
            expect("volume", [[0, 0, 255]]);
            expect("resolve", [[255, 0, 255]]);
            assert.match(log, /V86_GLES pack 255,0,255,255 glerror=0/, "a read into a pixel pack buffer, mapped");
        }
        // GLES 3.1's (L5) where the host announces it
        if(gpu.gles_version === "3.1" || gpu.gles_version === "3.2")
        {
            assert.match(log, /V86_GLES storage 0,3,6,9,12,15,18,21 glerror=0/, "a dispatch's storage buffer, mapped");
            assert.match(log, /V86_GLES counter 18 glerror=0/, "an atomic counter incremented 8 times from 10, mapped");
            expect("computed", [[0, 255, 0]]);
        }
        // (GLES 3.2's reach through the guest's library, where the host announces it: printed)
        const reach = /V86_GLES gles32 .*/.exec(log);
        if(reach) console.log("gles app: " + reach[0].replace(/^V86_GLES /, ""));
        // GLES 3.0's frame rate (docs/gles3-plan.md L7), one instanced draw a frame ("fps") and a draw a cube
        // ("fpsdraws"): the middle cube drawn (not the clear color), the frames in the guest's time; the host's
        // frame rate that time at the clock's rate (a tenth of the host's)
        if(gpu.gles_version !== "2.0")
        {
            const rate = Number(process.env.A32_ANDROID_RATE || RANCHU_25_ARMEABI_V7A.clock_rate);
            const clear = [26, 26, 51];
            const timed = [];
            for(const name of ["fps", "fpsdraws"])
            {
                assert.ok(scenes[name] && scenes[name].error === "0", "the frame rate scene " + name);
                assert.ok(scenes[name].pixels[0].some((v, i) => Math.abs(v - clear[i]) > 10), name + ": the middle cube: " + scenes[name].pixels[0]);
                const m = new RegExp(`V86_GLES ${name} frames=(\\d+) draws=(\\d+) guest_ms=([\\d.]+)`).exec(log);
                assert.ok(m && +m[1] > 0, name + ": frames timed");
                const result = { name, draws: +m[2], frames: +m[1], guest_ms: +m[3], guest_fps: +m[1] / (+m[3] / 1000) };
                result.host_fps = result.guest_fps * rate;
                timed.push(result);
                console.log(`gles app: GLES 3.0 scene, ${result.draws} draw(s) a frame: ${result.frames} frames, ` +
                    `${result.guest_fps.toFixed(1)} fps of the guest's clock, ${result.host_fps.toFixed(2)} fps of the host's`);
            }
            fs.writeFileSync(run_directory + "fps.json", JSON.stringify({ clock_rate: rate, timed }, null, 1));
        }
        save_png(sink, run_directory, "gles-app");
        console.log("gles app: every scene as GLES draws it");
    }
    if(media)
    {
        // the disk's files in as root, given to the shell (as dEQP's)
        for(const step of ["mkdir -p /data/local/tmp/media-disk", "mount -t ext2 -o ro /dev/block/vdd /data/local/tmp/media-disk",
            "cp /data/local/tmp/media-disk/*.apk /data/local/tmp/", "cp /data/local/tmp/media-disk/green.mp4 /sdcard/green.mp4",
            "umount /data/local/tmp/media-disk", "chown shell:shell /data/local/tmp/*.apk", "chmod 644 /data/local/tmp/*.apk"])
        {
            const out = await ask(`su 0 sh -c '${step}' 2>&1`, "A32_MEDIA_COPY", 900000);
            if(/denied|No such|failed|Invalid/i.test(out)) console.log("media copy: " + out.replace(/\s+/g, " ").slice(-300));
        }
        // a video: Gallery's player, the frame's middle green (YV12 from the decoder, RGB from gralloc);
        // the GLES test app closed first (its frame has green in it)
        await ask("am force-stop org.v86.gles; input keyevent 3", "A32_VIDEO_CLEAN", 600000);
        // (YouTube's native code died of SIGILL again and again on T32's LDM.W of one register until the
        // arm32 core transferred it: its "keeps stopping" dialogs covered the video and the games. It
        // launches and stays up now; still disabled until a media run without this line passes)
        await ask("su 0 pm disable com.google.android.youtube", "A32_NO_YOUTUBE", 900000);
        // (Gallery's player opens the file itself: its storage permission, which nothing has granted yet, as Gallery
        // asks for it when it is opened from the launcher; the games' immersive mode without its first-time overlay,
        // which takes their touches)
        await ask("pm grant com.android.gallery3d android.permission.READ_EXTERNAL_STORAGE; " +
            "settings put secure immersive_mode_confirmations confirmed", "A32_MEDIA_SETUP", 900000);
        await dismiss_dialogs();
        console.log("video: " + (await ask("am start -a android.intent.action.VIEW -d file:///sdcard/green.mp4 -t video/mp4 " +
            "-n com.android.gallery3d/.app.MovieActivity", "A32_VIDEO", 900000)).replace(/\s+/g, " ").slice(-160));
        const green = () =>
        {
            let n = 0;
            for(let y = fb.height * 0.3 | 0; y < fb.height * 0.7; y += 8)
            {
                for(let x = fb.width * 0.2 | 0; x < fb.width * 0.8; x += 8)
                {
                    const at = (y * sink.width + x) * 4;
                    if(sink.rgba[at + 1] > 200 && sink.rgba[at] < 80 && sink.rgba[at + 2] < 80) n++;
                }
            }
            return n;
        };
        const video_by = performance.now() + 600000;
        while(green() < 20 && performance.now() < video_by)
        {
            await new Promise(resolve => setTimeout(resolve, 5000));
            await dismiss_dialogs();
        }
        const player = await focus();
        console.log(`video: ${green()} green samples; focus ${player}; frames ${fb.frames}`);
        save_png(sink, run_directory, "video");
        // (checked after the games: a video that does not play leaves them to be tried; its log first)
        const media_failures = [];
        if(!/MovieActivity/.test(player)) media_failures.push("Gallery's player has the focus: " + player);
        if(green() < 20)
        {
            media_failures.push("the video's frame is shown (green)");
            console.log("video log: " + await ask("logcat -d -v brief -s VideoView:W MediaPlayer:W NuPlayer:W NuPlayerDriver:W " +
                "ACodec:W MediaCodec:W OMXNodeInstance:W SoftAVC:W | grep -v -E '[[:space:]]at [a-z]' | head -30", "A32_VIDEO_LOG", 600000));
        }
        await ask("input keyevent 4; input keyevent 3", "A32_VIDEO_HOME", 600000);
        // the games: installed, started, a minute of taps and swipes, still running and drawing
        for(const game of media.games)
        {
            const installed = await ask(`pm install -r -g /data/local/tmp/${game.name}.apk`, "A32_GAME_INSTALL", 1800000);
            assert.match(installed, /Success/, game.name + " installed");
            await dismiss_dialogs();
            await ask(`monkey -p ${game.package} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`, "A32_GAME_START", 900000);
            await new Promise(resolve => setTimeout(resolve, 120000));
            await dismiss_dialogs();
            save_png(sink, run_directory, game.name + "-start");
            const events = emulator.v86.cpu.devices.goldfish_events;
            for(const [i, step] of game.steps.entries())
            {
                let at = Array.isArray(step) ? step : null;
                if(step.view)
                {
                    // (uiautomator's bounds are the rotated screen's, as input tap's)
                    const view = await ask("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; grep -o -E '<node [^>]*>' " +
                        `/data/local/tmp/ui.xml | grep -E '${step.view}' | grep -o -E 'bounds="[^"]*"' | head -1`, "A32_UI_STEP", 900000);
                    const m = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(view);
                    if(m) await ask(`input tap ${(+m[1] + +m[3]) >> 1} ${(+m[2] + +m[4]) >> 1}`, "A32_TAP", 600000);
                    else at = step.at || null;
                    console.log(`game ${game.name} step ${i + 1}: ${step.view} ` + (m ? "found" : at ? "not found, tapped at " + at : "not found"));
                }
                if(at) events.tap(at[0], at[1], fb.width, fb.height);
                for(const code of step.key || []) events.scancode(code);
                await new Promise(resolve => setTimeout(resolve, 45000));
                await dismiss_dialogs();
                save_png(sink, run_directory, `${game.name}-step${i + 1}`);
            }
            // (log: the game's warnings after the steps, and the compile filter its code got)
            if(game.log)
            {
                const pid = (await ask(`pidof ${game.package}`, "A32_GAME_PID", 600000)).match(/\n\s*(\d+)/)?.[1];
                if(pid)
                {
                    // (its own report of a slow level, "waited more than 10 seconds on levelgen", among them; the
                    // sound's errors left out: this machine has no audio output)
                    console.log(`game ${game.name} log: ` + await ask(`getprop pm.dexopt.install; logcat -d -v brief '*:W' | ` +
                        `grep -E '\\( *${pid}\\)' | grep -v -E 'AudioTrack|SoundPool|AndroidMusic' | head -40`, "A32_GAME_LOG", 600000));
                }
            }
            const frames_before = fb.frames, calls_before = Object.values(gles_summary()?.counts || {}).reduce((n, c) => n + c, 0);
            const play_until = performance.now() + 60000;
            for(let i = 0; performance.now() < play_until; i++)
            {
                // (a game played with keys: the right arrow held a second, the up arrow tapped)
                if(game.keys)
                {
                    for(const code of [0xE0, 0x4D]) events.scancode(code);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    for(const code of [0xE0, 0xCD, 0xE0, 0x48, 0xE0, 0xC8]) events.scancode(code);
                }
                // (taps across the middle, then a swipe)
                if(i % 4 === 3)
                {
                    events.absolute([fb.width * 0.3, fb.height * 0.5, fb.width, fb.height]);
                    events.click([true]);
                    for(let k = 1; k <= 8; k++) { await new Promise(r => setTimeout(r, 60)); events.absolute([fb.width * (0.3 + 0.05 * k), fb.height * 0.5, fb.width, fb.height]); }
                    events.click([false]);
                }
                else events.tap(fb.width * (0.3 + 0.2 * (i % 3)), fb.height * (0.45 + 0.1 * (i % 2)), fb.width, fb.height);
                await new Promise(resolve => setTimeout(resolve, 4000));
            }
            const running = (await ask(`pidof ${game.package}`, "A32_GAME_PID", 600000)).match(/\n\s*(\d+)/);
            const now = await focus();
            const calls = Object.values(gles_summary()?.counts || {}).reduce((n, c) => n + c, 0) - calls_before;
            console.log(`game ${game.name}: focus ${now}; ${fb.frames - frames_before} frames and ${calls} GLES calls in the minute; ` +
                (running ? "running, pid " + running[1] : "not running"));
            save_png(sink, run_directory, game.name + "-play");
            assert.ok(running, game.name + " still runs after a minute");
            if(game.playing && !game.playing.test(now)) media_failures.push(game.name + " plays: " + now);
            assert.ok(calls > 0 && fb.frames > frames_before, game.name + " draws");
            await ask(`am force-stop ${game.package}; input keyevent 3`, "A32_GAME_STOP", 600000);
        }
        assert.deepEqual(media_failures, [], "the video and the games");
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
        // (A32_ANDROID_DEQP_INSTALL_MS: the install's time, dex2oat's; 30 minutes, more on a loaded host)
        const installed = await ask("pm install -r -g /data/local/tmp/deqp.apk", "A32_DEQP_INSTALL", Number(process.env.A32_ANDROID_DEQP_INSTALL_MS || 1800000));
        assert.match(installed, /Success/, "dEQP installed");
        const results = Object.assign({}, deqp.kept), details_of = {};
        const started_deqp = performance.now();
        for(const chunk of deqp.chunks)
        {
            // (A32_ANDROID_DEQP_IMAGES=1: the log's images and shader sources too, its data in the instrumentation's output, kept in deqp-run-<n>.txt)
            const images = process.env.A32_ANDROID_DEQP_IMAGES === "1";
            const command_line = `--deqp-caselist-file=/sdcard/deqp-cases.txt --deqp-gl-config-name=rgba8888d24s8ms0 --deqp-surface-type=window ` +
                `--deqp-screen-rotation=unspecified --deqp-log-images=${images ? "enable" : "disable"} --deqp-log-shader-sources=${images ? "enable" : "disable"} --deqp-watchdog=enable`;
            // (the console's shell has no access to /sdcard, which the tester reads and writes: as root)
            await ask(`su 0 sh -c 'cp /data/local/tmp/${chunk.name} /sdcard/deqp-cases.txt'`, "A32_DEQP_CASES", 600000);
            const run = await ask(`am instrument -w -e deqpLogFileName /sdcard/deqp.qpa -e deqpCmdLine "${command_line}" -e deqpLogData ${images} ` +
                `com.drawelements.deqp/com.drawelements.deqp.testercore.DeqpInstrumentation`, "A32_DEQP_RUN", 7200000);
            if(images) fs.writeFileSync(run_directory + `deqp-run-${chunk.name}`, run);
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
            // (the instrumentation's last words when it stopped early: a crash, or cases it never began)
            console.log(`${chunk.name}: ${JSON.stringify(counts)} (${((performance.now() - started_deqp) / 1000).toFixed(0)} s)` +
                (/INSTRUMENTATION_FAILED|Process crashed|Exception=/.test(run) || counts.NotRun ? " " + run.replace(/\s+/g, " ").slice(-600) : ""));
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
