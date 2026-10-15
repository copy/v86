#!/usr/bin/env node
// BMI1, BMI2, TZCNT, LZCNT and MOVBE in the x64 engine (docs/simd-xsave-plan.md
// 9.2, P10): in 64-bit mode (VEX.W1: 64-bit operands; R8-R15 through VEX.R,
// VEX.B and VEX.vvvv; 32-bit results zero-extended; memory sources) and in
// compatibility mode (32-bit operands, VEX.W ignored), against
// tests/rust/bmi_model.mjs (v86's values for the flags the SDM leaves
// undefined) and QEMU (those flags masked). The flags are set before each
// case; MULX, PDEP, PEXT, RORX and the shifts keep them. Faults: #UD for
// VEX.L1, a prefix before VEX and MOVBE from a register; no AVX state
// requirements. Both blocks loop: interpreted, then with the x64 page tier,
// then also with the page tier in compatibility mode.
// (Compatibility mode's cases include VEX.W1, which is ignored there.)
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {ARITHMETIC, VEX_FORMS, ops, v86_flags} from "../rust/bmi_model.mjs";

const OUT = 0x300000, CASE = OUT + 0x80, SKIP = OUT + 0x84, MATCH = OUT + 0xC0, FAULTS = OUT + 0x100, RESULTS = OUT + 0x1000;
const IDT = 0x380000, ROUNDS = 200, COMPAT_ROUNDS = 2000;
const SLOT = 32;

let seed = 0x13579BDF;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const random64 = () => BigInt(random()) << 32n | BigInt(random());
const EDGES = [0n, 1n, 2n, 0x7FFFFFFFn, 0x80000000n, 0xFFFFFFFFn, 0x100000000n, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn,
    0x7FFFFFFFFFFFFFFFn, 0xFFFF0000FFFF0000n, 0x5555555555555555n, 0x0000F0F000000000n, 0xFFFFFFFF00000000n, 0x8000000000000001n];
const value = n => n % 3 === 0 ? EDGES[(n / 3 | 0) % EDGES.length] : random64();
// BEXTR's control and BZHI's index
// (start 64 or 32 with a length: beyond a 64-bit or 32-bit operand)
const CONTROLS = [0x0000n, 0x0804n, 0x2000n, 0x4000n, 0x1F01n, 0x2001n, 0x3F01n, 0x0040n, 0x00FFn, 0xFF00n, 0xFFFFn, 0x10101n, 0x0510n, 0x203Cn, 0xFFFF0303n,
    0x0840n, 0xFF40n, 0x0820n, 0x2020n];
const INDICES = [0n, 1n, 4n, 31n, 32n, 33n, 63n, 64n, 65n, 255n, 0x100n, 0x101Fn, 0xFFFFFF05n, 7n, 0xFFFFFFFFFFFFFF20n];

const R64 = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const R32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi", "r8d", "r9d", "r10d", "r11d", "r12d", "r13d", "r14d", "r15d"];
const R16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di", "r8w", "r9w", "r10w", "r11w", "r12w", "r13w", "r14w", "r15w"];
const name_of = (r, bits) => (bits === 64 ? R64 : bits === 32 ? R32 : R16)[r];
// registers for operands: not RSP; R8-R15 in 64-bit mode
const USABLE = long => long ? [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] : [0, 1, 2, 3, 5, 6, 7];

// The cases: { long, name, bits, roles..., before: register values, flags (0/1), expected }
const VEX = ["andn", "bextr", "blsi", "blsmsk", "blsr", "bzhi", "mulx", "pdep", "pext", "rorx", "sarx", "shlx", "shrx"];
const cases = [];
for(const long of [true, false])
{
    const regs = USABLE(long);
    for(const name of VEX) for(const bits of long ? [32, 64] : [32])
    {
        // (BEXTR and BZHI: each control and index in each size)
        const count = name === "bextr" ? CONTROLS.length : name === "bzhi" ? INDICES.length : 12;
        for(let k = 0; k < count; k++)
        {
            const n = cases.length;
            const memory = k >= count - 4;
            // (destination, vvvv and r/m: distinct, but aliasing in some cases)
            const d = regs[n % regs.length], v = regs[(n + (k % 4 === 0 ? 0 : 5)) % regs.length], m = regs[(n + (k % 4 === 1 ? 0 : 9)) % regs.length];
            const second = name === "bextr" ? CONTROLS[k] : name === "bzhi" ? INDICES[k] :
                ["sarx", "shlx", "shrx"].includes(name) ? BigInt(n * 13 % 140) : value(n + 1);
            // (compatibility mode: some register forms with VEX.W1)
            const w1 = !long && !memory && k % 3 === 2;
            cases.push({long, kind: "vex", name, bits, d, v, m, memory, source: value(n), second, rdx: random64(), imm8: n * 37 % 256, flags: n & 1, w1});
        }
    }
    for(const name of ["tzcnt", "lzcnt"]) for(const bits of long ? [16, 32, 64] : [16, 32])
        for(let k = 0; k < 8; k++)
        {
            const n = cases.length;
            cases.push({long, kind: "count", name, bits, d: regs[n % regs.length], m: regs[(n + 4) % regs.length], memory: k >= 5,
                source: k < 2 ? 0n : value(n), before: random64(), flags: n & 1});
        }
    for(const bits of long ? [16, 32, 64] : [16, 32])
        for(let k = 0; k < 4; k++)
        {
            const n = cases.length;
            cases.push({long, kind: "movbe", name: "movbe", bits, d: regs[n % regs.length], source: value(n), before: random64(), flags: n & 1});
        }
}
const mask = bits => (1n << BigInt(bits)) - 1n;
const hex64 = v => "0x" + BigInt.asUintN(64, v).toString(16);

/** A case's code: the flags first (MOV keeps them), the registers, the
 * instruction; then the slot: two destinations, the flags, memory */
const code = (c, n) => {
    const out = RESULTS + n * SLOT, data = out + 24, reg = r => name_of(r, c.long ? 64 : 32);
    const lines = [c.flags ? "xor eax,eax" : "mov al,0x7F\nadd al,1\nstc"];
    const set = (r, v) => lines.push(`mov ${reg(r)},${hex64(c.long ? v : v & 0xFFFFFFFFn)}`);
    // (a memory source first, through RAX/EAX, which the registers' values follow)
    if(c.memory || c.kind === "movbe") lines.push(`mov ${reg(0)},${hex64(c.long ? c.source : c.source & 0xFFFFFFFFn)}`, `mov [${data}],${reg(0)}`);
    if(c.kind === "vex")
    {
        // every operand register a known value: RDX (MULX), VEX.vvvv, r/m
        for(const r of USABLE(c.long)) set(r, 0x1111111111111111n * BigInt(r + 1));
        set(2, c.rdx);
        if(c.name !== "rorx" && !["blsi", "blsmsk", "blsr"].includes(c.name)) set(c.v, c.second);
        if(!c.memory) set(c.m, c.source);
        const w = c.bits, o = r => name_of(r, w), src = c.memory ? `${w === 64 ? "qword" : "dword"} [${data}]` : o(c.m);
        const text = {
            andn: `andn ${o(c.d)},${o(c.v)},${src}`, bextr: `bextr ${o(c.d)},${src},${o(c.v)}`, bzhi: `bzhi ${o(c.d)},${src},${o(c.v)}`,
            blsi: `blsi ${o(c.v)},${src}`, blsmsk: `blsmsk ${o(c.v)},${src}`, blsr: `blsr ${o(c.v)},${src}`,
            mulx: `mulx ${o(c.d)},${o(c.v)},${src}`, pdep: `pdep ${o(c.d)},${o(c.v)},${src}`, pext: `pext ${o(c.d)},${o(c.v)},${src}`,
            rorx: `rorx ${o(c.d)},${src},${c.imm8}`, sarx: `sarx ${o(c.d)},${src},${o(c.v)}`, shlx: `shlx ${o(c.d)},${src},${o(c.v)}`,
            shrx: `shrx ${o(c.d)},${src},${o(c.v)}`,
        }[c.name];
        if(c.w1)
        {
            // (NASM has no VEX.W1 form of 32-bit registers: the bytes)
            const f = VEX_FORMS.find(f => f.name === c.name), vvvv = c.name === "rorx" ? 0 : c.v;
            const bytes = [0xC4, 0xE0 | f.map, 0x80 | (~vvvv & 15) << 3 | f.pp, f.op, 0xC0 | (f.group ?? c.d) << 3 | c.m, ...c.name === "rorx" ? [c.imm8] : []];
            lines.push(`db ${bytes.join(",")}`);
        }
        else lines.push(text);
        const first = ["blsi", "blsmsk", "blsr"].includes(c.name) ? c.v : c.d;
        lines.push(`mov [${out}],${reg(first)}`);
        if(c.name === "mulx") lines.push(`mov [${out + 8}],${reg(c.v)}`);
    }
    else if(c.kind === "count")
    {
        set(c.d, c.before);
        if(!c.memory && c.m !== c.d) set(c.m, c.source);
        const width = ["", "", "word", "", "dword", "", "", "", "qword"][c.bits / 8];
        lines.push(`${c.name} ${name_of(c.d, c.bits)},${c.memory ? `${width} [${data}]` : name_of(c.m, c.bits)}`, `mov [${out}],${reg(c.d)}`);
    }
    else
    {
        // MOVBE: load into the register, store from it
        set(c.d, c.before);
        const width = ["", "", "word", "", "dword", "", "", "", "qword"][c.bits / 8];
        lines.push(`movbe ${name_of(c.d, c.bits)},${width} [${data}]`, `mov [${out}],${reg(c.d)}`);
        lines.push(`mov qword [${out + 8}],0`.replace("qword", c.long ? "qword" : "dword"), `movbe ${width} [${out + 8}],${name_of(c.d, c.bits)}`);
    }
    lines.push(c.long ? "pushfq\npop rax" : "pushfd\npop eax", "and eax,0x8D5", `mov [${out + 16}],eax`);
    return lines.join("\n");
};
/** The model's slot of a case (v86's undefined flags; `qemu`: those masked) */
const expected = c => {
    const slot = new Uint8Array(SLOT), view = new DataView(slot.buffer);
    const width = c.long ? 64 : 32, full = mask(width);
    const write = (at, v) => { if(c.long) view.setBigUint64(at, BigInt.asUintN(64, v), true); else view.setUint32(at, Number(v & 0xFFFFFFFFn), true); };
    // the register file before the instruction
    const regs = [];
    let flags_before = c.flags ? 0x44 : 0x891, defined = ARITHMETIC, flags;
    if(c.kind === "vex")
    {
        for(const r of USABLE(c.long)) regs[r] = (0x1111111111111111n * BigInt(r + 1)) & full;
        regs[2] = c.rdx & full;
        if(c.name !== "rorx" && !["blsi", "blsmsk", "blsr"].includes(c.name)) regs[c.v] = c.second & full;
        if(!c.memory) regs[c.m] = c.source & full;
        const bits = c.bits, source = (c.memory ? c.source : regs[c.m]) & mask(bits);
        // (32-bit results zero-extended: the low `bits` of the register)
        const set = (r, v) => { regs[r] = v & mask(bits); };
        let r;
        switch(c.name)
        {
            case "andn": case "pdep": case "pext": r = ops[c.name](regs[c.v], source, bits); set(c.d, r.result); break;
            case "bextr": case "bzhi": case "sarx": case "shlx": case "shrx": r = ops[c.name](source, regs[c.v], bits); set(c.d, r.result); break;
            case "blsi": case "blsmsk": case "blsr": r = ops[c.name](source, bits); set(c.v, r.result); break;
            case "mulx": r = ops.mulx(regs[2], source, bits); set(c.v, r.low); set(c.d, r.result); break;
            case "rorx": r = ops.rorx(source, BigInt(c.imm8), bits); set(c.d, r.result); break;
        }
        const first = ["blsi", "blsmsk", "blsr"].includes(c.name) ? c.v : c.d;
        write(0, regs[first]);
        if(c.name === "mulx") write(8, regs[c.v]);
        if(r.flags) { flags = v86_flags(regs[first], bits, r.flags); defined = r.flags.defined; }
        else flags = flags_before;
    }
    else if(c.kind === "count")
    {
        regs[c.d] = c.before & full;
        if(!c.memory && c.m !== c.d) regs[c.m] = c.source & full;
        const source = c.memory ? c.source : regs[c.m];
        const r = ops[c.name](source, c.bits);
        // (16 bits: the rest kept; 32: zero-extended)
        const result = c.bits === 16 ? regs[c.d] & ~0xFFFFn | r.result : r.result;
        write(0, result);
        flags = v86_flags(r.result, c.bits, r.flags);
        defined = r.flags.defined;
    }
    else
    {
        const loaded = ops.movbe(c.source & mask(c.bits), c.bits).result;
        const before = c.before & full;
        const result = c.bits === 16 ? before & ~0xFFFFn | loaded : loaded;
        write(0, result);
        // (the store: the register's bytes reversed again, the source's)
        view.setBigUint64(8, c.source & mask(c.bits), true);
        if(!c.long) view.setUint32(12, 0, true);
        flags = flags_before;
    }
    view.setUint32(16, flags, true);
    return {slot, defined};
};

const block = long => cases.map((c, n) => c.long === long ? code(c, n) : "").filter(Boolean).join("\n");
// faults: [vector, what, long, code, QEMU's vector where it deviates]
const FAULT_CASES = [];
for(const long of [true, false])
{
    FAULT_CASES.push([6, "andn with VEX.L1", long, "db 0xC4, 0xE2, 0x64, 0xF2, 0xCA"]);
    FAULT_CASES.push([6, "66 andn", long, "db 0x66, 0xC4, 0xE2, 0x60, 0xF2, 0xCA"]);
    FAULT_CASES.push([6, "movbe from a register", long, "db 0x0F, 0x38, 0xF0, 0xC1"]);
    // (VEX.vvvv must be 1111b where no operand, SDM vol. 2A 2.3.6; QEMU 10.2
    // does not check)
    FAULT_CASES.push([6, "rorx with VEX.vvvv 2", long, "db 0xC4, 0xE3, 0x6B, 0xF0, 0xCA, 0x03", 0]);
    // (no AVX state requirements: CR4.OSXSAVE is clear here, and CR0.TS set)
    FAULT_CASES.push([0, "andn without CR4.OSXSAVE, with CR0.TS", long, long ? "mov rax,cr0\nbts rax,3\nmov cr0,rax\nandn ecx,ebx,edx" : "mov eax,cr0\nbts eax,3\nmov cr0,eax\nandn ecx,ebx,edx"]);
}
const faults = long => FAULT_CASES.map(([, , in_long, instruction], n) => {
    if(in_long !== long) return "";
    const lines = instruction.split("\n"), last = lines.pop();
    return `
${lines.join("\n")}
mov dword [${CASE}],${n}
mov dword [${SKIP}],fault_end${n} - fault${n}
fault${n}: ${last}
fault_end${n}:
clts
mov eax,fault${n}
cmp eax,[${FAULTS + n * 16 + 8}]
sete byte [${MATCH + n}]`;
}).join("\n");

const directory = assemble("bmi", long_mode_guest(`
mov ebx,6
mov rax,HIGH+ud
call set_gate
mov ebx,13
mov rax,HIGH+gp
call set_gate
lidt [rel idtr]
mov dword [${OUT + 0x88}],${ROUNDS}
.rounds:
${block(true)}
dec dword [${OUT + 0x88}]
jnz .rounds
${faults(true)}
; compatibility mode
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
mov dword [${OUT + 0x88}],${COMPAT_ROUNDS}
.rounds:
${block(false)}
dec dword [${OUT + 0x88}]
jnz .rounds
${faults(false)}
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
gp:
add rsp,8
mov ecx,13
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
`));

const length = RESULTS - OUT + cases.length * SLOT;
const check = (result, label) => {
    cases.forEach((c, n) => {
        const {slot, defined} = expected(c);
        const got = result.subarray(RESULTS - OUT + n * SLOT, RESULTS - OUT + (n + 1) * SLOT);
        const what = `${label}: ${c.long ? "64-bit" : "compatibility"} ${c.name} (${c.bits}) case ${n}${c.memory ? " memory" : ""}`;
        assert.equal(Buffer.from(got.subarray(0, 16)).toString("hex"), Buffer.from(slot.subarray(0, 16)).toString("hex"), `${what}: destinations`);
        const flags = new DataView(got.buffer, got.byteOffset).getUint32(16, true), want = new DataView(slot.buffer).getUint32(16, true);
        // (QEMU: the flags the SDM defines; v86: those and its values for the rest)
        const compared = label === "QEMU" ? defined : ARITHMETIC;
        assert.equal(flags & compared, want & compared, `${what}: flags ${flags.toString(16)}, expected ${want.toString(16)} (compared ${compared.toString(16)})`);
    });
    FAULT_CASES.forEach(([vector, what, , , qemu], n) => {
        const want = label === "QEMU" && qemu !== undefined ? qemu : vector;
        assert.equal(result.readUInt32LE(FAULTS - OUT + n * 16), want, `${label}: ${what}: vector`);
        assert.equal(result[MATCH - OUT + n], want === 0 ? 0 : 1, `${label}: ${what}: RIP`);
    });
};
const expected_qemu = await reference(directory, {length});
check(expected_qemu, "QEMU");
const FEATURES = {cpu_type: "x86_64", cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "BMI1", "BMI2", "LZCNT", "MOVBE"], cpu_features_unreleased: true};
for(const [label, options] of [["interpreted", {}],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}],
    // (compatibility-mode code in the page tier, docs/jit-unification-plan.md P7.2)
    ["x64 page tier, compat32", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        jit_switches: {x64_page_compat32: 1}}]])
{
    let page = 0, page32 = 0;
    const result = await actual(directory, {length, timeout: 180000, options: {...FEATURES, ...options},
        inspect: emulator => {
            page = emulator.v86.cpu.wm.exports.x64_page_stat(1);
            page32 = emulator.v86.cpu.wm.exports.x64_page_stat(36);
        }});
    check(result, label);
    if(options.disable_jit === false) assert.ok(page > 1000, `${label}: compiled 64-bit code ran (${page})`);
    if(options.jit_switches?.x64_page_compat32) assert.ok(page32 > 0, `${label}: the page tier compiled compatibility-mode code (${page32})`);
    console.log(`PASS (${label}): ${cases.length} BMI1/BMI2/TZCNT/LZCNT/MOVBE cases in 64-bit and compatibility mode, ${FAULT_CASES.length} faults, as the model and QEMU`);
}

// The page tier's templates for the hot BMI forms (P10 part 2, plan 5.1):
// a hot loop of TZCNT and LZCNT, SHRX/SARX/SHLX, BLSMSK, BLSR, BLSI, BZHI
// and ANDN on 32- and 64-bit operands and MOVBE loads and stores runs with
// almost no steps (x64_page_stat(4)), as QEMU. Every round adds the results
// to R14 and, right after each instruction, the flags the SDM defines for
// it to R13 (the shifts keep STC's CF): an execution the page tier got
// wrong shows even when the last round ran in the interpreter. Three calls
// end in a BMI instruction, so their flags stay in the lazy record until
// the caller reads them. (The stores are off the code's page.) CRC32 from
// memory (F2 0F 38 F0/F1, SSE4.2) sits beside MOVBE's rows.
{
    const ITERATIONS = 20000;
    const fold = mask => `pushfq\npop rdx\nand edx,${mask}\nadd r13,rdx`;
    // (CF ZF; CF ZF SF OF; CF)
    const COUNT = 0x41, LOGIC = 0x8C1, CARRY = 0x1;
    const hot = assemble("bmi-hot", long_mode_guest(`
jmp .start
.tz:
tzcnt eax,esi
ret
.bi:
blsi rax,rbx
ret
.bz:
bzhi eax,edi,ecx
ret
.start:
mov r15d,${ITERATIONS}
xor r14d,r14d
xor r13d,r13d
.loop:
imul rdi,r15,0x9E3779B1
mov rbx,rdi
shl rbx,13
xor rbx,rdi
mov ecx,r15d
and ecx,0x3F
mov esi,r15d
and esi,0xFF
mov [${OUT + 0x400}],rdi
mov [${OUT + 0x408}],rbx
tzcnt eax,edi
${fold(COUNT)}
add r14,rax
tzcnt rax,rbx
${fold(COUNT)}
add r14,rax
lzcnt eax,ecx
${fold(COUNT)}
add r14,rax
lzcnt rax,rdi
${fold(COUNT)}
add r14,rax
tzcnt eax,esi
${fold(COUNT)}
add r14,rax
lzcnt rax,rsi
${fold(COUNT)}
add r14,rax
stc
shrx eax,edi,ecx
${fold(CARRY)}
add r14,rax
sarx rax,rdi,rcx
add r14,rax
shlx eax,ebx,ecx
add r14,rax
shlx rax,[${OUT + 0x408}],rcx
add r14,rax
blsmsk eax,edi
${fold(LOGIC)}
add r14,rax
blsmsk rax,rsi
${fold(LOGIC)}
add r14,rax
blsr rax,rdi
${fold(LOGIC)}
add r14,rax
blsr eax,esi
${fold(LOGIC)}
add r14,rax
blsi rax,rbx
${fold(LOGIC)}
add r14,rax
bzhi eax,edi,ecx
${fold(LOGIC)}
add r14,rax
bzhi rax,rbx,rcx
${fold(LOGIC)}
add r14,rax
andn eax,edi,ebx
${fold(LOGIC)}
add r14,rax
andn rax,rbx,[${OUT + 0x400}]
${fold(LOGIC)}
add r14,rax
call .tz
${fold(COUNT)}
add r14,rax
call .bi
${fold(LOGIC)}
add r14,rax
call .bz
${fold(LOGIC)}
add r14,rax
movbe eax,[${OUT + 0x400}]
add r14,rax
movbe rax,[${OUT + 0x408}]
add r14,rax
movbe [${OUT + 0x410}],edi
movbe [${OUT + 0x418}],rbx
add r14,[${OUT + 0x410}]
add r14,[${OUT + 0x418}]
crc32 eax,byte [${OUT + 0x401}]
crc32 eax,dword [${OUT + 0x404}]
crc32 rax,qword [${OUT + 0x408}]
add r14,rax
dec r15d
jnz .loop
mov [${OUT + 16}],r14
mov [${OUT + 24}],r13
`));
    const length = 32;
    const expected = await reference(hot, {length});
    let steps, retired;
    const result = await actual(hot, {length, timeout: 60000,
        options: {...FEATURES, disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
        inspect: emulator => {
            steps = emulator.v86.cpu.wm.exports.x64_page_stat(4);
            retired = emulator.v86.cpu.wm.exports.x64_page_stat(1);
        }});
    assert.equal(Buffer.from(result.subarray(16, 32)).toString("hex"), Buffer.from(expected.subarray(16, 32)).toString("hex"), "hot loop: the sums as QEMU");
    // (CRC32 has no page-tier template: three steps a round)
    assert.ok(retired > ITERATIONS * 50 && steps < ITERATIONS * 3 + ITERATIONS / 10, `page tier templates: ${retired} retired, ${steps} steps`);
    console.log(`PASS (x64 page tier): the hot BMI forms' templates, as QEMU (${retired} instructions retired natively, ${steps} steps)`);
}
