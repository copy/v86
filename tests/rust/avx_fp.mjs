// AVX floating point in the 32-bit engines (docs/simd-xsave-plan.md 8, P5
// part 3): the VEX form of every SSE/SSE2/SSE3/SSE4.1 floating-point form of
// tests/rust/sse_fp_cases.mjs against the same model (exact rational
// arithmetic, independent of SoftFloat and cpu/simd_fp.rs), with VEX's
// operands: the destination XMM2, the first source XMM1, the second XMM0 or
// memory; VCMPPS/PD/SS/SD with all 32 predicates. Each case sets MXCSR (the
// four rounding modes, DAZ, FZ, masked and unmasked exceptions) and checks
// the destination, MXCSR and the fault: #XM, or #UD without
// CR4.OSXMMEXCPT, with the destination unchanged. Every case runs in the
// interpreter, then hot under the page tier and the region tiers (the AVX helper).
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { FORMS, MXCSRS, bytes128, cases, expect } from "./sse_fp_cases.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x300000, FAULTS = 0x3F0000, CASE = 0x3FF000, SKIP = 0x3FF004;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
// (the destination's value before: unchanged by a faulting instruction)
const BEFORE = 0x5A5A5A5A_A5A5A5A5_12345678_9ABCDEF0n;

const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
const movdqu_load = (r, a) => [0xF3, 0x0F, 0x6F, 0x05 | r << 3, ...u32(a)];
const movdqu_store = (r, a) => [0xF3, 0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
// (VEX.256 VMOVDQU)
const vmovdqu_load = (r, a) => [0xC5, 0xFE, 0x6F, 0x05 | r << 3, ...u32(a)];
const vmovdqu_store = (r, a) => [0xC5, 0xFE, 0x7F, 0x05 | r << 3, ...u32(a)];
const store_eax = a => [0xA3, ...u32(a)];
const OSXSAVE = 1 << 18;
const xsetbv = value => [0xB9, ...u32(0), 0xB8, ...u32(value), 0xBA, ...u32(0), 0x0F, 0x01, 0xD1];

// The VEX forms: those of the legacy ones with XMM operands. `operands`: the
// first source (VEX.vvvv) or none ("two"), a flags result ("comi"), a
// general-purpose destination (ECX) or source (EAX)
const VEX_FORMS = FORMS.filter(form => !["from_mmx", "to_mmx"].includes(form.kind)).map(form => {
    const two = ["from_dwords", "to_dwords"].includes(form.kind) ||
        !form.scalar && (form.op === "sqrt" || ["reciprocal", "widen", "narrow", "round"].includes(form.kind));
    const operands = ["comi", "to_gpr", "from_gpr"].includes(form.kind) ? form.kind : two ? "two" : "three";
    return { ...form, name: "v" + form.name, operands, pp: { "": 0, 102: 1, 243: 2, 242: 3 }[form.prefix.join()], vex_map: form.map === 0x3A ? 3 : 1 };
});
// P6 part 2: the VEX.256 forms, of the packed ones but VDPPD
const VEX256_FORMS = VEX_FORMS.filter(f => !f.scalar && ["two", "three"].includes(f.operands) && f.name !== "vdppd")
    .map(f => ({ ...f, name: f.name + " ymm", l: 1 }));
const BEFORE256 = BEFORE | BEFORE << 128n;
/** A VEX.256 form's cases: two of its VEX.128 form's in one (the second in
 * the high half; VCVTPS2PD's and VCVTDQ2PD's XMM source: the first's), the
 * model over all lanes with one exception context */
function cases256(form)
{
    const list = cases(form);
    const xmm_source = form.kind === "widen" || form.kind === "from_dwords" && form.double;
    return Array.from({ length: list.length >> 1 }, (_, k) => {
        const [c, d] = [list[2 * k], list[2 * k + 1]];
        const a = c.a | d.a << 128n, b = xmm_source ? c.b : c.b | d.b << 128n;
        const imm8 = form.kind === "compare" ? (k * 5 + 3) & 31 : c.imm8;
        return { mxcsr: c.mxcsr, a, b, imm8, ...expect(form, c.mxcsr, a, b, imm8, 256) };
    });
}
/** The instruction: destination XMM2 (ECX; XMM1 for VCOMIS), VEX.vvvv XMM1,
 * r/m XMM0 (EAX) or [source]; both VEX prefixes (`three`) */
function instruction(form, memory, source, imm8, three)
{
    const reg = form.operands === "comi" ? 1 : form.operands === "to_gpr" ? 1 : 2;
    const vvvv = ["three", "from_gpr"].includes(form.operands) ? 1 : 0;
    const modrm = memory ? [0x05 | reg << 3, ...u32(source)] : [0xC0 | reg << 3 | 0];
    const tail = [form.code, ...modrm, ...(form.imm8 ? [imm8] : [])];
    const fields = (~vvvv & 15) << 3 | (form.l ? 4 : 0) | form.pp;
    if(form.vex_map === 1 && !three) return [0xC5, 0x80 | fields, ...tail];
    return [0xC4, 0xE0 | form.vex_map, fields, ...tail];
}
function program(form, memory, list)
{
    const p = [];
    list.forEach((c, n) => {
        const base = DATA + n * 64;
        p.push(0xC7, 0x05, ...u32(CASE), ...u32(n));
        p.push(...ldmxcsr(base + 32));
        // XMM1: the first source; XMM2 (ECX): the destination's value before; XMM0 (EAX): the second source
        p.push(...movdqu_load(1, base), ...movdqu_load(2, base + 48));
        if(form.operands === "to_gpr") p.push(0xB9, ...u32(0x5A5A5A5A));
        if(!memory) p.push(...form.operands === "from_gpr" ? [0xB8, ...u32(Number(c.b & 0xFFFFFFFFn))] : movdqu_load(0, base + 16));
        // (the handler skips the instruction: its length, by its VEX prefix)
        const vex = instruction(form, memory, base + 16, c.imm8, n & 1);
        p.push(0xC7, 0x05, ...u32(SKIP), ...u32(vex.length), ...vex);
        p.push(...stmxcsr(OUT + n * 32 + 16));
        if(form.operands === "comi") p.push(0x9C, 0x58, ...store_eax(OUT + n * 32));
        else if(form.operands === "to_gpr") p.push(0x89, 0x0D, ...u32(OUT + n * 32));
        else p.push(...movdqu_store(2, OUT + n * 32));
    });
    return p;
}

/** A VEX.256 form's program: YMM1 the first source, YMM2 the destination's
 * value before, YMM0 or [source] the second source; 128 bytes of data and 64
 * of results per case */
function program256(form, memory, list)
{
    const p = [];
    list.forEach((c, n) => {
        const base = DATA + n * 128;
        p.push(0xC7, 0x05, ...u32(CASE), ...u32(n));
        p.push(...ldmxcsr(base + 64));
        p.push(...vmovdqu_load(1, base), ...vmovdqu_load(2, base + 96));
        if(!memory) p.push(...vmovdqu_load(0, base + 32));
        const vex = instruction(form, memory, base + 32, c.imm8, n & 1);
        p.push(0xC7, 0x05, ...u32(SKIP), ...u32(vex.length), ...vex);
        p.push(...stmxcsr(OUT + n * 64 + 32));
        p.push(...vmovdqu_store(2, OUT + n * 64));
    });
    return p;
}

const machines = [];
async function run(vm, code, warm, interpreter, until)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(Uint8Array.from(code), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 60000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && (compiled_activations(e) === start || !until(vm)))
    {
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it for the case, skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58);
    p.push(0xA1, ...u32(CASE), 0xC7, 0x04, 0x85, ...u32(FAULTS), ...u32(vector)); // mov [FAULTS + eax*4], vector
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true], [19, false]];
async function create_machines()
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 64 << 20,
            cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"], cpu_features_unreleased: true,
            ...arm, disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
        set.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    return set;
}
/** The build has Wasm SIMD (the portable one's regions decline XMM state) */
const simd = vm => vm.v86.cpu.wm.exports["ir_wasm_simd_supported"]() !== 0;

let total = 0;
try
{
    machines.push(...await create_machines());
    for(const xmm_exceptions of [true, false])
    {
        // CR4.OSFXSR (the legacy loads and stores), OSXSAVE, OSXMMEXCPT (else
        // unmasked exceptions are #UD); XCR0 7; CR0.TS clear
        const cr4 = [0x0F, 0x20, 0xE0, 0x0D, ...u32(OSXSAVE | (xmm_exceptions ? 0x600 : 0x200)), ...(xmm_exceptions ? [] : [0x25, ...u32(~0x400 >>> 0)]), 0x0F, 0x22, 0xE0];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0x0F, 0x06, ...cr4, ...xsetbv(7)];
        for(const form of xmm_exceptions ? [...VEX_FORMS, ...VEX256_FORMS] : VEX_FORMS.filter(f => f.kind === "binary" && !f.double))
        {
            // (AVX_FP_ONLY=name: one form, for debugging)
            if(process.env.AVX_FP_ONLY && form.name !== process.env.AVX_FP_ONLY) continue;
            // (a VEX.256 form: 128 bytes of data and 64 of results per case)
            const [stride, out_stride] = form.l ? [128, 64] : [64, 32];
            for(const memory of [false, true])
            {
                // (VCMP*: the 32 predicates)
                const list = form.l ? cases256(form) : cases(form).map((c, n) => form.kind !== "compare" ? c :
                    { ...c, imm8: (n * 5 + 3) & 31, ...expect(form, c.mxcsr, c.a, c.b, (n * 5 + 3) & 31) });
                const code = loop([...prologue, ...(form.l ? program256 : program)(form, memory, list)]);
                const data = new Uint8Array(list.length * stride);
                const bytes = (v, n) => Uint8Array.from({ length: n }, (_, i) => Number(v >> BigInt(8 * i) & 0xFFn));
                list.forEach((c, n) => {
                    if(form.l)
                    {
                        data.set(bytes(c.a, 32), n * 128);
                        data.set(bytes(c.b, 32), n * 128 + 32);
                        data.set(u32(c.mxcsr), n * 128 + 64);
                        data.set(bytes(BEFORE256, 32), n * 128 + 96);
                        return;
                    }
                    data.set(bytes128(c.a), n * 64);
                    data.set(bytes128(c.b), n * 64 + 16);
                    data.set(u32(c.mxcsr), n * 64 + 32);
                    data.set(bytes128(BEFORE), n * 64 + 48);
                });
                // (every run: the cold one is mostly interpreted, the program was rewritten)
                const runs = [];
                for(const [m, vm] of machines.entries())
                {
                    vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
                    VECTORS.forEach(([vector, error_code], i) => {
                        const h = HANDLER + i * 0x100;
                        vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
                        vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
                    });
                    const e = vm.v86.cpu.wm.exports;
                    e.ir_avx_calls_reset();
                    for(const warm of [true, false])
                    {
                        vm.write_memory(data, DATA);
                        vm.write_memory(new Uint8Array(list.length * out_stride), OUT);
                        vm.write_memory(new Uint8Array(list.length * 4), FAULTS);
                        vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
                        // (the region tiers ran the VEX forms: wait for the AVX helpers,
                        // which these operands go through, natively lifted forms too)
                        await run(vm, code, warm, vm === machines[0], vm => vm !== machines[2] || !simd(vm) || e.ir_avx_calls() >= list.length);
                        runs.push({ run: `machine ${m} ${warm ? "hot" : "one round"}`, out: Uint8Array.from(vm.read_memory(OUT, list.length * out_stride)),
                            faults: Uint8Array.from(vm.read_memory(FAULTS, list.length * 4)) });
                    }
                }
                for(const { run, out, faults: fault_bytes } of runs)
                {
                    const faults = new DataView(fault_bytes.buffer);
                    const view = new DataView(out.buffer);
                    list.forEach((c, n) => {
                        const label = `${form.name}${memory ? " [mem]" : ""} case ${n} on ${run}: mxcsr ${c.mxcsr.toString(16)} a ${c.a.toString(16)} b ${c.b.toString(16)}${form.imm8 ? " imm8 " + c.imm8 : ""}`;
                        const vector = faults.getUint32(n * 4, true);
                        assert.equal(vector, c.fault ? xmm_exceptions ? 19 : 6 : 0, label + ": fault");
                        if(form.l)
                        {
                            // (all 256 bits; a faulting instruction leaves them alone)
                            assert.equal(view.getUint32(n * 64 + 32, true), c.after, label + ": MXCSR");
                            const actual = [0, 1, 2, 3].reduce((v, q) => v | view.getBigUint64(n * 64 + 8 * q, true) << BigInt(64 * q), 0n);
                            assert.equal(actual.toString(16), (c.fault ? BEFORE256 : c.result).toString(16), label + ": result");
                            return;
                        }
                        assert.equal(view.getUint32(n * 32 + 16, true), c.after, label + ": MXCSR");
                        // a faulting instruction leaves its destination alone
                        let actual, expected;
                        if(form.operands === "comi")
                        {
                            actual = BigInt(view.getUint32(n * 32, true) & 0x8D5);
                            expected = c.fault ? undefined : BigInt(c.result);
                        }
                        else if(form.operands === "to_gpr")
                        {
                            actual = BigInt(view.getUint32(n * 32, true));
                            expected = c.fault ? 0x5A5A5A5An : c.result & 0xFFFFFFFFn;
                        }
                        else
                        {
                            actual = view.getBigUint64(n * 32, true) | view.getBigUint64(n * 32 + 8, true) << 64n;
                            expected = c.fault ? BEFORE : c.result;
                        }
                        if(expected !== undefined) assert.equal(actual.toString(16), expected.toString(16), label + ": result");
                    });
                }
                total += list.length;
            }
        }
        console.log(`PASS: ${xmm_exceptions ? "all forms, unmasked exceptions as #XM" : "unmasked exceptions as #UD without CR4.OSXMMEXCPT"}`);
    }
    console.log(`PASS: ${total} exact AVX floating-point cases (${VEX_FORMS.length} VEX.128 and VEX.LIG forms, ${VEX256_FORMS.length} VEX.256 ones, register and memory sources, ${MXCSRS.length} MXCSR settings) match the model on 3 arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
