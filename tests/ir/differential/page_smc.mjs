#!/usr/bin/env node
// Writes to a page of compiled legacy-mode code (docs/jit-unification-plan.md
// P7.3, x64::pages::dirty_bytes): a hot loop calls a function on another page;
// every 4096th iteration it writes data on that page next to the code (the
// function retires); every 64th iteration it rewrites the immediates
// of the function's instructions (8, 16 and 32 bits, sign-extended or not:
// MOV, ADD, IMUL, CMP, PUSH, a 16-bit MOV to memory, TEST; volatile in the
// next compile, which loads them from the page); every 8192nd it changes an
// ADD into a SUB (an opcode byte: the function retires); every 16384th it
// replaces the MOV with an instruction of another shape for 64 iterations
// (XOR EDX, EDX and three NOPs: a volatile instruction that changed form).
// Registers, memory and the instruction count must be the interpreter's.
//
//   node tests/ir/differential/page_smc.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, CALLEE = 0x501000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 40000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const u16 = n => [n & 255, n >>> 8 & 255];

// The callee: EBX = DATA; EAX, ESI and EDI accumulate
const callee = [
    0xBA, ...u32(0x1234567),        //  0 MOV EDX, imm32 (imm at 1)
    0x01, 0xD0,                     //  5 ADD EAX, EDX (SUB: 0x29)
    0x83, 0xC0, 0x05,               //  7 ADD EAX, imm8 (at 9)
    0x69, 0xC8, ...u32(0x9E3779B1), // 10 IMUL ECX, EAX, imm32 (at 12)
    0x31, 0xC8,                     // 16 XOR EAX, ECX
    0x3D, ...u32(0x80000000),       // 18 CMP EAX, imm32 (at 19)
    0x83, 0xD6, 0x00,               // 23 ADC ESI, 0
    0x68, ...u32(0x55AA),           // 26 PUSH imm32 (at 27)
    0x5F,                           // 31 POP EDI
    0x01, 0xFE,                     // 32 ADD ESI, EDI
    0x66, 0xC7, 0x43, 0x08, ...u16(0x7777), // 34 MOV WORD [EBX+8], imm16 (at 38)
    0x66, 0x81, 0xC6, ...u16(0x1111), // 40 ADD SI, imm16 (at 43)
    0xA9, ...u32(0x00F000F0),       // 45 TEST EAX, imm32 (at 46)
    0x0F, 0x95, 0xC1,               // 50 SETNZ CL
    0x01, 0xCE,                     // 53 ADD ESI, ECX
    0x6B, 0xC0, 0x03,               // 55 IMUL EAX, EAX, imm8 (at 57)
    0xC3,                           // 58 RET
];

// The loop: EBP counts iterations, [EBX+124] the ones left
const code = [], labels = {}, fixups = [];
const emit = (...bytes) => code.push(...bytes);
const label = name => { labels[name] = code.length; };
const jump = (opcode, name) => { emit(...opcode); fixups.push([code.length, name]); emit(0, 0, 0, 0); };
const at = offset => u32(CALLEE + offset);
label("top");
emit(0x45);                                     // INC EBP
emit(0xF7, 0xC5, ...u32(63));                   // TEST EBP, 63
jump([0x0F, 0x85], "call");                     // JNZ call
emit(0x80, 0x3D, ...at(0), 0x31);               // CMP BYTE [callee], 31h (the other shape?)
jump([0x0F, 0x85], "immediates");               // JNE
emit(0xC6, 0x05, ...at(0), 0xBA);               // MOV BYTE [callee], 0BAh (MOV EDX again)
label("immediates");
emit(0x89, 0xE9);                               // MOV ECX, EBP
emit(0x89, 0x2D, ...at(1));                     // MOV [callee+1], EBP
emit(0x88, 0x0D, ...at(9));                     // MOV [callee+9], CL
emit(0x89, 0x2D, ...at(12));                    // MOV [callee+12], EBP
emit(0x89, 0x2D, ...at(19));                    // MOV [callee+19], EBP
emit(0x89, 0x2D, ...at(27));                    // MOV [callee+27], EBP
emit(0x66, 0x89, 0x2D, ...at(38));              // MOV [callee+38], BP
emit(0x66, 0x89, 0x2D, ...at(43));              // MOV [callee+43], BP
emit(0x89, 0x2D, ...at(46));                    // MOV [callee+46], EBP
emit(0x88, 0x0D, ...at(57));                    // MOV [callee+57], CL
emit(0xF7, 0xC5, ...u32(4095));                 // TEST EBP, 4095
jump([0x0F, 0x85], "call");                     // JNZ call
emit(0x89, 0x2D, ...at(0x800));                 // MOV [callee+800h], EBP (data on the page)
emit(0xF7, 0xC5, ...u32(8191));                 // TEST EBP, 8191
jump([0x0F, 0x85], "call");                     // JNZ call
emit(0x80, 0x35, ...at(5), 0x28);               // XOR BYTE [callee+5], 28h (ADD <-> SUB)
emit(0xF7, 0xC5, ...u32(16383));                // TEST EBP, 16383
jump([0x0F, 0x85], "call");                     // JNZ call
emit(0xC7, 0x05, ...at(0), ...u32(0x9090D231)); // MOV DWORD [callee], XOR EDX, EDX; NOP; NOP
emit(0xC6, 0x05, ...at(4), 0x90);               // MOV BYTE [callee+4], NOP
label("call");
emit(0xE8, ...u32(CALLEE - (CODE + code.length + 5))); // CALL callee
emit(0xFF, 0x4B, 124);                          // DEC DWORD [EBX+124]
jump([0x0F, 0x85], "top");                      // JNZ top
emit(0xF4, 0xEB, 0xFE);                         // HLT
for(const [at, name] of fixups) code.splice(at, 4, ...u32(labels[name] - (at + 4)));

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
    cpu.mem8.fill(0, CALLEE, CALLEE + 4096);
    cpu.mem8.set(callee, CALLEE);
    cpu.mem8.fill(0, DATA, DATA + 128);
    view.setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const native = compiled ? e.x64_page_stat(1) : 0;
    const invalidated = compiled ? e.x64_page_stat(5) : 0;
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
        callee: Array.from(cpu.mem8.subarray(CALLEE, CALLEE + 4096)),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        native: compiled ? e.x64_page_stat(1) - native : 0,
        invalidated: compiled ? e.x64_page_stat(5) - invalidated : 0,
        compiles: compiled ? e.x64_page_stat(37) : 0,
    };
}

const reference = await run(await machine(false));
const compiled = await run(await machine(true));
// (each iteration runs 24 instructions or more, the callee's 20 among them;
// with each immediate's rewrite retiring the callee's function, about 300000
// ran natively)
assert(compiled.native > ITERATIONS * 16, `the page tier ran too few instructions natively: ${compiled.native}`);
// (the first rewrite of each of 9 immediates retires the callee's function
// once, the data on the page 9 times, the opcode changes 4 and the changed
// form 4; later rewrites of immediates none)
assert(compiled.invalidated <= 26, `writes retired the callee's function ${compiled.invalidated} times`);
const strip = ({ native, invalidated, compiles, ...rest }) => rest;
assert.deepEqual(strip(compiled), strip(reference), "the page tier's self-modifying code differs from the interpreter's");
console.log(`PASS: ${ITERATIONS} calls of a function whose page is written, its immediates every 64th, an opcode every 8192nd, ` +
    `as in the interpreter (${compiled.compiles} compiles, ${compiled.invalidated} retired, ${compiled.native} native instructions)`);
process.exit(0);
