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
// node tests/ir/performance/xp_boot.mjs disk.img [core.wasm]; IR_TIER0=0 turns Tier-0 off.
// XP_CPU_TYPE=x86_64: a CPU with NX, for which XP boots its PAE kernel (the
// result's cr4 shows PAE, bit 5).
const [disk, wasm = "build/v86-ir-runtime.wasm", ...extra] = process.argv.slice(2);
assert(disk && !extra.length, "usage: xp_boot.mjs disk.img [core.wasm]");
const duration = Number(process.env.IR_BOOT_MS || 30000);
assert(Number.isFinite(duration) && duration >= 1000);
const recording = process.env.IR_BENCH_RECORD === "1";
const target = process.env.IR_BOOT_TARGET || "time";
assert(["time", "desktop"].includes(target));
const region_budget = {};
if(process.env.IR_HOT_THRESHOLD !== undefined) region_budget.hot_threshold = Number(process.env.IR_HOT_THRESHOLD);
if(process.env.IR_PROMOTION_THRESHOLD !== undefined) region_budget.promotion_threshold = Number(process.env.IR_PROMOTION_THRESHOLD);
if(process.env.IR_SOURCE_WINDOW !== undefined) region_budget.max_source_bytes = Number(process.env.IR_SOURCE_WINDOW);
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
    wasm_path: wasm, ir_region_budget: region_budget,
    ...(process.env.IR_SYNC_PUB !== undefined ? {ir_sync_publication: process.env.IR_SYNC_PUB === "1"} : {}),
    ...(process.env.IR_OPT_LEVEL !== undefined ? {ir_opt_level: Number(process.env.IR_OPT_LEVEL)} : {}),
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
    if(process.env.IR_RESIDENT_PROMOTION !== undefined) {
        assert(["0", "1"].includes(process.env.IR_RESIDENT_PROMOTION));
        assert.equal(typeof e.ir_cache_set_resident_promotion, "function",
            "core does not support IR_RESIDENT_PROMOTION");
        const budget = vm.get_jit_info().ir_region_budget;
        const args = [budget.hot_threshold, budget.promotion_threshold, budget.max_source_bytes,
            budget.execution_budget, budget.rep_iterations];
        const enabled = e.ir_auto_stat(11);
        assert.equal(e.ir_auto_config(0, ...args), 1);
        assert.equal(e.ir_cache_set_resident_promotion(Number(process.env.IR_RESIDENT_PROMOTION)), 1);
        assert.equal(e.ir_auto_config(enabled, ...args), 1);
    }
    if(process.env.IR_HOT_CAPACITY !== undefined) {
        const capacity = Number(process.env.IR_HOT_CAPACITY);
        assert(Number.isInteger(capacity) && capacity >= 128 && capacity <= 512,
            "IR_HOT_CAPACITY must be an integer from 128 through 512");
        assert.equal(typeof e.ir_auto_set_hot_capacity, "function", "core does not support IR_HOT_CAPACITY");
        const budget = vm.get_jit_info().ir_region_budget;
        const args = [budget.hot_threshold, budget.promotion_threshold, budget.max_source_bytes,
            budget.execution_budget, budget.rep_iterations];
        const enabled = e.ir_auto_stat(11);
        assert.equal(e.ir_auto_config(0, ...args), 1);
        assert.equal(e.ir_auto_set_hot_capacity(capacity), 1);
        assert.equal(e.ir_auto_config(enabled, ...args), 1);
    }
    if(process.env.IR_REGION_INSTR !== undefined) { const [a,b]=process.env.IR_REGION_INSTR.split(",").map(Number); assert.equal(e.ir_auto_set_region_instructions(a,b),1); }
    if(process.env.IR_HEAT_STEPS !== undefined) assert.equal(e.ir_auto_set_heat_steps(Number(process.env.IR_HEAT_STEPS)),1);
    if(process.env.IR_DIRECT_T2 !== undefined) e.ir_auto_set_direct_tier2(Number(process.env.IR_DIRECT_T2));
    if(process.env.IR_IDLE_MODE !== undefined) assert.equal(e.ir_auto_set_idle_mode(Number(process.env.IR_IDLE_MODE), Number(process.env.IR_SYNC_AFTER || 16)),1);
    if(process.env.IR_PAGE_MODE !== undefined) assert.equal(e.ir_auto_set_page_mode(Number(process.env.IR_PAGE_MODE)),1);
    if(process.env.IR_TIER0 !== undefined) assert.equal(e.ir_auto_set_tier0(Number(process.env.IR_TIER0)),1);
    if(process.env.IR_T0_RANGES !== undefined) assert.equal(e.ir_t0_set_ranges(Number(process.env.IR_T0_RANGES)),1);
    if(process.env.IR_PAGE_THRESHOLD !== undefined) assert.equal(e.ir_auto_set_page_threshold(Number(process.env.IR_PAGE_THRESHOLD)),1);
    if(process.env.IR_T0_LINK !== undefined) assert.equal(e.ir_t0_set_link_mode(Number(process.env.IR_T0_LINK)),1);
    if(process.env.IR_HOT_FILTER !== undefined) assert.equal(e.ir_auto_set_hot_filter(Number(process.env.IR_HOT_FILTER)),1);
    if(process.env.IR_CACHE_CAPACITY !== undefined) assert.equal(e.ir_cache_set_capacity(Number(process.env.IR_CACHE_CAPACITY)),1);
    if(process.env.IR_FAST_VALIDATION !== undefined) {
        assert(["0", "1"].includes(process.env.IR_FAST_VALIDATION));
        assert.equal(e.ir_cache_set_fast_validation(Number(process.env.IR_FAST_VALIDATION)),1);
    }
    if(process.env.IR_FUSION !== undefined) {
        assert(["0", "1"].includes(process.env.IR_FUSION));
        assert.equal(e.ir_cache_set_fusion(Number(process.env.IR_FUSION)),1);
    }
    for(const [option, setter] of [["IR_WARM_CHAINING", "ir_cache_set_warm_chaining"], ["IR_MISSING_HINT", "ir_cache_set_missing_hint"], ["IR_MERGED_VALIDATION", "ir_cache_set_merged_validation"]]) {
        if(process.env[option] !== undefined) {
            assert(["0", "1"].includes(process.env[option]), option);
            assert.equal(typeof e[setter], "function", `${option} is unsupported by this core`);
            assert.equal(e[setter](Number(process.env[option])), 1);
        }
    }
    if(process.env.IR_DIAGNOSTICS !== undefined) {
        assert.equal(await vm.configure_ir_diagnostics(Number(process.env.IR_DIAGNOSTICS)), true);
    }
    // Opt-in immutable input corpus; no guest memory reads, never enabled in timing runs.
    if(process.env.IR_CAPTURE_FILE) {
        assert(e.ir_cache_replay_info);
        fs.writeFileSync(process.env.IR_CAPTURE_FILE,"");
        const publish=cpu.ir_auto_publish;
        cpu.ir_auto_publish=function(id,...args) {
            const get=(g,i,f)=>e.ir_cache_replay_info(id,g,i,f)>>>0;
            const header=Array.from({length:5},(_,f)=>get(0,0,f));
            const sources=Array.from({length:header[0]},(_,i)=>{
                const bytes=Buffer.from(new Uint8Array(e.memory.buffer,get(1,i,2),get(1,i,3))).toString("hex");
                const mappings=Array.from({length:get(1,i,4)},(_,m)=>`${get(4,i*65536+m,0)}:${get(4,i*65536+m,1)}`).join(",");
                return `${get(1,i,0)} ${get(1,i,1)} ${bytes} ${mappings}`;
            });
            const entries=Array.from({length:header[1]},(_,i)=>get(2,i,0)).join(",")||"-";
            const edges=Array.from({length:header[2]},(_,i)=>`${get(3,i,0)}:${get(3,i,1)}`).join(",")||"-";
            fs.appendFileSync(process.env.IR_CAPTURE_FILE,`${header[3]} ${header[4]} ${entries} ${edges} ${sources.join(" ")}\n`);
            return publish.call(this,id,...args);
        };
    }
    if(recording) e.performance_recording_enable(1);
    started = previous = performance.now();
    count = vm.get_instruction_counter() >>> 0;
    const read_ir = () => [10,2,19,32,35,37].map(field=>e.ir_cache_stat(field)>>>0);
    let prior_ir = read_ir();
    const total_ir = Array(prior_ir.length).fill(0);
    const sample_ir = () => {
        const current = read_ir(), delta = current.map((value,i)=>(value-prior_ir[i])>>>0);
        delta.forEach((value,i)=>total_ir[i]+=value);prior_ir=current;return delta;
    };
    vm.run();
    while(performance.now() - started < duration && !(target === "desktop" && milestone)) {
        await new Promise(resolve => setTimeout(resolve, target === "desktop" ? 250 : 5000));
        const now = performance.now(), next = vm.get_instruction_counter() >>> 0;
        const steps = (next - count) >>> 0;
        total += steps;
        const delta = sample_ir();
        console.log(JSON.stringify({ wasm, ms: now - started,
            phase, instructions: total,
            interval_ir: {steps:delta[0], activations:delta[1], full_checks:delta[2], observer_checks:delta[3],
                warm_handoffs:delta[4], missing_hint_hits:delta[5],
                coverage:steps ? delta[0]/steps : 0,
                activations_per_million:steps ? delta[1]*1e6/steps : 0,
                full_checks_per_million:steps ? delta[2]*1e6/steps : 0,
                validation_attempts_per_million:steps ? (delta[2]+delta[3])*1e6/steps : 0},
            requested_ms: duration, overrun_ms: Math.max(0, now - started - duration),
            mips: steps / (now - previous) / 1000, avg_mips: total / (now - started) / 1000,
            recording, jit: vm.get_jit_info(),
            sync_codegen_ms: recording ? e.performance_recording_get(5) : null,
            sync_codegen_calls: recording ? e.performance_recording_get(7) : null,
        }));
        previous = now; count = next;
    }
    await vm.stop();
    total+=((vm.get_instruction_counter()>>>0)-count)>>>0;sample_ir();
    if(e.ir_t0_stat) console.log(JSON.stringify({event:"tier0", pages:e.ir_t0_stat(0), instructions:e.ir_t0_stat(1), templated:e.ir_t0_stat(2), bytes:e.ir_t0_stat(3), chains:e.ir_t0_chains?.(), entries:e.ir_t0_entries?.(), covered:e.ir_t0_stat(4), memory:e.memory.buffer.byteLength}));
    if(e.ir_t0_template_stat && process.env.IR_TIER0_BYTES) {
        const kinds = [];
        for(let k = 0; k < 64; k++) { const n = e.ir_t0_template_stat(k, 1); if(n) kinds.push([k, e.ir_t0_template_stat(k, 0), n]); }
        kinds.sort((a, b) => b[1] - a[1]);
        console.log(JSON.stringify({event:"tier0_bytes", kinds: kinds.map(([k, b, n]) => `${k}:${b}/${n}=${(b / n).toFixed(0)}`)}));
    }
    // (tools/bench/jit_stats.mjs, docs/jit-unification-plan.md P0.7)
    if(jit_stats_enabled()) print_jit_stats(vm, { script: "xp_boot", wasm, target, milestone, ms: performance.now() - started });
    console.log(JSON.stringify({event:"result", target, completed:target === "time" || !!milestone,
        ms:performance.now()-started, instructions:total, milestone, jit:vm.get_jit_info(), cr4:cpu.cr[4]>>>0,
        // Accumulate wrapping counters per interval; long boots can exceed 2^32.
        ir_work:{guest_steps:total_ir[0],activations:total_ir[1],full_checks:total_ir[2],observer_checks:total_ir[3],
            warm_handoffs:total_ir[4],missing_hint_hits:total_ir[5]},
        boundary_counters:{warm_handoff_supported:typeof e.ir_cache_set_warm_chaining === "function",
            resident_promotion:typeof e.ir_cache_set_resident_promotion === "function" ? e.ir_cache_stat(41) : null,
            promotion_positions_scanned:typeof e.ir_cache_set_resident_promotion === "function" ? e.ir_cache_stat(42)>>>0 : null,
            promotion_candidates:typeof e.ir_cache_set_resident_promotion === "function" ? e.ir_cache_stat(43)>>>0 : null,
            promotion_heat_updates:typeof e.ir_cache_set_resident_promotion === "function" ? e.ir_cache_stat(44)>>>0 : null,
            promotion_failures_suppressed:typeof e.ir_cache_set_resident_promotion === "function" ? e.ir_cache_stat(45)>>>0 : null,
            hot_capacity:typeof e.ir_auto_set_hot_capacity === "function" ? e.ir_auto_stat(29) : 128,
            missing_hint_supported:typeof e.ir_cache_set_missing_hint === "function",entry_aliases:e.ir_cache_stat(30)>>>0,shared_publications:e.ir_cache_stat(31)>>>0,
            observer_rejections:e.ir_cache_stat(33)>>>0,shared_compilations:e.ir_auto_stat(25)>>>0,
            shared_extra_entries:e.ir_auto_stat(26)>>>0}}));
    if(recording) {
        const rows = Array.from({ length: e.performance_recording_hotspot_count() }, (_, i) =>
            Array.from({ length: 10 }, (_, j) => e.performance_recording_hotspot_get(i, j)));
        console.log(JSON.stringify({ event: "samples", rows }));
        const counts = new Map();
        for(const row of rows) counts.set(row[9], (counts.get(row[9]) || 0) + 1);
        const hot = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([pc, samples]) => ({
            pc: pc.toString(16), samples,
            // Physical bytes are useful for early identity-mapped BIOS code only.
            physical_bytes: Buffer.from(cpu.mem8.subarray(pc, pc + 32)).toString("hex"),
        }));
        console.log(JSON.stringify({ event: "hot", hot }));
    }
} finally {
    await vm.destroy();
}
