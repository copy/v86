#!/usr/bin/env node
// Instruction accounting under the x64 page tier's P4 switches
// (docs/jit-unification-plan.md P4 acceptance): system_bench.mjs's guests
// (steps, retries, exits, cold code, SYSCALL at CPL 3, lazy FPU faults)
// retire the same instructions, and the mode ledger accounts for all of
// them, with the page tier off (the reference), on, and on with each
// switch of `ARMS`. The x64 page tier counts exactly with x64_block_count=0
// (docs/profiling.md), so these runs set it.
//
//   node tests/x64/accounting.mjs
import assert from "node:assert/strict";
import {run} from "./system_bench.mjs";
import {mode_ledger, mode_ledger_total} from "../../tools/bench/jit_stats.mjs";

const N = 3000;
const GUESTS = ["base", "cpuid", "retry", "iretq", "syscall", "port_in", "fxsave", "cr0_ts", "nm", "popfq_ac", "cold", "sti"];
const ARMS = {
    interpreter: {x64_page: 0},
    page_tier: {},
    heat_batch: {x64_heat_batch: 1},
    miss_run: {x64_miss_run: 1},
    both: {x64_heat_batch: 1, x64_miss_run: 1},
    sti_shadow: {x64_sti_shadow: 1},
    // (the short guests reach a lower count than the default)
    hot_inline: {x64_hot_inline: 1, x64_hot_count: 4096},
    loops: {x64_loops: 1},
    all: {x64_hot_inline: 1, x64_hot_count: 4096, x64_loops: 1, x64_jac_entries: 2048},
};
const results = {};
// (x64_hot_inline: pages recompiled with inline lookups, P4.14)
let hot_recompiles = 0;
for(const guest of GUESTS)
{
    for(const [arm, switches] of Object.entries(ARMS))
    {
        let retired = 0, ledger = null;
        await run(guest, N, {switches: {x64_block_count: 0, mode_ledger: 1, ...switches}, inspect: emulator => {
            const e = emulator.v86.cpu.wm.exports;
            retired = e.core_statistics_get(0, 0);
            ledger = mode_ledger(e);
            hot_recompiles += arm === "hot_inline" ? e.x64_page_stat(33) : 0;
        }});
        assert.equal(mode_ledger_total(ledger), retired, `${guest}/${arm}: the ledger ${JSON.stringify(ledger)} accounts for ${retired}`);
        (results[guest] ??= {})[arm] = retired;
    }
    const reference = results[guest].interpreter;
    for(const [arm, retired] of Object.entries(results[guest]))
        assert.equal(retired, reference, `${guest}: ${arm} retired ${retired}, the interpreter ${reference}`);
}
assert.ok(hot_recompiles >= GUESTS.length / 2, `x64_hot_inline recompiled ${hot_recompiles} hot pages`);
console.log(`PASS: ${GUESTS.length} guests retire as many instructions as the interpreter with the page tier and its ` +
    `P4 switches (${Object.keys(ARMS).slice(1).join(", ")}), the mode ledger accounting for each: ` +
    GUESTS.map(g => `${g} ${results[g].interpreter}`).join(", ") + `; ${hot_recompiles} hot recompiles`);
