#!/usr/bin/env node
// Debugging docs/aarch64.md's known defect "Android after a restore:
// Launcher3's RenderThread waits for good for ANGLE's post-link tasks":
// Android on v86 (Venus, 4 cores in workers, the page tier) restored from
// A64_STALL_STATE (build/a64-android/android-venus-booted.v7), Launcher3's
// first frames, then A64_STALL_SNAPSHOTS saves and restores into the same
// machine A64_STALL_DELAY_MS after them (while its first programs link);
// after each, a swipe and Launcher3's frames, and if its RenderThread waits
// in ANGLE: every thread's futex and the memory around it.
//
// While a snapshot is saved: which pages of guest RAM and device memory
// changed between the state's capture (get_state) and the end of the
// stream, the renderer's messages and the workers' I/O meanwhile.
//
//   node tests/a64/android_restore_stall.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdbClient } from "./adb.mjs";
import { prepare_device } from "./android_scenario.mjs";
import { PictureSink, save_png } from "../lib/picture_sink.mjs";
import { create_remote_renderer } from "../x64/gpu_remote_renderer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const OUT = ROOT + "build/a64-android/out/";
const state_file = process.env.A64_STALL_STATE || ROOT + "build/a64-android/android-venus-booted.v7";
const rounds = +(process.env.A64_STALL_SNAPSHOTS || 1);
const delay = +(process.env.A64_STALL_DELAY_MS ?? 10000);
const directory = ROOT + "build/a64-android/runs/restore-stall/";
fs.mkdirSync(directory, { recursive: true });
const started = performance.now();
const elapsed = () => ((performance.now() - started) / 1000).toFixed(0) + " s";
const log = text => console.log(`${elapsed()}: ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const remote = await create_remote_renderer();
// (the renderer's messages to the device while a snapshot is saved)
let saving = false;
const during_save = { messages: {} };
{
    const listen = remote.renderer["listen"];
    remote.renderer["listen"] = handler => listen(message => {
        if(saving) during_save.messages[message["type"]] = (during_save.messages[message["type"]] || 0) + 1;
        handler(message);
    });
}
const sink = new PictureSink();
const emulator = new V86({
    cpu_type: "arm64", cpu_cores: 4, memory_size: 1536 << 20, log_level: 0, autostart: false,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: OUT + "Image" }, initrd: { url: OUT + "initrd-venus.img" },
    cmdline: fs.readFileSync(OUT + "cmdline.txt", "utf8").trim(),
    virtio_transport: "pci", virtio_disks: [{ url: OUT + "disk.img", async: true, size: fs.statSync(OUT + "disk.img").size }],
    graphics_adapter: "virtio_gpu", virtio_gpu_pci_slot: 2, screen_adapter: sink,
    graphics_adapter_test: { level: "venus", renderer: remote.renderer },
    net_device: { type: "virtio", count: 3, relay_url: "fetch", id: 2 },
    virtio_console: true, virtio_console_ports: 18, virtio_rng: true, virtio_input: ["keyboard", "multitouch"], virtio_vsock: true,
    // (as android_boot.mjs's machine since P12.5: states saved since have the sound card)
    virtio_sound: true,
    jit_switches: { a64_page: 1 },
    parallel: true, parallel_wasm_path: process.env.A64_PARALLEL_WASM || ROOT + "build/v86-arm64-parallel.wasm",
    // (the bundle's own default is build/vcpu-worker.js of the working directory)
    ...(+process.env.TEST_RELEASE_BUILD ? { vcpu_worker_url: ROOT + "build/vcpu-worker.js" } : {}),
});
emulator.add_listener("emulator-error", error => { console.error("emulator-error:", error); process.exit(1); });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
emulator.add_listener("emulator-ready", () => emulator.set_display_size(720, 1280));
const logcat = fs.openSync(directory + "logcat.log", "w"), kernel = fs.openSync(directory + "kernel.log", "w");
emulator.add_listener("virtio-console2-output-bytes", bytes => fs.writeSync(logcat, bytes));
emulator.add_listener("virtio-console0-output-bytes", bytes => fs.writeSync(kernel, bytes));
const screenshot = name => { emulator.v86?.cpu?.devices?.display?.request_frame(true); return save_png(sink, directory, name); };

async function restore_from(file_name, size)
{
    const file = await fs.promises.open(file_name, "r");
    await emulator.restore_state_stream({ size, read: async (offset, length) => {
        const data = new Uint8Array(length);
        const read = (await file.read(data, 0, length, offset))["bytesRead"];
        return read === length ? data : data.subarray(0, read);
    } });
    await file.close();
}
await restore_from(state_file, fs.statSync(state_file).size);
// (Venus's rings: a vkCreateRingMESA whose ring id is a ring's already, as
// the host's map key, is a collision: the new ring takes the old one's place)
const ring_events = { created: 0, destroyed: 0, collisions: [] };
{
    // (the ids are exact since the fix, 16 hex digits; before it they were
    // numbers: two rings whose numbers are equal shared one id)
    // ("~<number>": a ring of a snapshot saved before the fix)
    const rounded = id => typeof id === "number" ? id : id.startsWith("~") ? Number(id.slice(1)) : Number(BigInt("0x" + id));
    const venus = emulator.v86.cpu.devices.graphics_adapter.device["virtio_gpu"].venus;
    venus.on_command = (name, args) => {
        if(name === "vkDestroyRingMESA") ring_events.destroyed++;
        if(name !== "vkCreateRingMESA") return;
        ring_events.created++;
        for(const ctx of venus.contexts.values())
        {
            for(const id of ctx.rings.keys())
            {
                if(id === args.ring || rounded(id) === rounded(args.ring))
                {
                    const text = `context ${ctx.id}: ring ${args.ring} and ring ${id}`;
                    ring_events.collisions.push(text);
                    log("COLLISION (as numbers): " + text);
                }
            }
        }
    };
}
emulator.run();
log("restored " + state_file);

// adb over vsock (tests/a64/android_boot.mjs's adb_over)
async function shell(command, ms = 300000)
{
    const deadline = Date.now() + 600000;
    for(;;)
    {
        let s;
        try
        {
            s = await emulator.vsock_connect(5555);
            const client = new AdbClient({ write: bytes => s.write(Uint8Array.from(bytes)), set on_data(fn) { s.on_data = bytes => fn(Buffer.from(bytes)); } });
            await client.connect(60000);
            return await client.shell(command, ms);
        }
        catch(e)
        {
            if(Date.now() > deadline) throw e;
            await sleep(5000);
        }
        finally { s?.close(); }
    }
}
const poll = async (command, test, what, ms = 1800000, every = 15000) => {
    const deadline = Date.now() + ms;
    for(let output; ; await sleep(every))
    {
        output = await shell(command);
        if(test(output)) return output;
        assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(output.slice(-300))}`);
    }
};
const frames = async () => +((await shell("dumpsys -t 300 gfxinfo com.android.launcher3 2>&1 | grep 'Total frames rendered'")).match(/(\d+)/)?.[1] ?? -1);
const top_resumed = "dumpsys -t 300 activity activities 2>&1 | grep -m1 -E 'topResumedActivity|TIMEOUT'";

await prepare_device(shell);
log("device prepared");
await poll("am get-started-user-state 0 2>&1", o => /RUNNING_UNLOCKED/.test(o), "user 0 unlocked", 3600000);
await shell("settings put global captive_portal_mode 0; settings put global stay_on_while_plugged_in 7; settings put system screen_off_timeout 2147483647");
log("user 0 unlocked");
await poll("input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; " + top_resumed, o => /com\.android\.launcher3\//.test(o), "Launcher3 resumed");
log("Launcher3 resumed");
try
{
    await poll("dumpsys -t 300 gfxinfo com.android.launcher3 2>&1 | grep 'Total frames rendered'", o => /Total frames rendered: [1-9]/.test(o), "first frames",
        +(process.env.A64_STALL_FIRST_FRAMES_MS || 1800000));
}
catch(e)
{
    // (no frames before any snapshot of this run: the restore of A64_STALL_STATE itself)
    log("no first frames: " + e.message);
    await diagnose("before");
    process.exit(2);
}
log("Launcher3's first frames: " + await frames());

// ---- the snapshot, instrumented
const cpu = emulator.v86.cpu;
const page_hashes = (bytes, pages) => {
    const words = new Int32Array(bytes.buffer, bytes.byteOffset, pages * 1024);
    const hashes = new Int32Array(pages);
    for(let page = 0, at = 0; page < pages; page++)
    {
        let h = 0;
        for(const end = at + 1024; at < end; at++) h = Math.imul(h, 31) + words[at] | 0;
        hashes[page] = h;
    }
    return hashes;
};
const ram = () => cpu.mem8.subarray(0, cpu.memory_size[0]);
const device_memory = () => cpu.device_memory ? new Uint8Array(cpu.wasm_memory.buffer, cpu.mem8.byteOffset + cpu.device_memory.start,
    cpu.device_memory.end - cpu.device_memory.start) : null;
let captured = null;
{
    const get_state = cpu.get_state;
    cpu.get_state = function(...args)
    {
        if(saving)
        {
            const t = performance.now();
            const dm = device_memory();
            captured = { ram: page_hashes(ram(), cpu.memory_size[0] / 4096), device: dm && page_hashes(dm, dm.length >> 12),
                served: cpu.parallel.served, ms: 0, rings: venus_rings(), pending: gpu()?.pending.length, held: gpu()?.held };
            captured.ms = Math.round(performance.now() - t);
        }
        return get_state.apply(this, args);
    };
}
const gpu = () => cpu.devices.graphics_adapter?.device?.["virtio_gpu"];
/** Venus's rings and submissions as the save sees them: R running, W:<command> waiting, - idle, F fatal; head/tail */
const venus_rings = () => {
    const g = gpu();
    if(!g?.venus) return null;
    const bytes = g.hostmem_bytes(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [...g.venus.contexts.values()].map(c => ({ ctx: c.id, submissions: c.submissions.length, seqno_waits: c.seqno_waits.length,
        rings: [...c.rings.values()].map(r => (r.fatal ? "F" : !r.run ? "-" : r.run.waiting ? "W:" + r.run.waiting_on.replace(/^vk/, "") : "R") +
            ` ${r.head}/${r.blob.map_offset >= 0 ? view.getUint32(r.blob.map_offset + r.tail_offset, true) : "unmapped"}`) }))
        .filter(c => c.submissions || c.seqno_waits || c.rings.some(r => !r.startsWith("-") || !/ (\d+)\/\1$/.test(r)));
};
async function snapshot(round)
{
    const name = directory + "snapshot.v7";
    await emulator.stop();
    during_save.messages = {};
    const g = gpu();
    const before = { pending: g?.pending.length, held: g?.held, rings: venus_rings(), venus_queues: g?.venus ? [...g.venus.vk.queues].map(q => q.pending.length + "p/" + q.inflight + "i") : null };
    saving = true;
    let bytes = 0;
    const out = await fs.promises.open(name, "w");
    const t0 = performance.now();
    await emulator.save_state_stream(async chunk => { await out.write(chunk, 0, chunk.length, bytes); bytes += chunk.length; });
    await out.close();
    saving = false;
    const save_ms = Math.round(performance.now() - t0);
    // (what changed after the state was captured, with every core parked)
    const changed = { ram: [], device: [] };
    const now_ram = page_hashes(ram(), cpu.memory_size[0] / 4096);
    for(let p = 0; p < now_ram.length; p++) if(now_ram[p] !== captured.ram[p]) changed.ram.push("0x" + (0x40000000 + p * 4096).toString(16));
    const dm = device_memory();
    if(dm)
    {
        const now_device = page_hashes(dm, dm.length >> 12);
        for(let p = 0; p < now_device.length; p++) if(now_device[p] !== captured.device[p]) changed.device.push("+0x" + (p * 4096).toString(16));
    }
    const after = { pending: g?.pending.length, held: g?.held, rings: venus_rings(), venus_queues: g?.venus ? [...g.venus.vk.queues].map(q => q.pending.length + "p/" + q.inflight + "i") : null };
    log(`snapshot ${round}: ${Math.round(bytes / 1048576)} MiB in ${save_ms} ms; hashing ${captured.ms} ms; ` +
        `changed during the save: ${changed.ram.length} RAM pages ${JSON.stringify(changed.ram.slice(0, 16))}, ` +
        `${changed.device.length} device pages ${JSON.stringify(changed.device.slice(0, 16))}; renderer messages ${JSON.stringify(during_save.messages)}; ` +
        `worker I/O served ${cpu.parallel.served - captured.served}; at the capture ${JSON.stringify({ pending: captured.pending, held: captured.held, rings: captured.rings })}; gpu before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    if(!+process.env.A64_STALL_SAVE_ONLY)
    {
        // (the renderer's messages while the state is restored: they belong to the machine left behind)
        during_save.messages = {};
        saving = true;
        await restore_from(name, bytes);
        saving = false;
        log(`restored in place; renderer messages meanwhile ${JSON.stringify(during_save.messages)}; gpu pending ${g?.pending.length} held ${g?.held}`);
    }
    emulator.run();
    if(!process.env.A64_KEEP_SNAPSHOT) fs.rmSync(name, { force: true });
}

// ---- after it: does Launcher3 draw?
/**
 * Launcher3's threads (debuggerd -b: every futex wait is interrupted and
 * restarted, so a wait that goes on has an unchanged futex word), each
 * thread's state and syscall, and the memory around the futex words its
 * RenderThread, hwui and ANGLE threads wait on: files named after `tag`
 */
async function diagnose(tag)
{
    const pid = (await shell("pidof com.android.launcher3")).trim();
    const stacks = await shell(`su 0 debuggerd -b ${pid} 2>&1`, 300000);
    fs.writeFileSync(directory + `stacks-${tag}.txt`, stacks);
    const render = /"RenderThread"[\s\S]*?(?=\n"|\n----- end)/.exec(stacks)?.[0] || "";
    const stuck = /waitForPostLinkTasks|AsyncWaitableEvent::wait/.test(render);
    const threads = await shell(`su 0 sh -c 'for t in /proc/${pid}/task/*; do echo "$(basename $t) $(cat $t/comm | tr " " _) $(cut -d" " -f3 $t/stat) $(cat $t/wchan) $(cat $t/syscall)"; done'`);
    fs.writeFileSync(directory + `threads-${tag}.txt`, threads);
    const words = [];
    for(const line of threads.split("\n"))
    {
        const [tid, comm, state, wchan, number, a0, a1, a2] = line.trim().split(/\s+/);
        if(number !== "98" || !/RenderThread|ANGLE|hwui/.test(comm)) continue;
        const address = BigInt(a0);
        const from = address - 128n;
        const dump = await shell(`su 0 dd if=/proc/${pid}/mem bs=8 skip=${from / 8n} count=48 2>/dev/null | od -A x -t x8`);
        words.push(`${tid} ${comm} ${state} ${wchan} futex(0x${address.toString(16)}, op=${a1}, val=${a2}); from 0x${from.toString(16)}:\n${dump}`);
    }
    fs.writeFileSync(directory + `futexes-${tag}.txt`, words.join("\n"));
    // (SystemUI too; the threads of either inside the Venus driver)
    const systemui = await shell(`su 0 debuggerd -b $(pidof com.android.systemui) 2>&1`, 300000);
    fs.writeFileSync(directory + `stacks-systemui-${tag}.txt`, systemui);
    for(const [name, text] of [["launcher3", stacks], ["systemui", systemui]])
    {
        const inside = text.split(/\n(?=")/).filter(t => /vulkan\.virtio\.so/.test(t)).map(t => t.split("\n")[0] + " " + (/\((vn_\w+)\+/.exec(t)?.[1] || ""));
        if(inside.length) log(`${tag}: ${name}'s threads in the Venus driver: ${inside.join(", ")}`);
    }
    log(`${tag}: RenderThread ${stuck ? "WAITS IN ANGLE" : "not in ANGLE's wait"}; threads and futexes in ${directory}`);
    return stuck;
}

async function check(round)
{
    await sleep(30000);
    const f0 = await frames();
    // (the all-apps list, and back)
    await shell("input swipe 360 1100 360 300 300");
    await sleep(45000);
    await shell("input keyevent KEYCODE_BACK");
    await sleep(30000);
    const f1 = await frames();
    await screenshot(`after-${round}`);
    log(`round ${round}: frames ${f0} -> ${f1}`);
    if(f1 > f0) return false;
    await diagnose(`round-${round}`);
    return true;
}

let stalled = false;
for(let round = 1; round <= rounds && !stalled; round++)
{
    await sleep(delay);
    await snapshot(round);
    log("Launcher3 top: " + (await shell(top_resumed)).trim());
    stalled = await check(round);
}
log((stalled ? "STALLED" : "no stall") + "; rings " + JSON.stringify(ring_events));
await emulator.destroy();
remote.close();
process.exit(stalled ? 1 : 0);
