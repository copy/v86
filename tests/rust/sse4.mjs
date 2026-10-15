// SSE4.1 and SSE4.2 integer forms in the 32-bit engines (docs/simd-xsave-plan.md
// 7.2, 7.3, P4b) against a model of the SDM's pseudocode written here
// (tests/rust/sse4_model.mjs, independent of src/rust/cpu/simd_int.rs):
// register and memory sources, the destination as the source and as XMM0
// (BLENDV's mask), every imm8 of the blends, INSERTPS and MPSADBW, the
// element selection of PEXTR*/PINSR* to and from registers and memory, the
// flags of PTEST and the exceptions: #UD without the feature, with CR0.EM,
// without CR4.OSFXSR, with LOCK or an F2/F3 prefix and for MOVNTDQA from a
// register, #NM with CR0.TS, #GP(0) for a misaligned m128 (none for the
// narrow operands) and #PF, each without effect. SSE4.2: PCMPESTRI/M and
// PCMPISTRI/M for every imm8 (ECX or XMM0 and the flags; explicit lengths
// zero, negative, the most negative, beyond the register; an unaligned m128;
// the whole m128 read though a string ends early), CRC32 from 8-, 16- and
// 32-bit registers (AH-BH too) and memory (flags kept, no XMM state checks),
// and POPCNT, which has its own CPUID bit. Every case runs in the
// interpreter, then hot under the page tier.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { Fp, compare_strings, crc32, extract, get, insert, insertps, ptest, round_lane, set, sse4_38, sse4_3a } from "./sse4_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const hex = bytes => Buffer.from(bytes).toString("hex");
const CODE = 0x100000, DEST = 0x200000, SOURCE = 0x210000, MASK = 0x220000, OUT = 0x230000, FAULT = 0x24F000, SKIP = 0x24F100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x2F0000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// Operand data: random bytes, and lanes of edge values (8 kinds)
const make_data = seed => {
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const a = new Uint8Array(512 * 16), v = new DataView(a.buffer);
    const edges = {
        1: [0x00, 0x01, 0x7F, 0x80, 0x81, 0xFE, 0xFF, 0x40],
        2: [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8001, 0xFFFF, 0x4000, 0xC000],
        4: [0, 1, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0x0000FFFF, 0xFFFF0000],
    };
    for(let n = 0; n < 512; n++)
    {
        const kind = n % 8;
        for(let i = 0; i < 16; i++)
        {
            if(kind < 3) a[n * 16 + i] = random();
            else if(kind === 3) a[n * 16 + i] = edges[1][random() & 7];
            else if(kind === 4 && i % 2 === 0) v.setUint16(n * 16 + i, edges[2][random() & 7], true);
            else if(kind === 5 && i % 4 === 0) v.setUint32(n * 16 + i, edges[4][random() & 7], true);
            // (equal halves: PCMPEQQ, PHMINPOSUW ties)
            else if(kind === 6) a[n * 16 + i] = i < 8 ? random() & 3 : a[n * 16 + i - 8];
            else if(kind === 7) a[n * 16 + i] = (random() & 1) * 0xFF;
        }
    }
    return a;
};
const destinations = make_data(0x5EED1234), sources = make_data(0x0BADC0DE), masks = make_data(0x13579BDF);
// Strings for PCMPxSTRx: a small alphabet (so that elements match and fall in
// ranges), bytes of either sign and words; a zero element ends an implicit
// string (none in a fifth of them)
const make_strings = seed => {
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const a = new Uint8Array(512 * 16);
    const alphabets = [[0x61, 0x62, 0x63, 0x64], [0x41, 0x61, 0x7F, 0x80, 0xFF, 0x01], [0x61, 0x62]];
    for(let n = 0; n < 512; n++)
    {
        const alphabet = alphabets[n % 3], end = random() % 20;
        for(let i = 0; i < 16; i++) a[n * 16 + i] = alphabet[random() % alphabet.length];
        // (as words: the end in either byte of an element, or both)
        if(end < 16) a[n * 16 + end] = 0;
        if(end < 16 && n % 4 === 0) a[n * 16 + (end ^ 1)] = 0;
    }
    return a;
};
const needles = make_strings(0x600DF00D), haystacks = make_strings(0xFEEDFACE);
// explicit lengths (EAX, EDX): within, at and beyond the elements, negative, the extremes
const LENGTHS = [0, 1, 2, 3, 7, 8, 9, 15, 16, 17, 100, -1, -2, -7, -8, -9, -16, -17, 0x7FFFFFFF, -0x80000000, -0x7FFFFFFF];

const LOAD = [0xF3, 0x0F, 0x6F], STORE = [0xF3, 0x0F, 0x7F];
const absolute = (r, a) => [0x05 | r << 3, ...u32(a)];
const mov_r32 = (r, v) => [0xB8 | r, ...u32(v)];
const store_r32 = (r, a) => [0x89, 0x05 | r << 3, ...u32(a)];
const PUSHF_STORE = a => [0x9C, 0x58, 0xA3, ...u32(a)];
/** 66 0F map op ModRM(reg, rm or [address]) imm8 */
const encode = (map, op, reg, rm, address, imm8, prefixes = []) => [...prefixes, 0x66, 0x0F, map, op,
    ...(address === undefined ? [0xC0 | reg << 3 | rm] : absolute(reg, address)), ...(imm8 === undefined ? [] : [imm8])];
const OSFXSR = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0]; // CR4 |= OSFXSR | OSXMMEXCPT
const NO_OSFXSR = [0x0F, 0x20, 0xE0, 0x25, ...u32(~0x200 >>> 0), 0x0F, 0x22, 0xE0];
const CLTS = [0x0F, 0x06];
const SET_CR0 = bits => [0x0F, 0x20, 0xC0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xC0];
const CLEAR_CR0 = bits => [0x0F, 0x20, 0xC0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xC0];

// The forms of 66 0F 38 with simd_int::sse4 semantics: [op, name, memory bytes]
const BINARY = [[0x10, "pblendvb"], [0x14, "blendvps"], [0x15, "blendvpd"], [0x20, "pmovsxbw", 8], [0x21, "pmovsxbd", 4],
    [0x22, "pmovsxbq", 2], [0x23, "pmovsxwd", 8], [0x24, "pmovsxwq", 4], [0x25, "pmovsxdq", 8], [0x28, "pmuldq"], [0x29, "pcmpeqq"],
    [0x2B, "packusdw"], [0x30, "pmovzxbw", 8], [0x31, "pmovzxbd", 4], [0x32, "pmovzxbq", 2], [0x33, "pmovzxwd", 8],
    [0x34, "pmovzxwq", 4], [0x35, "pmovzxdq", 8], [0x37, "pcmpgtq"], [0x38, "pminsb"], [0x39, "pminsd"], [0x3A, "pminuw"],
    [0x3B, "pminud"], [0x3C, "pmaxsb"], [0x3D, "pmaxsd"], [0x3E, "pmaxuw"], [0x3F, "pmaxud"], [0x40, "pmulld"],
    [0x41, "phminposuw"]].map(([op, name, bytes = 16]) => ({ op, name, bytes }));
// 66 0F 3A with imm8 between XMM operands
const IMMEDIATE = [[0x0C, "blendps"], [0x0D, "blendpd"], [0x0E, "pblendw"], [0x21, "insertps"], [0x42, "mpsadbw"]];
const EXTRACT = [[0x14, "pextrb", 1], [0x15, "pextrw", 2], [0x16, "pextrd", 4], [0x17, "extractps", 4]];
const INSERT = [[0x20, "pinsrb", 1], [0x22, "pinsrd", 4]];
const GPRS = [0, 1, 2, 3, 5, 6, 7]; // (not ESP)
// The forms with page tier templates (P4b part 4): one Wasm SIMD operation (66 0F
// 38) and the blends with imm8 (66 0F 3A); PBLENDVB, BLENDVPS and BLENDVPD
// (P5 part 5; IR Tier-0, deleted in P7.5, also had PMULDQ's)
const TEMPLATED_38 = [0x10, 0x14, 0x15, 0x29, 0x2B, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40];
const TEMPLATED_3A = [0x0C, 0x0D, 0x0E];
// PCMPESTRM, PCMPESTRI, PCMPISTRM, PCMPISTRI
const STRINGS = [[0x60, "pcmpestrm"], [0x61, "pcmpestri"], [0x62, "pcmpistrm"], [0x63, "pcmpistri"]];
/** CRC32 r32, r/m8 (F2 0F 38 F0), r/m16 (66 F2 0F 38 F1), r/m32 (F2 0F 38 F1) */
const crc32_form = (bytes, reg, rm, address) => [...bytes === 2 ? [0x66] : [], 0xF2, 0x0F, 0x38, bytes === 1 ? 0xF0 : 0xF1,
    ...(address === undefined ? [0xC0 | reg << 3 | rm] : absolute(reg, address))];
/** POPCNT r16/r32, r/m16/r/m32 */
const popcnt_form = (bytes, reg, rm, address) => [...bytes === 2 ? [0x66] : [], 0xF3, 0x0F, 0xB8,
    ...(address === undefined ? [0xC0 | reg << 3 | rm] : absolute(reg, address))];
// flags before: OF, SF, AF, CF (0x7F + 1, STC) or ZF, PF (XOR EAX, EAX)
const FLAGS_BEFORE = [[[0xB0, 0x7F, 0x04, 0x01, 0xF9], 0x891], [[0x31, 0xC0], 0x44]];

const machines = [];
async function run(vm, program, warm, interpreter, label)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    // (the page tier's step counts are the hot run's: x64_page_steps)
    else e["x64_page_steps_freeze"]();
    vm.write_memory(Uint8Array.from(program), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 20000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && compiled_activations(e) === start)
    {
        assert(performance.now() < deadline, `program/JIT timeout (${label}: ${program.length} bytes, done ${word(vm, 0x600) === 0xCAFE}, compiled ${compiled_activations(e) - start})`);
        await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
// the body repeats until byte 0x604 is set, then halts after one more round
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it, the faulting EIP, CR2 and the error code, and skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58, 0xA3, ...u32(FAULT + 12));
    p.push(0xC7, 0x05, ...u32(FAULT), ...u32(vector));
    p.push(0x8B, 0x04, 0x24, 0xA3, ...u32(FAULT + 4));
    p.push(0x0F, 0x20, 0xD0, 0xA3, ...u32(FAULT + 8));
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true]];
const PROLOGUE = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS, ...CLEAR_CR0(4), ...OSFXSR];
/** Runs `program` on each machine of `set`: warm (compiled), then once more
 * cold; returns what `read` reads after each run (the cold run is mostly
 * interpreted: the program was rewritten) */
async function run_all(program, before = () => {}, set = machines, read = () => null)
{
    const results = [];
    for(const [i, vm] of set.entries())
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], i) => {
            const h = HANDLER + i * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(new Uint8Array(16), FAULT);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, loop([...PROLOGUE, ...program]), warm, vm === set[0], `machine ${i} ${warm ? "hot" : "one round"}`);
            results.push({ label: `machine ${i} ${warm ? "hot" : "one round"}`, data: read(vm) });
        }
    }
    return results;
}
/** Runs `program` on every machine; the results of OUT (`length` bytes) of
 * each run must agree; returns the interpreter's */
async function run_out(program, before, length, label)
{
    const results = await run_all(program, before, machines, vm => bytes(vm, OUT, length));
    for(const { label: run, data } of results)
    {
        for(let at = 0; at < length; at += 16)
        {
            if(!data.subarray(at, at + 16).every((b, k) => b === results[0].data[at + k]))
            {
                assert.fail(`${label} at ${at / 16}: ${run} ${hex(data.subarray(at, at + 16))}, interpreter ${hex(results[0].data.subarray(at, at + 16))}`);
            }
        }
    }
    return results[0].data;
}
async function create_machines(options = {})
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ...arm, ...options, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        set.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    return set;
}
/** The build has Wasm SIMD (the fallback build has no SIMD templates) */
const simd = vm => vm.v86.cpu.wm.exports["jit_wasm_simd_supported"]() !== 0;
/** The page tier (machine 1) ran a template for the form under test, whose
 * interpreter steps are keyed by its first two bytes, 66 0F; or stepped it
 * each round. A build without Wasm SIMD has no SIMD templates. Reset the
 * counts before the run (x64_page_steps_reset). */
function page_ran(name, templated, count)
{
    const page_steps = machines[1].v86.cpu.wm.exports["x64_page_steps"];
    const steps = page_steps(0x0F66);
    if(templated && simd(machines[1])) assert.ok(steps < count / 2, `${name}: the page tier template (${steps} steps)`);
    else assert.ok(steps >= count, `${name}: the page tier steps (${steps})`);
}
/** `faulting` raises `vector` at its first byte after `prologue` (the
 * handler skips it) in every run, and OUT holds `out` afterwards */
async function expect_fault(prologue, faulting, vector, { epilogue = [], before = () => {}, cr2, error_code, label, out, memory } = {})
{
    const at = CODE + PROLOGUE.length + prologue.length;
    const results = await run_all([...prologue, ...faulting, ...epilogue], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        before(vm);
    }, machines, vm => ({ fault: [0, 4, 8, 12].map(o => word(vm, FAULT + o)), out: bytes(vm, OUT, 16),
        memory: memory && bytes(vm, memory[0], memory[1].length) }));
    const name = label || hex(faulting);
    for(const { label: run, data } of results)
    {
        assert.deepEqual(data.fault.slice(0, 2), [vector, at], `${name} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(data.fault[2], cr2, `${name} (${run}): CR2`);
        if(error_code !== undefined) assert.equal(data.fault[3], error_code, `${name} (${run}): error code`);
        if(out) assert.equal(hex(data.out), hex(out), `${name} (${run}): destination kept`);
        if(memory) assert.equal(hex(data.memory), hex(memory[1]), `${name} (${run}): memory kept`);
    }
}
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};
const write_data = vm => {
    vm.write_memory(destinations, DEST);
    vm.write_memory(sources, SOURCE);
    vm.write_memory(masks, MASK);
};
let checks = 0;
try
{
    // Without SSE4.1 and SSE4.2: CPUID reports neither, every form is #UD
    const CPUID = [0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)];
    machines.push(...await create_machines({ cpu_features: ["SSSE3"] }));
    await run_all(CPUID);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 19 & 3, 0, "CPUID.1:ECX.SSE4_1/SSE4_2");
    for(const { op, name } of [...BINARY, { op: 0x17, name: "ptest" }, { op: 0x2A, name: "movntdqa" }])
    {
        await expect_fault([], encode(0x38, op, 1, undefined, SOURCE, undefined), 6, { label: `${name} without SSE4` });
    }
    for(const [op, name] of [...IMMEDIATE, ...EXTRACT, ...INSERT, [0x08, "roundps"], [0x0B, "roundsd"], [0x40, "dpps"], [0x41, "dppd"], ...STRINGS])
    {
        await expect_fault([], encode(0x3A, op, 1, 2, undefined, 0), 6, { label: `${name} without SSE4` });
    }
    for(const bytes of [1, 2, 4]) await expect_fault([], crc32_form(bytes, 1, 2), 6, { label: `crc32 (${bytes}) without SSE4.2` });
    // POPCNT has a CPUID bit of its own (always set), not SSE4.2's
    {
        const program = [...CPUID, 0xB8, ...u32(0xF0F00001), ...popcnt_form(4, 1, 0), 0x89, 0x0D, ...u32(OUT + 4)];
        const results = await run_all(program, () => {}, machines, vm => [word(vm, OUT), word(vm, OUT + 4), word(vm, FAULT)]);
        for(const { label, data: [ecx, count, fault] } of results)
        {
            assert.deepEqual([ecx >>> 23 & 1, count, fault], [1, 9, 0], `CPUID.1:ECX.POPCNT and POPCNT without SSE4.2 (${label})`);
        }
    }
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without SSE4.1/SSE4.2, CPUID reports neither and every form is #UD; POPCNT is there");

    // With SSE4.1 but not SSE4.2: PCMPGTQ, PCMPxSTRx and CRC32 are #UD, the SSE4.1 forms are not
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1"] }));
    await run_all(CPUID);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 19 & 3, 1, "CPUID.1:ECX.SSE4_1/SSE4_2");
    await expect_fault([], encode(0x38, 0x37, 1, 2), 6, { label: "pcmpgtq without SSE4.2" });
    for(const [op, name] of STRINGS) await expect_fault([], encode(0x3A, op, 1, 2, undefined, 0x0C), 6, { label: `${name} without SSE4.2` });
    for(const bytes of [1, 2, 4]) await expect_fault([], crc32_form(bytes, 1, 2), 6, { label: `crc32 (${bytes}) without SSE4.2` });
    {
        const results = await run_all([...encode(0x38, 0x3B, 1, 2), ...encode(0x3A, 0x0E, 1, 2, undefined, 3)], () => {}, machines, vm => word(vm, FAULT));
        for(const { label, data } of results) assert.equal(data, 0, `PMINUD and PBLENDW with SSE4.1 only (${label})`);
    }
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: with SSE4.1 only, CPUID reports it; PCMPGTQ, PCMPxSTRx and CRC32 are #UD, the SSE4.1 forms run");

    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2"] }));
    await run_all(CPUID);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 19 & 3, 3, "CPUID.1:ECX.SSE4_1/SSE4_2");

    // 66 0F 38 against the model. XMM0 (BLENDV's mask) is loaded first, then
    // the destination, then a register source: the operands may alias.
    const CASES = 64;
    let cases = 0;
    for(const { op, name, bytes: width } of BINARY)
    {
        const program = [];
        for(let n = 0; n < CASES; n++)
        {
            const dst = n & 7, src = n >> 3 & 7, memory = n >= CASES / 2;
            // a narrow memory operand needs no alignment
            const address = SOURCE + n * 16 + (width < 16 ? n & 7 : 0);
            program.push(...LOAD, ...absolute(0, MASK + n * 16), ...LOAD, ...absolute(dst, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(src, SOURCE + n * 16));
            program.push(...encode(0x38, op, dst, src, memory ? address : undefined));
            program.push(...STORE, ...absolute(dst, OUT + n * 16));
        }
        for(const vm of machines) vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(CASES * 16), OUT); }, CASES * 16, name);
        page_ran(name, TEMPLATED_38.includes(op), CASES);
        for(let n = 0; n < CASES; n++)
        {
            const dst = n & 7, src = n >> 3 & 7, memory = n >= CASES / 2;
            const registers = [masks.slice(n * 16, n * 16 + 16)];
            registers[dst] = destinations.slice(n * 16, n * 16 + 16);
            if(!memory) registers[src] = sources.slice(n * 16, n * 16 + 16);
            const offset = n * 16 + (width < 16 ? n & 7 : 0);
            const source = memory ? Uint8Array.from({ length: 16 }, (_, i) => i < width ? sources[offset + i] : 0) : registers[src];
            const expected = sse4_38(op, registers[dst], source, registers[0]);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected),
                `${name} xmm${dst}, ${memory ? "[mem]" : "xmm" + src} (xmm0 ${hex(registers[0])}): d=${hex(registers[dst])} s=${hex(source)}`);
        }
        cases += CASES;
    }
    console.log(`PASS: ${cases} cases of ${BINARY.length} forms of 66 0F 38 (PMOVSX/PMOVZX, BLENDV, PMULDQ/PMULLD, PCMPEQQ/PCMPGTQ, PACKUSDW, PMIN/PMAX, PHMINPOSUW) match the model in the interpreter and the page tier; the page tier templates for ${TEMPLATED_38.length}`);
    checks += cases;

    // PTEST: ZF and CF from the model, AF, OF, PF and SF cleared (set before)
    {
        const program = [];
        for(let n = 0; n < CASES; n++)
        {
            const memory = n >= CASES / 2;
            program.push(...LOAD, ...absolute(3, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(5, SOURCE + n * 16));
            // (OF, SF, AF set by 0x7F + 1, CF by STC)
            program.push(0xB0, 0x7F, 0x04, 0x01, 0xF9);
            program.push(...encode(0x38, 0x17, 3, 5, memory ? SOURCE + n * 16 : undefined));
            program.push(...PUSHF_STORE(OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(CASES * 16), OUT); }, CASES * 16, "ptest");
        for(let n = 0; n < CASES; n++)
        {
            const { zf, cf } = ptest(destinations.slice(n * 16, n * 16 + 16), sources.slice(n * 16, n * 16 + 16));
            const flags = new DataView(result.buffer).getUint32(n * 16, true);
            assert.equal(flags & 0x8D5, (zf ? 0x40 : 0) | (cf ? 1 : 0), `ptest ${n}: flags ${flags.toString(16)}`);
        }
        cases += CASES;
        checks += CASES;
    }
    console.log("PASS: PTEST sets ZF and CF as the model, clears AF, OF, PF and SF");

    // 66 0F 3A with imm8: every imm8, register and memory sources
    for(const [op, name] of IMMEDIATE)
    {
        const program = [];
        const count = 512;
        for(let n = 0; n < count; n++)
        {
            const imm8 = n & 255, dst = n % 7 + 1, src = n % 5, memory = n >= 256;
            const address = SOURCE + n * 16;
            program.push(...LOAD, ...absolute(dst, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(src, SOURCE + n * 16));
            program.push(...encode(0x3A, op, dst, src, memory ? address : undefined, imm8));
            program.push(...STORE, ...absolute(dst, OUT + n * 16));
        }
        for(const vm of machines) vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16), OUT); }, count * 16, name);
        page_ran(name, TEMPLATED_3A.includes(op), count);
        for(let n = 0; n < count; n++)
        {
            const imm8 = n & 255, dst = n % 7 + 1, src = n % 5, memory = n >= 256;
            const s = sources.slice(n * 16, n * 16 + 16);
            // (a destination that is also the source holds the source)
            const d = !memory && dst === src ? s : destinations.slice(n * 16, n * 16 + 16);
            // (INSERTPS from memory: the m32, imm8[7:6] ignored)
            const expected = op === 0x21 && memory ? insertps(d, get(s, 4, 0), imm8) : sse4_3a(op, d, s, imm8);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${name} imm8=${imm8.toString(16)} ${memory ? "[mem]" : "xmm"}`);
        }
        cases += count;
        checks += count;
    }
    console.log(`PASS: BLENDPS/BLENDPD/PBLENDW/INSERTPS/MPSADBW, every imm8 from registers and memory`);

    // PEXTR*/EXTRACTPS to a register (zero-extended) and to memory (the
    // bytes after unchanged), PINSRB/PINSRD from a register (its low bytes) and memory
    for(const [op, name, size] of EXTRACT)
    {
        const program = [], count = 64;
        for(let n = 0; n < count; n++)
        {
            const xmm = n % 8, gpr = GPRS[n % 7], imm8 = n * 37 & 255, memory = n >= count / 2;
            program.push(...LOAD, ...absolute(xmm, SOURCE + n * 16), ...mov_r32(gpr, 0xDEADBEEF));
            if(memory) program.push(...encode(0x3A, op, xmm, 0, OUT + n * 16 + (n & 7), imm8));
            else program.push(...encode(0x3A, op, xmm, gpr, undefined, imm8), ...store_r32(gpr, OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16).fill(0xEE), OUT); }, count * 16, name);
        for(let n = 0; n < count; n++)
        {
            const imm8 = n * 37 & 255, memory = n >= count / 2;
            const value = extract(sources.slice(n * 16, n * 16 + 16), size, imm8);
            const expected = new Uint8Array(16).fill(0xEE);
            if(memory) set(expected.subarray(n & 7), size, 0, value);
            else set(expected, 4, 0, value);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${name} imm8=${imm8} ${memory ? "[mem]" : "r32"}`);
        }
        cases += count;
        checks += count;
    }
    for(const [op, name, size] of INSERT)
    {
        const program = [], count = 64;
        for(let n = 0; n < count; n++)
        {
            const xmm = n % 8, gpr = GPRS[n % 7], imm8 = n * 37 & 255, memory = n >= count / 2;
            program.push(...LOAD, ...absolute(xmm, DEST + n * 16), ...mov_r32(gpr, Number(get(sources.subarray(n * 16), 4, 0))));
            program.push(...encode(0x3A, op, xmm, gpr, memory ? SOURCE + n * 16 + (n & 7) : undefined, imm8));
            program.push(...STORE, ...absolute(xmm, OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16), OUT); }, count * 16, name);
        for(let n = 0; n < count; n++)
        {
            const imm8 = n * 37 & 255, memory = n >= count / 2;
            const value = get(sources.subarray(n * 16 + (memory ? n & 7 : 0)), size, 0);
            const expected = insert(destinations.slice(n * 16, n * 16 + 16), size, value, imm8);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${name} imm8=${imm8} ${memory ? "[mem]" : "r32"}`);
        }
        cases += count;
        checks += count;
    }
    console.log(`PASS: PEXTRB/PEXTRW/PEXTRD/EXTRACTPS and PINSRB/PINSRD with registers and memory, ${cases} cases in all`);

    // ROUND: the page tier (machine 1) rounds finite lanes natively from the
    // default MXCSR (PE clear: set natively when reported), without the
    // exact helper (x64_sse_fp_calls) or steps; a NaN lane leaves the
    // template (the page tier retries the instruction in the interpreter; IR
    // Tier-0, before P7.5, called the helper). Every imm8 mode (bits 4-7 are
    // ignored), registers and memory.
    {
        const FINITE = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 3.7, -2.3, 1e-40, -1e-40, 0, -0, 1e10, -7, 123.456, 0.25];
        const NAN_LANES = [NaN, 1.5, -0.5, NaN];
        const values = (double, list, n) => {
            const v = new DataView(new ArrayBuffer(16));
            for(let i = 0; i < (double ? 2 : 4); i++)
            {
                const x = list[(n * 3 + i * 5) % list.length];
                if(double) v.setFloat64(i * 8, x === 1e-40 ? 1e-310 : x, true);
                else v.setFloat32(i * 4, x, true);
            }
            return new Uint8Array(v.buffer);
        };
        const MXCSR_DEFAULT = MASK + 0x1000;
        for(const [op, name, double, scalar] of [[0x0A, "roundss", false, true], [0x0B, "roundsd", true, true],
            [0x08, "roundps", false, false], [0x09, "roundpd", true, false]])
            for(const nan of [false, true])
        {
            const count = 64, program = [0x0F, 0xAE, 0x15, ...u32(MXCSR_DEFAULT)];
            const imm8 = n => [0, 1, 2, 3, 4, 8, 9, 10, 11, 12][n % 10] | n * 16 & 0xF0;
            const sources = new Uint8Array(count * 16);
            for(let n = 0; n < count; n++) sources.set(values(double, nan && n % 2 ? NAN_LANES : FINITE, n), n * 16);
            for(let n = 0; n < count; n++)
            {
                const dst = n % 8, src = (n + 3) % 8, memory = n >= count / 2;
                program.push(...LOAD, ...absolute(dst, DEST + n * 16));
                if(!memory) program.push(...LOAD, ...absolute(src, SOURCE + n * 16));
                program.push(...encode(0x3A, op, dst, src, memory ? SOURCE + n * 16 : undefined, imm8(n)), ...STORE, ...absolute(dst, OUT + n * 16));
            }
            program.push(0x0F, 0xAE, 0x1D, ...u32(OUT + count * 16));
            for(const vm of machines)
            {
                vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
                vm.v86.cpu.wm.exports["x64_sse_fp_calls_reset"]();
            }
            const label = `${name}${nan ? " with NaN lanes" : ""}`;
            const result = await run_out(program, vm => {
                write_data(vm);
                vm.write_memory(sources, SOURCE);
                vm.write_memory(Uint8Array.from(u32(0x1F80)), MXCSR_DEFAULT);
                vm.write_memory(new Uint8Array(count * 16 + 16), OUT);
            }, count * 16 + 16, label);
            const fp = new Fp(0x1F80), size = double ? 8 : 4;
            for(let n = 0; n < count; n++)
            {
                const expected = destinations.slice(n * 16, n * 16 + 16), source = sources.subarray(n * 16, n * 16 + 16);
                for(let i = 0; i < (scalar ? 1 : 16 / size); i++) set(expected, size, i, round_lane(fp, get(source, size, i), double, imm8(n)));
                assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${label} ${n}, imm8 ${imm8(n).toString(16)}`);
            }
            assert.equal(new DataView(result.buffer, result.byteOffset).getUint32(count * 16, true), fp.finish().mxcsr, `${label}: MXCSR`);
            const page = machines[1].v86.cpu.wm.exports;
            const steps = page["x64_page_steps"](0x0F66), calls = page["x64_sse_fp_calls"](0x660F3A00 | op);
            if(!simd(machines[1])) assert.ok(steps >= count, `${label}: the page tier steps without Wasm SIMD (${steps})`);
            else if(nan) assert.ok(calls + steps >= count / 4, `${label}: NaN lanes leave the template (${calls} calls, ${steps} steps and retries)`);
            else assert.ok(calls === 0 && steps < count / 2, `${label}: the page tier rounds natively (${calls} calls, ${steps} steps)`);
            checks += count;
        }
        console.log("PASS: ROUNDSS/ROUNDSD/ROUNDPS/ROUNDPD in the page tier natively for finite lanes (PE set there), retried for NaN lanes, every mode");
    }

    // MOVNTDQA loads an aligned m128
    {
        const program = [];
        for(let n = 0; n < 8; n++) program.push(...encode(0x38, 0x2A, n, 0, SOURCE + n * 16), ...STORE, ...absolute(n, OUT + n * 16));
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(128), OUT); }, 128, "movntdqa");
        assert.equal(hex(result), hex(sources.slice(0, 128)), "movntdqa");
        checks++;
    }

    // PCMPxSTRx against the model, every imm8 (bit 7 is reserved) from
    // registers and from an unaligned m128. XMM0 holds a pattern, then the
    // needle and the haystack are loaded (they may be XMM0 or the same
    // register). Out: XMM0, ECX (DEADBEEF before) and the flags.
    const PATTERN = OUT + 0x8000, pattern = Uint8Array.from({ length: 16 }, (_, i) => 0xC0 + i);
    // (the data must reach no match, all elements matching, and both strings ending early)
    const reached = { none: 0, all: 0, short: 0 };
    for(const [op, name] of STRINGS)
    {
        const count = 512, program = [];
        const operands = n => ({ imm8: n & 255, dst: n % 8, src: (n * 3 + 1) % 8, memory: n >= 256,
            la: LENGTHS[n % LENGTHS.length], lb: LENGTHS[(n * 7 + 3) % LENGTHS.length], address: MASK + n * 32 + (n & 15) });
        for(let n = 0; n < count; n++)
        {
            const { imm8, dst, src, memory, la, lb, address } = operands(n);
            program.push(...LOAD, ...absolute(0, PATTERN), ...LOAD, ...absolute(dst, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(src, SOURCE + n * 16));
            program.push(...FLAGS_BEFORE[n & 1][0], ...mov_r32(0, la), ...mov_r32(2, lb), ...mov_r32(1, 0xDEADBEEF));
            program.push(...encode(0x3A, op, dst, src, memory ? address : undefined, imm8));
            program.push(...store_r32(1, OUT + n * 32 + 16), ...STORE, ...absolute(0, OUT + n * 32), ...PUSHF_STORE(OUT + n * 32 + 20));
        }
        for(const vm of machines) vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
        const result = await run_out(program, vm => {
            vm.write_memory(needles, DEST);
            vm.write_memory(haystacks, SOURCE);
            for(let n = 256; n < count; n++) vm.write_memory(haystacks.subarray(n * 16, n * 16 + 16), operands(n).address);
            vm.write_memory(pattern, PATTERN);
            vm.write_memory(new Uint8Array(count * 32), OUT);
        }, count * 32, name);
        page_ran(name, true, count);
        const view = new DataView(result.buffer, result.byteOffset);
        for(let n = 0; n < count; n++)
        {
            const { imm8, dst, src, memory, la, lb } = operands(n);
            const registers = [pattern];
            registers[dst] = needles.slice(n * 16, n * 16 + 16);
            if(!memory) registers[src] = haystacks.slice(n * 16, n * 16 + 16);
            const explicit = op < 0x62;
            const r = compare_strings(imm8, registers[dst], memory ? haystacks.slice(n * 16, n * 16 + 16) : registers[src],
                explicit ? BigInt(la) : undefined, explicit ? BigInt(lb) : undefined);
            const index = op & 1;
            const label = `${name} xmm${dst}, ${memory ? "[mem]" : "xmm" + src}, ${imm8.toString(16)} (eax ${la}, edx ${lb})`;
            assert.equal(hex(result.subarray(n * 32, n * 32 + 16)), hex(index ? registers[0] : r.mask), `${label}: XMM0`);
            assert.equal(view.getUint32(n * 32 + 16, true), index ? r.index : 0xDEADBEEF, `${label}: ECX`);
            const flags = (r.cf ? 1 : 0) | (r.zf ? 0x40 : 0) | (r.sf ? 0x80 : 0) | (r.of ? 0x800 : 0);
            assert.equal(view.getUint32(n * 32 + 20, true) & 0x8D5, flags, `${label}: flags`);
            reached.none += r.intres2 === 0;
            reached.all += r.intres2 === (imm8 & 1 ? 0xFF : 0xFFFF);
            reached.short += r.zf && r.sf;
        }
        cases += count;
        checks += count;
    }
    assert(reached.none > 50 && reached.all > 50 && reached.short > 50, `PCMPxSTRx data: ${JSON.stringify(reached)}`);
    console.log("PASS: PCMPESTRM/PCMPESTRI/PCMPISTRM/PCMPISTRI, every imm8 from registers and unaligned memory: XMM0, ECX and the flags as the model; the page tier templates");

    // CRC32 against the model: r/m8 (AH-BH too), r/m16 and r/m32 from
    // registers (the destination's too) and unaligned memory; the flags kept
    for(const bytes of [1, 2, 4])
    {
        const count = 128, program = [];
        const operands = n => {
            const memory = n >= count / 2, rm = n % 8;
            return { memory, dst: GPRS[n % 7], rm: bytes > 1 && rm === 4 ? 5 : rm,
                crc: [0, 0xFFFFFFFF, 0x12345678, 0x80000001][n % 4] ^ Number(get(destinations.subarray(n * 16), 4, 0)) * (n % 5 === 0 ? 0 : 1),
                value: Number(get(sources.subarray(n * 16), 4, 0)), address: SOURCE + n * 16 + (n & 7) };
        };
        for(let n = 0; n < count; n++)
        {
            const { memory, dst, rm, crc, value, address } = operands(n);
            program.push(...FLAGS_BEFORE[n & 1][0]);
            // (the source's register, then the destination: the destination wins if they are one)
            if(!memory) program.push(...mov_r32(bytes === 1 ? rm & 3 : rm, value));
            program.push(...mov_r32(dst, crc), ...crc32_form(bytes, dst, rm, memory ? address : undefined));
            program.push(...store_r32(dst, OUT + n * 16), ...PUSHF_STORE(OUT + n * 16 + 4));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16), OUT); }, count * 16, `crc32 (${bytes})`);
        const view = new DataView(result.buffer, result.byteOffset);
        for(let n = 0; n < count; n++)
        {
            const { memory, dst, rm, crc, value } = operands(n);
            const registers = [];
            if(!memory) registers[bytes === 1 ? rm & 3 : rm] = value >>> 0;
            registers[dst] = crc >>> 0;
            let source;
            if(memory) source = Number(get(sources.subarray(n * 16 + (n & 7)), bytes, 0));
            else if(bytes === 1) source = registers[rm & 3] >>> (rm & 4 ? 8 : 0) & 0xFF;
            else source = registers[rm] & (bytes === 2 ? 0xFFFF : -1);
            const expected = Number(crc32(BigInt(registers[dst]), BigInt(source >>> 0), bytes));
            const label = `crc32 r${dst}, ${memory ? "[mem]" : "r" + rm} (${bytes}) crc ${registers[dst].toString(16)} value ${(source >>> 0).toString(16)}`;
            assert.equal(view.getUint32(n * 16, true), expected, label);
            assert.equal(view.getUint32(n * 16 + 4, true) & 0x8D5, FLAGS_BEFORE[n & 1][1], `${label}: flags kept`);
        }
        cases += count;
        checks += count;
    }
    console.log("PASS: CRC32 r32, r/m8 (AH-BH too), r/m16 and r/m32 from registers and memory as the CRC-32C model, the flags kept");

    // POPCNT r16/r32 from registers and memory: OF, SF, AF, CF and PF cleared,
    // ZF for a zero source; r16 keeps the upper half
    for(const bytes of [2, 4])
    {
        const count = 64, program = [];
        const VALUES = [0, 1, 0xFFFFFFFF, 0x80000000, 0x00010000, 0x8000, 0xFFFF0000, 0x5555AAAA];
        const operands = n => ({ memory: n >= count / 2, dst: GPRS[n % 7], src: GPRS[(n + 3) % 7], address: SOURCE + n * 16 + (n & 7),
            value: n % 16 < 8 ? VALUES[n % 8] : Number(get(sources.subarray(n * 16), 4, 0)) });
        for(let n = 0; n < count; n++)
        {
            const { memory, dst, src, address, value } = operands(n);
            program.push(...FLAGS_BEFORE[n & 1][0]);
            if(memory) program.push(0xC7, 0x05, ...u32(address), ...u32(value));
            else program.push(...mov_r32(src, value));
            program.push(...mov_r32(dst, 0xDEADBEEF), ...popcnt_form(bytes, dst, src, memory ? address : undefined));
            program.push(...store_r32(dst, OUT + n * 16), ...PUSHF_STORE(OUT + n * 16 + 4));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16), OUT); }, count * 16, `popcnt (${bytes})`);
        const view = new DataView(result.buffer, result.byteOffset);
        for(let n = 0; n < count; n++)
        {
            const { value } = operands(n);
            const source = bytes === 2 ? value & 0xFFFF : value >>> 0;
            const ones = source.toString(2).split("1").length - 1;
            const label = `popcnt (${bytes}) of ${source.toString(16)}`;
            assert.equal(view.getUint32(n * 16, true), bytes === 2 ? (0xDEAD0000 | ones) >>> 0 : ones, label);
            assert.equal(view.getUint32(n * 16 + 4, true) & 0x8D5, source === 0 ? 0x40 : 0, `${label}: flags`);
        }
        cases += count;
        checks += count;
    }
    console.log("PASS: POPCNT r16/r32 from registers and memory, its flags");

    // Faults: the destination keeps its value
    const keep = r => [...LOAD, ...absolute(r, DEST)];
    const kept = r => [...STORE, ...absolute(r, OUT)];
    const out = destinations.slice(0, 16);
    const before = vm => { write_data(vm); vm.write_memory(new Uint8Array(16), OUT); };
    const samples = [
        ["pminud", encode(0x38, 0x3B, 6, undefined, SOURCE + 8), true],
        ["pblendvb", encode(0x38, 0x10, 6, undefined, SOURCE + 4), true],
        ["ptest", encode(0x38, 0x17, 6, undefined, SOURCE + 1), true],
        ["movntdqa", encode(0x38, 0x2A, 6, undefined, SOURCE + 8), true],
        ["blendps", encode(0x3A, 0x0C, 6, undefined, SOURCE + 8, 5), true],
        ["mpsadbw", encode(0x3A, 0x42, 6, undefined, SOURCE + 12, 5), true],
        ["pmovzxbw", encode(0x38, 0x30, 6, undefined, SOURCE + 8), false],
        ["pinsrd", encode(0x3A, 0x22, 6, undefined, SOURCE + 1, 1), false],
        ["insertps", encode(0x3A, 0x21, 6, undefined, SOURCE + 3, 0x10), false],
        // (PCMPxSTRx: an m128 without alignment, SDM exception type 4 note)
        ["pcmpistri", encode(0x3A, 0x63, 6, undefined, SOURCE + 3, 0x0C), false],
        ["pcmpestrm", encode(0x3A, 0x60, 6, undefined, SOURCE + 9, 0x40), false],
    ];
    for(const [name, form, aligned] of samples)
    {
        const label = name + " [misaligned]";
        if(aligned)
        {
            await expect_fault(keep(6), form, 13, { epilogue: kept(6), before, error_code: 0, label, out });
        }
        else
        {
            const results = await run_all([...keep(6), ...form, ...kept(6)], before, machines, vm => word(vm, FAULT));
            for(const { label: run, data } of results) assert.equal(data, 0, `${label} (${run}): no fault`);
        }
        // CR0.TS: #NM; CR0.EM and no CR4.OSFXSR: #UD
        await expect_fault([...keep(6), ...SET_CR0(8)], form, 7, { epilogue: [...CLTS, ...kept(6)], before, label: name + " with CR0.TS", out });
        await expect_fault([...keep(6), ...SET_CR0(4)], form, 6, { epilogue: [...CLEAR_CR0(4), ...kept(6)], before, label: name + " with CR0.EM", out });
        await expect_fault([...keep(6), ...NO_OSFXSR], form, 6, { epilogue: [...OSFXSR, ...kept(6)], before, label: name + " without OSFXSR", out });
        checks += 4;
    }
    // LOCK, F2 and F3 are #UD; so is MOVNTDQA from a register
    for(const prefix of [0xF0, 0xF2, 0xF3])
    {
        for(const form of [encode(0x38, 0x3B, 6, 1), encode(0x3A, 0x0E, 6, 1, undefined, 3), encode(0x3A, 0x16, 1, 2, undefined, 1),
            encode(0x3A, 0x63, 6, 1, undefined, 0x0C)])
        {
            await expect_fault(keep(6), [prefix, ...form], 6, { epilogue: kept(6), before, label: `${prefix.toString(16)} ${hex(form)}`, out });
            checks++;
        }
    }
    await expect_fault(keep(6), encode(0x38, 0x2A, 6, 1), 6, { epilogue: kept(6), before, label: "movntdqa xmm6, xmm1", out });
    // CRC32 and POPCNT have no XMM state: CR0.TS, CR0.EM and CR4.OSFXSR do
    // not matter. LOCK is #UD, so is F3 at CRC32's opcodes.
    for(const [name, form] of [["crc32 ecx, byte [mem]", crc32_form(1, 1, 0, SOURCE + 1)], ["crc32 ecx, edx", crc32_form(4, 1, 2)],
        ["crc32 ecx, word [mem]", crc32_form(2, 1, 0, SOURCE + 3)], ["popcnt ecx, word [mem]", popcnt_form(2, 1, 0, SOURCE + 3)],
        ["popcnt ecx, edx", popcnt_form(4, 1, 2)]])
    {
        for(const [setup, undo, what] of [[SET_CR0(8), CLTS, "CR0.TS"], [SET_CR0(4), CLEAR_CR0(4), "CR0.EM"], [NO_OSFXSR, OSFXSR, "no CR4.OSFXSR"]])
        {
            const results = await run_all([...setup, ...form, ...undo], before, machines, vm => word(vm, FAULT));
            for(const { label, data } of results) assert.equal(data, 0, `${name} with ${what} (${label}): no fault`);
            checks++;
        }
        await expect_fault([], [0xF0, ...form], 6, { before, label: `lock ${name}` });
        checks++;
    }
    for(const op of [0xF0, 0xF1])
    {
        await expect_fault([], [0xF3, 0x0F, 0x38, op, 0xC1], 6, { before, label: `F3 0F 38 ${op.toString(16)} (not CRC32)` });
        checks++;
    }
    // #PF: a load from and a store to an absent page, nothing written
    const absent = vm => { before(vm); vm.write_memory(new Uint8Array(16).fill(0xEE), ABSENT - 16); pages(vm, ABSENT, false); };
    await expect_fault(keep(6), encode(0x38, 0x32, 6, undefined, ABSENT - 1), 14, { epilogue: kept(6), before: absent, cr2: ABSENT, error_code: 0, label: "pmovzxbq across into an absent page", out });
    await expect_fault(keep(6), encode(0x3A, 0x16, 6, undefined, ABSENT - 2, 3), 14, { epilogue: kept(6), before: absent, cr2: ABSENT, error_code: 2,
        label: "pextrd across into an absent page", memory: [ABSENT - 16, new Uint8Array(16).fill(0xEE)] });
    // PCMPISTRI reads all of its m128 though the string ends at its first
    // byte; a CRC32 operand across into the page. ECX keeps its value.
    const ecx = [...u32(0x12345678), ...new Array(12).fill(0)];
    await expect_fault(mov_r32(1, 0x12345678), encode(0x3A, 0x63, 6, undefined, ABSENT - 4, 0x0C), 14, { epilogue: store_r32(1, OUT),
        before: vm => { absent(vm); vm.write_memory(new Uint8Array(4), ABSENT - 4); }, cr2: ABSENT, error_code: 0,
        label: "pcmpistri across into an absent page", out: ecx });
    await expect_fault(mov_r32(1, 0x12345678), crc32_form(4, 1, 0, ABSENT - 2), 14, { epilogue: store_r32(1, OUT), before: absent, cr2: ABSENT,
        error_code: 0, label: "crc32 across into an absent page", out: ecx });
    for(const vm of machines) pages(vm, ABSENT, true);
    checks += 5;
    console.log("PASS: #GP(0) for misaligned m128 operands (none for narrow ones or PCMPxSTRx), #NM, #UD (EM, OSFXSR, LOCK, F2/F3, MOVNTDQA register) and #PF, without effect; CRC32 and POPCNT without XMM checks");
    console.log(`PASS: ${checks} SSE4 checks in the interpreter and the page tier`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
