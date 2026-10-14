// One JIT statistics record for the measuring scripts
// (docs/jit-unification-plan.md P0.7): tests/bench/run.mjs,
// tests/ir/performance/xp_boot.mjs and tests/x64/windows_boot.mjs write the
// same record with JIT_STATS=1. It says what ran (the core file, the JIT
// switches) and what the JITs did, with the definitions of cross-phase rule 3:
// retired instructions are core_statistics_get(core, 0) (a REP instruction
// counts once, a faulting one not at all); the x64 page tier's counters
// (x64_page_stat) and the regions' (CPU.get_jit_info); with the
// JIT switch step_profile on, the 40 most stepped instructions and events
// (StepKey v1, tools/step_profile.mjs; JIT_STATS_STEPS=<n> keeps n); the host
// milliseconds each core ran (runtime_ms); with mode_ledger on, the retired instructions by
// mode and how they ran (mode_ledger below).

import { get_jit_switches } from "../../src/jit_switches.js";
import { step_profile } from "../step_profile.mjs";

// x64_page_stat(index), crate::x64::pages
const X64_FIELDS = ["compiled", "native_retired", "retries", "unknown_exits", "steps", "invalidated", "entries",
    "compile_failures", "recompiles", "instructions_compiled", "templated", "evictions", "ready_functions"];
const X64_EXTRA = { 21: "pages_compiled", 24: "bytes_compiled", 20: "ms_in_calls", 22: "ms_in_execute", 13: "activations",
    14: "invlpg", 26: "cr0_writes", 27: "cr3_writes", 28: "cr4_writes", 29: "full_flushes", 30: "walks", 33: "hot_recompiles", 34: "jac_fills", 35: "jac_conflicts",
    36: "compat_compiles", 37: "legacy_compiles", 38: "spans", 39: "span_pages" };

// cpu/execution.rs: x64::state::ExecutionMode and Way (tier0_*: IR Tier-0's,
// none since P7.5)
export const LEDGER_MODES = ["real", "vm86", "prot16", "prot32", "compat16", "compat32", "long64"];
export const LEDGER_WAYS = ["interpreted", "tier0_native", "tier0_step", "region_native", "page_native", "page_step", "page_retry"];

/**
 * The mode ledger of a core's exports (docs/jit-unification-plan.md P0.6):
 * { mode: { way: retired } }, 32-bit code with flat segments under
 * "<mode>.flat", nonzero counts only; empty while the switch mode_ledger is off
 */
export function mode_ledger(exports)
{
    const ledger = {};
    if(!exports["mode_ledger_get"]) return ledger;
    LEDGER_MODES.forEach((mode, m) => {
        for(const flat of [0, 1]) LEDGER_WAYS.forEach((way, w) => {
            const n = exports["mode_ledger_get"](m, flat, w);
            if(n) (ledger[mode + (flat ? ".flat" : "")] ??= {})[way] = n;
        });
    });
    return ledger;
}
/** The sum of a mode_ledger() result */
export function mode_ledger_total(ledger)
{
    return Object.values(ledger).reduce((sum, ways) => sum + Object.values(ways).reduce((a, b) => a + b, 0), 0);
}

/** Whether the scripts write records: JIT_STATS=1 */
export function jit_stats_enabled(env = process.env)
{
    return env["JIT_STATS"] === "1";
}

/**
 * The record of an emulator (a V86 or its cpu) now; `extra` adds the script's
 * own fields (the core file, what it measured, the workload)
 */
export function jit_stats(emulator, extra = {})
{
    const cpu = emulator.v86 ? emulator.v86.cpu : emulator;
    const exports = cpu.wm.exports;
    const cores = Math.max(1, cpu.cores?.length || 0);
    const retired = Array.from({ length: cores }, (_, core) => exports["core_statistics_get"](core, 0));
    const runtime_ms = Array.from({ length: cores }, (_, core) => exports["core_statistics_get"](core, 4));
    let x64 = null;
    if(exports["x64_page_stat"])
    {
        x64 = {};
        X64_FIELDS.forEach((name, index) => { x64[name] = exports["x64_page_stat"](index); });
        for(const [index, name] of Object.entries(X64_EXTRA)) x64[name] = exports["x64_page_stat"](Number(index));
    }
    const switches = get_jit_switches(exports, cpu.wasm_memory);
    return {
        version: 1,
        ...extra,
        switches,
        retired,
        retired_total: retired.reduce((sum, n) => sum + n, 0),
        runtime_ms,
        x64,
        ir: cpu.get_jit_info()["ir"],
        // (the Wasm table both tiers take their slots from: free now and at
        // the fewest, P0.10)
        table: exports["jit_wasm_table_free_low"] ? { free: exports["jit_get_wasm_table_index_free_list_count"](), free_low: exports["jit_wasm_table_free_low"]() } : null,
        ...switches["step_profile"] ? { steps: step_profile(exports, Number(process.env["JIT_STATS_STEPS"] || 40)) } : {},
        ...switches["mode_ledger"] ? { ledger: mode_ledger(exports) } : {},
    };
}

/** Prints the record as one line: JIT_STATS {...} */
export function print_jit_stats(emulator, extra = {})
{
    console.log("JIT_STATS " + JSON.stringify(jit_stats(emulator, extra)));
}
