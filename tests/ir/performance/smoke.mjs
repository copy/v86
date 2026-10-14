import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { V86 } from "../../../build/libv86.mjs";
import { PerformanceRecorder } from "../../../src/browser/performance_recorder.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, message, timeout = 15000) => {
    const deadline = performance.now() + timeout;
    while(!await test())
    {
        assert(performance.now() < deadline, message);
        await sleep(5);
    }
};
const bytes = value => Uint8Array.of(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24);
const word = async (vm, address) => {
    const data = await vm.read_memory(address, 4);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
};
const counter = async vm => Number(await vm.get_instruction_counter()) >>> 0;
const delta32 = (after, before) => (after - before) >>> 0;
const median = values => {
    assert(values.length > 0, "median requires values");
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const bios = Uint8Array.from(fs.readFileSync("build/cpu-worker-test.bin")).buffer;
const loop_pc = 0x1200000;
const base_budget = {
    hot_threshold: 2,
    promotion_threshold: 4,
    max_source_bytes: 96,
    rep_iterations: 8,
};
const execution_budgets = [128, 256, 512, 1024, 2048, 4096];
const repetitions = 3;
const warm_window_ms = 250;

async function create(extra)
{
    const started = performance.now();
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: "build/v86-ir-runtime.wasm",
        bios: { buffer: bios.slice(0) },
        memory_size: 32 << 20,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        net_device: { type: "none" },
        autostart: false,
        ...extra,
    });
    let loaded = false, failure;
    vm.add_listener("emulator-loaded", () => { loaded = true; });
    vm.add_listener("emulator-error", error => { failure = String(error?.message || error); });
    await until(() => loaded || failure, "performance smoke core initialization");
    assert(!failure, failure);
    return { vm, load_ms: performance.now() - started };
}

async function boot(vm)
{
    const started = performance.now();
    await vm.run();
    await until(async () => await word(vm, 0x500) === 0xCAFE, "performance smoke protected-mode boot");
    return performance.now() - started;
}

async function warm_rate(vm, duration_ms = warm_window_ms)
{
    await sleep(25);
    const before = await counter(vm);
    const started = performance.now();
    await sleep(duration_ms);
    const elapsed_ms = performance.now() - started;
    const after = await counter(vm);
    const steps = delta32(after, before);
    assert(steps > 0, "warm window must execute guest instructions");
    return { elapsed_ms, instruction_steps: steps, instruction_steps_per_ms: steps / elapsed_ms };
}

function target_entry_stats(exports)
{
    const read = field => exports.ir_cache_entry_stat(loop_pc, 0, 1, field) >>> 0;
    return {
        present: read(0),
        hits: read(1),
        guest_steps: read(2),
        max_guest_steps: read(3),
        zero_step_exits: read(4),
        tier: read(5),
        structured_cfg: read(6),
        structured_backedges: read(7),
        generic_dispatch_edges: read(8),
        structured_edges: read(9),
    };
}

async function sample_ir(execution_budget, round)
{
    const budget = { ...base_budget, execution_budget };
    // The matrix measures the region tiers, so ir_tier0 (32-bit code in the x64 page tier) is off.
    const { vm, load_ms } = await create({ ir_tier0: false, ir_region_budget: budget });
    try
    {
        const exports = vm.v86.cpu.wm.exports;
        assert.equal(typeof exports.ir_cache_entry_stat, "function",
            "experimental core exposes entry-scoped IR cache diagnostics");
        const boot_ms = await boot(vm);
        const before = await vm.get_jit_info();
        assert.equal(before.backend, "ir");
        assert.equal(before.ir_region_budget.execution_budget, execution_budget);

        await vm.write_memory(Uint8Array.of(0x40, 0xEB, 0xFD), loop_pc);
        const recorder = new PerformanceRecorder(vm, {
            max_ms: 30000,
            metadata: { purpose: "ir13-execution-budget-matrix", execution_budget, round },
        });
        recorder.start();
        const cold_started = performance.now();
        await vm.write_memory(bytes(loop_pc), 0x600);

        await until(async () => (await vm.get_jit_info()).ir.tier1_published > before.ir.tier1_published,
            "IR Tier 1 publication in performance smoke");
        const tier1_ms = performance.now() - cold_started;
        await until(async () => {
            const info = await vm.get_jit_info();
            return info.ir.tier2_published > before.ir.tier2_published
                && target_entry_stats(exports).tier === 2;
        }, "target loop Tier 2 publication in performance smoke");
        const tier2_ms = performance.now() - cold_started;
        const target_before = target_entry_stats(exports);
        assert.equal(target_before.present, 1);
        assert.equal(target_before.tier, 2);
        assert.equal(target_before.structured_cfg, 1,
            "budget matrix target uses structured CFG emission");
        assert.equal(target_before.structured_backedges, 1);
        assert.equal(target_before.generic_dispatch_edges, 0);
        assert(target_before.structured_edges > 0,
            "budget matrix target records directly structured CFG edges");

        const warm = await warm_rate(vm);
        await vm.stop();
        const target_after = target_entry_stats(exports);
        const report = recorder.stop("ir13_budget_matrix");
        const after = await vm.get_jit_info();

        assert.equal(after.backend, "ir");
        assert.equal(target_after.present, 1, "target Tier 2 record survives warm window");
        assert.equal(target_after.tier, 2, "target record remains Tier 2");
        assert.equal(report.metadata.jit_backend, "ir");
        assert(report.execution_counters_available);

        const target_hits = (target_after.hits - target_before.hits) >>> 0;
        const target_guest_steps = (target_after.guest_steps - target_before.guest_steps) >>> 0;
        const target_zero_step_exits =
            (target_after.zero_step_exits - target_before.zero_step_exits) >>> 0;
        assert(target_hits > 0, "target Tier 2 entry executes during warm window");
        assert(target_guest_steps > 0, "target Tier 2 entry retires guest instructions");
        const target_average_guest_steps_per_activation = target_guest_steps / target_hits;

        return {
            round,
            execution_budget,
            load_ms,
            boot_ms,
            cold_region: { tier1_ms, tier2_ms },
            warm,
            target_entry: {
                hits: target_hits,
                guest_steps: target_guest_steps,
                max_guest_steps: target_after.max_guest_steps,
                zero_step_exits: target_zero_step_exits,
                average_guest_steps_per_activation: target_average_guest_steps_per_activation,
                structured_cfg: target_after.structured_cfg,
                structured_backedges: target_after.structured_backedges,
                generic_dispatch_edges: target_after.generic_dispatch_edges,
                structured_edges: target_after.structured_edges,
            },
            global_ir: {
                tier1_attempts: after.ir.tier1_attempts - before.ir.tier1_attempts,
                tier1_published: after.ir.tier1_published - before.ir.tier1_published,
                tier2_attempts: after.ir.tier2_attempts - before.ir.tier2_attempts,
                tier2_published: after.ir.tier2_published - before.ir.tier2_published,
                cache_hits: after.ir.cache_hits - before.ir.cache_hits,
                cache_cached_checks: after.ir.cache_cached_checks - before.ir.cache_cached_checks,
                cache_capture_fallbacks: after.ir.cache_capture_fallbacks - before.ir.cache_capture_fallbacks,
                cache_guest_steps: (after.ir.cache_guest_steps - before.ir.cache_guest_steps) >>> 0,
                cache_max_guest_steps: after.ir.cache_max_guest_steps,
                cache_zero_step_exits:
                    (after.ir.cache_zero_step_exits - before.ir.cache_zero_step_exits) >>> 0,
                structured_publications:
                    (after.ir.structured_publications - before.ir.structured_publications) >>> 0,
                structured_edges:
                    (after.ir.structured_edges - before.ir.structured_edges) >>> 0,
                generic_publications:
                    (after.ir.generic_publications - before.ir.generic_publications) >>> 0,
                structured_backedges:
                    (after.ir.structured_backedges - before.ir.structured_backedges) >>> 0,
                generic_dispatch_edges:
                    (after.ir.generic_dispatch_edges - before.ir.generic_dispatch_edges) >>> 0,
            },
            recorder: {
                duration_ms: report.duration_ms,
                sync_codegen_ms: report.execution?.sync_codegen_ms ?? null,
                sync_codegen_calls: report.execution?.sync_codegen_calls ?? null,
                jit_compile_publish_latency_ms: report.summary.jit_compile_publish_latency_ms,
                jit_compile_publish_max_ms: report.summary.jit_compile_publish_max_ms,
                jit_wasm_bytes: report.summary.jit_wasm_bytes,
            },
        };
    }
    finally { await vm.destroy(); }
}

function summarize_ir(samples, execution_budget)
{
    assert.equal(samples.length, repetitions, "IR budget matrix requires every repetition");
    return {
        samples: samples.length,
        execution_budget,
        median_load_ms: median(samples.map(sample => sample.load_ms)),
        median_boot_ms: median(samples.map(sample => sample.boot_ms)),
        median_tier1_ms: median(samples.map(sample => sample.cold_region.tier1_ms)),
        median_tier2_ms: median(samples.map(sample => sample.cold_region.tier2_ms)),
        median_instruction_steps_per_ms: median(samples.map(sample => sample.warm.instruction_steps_per_ms)),
        median_target_entry_hits: median(samples.map(sample => sample.target_entry.hits)),
        median_target_entry_guest_steps: median(samples.map(sample => sample.target_entry.guest_steps)),
        median_target_entry_average_guest_steps_per_activation:
            median(samples.map(sample => sample.target_entry.average_guest_steps_per_activation)),
        median_target_entry_max_guest_steps:
            median(samples.map(sample => sample.target_entry.max_guest_steps)),
        median_target_entry_zero_step_exits:
            median(samples.map(sample => sample.target_entry.zero_step_exits)),
        structured_cfg_samples:
            samples.filter(sample => sample.target_entry.structured_cfg === 1).length,
        median_structured_backedges:
            median(samples.map(sample => sample.target_entry.structured_backedges)),
        median_structured_edges:
            median(samples.map(sample => sample.target_entry.structured_edges)),
        median_generic_dispatch_edges:
            median(samples.map(sample => sample.target_entry.generic_dispatch_edges)),
        median_global_cache_capture_fallbacks:
            median(samples.map(sample => sample.global_ir.cache_capture_fallbacks)),
        median_structured_publications:
            median(samples.map(sample => sample.global_ir.structured_publications)),
        median_generic_publications:
            median(samples.map(sample => sample.global_ir.generic_publications)),
    };
}

const ir_runs = Object.fromEntries(execution_budgets.map(budget => [String(budget), []]));
for(let round = 0; round < repetitions; round++)
{
    const order = round & 1 ? [...execution_budgets].reverse() : execution_budgets;
    for(const execution_budget of order)
    {
        ir_runs[String(execution_budget)].push(await sample_ir(execution_budget, round));
    }
}

const ir_summary = {};
for(const execution_budget of execution_budgets)
{
    ir_summary[String(execution_budget)] = summarize_ir(ir_runs[String(execution_budget)], execution_budget);
}
const baseline_128 = ir_summary["128"].median_instruction_steps_per_ms;
let previous;
for(const execution_budget of execution_budgets)
{
    const summary = ir_summary[String(execution_budget)];
    summary.throughput_relative_to_ir_128 = summary.median_instruction_steps_per_ms / baseline_128;
    summary.throughput_relative_to_previous_budget = previous
        ? summary.median_instruction_steps_per_ms / previous.median_instruction_steps_per_ms
        : 1;
    previous = summary;
}

const result = {
    format: "v86-ir13-execution-budget-matrix",
    version: 4,
    policy: {
        note: "Diagnostic matrix only; CI timing has no release threshold and is not an end-to-end speed claim.",
        accounting_note: "execution_budget is dispatcher work units, not guest instructions; no guest-step/budget utilization percentage is reported.",
        core: "build/v86-ir-runtime.wasm",
        base_ir_region_budget: base_budget,
        execution_budgets,
        repetitions,
        warm_window_ms,
        fresh_vm_per_sample: true,
        target_entry_scoped: true,
        order: "IR budgets alternate ascending/descending to reduce fixed order bias",
    },
    summary: {
        ir: ir_summary,
    },
    raw: {
        ir: ir_runs,
    },
};
console.log(JSON.stringify(result, null, 2));
