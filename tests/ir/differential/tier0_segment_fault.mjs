#!/usr/bin/env node
// Accesses through a null segment selector in compiled 32-bit code
// (docs/jit-unification-plan.md P7.2(3)): a hot loop loads a data segment
// based at 0x1000 into ES, so its code runs with other than flat segments,
// loads a null selector into DS, ES, FS or GS in turn, reads through it (#GP,
// whose handler counts it and skips the 3-byte read), and reloads the
// segment. Tier-0's functions for other than flat segments, and the page
// tier's compiled for segment bases (JIT_SWITCHES=x64_page_legacy32=1),
// check the selector at each access; the faults, registers and counters must
// be the interpreter's.
//
//   node tests/ir/differential/tier0_segment_fault.mjs [wasm]
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

const CODE = 0x500000, HANDLER = 0x503000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 40000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
// (ES, DS, FS, GS: the segment register, its override prefix)
const SEGMENTS = [[0, 0x26], [3, 0x3E], [4, 0x64], [5, 0x65]];
const load = (selector, sreg) => [0x66, 0xB8, selector, 0x00, 0x8E, 0xC0 | sreg << 3];   // MOV AX, sel; MOV Sreg, AX

// EBX = DATA (0x1000 less in the segment based at 0x1000): [ebx+124] loop
// counter, [ebx+108] faults, [ebx+104] faults at another EIP than [ebx+100]
const code = [];
code.push(...load(0x18, 0));                                         // ES: the segment based at 0x1000
for(const [sreg, prefix] of SEGMENTS) {
    code.push(...load(0, sreg));                                     // a null selector
    code.push(0x36, 0xC7, 0x43, 100, ...u32(CODE + code.length + 8)); // MOV DWORD SS:[ebx+100], the read's EIP
    code.push(prefix, 0x8B, 0x0B);                                   // MOV ECX, seg:[ebx] (#GP)
    code.push(...load(sreg === 0 ? 0x18 : 0x10, sreg));              // the segment again
    code.push(0x8B, 0x53, 64);                                       // MOV EDX, [ebx+64] (through DS)
}
code.push(0xFF, 0x4B, 124);                                          // DEC DWORD [ebx+124]
code.push(0x0F, 0x85, ...u32(-(code.length + 6)));                   // JNZ top
code.push(...load(0x10, 0), 0xF4, 0xEB, 0xFE);                       // ES flat; HLT
const handler = [
    0x50,                                                            // PUSH EAX
    0x8B, 0x44, 0x24, 0x08,                                          // MOV EAX, [esp+8] (EIP)
    0x36, 0x3B, 0x43, 100,                                           // CMP EAX, SS:[ebx+100]
    0x74, 4,                                                         // JE +4
    0x36, 0xFF, 0x43, 104,                                           // INC DWORD SS:[ebx+104]
    0x36, 0xFF, 0x43, 108,                                           // INC DWORD SS:[ebx+108]
    0x83, 0x44, 0x24, 0x08, 0x03,                                    // ADD DWORD [esp+8], 3 (skip the read)
    0x58,                                                            // POP EAX
    0x83, 0xC4, 0x04,                                                // ADD ESP, 4 (error code)
    0xCF,                                                            // IRETD
];

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        ir_sync_publication: true,
        ...compiled ? { jit_switches: { ...page_tier ? { x64_block_count: 0, x64_legacy_heat: 2000 } : {}, ...jit_switches_from_env() } } : {},
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
    // A fourth descriptor: data based at 0x1000
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset), gdt = cpu.gdtr_offset[0] >>> 0;
    view.setUint32(gdt + 24, 0x1000FFFF, true);
    view.setUint32(gdt + 28, 0x00CF9300, true);
    cpu.gdtr_size[0] = 31;
    if(compiled) assert(e.ir_auto_set_tier0(1));
    return { vm, cpu, e, compiled };
}

async function run({ vm, cpu, e, compiled }) {
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.set(code, CODE);
    cpu.mem8.set(handler, HANDLER);
    cpu.mem8.fill(0, DATA, DATA + 128);
    cpu.mem8.fill(0, STACK - 0x1000, STACK);
    view.setUint32(DATA + 124, ITERATIONS, true);
    view.setUint32(DATA + 64, 0x12345678, true);
    // Vector 13: a present 32-bit interrupt gate to the handler
    view.setUint16(0x7000 + 13 * 8, HANDLER & 0xFFFF, true);
    view.setUint16(0x7000 + 13 * 8 + 2, 8, true);
    view.setUint16(0x7000 + 13 * 8 + 4, 0x8E00, true);
    view.setUint16(0x7000 + 13 * 8 + 6, HANDLER >>> 16, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const native = page_tier ? e.x64_page_stat(1) : 0;
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${compiled ? engine : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `counter ${view.getUint32(DATA + 124, true)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        status: view.getUint32(0x608, true),
        regs: Array.from(cpu.reg32, v => v >>> 0),
        faults: view.getUint32(DATA + 108, true),
        stray: view.getUint32(DATA + 104, true),
        counter: view.getUint32(DATA + 124, true),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        pages: !compiled ? 0 : page_tier ? e.x64_page_stat(37) : e.ir_t0_stat(0),
        native: compiled && page_tier ? e.x64_page_stat(1) - native : 0,
    };
}

const reference = await run(await machine(false));
assert.equal(reference.stray, 0, "the interpreter faulted elsewhere");
assert.equal(reference.faults, 4 * ITERATIONS, "the interpreter took a #GP per null access");
const compiled = await run(await machine(true));
assert(compiled.pages > 0, `no ${engine} page was compiled`);
assert(!page_tier || compiled.native > ITERATIONS, "the page tier ran the loop's instructions natively too seldom");
const strip = ({ pages, native, ...rest }) => rest;
assert.deepEqual(strip(compiled), strip(reference), `${engine}'s null segment accesses differ from the interpreter`);
console.log(`PASS: ${reference.faults} accesses through null DS, ES, FS and GS in ${engine} (${compiled.pages} page compiles` +
    `${page_tier ? `, ${compiled.native} native instructions` : ""}) fault as in the interpreter`);
process.exit(0);
