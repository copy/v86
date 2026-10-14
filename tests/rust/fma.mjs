// FMA and F16C in the 32-bit engines (docs/simd-xsave-plan.md 9.3, P11)
// against tests/rust/sse_fp_model.mjs (exact rational arithmetic, independent
// of SoftFloat and cpu/simd_fp.rs). Every FMA form (VFMADD, VFMSUB, VFNMADD,
// VFNMSUB 132/213/231 PS/PD/SS/SD; VFMADDSUB, VFMSUBADD 132/213/231 PS/PD;
// VEX.128 and VEX.256) with the destination XMM2/YMM2, also the first
// source, VEX.vvvv XMM1/YMM1 and the third source XMM0/YMM0 or memory; and
// VCVTPH2PS and VCVTPS2PH with every rounding control. Each case sets MXCSR
// (the rounding modes, DAZ, FZ, masked and unmasked exceptions) and checks
// the destination, MXCSR and the fault: #XM, or #UD without CR4.OSXMMEXCPT,
// with the destination unchanged. The values: special ones; NaNs with
// distinct payloads in two or three operands (the first of the operation's
// x, y, z wins); 0 × ∞ with a QNaN addend (no IE), an SNaN one or a number;
// random ones; and products whose rounding error the addend exposes (one
// rounding gives the error, a rounded product added gives 0). Every case
// runs in the interpreter, then hot under the page tier and the region tiers (the
// AVX helper). Without the features, CPUID reports neither and the forms #UD.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { MXCSRS } from "./sse_fp_cases.mjs";
import { FMA_FORMS, F16C_FORMS, fma_cases, f16c_cases, fma_expect } from "./fma_cases.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x300000, FAULTS = 0x3F0000, CASE = 0x3FF000, SKIP = 0x3FF004;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
// (the destination's value before: unchanged by a faulting instruction)
const BEFORE = 0x5A5A5A5A_A5A5A5A5_12345678_9ABCDEF0n;
// (a VEX.128 FMA form's destination's bits 255:128 before: zeroed)
const UPPER = 0x0123456789ABCDEF_FEDCBA9876543210n << 128n;
const BEFORE256 = BEFORE | BEFORE << 128n;
const bytes = (v, n) => Uint8Array.from({ length: n }, (_, i) => Number(v >> BigInt(8 * i) & 0xFFn));

const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
// VMOVDQU xmm/ymm loads and stores (VEX.128 zeroes bits 255:128)
const vmovdqu_load = (r, a, l) => [0xC5, 0xFA | l << 2, 0x6F, 0x05 | r << 3, ...u32(a)];
const vmovdqu_store = (r, a, l) => [0xC5, 0xFA | l << 2, 0x7F, 0x05 | r << 3, ...u32(a)];
const OSXSAVE = 1 << 18;
const xsetbv = value => [0xB9, ...u32(0), 0xB8, ...u32(value), 0xBA, ...u32(0), 0x0F, 0x01, 0xD1];

/** The instruction (three-byte VEX): reg, VEX.vvvv, r/m XMM0/YMM0 or [address] */
function vex(map, w, vvvv, l, op, reg, address, imm8)
{
    const modrm = address === undefined ? [0xC0 | reg << 3] : [0x05 | reg << 3, ...u32(address)];
    return [0xC4, 0xE0 | map, w << 7 | (~vvvv & 15) << 3 | l << 2 | 1, op, ...modrm, ...(imm8 === undefined ? [] : [imm8])];
}
/** A form's program and its data: per case 128 bytes of data (a, b, c or
 * the source, MXCSR) and 64 of results (the destination, MXCSR) */
function program(form, memory, list)
{
    const p = [], data = new Uint8Array(list.length * 128);
    list.forEach((c, n) => {
        const base = DATA + n * 128, out = OUT + n * 64, l = form.l;
        p.push(0xC7, 0x05, ...u32(CASE), ...u32(n));
        p.push(...ldmxcsr(base + 96));
        let instruction;
        if(form.op !== undefined)
        {
            // YMM2/XMM2 the destination (a), YMM1/XMM1 VEX.vvvv (b), YMM0/XMM0 or [base + 64] (c)
            p.push(...vmovdqu_load(2, base, 1), ...vmovdqu_load(1, base + 32, 1));
            if(!memory) p.push(...vmovdqu_load(0, base + 64, 1));
            instruction = vex(2, +form.double, 1, l, form.op, 2, memory ? base + 64 : undefined);
            data.set(bytes(l ? c.a : c.a | UPPER, 32), n * 128);
            data.set(bytes(c.b, 32), n * 128 + 32);
            data.set(bytes(c.c, 32), n * 128 + 64);
        }
        else if(form.kind === "ph2ps")
        {
            // YMM2 the destination (BEFORE), XMM0 or [base + 64] the halves
            p.push(...vmovdqu_load(2, base, 1));
            if(!memory) p.push(...vmovdqu_load(0, base + 64, 1));
            instruction = vex(2, 0, 0, l, 0x13, 2, memory ? base + 64 : undefined);
            data.set(bytes(BEFORE256, 32), n * 128);
            data.set(bytes(c.source, 16), n * 128 + 64);
        }
        else
        {
            // YMM2 the singles, YMM0 or [base + 64] the destination (BEFORE)
            p.push(...vmovdqu_load(2, base, 1), ...vmovdqu_load(0, base + 64, 1));
            instruction = vex(3, 0, 0, l, 0x1D, 2, memory ? base + 64 : undefined, c.imm8);
            data.set(bytes(c.source, 32), n * 128);
            data.set(bytes(BEFORE256, 32), n * 128 + 64);
        }
        data.set(u32(c.mxcsr), n * 128 + 96);
        p.push(0xC7, 0x05, ...u32(SKIP), ...u32(instruction.length), ...instruction);
        p.push(...stmxcsr(out + 32));
        // (the destination: YMM2, YMM0 or the memory at base + 64)
        if(form.kind === "ps2ph") p.push(...memory ? [...vmovdqu_load(3, base + 64, 1), ...vmovdqu_store(3, out, 1)] : vmovdqu_store(0, out, 1));
        else p.push(...vmovdqu_store(2, out, 1));
    });
    return { code: p, data };
}

const machines = [];
async function run(vm, code, warm, interpreter, until)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    // (the page tier's step counts are the hot run's: x64_page_steps)
    else e["x64_page_steps_freeze"]();
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
/** The build has Wasm SIMD */
const simd = vm => vm.v86.cpu.wm.exports["ir_wasm_simd_supported"]() !== 0;
async function create_machines(cpu_features)
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 64 << 20,
            cpu_features, cpu_features_unreleased: true,
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
/** Runs `code` with `data` hot then once more on every machine: per run the
 * results and the faults of `count` cases. The region tiers' hot run waits
 * for `settled` (by default the AVX helper's calls, one per case). */
async function run_all(code, data, count, settled = e => e.ir_avx_calls() >= count)
{
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
            vm.write_memory(new Uint8Array(count * 64), OUT);
            vm.write_memory(new Uint8Array(count * 4), FAULTS);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            // (the region tiers ran the forms: wait for the AVX helper's calls,
            // but in a build without Wasm SIMD, whose regions decline XMM state)
            await run(vm, code, warm, vm === machines[0], vm => vm !== machines[2] || !simd(vm) || settled(e));
            runs.push({ run: `machine ${m} ${warm ? "hot" : "one round"}`, out: Uint8Array.from(vm.read_memory(OUT, count * 64)),
                faults: new DataView(Uint8Array.from(vm.read_memory(FAULTS, count * 4)).buffer) });
        }
    }
    return runs;
}

let total = 0;
try
{
    // Without the features (AVX only): CPUID reports neither, the forms #UD
    machines.push(...await create_machines(["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"]));
    {
        const cr4 = [0x0F, 0x20, 0xE0, 0x0D, ...u32(OSXSAVE | 0x600), 0x0F, 0x22, 0xE0];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0x0F, 0x06, ...cr4, ...xsetbv(7)];
        const forms = [vex(2, 0, 1, 0, 0x98, 2), vex(2, 1, 1, 1, 0xB8, 2), vex(2, 0, 1, 0, 0xB9, 2), vex(2, 0, 0, 0, 0x13, 2), vex(3, 0, 0, 1, 0x1D, 2, undefined, 4)];
        const p = [0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT + 0x100)];
        forms.forEach((f, n) => p.push(0xC7, 0x05, ...u32(CASE), ...u32(n), 0xC7, 0x05, ...u32(SKIP), ...u32(f.length), ...f));
        const runs = await run_all(loop([...prologue, ...p]), new Uint8Array(0), forms.length, () => true);
        for(const { run, out, faults } of runs)
        {
            assert.equal(new DataView(out.buffer).getUint32(0x100, true) & (1 << 12 | 1 << 29), 0, `CPUID.1:ECX FMA, F16C (${run})`);
            forms.forEach((_, n) => assert.equal(faults.getUint32(n * 4, true), 6, `form ${n} without its feature (${run}): #UD`));
        }
        for(const vm of machines) await vm.destroy();
        machines.length = 0;
        console.log("PASS: without FMA and F16C, CPUID reports neither and their forms are #UD");
    }

    machines.push(...await create_machines(["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "FMA", "F16C"]));
    for(const xmm_exceptions of [true, false])
    {
        // CR4.OSXSAVE, OSXMMEXCPT (else unmasked exceptions are #UD); XCR0 7; CR0.TS clear
        const cr4 = [0x0F, 0x20, 0xE0, 0x0D, ...u32(OSXSAVE | (xmm_exceptions ? 0x600 : 0x200)), ...(xmm_exceptions ? [] : [0x25, ...u32(~0x400 >>> 0)]), 0x0F, 0x22, 0xE0];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0x0F, 0x06, ...cr4, ...xsetbv(7)];
        const forms = xmm_exceptions ? [...FMA_FORMS, ...F16C_FORMS] : FMA_FORMS.filter(f => f.name.startsWith("vfmadd231"));
        for(const form of forms)
        {
            // (FMA_ONLY=name[,name...]: those forms, for debugging)
            if(process.env.FMA_ONLY && !process.env.FMA_ONLY.split(",").includes(form.name)) continue;
            for(const memory of [false, true])
            {
                const list = form.op !== undefined ? fma_cases(form) : f16c_cases(form);
                const { code, data } = program(form, memory, list);
                const runs = await run_all(loop([...prologue, ...code]), data, list.length);
                for(const { run, out, faults } of runs)
                {
                    const view = new DataView(out.buffer);
                    list.forEach((c, n) => {
                        const operands = form.op !== undefined ? `a ${c.a.toString(16)} b ${c.b.toString(16)} c ${c.c.toString(16)}` : `source ${c.source.toString(16)} imm8 ${c.imm8}`;
                        const label = `${form.name}${memory ? " [mem]" : ""} case ${n} on ${run}: mxcsr ${c.mxcsr.toString(16)} ${operands}`;
                        assert.equal(faults.getUint32(n * 4, true), c.fault ? xmm_exceptions ? 19 : 6 : 0, label + ": fault");
                        assert.equal(view.getUint32(n * 64 + 32, true), c.after, label + ": MXCSR");
                        const actual = [0, 1, 2, 3].reduce((v, q) => v | view.getBigUint64(n * 64 + 8 * q, true) << BigInt(64 * q), 0n);
                        // (VEX.128: bits 255:128 zeroed; VCVTPS2PH to memory: 8 or 16 bytes, the rest as before)
                        let expected;
                        if(c.fault) expected = form.kind === "ph2ps" || form.kind === "ps2ph" ? BEFORE256 : form.l ? c.a : c.a | UPPER;
                        else if(form.kind === "ps2ph")
                        {
                            const written = form.l ? 128n : 64n;
                            expected = memory ? BEFORE256 & ~((1n << written) - 1n) | c.result : c.result;
                        }
                        else expected = c.result;
                        assert.equal(actual.toString(16), expected.toString(16), label + ": result");
                    });
                }
                total += list.length;
            }
        }
        console.log(`PASS: ${xmm_exceptions ? "all forms, unmasked exceptions as #XM" : "unmasked exceptions as #UD without CR4.OSXMMEXCPT"}`);
    }
    console.log(`PASS: ${total} exact FMA and F16C cases (${FMA_FORMS.length} FMA forms, ${F16C_FORMS.length} F16C forms, register and memory sources, ${MXCSRS.length} MXCSR settings) match the model on 3 arms`);

    // The page tier's templates (P11 part 2): the VEX.128 and scalar FMA forms on
    // ordinary operands (no faults: a fault retries) run hot without steps
    // (x64_page_steps of C4 E2); the VEX.256 forms step. With PE set, where the
    // host's relaxed multiply-adds fuse (ir_relaxed_fma), natively
    // (native_fp::fused): no calls of the exact helper x64_fma; with them
    // switched off, through it. The same results either way.
    const page = machines[1].v86.cpu.wm.exports;
    const relaxed = page.ir_relaxed_fma() === 1;
    for(const native of relaxed ? [true, false] : [false])
    {
        page.ir_set_relaxed_fma(+native);
        const cr4 = [0x0F, 0x20, 0xE0, 0x0D, ...u32(OSXSAVE | 0x600), 0x0F, 0x22, 0xE0];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0x0F, 0x06, ...cr4, ...xsetbv(7)];
        const f64 = x => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
        const f32 = x => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return BigInt(b.getUint32(0, true)); };
        let templated = 0, stepped = 0;
        for(const form of FMA_FORMS)
        {
            const width = form.l ? 256 : 128, lanes = width / (form.double ? 64 : 32);
            const value = n => (form.double ? f64 : f32)(1.25 + n / 7);
            const list = Array.from({ length: 16 }, (_, n) => {
                const of = k => Array.from({ length: lanes }, (_, i) => value(n * 3 + k + i)).reduce((v, x, i) => v | x << BigInt(i * (form.double ? 64 : 32)), 0n);
                const [a, b, c] = [of(0), of(1), of(2)];
                return { mxcsr: 0x1FA0, a, b, c, ...fma_expect(form, 0x1FA0, a, b, c) };
            });
            const { code, data } = program(form, false, list);
            for(const vm of machines) vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
            page.x64_fma_calls_reset();
            const runs = await run_all(loop([...prologue, ...code]), data, list.length);
            const steps = machines[1].v86.cpu.wm.exports["x64_page_steps"](0xE2C4);
            const calls = page.x64_fma_calls();
            for(const { run, out, faults } of runs)
            {
                const view = new DataView(out.buffer);
                list.forEach((c, n) => {
                    assert.equal(faults.getUint32(n * 4, true), 0, `${form.name} ordinary case ${n} (${run}): no fault`);
                    const actual = [0, 1, 2, 3].reduce((v, q) => v | view.getBigUint64(n * 64 + 8 * q, true) << BigInt(64 * q), 0n);
                    assert.equal(actual.toString(16), c.result.toString(16), `${form.name} ordinary case ${n} (${run}): result`);
                });
            }
            // (a template steps the first executions at most; a build without
            // Wasm SIMD has no SIMD templates)
            const is_templated = steps < list.length;
            assert.equal(is_templated, !form.l && simd(machines[1]), `${form.name}: the page tier ${is_templated ? "ran a template" : "stepped"} (${steps} steps, ${list.length} cases)`);
            // (hot rounds of the template: natively, or each through the helper)
            if(is_templated) assert.ok(native ? calls === 0 : calls > list.length, `${form.name}: ${calls} exact helper calls (${native ? "native" : "exact"} FMA)`);
            if(is_templated) templated++;
            else stepped++;
        }
        console.log(simd(machines[1]) ? `PASS: the page tier ran templates for the ${templated} VEX.128 and scalar FMA forms (${native ? "native, relaxed multiply-adds" : "the exact helper"}), stepped the ${stepped} VEX.256 ones` :
            `PASS: the page tier stepped all ${stepped} FMA forms (no Wasm SIMD: no SIMD templates)`);
    }
    page.ir_set_relaxed_fma(+relaxed);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
