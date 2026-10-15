#!/usr/bin/env node
// 16-bit differential fuzzing (docs/jit-unification-plan.md P7.7(6), P7.8):
// random 16-bit programs run hot in a loop in a 16-bit code segment of
// protected mode, real mode or virtual-8086 mode (FUZZ_MODE prot16, real or
// v86; so their page is compiled by the x64 page tier with x64_page_prot16
// or x64_page_v86; prot16ss32: protected mode with a 32-bit stack, M11) and
// must leave exactly the interpreter's state: the GPRs, FLAGS (PUSHF inside
// the loop stores them), the data, stack and counter segments, and the
// retired-instruction count. Each program must also have run in page
// functions, most of its instructions there.
//
// A 32-bit prologue loads SS (16-bit stack), DS and ES (the loop counter's
// segment) with 16-bit descriptors and jumps far to the program. Every case
// runs on a fresh code page, its code segment based so that the page starts
// at IP 0x840 (or, with FUZZ_STRADDLE=1, the program straddles two pages);
// the data and stack segments are 64 KiB each, so every 16-bit address is
// in them (the interpreter checks no data segment limits).
// Real mode and virtual-8086 mode set the machine state directly instead of
// a prologue, below 1 MiB (segment bases are the selectors shifted left by
// 4; at most 24 cases a run). Virtual-8086 programs run with IOPL 3 and
// paging off (boot.bin's page tables are not user pages); their final HLT
// is #GP, which a ring-0 handler of our own (TSS at 0x8000, IDT vector 13)
// halts at.
//
//   node tests/ir/differential/prot16_fuzz.mjs [cases=40] [seed=1] [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
// FUZZ_KIND restricts the programs: a (ALU and moves), m (memory operands),
// s (stack: pushes, pops, calls, LEAVE and ENTER frames, 32-bit pushes),
// j (jumps, LOOP, JCXZ), g (segment register loads, LES, LDS), x
// (multiplies, divides, shifts, extensions), f (far calls into a second
// code segment), l (LODS), z (a null ES loaded at the last round, then an
// ES access: #GP; protected mode only), c (self-modifying code: the round
// counter written over the immediate of the next instruction, through FS,
// flat, with a 32-bit address), y (protected mode: at the last round a far
// call to a selector past the GDT's limit, or a RETF popping one: #GP, in
// the page tier's far transfer helper, M11), i (virtual-8086 mode only: IOPL 0, no
// PUSHF captures, and at the last round PUSHF, POPF, CLI or STI: #GP), k
// (as i, but that instruction first, behind JMP +1 and reached by the JMP
// -3 after it: cold code, the page tier's interpreted blocks (a backward
// jump ends one), the #GP in the second one's first instruction; the
// handler's stack frame, the faulting IP, compared too).
// FUZZ_DEBUG=1 prints each case. JIT_SWITCHES applies to the compiled machine.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const cases = Number(process.argv[2] || 40);
let seed = Number(process.argv[3] || 1) >>> 0;
const wasm = process.argv[4] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const only = process.env.FUZZ_KIND || "";
const straddle = process.env.FUZZ_STRADDLE === "1";
const MODE = process.env.FUZZ_MODE || "prot16";
assert(["prot16", "prot16ss32", "real", "v86"].includes(MODE), "FUZZ_MODE: prot16, prot16ss32, real or v86");
const paragraphs = MODE === "real" || MODE === "v86";
assert(!paragraphs || cases <= 24, "real and virtual-8086 mode: at most 24 cases (below 1 MiB)");
assert(!paragraphs || only !== "z" && only !== "y", "kinds z and y need protected mode (no null selectors, no descriptors)");
assert(!["i", "k"].includes(only) || MODE === "v86", "kinds i and k need virtual-8086 mode");
const iopl0 = ["i", "k"].includes(only);

// The prologue's page, the code pages (one per case), the segments
const { PROLOGUE, CODE, DATA, STACK, COUNTER, FAR } = paragraphs ?
    // (a page after the stack: a 32-bit push at SP 2 writes past its end)
    { PROLOGUE: 0, CODE: 0x6B000, DATA: 0x30000, STACK: 0x40000, COUNTER: 0x51000, FAR: 0x52000 } :
    { PROLOGUE: 0x480000, CODE: 0x500000, DATA: 0x600000, STACK: 0x620000, COUNTER: 0x640000, FAR: 0x680000 };
const IP = 0x840, ITERATIONS = 20000;
// (selectors; in real and virtual-8086 mode the segments' paragraphs: the
// far routine's and code's per case, see run)
const SEL = paragraphs ? { data: DATA >> 4, stack: STACK >> 4, counter: COUNTER >> 4, far: 0 } :
    { code: 0x20, data: 0x28, stack: 0x30, counter: 0x38, far: 0x40 };
// Virtual-8086 mode's #GP handler (HLT), TSS and ring-0 stack
const V86_HANDLER = 0x8100, V86_TSS = 0x8000, V86_STACK0 = 0x9000, TSS_SELECTOR = 0x48;
// the far routine's IP in its code segment
const FAR_IP = 0x100;
const random = () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed;
};
const pick = list => list[random() % list.length];
const u16 = n => [n & 255, n >>> 8 & 255];
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
/** A 16-bit descriptor (G = 0, D/B = 0, or `flags` 0x40: B = 1): base, limit 0xFFFF, access byte */
const descriptor = (base, access, flags = 0) => [0xFF, 0xFF, base & 255, base >>> 8 & 255, base >>> 16 & 255, access, flags, base >>> 24 & 255];

// Registers: AX CX DX BX SP BP SI DI; destinations never SP (4)
const DESTINATIONS = [0, 1, 2, 3, 5, 6, 7];
const dst = () => pick(DESTINATIONS);
const any = () => random() & 7;
const rr = (r, m) => 0xC0 | r << 3 | m;
// A 16-bit memory operand: mod 0-2, every r/m (BP's forms address SS),
// with r/m 6 and mod 0 a 16-bit displacement
function memory(r) {
    const mod = random() % 3, m = random() & 7;
    if(mod === 0 && m === 6) return [r << 3 | 6, ...u16(random())];
    if(mod === 0) return [r << 3 | m];
    if(mod === 1) return [0x40 | r << 3 | m, random() & 255];
    return [0x80 | r << 3 | m, ...u16(random())];
}
const rm = r => random() % 3 ? [rr(r, dst())] : memory(r);
const rm_source = r => random() % 3 ? [rr(r, any())] : memory(r);

function alu() {
    const code = random() & 7, form = random() % 6;
    switch(form) {
        case 0: return [code << 3 | 1, ...rm(any())];                       // op r/m16, r16
        case 1: return [code << 3 | 3, ...rm_source(dst())];                // op r16, r/m16
        case 2: return [code << 3 | 0, ...random() % 3 ? [rr(any(), any())] : memory(any())]; // op r/m8, r8
        case 3: return [0x81, ...rm(code), ...u16(random())];               // op r/m16, imm16
        case 4: return [0x83, ...rm(code), random() & 255];                 // op r/m16, imm8
        default: return [code << 3 | 5, ...u16(random())];                  // op AX, imm16
    }
}
function move() {
    switch(random() % 8) {
        case 7: return [pick([0x2E, 0x26, 0x36]), 0x8B, ...memory(dst())];   // MOV r16, CS:/ES:/SS:m (reads)
        case 0: return [0x89, ...rm(any())];                                // MOV r/m16, r16
        case 1: return [0x8B, ...rm_source(dst())];                         // MOV r16, r/m16
        case 2: return [0xB8 | dst(), ...u16(random())];                    // MOV r16, imm16
        case 3: return [0xC7, ...rm(0), ...u16(random())];                  // MOV r/m16, imm16
        case 4: return [0x8D, ...memory(dst())];                            // LEA r16, m
        case 5: return [0x87, ...random() % 3 ? [rr(dst(), dst())] : memory(dst())];  // XCHG r16, r/m16
        default: return [0x88, ...rm(any())];                               // MOV r/m8, r8
    }
}
function unary() {
    switch(random() % 6) {
        case 0: return [0x40 | dst()];                                      // INC r16
        case 1: return [0x48 | dst()];                                      // DEC r16
        case 2: return [0xF7, ...rm(2 + (random() & 1))];                   // NOT/NEG r/m16
        case 3: return [0xFF, ...rm(random() & 1)];                         // INC/DEC r/m16
        case 4: return [0x85, ...rm_source(any())];                         // TEST r/m16, r16
        default: return [pick([0x98, 0x99, 0xF8, 0xF9, 0xF5, 0x9E, 0x9F])]; // CBW CWD CLC STC CMC SAHF LAHF
    }
}
function wide() {
    switch(random() % 8) {
        case 7: return [0xB9, ...u16(1 + random() % 0xFFFF), 0x31, 0xD2, 0xF7, 0xF1]; // MOV CX, n; XOR DX, DX; DIV CX
        case 0: return [0xF7, ...rm_source(4 + (random() & 1))];            // MUL/IMUL r/m16 (DX:AX)
        case 1: return [0x0F, 0xAF, ...rm_source(dst())];                   // IMUL r16, r/m16
        case 2: return [0x6B, ...rm_source(dst()), random() & 255];         // IMUL r16, r/m16, imm8
        case 3: return [0xD1, ...rm(pick([0, 1, 2, 3, 4, 5, 7]))];          // shifts and rotates by 1
        case 4: return [0xC1, ...rm(pick([0, 1, 4, 5, 7])), random() & 31]; // by imm8
        case 5: return [0x0F, pick([0xB6, 0xBE]), ...rm_source(dst())];     // MOVZX/MOVSX r16, r/m8
        default: return [0x0F, 0x40 | random() & 15, ...rm_source(dst())]; // CMOVcc r16, r/m16
    }
}
// PUSHF; POP WORD [disp16]: FLAGS where the comparison sees them
const capture = () => [0x9C, 0x8F, 0x06, ...u16(random() & 0xFFFE)];
function stack() {
    switch(random() % 7) {
        case 4: return [0x66, 0x50 | any(), ...simple(), 0x66, 0x58 | dst()];                      // PUSH r32 ... POP r32
        case 5: return [0x66, 0xFF, ...memory(6), 0x66, 0x8F, ...memory(0)];                       // PUSH m32; POP m32
        case 6: return [0xC8, ...u16(random() & 0x3E), 0, ...simple(), 0xC9];                     // ENTER n, 0; ...; LEAVE
        case 0: { const body = [0x50 | any(), ...simple(), 0x58 | dst()]; return body; }            // PUSH r16 ... POP r16
        case 1: return [0x6A, random() & 255, 0x58 | dst()];                                        // PUSH imm8; POP r16
        case 2: return [0x55, 0x89, 0xE5, ...simple(), 0xC9];                                       // PUSH BP; MOV BP, SP; ...; LEAVE
        default: return [0x68, ...u16(random()), 0xFF, ...memory(6)];                               // PUSH imm16; PUSH m16 (two pushes)
    }
}
function jumps() {
    const skip = simple();
    switch(random() % 3) {
        case 0: return [0x70 | random() & 15, skip.length, ...skip];                               // Jcc over an instruction
        case 1: return [0xEB, skip.length, ...skip];                                                // JMP over one
        default: {                                                                                  // MOV CX, n; L: op; LOOP L
            const loop = pick([[0x05, ...u16(random())], [0x42], [0x31, rr(3, 0)], [0x01, 0x06, ...u16(random() & 0xFFFE)]]);
            return [0xB9, ...u16(1 + random() % 4), ...loop, pick([0xE2, 0xE1, 0xE0]), -(loop.length + 2) & 255];
        }
    }
}
function segments() {
    // reload DS (or ES) with its own selector, through a register or the
    // stack, or from a far pointer at [disp16] (LES with the counter's
    // selector, LDS with the data's; 16- or 32-bit offsets)
    if(random() % 3 === 0) {
        const at = random() & 0xFFF0, les = random() & 1, wide = random() & 1;
        const offset = wide ? [0x66, 0xC7, 0x06, ...u16(at), ...u32(random())] : [0xC7, 0x06, ...u16(at), ...u16(random())];
        return [...offset, 0xC7, 0x06, ...u16(at + (wide ? 4 : 2)), ...u16(les ? SEL.counter : SEL.data),
            ...wide ? [0x66] : [], les ? 0xC4 : 0xC5, 0x06 | dst() << 3, ...u16(at)];
    }
    return pick([
        [0xB8, ...u16(SEL.data), 0x8E, 0xD8],     // MOV AX, data; MOV DS, AX
        [0x1E, 0x1F],                             // PUSH DS; POP DS
        [0x06, 0x07],                             // PUSH ES; POP ES
        [0x8C, 0xD8, 0x8E, 0xD8],                 // MOV AX, DS; MOV DS, AX
    ]);
}
// LODSB or LODSW, with DF clear or set (SI moves either way)
const lods = () => [pick([0xFC, 0xFD]), pick([0xAC, 0xAD]), 0xFC];
// CALL FAR to the routine in the second code segment, which RETFs (or
// with `far_pop`, RETF 2 after the caller pushed a word)
let far_pop = false;
// (real and virtual-8086 mode: the paragraph is patched per case, run)
const far = () => ({ bytes: [...far_pop ? [0x6A, random() & 127] : [], 0x9A, ...u16(FAR_IP), ...u16(SEL.far)], far_at: far_pop ? 5 : 3 });
/** The far routine: register operands, then RETF */
const far_routine = () => [...pick([[0x40 | dst()], [0x05, ...u16(random())], [0x31, rr(any(), dst())]]),
    ...far_pop ? [0xCA, 2, 0] : [0xCB]];
// At the last round (ES:[0] 1): MOV ES, a null selector, then MOV AX,
// ES:[BX], #GP(0) (CMP WORD ES:[0], 1; JNE over the rest)
const fault = () => [0x26, 0x83, 0x3E, 0, 0, 1, 0x75, 7, 0x31, 0xC0, 0x8E, 0xC0, 0x26, 0x8B, 0x07];
// At the last round (ES:[0] 1): CALL FAR 0xF8:0x100, or PUSH 0xF8; PUSH
// 0x100; RETF, whose selector is past the GDT's limit (kind y)
const far_fault = () => {
    const transfer = pick([[0x9A, 0x00, 0x01, 0xF8, 0x00], [0x68, 0xF8, 0x00, 0x68, 0x00, 0x01, 0xCB]]);
    return [0x26, 0x83, 0x3E, 0, 0, 1, 0x75, transfer.length, ...transfer];
};
// At the last round, an instruction IOPL governs in virtual-8086 mode
// (kind i: IOPL 0, #GP)
const iopl = () => [0x26, 0x83, 0x3E, 0, 0, 1, 0x75, 1, pick([0x9C, 0x9D, 0xFA, 0xFB])];
// MOV AX, ES:[0]; MOV FS:[linear address of the imm16 below], AX (67, A3);
// ADD AX, imm16 (an object: program() records where the address goes)
const smc = () => ({ bytes: [0x26, 0xA1, 0, 0, 0x64, 0x67, 0xA3, 0, 0, 0, 0, 0x05, ...u16(random())], address_at: 7, target_at: 12 });
// one instruction that leaves SP alone
function simple() { return pick([alu, move, unary])(); }
function instruction() {
    const kinds = { a: [alu, move, unary], m: [move, alu], s: [stack], j: [jumps], g: [segments], x: [wide], f: [far, alu], l: [lods, move],
        z: [fault, alu, move], c: [smc, alu, move], i: [iopl, alu, move, unary], y: [far_fault, far, alu] }[only];
    return pick(kinds || [alu, alu, move, move, unary, wide, stack, jumps, segments, far, lods, smc])();
}
function program() {
    const body = only === "k" ? [0xEB, 0x01, pick([0x9C, 0x9D, 0xFA, 0xFB]), 0xEB, 0xFD] : [], fixups = [];
    for(let k = 0; k < 24; k++) {
        const next = instruction();
        if(Array.isArray(next)) body.push(...next);
        else {
            if(next.far_at !== undefined) fixups.push({ at: body.length + next.far_at, far: true });
            else fixups.push({ at: body.length + next.address_at, target: body.length + next.target_at });
            body.push(...next.bytes);
        }
        if(k % 4 === 3 && !iopl0) body.push(...capture());
    }
    // a call of a subroutine after the loop
    const call_at = body.length;
    body.push(0xE8, 0, 0);
    // DEC WORD ES:[0]; JNZ top; HLT; the subroutine: an instruction, RET
    const tail = [0x26, 0xFF, 0x0E, 0, 0];
    const jnz = -(body.length + tail.length + 4);
    const code = [...body, ...tail, 0x0F, 0x85, ...u16(jnz), 0xF4];
    // (register operands only: a memory write could hit its return address)
    const subroutine = code.length;
    code.push(...pick([[random() & 0x38 | 1, rr(any(), dst())], [0x40 | dst()], [0xB8 | dst(), ...u16(random())]]), 0xC3);
    // (rel16 from the call's next instruction)
    const rel = subroutine - (call_at + 3);
    code[call_at + 1] = rel & 255; code[call_at + 2] = rel >> 8 & 255;
    code.fixups = fixups;
    return code;
}

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20,
        ir_sync_publication: true,
        ...compiled ? { jit_switches: { x64_page_prot16: 1, x64_page_v86: 1, x64_block_count: 0, x64_legacy_heat: 2000,
            x64_legacy_recompile_misses: 64, ...jit_switches_from_env() } } : {},
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
    const gdt = cpu.gdtr_offset[0] >>> 0;
    if(!paragraphs) {
        cpu.mem8.set(descriptor(DATA, 0x93), gdt + SEL.data);
        cpu.mem8.set(descriptor(FAR - FAR_IP, 0x9B), gdt + SEL.far);
        // (prot16ss32: a 32-bit stack, SS.B set)
        cpu.mem8.set(descriptor(STACK, 0x93, MODE === "prot16ss32" ? 0x40 : 0), gdt + SEL.stack);
        cpu.mem8.set(descriptor(COUNTER, 0x93), gdt + SEL.counter);
        cpu.gdtr_size[0] = SEL.far + 7;
    }
    if(MODE === "v86") {
        // A 32-bit TSS (ESP0, SS0 the flat data segment; no I/O bitmap) in
        // TR, and vector 13 an interrupt gate to HLT
        const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        cpu.mem8.fill(0, V86_TSS, V86_TSS + 0x68);
        view.setUint32(V86_TSS + 4, V86_STACK0, true);
        view.setUint16(V86_TSS + 8, 0x10, true);
        view.setUint16(V86_TSS + 0x66, 0x68, true);
        cpu.mem8.set([0x67, 0, V86_TSS & 255, V86_TSS >> 8 & 255, V86_TSS >> 16 & 255, 0x8B, 0, V86_TSS >>> 24], gdt + TSS_SELECTOR);
        cpu.gdtr_size[0] = TSS_SELECTOR + 7;
        cpu.sreg[6] = TSS_SELECTOR; cpu.segment_offsets[6] = V86_TSS; cpu.segment_limits[6] = 0x67; cpu.tss_size_32[0] = 1;
        cpu.mem8[V86_HANDLER] = 0xF4;
        const gate = (cpu.idtr_offset[0] >>> 0) + 13 * 8;
        cpu.mem8.set([V86_HANDLER & 255, V86_HANDLER >> 8 & 255, 0x08, 0, 0, 0x8E, V86_HANDLER >> 16 & 255, V86_HANDLER >>> 24], gate);
    }
    return { vm, cpu, e, compiled };
}

async function run(m, code, init, c, split) {
    const { vm, cpu, e } = m;
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    // A fresh code page per case (mem8.set bypasses code-write detection),
    // the code segment based so that its first byte is at IP 0x840 less
    // `split` (then it straddles the page before)
    const page = CODE + c * 0x2000 + (split ? 0x1000 : 0);
    const start = page - split, base = page - IP;
    // (the far routine: a fresh page too)
    const far_page = FAR + c * 0x1000;
    if(!paragraphs) {
        cpu.mem8.set(descriptor(base, 0x9B), (cpu.gdtr_offset[0] >>> 0) + SEL.code);
        cpu.mem8.set(descriptor(far_page - FAR_IP, 0x9B), (cpu.gdtr_offset[0] >>> 0) + SEL.far);
    }
    cpu.mem8.set(init.far, far_page);
    // (the self-modifying writes' linear addresses; in real and virtual-8086
    // mode the far routine's paragraph)
    const placed = Uint8Array.from(code);
    for(const { at, target, far } of code.fixups) {
        if(far) { if(paragraphs) placed.set(u16(far_page - FAR_IP >> 4), at); }
        else placed.set(u32(start + target), at);
    }
    cpu.mem8.set(placed, start);
    cpu.mem8.set(init.data, DATA);
    cpu.mem8.set(init.stack, STACK);
    if(MODE === "v86") cpu.mem8.fill(0, V86_STACK0 - 64, V86_STACK0);
    cpu.mem8.fill(0, COUNTER, COUNTER + 16);
    view.setUint16(COUNTER, ITERATIONS, true);
    view.setUint32(0x608, 0, true);
    // MOV AX, sel; MOV SS, AX; MOV ESP, 0xFFF0; MOV AX, data; MOV DS, AX;
    // MOV AX, counter; MOV ES, AX; MOV EAX, init; JMP FAR code:IP
    const prologue = [0x66, 0xB8, ...u16(SEL.stack), 0x8E, 0xD0, 0xBC, ...u32(0xFFF0),
        0x66, 0xB8, ...u16(SEL.data), 0x8E, 0xD8, 0x66, 0xB8, ...u16(SEL.counter), 0x8E, 0xC0,
        0xB8, ...u32(init.regs[0]), 0xEA, ...u32(IP - split), ...u16(SEL.code)];
    if(!paragraphs) cpu.mem8.set(prologue, PROLOGUE);
    // The prologue is 32-bit code: back to the BIOS's flat segments (the
    // last case halted in its 16-bit code segment; FS the flat alias the
    // self-modifying code writes through)
    for(const [r, selector, access] of [[0, 0x10, 0x93], [1, 0x08, 0x9B], [2, 0x10, 0x93], [3, 0x10, 0x93], [4, 0x10, 0x93]]) {
        cpu.sreg[r] = selector; cpu.segment_offsets[r] = 0; cpu.segment_limits[r] = -1;
        cpu.segment_access_bytes[r] = access; cpu.segment_is_null[r] = 0;
    }
    cpu.is_32[0] = 1; cpu.stack_size_32[0] = 1;
    cpu.reg32.set(init.regs);
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = PROLOGUE;
    if(paragraphs) {
        // Real mode (CR0.PE and PG clear) or virtual-8086 mode (EFLAGS.VM,
        // IOPL 3, CPL 3; paging off), the segments loaded as there, and the
        // program entered directly
        for(const [r, paragraph] of [[0, SEL.counter], [1, base >> 4], [2, SEL.stack], [3, SEL.data], [4, 0], [5, 0]]) {
            cpu.sreg[r] = paragraph; cpu.segment_offsets[r] = paragraph << 4; cpu.segment_limits[r] = 0xFFFF;
            cpu.segment_access_bytes[r] = r === 1 ? 0x9B : 0x93; cpu.segment_is_null[r] = 0;
        }
        cpu.is_32[0] = 0; cpu.stack_size_32[0] = 0;
        cpu.cr[0] = MODE === "real" ? cpu.cr[0] & ~0x80000001 : (cpu.cr[0] | 1) & ~0x80000000;
        cpu.protected_mode[0] = MODE === "real" ? 0 : 1;
        cpu.cpl[0] = MODE === "real" ? 0 : 3;
        cpu.flags[0] = MODE === "real" ? 2 : 0x20000 | (iopl0 ? 0 : 0x3000) | 2;
        cpu.instruction_pointer[0] = start;
    }
    e.update_state_flags();
    e.full_clear_tlb();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    const activations = e.x64_page_stat(13), native = e.x64_page_stat(1), steps = e.x64_page_stat(4);
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${m.compiled ? "page tier" : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `counter ${view.getUint16(COUNTER, true)} code ${Buffer.from(code).toString("hex")}`);
        }
        await sleep(0);
    }
    await vm.stop();
    const count = new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0;
    m.entries = e.x64_page_stat(13) - activations;
    m.native = e.x64_page_stat(1) - native;
    m.interpreted = Math.max(0, count - m.native - (e.x64_page_stat(4) - steps));
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        eip: cpu.instruction_pointer[0] >>> 0,
        eflags: e.get_eflags() >>> 0,
        sregs: Array.from(cpu.sreg.subarray(0, 6)),
        data: Buffer.from(cpu.mem8.subarray(DATA, DATA + 0x10000)).toString("base64"),
        stack: Buffer.from(cpu.mem8.subarray(STACK, STACK + 0x10000)).toString("base64"),
        counter: view.getUint16(COUNTER, true),
        count,
        // (boot.bin's fault stubs write the vector, and the faulting EIP
        // after it, at [0x608] through DS: the data segment's then)
        status: view.getUint32(0x608, true) || view.getUint32(DATA + 0x608, true),
        fault_eip: view.getUint32(DATA + 0x60C, true),
        // (virtual-8086 mode: the #GP handler's frame)
        ...MODE === "v86" ? { ring0: Buffer.from(cpu.mem8.subarray(V86_STACK0 - 64, V86_STACK0)).toString("hex") } : {},
    };
}

const reference = await machine(false), compiled = await machine(true);
assert.equal(compiled.e.x64_page_stat(paragraphs ? 44 : 42), 1, paragraphs ? "x64_page_v86 is on" : "x64_page_prot16 is on");
// (16-bit protected-mode compiles, or real-mode and virtual-8086 ones)
const compile_stat = paragraphs ? 45 : 43;
let failures = 0, uncompiled = 0, retired = 0, native = 0;
for(let c = 0; c < cases; c++) {
    far_pop = (random() & 1) === 1;
    const code = program();
    const init = {
        regs: Array.from({ length: 8 }, () => random()),
        data: Uint8Array.from({ length: 0x10000 }, () => random() & 255),
        stack: Uint8Array.from({ length: 0x10000 }, () => random() & 255),
        far: far_routine(),
    };
    init.regs[4] = 0xFFF0;
    // (a 32-bit stack: LEAVE sets ESP from all of EBP, whose random high
    // half would leave the stack segment)
    if(MODE === "prot16ss32") init.regs[5] &= 0xFFFF;
    const split = straddle ? 4 + random() % Math.max(1, code.length - 8) : 0;
    const expected = await run(reference, code, init, c, split), actual = await run(compiled, code, init, c, split);
    if(process.env.FUZZ_DEBUG) console.log(`case ${c}: count ${expected.count} entries ${compiled.entries} native ${compiled.native} ` +
        `interpreted ${compiled.interpreted} (compiles ${compiled.e.x64_page_stat(compile_stat)}, retries ${compiled.e.x64_page_stat(2)}, ` +
        `unknown exits ${compiled.e.x64_page_stat(3)}, steps ${compiled.e.x64_page_stat(4)}) status ${expected.status.toString(16)} eip ${expected.eip.toString(16)} eflags ${expected.eflags.toString(16)} ` +
        `code ${Buffer.from(code).toString("hex")}`);
    retired += actual.count;
    native += compiled.native;
    if(!compiled.entries && only !== "k") {
        uncompiled++;
        console.log(`case ${c}: no page function ran (${actual.count} instructions, eip ${actual.eip.toString(16)}, status ${actual.status.toString(16)}, ` +
            `faulting IP ${actual.fault_eip.toString(16)})\n` +
            `  code ${Buffer.from(code).toString("hex")}`);
    }
    for(const key of Object.keys(expected)) {
        try { assert.deepEqual(actual[key], expected[key]); }
        catch{
            failures++;
            const show = v => typeof v === "string" ? `(${v.length} base64 chars)` : JSON.stringify(v);
            let where = "";
            if(key === "data" || key === "stack") {
                const a = Buffer.from(actual[key], "base64"), b = Buffer.from(expected[key], "base64");
                const at = a.findIndex((x, i) => x !== b[i]);
                where = ` first difference at ${at.toString(16)}: ${a[at]} vs ${b[at]}`;
            }
            console.log(`case ${c}: ${key} differs${where}\n  code ${Buffer.from(code).toString("hex")}\n  expected ${show(expected[key])}\n  actual   ${show(actual[key])}`);
            break;
        }
    }
}
const compiles = compiled.e.x64_page_stat(compile_stat);
await reference.vm.destroy(); await compiled.vm.destroy();
const percent = share => `${(100 * share).toFixed(1)}%`;
const coverage = `${percent(native / retired)} of the instructions ran natively, ${compiles} 16-bit page compiles`;
// (kind k faults in cold code: interpreted only)
if(failures || uncompiled || only !== "k" && (compiles === 0 || native * 2 < retired)) {
    console.log(`FAIL: ${failures}/${cases} cases differ, no page function ran in ${uncompiled}; ${coverage}`);
    process.exit(1);
}
console.log(`PASS: ${cases} random 16-bit programs (${MODE}) in the page tier match the interpreter; ${coverage}`);
process.exit(0);
