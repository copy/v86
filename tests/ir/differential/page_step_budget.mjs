#!/usr/bin/env node
// Small budgets under compiled legacy-mode code that steps (docs/jit-
// unification-plan.md P7.3; pagegen's budget_flags): a hot loop steps an IN
// (a port read, after which the function goes on) in every iteration, run
// by run_cpu_slice with budgets of 1 to 15 instructions, below the budget's
// flag bits. A step takes its unit of the budget, and each slice must end
// near its budget: once a step wrapped the budget around, and the
// activation ran on until the loop ended (a loop that waits for a timer
// interrupt never did: Linux's boot on 4 cores in workers). Registers, data
// and the instruction count must be the interpreter's.
//
//   node tests/ir/differential/page_step_budget.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 20000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];

// EBX = DATA: [ebx+124] iterations left, [ebx+64] the sum of what IN read
const code = [];
const top = code.length;
code.push(
    0x31, 0xC0,                           // XOR EAX, EAX
    0xE4, 0x80,                           // IN AL, 0x80 (stepped)
    0x01, 0x43, 64,                       // ADD [EBX+64], EAX
    0xFF, 0x4B, 124,                      // DEC DWORD [EBX+124]
);
code.push(0x0F, 0x85, ...u32(top - (code.length + 6)));  // JNZ top
code.push(0xF4, 0xEB, 0xFE);              // HLT

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        ir_sync_publication: true,
        ...compiled ? { jit_switches: { x64_page_legacy32: 1, x64_legacy_heat: 2000, ...jit_switches_from_env() } } : {},
        bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
    });
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run();
    const end = performance.now() + 15000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
        assert(performance.now() < end, "benchmark BIOS did not start");
        await sleep(1);
    }
    await vm.stop();
    if(compiled) assert(e.jit_set_page32(1));
    return { vm, cpu, e, compiled };
}

function run({ cpu, e, compiled }) {
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.set(code, CODE);
    cpu.mem8.fill(0, DATA, DATA + 128);
    view.setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const native = compiled ? e.x64_page_stat(1) : 0;
    // (the machine stays stopped: slices are run here, one budget after
    // another; a slice that does not return hangs the test)
    let slices = 0, longest = 0;
    while(!cpu.in_hlt[0]) {
        assert(slices < 10 * ITERATIONS * 5, `${compiled ? "page tier" : "interpreter"}: no HLT after ${slices} slices`);
        const budget = 1 + slices % 15;
        longest = Math.max(longest, cpu.run_cpu_slice(budget) - budget);
        slices++;
    }
    // (an activation may finish its block and run its budget up to the
    // next multiple of 16, BUDGET_FLAGS)
    assert(longest <= 32, `${compiled ? "page tier" : "interpreter"}: a slice ran ${longest} instructions past its budget`);
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        data: Array.from(cpu.mem8.subarray(DATA, DATA + 128)),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        native: compiled ? e.x64_page_stat(1) - native : 0,
    };
}

const reference = run(await machine(false));
const compiled = run(await machine(true));
assert(compiled.native > ITERATIONS * 2, `the page tier ran too few instructions natively: ${compiled.native}`);
const strip = ({ native, ...rest }) => rest;
assert.deepEqual(strip(compiled), strip(reference), "the page tier's run differs from the interpreter's");
console.log(`PASS: a loop stepping IN in every iteration, in slices of 1 to 15 instructions, as in the interpreter (${compiled.native} native instructions)`);
process.exit(0);
