// The XSAVE feature set in the 32-bit engines (docs/simd-xsave-plan.md P2):
// CPUID leaves 1 and 0xD, CR4.OSXSAVE, XGETBV/XSETBV, XSAVE/XRSTOR in the
// standard format (round trips, partial saves, init on restore, the header
// and MXCSR checks, the fault order and page faults without partial effects)
// and FXSAVE/FXRSTOR, which share the state encoding (cpu/xstate.rs). Each
// case runs in the interpreter, then hot under the page tier and the region tiers;
// its checks follow the hot run (compiled code) and the cold one. P9:
// XSAVEOPT, XGETBV(1), XSAVEC and XRSTOR's compacted form, XSAVES, XRSTORS and
// IA32_XSS.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x210000, FAULT = 0x211000, SKIP = 0x211100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
// XSAVE areas (64-byte aligned); CROSSING's YMM_Hi128 starts on the next page
const AREA = 0x202000, AREA2 = 0x203000, AREA3 = 0x204000, CROSSING = 0x205DC0, ABSENT = 0x206000;

const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// instructions
const mov_eax = n => [0xB8, ...u32(n)], mov_ecx = n => [0xB9, ...u32(n)], mov_edx = n => [0xBA, ...u32(n)], mov_ebx = n => [0xBB, ...u32(n)];
const store_eax = a => [0xA3, ...u32(a)], store_ebx = a => [0x89, 0x1D, ...u32(a)];
const store_ecx = a => [0x89, 0x0D, ...u32(a)], store_edx = a => [0x89, 0x15, ...u32(a)];
const cpuid = (leaf, subleaf, out) => [...mov_eax(leaf), ...mov_ecx(subleaf), 0x0F, 0xA2,
    ...store_eax(out), ...store_ebx(out + 4), ...store_ecx(out + 8), ...store_edx(out + 12)];
const OSXSAVE = [0x0F, 0x20, 0xE0, 0x0D, ...u32(1 << 18), 0x0F, 0x22, 0xE0];          // CR4 |= OSXSAVE
const NO_OSXSAVE = [0x0F, 0x20, 0xE0, 0x25, ...u32(~(1 << 18) >>> 0), 0x0F, 0x22, 0xE0];
// SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
const ENABLE_SSE = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0];
const SET_TS = [0x0F, 0x20, 0xC0, 0x0D, ...u32(8), 0x0F, 0x22, 0xC0], CLTS = [0x0F, 0x06];
const XGETBV = [0x0F, 0x01, 0xD0], XSETBV = [0x0F, 0x01, 0xD1];
const xsetbv = value => [...mov_ecx(0), ...mov_eax(value), ...mov_edx(0), ...XSETBV];
const XSAVE = [0x0F, 0xAE, 0x23], XRSTOR = [0x0F, 0xAE, 0x2B], XSAVEOPT = [0x0F, 0xAE, 0x33]; // [ebx]
const XSAVEC = [0x0F, 0xC7, 0x23], XSAVES = [0x0F, 0xC7, 0x2B], XRSTORS = [0x0F, 0xC7, 0x1B];
const FXSAVE = [0x0F, 0xAE, 0x03], FXRSTOR = [0x0F, 0xAE, 0x0B];
const ALL = [...mov_eax(-1), ...mov_edx(-1)];
const fld = a => [0xDD, 0x05, ...u32(a)], fstp = a => [0xDD, 0x1D, ...u32(a)], FNINIT = [0xDB, 0xE3];
const fnstcw = a => [0xD9, 0x3D, ...u32(a)];
const movups_load = (r, a) => [0x0F, 0x10, 5 | r << 3, ...u32(a)], movups_store = (r, a) => [0x0F, 0x11, 5 | r << 3, ...u32(a)];
const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
const XORPS_0_7 = [0x0F, 0x57, 0xC0, 0x0F, 0x57, 0xFF];
const VZEROALL = [0xC5, 0xFC, 0x77];
// VINSERTF128 ymm6, ymm6, [a], 1: YMM6's upper half from memory
const vinsertf128_6 = a => [0xC4, 0xE3, 0x4D, 0x18, 0x35, ...u32(a), 1];
const xgetbv = (ecx, out) => [...mov_ecx(ecx), ...XGETBV, ...store_eax(out), ...store_edx(out + 4)];

const machines = [];
// The start of every program: a known CR0.TS, CR4.OSXSAVE and XCR0 (a warm
// run stops anywhere in its loop)
let preamble = [];
async function run(vm, program, warm = true, interpreter = false)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
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
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    // (a hot run goes on a while, then ends at the end of a round)
    if(warm)
    {
        await sleep(20);
        vm.write_memory(Uint8Array.of(1), 0x604);
        while(!cpu.in_hlt[0])
        {
            assert(performance.now() < deadline, "program end timeout");
            await sleep(1);
        }
    }
    await vm.stop();
}
// the body repeats until byte 0x604 is set, then halts at the end of the
// round; each round clears the fault record first
const CLEAR_FAULT = [0xC7, 0x05, ...u32(FAULT), 0, 0, 0, 0];
function loop(body)
{
    const p = [...CLEAR_FAULT, ...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it, the faulting EIP, CR2 and the error code, and skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58, ...store_eax(FAULT + 12));            // pop eax: the error code
    p.push(0xC7, 0x05, ...u32(FAULT), ...u32(vector));
    p.push(0x8B, 0x04, 0x24, ...store_eax(FAULT + 4));                // [esp]: EIP
    p.push(0x0F, 0x20, 0xD0, ...store_eax(FAULT + 8));                // CR2
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);               // add [esp], [SKIP]; iret
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true]];
/** Runs `program` on each machine of `set`, hot (compiled), then once more
 * cold (mostly interpreted: the program was rewritten), and checks each run
 * with `check` (the hot run stops anywhere in its loop: what the loop's
 * rounds write alike) */
async function run_all(program, before = () => {}, set = machines, check = () => {})
{
    for(const vm of set)
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], i) => {
            const h = HANDLER + i * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        // (the program first loads the IDT)
        const p = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...ENABLE_SSE, ...preamble, ...program];
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(new Uint8Array(16), FAULT);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, loop(p), warm, vm === set[0]);
            check(vm, `${warm ? "hot" : "cold"}, machine ${set.indexOf(vm)}`);
        }
    }
}
/** The interpreter, then the page tier and the region tiers, with `options` */
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
/**
 * `faulting` raises `vector` at its first byte after `prologue` (the
 * handler skips it, `epilogue` follows), with CR2 `cr2` for a page fault
 */
async function expect_fault(set, prologue, faulting, vector, { epilogue = [], before = () => {}, cr2, label, check = () => {} } = {})
{
    // (the fault record's clearing, the IDT load, SSE and the preamble come first)
    const at = CODE + CLEAR_FAULT.length + 7 + ENABLE_SSE.length + preamble.length + prologue.length;
    const name = label || faulting.map(b => b.toString(16)).join(" ");
    await run_all([...prologue, ...faulting, ...epilogue], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        before(vm);
    }, set, (vm, run) => {
        assert.deepEqual([word(vm, FAULT), word(vm, FAULT + 4)], [vector, at], `${name} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(word(vm, FAULT + 8), cr2, `${name} (${run}): CR2`);
        check(vm, run);
    });
}
/** A check: no fault */
const no_fault = name => (vm, run) =>
    assert.equal(word(vm, FAULT), 0, `${name} (${run}): fault ${word(vm, FAULT)} at ${word(vm, FAULT + 4).toString(16)}`);
const fill = (vm, a, n, byte) => vm.write_memory(new Uint8Array(n).fill(byte), a);
/** A pattern-filled area whose header (bytes 512-575) is 0 but XSTATE_BV */
function prepare(vm, a, xstate_bv = 0)
{
    fill(vm, a, 832, 0xCC);
    vm.write_memory(new Uint8Array(64), a + 512);
    vm.write_memory(Uint8Array.from(u32(xstate_bv)), a + 512);
}
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};

let count = 0;
try
{
    // Without XSAVE: no CPUID bits, CR4.OSXSAVE is reserved, the instructions #UD
    machines.push(...await create_machines());
    preamble = CLTS;
    await run_all(cpuid(1, 0, OUT), undefined, machines, (vm, run) => assert.equal(word(vm, OUT + 8) & 3 << 26, 0, `CPUID.1:ECX XSAVE, OSXSAVE (${run})`));
    await expect_fault(machines, OSXSAVE.slice(0, -3), OSXSAVE.slice(-3), 13, { label: "MOV CR4 with OSXSAVE" });
    for(const [instruction, label] of [[XGETBV, "XGETBV"], [XSETBV, "XSETBV"], [[...mov_ebx(AREA), ...XSAVE], "XSAVE"], [[...mov_ebx(AREA), ...XSAVEOPT], "XSAVEOPT"],
        [[...mov_ebx(AREA), ...XSAVEC], "XSAVEC"], [[...mov_ebx(AREA), ...XSAVES], "XSAVES"], [[...mov_ebx(AREA), ...XRSTORS], "XRSTORS"]])
    {
        const prologue = instruction.length > 3 ? instruction.slice(0, -3) : [];
        await expect_fault(machines, prologue, instruction.slice(-3), 6, { label: label + " without XSAVE" });
    }
    count += 9;
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without XSAVE, CPUID reports none, CR4.OSXSAVE is reserved, XGETBV/XSETBV/XSAVE/XSAVEOPT/XSAVEC/XSAVES/XRSTORS #UD");

    // XSAVE without AVX: XCR0 can have x87 and SSE state
    machines.push(...await create_machines({ cpu_features: ["XSAVE"], cpu_features_unreleased: true }));
    preamble = [...CLTS, ...OSXSAVE, ...xsetbv(1), ...NO_OSXSAVE];
    await run_all([...cpuid(1, 0, OUT), ...OSXSAVE, ...cpuid(1, 0, OUT + 16), ...cpuid(0xD, 0, OUT + 32),
        ...cpuid(0xD, 1, OUT + 48), ...cpuid(0xD, 2, OUT + 64), ...mov_ecx(0), ...XGETBV, ...store_eax(OUT + 80), ...store_edx(OUT + 84),
        ...xsetbv(3), ...mov_ecx(0), ...XGETBV, ...store_eax(OUT + 88), ...cpuid(0xD, 0, OUT + 96), ...xsetbv(1), ...NO_OSXSAVE], undefined, machines, (vm, run) => {
        assert.equal(word(vm, OUT + 8) >>> 26 & 3, 1, `CPUID.1:ECX: XSAVE, without OSXSAVE (${run})`);
        assert.equal(word(vm, OUT + 24) >>> 26 & 3, 3, `CPUID.1:ECX: XSAVE, OSXSAVE (${run})`);
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 32 + i)), [3, 576, 576, 0], `CPUID.0xD.0 (${run})`);
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 48 + i)), [0, 0, 0, 0], `CPUID.0xD.1 (${run})`);
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 64 + i)), [0, 0, 0, 0], `CPUID.0xD.2 (${run})`);
        assert.deepEqual([word(vm, OUT + 80), word(vm, OUT + 84), word(vm, OUT + 88)], [1, 0, 3], `XGETBV: XCR0 1 at reset, 3 after XSETBV (${run})`);
        assert.equal(word(vm, OUT + 100), 576, `CPUID.0xD.0:EBX with XCR0 3 (${run})`);
    });
    // without the XSAVEOPT and XSAVEC features, 0F AE /6 and 0F C7 /4 on memory are #UD
    await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA), ...ALL], XSAVEOPT, 6, { epilogue: NO_OSXSAVE, label: "XSAVEOPT without its feature" });
    await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA), ...ALL], XSAVEC, 6, { epilogue: NO_OSXSAVE, label: "XSAVEC without its feature" });
    // without XSAVES: XSAVES and XRSTORS #UD (IA32_XSS: an absent MSR, which
    // outside long mode reads 0 and ignores writes as all of them here;
    // tests/x64/xsave.mjs has its #GP in long mode)
    await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA), ...ALL], XSAVES, 6, { epilogue: NO_OSXSAVE, label: "XSAVES without its feature" });
    await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA), ...ALL], XRSTORS, 6, { epilogue: NO_OSXSAVE, label: "XRSTORS without its feature" });
    count += 13;
    // XSETBV's checks: XCR0 only, x87 always, supported bits only; XGETBV
    // of XCR 1 needs XGETBV1; no mandatory prefix; LOCK
    for(const [ecx, value] of [[0, 0], [0, 2], [0, 7], [0, 5], [1, 3], [0, 0x100003]])
    {
        await expect_fault(machines, [...OSXSAVE, ...mov_ecx(ecx), ...mov_eax(value), ...mov_edx(0)], XSETBV, 13,
            { epilogue: NO_OSXSAVE, label: `XSETBV ${ecx}, ${value.toString(16)}` });
    }
    await expect_fault(machines, [...OSXSAVE, ...mov_ecx(1)], XGETBV, 13, { epilogue: NO_OSXSAVE, label: "XGETBV 1" });
    for(const prefix of [0x66, 0xF2, 0xF3, 0xF0])
    {
        await expect_fault(machines, [...OSXSAVE, ...mov_ecx(0)], [prefix, ...XGETBV], 6, { epilogue: NO_OSXSAVE, label: `${prefix.toString(16)} XGETBV` });
        await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA)], [prefix, ...XSAVE], 6, { epilogue: NO_OSXSAVE, label: `${prefix.toString(16)} XSAVE` });
    }
    count += 15;
    console.log("PASS: CPUID 1 and 0xD, XGETBV/XSETBV and their #GP/#UD cases with XSAVE (XCR0 x87|SSE)");

    // XSAVE and XRSTOR: a round trip of x87, MMX/XMM and MXCSR state; a
    // partial save; init on restore; FXSAVE's layout matches XSAVE's
    const constants = new Float64Array([1.5, -2.25]);
    const xmm = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
    const setup = vm => {
        vm.write_memory(new Uint8Array(constants.buffer), DATA);
        vm.write_memory(xmm, DATA + 16);
        vm.write_memory(Uint8Array.from(u32(0x1FA0)), DATA + 48);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), DATA + 52);
        prepare(vm, AREA);
        prepare(vm, AREA2, 1);
        prepare(vm, AREA3);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), AREA3 + 24);
        fill(vm, AREA3 + 160, 16, 0x55);
        prepare(vm, AREA + 0x800);
    };
    const state = [...FNINIT, ...fld(DATA), ...fld(DATA + 8), ...movups_load(0, DATA + 16), ...movups_load(7, DATA + 32), ...ldmxcsr(DATA + 48)];
    await run_all([...OSXSAVE, ...xsetbv(3), ...state,
        ...mov_ebx(AREA), ...ALL, ...XSAVE,
        ...mov_ebx(AREA + 0x800), ...FXSAVE,
        ...mov_ebx(AREA2), ...mov_eax(2), ...mov_edx(0), ...XSAVE,
        ...FNINIT, ...XORPS_0_7, ...ldmxcsr(DATA + 52),
        ...mov_ebx(AREA), ...ALL, ...XRSTOR,
        ...fstp(OUT), ...fstp(OUT + 8), ...movups_store(0, OUT + 16), ...movups_store(7, OUT + 32), ...stmxcsr(OUT + 48),
        // init: XSTATE_BV 0, MXCSR from memory (RFBM[1])
        ...mov_ebx(AREA3), ...mov_eax(3), ...mov_edx(0), ...XRSTOR,
        ...fnstcw(OUT + 64), ...movups_store(0, OUT + 80), ...stmxcsr(OUT + 96),
        ...xsetbv(1), ...NO_OSXSAVE], setup, machines, (vm, run) => {
        no_fault("XSAVE/XRSTOR round trip")(vm, run);
        assert.deepEqual(new Float64Array(bytes(vm, OUT, 16).buffer), Float64Array.of(-2.25, 1.5), "x87 after XRSTOR");
        assert.deepEqual(bytes(vm, OUT + 16, 32), xmm, "XMM0, XMM7 after XRSTOR");
        assert.equal(word(vm, OUT + 48), 0x1FA0, "MXCSR after XRSTOR");
        const area = bytes(vm, AREA, 832);
        const view = new DataView(area.buffer);
        assert.deepEqual([view.getUint16(0, true), view.getUint32(24, true), view.getUint32(28, true)], [0x37F, 0x1FA0, 0xFFFF], "FCW, MXCSR, MXCSR_MASK");
        assert.equal(area[4], 0xC0, "abridged FTW: two registers in use");
        assert.deepEqual(area.subarray(160, 176), xmm.subarray(0, 16), "XMM0 at 160");
        assert.deepEqual(area.subarray(272, 288), xmm.subarray(16, 32), "XMM7 at 272");
        assert.ok(area.subarray(288, 512).every(b => b === 0xCC), "bytes 288-511 untouched outside 64-bit mode");
        assert.deepEqual([view.getUint32(512, true), view.getUint32(516, true)], [3, 0], "XSTATE_BV: x87 and SSE in use");
        assert.ok(area.subarray(520, 576).every(b => b === 0) && area.subarray(576).every(b => b === 0xCC), "only XSTATE_BV of the header, no YMM");
        assert.ok([5, 14, 15, 22, 23, 42, 43, 47].every(i => area[i] === 0xCC), "reserved bytes are not stored");
        // FXSAVE: the same legacy region
        const fx = bytes(vm, AREA + 0x800, 512);
        for(const [from, to] of [[0, 5], [6, 14], [16, 22], [24, 32], [32, 42], [160, 288]])
        {
            assert.deepEqual(fx.subarray(from, to), area.subarray(from, to), `FXSAVE bytes ${from}-${to}`);
        }
        assert.ok(fx.subarray(288, 512).every(b => b === 0xCC), "FXSAVE leaves 288-511 alone outside 64-bit mode");
        // the partial save: SSE only (MXCSR with it), XSTATE_BV bit 0 kept
        const partial = bytes(vm, AREA2, 576);
        assert.ok(partial.subarray(0, 24).every(b => b === 0xCC) && partial.subarray(32, 160).every(b => b === 0xCC), "x87 not stored");
        assert.equal(new DataView(partial.buffer).getUint32(24, true), 0x1FA0, "MXCSR stored with SSE");
        assert.deepEqual(partial.subarray(160, 176), xmm.subarray(0, 16));
        assert.equal(new DataView(partial.buffer).getUint32(512, true), 3, "XSTATE_BV: old bit 0, bit 1 in use");
        // init: FNINIT's x87 state, XMM zero, MXCSR loaded
        assert.equal(word(vm, OUT + 64) & 0xFFFF, 0x37F, "x87 init: FCW");
        assert.deepEqual(bytes(vm, OUT + 80, 16), new Uint8Array(16), "SSE init: XMM0 0");
        assert.equal(word(vm, OUT + 96), 0x1F80, "MXCSR loaded although SSE is initialized");
    });
    count += 20;
    console.log("PASS: XSAVE/XRSTOR round trip, partial save, init on restore, FXSAVE layout (XCR0 3)");

    // Faults: #UD without CR4.OSXSAVE before #NM; #NM with CR0.TS; #GP for
    // misalignment, the header and MXCSR; page faults before any byte moves
    await expect_fault(machines, [...SET_TS, ...mov_ebx(AREA)], XSAVE, 6, { epilogue: CLTS, label: "XSAVE without OSXSAVE, TS set" });
    await expect_fault(machines, [...OSXSAVE, ...SET_TS, ...mov_ebx(AREA), ...ALL], XSAVE, 7, { epilogue: [...CLTS, ...NO_OSXSAVE], label: "XSAVE with TS" });
    await expect_fault(machines, [...OSXSAVE, ...SET_TS, ...mov_ebx(AREA), ...ALL], XRSTOR, 7, { epilogue: [...CLTS, ...NO_OSXSAVE], label: "XRSTOR with TS" });
    for(const [offset, instruction, label] of [[32, XSAVE, "XSAVE"], [16, XRSTOR, "XRSTOR"], [8, FXSAVE, "FXSAVE"], [4, FXRSTOR, "FXRSTOR"]])
    {
        await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA + offset), ...ALL], instruction, 13,
            { epilogue: NO_OSXSAVE, label: label + " misaligned", before: vm => prepare(vm, AREA) });
    }
    for(const [patch, label] of [[[520 + 7, 0x80], "XCOMP_BV[63] without XSAVEC"], [[512, 4 | 3], "XSTATE_BV bit outside XCR0"],
        [[530, 1], "header bytes 23:8"], [[26, 1], "MXCSR reserved bits"]])
    {
        await expect_fault(machines, [...OSXSAVE, ...xsetbv(3), ...mov_ebx(AREA), ...ALL], XRSTOR, 13, {
            epilogue: NO_OSXSAVE, label,
            before: vm => {
                prepare(vm, AREA, 3);
                vm.write_memory(Uint8Array.from(u32(0x1F80)), AREA + 24);
                vm.write_memory(Uint8Array.of(patch[1]), AREA + patch[0]);
            },
        });
    }
    await expect_fault(machines, [...mov_ebx(CROSSING - 0x1000 + 0x40)], FXRSTOR, 13, {
        label: "FXRSTOR with MXCSR reserved bits",
        before: vm => vm.write_memory(Uint8Array.from(u32(0x10000)), CROSSING - 0x1000 + 0x40 + 24),
    });
    // the header on an absent page: nothing stored; XRSTOR reads it first
    for(const [instruction, label] of [[XSAVE, "XSAVE"], [XRSTOR, "XRSTOR"]])
    {
        const base = ABSENT - 512;
        await expect_fault(machines, [...OSXSAVE, ...xsetbv(3), ...mov_ebx(base), ...ALL], instruction, 14, {
            epilogue: NO_OSXSAVE, cr2: ABSENT, label: label + " header on an absent page",
            before: vm => { fill(vm, base, 512, 0xCC); pages(vm, ABSENT, false); },
            check: (vm, run) => assert.ok(bytes(vm, base, 512).every(b => b === 0xCC), `${label}: no byte stored before the page fault (${run})`),
        });
        for(const vm of machines) pages(vm, ABSENT, true);
    }
    // components not asked for are not touched: YMM's place on an absent page
    await run_all([...OSXSAVE, ...xsetbv(3), ...mov_ebx(CROSSING), ...ALL, ...XSAVE, ...XRSTOR, ...xsetbv(1), ...NO_OSXSAVE], vm => {
        prepare(vm, CROSSING, 3);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), CROSSING + 24);
        pages(vm, CROSSING + 576, false);
    }, machines, no_fault("XSAVE/XRSTOR without AVX state next to an absent page"));
    for(const vm of machines) pages(vm, CROSSING + 576, true);
    count += 14;
    console.log("PASS: #UD before #NM, #NM with CR0.TS, #GP for alignment, the header and MXCSR, #PF before any byte moves, no access beyond the components");
    for(const vm of machines) await vm.destroy();
    machines.length = 0;

    // With AVX: XCR0 can enable YMM state, which XRSTOR loads and XSAVE stores
    // (no AVX instruction has semantics yet); CPUID's sizes follow XCR0
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"], cpu_features_unreleased: true }));
    const ymm = Uint8Array.from({ length: 128 }, (_, i) => i * 13 + 1);
    await run_all([...OSXSAVE, ...cpuid(0xD, 0, OUT), ...cpuid(0xD, 2, OUT + 16), ...xsetbv(7), ...cpuid(0xD, 0, OUT + 32),
        ...mov_ebx(AREA), ...ALL, ...XRSTOR, ...mov_ebx(AREA2), ...ALL, ...XSAVE,
        ...mov_ebx(CROSSING), ...ALL, ...XSAVE,
        ...xsetbv(1), ...NO_OSXSAVE], vm => {
        prepare(vm, AREA, 4);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), AREA + 24);
        vm.write_memory(ymm, AREA + 576);
        prepare(vm, AREA2);
        prepare(vm, CROSSING);
    }, machines, (vm, run) => {
        no_fault("YMM round trip")(vm, run);
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + i)), [7, 576, 832, 0], "CPUID.0xD.0 with AVX, XCR0 1");
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 16 + i)), [256, 576, 0, 0], "CPUID.0xD.2");
        assert.equal(word(vm, OUT + 36), 832, "CPUID.0xD.0:EBX with XCR0 7");
        const area = bytes(vm, AREA2, 832);
        assert.deepEqual(area.subarray(576, 704), ymm, "YMM0_H-YMM7_H stored");
        assert.ok(area.subarray(704).every(b => b === 0xCC), "YMM8_H-YMM15_H only in 64-bit mode");
        assert.equal(new DataView(area.buffer).getUint32(512, true), 4, "XSTATE_BV: x87 and SSE initial (XRSTOR initialized them), AVX in use");
    });
    await expect_fault(machines, [...OSXSAVE, ...mov_ecx(0), ...mov_eax(5), ...mov_edx(0)], XSETBV, 13, { epilogue: NO_OSXSAVE, label: "XSETBV YMM without SSE" });
    // the YMM component on an absent page: nothing stored on the first page
    await expect_fault(machines, [...OSXSAVE, ...xsetbv(7), ...mov_ebx(CROSSING), ...ALL], XSAVE, 14, {
        epilogue: [...xsetbv(1), ...NO_OSXSAVE], cr2: CROSSING + 576, label: "XSAVE with YMM on an absent page",
        before: vm => { prepare(vm, CROSSING); pages(vm, CROSSING + 576, false); },
        check: (vm, run) => assert.ok(bytes(vm, CROSSING, 512).every(b => b === 0xCC), `no legacy-region byte stored before the page fault (${run})`),
    });
    for(const vm of machines) pages(vm, CROSSING + 576, true);
    count += 8;
    console.log("PASS: with AVX, XCR0 enables YMM state; CPUID 0xD sizes follow XCR0; XSAVE stores YMM_Hi128 or faults first");
    for(const vm of machines) await vm.destroy();
    machines.length = 0;

    // P9: XSAVEOPT, XGETBV(1), XSAVEC, XSAVES and XRSTORS. The rounds of
    // these programs keep XCR0 7 and CR4.OSXSAVE (the preamble sets them
    // alike each round): compiled code depends on them, and a program
    // changing them every round would run interpreted on the compiled arms.
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "XSAVEOPT", "XGETBV1", "XSAVEC", "XSAVES"], cpu_features_unreleased: true }));
    preamble = [...CLTS, ...OSXSAVE, ...xsetbv(7)];
    {
        // (every component in its initial configuration: XRSTOR of an area whose
        // XSTATE_BV is 0, MXCSR 1F80H; FNINIT would keep ST0-ST7's contents)
        const upper = Uint8Array.from({ length: 16 }, (_, i) => 0x90 + i), INIT = AREA2 + 0x800;
        const initial = [...mov_ebx(INIT), ...ALL, ...XRSTOR];
        const state = [...fld(DATA), ...fld(DATA + 8), ...movups_load(0, DATA + 16), ...movups_load(7, DATA + 32), ...ldmxcsr(DATA + 48), ...vinsertf128_6(DATA + 64)];
        // the state's x87 registers, XMM0, XMM7, MXCSR and YMM6_H at `out`
        const store_state = out => [...fstp(out), ...fstp(out + 8), ...movups_store(0, out + 16), ...movups_store(7, out + 32), ...stmxcsr(out + 48),
            0xC4, 0xE3, 0x7D, 0x19, 0x35, ...u32(out + 52), 1];                // vextractf128 [out + 52], ymm6, 1
        const check_state = (vm, out, what) => {
            assert.deepEqual(new Float64Array(bytes(vm, out, 16).buffer), Float64Array.of(-2.25, 1.5), `${what}: x87`);
            assert.deepEqual([bytes(vm, out + 16, 32), word(vm, out + 48)], [xmm, 0x1FA0], `${what}: XMM0, XMM7, MXCSR`);
            assert.deepEqual(bytes(vm, out + 52, 16), upper, `${what}: YMM6_H`);
        };
        const data = vm => {
            vm.write_memory(new Uint8Array(new Float64Array([1.5, -2.25]).buffer), DATA);
            vm.write_memory(xmm, DATA + 16);
            vm.write_memory(Uint8Array.from(u32(0x1FA0)), DATA + 48);
            vm.write_memory(Uint8Array.from(u32(0x1F80)), DATA + 52);
            vm.write_memory(upper, DATA + 64);
            prepare(vm, INIT);
            vm.write_memory(Uint8Array.from(u32(0x1F80)), INIT + 24);
        };
        const header = (vm, a) => [word(vm, a + 512), word(vm, a + 516), word(vm, a + 520), word(vm, a + 524)];
        // compacted areas to restore (XSTATE_BV, XCOMP_BV), their legacy region
        // and YMM_Hi128 0CCH
        const compacted = (vm, a, xstate_bv, xcomp_bv) => {
            fill(vm, a, 832, 0xCC);
            vm.write_memory(new Uint8Array(64), a + 512);
            vm.write_memory(Uint8Array.from([...u32(xstate_bv), 0, 0, 0, 0, ...u32(xcomp_bv), 0, 0, 0, 0x80]), a + 512);
        };

        // CPUID.0xD.1 and XGETBV(1), XCR0 AND XINUSE: here exactly the
        // components not in their initial configuration (the SDM lets XINUSE
        // be 1 for one that is; MXCSR is not part of it)
        await run_all([...cpuid(0xD, 1, OUT), ...initial, ...xgetbv(1, OUT + 16),
            ...ldmxcsr(DATA + 48), ...xgetbv(1, OUT + 24), ...fld(DATA), ...xgetbv(1, OUT + 32), ...movups_load(7, DATA + 16), ...xgetbv(1, OUT + 40),
            ...vinsertf128_6(DATA + 64), ...xgetbv(1, OUT + 48), ...xsetbv(3), ...xgetbv(1, OUT + 56), ...cpuid(0xD, 1, OUT + 64), ...xsetbv(7)], data, machines, (vm, run) => {
            no_fault("XGETBV(1), CPUID.0xD.1")(vm, run);
            assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + i)), [15, 832, 0, 0],
                `CPUID.0xD.1 with XCR0 7: XSAVEOPT, XSAVEC, XGETBV1, XSAVES; the compacted size; IA32_XSS bits (${run})`);
            assert.equal(word(vm, OUT + 68), 576, `CPUID.0xD.1:EBX with XCR0 3 (${run})`);
            assert.deepEqual([16, 24, 32, 40, 48, 56].map(o => [word(vm, OUT + o), word(vm, OUT + o + 4)]), [[0, 0], [0, 0], [1, 0], [3, 0], [7, 0], [3, 0]],
                `XGETBV(1): initial, MXCSR alone, x87, XMM7, YMM6_H, XCR0 3 (${run})`);
        });
        count += 4;

        // XSAVEOPT stores what XSAVE does but for the components in their
        // initial configuration (the init optimization; there is no modified
        // one), and MXCSR with RFBM[1] or RFBM[2] whatever XINUSE says
        await run_all([...initial, ...state,
            ...mov_ebx(AREA), ...ALL, ...XSAVE, ...mov_ebx(AREA2), ...ALL, ...XSAVEOPT,
            // all initial but MXCSR: only MXCSR (with MXCSR_MASK), XSTATE_BV 0
            ...initial, ...ldmxcsr(DATA + 48), ...mov_ebx(AREA3), ...ALL, ...XSAVEOPT,
            // x87 in use, RFBM SSE: MXCSR only, XSTATE_BV's other bits kept
            ...fld(DATA), ...mov_ebx(AREA + 0x800), ...mov_eax(2), ...mov_edx(0), ...XSAVEOPT,
            // XRSTOR of the all-initial area: everything initialized, MXCSR loaded
            ...movups_load(7, DATA + 16), ...vinsertf128_6(DATA + 64), ...mov_ebx(AREA3), ...ALL, ...XRSTOR,
            ...movups_store(7, OUT + 64), ...stmxcsr(OUT + 80), ...xgetbv(1, OUT + 88)], vm => {
            data(vm);
            prepare(vm, AREA);
            prepare(vm, AREA2);
            prepare(vm, AREA3, 7);
            prepare(vm, AREA + 0x800, 5);
        }, machines, (vm, run) => {
            no_fault("XSAVEOPT")(vm, run);
            assert.deepEqual(bytes(vm, AREA2, 832), bytes(vm, AREA, 832), `XSAVEOPT with every component in use: XSAVE's area (${run})`);
            const init = bytes(vm, AREA3, 832), view = new DataView(init.buffer);
            assert.ok(init.subarray(0, 24).every(b => b === 0xCC) && init.subarray(32, 288).every(b => b === 0xCC) && init.subarray(576).every(b => b === 0xCC),
                `XSAVEOPT stores no component in its initial configuration (${run})`);
            assert.deepEqual([view.getUint32(24, true), view.getUint32(28, true), view.getUint32(512, true), view.getUint32(516, true)], [0x1FA0, 0xFFFF, 0, 0],
                `XSAVEOPT: MXCSR, MXCSR_MASK, XSTATE_BV 0 (${run})`);
            const partial = bytes(vm, AREA + 0x800, 832), partial_view = new DataView(partial.buffer);
            assert.ok(partial.subarray(0, 24).every(b => b === 0xCC) && partial.subarray(32, 288).every(b => b === 0xCC),
                `XSAVEOPT of SSE alone: neither x87 (not requested) nor XMM (initial) (${run})`);
            assert.deepEqual([partial_view.getUint32(24, true), partial_view.getUint32(512, true)], [0x1FA0, 5], `XSAVEOPT of SSE alone: MXCSR, XSTATE_BV bits 0 and 2 kept (${run})`);
            assert.deepEqual([bytes(vm, OUT + 64, 16), word(vm, OUT + 80), word(vm, OUT + 88)], [new Uint8Array(16), 0x1FA0, 0],
                `XRSTOR of XSAVEOPT's all-initial area (${run})`);
        });
        count += 6;

        // XSAVEC, the compacted form (XCOMP_BV: RFBM with bit 63; YMM_Hi128 at
        // 576 as the only extended component), and XRSTOR of it. XSAVEC stores
        // the components in use, SSE state also when MXCSR is not 1F80H, MXCSR
        // only with SSE state, and no header byte but XSTATE_BV and XCOMP_BV.
        // The compacted XRSTOR loads MXCSR with SSE state only and initializes
        // it to 1F80H with it.
        const C_ALL = AREA, S_ALL = AREA2, C_MXCSR = AREA3, C_NONE = AREA + 0x800, C_YMM = AREA3 + 0x800;
        // (all initial with MXCSR 1FA0H in memory: SSE initialized, MXCSR
        // 1F80H; YMM alone with MXCSR 1FA0H: RFBM 4 keeps MXCSR)
        const R_INIT = 0x207000, R_YMM = 0x207400;
        const header_junk = (vm, a) => vm.write_memory(new Uint8Array(48).fill(0xEE), a + 528);
        await run_all([...initial, ...state,
            ...mov_ebx(C_ALL), ...ALL, ...XSAVEC, ...mov_ebx(S_ALL), ...ALL, ...XSAVE,
            ...mov_ebx(C_YMM), ...mov_eax(4), ...mov_edx(0), ...XSAVEC,
            ...initial, ...ldmxcsr(DATA + 48), ...mov_ebx(C_MXCSR), ...ALL, ...XSAVEC,
            ...initial, ...mov_ebx(C_NONE), ...ALL, ...XSAVEC,
            // the round trip: XRSTOR of XSAVEC's area
            ...initial, ...mov_ebx(C_ALL), ...ALL, ...XRSTOR, ...store_state(OUT + 32),
            // all initial from the compacted form: MXCSR 1F80H, not memory's
            ...state, ...mov_ebx(R_INIT), ...ALL, ...XRSTOR, ...stmxcsr(OUT + 112), ...movups_store(0, OUT + 116),
            // YMM alone (RFBM 4): MXCSR kept
            ...ldmxcsr(DATA + 52), ...mov_ebx(R_YMM), ...mov_eax(4), ...mov_edx(0), ...XRSTOR, ...stmxcsr(OUT + 132)], vm => {
            data(vm);
            for(const a of [C_ALL, S_ALL, C_MXCSR, C_NONE, C_YMM]) prepare(vm, a);
            for(const a of [C_MXCSR, C_NONE, C_YMM]) header_junk(vm, a);
            compacted(vm, R_INIT, 0, 7);
            vm.write_memory(Uint8Array.from(u32(0x1FA0)), R_INIT + 24);
            compacted(vm, R_YMM, 6, 7);
            vm.write_memory(Uint8Array.from(u32(0x1FA0)), R_YMM + 24);
        }, machines, (vm, run) => {
            no_fault("XSAVEC, compacted XRSTOR")(vm, run);
            const all = bytes(vm, C_ALL, 832), standard = bytes(vm, S_ALL, 832);
            assert.deepEqual([all.subarray(0, 512), all.subarray(576)], [standard.subarray(0, 512), standard.subarray(576)],
                `XSAVEC with every component in use: XSAVE's legacy region and YMM_Hi128 (${run})`);
            assert.deepEqual(header(vm, C_ALL), [7, 0, 7, 0x80000000], `XSAVEC: XSTATE_BV, XCOMP_BV (${run})`);
            const ymm_only = bytes(vm, C_YMM, 832);
            assert.ok(ymm_only.subarray(0, 512).every(b => b === 0xCC), `XSAVEC of YMM alone: no legacy-region byte, not MXCSR (${run})`);
            assert.deepEqual(ymm_only.subarray(576 + 96, 576 + 112), standard.subarray(576 + 96, 576 + 112), `XSAVEC of YMM alone: YMM6_H (${run})`);
            assert.deepEqual(header(vm, C_YMM), [4, 0, 4, 0x80000000], `XSAVEC of YMM alone: XSTATE_BV, XCOMP_BV (${run})`);
            assert.ok(ymm_only.subarray(528, 576).every(b => b === 0xEE), `XSAVEC writes no header byte but XSTATE_BV and XCOMP_BV (${run})`);
            const mxcsr_only = bytes(vm, C_MXCSR, 832), mxcsr_view = new DataView(mxcsr_only.buffer);
            assert.ok(mxcsr_only.subarray(0, 24).every(b => b === 0xCC) && mxcsr_only.subarray(32, 160).every(b => b === 0xCC), `XSAVEC: x87 initial, not stored (${run})`);
            assert.deepEqual([mxcsr_view.getUint32(24, true), mxcsr_view.getUint32(28, true)], [0x1FA0, 0xFFFF], `XSAVEC: SSE state for MXCSR 1FA0H (${run})`);
            assert.ok(mxcsr_only.subarray(160, 288).every(b => b === 0), `XSAVEC: SSE state stored, XMM0-7 zero (${run})`);
            assert.ok(mxcsr_only.subarray(288, 512).every(b => b === 0xCC) && mxcsr_only.subarray(576).every(b => b === 0xCC), `XSAVEC: YMM initial, not stored (${run})`);
            assert.deepEqual(header(vm, C_MXCSR), [2, 0, 7, 0x80000000], `XSAVEC: XSTATE_BV SSE (${run})`);
            const none = bytes(vm, C_NONE, 832);
            assert.ok(none.subarray(0, 512).every(b => b === 0xCC) && none.subarray(576).every(b => b === 0xCC), `XSAVEC with every component initial and MXCSR 1F80H: nothing stored (${run})`);
            assert.deepEqual(header(vm, C_NONE), [0, 0, 7, 0x80000000], `XSAVEC with nothing in use: XSTATE_BV 0 (${run})`);
            check_state(vm, OUT + 32, `compacted XRSTOR (${run})`);
            assert.deepEqual([word(vm, OUT + 112), bytes(vm, OUT + 116, 16)], [0x1F80, new Uint8Array(16)], `compacted XRSTOR initializing SSE state: MXCSR 1F80H, XMM0 0 (${run})`);
            assert.equal(word(vm, OUT + 132), 0x1F80, `compacted XRSTOR without RFBM[1]: MXCSR kept (${run})`);
        });
        count += 15;
        // MXCSR's reserved bits: #GP(0) only when SSE state is loaded
        await run_all([...mov_ebx(R_INIT), ...ALL, ...XRSTOR, ...stmxcsr(OUT)], vm => {
            compacted(vm, R_INIT, 0, 7);
            vm.write_memory(Uint8Array.from(u32(0x10000)), R_INIT + 24);
        }, machines, (vm, run) => {
            no_fault("compacted XRSTOR, MXCSR reserved bits without SSE state")(vm, run);
            assert.equal(word(vm, OUT), 0x1F80, `compacted XRSTOR initializes MXCSR, ignoring memory's (${run})`);
        });
        count += 2;

        // XSAVES: XSAVEC's stores and header with RFBM (XCR0 OR IA32_XSS) AND
        // EDX:EAX at CPL 0; XRSTORS of its area; XRSTOR of it (compacted,
        // within XCR0); IA32_XSS (no supervisor state component) reads 0 and
        // takes 0
        const S_XSAVES = 0x207800, RDMSR = [0x0F, 0x32], WRMSR = [0x0F, 0x30];
        await run_all([...initial, ...state,
            ...mov_ebx(C_ALL), ...ALL, ...XSAVEC, ...mov_ebx(S_XSAVES), ...ALL, ...XSAVES,
            ...initial, ...mov_ebx(S_XSAVES), ...ALL, ...XRSTORS, ...store_state(OUT + 32),
            ...initial, ...mov_ebx(S_XSAVES), ...ALL, ...XRSTOR, ...store_state(OUT + 112),
            ...mov_ecx(0xDA0), ...RDMSR, ...store_eax(OUT), ...store_edx(OUT + 4),
            ...mov_ecx(0xDA0), ...mov_eax(0), ...mov_edx(0), ...WRMSR], vm => {
            data(vm);
            prepare(vm, C_ALL);
            prepare(vm, S_XSAVES);
            vm.write_memory(new Uint8Array(8).fill(0xEE), OUT);
        }, machines, (vm, run) => {
            no_fault("XSAVES, XRSTORS, IA32_XSS")(vm, run);
            assert.deepEqual(bytes(vm, S_XSAVES, 832), bytes(vm, C_ALL, 832), `XSAVES: XSAVEC's area (${run})`);
            check_state(vm, OUT + 32, `XRSTORS of XSAVES's area (${run})`);
            check_state(vm, OUT + 112, `XRSTOR of XSAVES's area (${run})`);
            assert.deepEqual([word(vm, OUT), word(vm, OUT + 4)], [0, 0], `RDMSR IA32_XSS (${run})`);
        });
        count += 5;

        // the faults: #UD without CR4.OSXSAVE (before #NM), #NM with CR0.TS,
        // #GP(0) misaligned, 66, F2 and F3 #UD, a register operand #UD
        // (XSAVEC, XSAVES, XRSTORS), the header on an absent page #PF before
        // any byte moves
        const FORMS = [[XSAVEOPT, "XSAVEOPT"], [XSAVEC, "XSAVEC"], [XSAVES, "XSAVES"], [XRSTORS, "XRSTORS"]];
        for(const [instruction, label] of FORMS)
        {
            await expect_fault(machines, [...NO_OSXSAVE, ...SET_TS, ...mov_ebx(AREA)], instruction, 6, { epilogue: CLTS, label: label + " without OSXSAVE, TS set" });
            await expect_fault(machines, [...SET_TS, ...mov_ebx(AREA), ...ALL], instruction, 7, { epilogue: CLTS, label: label + " with TS" });
            await expect_fault(machines, [...mov_ebx(AREA + 16), ...ALL], instruction, 13, { label: label + " misaligned" });
            for(const prefix of [0x66, 0xF2, 0xF3])
            {
                await expect_fault(machines, [...mov_ebx(AREA), ...ALL], [prefix, ...instruction], 6, { label: `${prefix.toString(16)} ${label}` });
            }
            if(instruction[1] === 0xC7)
            {
                await expect_fault(machines, ALL, [0x0F, 0xC7, 0xC3 | instruction[2] & 0x38], 6, { label: label + " with a register operand" });
            }
            const base = ABSENT - 512, restore = instruction === XRSTORS;
            await expect_fault(machines, [...fld(DATA), ...mov_ebx(base), ...ALL], instruction, 14, {
                epilogue: FNINIT, cr2: ABSENT, label: label + " header on an absent page",
                before: vm => {
                    fill(vm, base, 512, 0xCC);
                    pages(vm, ABSENT, false);
                    vm.write_memory(new Uint8Array(new Float64Array([1.5]).buffer), DATA);
                },
                check: (vm, run) => assert.ok(restore || bytes(vm, base, 512).every(b => b === 0xCC), `${label}: no byte stored before the page fault (${run})`),
            });
            for(const vm of machines) pages(vm, ABSENT, true);
        }
        count += 4 * 8 - 1;
        // the header's #GP(0) cases: the compacted XRSTOR (XCR0 3 or 7), and
        // XRSTORS (the standard form, XCOMP_BV beyond XCR0 | IA32_XSS)
        for(const [instruction, xcr0, xstate_bv, xcomp_bv, patch, mxcsr, label] of [
            [XRSTOR, 3, 1, 7, null, 0x1F80, "compacted XRSTOR: XCOMP_BV beyond XCR0"], [XRSTOR, 7, 4, 3, null, 0x1F80, "compacted XRSTOR: XSTATE_BV beyond XCOMP_BV"],
            [XRSTOR, 7, 1, 7, 528, 0x1F80, "compacted XRSTOR: header byte 16"], [XRSTOR, 7, 1, 7, 575, 0x1F80, "compacted XRSTOR: header byte 63"],
            [XRSTOR, 7, 2, 7, null, 0x10000, "compacted XRSTOR: MXCSR reserved bits with SSE state"],
            [XRSTORS, 7, 1, null, null, 0x1F80, "XRSTORS of the standard form"], [XRSTORS, 7, 1, 0xF, null, 0x1F80, "XRSTORS: XCOMP_BV beyond XCR0 | IA32_XSS"],
            [XRSTORS, 7, 4, 3, null, 0x1F80, "XRSTORS: XSTATE_BV beyond XCOMP_BV"], [XRSTORS, 7, 1, 7, 560, 0x1F80, "XRSTORS: header byte 48"]])
        {
            await expect_fault(machines, [...xsetbv(xcr0), ...mov_ebx(R_INIT), ...ALL], instruction, 13, {
                epilogue: xsetbv(7), label,
                before: vm => {
                    if(xcomp_bv === null) prepare(vm, R_INIT, xstate_bv);
                    else compacted(vm, R_INIT, xstate_bv, xcomp_bv);
                    vm.write_memory(Uint8Array.from(u32(mxcsr)), R_INIT + 24);
                    if(patch !== null) vm.write_memory(Uint8Array.of(1), R_INIT + patch);
                },
            });
        }
        count += 9;
        // IA32_XSS takes no supported bit: #GP(0)
        for(const [eax, edx] of [[1, 0], [0x100, 0], [0, 1]])
        {
            await expect_fault(machines, [...mov_ecx(0xDA0), ...mov_eax(eax), ...mov_edx(edx)], WRMSR, 13, { label: `WRMSR IA32_XSS ${edx}:${eax.toString(16)}` });
        }
        count += 3;
    }
    console.log("PASS: XSAVEOPT, XGETBV(1), XSAVEC and the compacted XRSTOR, XSAVES and XRSTORS with IA32_XSS (CPUID.0xD.1, stores, headers, MXCSR, faults)");
    console.log(`PASS: ${count} XSAVE feature set checks on ${COMPILED_ARMS.length + 1} arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
