#!/usr/bin/env node
// The template-kind profile (docs/jit-unification-plan.md P3.0a): with the
// JIT switch t0_kind_profile on from the machine's construction, Tier-0's
// page functions count each instruction they execute by its key, so the
// counts add up to what the mode ledger files as Tier-0's (tier0_native and
// tier0_step), and each instruction of a hot loop counts once per
// iteration it ran compiled (the first ones run in the interpreter until
// the page is hot; an entry in the middle of the loop counts the rest of
// that iteration): integer templates by Form kind, CPUID as a step, the x87
// forms by opcode and ModRM, a run of register forms (its fast path counts
// when it completes) as well as single ones and a memory form.
//
//   node tests/ir/differential/tier0_kind_profile.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build).
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { kind_profile, mode_ledger } from "../../../tools/bench/jit_stats.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 30000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const prelude = [
    0xDB, 0xE3,                                     // FNINIT
    0xD9, 0xE8,                                     // FLD1
    0xD9, 0xE8,                                     // FLD1
];
const loop = [
    0x31, 0xC0,                                     // XOR EAX, EAX
    0x0F, 0xA2,                                     // CPUID (a step)
    0x01, 0xC6,                                     // ADD ESI, EAX
    0xD8, 0xC1,                                     // FADD ST0, ST1
    0xD8, 0xE1,                                     // FSUB ST0, ST1
    0xD9, 0xC9,                                     // FXCH ST1
    0xDD, 0x05, ...u32(DATA + 64),                  // FLD QWORD [DATA+64]
    0xD9, 0xFA,                                     // FSQRT
    0xDD, 0xD8,                                     // FSTP ST0
    0xFF, 0x0D, ...u32(DATA + 124),                 // DEC DWORD [DATA+124]
];
loop.push(0x0F, 0x85, ...u32(-(loop.length + 6))); // JNZ top
const code = [...prelude, ...loop, 0xF4];           // HLT

const vm = new V86({
    graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 128 << 20, ir_sync_publication: true,
    // (Tier-0's: the page tier runs 32-bit code by default since M8)
    jit_switches: { mode_ledger: 1, t0_kind_profile: 1, x64_page_legacy32: 0 },
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
assert(e.ir_auto_set_tier0(1));
// (what the BIOS's own code counted)
e.ir_t0_kind_profile_reset();
e.mode_ledger_reset();

const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
cpu.mem8.set(code, CODE);
cpu.mem8.fill(0, DATA, DATA + 128);
view.setFloat64(DATA + 64, 1, true);
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

const rows = kind_profile(e, cpu.wasm_memory);
const count = name => rows.find(r => r.name === name)?.count || 0;
const total = rows.reduce((sum, r) => sum + r.count, 0);
const tier0 = Object.values(mode_ledger(e)).reduce((sum, ways) => sum + (ways.tier0_native || 0) + (ways.tier0_step || 0), 0);
const summary = JSON.stringify(rows.slice(0, 16).map(r => [r.name, r.count]));
assert.equal(total, tier0, `the profile counts what Tier-0 ran (the mode ledger's tier0_native and tier0_step): ${summary}`);
// Each instruction of the loop once per compiled iteration, as the
// backward branch
const compiled = count("Jcc");
assert(compiled > ITERATIONS / 2 && compiled <= ITERATIONS, `most iterations ran compiled: ${compiled} of ${ITERATIONS}: ${summary}`);
const per_iteration = (name, times = 1) => {
    const n = count(name);
    assert(Math.abs(n - times * compiled) <= times, `${name}: ${n} for ${compiled} compiled iterations: ${summary}`);
};
per_iteration("Step");
per_iteration("Alu", 2);
per_iteration("Jcc");
for(const x87 of ["x87 D8 C1", "x87 D8 E1", "x87 D9 C9", "x87 DD /0 m", "x87 D9 FA", "x87 DD D8"]) per_iteration(x87);
await vm.destroy();
console.log(`PASS: the template-kind profile counts ${total} instructions as the mode ledger files Tier-0's: ${summary}`);
process.exit(0);
