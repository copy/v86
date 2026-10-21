import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire as create_require } from "node:module";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";
import { jit_stats_enabled, print_jit_stats } from "../../../tools/bench/jit_stats.mjs";
// The guest's v86gl driver finds its device; no renderer answers
const { createV86GLDevice: create_v86gl_device } = create_require(import.meta.url)("../../../src/browser/glbridge/v86gl_device.js");

// Headless CPU/disk diagnostic. Disk writes stay in AsyncXHRBuffer's RAM overlay.
// Run one process per core so 2 GiB guest memories do not overlap.
// node tests/ir/performance/xp_boot.mjs disk.img [core.wasm]
// XP_CPU_TYPE=x86_64: a CPU with NX, for which XP boots its PAE kernel (the
// result's cr4 shows PAE, bit 5).
const [disk, wasm = "build/v86.wasm", ...extra] = process.argv.slice(2);
assert(disk && !extra.length, "usage: xp_boot.mjs disk.img [core.wasm]");
const duration = Number(process.env.IR_BOOT_MS || 30000);
assert(Number.isFinite(duration) && duration >= 1000);
const target = process.env.IR_BOOT_TARGET || "time";
assert(["time", "desktop"].includes(target));
// IR_SYNC_DISK=1: reads complete synchronously from the image and writes stay
// in a RAM sector overlay. This removes host I/O latency from the boot, so the
// milestone time measures emulated CPU work (a benchmarking aid, not the
// default acceptance configuration).
class SyncDisk {
    constructor(path) {
        this.fd = fs.openSync(path, "r");
        this.byteLength = fs.fstatSync(this.fd).size;
        this.overlay = new Map();
    }
    load() { this.onload && this.onload({}); }
    get(start, len, fn) {
        const out = new Uint8Array(len);
        fs.readSync(this.fd, out, 0, len, start);
        for(let sector = Math.floor(start / 512); sector * 512 < start + len; sector++) {
            const data = this.overlay.get(sector);
            if(!data) continue;
            const from = Math.max(start, sector * 512), to = Math.min(start + len, sector * 512 + 512);
            out.set(data.subarray(from - sector * 512, to - sector * 512), from - start);
        }
        fn(out);
    }
    get_and_cache(start, len, fn) { this.get(start, len, fn); }
    get_from_cache() { return undefined; }
    set(start, slice, fn) {
        for(let at = 0; at < slice.length;) {
            const offset = start + at, sector = Math.floor(offset / 512), within = offset - sector * 512;
            let data = this.overlay.get(sector);
            if(!data) { data = new Uint8Array(512); this.get(sector * 512, 512, b => data.set(b)); this.overlay.set(sector, data); }
            const n = Math.min(512 - within, slice.length - at);
            data.set(slice.subarray(at, at + n), within);
            at += n;
        }
        fn && fn();
    }
    get_buffer(fn) { fn(); }
    get_state() { return []; }
    set_state() {}
}
let milestone = null;
let phase = "bios";
const vm = new V86({
    graphics_adapter: "bochs_vga",
    wasm_path: wasm,
    ...(process.env.IR_SYNC_PUB !== undefined ? {ir_sync_publication: process.env.IR_SYNC_PUB === "1"} : {}),
    memory_size: 2048 * 1024 * 1024, vram_size: 16 * 1024 * 1024,
    ...(process.env.XP_CPU_TYPE ? { cpu_type: process.env.XP_CPU_TYPE } : {}),
    bios: { url: "bios/seabios.bin" }, vga_bios: { url: "bios/vgabios.bin" },
    hda: process.env.IR_SYNC_DISK === "1" ? new SyncDisk(disk) : { url: disk, size: fs.statSync(disk).size, async: true },
    x87_fast_math: true, x87_jit_cache: true,
    virtio_devices: [create_v86gl_device({ remote: false, post() {}, listen() {} })],
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "ne2k" }, autostart: false,
    // (JIT_SWITCHES, tests/lib/jit_switches.mjs)
    ...Object.keys(jit_switches_from_env()).length ? { jit_switches: jit_switches_from_env() } : {},
});
let started, previous, count, total = 0;
vm.add_listener("screen-set-size", size => {
    const ms = started ? performance.now() - started : 0;
    phase = size.join("x");
    console.log(JSON.stringify({ event: "screen", ms, size }));
    // This is a reproducible display-mode milestone, not proof of desktop idle.
    if(started && !milestone && size[0] === 800 && size[1] === 600 && size[2] === 32) {
        milestone = {ms, instructions: total + (((vm.get_instruction_counter() >>> 0) - count) >>> 0)};
        console.log(JSON.stringify({event:"milestone", name:"800x600x32", ...milestone}));
    }
});
try {
    await new Promise((resolve, reject) => {
        vm.add_listener("emulator-loaded", resolve);
        vm.add_listener("emulator-error", reject);
    });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    started = previous = performance.now();
    count = vm.get_instruction_counter() >>> 0;
    vm.run();
    while(performance.now() - started < duration && !(target === "desktop" && milestone)) {
        await new Promise(resolve => setTimeout(resolve, target === "desktop" ? 250 : 5000));
        const now = performance.now(), next = vm.get_instruction_counter() >>> 0;
        const steps = (next - count) >>> 0;
        total += steps;
        console.log(JSON.stringify({ wasm, ms: now - started,
            phase, instructions: total,
            requested_ms: duration, overrun_ms: Math.max(0, now - started - duration),
            mips: steps / (now - previous) / 1000, avg_mips: total / (now - started) / 1000,
            jit: vm.get_jit_info(),
        }));
        previous = now; count = next;
    }
    await vm.stop();
    total+=((vm.get_instruction_counter()>>>0)-count)>>>0;
    console.log(JSON.stringify({event:"page_tier", compiles:e.x64_page_stat(0), legacy_compiles:e.x64_page_stat(37), native:e.x64_page_stat(1),
        steps:e.x64_page_stat(4), retries:e.x64_page_stat(2), activations:e.x64_page_stat(13), pages:e.x64_page_stat(21), bytes:e.x64_page_stat(24),
        memory:e.memory.buffer.byteLength}));
    // (tools/bench/jit_stats.mjs, docs/jit-unification-plan.md P0.7)
    if(jit_stats_enabled()) print_jit_stats(vm, { script: "xp_boot", wasm, target, milestone, ms: performance.now() - started });
    console.log(JSON.stringify({event:"result", target, completed:target === "time" || !!milestone,
        ms:performance.now()-started, instructions:total, milestone, jit:vm.get_jit_info(), cr4:cpu.cr[4]>>>0}));
} finally {
    await vm.destroy();
}
