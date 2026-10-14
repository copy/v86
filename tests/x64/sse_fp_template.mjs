#!/usr/bin/env node
// The x64 page tier's SSE ADD/SUB/MUL/DIV template (x64::pagegen, vfp): it
// runs natively only when that cannot change MXCSR and otherwise retries
// the instruction in the interpreter. Each of the 16 instructions (PS PD SS
// SD), with a register and with a memory source, is applied to the same
// vectors of special and random operands under MXCSR values that allow and
// that refuse the native path, in a loop until the page tier has compiled
// the code; every result and MXCSR must equal the interpreter's.
// With x64_sse_fast_check (JIT_SWITCHES; docs/jit-unification-plan.md
// P4.18) the instructions go through x86tpl::ops::float, which also takes
// SQRT, MIN and MAX (PS PD SS SD) and RCP and RSQRT (PS SS), tested too,
// and runs refused ones exactly in place, but those whose register facts
// hold only for admitted operands, which retry (as IR Tier-0's did).
//
// SSE_FP_SEED, SSE_FP_VECTORS (per form, default 256), SSE_FP_ROUNDS (8),
// SSE_FP_FORMS (a regular expression of the mnemonics to test);
// SSE_FP_ORDINARY=1: only ordinary operands under MXCSR 0x1FA0, where the
// native path must take (nearly) every instruction.
import assert from "node:assert/strict";
import { assemble, actual } from "./guest_runner.mjs";
import { long_mode_guest } from "./guest_builder.mjs";

let seed = Number(process.env.SSE_FP_SEED || 1) >>> 0 || 1;
const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
};
const int = n => Math.floor(random() * n);
const COUNT = +(process.env.SSE_FP_VECTORS || 256);
const ROUNDS = +(process.env.SSE_FP_ROUNDS || 8);
const VECTORS = 0x400000, OUT = 0x600000, STRIDE = 48, OUT_STRIDE = 32;
const ORDINARY = +process.env.SSE_FP_ORDINARY;
const FORMS = new RegExp(process.env.SSE_FP_FORMS || ".");

// operands: bit patterns of every class the guards distinguish
// (ordinary operands are positive: SQRT and RSQRT refuse negative ones)
function single()
{
    const sign = ORDINARY ? 0 : int(2) << 31;
    switch(ORDINARY ? 11 : int(12))
    {
        case 0: return sign;                                              // zero
        case 1: return sign | 1 + int(0x7FFFFF);                         // denormal
        case 2: return sign | 0x7F800000;                                 // infinity
        case 3: return 0x7FC00000 | int(0x3FFFFF);                        // QNaN
        case 4: return 0x7F800001 + int(0x3FFFFF);                        // SNaN
        case 5: return sign | 0x00800000 + int(4);                        // smallest normals
        case 6: return sign | 0x7F7FFFFF - int(4);                        // largest
        case 7: return sign | (1 + int(12)) << 23 | int(0x7FFFFF);       // tiny normals (products underflow)
        case 8: return sign | (240 + int(14)) << 23 | int(0x7FFFFF);     // huge (products overflow)
        default: return sign | (100 + int(56)) << 23 | int(0x7FFFFF);   // ordinary
    }
}
function double()
{
    const sign = BigInt(ORDINARY ? 0 : int(2)) << 63n;
    const mantissa = () => BigInt(int(0x100000)) << 32n | BigInt(int(0x100000000));
    switch(ORDINARY ? 11 : int(12))
    {
        case 0: return sign;
        case 1: return sign | 1n + mantissa();
        case 2: return sign | 0x7FF0000000000000n;
        case 3: return 0x7FF8000000000000n | mantissa();
        case 4: return 0x7FF0000000000001n + mantissa() % 0x7FFFFFFFFFFFFn;
        case 5: return sign | 0x0010000000000000n + BigInt(int(4));
        case 6: return sign | 0x7FEFFFFFFFFFFFFFn - BigInt(int(4));
        case 7: return sign | BigInt(1 + int(40)) << 52n | mantissa();
        case 8: return sign | BigInt(2000 + int(46)) << 52n | mantissa();
        default: return sign | BigInt(900 + int(250)) << 52n | mantissa();
    }
}
// MXCSR: 0x1FA0 and 0x1FBF allow the native path; the others refuse it
const MXCSR = [0x1F80, 0x1FA0, 0x1FA0, 0x1FA0, 0x1FBF, 0x3FA0, 0x5FA0, 0x7FA0, 0x1FE0, 0x9FA0];

const vectors = new DataView(new ArrayBuffer(COUNT * STRIDE));
for(let v = 0; v < COUNT; v++)
{
    const at = v * STRIDE;
    vectors.setUint32(at, ORDINARY ? 0x1FA0 : MXCSR[int(MXCSR.length)], true);
    if(v % 2)
    {
        for(let lane = 0; lane < 2; lane++)
        {
            const a = double();
            // sometimes b = -a (exact cancellation) or a copy (x - x)
            const b = ORDINARY ? double() : [double(), a ^ 1n << 63n, a][int(6) < 4 ? 0 : 1 + int(2)];
            vectors.setBigUint64(at + 16 + lane * 8, a, true);
            vectors.setBigUint64(at + 32 + lane * 8, b, true);
        }
    }
    else
    {
        for(let lane = 0; lane < 4; lane++)
        {
            const a = single();
            const b = ORDINARY ? single() : [single(), (a ^ 0x80000000) >>> 0, a][int(6) < 4 ? 0 : 1 + int(2)];
            vectors.setUint32(at + 16 + lane * 4, a >>> 0, true);
            vectors.setUint32(at + 32 + lane * 4, b >>> 0, true);
        }
    }
}

const forms = [];
for(const op of ["add", "sub", "mul", "div", "sqrt", "min", "max", "rcp", "rsqrt"])
    for(const suffix of ["ps", "pd", "ss", "sd"])
        for(const memory of [false, true])
            if((!op.startsWith("r") || !suffix.endsWith("d")) && FORMS.test(op + suffix)) forms.push({ op: op + suffix, memory });
let body = `
mov rax, cr4
or rax, 0x600                 ; OSFXSR, OSXMMEXCPT
mov cr4, rax
mov r15d, ${ROUNDS}
.round:
`;
forms.forEach(({ op, memory }, index) => {
    body += `
mov rsi, ${VECTORS}
mov rdi, ${OUT + index * COUNT * OUT_STRIDE}
mov ecx, ${COUNT}
.form${index}:
ldmxcsr [rsi]
movups xmm0, [rsi + 16]
movups xmm1, [rsi + 32]
${op} xmm0, ${memory ? "[rsi + 32]" : "xmm1"}
stmxcsr [rdi]
movups [rdi + 16], xmm0
add rsi, ${STRIDE}
add rdi, ${OUT_STRIDE}
dec ecx
jnz .form${index}
`;
});
body += `
dec r15d
jnz .round
mov eax, 0x1F80
mov [0x300010], eax
ldmxcsr [0x300010]
`;
const directory = assemble("sse-fp-template", long_mode_guest(body));
const length = forms.length * COUNT * OUT_STRIDE;
const results = [];
for(const jit of [false, true])
{
    let output, stats;
    await actual(directory, {
        length: 8, timeout: 600000,
        options: { memory_size: 16 << 20, disable_jit: !jit, ir_sync_publication: true },
        setup: emulator => { emulator.v86.cpu.mem8.set(new Uint8Array(vectors.buffer), VECTORS); },
        inspect: emulator => {
            const cpu = emulator.v86.cpu;
            output = cpu.mem8.slice(OUT, OUT + length);
            stats = Array.from({ length: 13 }, (_, i) => cpu.wm.exports.x64_page_stat(i));
        },
    });
    results.push(output);
    console.log(`${jit ? "page tier" : "interpreter"}: native ${stats[1]}, compiled ${stats[0]}, steps ${stats[4]}, retries ${stats[2]}, templated ${stats[10]}`);
    if(jit) assert.ok(stats[1] > forms.length * COUNT, "the page tier ran the forms: " + stats);
    // (ordinary operands: a refusal of the template is a retry; LDMXCSR and
    // STMXCSR are steps either way)
    if(jit && ORDINARY) assert.ok(stats[2] < forms.length * COUNT * ROUNDS / 10, "the native path ran: " + stats);
}
for(let form = 0; form < forms.length; form++)
{
    for(let v = 0; v < COUNT; v++)
    {
        const at = (form * COUNT + v) * OUT_STRIDE;
        const differs = results[0].subarray(at, at + OUT_STRIDE).some((byte, i) => byte !== results[1][at + i]);
        if(differs)
        {
            const hex = bytes => Buffer.from(bytes).toString("hex");
            assert.fail(`${forms[form].op}${forms[form].memory ? " mem" : ""} vector ${v} (mxcsr ${vectors.getUint32(v * STRIDE, true).toString(16)}, ` +
                `a ${hex(new Uint8Array(vectors.buffer, v * STRIDE + 16, 16))}, b ${hex(new Uint8Array(vectors.buffer, v * STRIDE + 32, 16))}): ` +
                `interpreter ${hex(results[0].subarray(at, at + OUT_STRIDE))} page tier ${hex(results[1].subarray(at, at + OUT_STRIDE))}`);
        }
    }
}
console.log(`X64_SSE_FP_TEMPLATE_PASS ${forms.length} forms x ${COUNT} vectors x ${ROUNDS} rounds`);
