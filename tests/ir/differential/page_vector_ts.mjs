#!/usr/bin/env node
// CR0.TS under compiled legacy-mode SSE and x87 code (docs/jit-unification-
// plan.md P7.3; pagegen's vector_ok, which the page tier computes at entry
// and after each step): a hot loop adds with ADDPS and FADD, and every 8th
// iteration sets CR0.TS with MOV CR0 (a step); the next SSE or x87
// instruction raises #NM, whose handler counts it, clears TS with CLTS and
// returns to the instruction. Faults, registers and the instruction count
// must be the interpreter's.
//
//   node tests/ir/differential/page_vector_ts.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, HANDLER = 0x503000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 40000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];

// EBX = DATA: [ebx+124] iterations left, [ebx+108] #NM taken, [ebx] the
// SSE operand
const code = [
    0xDB, 0xE3,                           // FNINIT
    0xD9, 0xE8,                           // FLD1
    0x0F, 0x28, 0x0B,                     // MOVAPS XMM1, [EBX]
];
const top = code.length;
code.push(
    0x0F, 0x58, 0xC1,                     // ADDPS XMM0, XMM1
    0xD8, 0xC0,                           // FADD ST0, ST0
    0xD9, 0xE1,                           // FABS
    0x0F, 0x58, 0xD0,                     // ADDPS XMM2, XMM0
    0xF7, 0x43, 124, ...u32(7),           // TEST DWORD [EBX+124], 7
    0x75, 9,                              // JNZ +9
    0x0F, 0x20, 0xC0,                     // MOV EAX, CR0
    0x83, 0xC8, 0x08,                     // OR EAX, 8 (TS)
    0x0F, 0x22, 0xC0,                     // MOV CR0, EAX
    0xFF, 0x4B, 124,                      // DEC DWORD [EBX+124]
);
code.push(0x0F, 0x85, ...u32(top - (code.length + 6)));  // JNZ top
code.push(0xDD, 0x5B, 64);                // FSTP QWORD [EBX+64]
code.push(0x0F, 0x29, 0x53, 32);          // MOVAPS [EBX+32], XMM2
code.push(0xF4, 0xEB, 0xFE);              // HLT
const handler = [
    0xFF, 0x43, 108,                      // INC DWORD [EBX+108]
    0x0F, 0x06,                           // CLTS
    0xCF,                                 // IRETD (to the faulting instruction)
];

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        ir_sync_publication: true,
        ...compiled ? { jit_switches: { x64_page_legacy32: 1, x64_block_count: 0, x64_legacy_heat: 2000, ...jit_switches_from_env() } } : {},
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
    if(compiled) assert(e.ir_auto_set_tier0(1));
    return { vm, cpu, e, compiled };
}

async function run({ vm, cpu, e, compiled }) {
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.set(code, CODE);
    cpu.mem8.set(handler, HANDLER);
    cpu.mem8.fill(0, DATA, DATA + 128);
    for(let i = 0; i < 4; i++) view.setFloat32(DATA + 4 * i, 0.25 * (i + 1), true);
    view.setUint32(DATA + 124, ITERATIONS, true);
    // Vector 7: a present 32-bit interrupt gate to the handler
    view.setUint16(0x7000 + 7 * 8, HANDLER & 0xFFFF, true);
    view.setUint16(0x7000 + 7 * 8 + 2, 8, true);
    view.setUint16(0x7000 + 7 * 8 + 4, 0x8E00, true);
    view.setUint16(0x7000 + 7 * 8 + 6, HANDLER >>> 16, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const native = compiled ? e.x64_page_stat(1) : 0;
    vm.run();
    const end = performance.now() + 60000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${compiled ? "page tier" : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        data: Array.from(cpu.mem8.subarray(DATA, DATA + 128)),
        cr0: cpu.cr[0] >>> 0,
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        native: compiled ? e.x64_page_stat(1) - native : 0,
    };
}

const reference = await run(await machine(false));
const faults = new DataView(Uint8Array.from(reference.data).buffer).getUint32(108, true);
assert.equal(faults, ITERATIONS / 8, "the interpreter took a #NM after each MOV CR0 that set TS");
const compiled = await run(await machine(true));
assert(compiled.native > ITERATIONS * 4, `the page tier ran too few instructions natively: ${compiled.native}`);
const strip = ({ native, ...rest }) => rest;
assert.deepEqual(strip(compiled), strip(reference), "the page tier's #NM differs from the interpreter's");
console.log(`PASS: ${faults} #NM after CR0.TS set in compiled SSE and x87 code, as in the interpreter (${compiled.native} native instructions)`);
process.exit(0);
