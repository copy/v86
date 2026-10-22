#!/usr/bin/env node
// The x64 page tier's SSE2 packed integer, shuffle, shift and compare
// templates (x64::pagegen: Vpacked, VshiftImm, Vcompare, Mxcsr). Every form,
// with a register and (where it exists) an aligned memory source, runs over
// the same vectors in a loop until the page tier has compiled it; each
// result (XMM, EFLAGS after COMISS/UCOMISS/COMISD/UCOMISD, MXCSR) must equal
// the interpreter's. Compare operands include NaNs, denormals, infinities
// and zeros, under MXCSR values with and without DAZ/FTZ.
//
// SSE_INT_SEED, SSE_INT_VECTORS (per form, default 64), SSE_INT_ROUNDS (6)
import assert from "node:assert/strict";
import { assemble, actual } from "./guest_runner.mjs";
import { long_mode_guest } from "./guest_builder.mjs";

let seed = Number(process.env.SSE_INT_SEED || 1) >>> 0 || 1;
const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
};
const int = n => Math.floor(random() * n);
const COUNT = +(process.env.SSE_INT_VECTORS || 64);
const ROUNDS = +(process.env.SSE_INT_ROUNDS || 6);
const VECTORS = 0x400000, OUT = 0x600000, STRIDE = 48, OUT_STRIDE = 32;

function single()
{
    const sign = int(2) << 31;
    switch(int(9))
    {
        case 0: return sign;                                    // zero
        case 1: return sign | 1 + int(0x7FFFFF);               // denormal
        case 2: return sign | 0x7F800000;                       // infinity
        case 3: return 0x7FC00000 | int(0x3FFFFF);              // QNaN
        case 4: return 0x7F800001 + int(0x3FFFFF);              // SNaN
        default: return sign | (100 + int(56)) << 23 | int(0x7FFFFF);
    }
}
function double()
{
    const sign = BigInt(int(2)) << 63n;
    const mantissa = () => BigInt(int(0x100000)) << 32n | BigInt(int(0x100000000));
    switch(int(9))
    {
        case 0: return sign;
        case 1: return sign | 1n + mantissa();
        case 2: return sign | 0x7FF0000000000000n;
        case 3: return 0x7FF8000000000000n | mantissa();
        case 4: return 0x7FF0000000000001n + mantissa() % 0x7FFFFFFFFFFFFn;
        default: return sign | BigInt(900 + int(250)) << 52n | mantissa();
    }
}
// all exceptions masked; with and without DAZ (0x40), FTZ (0x8000), PE, RC
const MXCSR = [0x1F80, 0x1FA0, 0x1FC0, 0x9F80, 0x9FC0, 0x3F80, 0x1FBF];

// vector v: [0] MXCSR, [4] flags seed, [16] a, [32] b. Even vectors hold
// float lanes (a/b alike for compares), odd ones random bytes with a small
// shift count in b's low quadword now and then.
const vectors = new DataView(new ArrayBuffer(COUNT * STRIDE));
for(let v = 0; v < COUNT; v++)
{
    const at = v * STRIDE;
    vectors.setUint32(at, MXCSR[int(MXCSR.length)], true);
    vectors.setUint32(at + 4, int(0x100000000), true);
    if(v % 4 === 0)
    {
        for(let lane = 0; lane < 4; lane++)
        {
            const a = single();
            const b = [single(), a, (a ^ 0x80000000) >>> 0][int(3)];
            vectors.setUint32(at + 16 + lane * 4, a >>> 0, true);
            vectors.setUint32(at + 32 + lane * 4, b >>> 0, true);
        }
    }
    else if(v % 4 === 2)
    {
        for(let lane = 0; lane < 2; lane++)
        {
            const a = double();
            const b = [double(), a, a ^ 1n << 63n][int(3)];
            vectors.setBigUint64(at + 16 + lane * 8, a, true);
            vectors.setBigUint64(at + 32 + lane * 8, b, true);
        }
    }
    else
    {
        for(let i = 16; i < 48; i++) vectors.setUint8(at + i, int(256));
        if(int(2)) vectors.setBigUint64(at + 32, BigInt(int(70)), true);
    }
}

const binary = ["paddb", "paddw", "paddd", "paddq", "psubb", "psubw", "psubd", "psubq", "paddsb", "paddsw", "paddusb", "paddusw",
    "psubsb", "psubsw", "psubusb", "psubusw", "pcmpgtb", "pcmpgtw", "pcmpgtd", "pcmpeqb", "pcmpeqw", "pcmpeqd",
    "pminub", "pmaxub", "pminsw", "pmaxsw", "pavgb", "pavgw", "pmulhuw", "pmulhw", "pmuludq", "psadbw", "pmullw", "pmaddwd",
    "punpcklbw", "punpcklwd", "punpckldq", "punpckhbw", "punpckhwd", "punpckhdq", "punpcklqdq", "punpckhqdq",
    "unpcklps", "unpckhps", "unpcklpd", "unpckhpd",
    "packsswb", "packuswb", "packssdw", "psrlw", "psrld", "psrlq", "psraw", "psrad", "psllw", "pslld", "psllq"];
const forms = [];
for(const op of binary)
{
    forms.push({ text: `${op} xmm0, xmm1` });
    forms.push({ text: `${op} xmm0, [rsi + 32]` });
}
// high registers (REX.R/REX.B)
forms.push({ text: "paddw xmm9, xmm12", high: true });
forms.push({ text: "punpcklbw xmm9, [rsi + 32]", high: true });
forms.push({ text: "unpcklps xmm9, xmm12", high: true });
forms.push({ text: "pshufd xmm9, xmm12, 0x1B", high: true });
forms.push({ text: "psrlw xmm12, 3", high: true, shifted: 12 });
for(const imm of [0x00, 0x1B, 0x4E, 0xB1, 0xE4, 0xFF, int(256)])
{
    for(const op of ["pshufd", "pshuflw", "pshufhw", "shufps", "shufpd"])
    {
        forms.push({ text: `${op} xmm0, xmm1, 0x${imm.toString(16)}` });
        forms.push({ text: `${op} xmm0, [rsi + 32], 0x${imm.toString(16)}` });
    }
}
for(const count of [0, 1, 3, 7, 8, 15, 16, 31, 32, 63, 64, 200])
    for(const op of ["psrlw", "psrld", "psrlq", "psraw", "psrad", "psllw", "pslld", "psllq", "psrldq", "pslldq"])
        forms.push({ text: `${op} xmm0, ${count}` });
for(const op of ["comiss", "ucomiss", "comisd", "ucomisd"])
{
    forms.push({ text: `${op} xmm0, xmm1`, flags: true });
    forms.push({ text: `${op} xmm0, [rsi + 32]`, flags: true });
    forms.push({ text: `${op} xmm11, xmm1`, flags: true, high: true });
}

let body = `
mov rax, cr4
or rax, 0x600                 ; OSFXSR, OSXMMEXCPT
mov cr4, rax
mov r15d, ${ROUNDS}
.round:
`;
forms.forEach(({ text, flags, high, shifted }, index) => {
    const dst = high ? (shifted === 12 ? "xmm12" : text.includes("xmm11") ? "xmm11" : "xmm9") : "xmm0";
    body += `
mov rsi, ${VECTORS}
mov rdi, ${OUT + index * COUNT * OUT_STRIDE}
mov ecx, ${COUNT}
.form${index}:
ldmxcsr [rsi]
movups xmm0, [rsi + 16]
movups xmm1, [rsi + 32]
movups xmm9, [rsi + 16]
movups xmm11, [rsi + 16]
movups xmm12, [rsi + ${shifted === 12 ? 16 : 32}]
mov eax, [rsi + 4]
add eax, eax                  ; some flags state
${text}
${flags ? "pushfq\npop rax\nmov [rdi + 8], rax" : ""}
stmxcsr [rdi]
movups [rdi + 16], ${dst}
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
const directory = assemble("sse-int-template", long_mode_guest(body));
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
    console.log(`${jit ? "page tier" : "interpreter"}: native ${stats[1]}, compiled ${stats[0]}, retries ${stats[2]}, steps ${stats[4]}, templated ${stats[10]}`);
    if(jit)
    {
        assert.ok(stats[1] > forms.length * COUNT * 8, "the page tier ran the forms: " + stats);
        // the loop bodies are templated: few steps per iteration
        assert.ok(stats[4] < forms.length * COUNT * ROUNDS / 4, "SSE forms were templated: " + stats);
    }
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
            assert.fail(`${forms[form].text} vector ${v} (mxcsr ${vectors.getUint32(v * STRIDE, true).toString(16)}, ` +
                `a ${hex(new Uint8Array(vectors.buffer, v * STRIDE + 16, 16))}, b ${hex(new Uint8Array(vectors.buffer, v * STRIDE + 32, 16))}): ` +
                `interpreter ${hex(results[0].subarray(at, at + OUT_STRIDE))} page tier ${hex(results[1].subarray(at, at + OUT_STRIDE))}`);
        }
    }
}
console.log(`X64_SSE_INT_TEMPLATE_PASS ${forms.length} forms x ${COUNT} vectors x ${ROUNDS} rounds`);
