#!/usr/bin/env node
// What compiled code knows about XMM registers within a block (the x64 page
// tier's Emitter::xmm_clean, IR Tier-0's Page::xmm_clean until P7.5: lanes
// neither NaN nor denormal, whose checks native SSE
// floating point then skips, see x86tpl::native_fp). Each sequence makes a wrong
// fact visible: a consumer skips the check of a denormal, and MXCSR.DE is
// missing. The sequences run hot, each iteration starting with LDMXCSR and
// MOVAPS of every register (so that a later iteration does not set the flag),
// and must leave the interpreter's XMM registers and MXCSR.
//
//   node tests/ir/differential/sse_fp_tracking.mjs [wasm]
// (TRACKING_DEBUG=1 prints each sequence's MXCSR on both sides)
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "../../rust/compiled_arms.mjs";

const wasm = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, DONE = 0x600, ITERATIONS = 100000;

// singles and doubles: one, the smallest normal and the next, a denormal
const ONE = 0x3F800000, MIN = 0x00800000, MIN1 = 0x00800001, DENORMAL = 0x00000003;
const D_ONE = [0, 0x3FF00000], D_MIN = [0, 0x00100000], D_MIN1 = [1, 0x00100000], D_DENORMAL = [3, 0];
const ones = [ONE, ONE, ONE, ONE];
const d_ones = [...D_ONE, ...D_ONE];
const rr = (r, m) => 0xC0 | r << 3 | m;

// [name, registers xmm0..3 (each four words), code]
const SEQUENCES = [
    ["a sum or difference may be an exact denormal", [[MIN1, MIN1, MIN1, MIN1], [MIN, MIN, MIN, MIN], ones, ones],
        [0x0F, 0x5C, rr(0, 1), 0x0F, 0x58, rr(2, 0)]],                                   // SUBPS 0, 1; ADDPS 2, 0
    ["(double precision)", [[...D_MIN1, ...D_MIN1], [...D_MIN, ...D_MIN], d_ones, d_ones],
        [0x66, 0x0F, 0x5C, rr(0, 1), 0x66, 0x0F, 0x58, rr(2, 0)]],
    ["a scalar form checks lane 0 only", [ones, [ONE, DENORMAL, ONE, ONE], ones, ones],
        [0xF3, 0x0F, 0x58, rr(0, 1), 0x0F, 0x58, rr(2, 1)]],                             // ADDSS 0, 1; ADDPS 2, 1
    ["(double precision)", [d_ones, [...D_ONE, ...D_DENORMAL], d_ones, d_ones],
        [0xF2, 0x0F, 0x58, rr(0, 1), 0x66, 0x0F, 0x58, rr(2, 1)]],
    ["a shuffle keeps what it moves", [ones, [ONE, ONE, DENORMAL, ONE], ones, ones],
        [0x0F, 0x59, rr(0, 0), 0x0F, 0xC6, rr(0, 1), 0xE4, 0x0F, 0x58, rr(2, 0)]],      // MULPS 0, 0; SHUFPS 0, 1; ADDPS 2, 0
    ["(UNPCKHPD)", [d_ones, [...D_ONE, ...D_DENORMAL], d_ones, d_ones],
        [0x66, 0x0F, 0x59, rr(0, 0), 0x66, 0x0F, 0x15, rr(0, 1), 0x66, 0x0F, 0x58, rr(2, 0)]],
    ["(UNPCKLPS)", [ones, [ONE, DENORMAL, ONE, ONE], ones, ones],
        [0x0F, 0x59, rr(0, 0), 0x0F, 0x14, rr(0, 1), 0x0F, 0x58, rr(2, 0)]],
    ["a copy is what it copies", [ones, [ONE, ONE, ONE, DENORMAL], ones, ones],
        [0x0F, 0x59, rr(3, 3), 0x0F, 0x28, rr(3, 1), 0x0F, 0x58, rr(2, 3)]],             // MULPS 3, 3; MOVAPS 3, 1; ADDPS 2, 3
    ["(MOVAPS to a register)", [ones, [ONE, ONE, ONE, DENORMAL], ones, ones],
        [0x0F, 0x59, rr(3, 3), 0x0F, 0x29, rr(1, 3), 0x0F, 0x58, rr(2, 3)]],            // MOVAPS xmm3, xmm1 (0F 29)
    ["a scalar move replaces lane 0", [ones, [DENORMAL, ONE, ONE, ONE], ones, ones],
        [0x0F, 0x59, rr(0, 0), 0xF3, 0x0F, 0x10, rr(0, 1), 0x0F, 0x58, rr(2, 0)]],      // MULPS 0, 0; MOVSS 0, 1; ADDPS 2, 0
    ["a conversion checks the lanes it reads", [ones, [ONE, ONE, DENORMAL, ONE], ones, ones],
        [0x0F, 0x5A, rr(0, 1), 0x0F, 0x58, rr(2, 1)]],                                   // CVTPS2PD 0, 1; ADDPS 2, 1
    ["a comparison checks lane 0", [ones, [ONE, DENORMAL, ONE, ONE], ones, ones],
        [0x0F, 0x2F, rr(0, 1), 0x0F, 0x58, rr(2, 1)]],                                   // COMISS 0, 1; ADDPS 2, 1
    ["a scalar result keeps the other lanes", [[ONE, DENORMAL, ONE, ONE], ones, ones, ones],
        [0xF3, 0x0F, 0x59, rr(0, 1), 0x0F, 0x58, rr(2, 0)]],                             // MULSS 0, 1; ADDPS 2, 0
    ["MAXPS of clean operands", [[MIN1, MIN1, MIN1, MIN1], [MIN, MIN, MIN, MIN], ones, ones],
        [0x0F, 0x5C, rr(0, 1), 0x0F, 0x5F, rr(2, 0)]],                                   // SUBPS 0, 1; MAXPS 2, 0
    ["XORPS of a register with itself", [[DENORMAL, DENORMAL, DENORMAL, DENORMAL], ones, ones, ones],
        [0x0F, 0x57, rr(0, 0), 0x0F, 0x58, rr(2, 0), 0x0F, 0x58, rr(3, 1)]],
];

async function machine(options) {
    const vm = new V86({
        graphics_adapter: "bochs_vga", wasm_path: wasm, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
        ...options, disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false,
    });
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const word = a => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
    vm.run();
    while(word(0x500) !== 0xCAFE) await sleep(1);
    await vm.stop();
    return { vm, word };
}

async function run({ vm, word }, registers, code, page) {
    const cpu = vm.v86.cpu;
    const words = registers.flat();
    vm.write_memory(new Uint8Array(Uint32Array.from([...words, 0x1FA0]).buffer), DATA);
    // CR4.OSFXSR; ECX iterations; loop: LDMXCSR; MOVAPS xmm0..3; the code; DEC ECX; JNZ
    const p = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0, 0xB9, ...u32(ITERATIONS)];
    const top = p.length;
    p.push(0x0F, 0xAE, 0x15, ...u32(DATA + 64));
    for(let k = 0; k < 4; k++) p.push(0x0F, 0x28, 0x05 | k << 3, ...u32(DATA + 16 * k));
    p.push(...code, 0x49, 0x0F, 0x85);
    p.push(...u32(top - (p.length + 4)));
    p.push(0x0F, 0xAE, 0x1D, ...u32(DATA + 80), 0xC7, 0x05, ...u32(DONE), ...u32(0xCAFE), 0xF4, 0xEB, 0xFD);
    const base = CODE + page * 0x1000;
    vm.write_memory(Uint8Array.from(p), base);
    vm.write_memory(new Uint8Array(4), DONE);
    cpu.reg32[4] = 0x8000; cpu.instruction_pointer[0] = base; cpu.in_hlt[0] = 0;
    vm.run();
    while(word(DONE) !== 0xCAFE) await sleep(1);
    await vm.stop();
    return { mxcsr: word(DATA + 80), xmm: Array.from(cpu.reg_xmm32s.subarray(0, 16), v => v >>> 0) };
}

const reference = await machine({ disable_jit: true });
const arms = [];
for(const arm of COMPILED_ARMS) arms.push({ ...arm, m: await machine(arm.options) });
try {
    for(const [n, [name, registers, code]] of SEQUENCES.entries()) {
        const expected = await run(reference, registers, code, n);
        for(const arm of arms) {
            const before = compiled_activations(arm.m.vm.v86.cpu.wm.exports);
            const actual = await run(arm.m, registers, code, n);
            const label = `${name} (${Buffer.from(code).toString("hex")}) on ${arm.label}`;
            assert(compiled_activations(arm.m.vm.v86.cpu.wm.exports) !== before, label + ": not compiled");
            if(process.env.TRACKING_DEBUG) console.log(label, expected.mxcsr.toString(16), actual.mxcsr.toString(16));
            assert.equal(actual.mxcsr.toString(16), expected.mxcsr.toString(16), label + ": MXCSR");
            assert.deepEqual(actual.xmm, expected.xmm, label + ": XMM");
        }
        assert(expected.mxcsr & 2 || name.startsWith("XORPS"), `${name}: the sequence should raise DE`);
    }
    console.log(`PASS: ${SEQUENCES.length} sequences on what compiled code knows about XMM registers match the interpreter`);
}
finally {
    await reference.vm.destroy();
    for(const arm of arms) await arm.m.vm.destroy();
}
