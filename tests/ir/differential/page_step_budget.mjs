#!/usr/bin/env node
// Small budgets under compiled legacy-mode code (docs/jit-unification-plan.md
// P7.3; pagegen's budget_flags), run by run_cpu_slice with budgets of 1 to 40
// instructions, around one unit of the budget above its flag bits (16; below
// it the interpreter runs the slice). Each slice must end near its budget:
// - steps: a hot loop steps an IN (a port read, after which the function
//   goes on) in every iteration, and a step takes its unit of the budget
//   (once a step wrapped the budget around, and the activation ran on until
//   the loop ended: a loop that waits for a timer interrupt never did, Linux's
//   boot on 4 cores in workers)
// - chains: a loop's two halves on two pages, each function chaining to the
//   other after an instruction or two (once each chain handed on a budget
//   rounded up, which never ran out: MS-DOS's boot, its far calls between
//   pages, waited for a timer tick that never came)
// Registers, data and the instruction count must be the interpreter's.
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

// (each program at its own address: code written from here retires no
// compiled code)
const STEPS = 0x500000, CHAINS = 0x502000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 20000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];

// EBX = DATA: [ebx+124] iterations left, [ebx+64] the sum of what IN read
const steps = [];
steps.push(
    0x31, 0xC0,                           // XOR EAX, EAX
    0xE4, 0x80,                           // IN AL, 0x80 (stepped)
    0x01, 0x43, 64,                       // ADD [EBX+64], EAX
    0xFF, 0x4B, 124,                      // DEC DWORD [EBX+124]
);
steps.push(0x0F, 0x85, ...u32(-(steps.length + 6)));  // JNZ STEPS
steps.push(0xF4, 0xEB, 0xFE);             // HLT
// CHAINS: INC ECX, JMP CHAINS + 0x1000; there: DEC DWORD [EBX+124], JNZ CHAINS
const chains = new Array(0x1000 + 16).fill(0x90);
chains.splice(0, 6, 0x41, 0xE9, ...u32(0x1000 - 6));
chains.splice(0x1000, 13, 0xFF, 0x4B, 124, 0x0F, 0x85, ...u32(-(0x1000 + 9)), 0xF4, 0xEB, 0xFE);

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

function run({ cpu, e, compiled }, code, at) {
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.set(code, at);
    cpu.mem8.fill(0, DATA, DATA + 128);
    view.setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = at;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const native = compiled ? e.x64_page_stat(1) : 0;
    // (the machine stays stopped: slices are run here, one budget after
    // another; a slice that does not return hangs the test)
    let slices = 0, longest = 0;
    while(!cpu.in_hlt[0]) {
        assert(slices < 10 * ITERATIONS * 5, `${compiled ? "page tier" : "interpreter"}: no HLT after ${slices} slices`);
        const budget = 1 + slices % 40;
        longest = Math.max(longest, cpu.run_cpu_slice(budget) - budget);
        slices++;
    }
    // (an activation may finish its block, and its flags add up to 15)
    assert(longest <= 32, `${compiled ? "page tier" : "interpreter"}: a slice ran ${longest} instructions past its budget`);
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        data: Array.from(cpu.mem8.subarray(DATA, DATA + 128)),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        native: compiled ? e.x64_page_stat(1) - native : 0,
    };
}

const reference = await machine(false), page_tier = await machine(true);
const strip = ({ native, ...rest }) => rest;
for(const [name, code, at] of [["stepping IN in every iteration", steps, STEPS], ["chaining between two pages in every iteration", chains, CHAINS]])
{
    const expected = run(reference, code, at);
    const compiled = run(page_tier, code, at);
    assert(compiled.native > ITERATIONS, `${name}: the page tier ran too few instructions natively: ${compiled.native}`);
    assert.deepEqual(strip(compiled), strip(expected), `${name}: the page tier's run differs from the interpreter's`);
    console.log(`PASS: a loop ${name}, in slices of 1 to 40 instructions, as in the interpreter (${compiled.native} native instructions)`);
}
process.exit(0);
