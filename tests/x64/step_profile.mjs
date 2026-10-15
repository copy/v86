#!/usr/bin/env node
// The step profile of the x64 page tier (docs/jit-unification-plan.md P0.5):
// a long-mode loop whose page function steps CPUID and a REX.W CPUID. With
// the JIT switch step_profile on, the steps land under their StepKeys
// (64-bit mode, the x64 page tier; REX.W kept apart), and
// x64_page_profile_get still reads them by the tier's earlier key, which
// sums the two.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {set_jit_switches} from "../../src/jit_switches.js";
import {step_key, step_profile} from "../../tools/step_profile.mjs";

const ITERATIONS = 20000;
const directory = assemble("step-profile", long_mode_guest(`
mov r8d,${ITERATIONS}
.loop:
xor eax,eax
cpuid
xor eax,eax
db 0x48
cpuid
dec r8d
jnz .loop
`));
let profile, legacy, steps;
await actual(directory, {length: 4, timeout: 60000,
    options: {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
    setup: emulator => {
        const cpu = emulator.v86.cpu;
        set_jit_switches(cpu.wm.exports, cpu.wasm_memory, {step_profile: 1}, "x64 step_profile");
    },
    inspect: emulator => {
        const e = emulator.v86.cpu.wm.exports;
        profile = step_profile(e);
        legacy = e.x64_page_profile_get(0x1A2);
        steps = e.x64_page_stat(4);
    }});
const count = fields => profile.find(r => r.key === step_key({opcode: 0xA2, map: 1, mode: "long64", stepper: "x64page", ...fields}))?.count ?? 0;
const plain = count({}), wide = count({rex_w: true});
assert.ok(plain >= ITERATIONS / 2 && wide >= ITERATIONS / 2,
    `the x64 page tier stepped CPUID ${plain} and REX.W CPUID ${wide} times (${steps} steps): ${JSON.stringify(profile.slice(0, 4))}`);
assert.equal(legacy, plain + wide, "x64_page_profile_get sums CPUID's StepKeys");
console.log(`PASS: the x64 page tier stepped CPUID ${plain} and REX.W CPUID ${wide} times, under their StepKeys and its earlier key`);
