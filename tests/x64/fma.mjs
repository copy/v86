#!/usr/bin/env node
// FMA and F16C in the x64 engine (docs/simd-xsave-plan.md 9.3, P11): every
// form in 64-bit mode with XMM0-15 (VEX.R, VEX.B and VEX.vvvv's top bit),
// aliased operands and memory operands, and in compatibility mode, against
// QEMU and tests/rust/sse_fp_model.mjs (through tests/rust/fma_cases.mjs).
// Eight forms (each order, each negation, ADDSUB/SUBADD, both widths) go
// through every special triple of fma_cases (NaN payloads in two or three
// operands: the first of x, y, z wins; 0 × ∞ with a QNaN, an SNaN or a
// number added; signed zeros, overflow, underflow, denormals) under three
// MXCSR settings; the others through random and special values. MXCSR's
// exceptions are masked there; the faults (#XM, destination unchanged) come
// with every exception unmasked. The cases run in rounds: interpreted, then
// with the x64 page tier, then also with Tier-0 in compatibility mode.
// QEMU 10.2 deviates from the SDM for F16C's denormals: VCVTPH2PS of a
// denormal half reports DE and, with DAZ, gives zero (the SDM: DAZ is
// ignored, and no denormal exception is reported); VCVTPS2PH flushes a tiny
// result to zero with FZ (the SDM: FZ is ignored, a tiny result is a half
// denormal). Those cases compare QEMU's MXCSR without DE; VCVTPH2PS's with
// DAZ or with DE unmasked (QEMU raises #XM) and VCVTPS2PH's with FZ are
// judged by the SDM alone. Nor does QEMU raise #XM for unmasked exceptions:
// the fault cases are judged by the model alone.
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {FMA_FORMS, F16C_FORMS, fma_cases, fma_expect, f16c_cases} from "../rust/fma_cases.mjs";

const OUT = 0x300000, CASE = OUT + 0x80, SKIP = OUT + 0x84, COUNTER = OUT + 0x88, FAULTS = OUT + 0x100, RESULTS = OUT + 0x2000, IDT = 0x380000;
// (the cases run in rounds, so that the last ones run compiled: the page tier
// compiles a page after 2000 visits, Tier-0 compatibility-mode code later)
const ROUNDS = 400, COMPAT_ROUNDS = 4000;
const SLOT = 48;
// (MXCSR: exceptions masked; nearest, nearest with PE set (where native FMA
// is admitted: x86tpl::native_fp::fused), down and DAZ|FZ, up)
const MASKED = [0x1F80, 0x1FA0, 0x3FA0, 0x9FE0 | 0x4000];
const FULL = ["vfmadd132sd", "vfmadd213ss", "vfmadd231pd", "vfnmsub132ss", "vfmsub213sd", "vfnmadd231ps ymm", "vfmaddsub132ps", "vfmsubadd231pd ymm"];

let seed = 0x0BADF00D;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const pick = list => list[random() % list.length];
const hex = (v, bytes) => Array.from({length: bytes}, (_, i) => "0x" + Number(v >> BigInt(8 * i) & 0xFFn).toString(16)).join(",");

// The cases: {form, long, a, b, c (or source, imm8), mxcsr, registers A, B, C, memory, expected {result, after, fault}}
const cases = [];
for(const form of FMA_FORMS)
{
    const full = FULL.includes(form.name);
    const list = fma_cases(form, full ? MASKED : [pick(MASKED)], full ? 2 : 2);
    const chosen = full ? list : [list[0], list[list.length - 1], list[list.length - 2], list[random() % list.length]];
    for(const [k, c] of chosen.entries())
    {
        for(const long of full ? [true] : [true, false])
        {
            if(!long && k > 1) continue;
            const regs = long ? 16 : 8, memory = k % 2 === 1;
            // (registers: distinct, but in some cases the third source is VEX.vvvv's or the destination)
            let A = random() % regs, B = random() % regs, C = random() % regs;
            if(k % 5 === 4) C = B;
            else if(k % 7 === 6) C = A;
            else { while(B === A) B = random() % regs; while(C === A || C === B) C = random() % regs; }
            // (the operands as loaded in order A, B, C: an alias holds the last value)
            const value = r => r === C && !memory ? c.c : r === B ? c.b : c.a;
            const [a, b, cc] = [value(A), value(B), memory ? c.c : value(C)];
            cases.push({form, long, A, B, C, memory, a: c.a, b: c.b, c: c.c, mxcsr: c.mxcsr, expected: fma_expect(form, c.mxcsr, a, b, cc)});
        }
    }
}
for(const form of F16C_FORMS)
{
    const list = f16c_cases(form, MASKED, 6);
    for(const [k, c] of list.entries())
    {
        for(const long of k < 12 ? [true, false] : [true])
        {
            const regs = long ? 16 : 8;
            const A = random() % regs;
            let C = random() % regs;
            while(C === A) C = random() % regs;
            cases.push({form, long, A, C, memory: k % 2 === 1, source: c.source, imm8: c.imm8, mxcsr: c.mxcsr, expected: c});
        }
    }
}
// Faults: every exception unmasked (and the defaults, no fault), on special operands
const UNMASKED = 0;
for(const name of ["vfmadd132sd", "vfnmsub231ps", "vfmaddsub213pd ymm", "vfmsub132ss"])
{
    const form = FMA_FORMS.find(f => f.name === name);
    for(const c of fma_cases(form, [UNMASKED], 0).filter((_, n) => n % 3 === 0))
        cases.push({form, long: true, A: 1, B: 9, C: 14, memory: false, a: c.a, b: c.b, c: c.c, mxcsr: UNMASKED, expected: fma_expect(form, UNMASKED, c.a, c.b, c.c)});
}
for(const form of F16C_FORMS)
    for(const c of f16c_cases(form, [UNMASKED], 6))
        cases.push({form, long: true, A: 3, C: 12, memory: false, source: c.source, imm8: c.imm8, mxcsr: UNMASKED, expected: c});

const xmm = (r, l) => (l ? "ymm" : "xmm") + r;
/** A case's code: MXCSR, the operands, the instruction (the handler skips it
 * on #XM), the destination's 256 bits and MXCSR to its slot */
const code = (c, n) => {
    const out = RESULTS + n * SLOT, data = `case_${n}`, l = c.form.l;
    const lines = [`mov dword [${CASE}],${n}`, `ldmxcsr [${data} + 96]`];
    let instruction, destination;
    if(c.form.op !== undefined)
    {
        lines.push(`vmovdqu ${xmm(c.A, 1)},[${data}]`, `vmovdqu ${xmm(c.B, 1)},[${data} + 32]`);
        if(!c.memory) lines.push(`vmovdqu ${xmm(c.C, 1)},[${data} + 64]`);
        const size = c.form.scalar ? (c.form.double ? "qword" : "dword") : l ? "yword" : "oword";
        const third = c.memory ? `${size} [${data} + 64]` : xmm(c.C, l && !c.form.scalar);
        const mnemonic = c.form.name.split(" ")[0];
        instruction = `${mnemonic} ${xmm(c.A, l)},${xmm(c.B, l)},${third}`;
        destination = xmm(c.A, 1);
    }
    else if(c.form.kind === "ph2ps")
    {
        lines.push(`vmovdqu ${xmm(c.A, 1)},[${data}]`);
        if(!c.memory) lines.push(`vmovdqu ${xmm(c.C, 1)},[${data} + 64]`);
        instruction = `vcvtph2ps ${xmm(c.A, l)},${c.memory ? `${l ? "oword" : "qword"} [${data} + 64]` : xmm(c.C, 0)}`;
        destination = xmm(c.A, 1);
    }
    else
    {
        lines.push(`vmovdqu ${xmm(c.A, 1)},[${data}]`, `vmovdqu ${xmm(c.C, 1)},[${data} + 64]`);
        instruction = `vcvtps2ph ${c.memory ? `${l ? "oword" : "qword"} [${data} + 64]` : xmm(c.C, 0)},${xmm(c.A, l)},${c.imm8}`;
        destination = c.memory ? null : xmm(c.C, 1);
    }
    lines.push(`mov dword [${SKIP}],skip_end${n} - skip${n}`, `skip${n}: ${instruction}`, `skip_end${n}:`);
    if(destination) lines.push(`vmovdqu [${out}],${destination}`);
    else lines.push(`vmovdqu ymm15,[${data} + 64]`.replace("ymm15", c.long ? "ymm15" : "ymm7"), `vmovdqu [${out}],${c.long ? "ymm15" : "ymm7"}`);
    lines.push(`stmxcsr [${out} + 32]`);
    return lines.join("\n");
};
/** A case's data: 128 bytes (A's, B's, C's 256 bits, MXCSR) */
const BEFORE256 = 0x5A5A5A5A_A5A5A5A5_12345678_9ABCDEF0n * (1n + (1n << 128n));
// (the operands' bits 255:128 for VEX.128 forms: a destination's are zeroed)
const UPPER = 0x0123456789ABCDEF_FEDCBA9876543210n << 128n;
const data = (c, n) => {
    let a, b, third;
    if(c.form.op !== undefined) [a, b, third] = c.form.l ? [c.a, c.b, c.c] : [c.a | UPPER, c.b | UPPER, c.c | UPPER];
    else if(c.form.kind === "ph2ps") [a, b, third] = [BEFORE256, 0n, c.source];
    else [a, b, third] = [c.source, 0n, BEFORE256];
    return `align 32\ncase_${n}: db ${hex(a, 32)}\ndb ${hex(b, 32)}\ndb ${hex(third, 32)}\ndd ${c.mxcsr}\ntimes 28 db 0`;
};
/** The slot the model expects: the destination's 256 bits, MXCSR */
const expected_slot = c => {
    const e = c.expected, l = c.form.l;
    let result;
    if(c.form.op !== undefined) result = e.fault ? c.a : e.result;
    else if(c.form.kind === "ph2ps") result = e.fault ? BEFORE256 : e.result;
    else
    {
        // (to memory: 8 or 16 bytes, the rest as before; to a register the rest zeroed)
        const written = l ? 128n : 64n;
        result = e.fault ? BEFORE256 : c.memory ? BEFORE256 & ~((1n << written) - 1n) | e.result : e.result;
    }
    // (a faulting FMA form's destination: as loaded, A's value unless aliased)
    if(c.form.op !== undefined && e.fault)
    {
        const loaded = c.A === c.C && !c.memory ? c.c : c.A === c.B ? c.b : c.a;
        result = c.form.l ? loaded : loaded | UPPER;
    }
    return {result, after: e.after, fault: e.fault};
};

const block = long => cases.map((c, n) => c.long === long ? code(c, n) : "").filter(Boolean).join("\n");
const directory = assemble("fma", long_mode_guest(`
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
xor ecx,ecx
mov eax,7
xor edx,edx
xsetbv
mov ebx,19
mov rax,HIGH+xm
call set_gate
mov ebx,6
mov rax,HIGH+ud
call set_gate
lidt [rel idtr]
mov dword [${COUNTER}],${ROUNDS}
rounds64:
${block(true)}
dec dword [${COUNTER}]
jnz rounds64
; compatibility mode
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
mov dword [${COUNTER}],${COMPAT_ROUNDS}
rounds32:
${block(false)}
dec dword [${COUNTER}]
jnz rounds32
jmp 0x18:back
bits 64
back:
mov rax,HIGH+in_long_mode
jmp rax
in_long_mode:
`, `
set_gate:
mov rdi,rbx
shl rdi,4
add rdi,${IDT}
mov [rdi],ax
mov word [rdi + 2],0x18
mov word [rdi + 4],0x8E00
shr rax,16
mov [rdi + 6],ax
shr rax,16
mov [rdi + 8],eax
mov dword [rdi + 12],0
ret
ud:
mov ecx,6
jmp record
xm:
mov ecx,19
record:
mov edx,[${CASE}]
mov [${FAULTS} + rdx * 4],ecx
mov eax,[${SKIP}]
add [rsp],rax
iretq
align 8
idtr: dw 511
dq ${IDT}
${cases.map(data).join("\n")}
`));

assert.ok(cases.length * 4 <= RESULTS - FAULTS, "the faults' table fits");
const length = RESULTS - OUT + cases.length * SLOT;
/** VCVTPH2PS of a denormal half (see above: QEMU reports DE) */
const denormal_half = c => c.form.kind === "ph2ps" && [0, 1, 2, 3, 4, 5, 6, 7].some(i => {
    const h = c.source >> BigInt(16 * i) & 0xFFFFn;
    return (h & 0x7C00n) === 0n && (h & 0x3FFn) !== 0n;
});
const check = (result, label) => {
    cases.forEach((c, n) => {
        const qemu_de = label === "QEMU" && denormal_half(c);
        if(qemu_de && ((c.mxcsr & 0x100) === 0 || (c.mxcsr & 0x40) !== 0)) return;
        if(label === "QEMU" && c.form.kind === "ps2ph" && (c.mxcsr & 0x8000) !== 0) return;
        if(label === "QEMU" && c.mxcsr === UNMASKED) return;
        const {result: want, after, fault} = expected_slot(c);
        const got = result.subarray(RESULTS - OUT + n * SLOT, RESULTS - OUT + n * SLOT + 32);
        const operands = c.form.op !== undefined ? `a ${c.a.toString(16)} b ${c.b.toString(16)} c ${c.c.toString(16)} (registers ${c.A} ${c.B} ${c.C})` : `source ${c.source.toString(16)} imm8 ${c.imm8}`;
        const what = `${label}: ${c.long ? "64-bit" : "compatibility"} ${c.form.name}${c.memory ? " [mem]" : ""} case ${n}, mxcsr ${c.mxcsr.toString(16)}, ${operands}`;
        assert.equal(result.readUInt32LE(FAULTS - OUT + n * 4), fault ? 19 : 0, `${what}: fault`);
        const value = Array.from(got).reduceRight((v, x) => v << 8n | BigInt(x), 0n);
        assert.equal(value.toString(16), want.toString(16), `${what}: result`);
        const mxcsr = result.readUInt32LE(RESULTS - OUT + n * SLOT + 32);
        assert.equal(qemu_de ? mxcsr & ~2 : mxcsr, after, `${what}: MXCSR`);
    });
};
const expected_qemu = await reference(directory, {length});
check(expected_qemu, "QEMU");
const FEATURES = {cpu_type: "x86_64", cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "FMA", "F16C"], cpu_features_unreleased: true};
for(const [label, options, compat] of [["interpreted", {}, false],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}, false],
    ["x64 page tier + compatibility-mode JIT", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}, true],
    // (compatibility-mode code in the page tier, docs/jit-unification-plan.md P7.2)
    ["x64 page tier, compat32", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        jit_switches: {x64_page_compat32: 1}}, false]])
{
    let page = 0, page32 = 0, tier0;
    const result = await actual(directory, {length, timeout: 180000, options: {...FEATURES, ...options},
        setup: emulator => {
            const x = emulator.v86.cpu.wm.exports;
            x.x64_set_compat_jit(compat);
            if(options.disable_jit === false)
            {
                x.ir_auto_set_idle_mode(0, 1);
                // (compile compatibility-mode pages at their first visit)
                assert.ok(x.ir_auto_set_page_threshold(1));
            }
        },
        inspect: emulator => {
            page = emulator.v86.cpu.wm.exports.x64_page_stat(1);
            page32 = emulator.v86.cpu.wm.exports.x64_page_stat(36);
            tier0 = emulator.v86.cpu.get_jit_info().ir?.tier0;
        }});
    check(result, label);
    if(options.disable_jit === false) assert.ok(page > 1000, `${label}: compiled 64-bit code ran (${page})`);
    if(compat) assert.ok(tier0.activations > 0 && tier0.page_functions > 0, `${label}: compiled compatibility-mode code ran ${JSON.stringify(tier0)}`);
    if(options.jit_switches?.x64_page_compat32) assert.ok(page32 > 0, `${label}: the page tier compiled compatibility-mode code (${page32})`);
    console.log(`PASS (${label}): ${cases.length} FMA and F16C cases in 64-bit and compatibility mode (XMM0-15, aliased and memory operands, faults), as the model and QEMU`);
}

// The page tier's templates for FMA (P11 part 2): a hot loop of the hot forms
// (VFMADD213SD, VFMADD132SD, VFMADD231SD, VFMSUB132SD, VFMSUB231SD,
// VFMADD132PD, VFMADD213PD, VFMADD213SS) and siblings, register and memory
// operands, on ordinary values (no exceptions), runs with almost no steps
// (x64_page_stat(4)), the sums of every round as QEMU's. PE is set after the
// first rounding: where the host's relaxed multiply-adds fuse
// (ir_relaxed_fma), natively (x86tpl::native_fp::fused: the exact helper
// ir_t0_fma only before), and again with them switched off (every FMA
// through the helper).
for(const native of [true, false])
{
    const ITERATIONS = 20000;
    const hot = assemble("fma-hot", long_mode_guest(`
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
xor ecx,ecx
mov eax,7
xor edx,edx
xsetbv
mov r15d,${ITERATIONS}
vxorpd xmm13,xmm13,xmm13
vxorpd xmm14,xmm14,xmm14
vxorpd xmm15,xmm15,xmm15
.loop:
vcvtsi2sd xmm0,xmm0,r15d
vmulsd xmm0,xmm0,[rel scale]
vmovsd xmm1,[rel c4]
vfmadd213sd xmm1,xmm0,[rel c3]
vfmadd213sd xmm1,xmm0,[rel c2]
vmovsd xmm2,[rel c1]
vfmadd231sd xmm2,xmm1,xmm0
vmovapd xmm3,xmm0
vfmadd132sd xmm3,xmm2,[rel c0]
vfmsub132sd xmm3,xmm1,xmm0
vfmsub231sd xmm3,xmm2,[rel c1]
vfnmadd213sd xmm3,xmm0,xmm2
vaddsd xmm15,xmm15,xmm3
vmovapd xmm4,xmm0
vmovupd xmm5,[rel pd]
vfmadd132pd xmm5,xmm4,[rel pd2]
vfmadd213pd xmm5,xmm4,xmm4
vfnmsub231pd xmm5,xmm4,[rel pd]
vaddpd xmm14,xmm14,xmm5
vcvtsd2ss xmm6,xmm6,xmm0
vmovss xmm7,[rel s1]
vfmadd213ss xmm7,xmm6,[rel s2]
vfmsub231ss xmm7,xmm6,xmm6
vfmaddsub213ps xmm7,xmm6,xmm7
vaddss xmm13,xmm13,xmm7
dec r15d
jnz .loop
vmovupd [${OUT + 16}],xmm15
vmovupd [${OUT + 32}],xmm14
vmovupd [${OUT + 48}],xmm13
`, `
align 16
scale: dq 0.0001
c0: dq 1.0
c1: dq 0.5
c2: dq 0.16666666666666666
c3: dq 0.041666666666666664
c4: dq 0.008333333333333333
pd: dq 0.75, -1.25
pd2: dq 3.0, 0.125
s1: dd 1.5
s2: dd -0.375
`));
    const length = 64;
    const expected = await reference(hot, {length});
    let steps, retired, calls, relaxed;
    const result = await actual(hot, {length, timeout: 60000,
        options: {...FEATURES, disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        setup: emulator => {
            const e = emulator.v86.cpu.wm.exports;
            relaxed = e.ir_relaxed_fma() === 1 && native;
            e.ir_set_relaxed_fma(+relaxed);
            e.ir_t0_fma_calls_reset();
        },
        inspect: emulator => {
            steps = emulator.v86.cpu.wm.exports.x64_page_stat(4);
            retired = emulator.v86.cpu.wm.exports.x64_page_stat(1);
            calls = emulator.v86.cpu.wm.exports.ir_t0_fma_calls();
        }});
    if(native && !relaxed) continue;
    assert.equal(Buffer.from(result.subarray(16, 64)).toString("hex"), Buffer.from(expected.subarray(16, 64)).toString("hex"), "hot loop: the sums as QEMU");
    assert.ok(retired > ITERATIONS * 20 && steps < ITERATIONS / 10, `page tier templates: ${retired} retired, ${steps} steps`);
    // (13 FMA instructions per iteration)
    assert.ok(relaxed ? calls < ITERATIONS / 10 : calls > ITERATIONS * 10, `${calls} exact helper calls (${relaxed ? "native" : "exact"} FMA)`);
    console.log(`PASS (x64 page tier): the hot FMA forms' templates (${relaxed ? "native, relaxed multiply-adds" : "the exact helper"}), as QEMU (${retired} instructions retired natively, ${steps} steps, ${calls} helper calls)`);
}
