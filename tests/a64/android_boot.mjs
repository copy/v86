#!/usr/bin/env node
// Android 16 on the virt machine (docs/arm64-virt-android16-plan.md P10.3,
// P10.7, P11): tools/a64_android.mjs's Image, initrd.img and disk.img (the
// pinned Cuttlefish arm64-only phone, direct kernel boot, unlocked, SELinux
// enforcing) booted on the QEMU reference or on v86. The first boot each
// time: the disk's writes stay in memory (QEMU's snapshot=on, v86's buffer)
// for as long as the machine runs, across its reboots.
//
// QEMU (A64_ANDROID_TARGET=qemu, the default): tests/a64/android_qemu.mjs's
// machine, cortex-a35 under TCG (A64_ANDROID_ACCEL=hvf: the host's CPU, for
// quick runs). Passes when the Android console answers
// `getprop sys.boot_completed` with 1. A64_QEMU_PLUGINS=1 counts the
// instructions to that point (libinsn, and libhowvec's classes), for
// P10.3's budget.
//
// v86 (A64_ANDROID_TARGET=v86): the same materials and the devices in the
// same PCI order (virtio-blk 00:01.0, virtio-gpu 00:02.0 at 720x1280, three
// virtio-net (the third, under Cuttlefish's Wi-Fi, on the fetch adapter), 18
// console ports with the kernel's console on hvc0 and logcat on hvc2, rng,
// a keyboard and a multitouch screen, vsock), RAM above 1536 MiB as extended
// RAM. Passes when system_server has started and adbd answers over
// vsock:5555 (tests/a64/adb.mjs; A8's acceptance), and reports how far the
// boot got by the deadline (A64_ANDROID_WAIT=boot_completed: until
// sys.boot_completed=1). The fetch adapter only reaches the test's own
// server: every other URL is refused, nothing leaves the host.
//
// A64_ANDROID_SCENARIO=a9 (either target): after boot_completed, A9's
// acceptance (tests/a64/android_scenario.mjs): the desktop, the network,
// touch (v86), an app installed and started, a reboot with /data kept. On
// QEMU adb goes to tcp:5555 on Wi-Fi through a forwarded port once the
// console has turned Wi-Fi on; screenshots come from the monitor's screendump
// (QEMU) or the display (v86), into the run's directory.
//
//   A64_CORES (4), A64_MEMORY_MB (1536: about 1 GiB is the least that boots, P10.3), A64_JIT=1 (the page tier),
//   A64_PARALLEL=1 (vCPU workers), A64_ANDROID_GPU=venus (v86: virtio-gpu with Venus, the renderer in a headless
//   Chrome, the guest's driver initrd-venus.img's), A64_ANDROID_SAVE_STATE=<file> / A64_ANDROID_RESTORE_STATE=<file> (v86: a state after boot_completed, saved
//   or restored instead of booting), A64_ANDROID_TIMEOUT (ms), A64_ANDROID_PROBE=<file> (shell commands to run
//   over adb after boot_completed, one per line, with their output; A64_ANDROID_PUSH=<local>=<remote>,... first),
//   A64_ANDROID_PAGE_SIZE=16k (P12.1: tools/a64_android.mjs --page-size 16k's materials, build/a64-android/out-16k/; the
//   guest's page size and kernel are checked over adb or the console; A64_ANDROID_SCENARIO=pagesize records how native
//   APKs aligned to 4 and 16 KiB fare, android_scenario.mjs), A64_ANDROID_SCENARIO=cts (P12.3's CTS subset, android_cts.mjs;
//   A64_ANDROID_CTS_MODULES=<module>,... and A64_ANDROID_CTS_FILTER=<module>=<gtest filter>;... to try parts of it),
//   A64_ANDROID_SCENARIO=deqp (appendix F6: a dEQP subset through CtsDeqpTestCases's APK, android_deqp.mjs;
//   A64_ANDROID_DEQP=<package>=<prefix>,...;... for other cases), A64_ANDROID_SCENARIO=compat32 (the aarch32
//   plan's Q5.2: 32-bit apps on tools/a64_android.mjs --build a14's materials, A64_ANDROID_OUT=build/a64-android/out-a14;
//   on v86 with A64_PROFILE=v3, which has AArch32 at EL0; QEMU's cortex-a35 has it, HVF does not),
//   A64_PROFILE=v1.1 (the CPU profile without FEAT_PAN; v2, the default, has it), TEST_RELEASE_BUILD=1 (build/libv86.mjs),
//   A64_ANDROID_BOOTLOADER=1 (v86: the android option, the kernel and initrd from the disk),
//   A64_ANDROID_OUT=<dir> (tools/a64_android.mjs --out's materials in place of out/ or out-16k/), A64_ANDROID_CONSOLE=0 (QEMU:
//   a user build, such as a GSI with the release vendor ramdisk, has no console; boot_completed from the kernel's log)
// Logs: build/a64-android/runs/<tag>/ (kernel.log, logcat.log, console.log, *.png, result.json)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { android_qemu_args, AndroidConsole, qemu_screendump, qmp_connect, qemu_touch, qemu_picture_digest } from "./android_qemu.mjs";
import { createHash as create_hash } from "node:crypto";
import { qemu_binary } from "./guest_runner.mjs";
import { AdbClient } from "./adb.mjs";
import { a9_scenario, a10_scenario, pagesize_scenario, compat32_scenario, prepare_device, PREPARE_COMMAND, device_prepared } from "./android_scenario.mjs";
import { cts_scenario } from "./android_cts.mjs";
import { deqp_scenario } from "./android_deqp.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";
import { create_remote_renderer } from "../x64/gpu_remote_renderer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const page_size = { "": 4096, "4k": 4096, "16k": 16384 }[process.env.A64_ANDROID_PAGE_SIZE || ""];
assert.ok(page_size, "A64_ANDROID_PAGE_SIZE: 4k or 16k");
// (A64_ANDROID_OUT=<dir>: another tools/a64_android.mjs output, as --out gave it: --release --no-venus's, --gsi's)
const OUT = process.env.A64_ANDROID_OUT ? path.resolve(process.env.A64_ANDROID_OUT) + "/" :
    ROOT + (page_size === 4096 ? "build/a64-android/out/" : "build/a64-android/out-16k/");
for(const file of ["Image", "initrd.img", "disk.img", "cmdline.txt"])
{
    assert.ok(fs.existsSync(OUT + file), OUT + file + ` is missing: node tools/a64_android.mjs --download${page_size === 4096 ? "" : " --page-size 16k"}`);
}
/** the page size and kernel release the guest reports ("S=<getconf PAGE_SIZE> K=<uname -r>"), checked */
function check_page_size(output)
{
    const m = /S=(\d+) K=(\S+)/.exec(output);
    assert.ok(m && +m[1] === page_size, `the guest's page size: ${JSON.stringify(output)}, expected ${page_size}`);
    return { page_size: +m[1], kernel_release: m[2] };
}
const target = process.env.A64_ANDROID_TARGET || "qemu";
assert.ok(target === "qemu" || target === "v86", "A64_ANDROID_TARGET: qemu or v86");
const accel = process.env.A64_ANDROID_ACCEL || "tcg";
const cores = +process.env.A64_CORES || 4;
const memory_mb = +process.env.A64_MEMORY_MB || 1536;
const plugins = !!+process.env.A64_QEMU_PLUGINS;
const jit = !!+process.env.A64_JIT;
const parallel = !!+process.env.A64_PARALLEL;
const scenario = process.env.A64_ANDROID_SCENARIO || "";
// A64_ANDROID_BOOTLOADER=1 (v86): the android option in place of kernel, initrd and cmdline: v64's
// bootloader reads them from disk.img (docs/android-images-plan.md I2.3), the vendor ramdisk the tool's
const bootloader = !!+process.env.A64_ANDROID_BOOTLOADER;
assert.ok(!bootloader || target === "v86" && page_size === 4096, "A64_ANDROID_BOOTLOADER=1: v86, 4K (the 16K kernel is not on the disk)");
// A64_ANDROID_CONSOLE=0 (QEMU): no console (a user build's: ro.debuggable=0), boot_completed from the kernel's log
const use_console = process.env.A64_ANDROID_CONSOLE !== "0";
assert.ok(use_console || target === "qemu" && !scenario && !process.env.A64_ANDROID_PROBE, "A64_ANDROID_CONSOLE=0: QEMU, no scenario or probes");
assert.ok(!scenario || ["a9", "a10", "pagesize", "cts", "deqp", "compat32"].includes(scenario), "A64_ANDROID_SCENARIO: a9, a10, pagesize, cts, deqp or compat32");
assert.ok(!scenario || !plugins, "A64_ANDROID_SCENARIO and A64_QEMU_PLUGINS do not go together");
const wait_for_boot_completed = target === "qemu" || !!scenario || process.env.A64_ANDROID_WAIT === "boot_completed";
const tag = (target === "qemu" ? `qemu-${accel}${plugins ? "-plugins" : ""}` : `v86${jit ? "-jit" : ""}${parallel ? "-par" : ""}`) +
    `${process.env.A64_ANDROID_GPU ? "-" + process.env.A64_ANDROID_GPU : ""}${scenario ? "-" + scenario : ""}${page_size === 4096 ? "" : "-16k"}${bootloader ? "-bl" : ""}-${memory_mb}m-${cores}c` +
    (process.env.A64_ANDROID_OUT ? "-" + path.basename(OUT) : "");
const timeout = +process.env.A64_ANDROID_TIMEOUT || (target === "qemu" && !scenario ? (accel === "hvf" ? 600000 : plugins ? 14400000 : 3600000) : 14400000);
const directory = ROOT + `build/a64-android/runs/${tag}/`;
fs.mkdirSync(directory, { recursive: true });
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
        // (init's fatal errors reboot into the bootloader: an SELinux policy that does not compile, ...)
        if(/reboot: Restarting system with command 'bootloader'/.test(window)) fail(new Error("the guest rebooted into the bootloader (init failed: kernel.log)"));
        text = window.slice(-512);
    };
};
let fail;
const failed = new Promise((_, reject) => { fail = reject; });
failed.catch(() => {});

/**
 * adb over a byte stream that open() makes: a shell command's output, and
 * push; each a new connection, retried (adbd is away while the guest boots
 * or reboots) for up to retry_ms
 */
function adb_over(open, retry_ms = 600000)
{
    const session = async (fn, ms) => {
        const deadline = Date.now() + retry_ms;
        for(;;)
        {
            let stream;
            try
            {
                stream = await open();
                const client = new AdbClient(stream.adapter);
                await client.connect(60000);
                return await fn(client, ms);
            }
            catch(e)
            {
                if(Date.now() > deadline || /deadline|panic/.test(e.message)) throw e;
                await sleep(5000);
            }
            finally
            {
                stream?.close();
            }
        }
    };
    return {
        shell: (command, ms = 120000) => session((client, ms) => client.shell(command, ms), ms),
        push: (remote, bytes) => session(client => client.push(remote, bytes)),
        banner: () => session(client => client.banner),
        // (once: "reboot" must not run again on the rebooted guest)
        reboot: async () => {
            const stream = await open();
            try
            {
                const client = new AdbClient(stream.adapter);
                await client.connect(60000);
                await client.shell("reboot", 30000).catch(() => {});
            }
            finally
            {
                stream.close();
            }
        },
    };
}

/** the scenario's result, with its screenshots, into the result */
// A64_ANDROID_PROBE=<file>: after boot_completed, each line of the file a
// shell command over adb, with its time, length and output (debugging); a
// line "@screenshot <name>" saves the display as <name>.png;
// A64_ANDROID_PUSH=<local>=<remote>,...: files pushed first
const probe_file = process.env.A64_ANDROID_PROBE || "";
/** the rows whose change ends a timed tap (below the status bar, above the navigation bar) */
const LATENCY_ROWS = [300, 1000];
// A64_ANDROID_A10_MONKEY_MINUTES: A10's long run (30, P10.3's budget)
const monkey_minutes = +process.env.A64_ANDROID_A10_MONKEY_MINUTES || 30;
// A64_ANDROID_A10_STEPS=<step>,...: only these of A10's steps after the desktop (touch, frames, sound, monkey, memory; all by default)
const a10_steps = process.env.A64_ANDROID_A10_STEPS ? process.env.A64_ANDROID_A10_STEPS.split(",") : null;
async function run_probes(shell, push, screenshot)
{
    if(!probe_file) return;
    for(const pair of (process.env.A64_ANDROID_PUSH || "").split(",").filter(Boolean))
    {
        const [local, remote] = pair.split("=");
        await push(remote, fs.readFileSync(local));
        console.log(`push: ${local} -> ${remote}`);
    }
    let probe_number = 0;
    for(const command of fs.readFileSync(probe_file, "utf8").split("\n").filter(line => line.trim() && !line.startsWith("#")))
    {
        if(command.startsWith("@screenshot "))
        {
            console.log(`probe: screenshot ${await screenshot(command.slice(12).trim())}`);
            continue;
        }
        const start = Date.now();
        let output;
        try { output = await shell(command, 900000); }
        catch(e) { output = "(error: " + e.message + ")"; }
        // (the whole output in the run's directory, probe-<n>.txt)
        fs.writeFileSync(directory + `probe-${++probe_number}.txt`, command + "\n\n" + output);
        console.log(`probe: ${command}\n  ${Date.now() - start} ms, ${output.length} chars: ${JSON.stringify(output.slice(0, 4000))}`);
    }
}

async function run_scenario(env, result)
{
    console.log("scenario " + scenario);
    // (cts: A64_ANDROID_CTS_MODULES=<module>,... some of the subset only; A64_ANDROID_CTS_FILTER=<module>=<gtest filter>;...)
    const cts = env => cts_scenario(env, {
        modules: process.env.A64_ANDROID_CTS_MODULES ? process.env.A64_ANDROID_CTS_MODULES.split(",") : undefined,
        filter: process.env.A64_ANDROID_CTS_FILTER ? Object.fromEntries(process.env.A64_ANDROID_CTS_FILTER.split(";").map(f => f.split(/=(.*)/s).slice(0, 2))) : undefined });
    const found = await ({ a9: a9_scenario, a10: a10_scenario, pagesize: pagesize_scenario, cts, deqp: deqp_scenario, compat32: compat32_scenario })[scenario]({ ...env,
        log: text => console.log(`${(elapsed() / 1000).toFixed(0)} s: ${scenario}: ${text}`) });
    result[scenario] = found;
    mark(scenario + "_done");
    if(scenario === "cts") assert.ok(found.passed, "the CTS subset: " + JSON.stringify(found.modules));
    if(scenario === "deqp") assert.ok(found.passed, "the dEQP subset: " + JSON.stringify(found.packages).slice(0, 4000));
}

if(target === "qemu")
{
    const qemu = qemu_binary();
    const socket = `/tmp/v86-a64-android-${process.pid}.sock`, monitor = `/tmp/v86-a64-android-${process.pid}-m.sock`;
    const qmp_socket = `/tmp/v86-a64-android-${process.pid}-q.sock`;
    const adb_port = 15600 + process.pid % 1000;
    const args = android_qemu_args(OUT, { accel, memory_mb, cores, console_socket: socket,
        kernel_log: directory + "kernel.log", logcat: directory + "logcat.log",
        ...(scenario || probe_file ? { monitor_socket: monitor, adb_port } : {}), ...(scenario === "a10" ? { qmp_socket } : {}),
        sound_wav: directory + "sound.wav" });
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
        if(!use_console)
        {
            // (a user build has no console: boot_completed from init's line in the kernel's log)
            const qemu_failed = exited.then(code => { throw new Error("QEMU exited " + code); });
            qemu_failed.catch(() => {});
            await Promise.race([(async () => { while(marks.boot_completed === undefined) await sleep(1000); })(), failed, qemu_failed,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`no sys.boot_completed=1 in the kernel's log in ${timeout} ms`)), timeout))]);
            const result = { tag, console: false, marks, ms: elapsed() };
            child.kill("SIGKILL");
            await exited;
            fs.writeFileSync(directory + "result.json", JSON.stringify(result, null, 2) + "\n");
            console.log(JSON.stringify(result));
            console.log(`A64_ANDROID_BOOT_OK ${tag}`);
            process.exit(0);
        }
        await terminal.open();
        // (with a scenario, the device's settings from the console as soon as
        // the services take them, as v86 does over adb: on a slow boot the
        // lock screen must be off before SystemUI sets up its keyguard,
        // prepare_device in android_scenario.mjs)
        let prepared = !scenario;
        const until_booted = async () =>
        {
            for(;;)
            {
                if(!prepared)
                {
                    const p = await terminal.run(PREPARE_COMMAND, 60000);
                    if(p && device_prepared(p.output)) { prepared = true; mark("device_prepared"); }
                }
                const r = await terminal.run("getprop sys.boot_completed", 30000);
                if(r && r.output.trim() === "1") return;
                await sleep(5000);
            }
        };
        const qemu_failed = exited.then(code => { throw new Error("QEMU exited " + code); });
        qemu_failed.catch(() => {});
        await Promise.race([until_booted(), failed, qemu_failed,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`no sys.boot_completed=1 in ${timeout} ms`)), timeout))]);
        mark("boot_completed_getprop");
        const fingerprint = (await terminal.run("getprop ro.build.fingerprint")).output.trim();
        const result = { tag, fingerprint, marks, ...check_page_size((await terminal.run("echo S=$(getconf PAGE_SIZE) K=$(uname -r)")).output) };
        console.log(`page size ${result.page_size}, kernel ${result.kernel_release}`);
        if(scenario || probe_file)
        {
            // (Wi-Fi first, from the console: adb reaches the guest through it;
            // a user build's GSI has no su, and the shell may run cmd wifi)
            await terminal.run("S=; command -v su >/dev/null 2>&1 && S='su 0'; " +
                "$S cmd wifi set-wifi-enabled enabled; sleep 10; $S cmd wifi connect-network VirtWifi open", 120000);
            const tcp = () => new Promise((resolve, reject) => {
                const s = net.connect(adb_port, "127.0.0.1");
                s.once("connect", () => {
                    const adapter = { write: bytes => s.write(bytes), on_data: null };
                    s.on("data", bytes => adapter.on_data?.(bytes));
                    s.on("error", () => {});
                    resolve({ adapter, close: () => s.destroy() });
                });
                s.once("error", reject);
            });
            const adb = adb_over(tcp);
            await run_probes(adb.shell, adb.push, name => qemu_screendump(monitor, directory, name));
            if(scenario)
            {
                // (A10: taps through QMP, and their latency to the screen's first change in screendumps)
                const qmp = scenario === "a10" ? await qmp_connect(qmp_socket) : null;
                const touch = qmp ? (x, y) => qemu_touch(qmp, x, y, 720, 1280) : null;
                const digest = () => qemu_picture_digest(monitor, directory + "latency.ppm", LATENCY_ROWS[0], LATENCY_ROWS[1]);
                const tap_latency = touch ? async (x, y) => {
                    const before = await digest();
                    const started = performance.now();
                    await touch(x, y);
                    while(performance.now() - started < 60000)
                    {
                        if(await digest() !== before) return Math.round(performance.now() - started);
                    }
                    return null;
                } : null;
                // (what the sound card played: the WAV's samples written since reset)
                let sound_from = -1;
                const sound = { reset: () => { sound_from = fs.existsSync(directory + "sound.wav") ? fs.statSync(directory + "sound.wav").size : 44; },
                    played: () => {
                        const wav = fs.existsSync(directory + "sound.wav") ? fs.readFileSync(directory + "sound.wav") : Buffer.alloc(0);
                        const from = Math.max(44, sound_from);
                        return wav.subarray(from, from + (wav.length - from & ~3));
                    } };
                await run_scenario({ target, directory, adb: adb.shell, push: adb.push, reboot: adb.reboot,
                    screenshot: name => qemu_screendump(monitor, directory, name), touch, tap_latency, http: null, wait_reboot: () => sleep(30000), monkey_minutes, steps: a10_steps,
                    sound }, result);
                qmp?.close();
            }
        }
        fs.writeFileSync(directory + "console.log", terminal.text);
        terminal.close();
        child.kill(plugins ? "SIGINT" : "SIGKILL");
        await exited;
        result.ms = elapsed();
        if(plugins)
        {
            // (libinsn: "total insns: N"; libhowvec: the classes and their
            // counts, which QEMU may still be writing as it exits)
            await sleep(2000);
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
        console.error("marks: " + JSON.stringify(marks));
        process.exit(1);
    }
    finally
    {
        timers.forEach(clearInterval);
    }
}

// v86
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
// (the fetch adapter's requests: the test's own server only)
const local_fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
    const target_url = new URL(typeof url === "string" ? url : url.url);
    if(target_url.hostname !== "localhost" && target_url.hostname !== "127.0.0.1")
    {
        return Promise.resolve(new Response("not from this test", { status: 403 }));
    }
    return local_fetch(url, options);
};
const http_token = "v86-a9-" + Math.random().toString(36).slice(2);
const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${http_token} ${request.url}\n`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const http_port = server.address().port;

// (RAM: below 2 GiB with the display adapter's device memory, the rest extended RAM from 4 GiB)
const LOW_LIMIT_MB = 1536;
const low_mb = Math.min(memory_mb, LOW_LIMIT_MB);
const sink = new PictureSink();
// A64_ANDROID_GPU=venus (v86): virtio-gpu's level with Venus, drawn by the
// renderer in a headless Chrome (tests/x64/gpu_remote_renderer.mjs, GL_CHROME)
// A64_ANDROID_GPU=gfxstream (v86, A64_ANDROID_BOOTLOADER=1): virtio-gpu's
// level gfxstream, the image's own driver (vulkan.ranchu: gpu mode
// gfxstream's bootconfig), docs/gfxstream-plan.md
const gpu_level = process.env.A64_ANDROID_GPU || "";
assert.ok(!gpu_level || gpu_level === "venus" || gpu_level === "gfxstream", "A64_ANDROID_GPU: venus or gfxstream");
assert.ok(gpu_level !== "gfxstream" || bootloader, "A64_ANDROID_GPU=gfxstream: with A64_ANDROID_BOOTLOADER=1");
// (and tools/a64_android.mjs's initrd-venus.img: libvulkan's driver the odm's vulkan.virtio.so)
const initrd = gpu_level === "venus" ? "initrd-venus.img" : "initrd.img";
assert.ok(fs.existsSync(OUT + initrd), OUT + initrd + " is missing: make android-venus, then node tools/a64_android.mjs");
// (A64_ANDROID_SHADER_DIR=<dir>: Venus's shaders and pipelines written there, a corpus for VX's translation)
const remote = gpu_level ? await create_remote_renderer({ shader_dir: process.env.A64_ANDROID_SHADER_DIR }) : null;
// A64_ANDROID_SAVE_STATE=<file>: a V7 state saved after boot_completed;
// A64_ANDROID_RESTORE_STATE=<file>: such a state restored instead of booting
// (the same options otherwise), for quick rounds of probes
const save_state_file = process.env.A64_ANDROID_SAVE_STATE || "", restore_state_file = process.env.A64_ANDROID_RESTORE_STATE || "";
// virtio-snd (P12.5): the audio HAL's card; what it plays is collected
// while a scenario's sound step listens (sound.reset to sound.played)
let sound_chunks = null;
const sound = { reset: () => { sound_chunks = []; }, played: () => { const pcm = Buffer.concat(sound_chunks || []); sound_chunks = null; return pcm; } };
const emulator = new V86({
    cpu_type: "arm64", cpu_cores: cores, memory_size: low_mb * 1048576, log_level: 0, autostart: !restore_state_file,
    // (A64_PROFILE: the CPU profile by its short name, as its CPU model; v2, the default, has FEAT_PAN)
    ...(process.env.A64_PROFILE ? { cpu_profile: { "v1": "generic-arm64-v1", "v1.1": "generic-arm64-v1.1", "v2": "generic-arm64",
        "v3": "generic-arm64-compat32" }[process.env.A64_PROFILE] } : {}),
    ...(memory_mb > low_mb ? { extended_memory_size: (memory_mb - low_mb) * 1048576 } : {}),
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    ...(bootloader ? { android: { gpu_mode: gpu_level || "swiftshader",
        vendor_ramdisk: JSON.parse(fs.readFileSync(OUT + "manifest.json", "utf8")).vendor_ramdisk === "vendor_ramdisk-debug.img" ?
            { url: ROOT + "build/a64-android/dl/vendor_ramdisk-debug.img" } : undefined } } :
        { kernel: { url: OUT + "Image" }, initrd: { url: OUT + initrd }, cmdline: fs.readFileSync(OUT + "cmdline.txt", "utf8").trim() }),
    virtio_transport: "pci", virtio_disks: [{ url: OUT + "disk.img", async: true, size: fs.statSync(OUT + "disk.img").size }],
    graphics_adapter: "virtio_gpu", virtio_gpu_pci_slot: 2, screen_adapter: sink,
    ...(remote ? { graphics_adapter_test: { level: gpu_level, renderer: remote.renderer } } : {}),
    net_device: { type: "virtio", count: 3, relay_url: "fetch", id: 2 },
    virtio_console: true, virtio_console_ports: 18, virtio_rng: true, virtio_input: ["keyboard", "multitouch"], virtio_vsock: true,
    virtio_sound: true,
    // (A64_JIT_SWITCHES: more page tier switches, "name=value,...", e.g. a64_system=0)
    ...(jit ? { jit_switches: { a64_page: 1, ...Object.fromEntries((process.env.A64_JIT_SWITCHES || "").split(",").filter(Boolean)
        .map(p => [p.split("=")[0], +p.split("=")[1]])) } } : {}),
    ...(parallel ? { parallel: true, parallel_wasm_path: process.env.A64_PARALLEL_WASM || ROOT + "build/v86-arm64-parallel.wasm" } : {}),
    // (the bundle's own default is build/vcpu-worker.js of the working directory)
    ...(parallel && +process.env.TEST_RELEASE_BUILD ? { vcpu_worker_url: ROOT + "build/vcpu-worker.js" } : {}),
});
// (a machine that fails to start, e.g. a worker script not found, says so here only)
emulator.add_listener("emulator-error", error => { console.error("emulator-error:", error); process.exit(1); });
const loaded = new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
let sound_bytes = 0;
emulator.add_listener("virtio-snd-pcm", pcm => { sound_bytes += pcm["bytes"].length; if(sound_chunks) sound_chunks.push(Buffer.from(pcm["bytes"])); });
// A64_ANDROID_GFXSTREAM_TRACE=1 (with the sources): gfxstream's Vulkan
// commands (but a command buffer's vkCmd*), each process's, with their
// results and the stats' errors when they change, into gfxstream-trace.txt
if(process.env.A64_ANDROID_GFXSTREAM_TRACE)
{
    const trace = fs.openSync(directory + "gfxstream-trace.txt", "w"), started = Date.now();
    let lines = 0, last_error = "";
    const install = setInterval(() => {
        const gpu = emulator.v86?.cpu?.devices?.graphics_adapter?.device?.["virtio_gpu"];
        const vulkan = gpu && gpu.gfxstream && gpu.gfxstream.vulkan;
        if(!vulkan) return;
        clearInterval(install);
        const now = () => ((Date.now() - started) / 1000).toFixed(3);
        // (the imports of gralloc's resources, what the GPU wrote, the transfers: G3's color buffers)
        const model = gpu.gfxstream.vk;
        let imports = 0;
        const wrote = gpu.virgl.wrote.bind(gpu.virgl), from_host = gpu.virgl.transfer_from_host.bind(gpu.virgl);
        gpu.virgl.wrote = resource => { if(lines < 200000) fs.writeSync(trace, `${now()} wrote resource ${resource.id}\n`); return wrote(resource); };
        gpu.virgl.transfer_from_host = (resource, ...rest) => {
            fs.writeSync(trace, `${now()} TRANSFER_FROM_HOST resource ${resource.id} ${resource.width}x${resource.height} format ${resource.format}\n`);
            return from_host(resource, ...rest);
        };
        vulkan.on_command = (name, a) => {
            if(model.imports.size !== imports)
            {
                imports = model.imports.size;
                fs.writeSync(trace, `${now()} imports ${JSON.stringify([...model.imports.values()].map(([rid, resource]) => rid + ":" + resource))}\n`);
            }
            if(name.startsWith("vkCmd") || ++lines > 200000) return;
            const t = now();
            const ext = name === "vkCreateDevice" || name === "vkCreateInstance" ? " " + JSON.stringify(a.pCreateInfo.ppEnabledExtensionNames) : "";
            let detail = "";
            if(name === "vkAllocateMemory")
            {
                const chain = [];
                for(let c = a.pAllocateInfo.pNext; c; c = c.pNext) chain.push(c.sType + (c.resourceId !== undefined ? ":" + c.resourceId : ""));
                detail = ` type=${a.pAllocateInfo.memoryTypeIndex} size=${a.pAllocateInfo.allocationSize} chain=${chain.join(",")} memory=${a.pMemory}`;
            }
            else if(name === "vkBindImageMemory") detail = ` image=${a.image} memory=${a.memory}`;
            else if(name === "vkBindImageMemory2") detail = " " + JSON.stringify((a.pBindInfos || []).map(b => [b.image, b.memory]));
            fs.writeSync(trace, `${t} ${name}${a.ret !== undefined ? " ret=" + a.ret : ""}${ext}${detail}\n`);
            if(vulkan.stats.last_error !== last_error) { last_error = vulkan.stats.last_error; fs.writeSync(trace, `${t} ERROR ${last_error}\n`); }
        };
    }, 100);
    install.unref();
}
// A64_ANDROID_VENUS_TRACE=1 (with the sources, not the release build): the
// device's fence commands, with their answers and the fences' state, and its
// small readbacks (fence feedback slots), into venus-trace.txt
if(process.env.A64_ANDROID_VENUS_TRACE)
{
    const trace = fs.openSync(directory + "venus-trace.txt", "w"), started = Date.now();
    const line = text => fs.writeSync(trace, ((Date.now() - started) / 1000).toFixed(3) + " " + text + "\n");
    const FENCES = /Fence|QueueSubmit/;
    const install = setInterval(() => {
        const gpu = emulator.v86?.cpu?.devices?.graphics_adapter?.device?.["virtio_gpu"];
        const vk = gpu && gpu.venus && gpu.venus.vk;
        if(!vk) return;
        clearInterval(install);
        const handle = vk.handle.bind(vk);
        vk.handle = (ctx, name, a) => {
            const wait = handle(ctx, name, a);
            if(FENCES.test(name))
            {
                const ids = [a.fence, ...(a.pFences || [])].filter(id => id);
                const state = ids.map(id => { const f = ctx.objects.get(id); return id + (f ? (f.signaled ? ":S" : ":-") + f.pending : ":gone"); });
                line(name + " " + state.join(" ") + (wait ? " (waits)" : " ret=" + a.ret));
            }
            return wait;
        };
        vk.debug = text => {
            const m = /^readback memory \d+ \[(\d+),(\d+)\)/.exec(text);
            if(m && m[2] - m[1] <= 64 || /^readback skipped/.test(text)) line(text);
        };
    }, 1000);
}
// A64_ANDROID_GPU_DEBUG=1 (with the sources, not the release build: the
// device's names): virtio-gpu's control queue and Venus's queues every 30 s
if(process.env.A64_ANDROID_GPU_DEBUG)
{
    let debug_lines = 0;
    setInterval(() => {
        const gpu = emulator.v86?.cpu?.devices?.graphics_adapter?.device?.["virtio_gpu"];
        if(!gpu) return;
        // (and the display every 5 minutes: what reached it)
        if(++debug_lines % 10 === 0) try { screenshot("gpu-debug-" + debug_lines / 10); } catch(e) { console.log("gpu-debug: no screenshot: " + e.message); }
        if(gpu.gfxstream)
        {
            // gfxstream: each context's rings (W waiting, B after another ring's command, - idle), Vulkan's stats
            const g = gpu.gfxstream, v = g.vulkan;
            // (the commands that did not decode: their payloads into the run's directory)
            for(const [i, u] of (v ? v.stats.undecoded : []).entries())
            {
                const file = `${directory}gfxstream-undecoded-${i}-${u.name}.bin`;
                if(!fs.existsSync(file)) fs.writeFileSync(file, u.payload);
            }
            console.log(`gpu-debug: held=${gpu.held} pending=${gpu.pending.length} gfxstream pings=${g.stats.pings} commands=${g.stats.commands}` +
                ` errors=${g.stats.errors}${g.stats.last_error ? " last=" + JSON.stringify(g.stats.last_error) : ""}` +
                ` contexts=${[...g.contexts.values()].map(c => c.capset + ":" + [...c.rings.values()].map(r => r.waiting ? "W" : r.blocked ? "B" : "-").join("")).join(" ")}` +
                (v ? ` vulkan commands=${v.stats.commands} flushed=${v.stats.flushed} errors=${v.stats.errors}` +
                    `${v.stats.last_error ? " last=" + JSON.stringify(v.stats.last_error) : ""} unknown=${JSON.stringify(v.stats.unknown)}` +
                    ` unimplemented=${JSON.stringify(v.stats.unimplemented)} failures=${JSON.stringify(v.stats.failures)}` +
                    ` queues=${[...g.vk.queues].map(q => q.pending.length + "p/" + q.inflight + "i").join(",")} waiters=${g.vk.waiters.length}` : "") +
                ` unknown=${JSON.stringify(g.stats.unknown)} syncs=${JSON.stringify(g.stats.syncs)}` +
                ` execbuffer=${JSON.stringify(g.stats.execbuffer)} fences=${JSON.stringify(gpu.stats.fences)}` +
                // (the host visible memory the guest has mapped: its rings and memory, MiB, of the whole)
                ` hostmem=${([...gpu.mapped.values()].reduce((sum, r) => sum + r.blob_size, 0) / 1048576).toFixed(1)}` +
                `/${gpu.hostmem_size >> 20} in ${gpu.mapped.size}` +
                // (the control queue's commands by type, flushes: KMS's scanouts)
                ` control=${JSON.stringify(gpu.stats.commands)} flushes=${gpu.stats.flushes} gpu-errors=${gpu.stats.errors}/${gpu.stats.last_error.toString(16)}` +
                (gpu.stats.failed_command ? ` failed=${JSON.stringify(gpu.stats.failed_command.slice(0, 300))}` : ""));
            return;
        }
        const first = gpu.pending.find(entry => !entry.ready);
        const vk = gpu.venus && gpu.venus.vk;
        console.log(`gpu-debug: held=${gpu.held} pending=${gpu.pending.length} first-waiting=${first ? "0x" + new DataView(first.bytes.buffer, first.bytes.byteOffset).getUint32(0, true).toString(16) : "-"}` +
            (vk ? ` venus queues=${[...vk.queues].map(q => q.pending.length + "p/" + q.inflight + "i/ring" + q.ring_idx).join(",")} waiters=${vk.waiters.length}` +
                ` submissions=${vk.stats.submissions} batches=${vk.stats.batches}` : "") +
            (gpu.venus ? ` errors=${gpu.venus.stats.errors}${gpu.venus.stats.last_error ? " last=" + JSON.stringify(gpu.venus.stats.last_error) : ""}` +
                // (the commands that answered an error, with the last one's VkResult)
                ` failures=${JSON.stringify(gpu.venus.stats.failures)}` +
                // (each context's rings: - idle, R running, W:<command> waiting in it, F fatal)
                ` rings=${[...gpu.venus.contexts.values()].map(c => [...c.rings.values()].map(r => r.fatal ? "F" : !r.run ? "-" :
                    r.run.waiting ? "W:" + r.run.waiting_on.replace(/^vk/, "") : "R").join("")).filter(r => /[RWF]/.test(r)).join(" ")}` : ""));
        // (=2: every ring: context, id, its blob's mapping, head, the tail and status in its memory)
        if(process.env.A64_ANDROID_GPU_DEBUG === "2" && gpu.venus)
        {
            const bytes = gpu.venus.bytes(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for(const c of gpu.venus.contexts.values())
            {
                for(const r of c.rings.values())
                {
                    const mapped = r.blob.map_offset >= 0;
                    console.log(`gpu-ring: ctx=${c.id} ring=${r.id} blob=${r.blob.id} map=${r.blob.map_offset} head=${r.head}` +
                        (mapped ? ` tail=${view.getUint32(r.blob.map_offset + r.tail_offset, true)} mem-head=${view.getUint32(r.blob.map_offset + r.head_offset, true)}` +
                            ` status=${view.getUint32(r.blob.map_offset + r.status_offset, true)}` : "") +
                        ` fatal=${r.fatal} run=${r.run ? (r.run.waiting ? "W:" + r.run.waiting_on : "R") : "-"}`);
                }
            }
        }
    }, 30000).unref();
}
// (Cuttlefish's phone display: 720x1280, lcd_density 320)
emulator.add_listener("emulator-ready", () => emulator.set_display_size(720, 1280));
// (Node has no animation frames: the display draws into the sink when asked, as tests/x64/linux_gpu.mjs's)
const screenshot = name => { emulator.v86?.cpu?.devices?.display?.request_frame(true); return save_png(sink, directory, name); };
const kernel_watch = watch("kernel", "kernel.log"), logcat_watch = watch("logcat", "logcat.log");
const serial_out = fs.openSync(directory + "console.log", "w");
emulator.add_listener("serial0-output-byte", byte => { fs.writeSync(serial_out, Buffer.from([byte])); });
emulator.add_listener("virtio-console0-output-bytes", kernel_watch);
emulator.add_listener("virtio-console2-output-bytes", logcat_watch);
// (the DHCP messages between the guest and the fetch adapter on the third
// NIC, net2: dhcp.log, for A9's network step)
const dhcp_log = fs.openSync(directory + "dhcp.log", "w");
const DHCP_TYPES = ["", "DISCOVER", "OFFER", "REQUEST", "DECLINE", "ACK", "NAK", "RELEASE", "INFORM"];
const log_dhcp = direction => frame => {
    if(frame.length < 14 + 20 + 8 + 240 || frame[12] !== 0x08 || frame[13] !== 0x00 || frame[14 + 9] !== 17) return;
    const udp = 14 + (frame[14] & 15) * 4;
    const ports = [frame[udp] << 8 | frame[udp + 1], frame[udp + 2] << 8 | frame[udp + 3]];
    if(!ports.includes(67)) return;
    const dhcp = udp + 8;
    let type = 0;
    for(let i = dhcp + 240; i < frame.length && frame[i] !== 255; i += frame[i] === 0 ? 1 : 2 + frame[i + 1])
    {
        if(frame[i] === 53) type = frame[i + 2];
    }
    const xid = (frame[dhcp + 4] << 24 | frame[dhcp + 5] << 16 | frame[dhcp + 6] << 8 | frame[dhcp + 7]) >>> 0;
    fs.writeSync(dhcp_log, `${(elapsed() / 1000).toFixed(1)} s ${direction} ${DHCP_TYPES[type] || type} xid=${xid.toString(16)}\n`);
};
emulator.add_listener("net2-send", log_dhcp("guest->host"));
{
    // (the fetch adapter sends its frames from this end of the bus, where
    // listeners do not see them)
    const send = emulator.bus.send.bind(emulator.bus), to_guest = log_dhcp("host->guest");
    emulator.bus.send = (name, value, ...rest) => { if(name === "net2-receive") to_guest(value); return send(name, value, ...rest); };
}
const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error(`deadline (${timeout} ms)`)), timeout));
deadline.catch(() => {});
const progress = setInterval(() => {
    console.log(`${(elapsed() / 1000).toFixed(0)} s: ${Object.keys(marks).join(", ") || "booting"}`);
}, 60000);
const vsock = async () => {
    const s = await emulator.vsock_connect(5555);
    return { adapter: { write: bytes => s.write(Uint8Array.from(bytes)), set on_data(fn) { s.on_data = bytes => fn(Buffer.from(bytes)); } },
        close: () => s.close() };
};
const adb = adb_over(vsock);
const with_deadline = p => Promise.race([p, failed, deadline]);

try
{
    if(restore_state_file)
    {
        await loaded;
        const file = await fs.promises.open(restore_state_file, "r");
        const size = (await file.stat()).size;
        await emulator.restore_state_stream({ size, read: async (offset, length) => {
            const data = new Uint8Array(length);
            const read = (await file.read(data, 0, length, offset))["bytesRead"];
            return read === length ? data : data.subarray(0, read);
        } });
        await file.close();
        for(const name of ["restored", "system_server", "adbd", "boot_completed"]) mark(name);
        console.log(`restored ${restore_state_file} (${(size / 1048576).toFixed(0)} MiB)`);
        emulator.run();
    }
    // system_server, then adbd's answer (retried: adbd starts before its vsock listener is ready)
    await with_deadline(new Promise(resolve => { const t = setInterval(() => { if(marks.system_server !== undefined && marks.adbd !== undefined) { clearInterval(t); resolve(); } }, 1000); }));
    const banner = await with_deadline(adb.banner());
    const answer = await with_deadline(adb.shell("echo B=$(getprop sys.boot_completed) P=$(pidof system_server) F=$(getprop ro.build.fingerprint) S=$(getconf PAGE_SIZE) K=$(uname -r)"));
    mark("adb");
    console.log("adb banner: " + banner.slice(0, 120));
    console.log("adb: " + JSON.stringify(answer));
    const fields = /B=(\S*) P=(\d*) F=(\S*)/.exec(answer);
    assert.ok(fields && fields[2], "system_server's pid over adb: " + JSON.stringify(answer));
    assert.ok(/:16\/BP4A\.251205\.006\//.test(fields[3]), "the build's fingerprint over adb");
    const result = { tag, marks, system_server_pid: +fields[2], fingerprint: fields[3], ...check_page_size(answer) };
    // (the scenario's device settings, from now on: see prepare_device)
    const prepared = scenario ? prepare_device(adb.shell).then(() => mark("device_prepared")) : null;
    prepared?.catch(() => {});
    if(wait_for_boot_completed)
    {
        while((await with_deadline(adb.shell("getprop sys.boot_completed"))).trim() !== "1") await sleep(30000);
        mark("boot_completed_adb");
        screenshot("boot-completed");
    }
    if(save_state_file)
    {
        await emulator.stop();
        const file = await fs.promises.open(save_state_file, "w");
        let bytes = 0;
        await emulator.save_state_stream(async chunk => { await file.write(chunk, 0, chunk.length, bytes); bytes += chunk.length; });
        await file.close();
        mark("state_saved");
        console.log(`saved ${save_state_file} (${(bytes / 1048576).toFixed(0)} MiB)`);
        emulator.run();
    }
    // (A10 runs the probes after its snapshot instead: debugging what follows a restore)
    if(scenario !== "a10") await with_deadline(run_probes(adb.shell, adb.push, async name => screenshot(name)));
    if(scenario)
    {
        await with_deadline(prepared);
        // (a tap held 100 ms: a busy guest that reads the release late would otherwise
        // see more than the long press timeout, 400 ms, and Launcher3 opens the icon's menu)
        const touch = async (x, y) => {
            emulator.bus.send("touch", { "touches": [[1, x, y]], "width": 720, "height": 1280 });
            await sleep(100);
            emulator.bus.send("touch", { "touches": [], "width": 720, "height": 1280 });
        };
        // (A10's input latency: from the touch to the first change of the screen's middle rows)
        const digest = () => {
            emulator.v86?.cpu?.devices?.display?.request_frame(true);
            const row = sink.width * 4;
            return create_hash("sha1").update(sink.rgba.subarray(LATENCY_ROWS[0] * row, LATENCY_ROWS[1] * row)).digest("hex");
        };
        const tap_latency = async (x, y) => {
            const before = digest();
            const started = performance.now();
            await touch(x, y);
            while(performance.now() - started < 60000)
            {
                if(digest() !== before) return Math.round(performance.now() - started);
                await sleep(20);
            }
            return null;
        };
        // (after "reboot" adbd goes away, the machine resets and boots again: wait for adb, up to 2 hours)
        const wait_reboot = async () => { await sleep(60000); await adb_over(vsock, 7200000).shell("echo up"); };
        // (A10: the desktop saved to A64_ANDROID_A10_SAVE, which a second run
        // restores into a new machine; A64_ANDROID_SNAPSHOT=inprocess: saved
        // and restored into this one, debugging: see docs/aarch64.md's known
        // defects; =pause: only stopped for 20 s)
        const a10_save = process.env.A64_ANDROID_A10_SAVE || "";
        const snapshot = async () => {
            const name = a10_save || directory + "snapshot.v7";
            await emulator.stop();
            if(a10_save)
            {
                const started = performance.now();
                let bytes = 0;
                const out = await fs.promises.open(name, "w");
                await emulator.save_state_stream(async chunk => { await out.write(chunk, 0, chunk.length, bytes); bytes += chunk.length; });
                await out.close();
                emulator.run();
                return { saved: name, mib: Math.round(bytes / 1048576), save_ms: Math.round(performance.now() - started) };
            }
            // (A64_ANDROID_SNAPSHOT=pause: the machine only stopped for 20 s, debugging)
            if(process.env.A64_ANDROID_SNAPSHOT === "pause")
            {
                await sleep(20000);
                emulator.run();
                await adb_over(vsock, 600000).shell("echo up");
                return { paused_ms: 20000 };
            }
            let started = performance.now(), bytes = 0;
            const out = await fs.promises.open(name, "w");
            await emulator.save_state_stream(async chunk => { await out.write(chunk, 0, chunk.length, bytes); bytes += chunk.length; });
            await out.close();
            const save_ms = Math.round(performance.now() - started);
            started = performance.now();
            const file = await fs.promises.open(name, "r");
            await emulator.restore_state_stream({ size: bytes, read: async (offset, length) => {
                const data = new Uint8Array(length);
                const read = (await file.read(data, 0, length, offset))["bytesRead"];
                return read === length ? data : data.subarray(0, read);
            } });
            await file.close();
            const restore_ms = Math.round(performance.now() - started);
            emulator.run();
            if(!process.env.A64_ANDROID_KEEP_SNAPSHOT) fs.rmSync(name, { force: true });
            await adb_over(vsock, 600000).shell("echo up");
            return { mib: Math.round(bytes / 1048576), save_ms, restore_ms };
        };
        await with_deadline(run_scenario({ target, directory, adb: adb.shell, push: adb.push, reboot: adb.reboot,
            screenshot: async name => screenshot(name),
            touch, tap_latency, http: { port: http_port, token: http_token }, wait_reboot, monkey_minutes, steps: a10_steps,
            snapshot: scenario === "a10" && (a10_save && !restore_state_file || process.env.A64_ANDROID_SNAPSHOT) ? snapshot : null,
            restored: restore_state_file || null,
            sound,
            probe: probe_file ? () => run_probes(adb.shell, adb.push, async name => screenshot(name)) : null }, result));
    }
    clearInterval(progress);
    result.ms = elapsed();
    if(remote) result.renderer = remote.stats;
    // (P12.3's metrics: the instructions each core retired, MIPS over the
    // run, the page tier's counters (core 0's instance; the workers' compile
    // their own), the host process's peak resident memory)
    {
        const cpu = emulator.v86.cpu;
        const retired = Array.from({ length: cores }, (_, core) => cpu.retired_instructions(core));
        const total = retired.reduce((sum, n) => sum + n, 0);
        const t = jit ? cpu.page_tier_stats() : null;
        result.metrics = { retired, mips: Math.round(total / result.ms / 100) / 10,
            ...(t ? { compiles: t.compiled, compile_ms: Math.round(t.compile_ms), evictions: t.evictions, live_code_mib: Math.round(t.live_code_bytes / 1048576) } : {}),
            // (core 0's page tier counters in full: its instance's)
            ...(t ? { page_tier: t, retired_core0: cpu.retired_instructions(0) } : {}),
            // (the workers' counters: slices, waits, device accesses served by the machine's thread)
            ...(cpu.parallel ? { parallel: cpu.parallel.status() } : {}),
            // (the instructions the page tier steps, and those of them that end its activations)
            ...(t && cpu.step_stats ? { steps: cpu.step_stats(25) } : {}),
            max_rss_mib: Math.round(process.resourceUsage().maxRSS / 1024),
            // (what the sound card played over the run: the audio HAL's output)
            sound_mib: Math.round(sound_bytes / 1048576 * 10) / 10 };
    }
    fs.writeFileSync(directory + "result.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
    console.log(`A64_ANDROID_BOOT_OK ${tag}`);
    await emulator.destroy();
    remote?.close();
    process.exit(0);
}
catch(e)
{
    clearInterval(progress);
    screenshot("failure");
    console.error(e);
    console.error("marks: " + JSON.stringify(marks));
    remote?.close();
    process.exit(1);
}
