// Legacy SSE exception conditions in the 32-bit engines (docs/simd-xsave-plan.md
// 3.3, P4a). Without CR4.OSFXSR every form that names an XMM register or
// MXCSR is #UD: also with CR0.TS (#UD before #NM), and before any check of
// its memory operand. MMX forms run, including the SSE, SSE2 and SSSE3 ones
// on MMX registers, and so do EMMS and FXSAVE. A misaligned 16-byte memory
// operand is #GP(0) without effect and before #PF, except for MOVUPS,
// MOVUPD, MOVDQU and LDDQU; UNPCKLPS/UNPCKLPD read 8 bytes of an aligned
// m128; narrower operands, MMX forms and the masked stores need no
// alignment. Each program runs in the interpreter, then hot under the page tier and
// the region tiers; the fault log, registers and memory must agree after the
// hot run and after one more round.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const hex = n => (n >>> 0).toString(16);
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// The program runs at CODE; the length of each faulting instruction is at
// CODE + LENGTHS (its handler skips it). Every form has a slot of 0x40 bytes
// in each region: sources at DATA_A (aligned) and DATA_M (at skew(k)), store
// targets at STORE_A and STORE_M, its results at OUT. The handlers log
// vector, EIP, error code (-1 without) and CR2 (#PF, else 0) per fault.
const CODE = 0x100000, LENGTHS = 0x10000, PATTERN = 0x120000, MM_PATTERN = 0x120080, MXCSR = 0x1200C0;
const DATA_A = 0x130000, DATA_M = 0x140000, STORE_A = 0x150000, STORE_M = 0x160000, OUT = 0x170000;
const LOG = 0x180000, LOG_INDEX = 0x18FFF0, FXAREA = 0x190000;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x2F0000;
const SLOT = 0x40, REGION = 0x10000;
const skew = k => [8, 4, 1, 12, 15, 2, 9, 6][k % 8];
const EDX_INIT = 0x13572468, EBX_INIT = 0x2468ACE0, MXCSR_INIT = 0x1F80;
const OSFXSR = 0x200, OSXMMEXCPT = 0x400, EM = 4, TS = 8;

let seed = 0x5EED1234;
const random_bytes = n => Uint8Array.from({ length: n }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed & 255;
});
const XMM_INIT = random_bytes(128), MM_INIT = random_bytes(64);

// [name, opcode, operands, imm8]. Operands "<ModRM.reg>,<r/m>/<memory>": x
// XMM, m MMX, g GPR (EDX as ModRM.reg, EBX as r/m), a digit the ModRM.reg of
// a group, "=" r/m is ModRM.reg, "-" no register form. Memory: "A" an m128
// that must be 16-byte aligned, a byte count, "-" none, "*" the masked store
// to [EDI]; "!" the memory operand is written.
const XMM_FORMS = [
    ["addps", [0x0F, 0x58], "x,x/A"],
    ["addss", [0xF3, 0x0F, 0x58], "x,x/4"],
    ["mulpd", [0x66, 0x0F, 0x59], "x,x/A"],
    ["divsd", [0xF2, 0x0F, 0x5E], "x,x/8"],
    ["sqrtps", [0x0F, 0x51], "x,x/A"],
    ["minpd", [0x66, 0x0F, 0x5D], "x,x/A"],
    ["maxss", [0xF3, 0x0F, 0x5F], "x,x/4"],
    ["cmpps", [0x0F, 0xC2], "x,x/A", 1],
    ["cmpsd", [0xF2, 0x0F, 0xC2], "x,x/8", 2],
    ["ucomiss", [0x0F, 0x2E], "x,x/4"],
    ["comisd", [0x66, 0x0F, 0x2F], "x,x/8"],
    ["rcpps", [0x0F, 0x53], "x,x/A"],
    ["rsqrtss", [0xF3, 0x0F, 0x52], "x,x/4"],
    ["haddps", [0xF2, 0x0F, 0x7C], "x,x/A"],
    ["hsubpd", [0x66, 0x0F, 0x7D], "x,x/A"],
    ["addsubps", [0xF2, 0x0F, 0xD0], "x,x/A"],
    ["addsubpd", [0x66, 0x0F, 0xD0], "x,x/A"],
    ["cvtps2pd", [0x0F, 0x5A], "x,x/8"],
    ["cvtpd2ps", [0x66, 0x0F, 0x5A], "x,x/A"],
    ["cvtss2sd", [0xF3, 0x0F, 0x5A], "x,x/4"],
    ["cvtsd2ss", [0xF2, 0x0F, 0x5A], "x,x/8"],
    ["cvtdq2ps", [0x0F, 0x5B], "x,x/A"],
    ["cvtps2dq", [0x66, 0x0F, 0x5B], "x,x/A"],
    ["cvttps2dq", [0xF3, 0x0F, 0x5B], "x,x/A"],
    ["cvtdq2pd", [0xF3, 0x0F, 0xE6], "x,x/8"],
    ["cvtpd2dq", [0xF2, 0x0F, 0xE6], "x,x/A"],
    ["cvttpd2dq", [0x66, 0x0F, 0xE6], "x,x/A"],
    ["cvtsi2ss", [0xF3, 0x0F, 0x2A], "x,g/4"],
    ["cvtsi2sd", [0xF2, 0x0F, 0x2A], "x,g/4"],
    ["cvttss2si", [0xF3, 0x0F, 0x2C], "g,x/4"],
    ["cvtsd2si", [0xF2, 0x0F, 0x2D], "g,x/8"],
    // (the conversions between MMX and XMM registers are XMM forms)
    ["cvtpi2ps", [0x0F, 0x2A], "x,m/8"],
    ["cvtpi2pd", [0x66, 0x0F, 0x2A], "x,m/8"],
    ["cvtps2pi", [0x0F, 0x2D], "m,x/8"],
    ["cvttps2pi", [0x0F, 0x2C], "m,x/8"],
    ["cvttpd2pi", [0x66, 0x0F, 0x2C], "m,x/A"],
    ["cvtpd2pi", [0x66, 0x0F, 0x2D], "m,x/A"],
    ["andps", [0x0F, 0x54], "x,x/A"],
    ["andnpd", [0x66, 0x0F, 0x55], "x,x/A"],
    ["orps", [0x0F, 0x56], "x,x/A"],
    ["xorps", [0x0F, 0x57], "x,x/A"],
    ["xorps zeroing", [0x0F, 0x57], "x,=/-"],
    ["unpcklps", [0x0F, 0x14], "x,x/A"],
    ["unpcklpd", [0x66, 0x0F, 0x14], "x,x/A"],
    ["unpckhps", [0x0F, 0x15], "x,x/A"],
    ["unpckhpd", [0x66, 0x0F, 0x15], "x,x/A"],
    ["shufps", [0x0F, 0xC6], "x,x/A", 0x1B],
    ["shufpd", [0x66, 0x0F, 0xC6], "x,x/A", 1],
    ["movmskps", [0x0F, 0x50], "g,x/-"],
    ["movmskpd", [0x66, 0x0F, 0x50], "g,x/-"],
    ["movups", [0x0F, 0x10], "x,x/16"],
    ["movups store", [0x0F, 0x11], "x,x/16!"],
    ["movupd", [0x66, 0x0F, 0x10], "x,x/16"],
    ["movupd store", [0x66, 0x0F, 0x11], "x,x/16!"],
    ["movss", [0xF3, 0x0F, 0x10], "x,x/4"],
    ["movss store", [0xF3, 0x0F, 0x11], "x,x/4!"],
    ["movsd", [0xF2, 0x0F, 0x10], "x,x/8"],
    ["movsd store", [0xF2, 0x0F, 0x11], "x,x/8!"],
    ["movaps", [0x0F, 0x28], "x,x/A"],
    ["movaps store", [0x0F, 0x29], "x,x/A!"],
    ["movapd", [0x66, 0x0F, 0x28], "x,x/A"],
    ["movapd store", [0x66, 0x0F, 0x29], "x,x/A!"],
    ["movntps", [0x0F, 0x2B], "x,-/A!"],
    ["movntpd", [0x66, 0x0F, 0x2B], "x,-/A!"],
    ["movlps", [0x0F, 0x12], "x,x/8"], // (register form: MOVHLPS)
    ["movlps store", [0x0F, 0x13], "x,-/8!"],
    ["movhps", [0x0F, 0x16], "x,x/8"], // (register form: MOVLHPS)
    ["movhps store", [0x0F, 0x17], "x,-/8!"],
    ["movlpd", [0x66, 0x0F, 0x12], "x,-/8"],
    ["movhpd store", [0x66, 0x0F, 0x17], "x,-/8!"],
    ["movsldup", [0xF3, 0x0F, 0x12], "x,x/A"],
    ["movshdup", [0xF3, 0x0F, 0x16], "x,x/A"],
    ["movddup", [0xF2, 0x0F, 0x12], "x,x/8"],
    ["lddqu", [0xF2, 0x0F, 0xF0], "x,-/16"],
    ["movdqa", [0x66, 0x0F, 0x6F], "x,x/A"],
    ["movdqa store", [0x66, 0x0F, 0x7F], "x,x/A!"],
    ["movdqu", [0xF3, 0x0F, 0x6F], "x,x/16"],
    ["movdqu store", [0xF3, 0x0F, 0x7F], "x,x/16!"],
    ["movntdq", [0x66, 0x0F, 0xE7], "x,-/A!"],
    ["maskmovdqu", [0x66, 0x0F, 0xF7], "x,x/*"],
    ["movd xmm, r/m32", [0x66, 0x0F, 0x6E], "x,g/4"],
    ["movd r/m32, xmm", [0x66, 0x0F, 0x7E], "x,g/4!"],
    ["movq xmm, xmm/m64", [0xF3, 0x0F, 0x7E], "x,x/8"],
    ["movq xmm/m64, xmm", [0x66, 0x0F, 0xD6], "x,x/8!"],
    ["movq2dq", [0xF3, 0x0F, 0xD6], "x,m/-"],
    ["movdq2q", [0xF2, 0x0F, 0xD6], "m,x/-"],
    ["paddd", [0x66, 0x0F, 0xFE], "x,x/A"],
    ["psubb", [0x66, 0x0F, 0xF8], "x,x/A"],
    ["pxor", [0x66, 0x0F, 0xEF], "x,x/A"],
    ["pxor zeroing", [0x66, 0x0F, 0xEF], "x,=/-"],
    ["pand", [0x66, 0x0F, 0xDB], "x,x/A"],
    ["pcmpeqb", [0x66, 0x0F, 0x74], "x,x/A"],
    ["pcmpeqd all ones", [0x66, 0x0F, 0x76], "x,=/-"],
    ["pcmpgtd", [0x66, 0x0F, 0x66], "x,x/A"],
    ["punpcklbw", [0x66, 0x0F, 0x60], "x,x/A"],
    ["punpcklqdq", [0x66, 0x0F, 0x6C], "x,x/A"],
    ["punpckhdq", [0x66, 0x0F, 0x6A], "x,x/A"],
    ["packsswb", [0x66, 0x0F, 0x63], "x,x/A"],
    ["packuswb", [0x66, 0x0F, 0x67], "x,x/A"],
    ["pmullw", [0x66, 0x0F, 0xD5], "x,x/A"],
    ["pmulhuw", [0x66, 0x0F, 0xE4], "x,x/A"],
    ["pmuludq", [0x66, 0x0F, 0xF4], "x,x/A"],
    ["pmaddwd", [0x66, 0x0F, 0xF5], "x,x/A"],
    ["psadbw", [0x66, 0x0F, 0xF6], "x,x/A"],
    ["pavgb", [0x66, 0x0F, 0xE0], "x,x/A"],
    ["pminub", [0x66, 0x0F, 0xDA], "x,x/A"],
    ["pmaxsw", [0x66, 0x0F, 0xEE], "x,x/A"],
    ["paddq", [0x66, 0x0F, 0xD4], "x,x/A"],
    ["paddusb", [0x66, 0x0F, 0xDC], "x,x/A"],
    ["psllw", [0x66, 0x0F, 0xF1], "x,x/A"],
    ["psrad", [0x66, 0x0F, 0xE2], "x,x/A"],
    ["psrlq", [0x66, 0x0F, 0xD3], "x,x/A"],
    ["psllw imm8", [0x66, 0x0F, 0x71], "6,x/-", 3],
    ["psrad imm8", [0x66, 0x0F, 0x72], "4,x/-", 5],
    ["psrldq", [0x66, 0x0F, 0x73], "3,x/-", 4],
    ["pslldq", [0x66, 0x0F, 0x73], "7,x/-", 9],
    ["pshufd", [0x66, 0x0F, 0x70], "x,x/A", 0x1B],
    ["pshufhw", [0xF3, 0x0F, 0x70], "x,x/A", 0x39],
    ["pshuflw", [0xF2, 0x0F, 0x70], "x,x/A", 0x93],
    ["pextrw", [0x66, 0x0F, 0xC5], "g,x/-", 5],
    ["pinsrw", [0x66, 0x0F, 0xC4], "x,g/2", 3],
    ["pmovmskb", [0x66, 0x0F, 0xD7], "g,x/-"],
    ["pshufb", [0x66, 0x0F, 0x38, 0x00], "x,x/A"],
    ["palignr", [0x66, 0x0F, 0x3A, 0x0F], "x,x/A", 5],
    ["pmaddubsw", [0x66, 0x0F, 0x38, 0x04], "x,x/A"],
    ["phaddw", [0x66, 0x0F, 0x38, 0x01], "x,x/A"],
    ["psignb", [0x66, 0x0F, 0x38, 0x08], "x,x/A"],
    ["pabsd", [0x66, 0x0F, 0x38, 0x1E], "x,x/A"],
    ["pmulhrsw", [0x66, 0x0F, 0x38, 0x0B], "x,x/A"],
    // (in this order: STMXCSR reads the MXCSR that LDMXCSR set)
    ["ldmxcsr", [0x0F, 0xAE], "2,-/4"],
    ["stmxcsr", [0x0F, 0xAE], "3,-/4!"],
];
const MMX_FORMS = [
    ["paddd mm", [0x0F, 0xFE], "m,m/8"],
    ["pxor mm", [0x0F, 0xEF], "m,m/8"],
    ["pshufw", [0x0F, 0x70], "m,m/8", 0x1B],
    ["pshufb mm", [0x0F, 0x38, 0x00], "m,m/8"],
    ["palignr mm", [0x0F, 0x3A, 0x0F], "m,m/8", 3],
    ["pmaddubsw mm", [0x0F, 0x38, 0x04], "m,m/8"],
    ["pabsb mm", [0x0F, 0x38, 0x1C], "m,m/8"],
    ["movq mm", [0x0F, 0x6F], "m,m/8"],
    ["movq mm store", [0x0F, 0x7F], "m,m/8!"],
    ["movd mm, r/m32", [0x0F, 0x6E], "m,g/4"],
    ["movd r/m32, mm", [0x0F, 0x7E], "m,g/4!"],
    ["pinsrw mm", [0x0F, 0xC4], "m,g/2", 2],
    ["pextrw mm", [0x0F, 0xC5], "g,m/-", 1],
    ["pmovmskb mm", [0x0F, 0xD7], "g,m/-"],
    ["movntq", [0x0F, 0xE7], "m,-/8!"],
    ["maskmovq", [0x0F, 0xF7], "m,m/*"],
    ["pavgb mm", [0x0F, 0xE0], "m,m/8"],
    ["psadbw mm", [0x0F, 0xF6], "m,m/8"],
    ["pmuludq mm", [0x0F, 0xF4], "m,m/8"],
    ["paddq mm", [0x0F, 0xD4], "m,m/8"],
    ["psubq mm", [0x0F, 0xFB], "m,m/8"],
    ["pminub mm", [0x0F, 0xDA], "m,m/8"],
    ["psllw mm, imm8", [0x0F, 0x71], "6,m/-", 3],
    ["punpcklbw mm", [0x0F, 0x60], "m,m/4"],
    ["packsswb mm", [0x0F, 0x63], "m,m/8"],
];
const ALL = [...XMM_FORMS.map(f => [f, true]), ...MMX_FORMS.map(f => [f, false])].map(([[name, op, operands, imm], xmm], k) => {
    const [, reg, rm, memory, store] = /^([xmg0-7]),([xmg=-])\/(A|\d+|-|\*)(!?)$/.exec(operands);
    return { name, op, reg, rm, imm, xmm, k, aligned: memory === "A", memory: !"-*".includes(memory), masked: memory === "*", store: store === "!" };
});
const XMM = ALL.filter(f => f.xmm), MMX = ALL.filter(f => !f.xmm);
const form = name => ALL.find(f => f.name === name);

const reg_of = f => /\d/.test(f.reg) ? +f.reg : f.reg === "g" ? 2 : f.k % 8;
const rm_of = f => f.rm === "=" ? reg_of(f) : f.rm === "g" ? 3 : (f.k + 3) % 8;
/** The instruction, with a register or [address] operand */
const encode = (f, address) => [...f.op,
    ...(address === undefined ? [0xC0 | reg_of(f) << 3 | rm_of(f)] : [0x05 | reg_of(f) << 3, ...u32(address)]),
    ...(f.imm === undefined ? [] : [f.imm])];
/** The memory operand of slot k (for masked stores [EDI]) */
const slot = (f, misaligned) => (f.store || f.masked ? (misaligned ? STORE_M : STORE_A) : (misaligned ? DATA_M : DATA_A)) +
    f.k * SLOT + (misaligned ? skew(f.k) : 0);

// Sources: random bytes, the same at both addresses of a slot; LDMXCSR's is
// the initial MXCSR
const DATA = random_bytes(REGION);
DATA.set(u32(MXCSR_INIT), form("ldmxcsr").k * SLOT);
const DATA_SKEWED = random_bytes(REGION);
for(const f of ALL) DATA_SKEWED.set(DATA.subarray(f.k * SLOT, (f.k + 1) * SLOT - skew(f.k)), f.k * SLOT + skew(f.k));

const movdqu_load = (r, a) => [0xF3, 0x0F, 0x6F, 0x05 | r << 3, ...u32(a)];
const movdqu_store = (r, a) => [0xF3, 0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
const movq_load = (r, a) => [0x0F, 0x6F, 0x05 | r << 3, ...u32(a)];
const movq_store = (r, a) => [0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
const mov_edx = v => [0xBA, ...u32(v)], mov_ebx = v => [0xBB, ...u32(v)], mov_edi = v => [0xBF, ...u32(v)];
const store_edx = a => [0x89, 0x15, ...u32(a)], store_ebx = a => [0x89, 0x1D, ...u32(a)];
const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
const fxsave = a => [0x0F, 0xAE, 0x05, ...u32(a)], fxrstor = a => [0x0F, 0xAE, 0x0D, ...u32(a)];
const EMMS = [0x0F, 0x77], CLTS = [0x0F, 0x06];
const SET_CR0 = bits => [0x0F, 0x20, 0xC0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xC0];
const CLEAR_CR0 = bits => [0x0F, 0x20, 0xC0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xC0];
const SET_CR4 = bits => [0x0F, 0x20, 0xE0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xE0];
const CLEAR_CR4 = bits => [0x0F, 0x20, 0xE0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xE0];
// (every round: the IDT, CR0.TS and CR0.EM clear, OSFXSR, MXCSR, the log)
const PROLOGUE = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS, ...CLEAR_CR0(EM), ...SET_CR4(OSFXSR | OSXMMEXCPT),
    ...ldmxcsr(MXCSR), 0xC7, 0x05, ...u32(LOG_INDEX), ...u32(0)];

class Program
{
    constructor() { this.code = [...PROLOGUE]; this.expected = []; }
    emit(...code) { this.code.push(...code); return this; }
    /** `code`, which raises `fault` ([vector, error code, CR2]) if given */
    insn(code, fault, name = "") {
        if(fault)
        {
            const [vector, error_code = -1, cr2 = 0] = fault;
            this.expected.push({ vector, eip: CODE + this.code.length, error_code: error_code >>> 0, cr2, length: code.length, name });
        }
        return this.emit(...code);
    }
    /** The rounds: the body repeats until byte 0x604 is set, then halts after one more */
    build()
    {
        const code = [...this.code, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
        code.push(0xE9, ...u32(-code.length - 5), 0xF4);
        const lengths = new Uint8Array(code.length);
        for(const { eip, length } of this.expected) lengths[eip - CODE] = length;
        return { code: Uint8Array.from(code), lengths, expected: this.expected };
    }
}

/** A handler for `vector`: logs the fault and skips the faulting instruction (halts if it is not in the table) */
const handler = (vector, error_code) => [
    0x8B, 0x0D, ...u32(LOG_INDEX), // mov ecx, [LOG_INDEX]
    0xC1, 0xE1, 0x04, // shl ecx, 4
    ...(error_code ? [0x58] : [0xB8, ...u32(-1)]), // pop eax / mov eax, -1
    0x89, 0x81, ...u32(LOG + 8), // mov [ecx + LOG + 8], eax
    0xC7, 0x81, ...u32(LOG), ...u32(vector), // mov dword [ecx + LOG], vector
    ...(vector === 14 ? [0x0F, 0x20, 0xD0] : [0x31, 0xC0]), // mov eax, cr2 / xor eax, eax
    0x89, 0x81, ...u32(LOG + 12), // mov [ecx + LOG + 12], eax
    0x8B, 0x04, 0x24, // mov eax, [esp]
    0x89, 0x81, ...u32(LOG + 4), // mov [ecx + LOG + 4], eax
    0xFF, 0x05, ...u32(LOG_INDEX), // inc dword [LOG_INDEX]
    0x0F, 0xB6, 0x80, ...u32(LENGTHS), // movzx eax, byte [eax + LENGTHS]
    0x85, 0xC0, 0x75, 0x03, 0xF4, 0xEB, 0xFD, // test eax, eax; jnz +3; hlt; jmp hlt
    0x01, 0x04, 0x24, // add [esp], eax
    0xCF, // iret
];
const VECTORS = [[6, false], [7, false], [13, true], [14, true], [19, false]];

const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};

const machines = [];
const labels = ["interpreter", ...COMPILED_ARMS.map(arm => arm.label)];
async function run(vm, code, warm, interpreter)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(code, CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 20000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && (compiled_activations(e) - start >>> 0) < 3)
    {
        if(performance.now() > deadline)
        {
            await vm.stop();
            const n = word(vm, LOG_INDEX), last = n ? [0, 4, 8, 12].map(o => hex(word(vm, LOG + (n - 1) * 16 + o))) : [];
            assert.fail(`program timeout at EIP ${hex(cpu.instruction_pointer[0])}, ${n} faults logged, the last ${last.join(" ")}`);
        }
        await sleep(1);
    }
    if(warm) await sleep(50);
    await vm.stop();
}

/** Runs the program on every machine, hot then one round cold; checks the
 * fault log of each run and that the runs agree. Returns the interpreter's. */
async function execute(program, setup = () => {})
{
    const { code, lengths, expected } = program.build();
    const results = [];
    for(const [i, vm] of machines.entries())
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], n) => {
            const h = HANDLER + n * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        for(const warm of [true, false])
        {
            vm.write_memory(lengths, CODE + LENGTHS);
            vm.write_memory(XMM_INIT, PATTERN);
            vm.write_memory(MM_INIT, MM_PATTERN);
            vm.write_memory(Uint8Array.from(u32(MXCSR_INIT)), MXCSR);
            vm.write_memory(DATA, DATA_A);
            vm.write_memory(DATA_SKEWED, DATA_M);
            vm.write_memory(new Uint8Array(REGION).fill(0xEE), STORE_A);
            vm.write_memory(new Uint8Array(REGION).fill(0xEE), STORE_M);
            vm.write_memory(new Uint8Array(REGION), OUT);
            vm.write_memory(new Uint8Array(REGION), LOG);
            vm.write_memory(new Uint8Array(0x1000).fill(0xEE), FXAREA);
            setup(vm);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, code, warm, i === 0);
            results.push({
                label: `${labels[i]} (${warm ? "hot" : "one round"})`,
                log: bytes(vm, LOG, (expected.length + 1) * 16),
                out: bytes(vm, OUT, REGION), store_a: bytes(vm, STORE_A, REGION), store_m: bytes(vm, STORE_M, REGION),
                fxarea: bytes(vm, FXAREA + 0x400, 0x400), below_absent: bytes(vm, ABSENT - 0x40, 0x40),
            });
        }
    }
    for(const result of results)
    {
        const view = new DataView(result.log.buffer);
        for(let n = 0; n <= expected.length; n++)
        {
            const [vector, eip, error_code, cr2] = [0, 4, 8, 12].map(o => view.getUint32(n * 16 + o, true));
            if(n === expected.length)
            {
                assert.equal(vector, 0, `${result.label}: an unexpected fault #${vector} at ${hex(eip)}`);
                break;
            }
            const e = expected[n];
            if(vector !== e.vector || eip !== e.eip || error_code !== e.error_code || cr2 !== e.cr2)
            {
                assert.fail(`${result.label}: fault ${n} (${e.name}): #${vector} at ${hex(eip)}, error code ${hex(error_code)}, CR2 ${hex(cr2)}; ` +
                    `expected #${e.vector} at ${hex(e.eip)}, error code ${hex(e.error_code)}, CR2 ${hex(e.cr2)}`);
            }
        }
        for(const key of ["out", "store_a", "store_m", "fxarea", "below_absent"])
        {
            same(result[key], results[0][key], `${result.label}: ${key} as in the interpreter`);
        }
    }
    return results[0];
}
/** Byte equality, reporting the first difference (the slot's form, for slotted regions) */
function same(actual, expected, what, base = 0)
{
    for(let i = 0; i < Math.max(actual.length, expected.length); i++)
    {
        if(actual[i] !== expected[i])
        {
            const f = ALL[(base + i) / SLOT | 0];
            assert.fail(`${what}: byte ${hex(base + i)}${f ? " (slot of " + f.name + ")" : ""} is ${actual[i]?.toString(16)}, expected ${expected[i]?.toString(16)}`);
        }
    }
}

const load_registers = p => {
    for(let r = 0; r < 8; r++) p.emit(...movdqu_load(r, PATTERN + 16 * r));
    for(let r = 0; r < 8; r++) p.emit(...movq_load(r, MM_PATTERN + 8 * r));
    p.emit(...mov_edx(EDX_INIT), ...mov_ebx(EBX_INIT));
};
// XMM registers at OUT, MMX registers at OUT + 0x80, EDX, EBX and MXCSR at OUT + 0xC0
const save_registers = p => {
    for(let r = 0; r < 8; r++) p.emit(...movdqu_store(r, OUT + 16 * r));
    for(let r = 0; r < 8; r++) p.emit(...movq_store(r, OUT + 0x80 + 8 * r));
    p.emit(...EMMS, ...store_edx(OUT + 0xC0), ...store_ebx(OUT + 0xC4), ...stmxcsr(OUT + 0xC8));
};
const registers_kept = (result, what) => {
    same(result.out.subarray(0, 0x80), XMM_INIT, `${what}: XMM registers kept`);
    assert.equal(new DataView(result.out.buffer).getUint32(0xC8, true), MXCSR_INIT, `${what}: MXCSR kept`);
};
const ABSENT_FORMS = ["addps", "movaps", "movdqa store", "pshufb", "ldmxcsr", "stmxcsr"];

let checks = 0;
try
{
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        // (the region tiers alone: an entry compiles the first time it runs,
        // a fault's resume point runs once a round)
        const regions = arm.ir_tier0 === false ? { ir_region_budget: { hot_threshold: 1 }, ir_sync_publication: true } : {};
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            cpu_features: ["SSSE3"], ...arm, ...regions, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        machines.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }

    // CR4.OSFXSR and CR0.TS. The forms in register and memory variants (the
    // memory operand misaligned or absent), alternating XMM and MMX forms (a
    // block checks the MMX conditions, then those of an XMM form)
    const task = ({ osfxsr, ts, xmm = true }) => {
        const p = new Program();
        load_registers(p);
        if(!osfxsr) p.emit(...CLEAR_CR4(OSFXSR));
        if(ts) p.emit(...SET_CR0(TS));
        const xmm_fault = osfxsr ? [7] : [6], mmx_fault = ts ? [7] : undefined;
        const variants = f => f.masked ? [[mov_edi(slot(f, true)), encode(f)]] :
            [...(f.rm === "-" ? [] : [[[], encode(f)]]), ...(f.memory ? [[[], encode(f, slot(f, true))]] : [])];
        for(let i = 0; i < XMM.length; i++)
        {
            if(xmm) for(const [before, code] of variants(XMM[i])) p.emit(...before).insn(code, xmm_fault, XMM[i].name);
            if(i < MMX.length) for(const [before, code] of variants(MMX[i])) p.emit(...before).insn(code, mmx_fault, MMX[i].name);
        }
        if(xmm) for(const name of ABSENT_FORMS) p.insn(encode(form(name), ABSENT + (form(name).aligned ? 0 : 8)), xmm_fault, name + " [absent]");
        p.insn(EMMS, mmx_fault, "emms").insn(fxsave(FXAREA), mmx_fault, "fxsave");
        if(ts) p.emit(...CLTS);
        if(!osfxsr) p.emit(...SET_CR4(OSFXSR));
        save_registers(p);
        return p;
    };
    const absent = vm => pages(vm, ABSENT, false);
    const reference = await execute(task({ osfxsr: true, ts: false, xmm: false }));
    const without = await execute(task({ osfxsr: false, ts: false }), absent);
    registers_kept(without, "without OSFXSR");
    same(without.out.subarray(0x80, 0xC8), reference.out.subarray(0x80, 0xC8), "without OSFXSR: MMX registers, EDX, EBX as with it");
    same(without.store_m, reference.store_m, "without OSFXSR: memory as with it (the MMX stores)");
    const ud = task({ osfxsr: false, ts: false }).expected.length;
    for(const [osfxsr, what] of [[false, "without OSFXSR, CR0.TS: #UD, MMX forms #NM"], [true, "with CR0.TS: #NM"]])
    {
        const result = await execute(task({ osfxsr, ts: true }), absent);
        registers_kept(result, what);
        same(result.out.subarray(0x80, 0xC0), MM_INIT, `${what}: MMX registers kept`);
        assert.deepEqual([...result.out.subarray(0xC0, 0xC8)], [...u32(EDX_INIT), ...u32(EBX_INIT)], `${what}: EDX, EBX kept`);
        same(result.store_m, new Uint8Array(REGION).fill(0xEE), `${what}: memory kept`);
    }
    for(const vm of machines) pages(vm, ABSENT, true);
    checks += 4;
    console.log(`PASS: without CR4.OSFXSR ${ud} XMM form variants are #UD (also with CR0.TS, misaligned or absent operands) and ${MMX.length} MMX forms, EMMS and FXSAVE run; with CR0.TS all are #NM`);

    // Alignment: every memory form at an aligned, then a misaligned address
    const alignment = misaligned => {
        const p = new Program();
        for(const f of ALL.filter(f => f.memory || f.masked))
        {
            const r = reg_of(f);
            // the register the form writes (or stores), reloaded; the mask too
            if(f.reg === "x") p.emit(...movdqu_load(r, PATTERN + 16 * r));
            if(f.reg === "m") p.emit(...movq_load(r, MM_PATTERN + 8 * r));
            if(f.reg === "g") p.emit(...mov_edx(EDX_INIT));
            if(f.masked && f.rm === "x") p.emit(...movdqu_load(rm_of(f), PATTERN + 16 * rm_of(f)));
            if(f.masked && f.rm === "m") p.emit(...movq_load(rm_of(f), MM_PATTERN + 8 * rm_of(f)));
            if(f.masked) p.emit(...mov_edi(slot(f, misaligned))).insn(encode(f));
            else p.insn(encode(f, slot(f, misaligned)), misaligned && f.aligned ? [13, 0] : undefined, f.name);
            const out = OUT + f.k * SLOT;
            p.emit(...f.reg === "x" ? movdqu_store(r, out) : f.reg === "m" ? movq_store(r, out) : f.reg === "g" ? store_edx(out) : stmxcsr(out));
        }
        const area = FXAREA + (misaligned ? 0x408 : 0);
        p.insn(fxsave(area), misaligned ? [13, 0] : undefined, "fxsave").insn(fxrstor(area), misaligned ? [13, 0] : undefined, "fxrstor");
        p.emit(...EMMS);
        return p;
    };
    const aligned = await execute(alignment(false)), skewed = await execute(alignment(true));
    let faulting = 0, passing = 0;
    for(const f of ALL.filter(f => f.memory || f.masked))
    {
        const at = f.k * SLOT, r = reg_of(f), what = `${f.name} [misaligned by ${skew(f.k)}]`;
        if(f.aligned)
        {
            // #GP(0): the register and memory are kept
            const kept = f.reg === "x" ? XMM_INIT.subarray(16 * r, 16 * r + 16) : f.reg === "m" ? MM_INIT.subarray(8 * r, 8 * r + 8) : Uint8Array.from(u32(EDX_INIT));
            same(skewed.out.subarray(at, at + kept.length), kept, `${what}: register kept`);
            same(skewed.store_m.subarray(at, at + SLOT), new Uint8Array(SLOT).fill(0xEE), `${what}: memory kept`, at);
            faulting++;
        }
        else
        {
            same(skewed.out.subarray(at, at + 16), aligned.out.subarray(at, at + 16), `${what}: result as aligned`, at);
            const s = skew(f.k);
            same(skewed.store_m.subarray(at + s, at + SLOT), aligned.store_a.subarray(at, at + SLOT - s), `${what}: stored as aligned`, at);
            same(skewed.store_m.subarray(at, at + s), new Uint8Array(s).fill(0xEE), `${what}: nothing stored below`, at);
            passing++;
        }
    }
    same(skewed.fxarea.subarray(0, 0x210), new Uint8Array(0x210).fill(0xEE), "fxsave [misaligned]: memory kept");
    checks += 2;
    console.log(`PASS: misaligned, ${faulting} memory forms are #GP(0) without effect (also FXSAVE, FXRSTOR) and ${passing} run as aligned`);

    // #GP(0) for alignment comes before #PF; #NM (CR0.TS) before both
    const order = new Program();
    load_registers(order);
    const cases = [
        ["movaps", ABSENT + 8, [13, 0]],
        ["movaps", ABSENT, [14, 0, ABSENT]],
        ["movaps store", ABSENT + 4, [13, 0]],
        ["movaps store", ABSENT, [14, 2, ABSENT]],
        ["unpcklps", ABSENT + 8, [13, 0]],
        ["unpcklpd", ABSENT, [14, 0, ABSENT]],
        ["pshufd", ABSENT + 1, [13, 0]],
        ["addps", ABSENT + 12, [13, 0]],
        ["pshufb", ABSENT + 2, [13, 0]],
        ["movntdq", ABSENT + 8, [13, 0]],
        ["cvttpd2pi", ABSENT + 8, [13, 0]],
        ["movups", ABSENT + 8, [14, 0, ABSENT + 8]],
        ["movups", ABSENT - 8, [14, 0, ABSENT]],
        ["lddqu", ABSENT - 4, [14, 0, ABSENT]],
        ["movdqu store", ABSENT - 8, [14, 2, ABSENT]],
        ["addss", ABSENT + 8, [14, 0, ABSENT + 8]],
        ["paddd mm", ABSENT + 8, [14, 0, ABSENT + 8]],
    ];
    for(const [name, address, fault] of cases) order.insn(encode(form(name), address), fault, `${name} [${hex(address)}]`);
    order.emit(...SET_CR0(TS));
    for(const [name, address] of [["addps", ABSENT + 8], ["movaps store", ABSENT + 4], ["paddd mm", ABSENT + 8], ["movdqa", DATA_M + 1]])
    {
        order.insn(encode(form(name), address), [7], `${name} [${hex(address)}] with CR0.TS`);
    }
    order.emit(...CLTS);
    save_registers(order);
    const ordered = await execute(order, vm => {
        vm.write_memory(new Uint8Array(0x40).fill(0xEE), ABSENT - 0x40);
        pages(vm, ABSENT, false);
    });
    for(const vm of machines) pages(vm, ABSENT, true);
    registers_kept(ordered, "page faults");
    same(ordered.out.subarray(0x80, 0xC0), MM_INIT, "page faults: MMX registers kept");
    same(ordered.below_absent, new Uint8Array(0x40).fill(0xEE), "a store across into an absent page: nothing written");
    checks++;
    console.log(`PASS: #GP(0) for misalignment before #PF (${cases.length} cases), #NM before both`);
    console.log(`PASS: ${checks} legacy SSE fault checks on ${machines.length} arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
