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
//   TEST_RELEASE_BUILD=1 (build/libv86.mjs)
// Logs: build/a64-android/runs/<tag>/ (kernel.log, logcat.log, console.log, *.png, result.json)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { android_qemu_args, AndroidConsole, qemu_screendump } from "./android_qemu.mjs";
import { qemu_binary } from "./guest_runner.mjs";
import { AdbClient } from "./adb.mjs";
import { a9_scenario, prepare_device } from "./android_scenario.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";
import { create_remote_renderer } from "../x64/gpu_remote_renderer.mjs";

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
const scenario = process.env.A64_ANDROID_SCENARIO || "";
assert.ok(!scenario || scenario === "a9", "A64_ANDROID_SCENARIO: a9");
assert.ok(!scenario || !plugins, "A64_ANDROID_SCENARIO and A64_QEMU_PLUGINS do not go together");
const wait_for_boot_completed = target === "qemu" || !!scenario || process.env.A64_ANDROID_WAIT === "boot_completed";
const tag = (target === "qemu" ? `qemu-${accel}${plugins ? "-plugins" : ""}` : `v86${jit ? "-jit" : ""}${parallel ? "-par" : ""}`) +
    `${process.env.A64_ANDROID_GPU ? "-" + process.env.A64_ANDROID_GPU : ""}${scenario ? "-" + scenario : ""}-${memory_mb}m-${cores}c`;
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
async function run_probes(shell, push, screenshot)
{
    if(!probe_file) return;
    for(const pair of (process.env.A64_ANDROID_PUSH || "").split(",").filter(Boolean))
    {
        const [local, remote] = pair.split("=");
        await push(remote, fs.readFileSync(local));
        console.log(`push: ${local} -> ${remote}`);
    }
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
        console.log(`probe: ${command}\n  ${Date.now() - start} ms, ${output.length} chars: ${JSON.stringify(output.slice(0, 4000))}`);
    }
}

async function run_scenario(env, result)
{
    console.log("scenario a9");
    const found = await a9_scenario({ ...env, log: text => console.log(`${(elapsed() / 1000).toFixed(0)} s: a9: ${text}`) });
    result.a9 = found;
    mark("a9_done");
}

if(target === "qemu")
{
    const qemu = qemu_binary();
    const socket = `/tmp/v86-a64-android-${process.pid}.sock`, monitor = `/tmp/v86-a64-android-${process.pid}-m.sock`;
    const adb_port = 15600 + process.pid % 1000;
    const args = android_qemu_args(OUT, { accel, memory_mb, cores, console_socket: socket,
        kernel_log: directory + "kernel.log", logcat: directory + "logcat.log",
        ...(scenario || probe_file ? { monitor_socket: monitor, adb_port } : {}) });
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
        const until_booted = async () =>
        {
            for(;;)
            {
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
        const result = { tag, fingerprint, marks };
        if(scenario || probe_file)
        {
            // (Wi-Fi first, from the console: adb reaches the guest through it)
            await terminal.run("su 0 cmd wifi set-wifi-enabled enabled; sleep 10; su 0 cmd wifi connect-network VirtWifi open", 120000);
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
                await run_scenario({ target, adb: adb.shell, push: adb.push, reboot: adb.reboot,
                    screenshot: name => qemu_screendump(monitor, directory, name), touch: null, http: null, wait_reboot: () => sleep(30000) }, result);
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
const gpu_level = process.env.A64_ANDROID_GPU || "";
assert.ok(!gpu_level || gpu_level === "venus", "A64_ANDROID_GPU: venus");
// (and tools/a64_android.mjs's initrd-venus.img: libvulkan's driver the odm's vulkan.virtio.so)
const initrd = gpu_level === "venus" ? "initrd-venus.img" : "initrd.img";
assert.ok(fs.existsSync(OUT + initrd), OUT + initrd + " is missing: make android-venus, then node tools/a64_android.mjs");
const remote = gpu_level ? await create_remote_renderer() : null;
// A64_ANDROID_SAVE_STATE=<file>: a V7 state saved after boot_completed;
// A64_ANDROID_RESTORE_STATE=<file>: such a state restored instead of booting
// (the same options otherwise), for quick rounds of probes
const save_state_file = process.env.A64_ANDROID_SAVE_STATE || "", restore_state_file = process.env.A64_ANDROID_RESTORE_STATE || "";
const emulator = new V86({
    cpu_type: "arm64", cpu_cores: cores, memory_size: low_mb * 1048576, log_level: 0, autostart: !restore_state_file,
    ...(memory_mb > low_mb ? { extended_memory_size: (memory_mb - low_mb) * 1048576 } : {}),
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: OUT + "Image" }, initrd: { url: OUT + initrd },
    cmdline: fs.readFileSync(OUT + "cmdline.txt", "utf8").trim(),
    virtio_transport: "pci", virtio_disks: [{ url: OUT + "disk.img", async: true, size: fs.statSync(OUT + "disk.img").size }],
    graphics_adapter: "virtio_gpu", virtio_gpu_pci_slot: 2, screen_adapter: sink,
    ...(remote ? { graphics_adapter_test: { level: gpu_level, renderer: remote.renderer } } : {}),
    net_device: { type: "virtio", count: 3, relay_url: "fetch", id: 2 },
    virtio_console: true, virtio_console_ports: 18, virtio_rng: true, virtio_input: ["keyboard", "multitouch"], virtio_vsock: true,
    ...(jit ? { jit_switches: { a64_page: 1 } } : {}),
    ...(parallel ? { parallel: true, parallel_wasm_path: process.env.A64_PARALLEL_WASM || ROOT + "build/v86-arm64-parallel.wasm" } : {}),
});
const loaded = new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
// A64_ANDROID_GPU_DEBUG=1 (with the sources, not the release build: the
// device's names): virtio-gpu's control queue and Venus's queues every 30 s
if(process.env.A64_ANDROID_GPU_DEBUG)
{
    setInterval(() => {
        const gpu = emulator.v86?.cpu?.devices?.graphics_adapter?.device?.["virtio_gpu"];
        if(!gpu) return;
        const first = gpu.pending.find(entry => !entry.ready);
        const vk = gpu.venus && gpu.venus.vk;
        console.log(`gpu-debug: held=${gpu.held} pending=${gpu.pending.length} first-waiting=${first ? "0x" + new DataView(first.bytes.buffer, first.bytes.byteOffset).getUint32(0, true).toString(16) : "-"}` +
            (vk ? ` venus queues=${[...vk.queues].map(q => q.pending.length + "p/" + q.inflight + "i/ring" + q.ring_idx).join(",")} waiters=${vk.waiters.length}` +
                ` submissions=${vk.stats.submissions} batches=${vk.stats.batches}` : "") +
            (gpu.venus ? ` errors=${gpu.venus.stats.errors}${gpu.venus.stats.last_error ? " last=" + JSON.stringify(gpu.venus.stats.last_error) : ""}` +
                // (each context's rings: - idle, R running, W:<command> waiting in it, F fatal)
                ` rings=${[...gpu.venus.contexts.values()].map(c => [...c.rings.values()].map(r => r.fatal ? "F" : !r.run ? "-" :
                    r.run.waiting ? "W:" + r.run.waiting_on.replace(/^vk/, "") : "R").join("")).filter(r => /[RWF]/.test(r)).join(" ")}` : ""));
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
    const answer = await with_deadline(adb.shell("echo B=$(getprop sys.boot_completed) P=$(pidof system_server) F=$(getprop ro.build.fingerprint)"));
    mark("adb");
    console.log("adb banner: " + banner.slice(0, 120));
    console.log("adb: " + JSON.stringify(answer));
    const fields = /B=(\S*) P=(\d*) F=(\S*)/.exec(answer);
    assert.ok(fields && fields[2], "system_server's pid over adb: " + JSON.stringify(answer));
    assert.ok(/:16\/BP4A\.251205\.006\//.test(fields[3]), "the build's fingerprint over adb");
    const result = { tag, marks, system_server_pid: +fields[2], fingerprint: fields[3] };
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
    await with_deadline(run_probes(adb.shell, adb.push, async name => screenshot(name)));
    if(scenario)
    {
        await with_deadline(prepared);
        const touch = async (x, y) => {
            emulator.bus.send("touch", { "touches": [[1, x, y]], "width": 720, "height": 1280 });
            await sleep(300);
            emulator.bus.send("touch", { "touches": [], "width": 720, "height": 1280 });
        };
        // (after "reboot" adbd goes away, the machine resets and boots again: wait for adb, up to 2 hours)
        const wait_reboot = async () => { await sleep(60000); await adb_over(vsock, 7200000).shell("echo up"); };
        await with_deadline(run_scenario({ target, adb: adb.shell, push: adb.push, reboot: adb.reboot,
            screenshot: async name => screenshot(name),
            touch, http: { port: http_port, token: http_token }, wait_reboot }, result));
    }
    clearInterval(progress);
    result.ms = elapsed();
    if(remote) result.renderer = remote.stats;
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
