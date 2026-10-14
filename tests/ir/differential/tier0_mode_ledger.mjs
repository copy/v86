#!/usr/bin/env node
// The mode ledger (docs/jit-unification-plan.md P0.6) with the x64 page tier
// in legacy mode (written for IR Tier-0, deleted in P7.5): on from
// the machine's construction (the JIT switch mode_ledger), it must account
// for every retired instruction (cross-phase rule 3: its sum is
// core_statistics_get(0, 0)) and file them by mode and how they ran. The
// benchmark BIOS starts in real mode; then a hot loop in flat 32-bit code
// runs in a page function that steps CPUID and MOV DS, and loads DS
// with a segment based at 4 KiB for a few instructions, which therefore run
// as 32-bit code without flat segments.
//
//   node tests/ir/differential/tier0_mode_ledger.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build).
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { mode_ledger, mode_ledger_total } from "../../../tools/bench/jit_stats.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 30000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const code = [
    0x31, 0xC0,                                     // XOR EAX, EAX
    0x0F, 0xA2,                                     // CPUID
    0x66, 0xB8, 0x18, 0x00,                         // MOV AX, 0x18 (based at 0x1000)
    0x8E, 0xD8,                                     // MOV DS, AX
    0xA1, ...u32(0),                                // MOV EAX, [0] (linear 0x1000)
    0x01, 0xC6,                                     // ADD ESI, EAX
    0x66, 0xB8, 0x10, 0x00,                         // MOV AX, 0x10
    0x8E, 0xD8,                                     // MOV DS, AX
    0xFF, 0x0D, ...u32(DATA + 124),                 // DEC DWORD [DATA+124]
];
code.push(0x0F, 0x85, ...u32(-(code.length + 6)), 0xF4); // JNZ top; HLT

const vm = new V86({
    graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 128 << 20, ir_sync_publication: true,
    // (the page tier compiles a page after 2000 instructions)
    jit_switches: { mode_ledger: 1, x64_legacy_heat: 2000 },
    bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
    disable_speaker: true, net_device: { type: "none" }, autostart: false,
});
await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
const cpu = vm.v86.cpu, e = cpu.wm.exports;
vm.run();
const ready = performance.now() + 15000;
while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
    assert(performance.now() < ready, "benchmark BIOS did not start");
    await sleep(1);
}
await vm.stop();

const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
// A fourth descriptor: a data segment based at 0x1000.
const gdt = cpu.gdtr_offset[0] >>> 0;
view.setUint32(gdt + 24, 0x1000FFFF, true);
view.setUint32(gdt + 28, 0x00CF9200, true);
cpu.gdtr_size[0] = 31;
cpu.mem8.set(code, CODE);
cpu.mem8.fill(0, DATA, DATA + 128);
view.setUint32(DATA + 124, ITERATIONS, true);
cpu.reg32.fill(0);
cpu.reg32[4] = STACK;
cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
cpu.instruction_pointer[0] = CODE;
e.update_state_flags();
e.full_clear_tlb();
vm.run();
const end = performance.now() + 30000;
while(!cpu.in_hlt[0]) {
    if(performance.now() > end) {
        await vm.stop();
        throw new Error(`timeout: eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} counter ${view.getUint32(DATA + 124, true)}`);
    }
    await sleep(0);
}
await vm.stop();
assert.equal(view.getUint32(0x608, true), 0, "the guest took an exception");
assert.equal(view.getUint32(DATA + 124, true), 0);

const ledger = mode_ledger(e), retired = e.core_statistics_get(0, 0);
const row = name => ledger[name] || {};
assert.equal(mode_ledger_total(ledger), retired, `the ledger accounts for every retired instruction: ${JSON.stringify(ledger)}`);
assert(row("real").interpreted > 0, "the BIOS's real-mode start is in the ledger");
assert(row("prot32.flat").page_native > ITERATIONS, `flat 32-bit code ran in a page function: ${JSON.stringify(ledger)}`);
assert(row("prot32.flat").page_step >= ITERATIONS / 2, `CPUID and MOV DS were stepped: ${JSON.stringify(ledger)}`);
assert(mode_ledger_total({ prot32: row("prot32") }) >= ITERATIONS / 2, `the instructions with DS based at 0x1000: ${JSON.stringify(ledger)}`);
await vm.destroy();
console.log(`PASS: the mode ledger accounts for ${retired} retired instructions: ${JSON.stringify(ledger)}`);
process.exit(0);
