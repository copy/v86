#!/usr/bin/env node
// The mode ledger (docs/jit-unification-plan.md P0.6) with the x64 page tier:
// on from the machine's construction, its sum is the retired count
// (cross-phase rule 3), and a multiboot guest's way into long mode lands in
// the rows of its modes: the 32-bit setup interpreted, the far jump that
// leaves compatibility mode, then a 64-bit loop that the page tier runs
// natively and in which it steps CPUID.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {mode_ledger, mode_ledger_total} from "../../tools/bench/jit_stats.mjs";

const ITERATIONS = 20000;
const directory = assemble("mode-ledger", long_mode_guest(`
mov r8d,${ITERATIONS}
.loop:
xor eax,eax
cpuid
add r9,rax
dec r8d
jnz .loop
`));
let ledger, retired;
await actual(directory, {length: 4, timeout: 60000,
    options: {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true, jit_switches: {mode_ledger: 1}},
    inspect: emulator => {
        const e = emulator.v86.cpu.wm.exports;
        ledger = mode_ledger(e);
        retired = e.core_statistics_get(0, 0);
    }});
const row = name => ledger[name] || {};
assert.equal(mode_ledger_total(ledger), retired, `the ledger accounts for every retired instruction: ${JSON.stringify(ledger)}`);
assert.ok(row("prot32.flat").interpreted > 0, `the 32-bit setup: ${JSON.stringify(ledger)}`);
assert.ok(row("compat32.flat").interpreted > 0, `the far jump from compatibility mode: ${JSON.stringify(ledger)}`);
assert.ok(row("long64").page_native > ITERATIONS && row("long64").page_step >= ITERATIONS / 2, `the 64-bit loop: ${JSON.stringify(ledger)}`);
console.log(`PASS: the mode ledger accounts for ${retired} retired instructions: ${JSON.stringify(ledger)}`);
