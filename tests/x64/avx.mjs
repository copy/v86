#!/usr/bin/env node
// AVX in the x64 engine (docs/simd-xsave-plan.md 8, P5): the VEX forms in
// 64-bit mode (XMM8-15 through VEX.R, VEX.B and VEX.vvvv, memory operands
// through VEX.X and VEX.B, RIP-relative ones, the VEX.W1 forms with 64-bit
// general-purpose operands) and in compatibility mode (the 32-bit
// interpreter: XMM0-7 only, VZEROUPPER leaving YMM8-15's upper halves),
// against QEMU and the model of tests/rust/avx_model.mjs. Registers are
// loaded with XRSTOR and stored with XSAVE, which shows the upper halves of
// the YMM registers. Faults: #UD without CR4.OSXSAVE or with XCR0 3, #NM
// with CR0.TS, #GP(0) for a misaligned operand of an aligned move and a
// non-canonical address; CR0.EM does not matter. Interpreted, with the x64
// page tier, and with compatibility-mode code compiled. Both blocks loop so
// that they become hot.
//
// P5 part 1: the data movement and logic forms, VZEROUPPER, VLDMXCSR and
// VSTMXCSR. P8: the gathers (VSIB: index registers 8-15 through VEX.X).
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {fileURLToPath} from "node:url";
import {FORMS, big, execute, le, mask, memory_bytes} from "../rust/avx_model.mjs";

const OUT = 0x300000, CASE = OUT + 0x80, SKIP = OUT + 0x84, COUNTER = OUT + 0x88, MATCH = OUT + 0xC0, FAULTS = OUT + 0x100;
// a case's general-purpose result, its memory destination (48 bytes) and its
// XSAVE area (up to 5120 cases; RESULTS beyond the IDT, the stack and
// 0x3FFEA0, which held a heap allocator's header at power-on with the JIT
// enabled: tests/x64/initial_ram.mjs)
const GPR_OUT = OUT + 0x1000, STORES = OUT + 0x29000, RESULTS = OUT + 0x110000;
// a case's fault record ([vector, RIP] as the fault cases'): none expected
const CASE_FAULTS = OUT + 0x15000;
const SPAN = 48, AREA = 832;
// (compatibility-mode code is compiled only after a while)
const IDT = 0x380000, ROUNDS = 400, COMPAT_ROUNDS = 4000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const hex = b => Buffer.from(b).toString("hex");

// 8 register files (XMM0-15, YMM0-15's upper halves, MXCSR) and 1 KiB of memory operands
let seed = 0x13572468;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const AREAS = Array.from({length: 8}, () => {
    const a = new Uint8Array(AREA);
    // (MXCSR: exceptions masked, the floating-point forms run without faults)
    a.set(u32(random() & 0xFFFF | 0x1F80), 24);
    for(let i = 160; i < 416; i++) a[i] = random();
    a[512] = 6;
    for(let i = 576; i < 832; i++) a[i] = random();
    return a;
});
const samples = Uint8Array.from({length: 1024}, () => random());
// (VLDMXCSR's operands: valid values at the last 64 bytes)
for(let i = 960; i < 1024; i += 4) samples.set(u32(random() & 0xFFFF), i);
// (the counts of the shifts by xmm/m128, at COUNTS: below and beyond the
// elements' widths in the low quadword, which alone counts, random bits above
// it; a register count is loaded from there first)
const COUNTS = 512;
[1, 7, 15, 16, 31, 32, 63, 65].forEach((count, k) => samples.set(le(BigInt(count), 8), COUNTS + 16 * k));
const count_shift = f => !f.map && f.kind === "binary" && [0xD1, 0xD2, 0xD3, 0xE1, 0xE2, 0xF1, 0xF2, 0xF3].includes(f.op);
// (the variable shifts' counts, at VCOUNTS: 32 bytes each, quadwords below
// and beyond 64, as dwords those and zeros)
const VCOUNTS = 640;
for(let k = 0; k < 8; k++) for(let e = 0; e < 4; e++) samples.set(le(BigInt((k * 7 + e * 13) % 72), 8), VCOUNTS + 32 * k + 8 * e);
const variable_shift = f => f.map === 2 && f.op >= 0x45 && f.op <= 0x47 && f.kind === "binary";

/** A VEX instruction: fields map, pp, L, W, vvvv (4 bits) and the
 * three-byte prefix; ModRM's reg and r/m register `rm` or memory operand
 * `mem` {base, index, scale, disp}: [base + index << scale + disp32]; imm8.
 * VEX.R, X and B extend registers 8-15. */
function encode({map = 1, pp = 0, l = 0, w = 0, vvvv = 0, three = false}, op, reg, rm, mem, imm8)
{
    let modrm = [], x = 0, b = 0;
    if(mem)
    {
        const {base, index, scale = 0, disp = 0} = mem;
        b = base >> 3;
        if(index !== undefined)
        {
            x = index >> 3;
            modrm = [0x80 | (reg & 7) << 3 | 4, scale << 6 | (index & 7) << 3 | base & 7, ...u32(disp)];
        }
        else if((base & 7) === 4) modrm = [0x80 | (reg & 7) << 3 | 4, 0x24, ...u32(disp)];
        else modrm = [0x80 | (reg & 7) << 3 | base & 7, ...u32(disp)];
    }
    else if(rm !== undefined)
    {
        b = rm >> 3;
        modrm = [0xC0 | (reg & 7) << 3 | rm & 7];
    }
    const r = reg >> 3;
    const tail = [op, ...modrm, ...(imm8 === undefined ? [] : [imm8])];
    const fields = (~vvvv & 15) << 3 | l << 2 | pp;
    if(map === 1 && !w && !three && !x && !b) return [0xC5, (r ? 0 : 0x80) | fields, ...tail];
    return [0xC4, (r ? 0 : 0x80) | (x ? 0 : 0x40) | (b ? 0 : 0x20) | map, w << 7 | fields, ...tail];
}
const GPR64 = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const GPR32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
// general-purpose operands and address registers (not RAX, RDX: XRSTOR/XSAVE's; not RSP)
const OPERANDS = [[1, 9, 14, 6, 11], [1, 3, 6, 7, 5]];
const STORE_KINDS = ["store", "scalar_st", "store64", "gpr_store", "stmxcsr", "extract", "maskstore", "extract128"];
// the kinds with VEX.vvvv (the immediate shifts: the destination) and with imm8
const VVVV = ["binary", "low", "high", "binary_imm", "insert", "insertps", "blendv", "maskload", "maskstore", "insert128", "gather"];
const has_vvvv = c => VVVV.includes(c.f.kind) || ["scalar", "scalar_st"].includes(c.f.kind) && !c.memory ||
    c.f.kind === "fp" && ["three", "from_gpr"].includes(c.f.operands);
const IMMEDIATE = ["load_imm", "binary_imm", "shift_imm", "extract", "insert", "insertps", "blendv", "pcmpstr", "insert128", "extract128"];
// explicit lengths of VPCMPESTRx: within, beyond, negative, beyond 32 bits (with VEX.W1)
const LENGTHS = [0n, 3n, 8n, 9n, 16n, 17n, -1n, -7n, -16n, 0x7FFFFFFFn, -0x80000000n, 0x100000005n, -0x100000002n, 0x8000000000000000n];

// the cases: {long, f, k (register file), d, v, m, memory {base, index, scale, at}, gpr}
const cases = [];
for(const long of [true, false])
{
    const regs = long ? 16 : 8;
    for(const f of FORMS.filter(f => long || !f.long))
    {
        const count = f.kind.startsWith("zero_") ? 2 : 4;
        for(let i = 0; i < count; i++)
        {
            const n = cases.length;
            const memory = f.memory || !f.register && i >= count / 2;
            // (the registers alias in one case of two)
            const d = (n * 5 + (long ? 3 : 0)) % regs, v = i & 1 ? d : (d + 7) % regs, m = i & 1 ? (v + 1) % regs : d;
            const gprs = OPERANDS[long ? 0 : 1];
            const c = {long, f, k: n % 8, d, v, m: memory ? undefined : m, gpr: gprs[n % 3], n};
            if(count_shift(f) && !memory) c.count_from = COUNTS + 16 * (n % 8);
            if(variable_shift(f) && !memory) c.count_from = VCOUNTS + 32 * (n % 8);
            // (every imm8 over the forms' cases; VPBLENDVB: the mask register in imm8[7:4], imm8[7] ignored in compatibility mode;
            // the shifts by imm8 and VPALIGNR mostly counts below the
            // element's or the operand's size, beyond which the result is 0)
            c.imm8 = f.kind === "blendv" ? (n * 5 + 3) % 16 << 4 | n * 7 & 15 : f.kind === "shift_imm" ? (n * 7 + 1) % 20 :
                f.name === "vpalignr" ? (n * 7 + 3) % 36 : n * 37 + 11 & 255;
            if(f.kind === "gather")
            {
                // (destination, mask and indices distinct, #UD otherwise;
                // each index within 256 bytes either side of `at`, a
                // quadword's high half outside 64-bit mode random: address
                // size 32 ignores it; beyond the elements, random)
                [c.v, c.vsib] = [(d + 3) % regs, (d + 5) % regs];
                const scale = n % 4, elements = (f.l ? 32 : 16) / Math.max(f.data, f.index);
                const low = Math.ceil(-256 / 2 ** scale), high = Math.floor((255 - f.data) / 2 ** scale);
                c.indices = 0n;
                for(let e = 0; e < 32 / f.index; e++)
                {
                    const value = e >= elements ? BigInt(random()) :
                        BigInt(low + random() % (high - low + 1)) + (f.index === 8 && !long && e & 1 ? BigInt(random()) << 32n : 0n);
                    c.indices |= BigInt.asUintN(8 * f.index, value) << BigInt(8 * f.index * e);
                }
                c.memory = {base: gprs[3 + n % 2], scale, at: 256 + n % 8, disp: -0x40 + n};
            }
            else if(memory)
            {
                // [base + index << scale + disp]: the operand at `at` of the samples (or of the case's destination)
                // (a VEX.256 store within its 48 bytes: at 16 at most; the
                // aligned ones' operands 32-byte aligned: a destination at
                // n * 48 + 16 * (n & 1), a sample at 32 * (n & 1))
                const store = STORE_KINDS.includes(f.kind);
                const at = count_shift(f) ? COUNTS + 16 * (n % 8) : variable_shift(f) ? VCOUNTS + 32 * (n % 8) :
                    f.aligned ? (f.l && !store ? 32 : 16) * (n & 1) : f.kind === "ldmxcsr" ? 960 + 4 * (n % 16) :
                    f.l && store ? (n * 7) % 17 : (n * 7) % 33;
                // (VPCMPxSTRx: not RCX, which holds ones before)
                const index = f.kind === "pcmpstr" ? gprs[1] : gprs[(n + 1) % 3];
                c.memory = {base: gprs[3 + n % 2], index: i === count - 1 ? index : undefined, scale: n % 4, at, disp: -0x40 + n};
            }
            cases.push(c);
        }
    }
}
const store_kind = c => STORE_KINDS.includes(c.f.kind);
const code = (c, n) => {
    const lines = [], f = c.f;
    const R = c.long ? GPR64 : GPR32;
    lines.push("mov eax,6", "xor edx,edx", `xrstor [areas + ${c.k * AREA}]`);
    let reg = c.d, rm = c.m, mem;
    if(c.memory)
    {
        const {base, index, scale, at, disp} = c.memory;
        const target = store_kind(c) ? `${STORES + n * SPAN + at}` : `samples + ${at}`;
        // (the index register holds 3)
        lines.push(`lea ${R[base]},[${target} - ${disp} - ${index === undefined ? 0 : 3 << scale}]`);
        if(index !== undefined) lines.push(`mov ${R[index]},3`);
        mem = {base, index, scale, disp};
    }
    switch(f.kind)
    {
        case "to_gpr":
            reg = c.gpr;
            lines.push(`mov ${R[c.gpr]},-1`);
            break;
        case "gpr_load": case "gpr_store":
            if(c.memory) break;
            rm = c.gpr;
            c.value = BigInt(random()) << 32n | BigInt(random());
            lines.push(`mov ${R[c.gpr]},${f.kind === "gpr_load" ? "0x" + (c.long ? c.value : c.value & 0xFFFFFFFFn).toString(16) : -1}`);
            break;
        case "ldmxcsr": case "stmxcsr": reg = f.group; break;
        case "maskmov":
            lines.push(`mov ${c.long ? "rdi" : "edi"},${STORES + n * SPAN + 5}`);
            break;
        case "shift_imm": reg = f.group; break;
        case "extract": case "insert":
            if(c.memory) break;
            rm = c.gpr;
            c.value = BigInt(random()) << 32n | BigInt(random());
            lines.push(`mov ${R[c.gpr]},${f.kind === "insert" ? "0x" + (c.long ? c.value : c.value & 0xFFFFFFFFn).toString(16) : -1}`);
            break;
        case "ptest": case "vtest":
            // (OF, SF, AF set by 0x7F + 1, CF by STC)
            lines.push("mov al,0x7F", "add al,1", "stc");
            break;
        case "fp":
            if(f.operands === "comi") lines.push("mov al,0x7F", "add al,1", "stc");
            else if(f.operands === "to_gpr")
            {
                reg = c.gpr;
                lines.push(`mov ${R[c.gpr]},-1`);
            }
            else if(f.operands === "from_gpr" && !c.memory)
            {
                rm = c.gpr;
                c.value = BigInt(random()) << 32n | BigInt(random());
                lines.push(`mov ${R[c.gpr]},0x${(c.long ? c.value : c.value & 0xFFFFFFFFn).toString(16)}`);
            }
            break;
        case "gather":
            // (the indices: 32 bytes jumped over; ..@ labels keep the
            // block's local labels in scope)
            lines.push(`jmp ..@gather_${n}_load`, `..@gather_${n}: dq ${[0, 1, 2, 3].map(k => "0x" + (c.indices >> BigInt(64 * k) & mask(64)).toString(16)).join(",")}`,
                `..@gather_${n}_load:`, `vmovdqu ymm${c.vsib},[..@gather_${n}]`);
            mem.index = c.vsib;
            break;
        case "pcmpstr":
        {
            const value = x => "0x" + BigInt.asUintN(c.long ? 64 : 32, x).toString(16);
            c.lengths = [LENGTHS[n % LENGTHS.length], LENGTHS[(n * 5 + 2) % LENGTHS.length]];
            lines.push("mov al,0x7F", "add al,1", "stc", `mov ${R[0]},${value(c.lengths[0])}`, `mov ${R[2]},${value(c.lengths[1])}`, `mov ${R[1]},-1`);
            break;
        }
    }
    if(f.kind === "to_gpr" && f.imm) lines.push(`mov ${R[c.gpr]},-1`);
    if(c.count_from !== undefined) lines.push(`vmovdqu ${f.l ? "ymm" : "xmm"}${c.m},[samples + ${c.count_from}]`);
    const vvvv = f.kind === "shift_imm" ? c.d : has_vvvv(c) ? c.v : 0;
    const imm8 = IMMEDIATE.includes(f.kind) || f.imm || f.legacy?.imm8 ? c.imm8 : undefined;
    // (VEX.W where ignored: WIG, WIG32 outside 64-bit mode; VEX.L where
    // ignored, but for the floating-point forms: QEMU 10.2 raises #UD for
    // VSQRTSS with VEX.L1 and stops on VROUNDSS's, an assertion of
    // gen_VROUNDSS; tests/rust/avx.mjs has their VEX.L1 cases)
    const fields = {map: f.map || 1, pp: f.pp, w: f.w === undefined || f.wig32 && !c.long ? n & 1 : f.w,
        l: f.l ?? (f.lig && f.kind !== "fp" ? n >> 1 & 1 : 0), three: !!(n & 2), vvvv};
    // (a fault, unexpected, is recorded and the instruction skipped)
    const instruction = f.kind.startsWith("zero_") ? encode(fields, f.op) : encode(fields, f.op, reg, rm, mem, imm8);
    lines.push(`mov dword [${CASE}],${(CASE_FAULTS - FAULTS) / 16 + n}`, `mov dword [${SKIP}],${instruction.length}`);
    lines.push(`db ${instruction.join(",")}`);
    if(["to_gpr"].includes(f.kind) || ["gpr_store", "extract"].includes(f.kind) && !c.memory || f.operands === "to_gpr")
    {
        lines.push(`mov [${GPR_OUT + n * 16}],${R[c.gpr]}`);
    }
    if(f.kind === "pcmpstr") lines.push(`mov [${GPR_OUT + n * 16}],${R[1]}`);
    // (the flags: OF, SF, ZF, AF, PF, CF)
    if(["ptest", "vtest", "pcmpstr"].includes(f.kind) || f.operands === "comi") lines.push(c.long ? "pushfq\npop rax" : "pushfd\npop eax", "and eax,0x8D5", `mov [${GPR_OUT + n * 16 + 8}],eax`);
    lines.push("mov eax,6", "xor edx,edx", `xsave [${RESULTS + n * AREA}]`);
    return lines.join("\n");
};
const block = long => cases.map((c, n) => c.long === long ? code(c, n) : "").filter(Boolean).join("\n");

// VMOVSS and VMOVSD with VEX.L1 (VEX.LIG): the SDM zeroes bits 255:128 of
// the destination register as with VEX.L0 (the operation is VEX.128's).
// QEMU 10.2 runs them as 256-bit operations: between registers those bits
// come from the first source (VEX.vvvv), VMOVSD from memory keeps them
// (VMOVSS from memory zeroes them). Against QEMU, any of these.
const qemu_lig = (c, n) => c.f.lig && c.f.kind !== "fp" && (n >> 1 & 1) === 1;
// VPCMPESTRx with VEX.W1: QEMU 10.2 takes the lengths from EAX and EDX, as
// for REX.W (tests/x64/sse4.mjs), not from RAX and RDX
const qemu_w1 = c => c.f.kind === "pcmpstr" && c.f.w === 1;
// VRCPPS, VRSQRTPS, VRCPSS, VRSQRTSS: approximations within 1.5 * 2^-12 of
// the exact result (SDM): QEMU's and the model's lanes within 2^-10 of each
// other, the special values (NaN, infinite, zero, denormal) exact. QEMU 10.2
// computes a denormal source's (exact) reciprocal or reciprocal square root,
// 2^63 or more; the SDM takes the source as 0.0 and returns ±∞ (the model's)
const approximate = c => c.f.legacy?.kind === "reciprocal";
const close = (q, m) => {
    for(let i = 0; i < 16; i += 4)
    {
        const [x, y] = [q.readUInt32LE(i), m.readUInt32LE(i)];
        const normal = v => (v >>> 23 & 255) !== 0 && (v >>> 23 & 255) !== 255;
        if(x === y) continue;
        if((y & 0x7FFFFFFF) === 0x7F800000 && !((x ^ y) >>> 31) && normal(x) && (x >>> 23 & 255) >= 127 + 63) continue;
        if(!normal(x) || !normal(y) || (x ^ y) >>> 31) return false;
        const [fx, fy] = [q.readFloatLE(i), m.readFloatLE(i)];
        if(Math.abs(fx - fy) > Math.abs(fy) * 2 ** -10) return false;
    }
    return true;
};
// VPBLENDVB outside 64-bit mode: the mask register is imm8[6:4] (SDM vol. 2A,
// 2.3, the /is4 operand); QEMU 10.2 takes imm8[7:4]
const qemu_is4 = c => c.f.kind === "blendv" && !c.long && c.imm8 & 0x80;
// A gather with quadword indices outside 64-bit mode: address size 32 wraps
// each element's address at 4 GiB, a quadword index's high half ignored;
// QEMU 10.2 adds the indices at 64 bits (and faults)
const qemu_vsib32 = c => c.f.kind === "gather" && !c.long && c.f.index === 8;
// The model: each case's XSAVE area (the registers it can reach), its
// general-purpose result and its memory destination (`qemu`: QEMU's
// deviations for qemu_lig, "kept" or "first source")
const expected_case = (c, n, qemu = undefined) => {
    const area = AREAS[c.k], regs = c.long ? 16 : 8;
    const s = {
        x: Array.from({length: 16}, (_, r) => big(area.subarray(160 + 16 * r, 176 + 16 * r))),
        h: Array.from({length: 16}, (_, r) => big(area.subarray(576 + 16 * r, 592 + 16 * r))),
        mxcsr: area[24] | area[25] << 8,
        // (VPCMPxSTRM leave RCX: ones)
        gpr_out: c.f.kind === "pcmpstr" ? Uint8Array.from({length: 16}, (_, i) => i < (c.long ? 8 : 4) ? 255 : 0) : new Uint8Array(16),
        dest: new Uint8Array(SPAN),
    };
    Object.defineProperty(s, "flags", {set: value => { s.gpr_out.set(u32(value), 8); }});
    const at = c.memory?.at ?? 0;
    s.load = bytes => big(samples.subarray(at, at + bytes));
    s.store = (bytes, v) => s.dest.set(le(v, bytes), at);
    s.load_at = (offset, bytes) => big(samples.subarray(at + offset, at + offset + bytes));
    s.store_at = (offset, bytes, v) => s.dest.set(le(v, bytes), at + offset);
    s.masked = (value, selected) => le(value).forEach((b, i) => { if(selected[i]) s.dest[5 + i] = b; });
    s.gpr = r => {
        const value = c.f.kind === "pcmpstr" ? c.lengths[r === 0 ? 0 : 1] : c.value;
        return BigInt.asUintN(c.long ? 64 : 32, value);
    };
    // (32-bit results zero-extended in 64-bit mode; in compatibility mode a 32-bit store)
    s.set_gpr = (r, value) => s.gpr_out.set(le(value, c.long ? 8 : 4));
    const o = {d: c.d, v: c.f.kind === "shift_imm" ? c.d : c.v, m: c.m, imm8: c.imm8, long: c.long, index: c.vsib, scale: c.memory?.scale};
    if(c.f.kind === "to_gpr" || c.f.operands === "to_gpr") Object.assign(o, {d: c.gpr});
    if(["gpr_load", "gpr_store", "extract", "insert"].includes(c.f.kind) && !c.memory || c.f.operands === "from_gpr" && !c.memory) o.m = c.gpr;
    // (a register count: loaded by VMOVDQU, bits 255:128 zeroed but by a
    // VEX.256 form's)
    if(c.count_from !== undefined) [s.x[c.m], s.h[c.m]] = [big(samples.subarray(c.count_from, c.count_from + 16)),
        c.f.l ? big(samples.subarray(c.count_from + 16, c.count_from + 32)) : 0n];
    // (a gather's indices: loaded by VMOVDQU)
    if(c.vsib !== undefined) [s.x[c.vsib], s.h[c.vsib]] = [c.indices & mask(128), c.indices >> 128n];
    const upper = [...s.h];
    execute(qemu === "W0" ? {...c.f, w: 0} : c.f, s, o);
    if(qemu === "kept") s.h = upper;
    if(qemu === "first source" && !c.memory) s.h[c.f.op === 0x10 ? c.d : c.m] = upper[c.v];
    const out = new Uint8Array(AREA);
    out.set(u32(s.mxcsr), 24);
    out.set(u32(0xFFFF), 28);
    for(let r = 0; r < regs; r++)
    {
        out.set(le(s.x[r]), 160 + 16 * r);
        out.set(le(s.h[r]), 576 + 16 * r);
    }
    return {area: out, gpr: s.gpr_out, dest: s.dest};
};
// (the bytes an XSAVE stores: MXCSR and MXCSR_MASK, the XMM and YMM_Hi128 registers of the mode)
const xsave_bytes = (area, long) => Buffer.concat([area.subarray(24, 32), area.subarray(160, long ? 416 : 288), area.subarray(576, long ? 832 : 704)]);

// the faults: [vector, what, long, setup, instruction, the vector QEMU raises instead]
const VMOVAPS = encode({pp: 0}, 0x28, 1, 2), VZEROUPPER = encode({}, 0x77), VLDMXCSR = "vldmxcsr [samples + 960]";
const FAULT_CASES = [];
for(const long of [true, false])
{
    for(const [what, instruction] of [["vmovaps xmm1,xmm2", `db ${VMOVAPS.join(",")}`], ["vzeroupper", `db ${VZEROUPPER.join(",")}`], ["vldmxcsr", VLDMXCSR],
        ...long ? [["vpxor xmm12,xmm13,xmm9", "vpxor xmm12,xmm13,xmm9"], ["vmovq r10,xmm11", "vmovq r10,xmm11"]] : [["vmovd ecx,xmm3", "vmovd ecx,xmm3"]]])
    {
        FAULT_CASES.push([6, `${what} without CR4.OSXSAVE`, long, "no_osxsave", instruction]);
        FAULT_CASES.push([6, `${what} with XCR0 3`, long, "xcr0_3", instruction]);
        FAULT_CASES.push([7, `${what} with CR0.TS`, long, "ts", instruction]);
        FAULT_CASES.push([6, `${what} with CR0.TS, without CR4.OSXSAVE`, long, "ts no_osxsave", instruction]);
    }
    // (0: no fault. VEX forms ignore CR0.EM, SDM exception type tables; QEMU
    // 10.2 raises #UD, as for legacy SSE)
    FAULT_CASES.push([0, "vmovaps xmm1,xmm2 with CR0.EM", long, "em", `db ${VMOVAPS.join(",")}`, 6]);
    FAULT_CASES.push([13, "vmovaps xmm1,[misaligned]", long, "", "vmovaps xmm1,[samples + 8]"]);
    FAULT_CASES.push([13, "vmovntdq [misaligned],xmm2", long, "", `vmovntdq [${STORES + 4}],xmm2`]);
    FAULT_CASES.push([13, "vmovntdqa xmm3,[misaligned]", long, "", "vmovntdqa xmm3,[samples + 4]"]);
    FAULT_CASES.push([0, "vmovups xmm1,[misaligned]", long, "", "vmovups xmm1,[samples + 8]"]);
    // (VEX.256: the aligned moves need 32-byte alignment; samples and
    // STORES are 32-byte aligned)
    FAULT_CASES.push([13, "vmovaps ymm1,[16-byte aligned]", long, "", "vmovaps ymm1,[samples + 16]"]);
    FAULT_CASES.push([13, "vmovntdq [16-byte aligned],ymm2", long, "", `vmovntdq [${STORES + 16}],ymm2`]);
    FAULT_CASES.push([13, "vmovdqa [16-byte aligned],ymm3", long, "", `vmovdqa [${STORES + 48}],ymm3`]);
    FAULT_CASES.push([0, "vmovdqu ymm1,[misaligned]", long, "", "vmovdqu ymm1,[samples + 8]"]);
    // (QEMU 10.2 does not check MXCSR's reserved bits: no fault, and MXCSR
    // takes the value until the next LDMXCSR)
    FAULT_CASES.push([13, "vldmxcsr with a reserved bit", long, "mxcsr", "vldmxcsr [reserved_mxcsr]", 0]);
    if(long)
    {
        FAULT_CASES.push([13, "vmovups xmm1,[non-canonical]", long, "", "mov rbx,0x0000800000000000\nvmovups xmm1,[rbx]"]);
        // (QEMU 10.2 raises #GP(0) for a non-canonical stack address too: tests/x64/system_oracle.mjs)
        FAULT_CASES.push([12, "vmovdqu [rbp non-canonical],xmm1", long, "", "mov rbp,0x0000800000000000\nvmovdqu [rbp],xmm1", 13]);
        // (a gather: the selected element's address, its first)
        FAULT_CASES.push([13, "vpgatherdd xmm1,[non-canonical]", long, "",
            "mov rbx,0x0000800000000000\nvpcmpeqd xmm3,xmm3,xmm3\nvpxor xmm2,xmm2,xmm2\nvpgatherdd xmm1,[rbx+xmm2*4],xmm3"]);
        FAULT_CASES.push([12, "vpgatherqq ymm1,[rbp non-canonical]", long, "",
            "mov rbp,0x0000800000000000\nvpcmpeqd ymm3,ymm3,ymm3\nvpxor xmm2,xmm2,xmm2\nvpgatherqq ymm1,[rbp+ymm2*8],ymm3", 13]);
    }
}
const SET_CR0 = (bits, long) => long ? `mov rax,cr0\nor eax,${bits}\nmov cr0,rax` : `mov eax,cr0\nor eax,${bits}\nmov cr0,eax`;
const CLEAR_CR0 = long => long ? "mov rax,cr0\nand eax,~12\nmov cr0,rax" : "mov eax,cr0\nand eax,~12\nmov cr0,eax";
const CR4 = (long, or, and = -1) => long ? `mov rax,cr4\nor eax,${or}\nand eax,${and}\nmov cr4,rax` : `mov eax,cr4\nor eax,${or}\nand eax,${and}\nmov cr4,eax`;
const XSETBV = value => `xor ecx,ecx\nmov eax,${value}\nxor edx,edx\nxsetbv`;
const faults = long => FAULT_CASES.map(([, what, in_long, setup, instruction], n) => {
    if(in_long !== long) return "";
    const before = [], after = [];
    if(setup.includes("no_osxsave")) { before.push(CR4(long, 0, ~(1 << 18))); after.push(CR4(long, 1 << 18)); }
    if(setup.includes("xcr0_3")) { before.push(XSETBV(3)); after.push(XSETBV(7)); }
    if(setup.includes("ts")) before.push(SET_CR0(8, long));
    if(setup.includes("em")) before.push(SET_CR0(4, long));
    if(setup.includes("mxcsr")) after.push("ldmxcsr [default_mxcsr]");
    // (setup instructions before the faulting one: its address)
    const lines = instruction.split("\n"), last = lines.pop(), prefix = lines.join("\n");
    return `
${before.join("\n")}
${prefix}
mov dword [${CASE}],${n}
mov dword [${SKIP}],fault_end${n} - fault${n}
fault${n}: ${last}
fault_end${n}:
${CLEAR_CR0(long)}
${after.join("\n")}
mov eax,fault${n}
cmp eax,[${FAULTS + n * 16 + 8}]
sete byte [${MATCH + n}]`;
}).join("\n");

const directory = assemble("avx", long_mode_guest(`
mov ebx,6
mov rax,HIGH+ud
call set_gate
mov ebx,7
mov rax,HIGH+nm
call set_gate
mov ebx,12
mov rax,HIGH+stack_fault
call set_gate
mov ebx,13
mov rax,HIGH+gp
call set_gate
mov ebx,14
mov rax,HIGH+page_fault
call set_gate
lidt [rel idtr]
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
${XSETBV(7)}
; 64-bit mode
mov dword [${COUNTER}],${ROUNDS}
.rounds:
${block(true)}
dec dword [${COUNTER}]
jnz .rounds
${faults(true)}
; YMM8-15's upper halves through compatibility mode, where VZEROUPPER leaves them
mov eax,6
xor edx,edx
xrstor [areas]
; compatibility mode
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
db ${VZEROUPPER.join(",")}
mov eax,6
xor edx,edx
xsave [${RESULTS - AREA}]
mov dword [${COUNTER}],${COMPAT_ROUNDS}
.rounds:
${block(false)}
dec dword [${COUNTER}]
jnz .rounds
${faults(false)}
jmp 0x18:back
bits 64
back:
mov eax,6
xor edx,edx
xsave [${RESULTS - 2 * AREA}]
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
nm:
mov ecx,7
jmp record
stack_fault:
add rsp,8
mov ecx,12
jmp record
gp:
add rsp,8
mov ecx,13
jmp record
page_fault:
add rsp,8
mov ecx,14
record:
mov edx,[${CASE}]
shl edx,4
mov [${FAULTS} + rdx],ecx
mov rax,[rsp]
mov [${FAULTS} + rdx + 8],rax
mov eax,[${SKIP}]
add [rsp],rax
iretq
align 8
idtr: dw 511
dq ${IDT}
reserved_mxcsr: dd 0x10000
default_mxcsr: dd 0x1F80
align 64
areas: db ${AREAS.flatMap(a => Array.from(a)).join(",")}
align 32
samples: db ${Array.from(samples).join(",")}
`));

const length = RESULTS - OUT + cases.length * AREA;
assert.ok(cases.length <= 5120 && STORES + cases.length * SPAN <= IDT && GPR_OUT + cases.length * 16 <= CASE_FAULTS && CASE_FAULTS + cases.length * 16 <= STORES);
const check = (result, label) => {
    // the model first: QEMU is a reference, not the specification
    cases.forEach((c, n) => {
        const e = expected_case(c, n, label === "QEMU" && qemu_w1(c) ? "W0" : undefined);
        const what = `${label}: ${c.long ? "64-bit" : "compatibility"} ${c.f.name} (${c.f.op.toString(16)}) case ${n}`;
        if(label === "QEMU" && (qemu_is4(c) || qemu_vsib32(c))) return;
        const area = result.subarray(RESULTS - OUT + n * AREA, RESULTS - OUT + (n + 1) * AREA);
        assert.equal(result.readUInt32LE(CASE_FAULTS - OUT + n * 16), 0, `${what}: no fault`);
        const deviation = label === "QEMU" && qemu_lig(c, n) &&
            ["kept", "first source"].some(qemu => xsave_bytes(area, c.long).equals(xsave_bytes(expected_case(c, n, qemu).area, c.long)));
        if(label === "QEMU" && approximate(c))
        {
            // (the destination within the error, the rest exactly; VEX.256:
            // its upper half in the YMM_Hi128 component too)
            const [q, m] = [Buffer.from(area), Buffer.from(e.area)];
            for(const at of c.f.l ? [160 + 16 * c.d, 576 + 16 * c.d] : [160 + 16 * c.d])
            {
                assert.ok(close(q.subarray(at, at + 16), m.subarray(at, at + 16)), `${what}: an approximation within the error`);
                q.fill(0, at, at + 16);
                m.fill(0, at, at + 16);
            }
            assert.equal(hex(xsave_bytes(q, c.long)), hex(xsave_bytes(m, c.long)), `${what}: registers`);
        }
        else if(!deviation) assert.equal(hex(xsave_bytes(area, c.long)), hex(xsave_bytes(e.area, c.long)), `${what}: registers`);
        assert.equal(hex(result.subarray(GPR_OUT - OUT + n * 16, GPR_OUT - OUT + n * 16 + 16)), hex(e.gpr), `${what}: general-purpose result`);
        assert.equal(hex(result.subarray(STORES - OUT + n * SPAN, STORES - OUT + (n + 1) * SPAN)), hex(e.dest), `${what}: memory`);
    });
    // VZEROUPPER in compatibility mode zeroes YMM0-7's upper halves, and
    // YMM8-15's are kept through the compatibility-mode block (QEMU 10.2
    // zeroes all 16 in every mode: CPU_NB_REGS in gen_VZEROUPPER); VZEROALL
    // there zeroes YMM0-7 and keeps XMM8-15 too (QEMU zeroes all 16)
    const kept = result.subarray(RESULTS - OUT - 2 * AREA, RESULTS - OUT - AREA);
    const zeroed = result.subarray(RESULTS - OUT - AREA, RESULTS - OUT);
    assert.ok(zeroed.subarray(576, 704).every(b => b === 0), `${label}: VZEROUPPER in compatibility mode: YMM0-7 upper halves`);
    assert.equal(hex(kept.subarray(704, 832)), hex(label === "QEMU" ? new Uint8Array(128) : AREAS[0].subarray(704, 832)),
        `${label}: YMM8-15 upper halves kept through compatibility mode`);
    assert.equal(hex(kept.subarray(288, 416)), hex(label === "QEMU" ? new Uint8Array(128) : AREAS[0].subarray(288, 416)),
        `${label}: XMM8-15 kept through compatibility mode (VZEROALL)`);
    FAULT_CASES.forEach(([vector, what, , , , qemu], n) => {
        const deviation = label === "QEMU" && qemu !== undefined;
        assert.equal(result.readUInt32LE(FAULTS - OUT + n * 16), deviation ? qemu : vector, `${label}: ${what}: vector`);
        assert.equal(result[MATCH - OUT + n], (deviation ? qemu : vector) === 0 ? 0 : 1, `${label}: ${what}: RIP`);
    });
};
// v86 against QEMU, but for the fault records, VMOVSS/VMOVSD's upper halves
// and YMM8-15's after compatibility mode, where QEMU deviates
const comparable = buffer => {
    const copy = Buffer.from(buffer);
    cases.forEach((c, n) => {
        // (compatibility mode: XSAVE writes neither XMM8-15 nor YMM8-15's
        // upper halves, which hold what memory held: with the JIT enabled,
        // the power-on heap header at 0x5FFEA8, tests/x64/initial_ram.mjs)
        if(!c.long)
        {
            copy.fill(0, RESULTS - OUT + n * AREA + 288, RESULTS - OUT + n * AREA + 416);
            copy.fill(0, RESULTS - OUT + n * AREA + 704, RESULTS - OUT + (n + 1) * AREA);
        }
        if(qemu_lig(c, n)) copy.fill(0, RESULTS - OUT + n * AREA + 576, RESULTS - OUT + (n + 1) * AREA);
        if(approximate(c))
        {
            copy.fill(0, RESULTS - OUT + n * AREA + 160 + 16 * c.d, RESULTS - OUT + n * AREA + 176 + 16 * c.d);
            if(c.f.l) copy.fill(0, RESULTS - OUT + n * AREA + 576 + 16 * c.d, RESULTS - OUT + n * AREA + 592 + 16 * c.d);
        }
        if(qemu_w1(c) || qemu_is4(c) || qemu_vsib32(c))
        {
            copy.fill(0, RESULTS - OUT + n * AREA, RESULTS - OUT + (n + 1) * AREA);
            copy.fill(0, GPR_OUT - OUT + n * 16, GPR_OUT - OUT + n * 16 + 16);
        }
        // (QEMU's fault there)
        if(qemu_vsib32(c)) copy.fill(0, CASE_FAULTS - OUT + n * 16, CASE_FAULTS - OUT + n * 16 + 16);
    });
    copy.fill(0, RESULTS - OUT - 2 * AREA + 704, RESULTS - OUT - AREA);
    copy.fill(0, RESULTS - OUT - 2 * AREA + 288, RESULTS - OUT - 2 * AREA + 416);
    // (and XMM0-7 and YMM0-7's upper halves there: the last
    // compatibility-mode case's, a gather where QEMU deviates, qemu_vsib32)
    copy.fill(0, RESULTS - OUT - 2 * AREA + 160, RESULTS - OUT - 2 * AREA + 288);
    copy.fill(0, RESULTS - OUT - 2 * AREA + 576, RESULTS - OUT - 2 * AREA + 704);
    // (between the stores and the XSAVE areas: the IDT and the stack, with fault frames)
    copy.fill(0, STORES - OUT + cases.length * SPAN, RESULTS - OUT - 2 * AREA);
    // (XSTATE_BV: XINUSE may be 1 for a component in its initial
    // configuration, SDM vol. 1, 13.6, and QEMU does not track it: after
    // VZEROUPPER, the YMM state is initial for v86)
    for(let n = -2; n < cases.length; n++) copy.fill(0, RESULTS - OUT + n * AREA + 512, RESULTS - OUT + n * AREA + 520);
    FAULT_CASES.forEach(([, , , , , qemu], n) => {
        if(qemu === undefined) return;
        copy.fill(0, FAULTS - OUT + n * 16, FAULTS - OUT + n * 16 + 16);
        copy[MATCH - OUT + n] = 0;
    });
    return copy;
};
const expected = await reference(directory, {length});
// (X64_AVX_LIST=1: list QEMU's differences from the model, for debugging)
if(process.env.X64_AVX_LIST)
{
    cases.forEach((c, n) => {
        const e = expected_case(c, n);
        const area = expected.subarray(RESULTS - OUT + n * AREA, RESULTS - OUT + (n + 1) * AREA);
        const [got, want] = [xsave_bytes(area, c.long), xsave_bytes(e.area, c.long)];
        const registers = [];
        for(let i = 0; i < got.length; i++) if(got[i] !== want[i]) registers.push(i < 8 ? "mxcsr" : i < 8 + (c.long ? 256 : 128) ? "xmm" + (i - 8 >> 4) : "ymmh" + (i - 8 - (c.long ? 256 : 128) >> 4));
        const gpr = !expected.subarray(GPR_OUT - OUT + n * 16, GPR_OUT - OUT + n * 16 + 16).equals(Buffer.from(e.gpr));
        const fault = expected.readUInt32LE(CASE_FAULTS - OUT + n * 16);
        if(fault) registers.push("fault " + fault);
        const memory = !expected.subarray(STORES - OUT + n * SPAN, STORES - OUT + (n + 1) * SPAN).equals(Buffer.from(e.dest));
        if(registers.length || gpr || memory)
        {
            console.log(n, c.long ? "64-bit" : "compat", c.f.name, c.f.kind, c.f.op.toString(16), `d${c.d} v${c.v} m${c.m}`, c.memory ? "memory" : "register",
                `l${c.f.lig ? n >> 1 & 1 : 0} w${c.f.w ?? n & 1}`, [...new Set(registers)].join(" "), gpr ? "gpr" : "", memory ? "memory" : "");
        }
    });
    FAULT_CASES.forEach(([vector, what], n) => {
        const got = expected.readUInt32LE(FAULTS - OUT + n * 16);
        if(got !== vector) console.log("fault", what, "QEMU", got, "SDM", vector);
    });
    process.exit(0);
}
check(expected, "QEMU");
const FEATURES = {cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "AVX2"], cpu_features_unreleased: true};
for(const [label, options, compat] of [["interpreted", {}, false],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}, false],
    // (Tier-0's compatibility-mode code: the page tier's is the default since M9)
    ["x64 page tier + compatibility-mode JIT", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        jit_switches: {x64_page_compat32: 0}}, true],
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
    {
        const [mine, theirs] = [comparable(result), comparable(expected)];
        const at = mine.findIndex((b, i) => b !== theirs[i]);
        assert.ok(at < 0, `${label}: equal to QEMU (but for its documented deviations): first difference at ${(OUT + at).toString(16)}`);
    }
    if(options.disable_jit === false) assert.ok(page > 1000, `${label}: compiled 64-bit code ran (${page})`);
    if(compat) assert.ok(tier0.activations > 0 && tier0.page_functions > 0, `${label}: compiled compatibility-mode code ran ${JSON.stringify(tier0)}`);
    if(options.jit_switches?.x64_page_compat32) assert.ok(page32 > 0, `${label}: the page tier compiled compatibility-mode code (${page32})`);
    console.log(`PASS (${label}): ${cases.length} AVX cases in 64-bit and compatibility mode, ${FAULT_CASES.length} faults, as QEMU and the model`);
}

// The page tier's templates for the hot VEX forms (P5 part 5; the VEX.256
// moves and VZEROALL, P6 part 3; AVX2's, P7 part 3): a hot loop of
// them over ordinary values (finite, normal, of moderate size: no retries)
// runs with almost no steps (x64_page_stat(4)), as QEMU. (Its stores are off
// the code's page, which they would invalidate.) The results' bits
// of every round are summed (R14, R13): an execution the page tier got wrong
// shows even when the last round ran in the interpreter.
{
    const ITERATIONS = 20000;
    const f64 = x => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return [...b]; };
    const hot_samples = [...f64(1.5), ...f64(-2.25), ...f64(3000), ...f64(0.125), ...f64(-7.75), ...f64(1024),
        ...samples.subarray(0, 64)];
    const hot = assemble("avx-hot", long_mode_guest(`
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
${XSETBV(7)}
mov r15d,${ITERATIONS}
xor r14d,r14d
xor r13d,r13d
.loop:
vmovdqu ymm8,[hot_ymm + 8]
vmovdqa ymm9,[hot_ymm + 32]
vmovups ymm10,ymm8
vmovaps ymm11,ymm9
vmovupd [${OUT + 0x488}],ymm10
vmovapd [${OUT + 0x4C0}],ymm11
vmovntdq [${OUT + 0x4E0}],ymm8
vmovntps [${OUT + 0x500}],ymm9
vmovdqu ymm12,[${OUT + 0x488}]
vmovntpd [${OUT + 0x560}],ymm12
vxorps xmm12,xmm12,xmm9
vmovdqu [${OUT + 0x520}],ymm12
vzeroall
vmovdqu [${OUT + 0x540}],ymm11
add r14,[${OUT + 0x498}]
add r14,[${OUT + 0x4D8}]
add r14,[${OUT + 0x4F0}]
add r14,[${OUT + 0x518}]
add r14,[${OUT + 0x578}]
add r13,[${OUT + 0x520}]
add r13,[${OUT + 0x530}]
add r13,[${OUT + 0x548}]
add r13,[${OUT + 0x558}]
vpbroadcastb ymm8,[hot_ymm + 3]
vpbroadcastd ymm9,[hot_ymm + 12]
vpcmpeqb ymm10,ymm8,[hot_ymm + 32]
vpcmpeqd ymm11,ymm9,ymm10
vpaddb ymm12,ymm10,[hot_ymm]
vpandn ymm12,ymm12,ymm8
vpminub ymm12,ymm12,ymm9
vpcmpgtb ymm13,ymm12,ymm8
vpand ymm13,ymm13,ymm11
vpminud ymm13,ymm13,[hot_ymm + 40]
vpor ymm14,ymm13,ymm10
vpxor ymm14,ymm14,ymm9
vpmovmskb eax,ymm14
add r13,rax
vpmovmskb eax,ymm12
add r13,rax
vpbroadcastd xmm15,[hot_ymm + 8]
vpbroadcastb xmm7,xmm14
vpaddb xmm15,xmm15,xmm7
vmovq rax,xmm15
add r14,rax
vmovsd xmm1,[hot_samples]
vmovsd xmm2,[hot_samples + 8]
vaddsd xmm3,xmm1,xmm2
vmulsd xmm4,xmm3,[hot_samples + 16]
vsubsd xmm5,xmm4,xmm1
vdivsd xmm6,xmm5,xmm2
vmovq rax,xmm6
add r14,rax
vcomisd xmm6,xmm1
setb al
movzx eax,al
add r13,rax
vucomisd xmm1,[hot_samples + 24]
seta al
movzx eax,al
add r13,rax
vcmpsd xmm7,xmm1,xmm6,2
vmovq rax,xmm7
add r14,rax
vcmpltpd xmm7,xmm3,[hot_samples + 32]
vmovq rax,xmm7
add r14,rax
vcvttsd2si eax,xmm6
add r13,rax
vcvttsd2si rax,xmm4
add r13,rax
vcvtsi2sd xmm8,xmm1,r15
vcvtsi2sd xmm9,xmm2,r15d
vcvtsd2ss xmm10,xmm2,xmm6
vcvtss2sd xmm11,xmm3,xmm10
vmovq rax,xmm11
add r14,rax
vmulpd xmm12,xmm1,[hot_samples + 8]
vaddss xmm12,xmm12,[hot_samples + 4]
vmovq rax,xmm12
add r14,rax
vxorpd xmm12,xmm1,xmm2
vandnpd xmm12,xmm12,xmm3
vorpd xmm12,xmm12,[hot_samples + 40]
vandpd xmm12,xmm12,xmm8
vxorps xmm12,xmm12,xmm9
vmovdqu xmm13,[hot_samples + 48]
vpcmpeqb xmm14,xmm13,[hot_samples + 64]
vpcmpgtb xmm15,xmm13,xmm14
vpaddb xmm15,xmm15,xmm13
vpcmpeqd xmm0,xmm15,xmm13
vpxor xmm0,xmm0,xmm15
vpand xmm0,xmm0,xmm12
vpor xmm0,xmm0,xmm9
vpandn xmm0,xmm0,xmm11
vpmovmskb eax,xmm0
add r13,rax
vblendvpd xmm1,xmm12,xmm0,xmm15
vunpcklpd xmm2,xmm1,xmm6
vmovapd [${OUT + 0x400}],xmm2
vmovdqa xmm3,[${OUT + 0x400}]
vmovd eax,xmm3
add r13,rax
vmovq rax,xmm1
add r14,rax
vmovd xmm4,r13d
vmovq xmm5,r14
vpaddb xmm0,xmm0,xmm4
vpaddb xmm0,xmm0,xmm5
vzeroupper
dec r15d
jnz .loop
mov [${OUT + 16}],r14
mov [${OUT + 24}],r13
stmxcsr [${OUT + 32}]
${Array.from({length: 16}, (_, r) => `vmovdqu [${OUT + 48 + 16 * r}],xmm${r}`).join("\n")}
`, `
align 16
hot_samples: db ${hot_samples.join(",")}
align 32
hot_ymm: db ${Array.from(samples.subarray(64, 160)).join(",")}
`));
    // (the guest runner's completion word is at OUT)
    const length = 48 + 256;
    const expected = await reference(hot, {length});
    let steps, retired;
    const result = await actual(hot, {length, timeout: 60000,
        options: {...FEATURES, disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        inspect: emulator => {
            steps = emulator.v86.cpu.wm.exports.x64_page_stat(4);
            retired = emulator.v86.cpu.wm.exports.x64_page_stat(1);
        }});
    assert.equal(hex(result), hex(expected), "hot loop: the sums, MXCSR and XMM0-15 as QEMU");
    assert.ok(retired > ITERATIONS * 50 && steps < ITERATIONS / 10, `page tier templates: ${retired} retired, ${steps} steps`);
    console.log(`PASS (x64 page tier): the hot VEX forms' templates, as QEMU (${retired} instructions retired natively, ${steps} steps)`);
}

// The parallel build (cores in workers) reaches guest memory through aligned
// atomics: an unaligned read is served from a copy (x64::pages::BOUNCE), made
// by the access cache's inline code or by x64_page_access, of the read's 16
// or 32 bytes. A hot loop of unaligned 128- and 256-bit loads from a page
// without code, which an aligned read puts in the access cache (unaligned
// reads alone leave it out), compiled by the page tier of
// build/v86-parallel.wasm on the bootstrap processor (two cores: the other
// one waits for its SIPI in a vCPU worker), as QEMU (P12: the inline copy
// took 8 bytes of a 32-byte read, and glibc's AVX2 memcpy garbled printf with
// cores in workers).
{
    const ITERATIONS = 20000;
    const data = Array.from({length: 96}, (_, i) => (i * 37 + 11) & 255);
    const unaligned = assemble("avx-parallel-unaligned", long_mode_guest(`
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
${XSETBV(7)}
mov r15d,${ITERATIONS}
xor r14d,r14d
vpxor xmm0,xmm0,xmm0
vpxor xmm2,xmm2,xmm2
.loop:
add r14,[unaligned_data + 64]
vmovdqu ymm1,[unaligned_data + 1]
vpaddb ymm0,ymm0,ymm1
vpaddb ymm0,ymm0,[unaligned_data + 35]
vpcmpeqb ymm3,ymm1,[unaligned_data + 13]
vpsubb ymm0,ymm0,ymm3
vmovdqu xmm4,[unaligned_data + 5]
vpaddb xmm2,xmm2,xmm4
dec r15d
jnz .loop
vmovdqu [${OUT + 16}],ymm0
vmovdqu [${OUT + 48}],xmm2
mov [${OUT + 64}],r14
`, `
align 4096
unaligned_data: db ${data.join(",")}
`));
    const length = 72;
    const expected = await reference(unaligned, {length});
    let retired;
    const result = await actual(unaligned, {length, timeout: 120000,
        options: {...FEATURES, disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
            cpu_cores: 2, parallel: true, wasm_path: fileURLToPath(new URL("../../build/v86-parallel.wasm", import.meta.url))},
        inspect: emulator => { retired = emulator.v86.cpu.wm.exports.x64_page_stat(1); }});
    assert.equal(hex(result.subarray(16)), hex(expected.subarray(16)), "parallel build: unaligned 128- and 256-bit loads as QEMU");
    assert.ok(retired > ITERATIONS * 5, `parallel build: compiled code ran (${retired} retired)`);
    console.log(`PASS (x64 page tier, parallel build): unaligned VEX.128 and VEX.256 loads in compiled code, as QEMU (${retired} retired natively)`);
}

// The page tier's VEX.256 moves (P6 part 3) check the whole access in
// compiled code: a hot loop's aligned moves and 32-byte stores run without
// faults but in three rounds, a thousand apart: one stores across into an
// absent page (#PF, nothing written), one takes a 16-byte aligned address
// for VMOVAPS ymm, one for VMOVDQA ymm (#GP(0) each). The handlers count the
// faults and skip the 4-byte instruction. (After a retry the runtime
// interprets for a while: single faulting instructions, such as FAULT_CASES,
// and the instructions after one in a round do not run as page-tier code.
// The stores are off the code's page, which they would invalidate.) As QEMU,
// but for the crossing store's low half, which QEMU 10.2 writes (11.1)
{
    const FAULT_ROUNDS = 20000, PATTERN = "0x1122334455667788";
    const fault_loop = assemble("avx-fault-loop", long_mode_guest(`
mov ebx,13
mov rax,HIGH+gp
call set_gate
mov ebx,14
mov rax,HIGH+pf
call set_gate
lidt [rel idtr]
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
${XSETBV(7)}
; (the 2 MiB page at 0x600000 absent)
mov qword [0x202000 + 3 * 8],0
mov rax,cr3
mov cr3,rax
mov rax,${PATTERN}
mov [0x5FFFF0],rax
mov [0x5FFFF8],rax
vmovdqu ymm2,[aligned]
mov r15d,${FAULT_ROUNDS}
xor r14d,r14d
xor r13d,r13d
xor r12d,r12d
.loop:
lea rbx,[aligned]
mov edx,${OUT + 0x800}
mov esi,0x5FFF00
cmp r15d,3001
jne .misaligned_load
mov esi,0x5FFFF0
.misaligned_load:
cmp r15d,2001
jne .misaligned_store
lea rbx,[aligned + 16]
.misaligned_store:
cmp r15d,1001
jne .go
mov edx,${OUT + 0x810}
.go:
vmovaps ymm1,[rbx]
vmovdqa [rdx],ymm2
vmovdqu [rsi],ymm2
add r13,[${OUT + 0x808}]
dec r15d
jnz .loop
mov [${OUT + 16}],r14
mov [${OUT + 24}],r13
mov [${OUT + 32}],r12
mov rax,[0x5FFFF0]
mov [${OUT + 40}],rax
mov rax,[0x5FFFF8]
mov [${OUT + 48}],rax
vmovdqu [${OUT + 64}],ymm1
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
gp:
add rsp,8
inc r14
add qword [rsp],4
iretq
pf:
add rsp,8
inc r12
mov rax,cr2
mov [${OUT + 56}],rax
add qword [rsp],4
iretq
align 8
idtr: dw 511
dq ${IDT}
align 32
aligned: db ${Array.from(samples.subarray(160, 256)).join(",")}
`));
    const length = 96;
    const expected = await reference(fault_loop, {length});
    let retired;
    const result = await actual(fault_loop, {length, timeout: 60000,
        options: {...FEATURES, disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        inspect: emulator => { retired = emulator.v86.cpu.wm.exports.x64_page_stat(1); }});
    const pattern = BigInt(PATTERN);
    assert.deepEqual([16, 32, 56].map(at => result.readBigUInt64LE(at)), [2n, 1n, 0x600000n], "#GP twice, #PF once at 0x600000");
    assert.deepEqual([40, 48].map(at => result.readBigUInt64LE(at)), [pattern, pattern], "the crossing store wrote nothing");
    // (QEMU: its low half written)
    for(const b of [result, expected]) b.fill(0, 40, 56);
    assert.equal(hex(result), hex(expected), "the fault counts, CR2, the sums and YMM1 as QEMU");
    assert.ok(retired > FAULT_ROUNDS * 8, `the loop ran as page-tier code (${retired} instructions retired natively)`);
    console.log(`PASS (x64 page tier): VEX.256 alignment and cross-page faults in compiled code, as QEMU (${retired} retired natively)`);
}

// The page tier's conversion and compare templates at the edges of what
// they admit, legacy and VEX forms, as QEMU, in compiled loops whose results'
// bits are summed every round (R14): one of admitted operands only (exact
// results, so no flags: a 53-bit integer, the ends of the integer ranges,
// equal operands of CMP's NLT and NLE), run natively with almost no steps;
// then one loop each for an inexact conversion (PE, set natively) and for
// operands the templates refuse (retried in the interpreter: IE), MXCSR
// reset before each.
{
    const ITERATIONS = 20000;
    const f64 = x => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return [...b]; };
    const edge_samples = [...f64(2147483647), ...f64(-2147483648), ...f64(-(2 ** 63)), ...f64(1.5), ...f64(2 ** -125),
        ...f64(2147483648), ...f64(-2147483649)];
    const loop = (n, body) => `mov r15d,${ITERATIONS}
xor r14d,r14d
ldmxcsr [edge_mxcsr]
.loop${n}:
${body}
dec r15d
jnz .loop${n}
mov [${OUT + 16 + 16 * n}],r14
stmxcsr [${OUT + 24 + 16 * n}]`;
    const sum = (move, register) => `${move} rax,${register}\nadd r14,rax`;
    const loops = [
        // admitted: exact
        [`mov rax,0x10000000000001
vcvtsi2sd xmm1,xmm1,rax
${sum("vmovq", "xmm1")}
mov rax,0x20000000000000
cvtsi2sd xmm2,rax
${sum("movq", "xmm2")}
mov eax,0xFFFFFF
vcvtsi2ss xmm3,xmm3,eax
vmovd eax,xmm3
add r14,rax
${[0, 8].map(at => `vmovsd xmm4,[edge_samples + ${at}]
vcvttsd2si eax,xmm4
add r14,rax
cvtsd2si ebx,xmm4
add r14,rbx`).join("\n")}
vmovsd xmm4,[edge_samples + 16]
vcvttsd2si rax,xmm4
add r14,rax
vmovsd xmm5,[edge_samples + 32]
vcvtsd2ss xmm6,xmm6,xmm5
vmovd eax,xmm6
add r14,rax
vmovsd xmm7,[edge_samples + 24]
vcmpsd xmm8,xmm7,xmm7,5
${sum("vmovq", "xmm8")}
vcmpsd xmm8,xmm7,xmm7,6
${sum("vmovq", "xmm8")}
vcmpps xmm9,xmm7,xmm7,13
${sum("vmovq", "xmm9")}
movapd xmm10,xmm7
cmpsd xmm10,xmm7,5
${sum("movq", "xmm10")}
movapd xmm11,xmm7
cmppd xmm11,xmm7,6
${sum("movq", "xmm11")}`, true],
        // inexact: a 54-bit integer (PE)
        [`mov rax,0x20000000000001
vcvtsi2sd xmm1,xmm1,rax
${sum("vmovq", "xmm1")}`, true],
        // refused: beyond the 32-bit range (IE, the integer indefinite)
        [`vmovsd xmm4,[edge_samples + 40]
vcvttsd2si eax,xmm4
add r14,rax`, false],
        [`vmovsd xmm4,[edge_samples + 48]
cvttsd2si eax,xmm4
add r14,rax`, false],
    ];
    const edges = assemble("avx-edges", long_mode_guest(`
mov rax,cr4
or eax,3 << 9 | 1 << 18 ; OSFXSR, OSXMMEXCPT, OSXSAVE
mov cr4,rax
${XSETBV(7)}
${loops.map(([body], n) => loop(n, body)).join("\n")}
`, `
align 16
edge_samples: db ${edge_samples.join(",")}
edge_mxcsr: dd 0x1F80
`));
    // (the guest runner's completion word is at OUT)
    const length = 16 + 16 * loops.length;
    const expected = await reference(edges, {length});
    let steps;
    const result = await actual(edges, {length, timeout: 60000,
        options: {...FEATURES, disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        inspect: emulator => { steps = emulator.v86.cpu.wm.exports.x64_page_stat(4); }});
    loops.forEach((_, n) => assert.equal(hex(result.subarray(16 + 16 * n, 32 + 16 * n)), hex(expected.subarray(16 + 16 * n, 32 + 16 * n)),
        `edge loop ${n}: the sum and MXCSR as QEMU`));
    // (the refused loops retry: those of the others are few)
    assert.ok(steps < ITERATIONS * 2 + ITERATIONS / 10, `edge loops: ${steps} steps`);
    console.log(`PASS (x64 page tier): conversion and compare templates at the edges, as QEMU (${steps} steps)`);
}
