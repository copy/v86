// Decode rules shared by the 32-bit interpreter and the page tier
// (docs/simd-xsave-plan.md 5.2): which row the 66/F2/F3 prefixes select
// (decode_rules::mandatory_variant), the order of repeated F2/F3, #UD for a
// mandatory prefix without a row of its own, the three-byte maps and VEX.
// Each case runs in the interpreter, then hot under the page tier.
// (tests/decode/vex_modes.mjs: C4/C5 by mode.)
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x210000;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
const machines = [];
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const load = (r, a) => [0xF3, 0x0F, 0x6F, 5 | r << 3, ...u32(a)];
const store = (r, a) => [0xF3, 0x0F, 0x7F, 5 | r << 3, ...u32(a)];

// (machines[0] of a set is the interpreter: it compiles nothing)
async function run(vm, program, warm = true, interpreter = vm === machines[0])
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
    if(warm) await sleep(20);
    await vm.stop();
}
// SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
const ENABLE_SSE = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0];
// the body repeats until byte 0x604 is set, then halts after one more round
function loop(body)
{
    const p = [...ENABLE_SSE, ...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** Runs `program` on each machine of `set`, hot, then once more cold (the
 * cold run is mostly interpreted: the program was rewritten);
 * `verify(vm, run)` checks after each run */
async function run_all(program, before = () => {}, set = machines, verify = () => {})
{
    for(const [i, vm] of set.entries())
    {
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, program, warm, vm === set[0]);
            verify(vm, `machine ${i} ${warm ? "hot" : "one round"}`);
        }
    }
}
/** The interpreter, then the page tier, with `options` */
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
/** Each form raises #UD at its first byte (the handler skips the form) */
async function expect_undefined(forms, set = machines)
{
    for(const form of forms)
    {
        const h = [0x8B, 0x44, 0x24, 0, 0xA3, ...u32(OUT), 0x83, 0x44, 0x24, 0, form.length, 0xCF];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0xB8, ...u32(DATA)];
        const fault_eip = CODE + ENABLE_SSE.length + prologue.length;
        await run_all(loop([...prologue, ...form]), vm => {
            vm.write_memory(Uint8Array.from([HANDLER & 255, HANDLER >>> 8 & 255, 8, 0, 0, 0x8E, HANDLER >>> 16 & 255, HANDLER >>> 24]), IDT + 6 * 8);
            vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
            vm.write_memory(Uint8Array.from(h), HANDLER);
            vm.write_memory(new Uint8Array(4), OUT);
        }, set, (vm, run) => assert.equal(word(vm, OUT), fault_eip, `${form.map(b => b.toString(16)).join(" ")} (${run}): #UD at the first byte`));
    }
}

try
{
    machines.push(...await create_machines());

    // 66 with F2/F3 is an operand-size prefix; of F2 and F3 the last counts.
    // MOVSS/MOVSD between registers replace the low 32/64 bits only.
    const data = new Uint8Array(64);
    for(let i = 0; i < data.length; i++) data[i] = i * 29 + 7 & 255;
    const moves = [
        [[], 16], [[0x66], 16], [[0x66, 0xF3], 4], [[0xF3, 0x66], 4], [[0x66, 0xF2], 8], [[0xF2, 0x66], 8],
        [[0xF2, 0xF3], 4], [[0xF3, 0xF2], 8], [[0xF2, 0xF3, 0x66], 4], [[0x66, 0xF3, 0xF2], 8],
    ];
    const p = [];
    for(const [n, [prefixes]] of moves.entries())
    {
        p.push(...load(0, DATA), ...load(1, DATA + 16), ...prefixes, 0x0F, 0x10, 0xC1, ...store(0, OUT + n * 16));
    }
    await run_all(loop(p), vm => vm.write_memory(data, DATA), machines, (vm, run) => {
        const bytes = Uint8Array.from(vm.read_memory(OUT, moves.length * 16));
        for(const [n, [prefixes, low]] of moves.entries())
        {
            const expected = data.slice(0, 16);
            expected.set(data.slice(16, 16 + low));
            assert.deepEqual(bytes.slice(n * 16, n * 16 + 16), expected, `0F 10 with ${prefixes.map(b => b.toString(16)).join(" ")} (${run})`);
        }
    });
    console.log(`PASS: ${moves.length} 0F 10 prefix orders select MOVUPS/MOVUPD/MOVSS/MOVSD as iced-x86 does, on ${machines.length} arms`);

    // REPE/REPNE CMPSB: the last of F2/F3 decides
    const strings = new Uint8Array(64);
    strings.set([5, 5, 5, 7, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0);
    strings.set([5, 5, 5, 9, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], 32);
    const reps = [[[0xF3], 12, 4], [[0xF2], 15, 1], [[0xF2, 0xF3], 12, 4], [[0xF3, 0xF2], 15, 1]];
    const q = [0xFC];
    for(const [n, [prefixes]] of reps.entries())
    {
        q.push(0xBE, ...u32(DATA), 0xBF, ...u32(DATA + 32), 0xB9, ...u32(16), ...prefixes, 0xA6,
            0x89, 0x0D, ...u32(OUT + n * 8), 0x89, 0x35, ...u32(OUT + n * 8 + 4));
    }
    await run_all(loop(q), vm => vm.write_memory(strings, DATA), machines, (vm, run) => {
        for(const [n, [prefixes, ecx, advanced]] of reps.entries())
        {
            assert.equal(word(vm, OUT + n * 8), ecx, `CMPSB with ${prefixes} ECX (${run})`);
            assert.equal(word(vm, OUT + n * 8 + 4), DATA + advanced, `CMPSB with ${prefixes} ESI (${run})`);
        }
    });
    console.log(`PASS: ${reps.length} REPE/REPNE CMPSB prefix orders`);

    // A mandatory prefix without a row of its own is #UD at the first prefix
    // byte; outside the SSE maps F2/F3 are ignored repeat prefixes.
    const undefined_forms = [
        [0xF3, 0x0F, 0x2B, 0x00], [0xF2, 0x0F, 0x2B, 0x00], // MOVNTPS (F3: AMD's MOVNTSS)
        [0x66, 0x0F, 0xC3, 0x00], [0xF3, 0x0F, 0xC3, 0x00], // MOVNTI
        [0xF2, 0x0F, 0x77], [0x66, 0x0F, 0x77],             // EMMS
        [0x66, 0x0F, 0xAE, 0x00], [0xF2, 0x0F, 0xAE, 0x00], // FXSAVE
    ];
    await expect_undefined(undefined_forms);
    // IMUL r32, r/m32 with F3: a repeat prefix, ignored
    await run_all(loop([0xB8, ...u32(7), 0xB9, ...u32(6), 0xF3, 0x0F, 0xAF, 0xC1, 0xA3, ...u32(OUT)]), undefined, machines,
        (vm, run) => assert.equal(word(vm, OUT), 42, `F3 IMUL (${run})`));
    console.log(`PASS: ${undefined_forms.length} undefined mandatory prefixes raise #UD, F3 IMUL ignores the prefix`);

    // The three-byte maps decode in the interpreter and the page tier. SSSE3
    // (P3) and SSE4 (P4b) are #UD without their feature; every other encoding
    // is #UD until its semantics come (docs/simd-xsave-plan.md), whether or
    // not the machine has its CPUID feature; so are F2/F3 at the SSSE3
    // opcodes, F3 at CRC32's and an opcode byte without rows
    const featured_forms = [
        [0x66, 0x0F, 0x38, 0x00, 0xC1], [0x0F, 0x38, 0x00, 0xC1],                  // pshufb
        [0x66, 0x0F, 0x3A, 0x0F, 0xC1, 0x08], [0x0F, 0x3A, 0x0F, 0xC1, 0x08],      // palignr
        [0x66, 0x0F, 0x3A, 0x62, 0x00, 0x04], [0x66, 0x0F, 0x3A, 0x63, 0xC1, 0x0C], // pcmpistrm, pcmpistri
        [0xF2, 0x0F, 0x38, 0xF1, 0xC1], [0x66, 0xF2, 0x0F, 0x38, 0xF1, 0xC1],      // crc32
    ];
    await expect_undefined(featured_forms);
    const three_byte = [
        [0xF3, 0x0F, 0x38, 0x00, 0xC1], [0x66, 0xF2, 0x0F, 0x3A, 0x0F, 0xC1, 0x08], // pshufb, palignr
        [0x0F, 0x38, 0xF0, 0x00], [0xF3, 0x0F, 0x38, 0xF0, 0x00],                  // movbe, F3 at crc32
        [0x0F, 0x38, 0x10, 0xC1], [0x0F, 0x38, 0xFF, 0xC1], [0x0F, 0x3A, 0xFF, 0xC1, 0x00], // no row
    ];
    await expect_undefined(three_byte);

    // VEX (C4/C5 with a register ModRM byte in protected mode): #UD without
    // the features, and with them the AVX forms while the AVX state is off
    // (CR4.OSXSAVE, as here; tests/rust/avx.mjs), but ANDN (BMI1, P10: no AVX
    // state, tests/rust/bmi.mjs); so are 66/F2/F3/LOCK before VEX, VEX.vvvv
    // other than 1111b where it is no operand, the reserved maps and opcodes
    // without rows
    const vex = [
        [0xC5, 0xF8, 0x77], [0xC4, 0xE1, 0x7C, 0x77],                 // vzeroupper, vzeroall
        [0xC4, 0xE2, 0x79, 0x18, 0x00], [0xC4, 0xE2, 0x78, 0xF2, 0xC1], // vbroadcastss xmm0, [eax]; andn
        [0xC4, 0xE3, 0x79, 0x4A, 0xC1, 0x20], [0xC4, 0xE2, 0x61, 0x90, 0x14, 0x88], // vblendvps, vpgatherdd
        [0xC5, 0xF0, 0x77], [0x66, 0xC5, 0xF8, 0x77], [0xF3, 0xC5, 0xF8, 0x77], [0xF0, 0xC5, 0xF8, 0x77],
        [0xC4, 0xE0, 0x78, 0x77], [0xC5, 0xF8, 0x00],
    ];
    await expect_undefined(vex);
    // ... and with a memory ModRM byte, LES and LDS
    const far = [0x8C, 0x1D, ...u32(DATA + 4), 0xC7, 0x05, ...u32(DATA), ...u32(0x12345678),
        0xC4, 0x1D, ...u32(DATA), 0x89, 0x1D, ...u32(OUT), 0x8C, 0x05, ...u32(OUT + 4),
        0xC5, 0x0D, ...u32(DATA), 0x89, 0x0D, ...u32(OUT + 8), 0x1E, 0x07];
    await run_all(loop(far), undefined, machines, (vm, run) => {
        assert.equal(word(vm, OUT), 0x12345678, `LES (${run})`);
        assert.equal(word(vm, OUT + 4) & 0xFFFF, word(vm, DATA + 4) & 0xFFFF, `LES: ES (${run})`);
        assert.equal(word(vm, OUT + 8), 0x12345678, `LDS (${run})`);
    });
    // TZCNT and LZCNT without their features: BSF and BSR
    const bit_scans = loop([0xB9, ...u32(0x810000), 0xF3, 0x0F, 0xBC, 0xC1, 0xA3, ...u32(OUT), 0xF3, 0x0F, 0xBD, 0xC1, 0xA3, ...u32(OUT + 4)]);
    await run_all(bit_scans, undefined, machines,
        (vm, run) => assert.deepEqual([word(vm, OUT), word(vm, OUT + 4)], [16, 23], `F3 BSF, F3 BSR (${run})`));

    // With the features (P10): TZCNT and LZCNT; MOVBE and ANDN run
    // (tests/rust/bmi.mjs), the other forms stay #UD
    const featured = await create_machines({ cpu_type: "x86_64", cpu_features: "x86-64-v3", cpu_features_unreleased: true });
    try
    {
        const runs = [[0x0F, 0x38, 0xF0, 0x00], [0xC4, 0xE2, 0x78, 0xF2, 0xC1]].map(form => form.join());
        await expect_undefined([...three_byte, ...vex].filter(form => !runs.includes(form.join())), featured);
        await run_all(bit_scans, undefined, featured,
            (vm, run) => assert.deepEqual([word(vm, OUT), word(vm, OUT + 4)], [16, 8], `TZCNT, LZCNT (${run})`));
    }
    finally
    {
        for(const vm of featured) await vm.destroy();
    }
    console.log(`PASS: ${featured_forms.length} SSSE3 and SSE4.2 encodings raise #UD without their features; ${three_byte.length} three-byte map and ${vex.length} VEX encodings without their features, all but MOVBE and ANDN also with them; ` +
        "LES/LDS with a memory operand; F3 0F BC/BD are BSF/BSR without BMI1/LZCNT and TZCNT/LZCNT with them");
}
finally
{
    for(const vm of machines) await vm.destroy();
}
