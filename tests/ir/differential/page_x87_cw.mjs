#!/usr/bin/env node
// FLDCW in compiled legacy-mode code (docs/jit-unification-plan.md M8,
// pages::x64_page_fldcw): a hot loop converts values with FISTP under each
// rounding mode in turn (FNSTCW, the RC field set, FLDCW, FISTP, FLDCW of
// the saved word, as compilers truncate) and once in a while lowers the
// precision control; the integers, the x87 state and the instruction count
// must be the interpreter's. Tier-0 by default, the page tier with
// JIT_SWITCHES=x64_page_legacy32=1.
//
//   node tests/ir/differential/page_x87_cw.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const page_tier = jit_switches_from_env().x64_page_legacy32 === 1;
const engine = page_tier ? "the page tier" : "Tier-0";

const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 40000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];

// EBX = DATA: [ebx] the value (a double), [ebx+8] its step, [ebx+16] the
// saved control word, [ebx+20] the one loaded, [ebx+24] the integer,
// [ebx+28] their sum, [ebx+124] iterations left; ECX counts up
const code = [0xDB, 0xE3];                // FNINIT
const top = code.length;
code.push(
    0xDD, 0x03,                           // FLD QWORD [EBX]
    0xDC, 0x43, 8,                        // FADD QWORD [EBX+8]
    0xDD, 0x13,                           // FST QWORD [EBX]
    0xD9, 0x7B, 16,                       // FNSTCW [EBX+16]
    0x0F, 0xB7, 0x43, 16,                 // MOVZX EAX, WORD [EBX+16]
    0x89, 0xCA,                           // MOV EDX, ECX
    0x83, 0xE2, 0x03,                     // AND EDX, 3 (the rounding mode)
    0xC1, 0xE2, 0x0A,                     // SHL EDX, 10
    0x80, 0xE4, 0xF3,                     // AND AH, 0F3h
    0x09, 0xD0,                           // OR EAX, EDX
    0xF7, 0xC1, ...u32(1023),             // TEST ECX, 1023
    0x75, 3,                              // JNZ +3
    0x80, 0xE4, 0xFC,                     // AND AH, 0FCh (precision: single)
    0x66, 0x89, 0x43, 20,                 // MOV [EBX+20], AX
    0xD9, 0x6B, 20,                       // FLDCW [EBX+20]
    0xDB, 0x5B, 24,                       // FISTP DWORD [EBX+24]
    0xD9, 0x6B, 16,                       // FLDCW [EBX+16]
    0x8B, 0x43, 24,                       // MOV EAX, [EBX+24]
    0x01, 0x43, 28,                       // ADD [EBX+28], EAX
    0x41,                                 // INC ECX
    0xFF, 0x4B, 124,                      // DEC DWORD [EBX+124]
);
code.push(0x0F, 0x85, ...u32(top - (code.length + 6)));  // JNZ top
code.push(0xD9, 0x7B, 32);                // FNSTCW [EBX+32]
code.push(0xF4, 0xEB, 0xFE);              // HLT

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        ir_sync_publication: true,
        ...compiled ? { jit_switches: { ...page_tier ? { x64_block_count: 0, x64_legacy_heat: 2000 } : { x64_page_legacy32: 0 }, ...jit_switches_from_env() } } : {},
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
    cpu.mem8.fill(0, DATA, DATA + 128);
    view.setFloat64(DATA, -1000.3, true);
    view.setFloat64(DATA + 8, 0.0371, true);
    view.setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const native = compiled && page_tier ? e.x64_page_stat(1) : 0;
    vm.run();
    const end = performance.now() + 60000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${compiled ? engine : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        data: Array.from(cpu.mem8.subarray(DATA, DATA + 64)),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        native: compiled && page_tier ? e.x64_page_stat(1) - native : 0,
    };
}

const reference = await run(await machine(false));
const compiled = await run(await machine(true));
assert(!page_tier || compiled.native > ITERATIONS * 20, `the page tier ran too few instructions natively: ${compiled.native}`);
const strip = ({ native, ...rest }) => rest;
assert.deepEqual(strip(compiled), strip(reference), `${engine}'s FLDCW and FISTP differ from the interpreter's`);
const sum = new DataView(Uint8Array.from(reference.data).buffer).getInt32(28, true);
console.log(`PASS: ${ITERATIONS} FISTP under each rounding mode set by FLDCW in ${engine} as in the interpreter (sum ${sum}` +
    `${page_tier ? `, ${compiled.native} native instructions` : ""})`);
process.exit(0);
