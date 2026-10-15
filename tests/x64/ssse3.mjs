#!/usr/bin/env node
// SSSE3 in the x64 engine (docs/simd-xsave-plan.md P3): the MMX and XMM forms
// in 64-bit mode (XMM8-15 through REX, which MMX registers ignore) and in
// compatibility mode, with register and memory sources, against QEMU and the
// SDM model of tests/rust/ssse3_model.mjs; #GP(0) for a misaligned XMM memory
// operand (none for MMX), #NM with CR0.TS, #UD with CR0.EM or F3, in both
// modes. Interpreted and with the x64 page tier, with and without its
// compatibility-mode code (x64_page_compat32). Both blocks loop so that they
// become hot.
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {OPS, PALIGNR, model} from "../rust/ssse3_model.mjs";

const OUT = 0x300000, CASE = OUT + 0x80, SKIP = OUT + 0x84, MATCH = OUT + 0xC0, FAULTS = OUT + 0x100, RESULTS = OUT + 0x1000;
// (compatibility-mode code is compiled only after a while)
const IDT = 0x380000, ROUNDS = 400, COMPAT_ROUNDS = 20000;

// 16 sample vectors: random bytes and lanes of edge values
const samples = new Uint8Array(16 * 16);
{
    const view = new DataView(samples.buffer);
    let seed = 0x13579BDF;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const edges = [[1, [0x00, 0x01, 0x7F, 0x80, 0x81, 0xFF, 0x40, 0xC0]],
        [2, [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8001, 0xFFFF, 0x4000, 0xC000]],
        [4, [0, 1, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0x40000000, 0xC0000000]]];
    for(let n = 0; n < 16; n++)
    {
        const [size, values] = edges[n % 4] || [1, null];
        for(let i = 0; i < 16; i += size)
        {
            const value = values ? values[random() & 7] : random() & 255;
            if(size === 1) samples[n * 16 + i] = value;
            else if(size === 2) view.setUint16(n * 16 + i, value, true);
            else view.setUint32(n * 16 + i, value, true);
        }
    }
}
const sample = i => samples.subarray(i * 16, i * 16 + 16);

// the cases: [long, xmm, op, memory, dst, src, a, b, imm8]
const cases = [];
for(const [op, name] of OPS)
{
    for(const long of [true, false]) for(const xmm of [true, false]) for(const memory of [false, true])
    {
        const imms = op === PALIGNR ? (long && !memory ? [0, 1, 4, 7, 8, 9, 15, 16, 17, 24, 31, 32, 200] : [3, 12, 20]) : [0];
        const pairs = memory ? [[3, 6]] : [[0, 1], [2, 5], [7, 7]];
        for(const imm8 of imms) for(const [a, b] of op === PALIGNR ? [[9, 10]] : pairs)
        {
            const n = cases.length;
            const count = long && xmm ? 16 : 8, base = long && xmm ? 8 : 0;
            const dst = base + n % 8;
            // (a destination that is also the source: sample pair [7, 7] and every 11th case)
            const src = memory ? undefined : a === b || n % 11 === 0 ? dst : (dst + 1 + n * 5 % (count - 1)) % count;
            cases.push({long, xmm, op, name, memory, dst, src, a, b, imm8,
                // (MMX memory operands need no alignment)
                offset: memory && !xmm ? n & 7 : 0});
        }
    }
}
const code = (c, n) => {
    const reg = r => (c.xmm ? "xmm" : "mm") + r, load = c.xmm ? "movdqu" : "movq";
    const at = i => `[samples + ${i * 16}]`;
    const lines = [`${load} ${reg(c.dst)},${at(c.a)}`];
    if(!c.memory) lines.push(`${load} ${reg(c.src)},${at(c.b)}`);
    lines.push(c.raw || `${c.name} ${reg(c.dst)},${c.memory ? `[samples + ${c.b * 16 + c.offset}]` : reg(c.src)}${c.op === PALIGNR ? "," + c.imm8 : ""}`);
    lines.push(`${load} [${RESULTS + n * 16}],${reg(c.dst)}`);
    return lines.join("\n");
};
const block = long => cases.map((c, n) => c.long === long ? code(c, n) : "").filter(Boolean).join("\n");

// 64-bit mode ignores REX for MMX registers: REX.WRB PSHUFB mm2,mm3
cases.push({long: true, xmm: false, op: 0x00, name: "pshufb", memory: false, dst: 2, src: 3, a: 4, b: 11, imm8: 0, offset: 0,
    raw: "db 0x4D, 0x0F, 0x38, 0x00, 0xD3"});

// the faults: [vector, what, long, instruction]
const FAULT_CASES = [
    [13, "pshufb xmm8,[misaligned]", true, "pshufb xmm8,[samples + 8]"],
    [13, "palignr xmm1,[misaligned]", false, "palignr xmm1,[samples + 4],3"],
    [7, "pabsd xmm9,xmm10 with CR0.TS", true, "pabsd xmm9,xmm10"],
    [7, "phaddw mm1,mm2 with CR0.TS", false, "phaddw mm1,mm2"],
    [6, "pmulhrsw xmm1,xmm2 with CR0.EM", true, "pmulhrsw xmm1,xmm2"],
    [6, "psignb mm1,mm2 with CR0.EM", false, "psignb mm1,mm2"],
    [6, "F3 pshufb xmm1,xmm2", true, "db 0xF3, 0x66, 0x0F, 0x38, 0x00, 0xCA"],
    [6, "F3 pshufb mm1,mm2", false, "db 0xF3, 0x0F, 0x38, 0x00, 0xCA"],
];
const SET_CR0 = (bits, long) => long ? `mov rax,cr0\nor eax,${bits}\nmov cr0,rax` : `mov eax,cr0\nor eax,${bits}\nmov cr0,eax`;
const CLEAR_CR0 = long => long ? "mov rax,cr0\nand eax,~12\nmov cr0,rax" : "mov eax,cr0\nand eax,~12\nmov cr0,eax";
const faults = long => FAULT_CASES.map(([vector, what, in_long, instruction], n) => in_long !== long ? "" : `
${vector === 7 ? SET_CR0(8, long) : vector === 6 && what.includes("CR0.EM") ? SET_CR0(4, long) : ""}
mov dword [${CASE}],${n}
mov dword [${SKIP}],fault_end${n} - fault${n}
fault${n}: ${instruction}
fault_end${n}:
${CLEAR_CR0(long)}
mov eax,fault${n}
cmp eax,[${FAULTS + n * 16 + 8}]
sete byte [${MATCH + n}]`).join("\n");

const directory = assemble("ssse3", long_mode_guest(`
mov ebx,6
mov rax,HIGH+ud
call set_gate
mov ebx,7
mov rax,HIGH+nm
call set_gate
mov ebx,13
mov rax,HIGH+gp
call set_gate
lidt [rel idtr]
mov rax,cr4
or eax,3 << 9 ; OSFXSR, OSXMMEXCPT
mov cr4,rax
; 64-bit mode
mov ecx,${ROUNDS}
.rounds:
${block(true)}
dec ecx
jnz .rounds
emms
${faults(true)}
; compatibility mode
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
mov ecx,${COMPAT_ROUNDS}
.rounds:
${block(false)}
dec ecx
jnz .rounds
emms
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
nm:
mov ecx,7
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
align 16
samples: db ${Array.from(samples).join(",")}
`));

const length = RESULTS - OUT + cases.length * 16;
const expected = await reference(directory, {length});
const check = (result, label) => {
    // the model first: QEMU is a reference, not the specification
    cases.forEach((c, n) => {
        const size = c.xmm ? 16 : 8;
        const source = c.memory ? samples.subarray(c.b * 16 + c.offset, c.b * 16 + c.offset + size) : sample(c.b).subarray(0, size);
        const destination = !c.memory && c.src === c.dst ? source : sample(c.a).subarray(0, size);
        const value = result.subarray(RESULTS - OUT + n * 16, RESULTS - OUT + n * 16 + size);
        assert.deepEqual(Uint8Array.from(value), model(c.op, destination, source, c.imm8),
            `${label}: ${c.long ? "64-bit" : "compatibility"} ${c.name} ${c.xmm ? "xmm" : "mm"}${c.dst}, ${c.memory ? "[mem]" : (c.xmm ? "xmm" : "mm") + c.src} ${c.imm8}`);
    });
    FAULT_CASES.forEach(([vector, what], n) => {
        assert.equal(result.readUInt32LE(FAULTS - OUT + n * 16), vector, `${label}: ${what}: vector`);
        assert.equal(result[MATCH - OUT + n], 1, `${label}: ${what}: RIP`);
    });
};
check(expected, "QEMU");
for(const [label, options] of [["interpreted", {}],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}],
    // (compatibility-mode code in the page tier, docs/jit-unification-plan.md P7.2)
    ["x64 page tier, compat32", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
        jit_switches: {x64_page_compat32: 1}}]])
{
    let page = 0, page32 = 0;
    const result = await actual(directory, {length, timeout: 120000, options: {cpu_features: ["SSSE3"], ...options},
        inspect: emulator => {
            page = emulator.v86.cpu.wm.exports.x64_page_stat(1);
            page32 = emulator.v86.cpu.wm.exports.x64_page_stat(36);
        }});
    check(result, label);
    assert.ok(result.equals(expected), `${label}: equal to QEMU`);
    if(options.disable_jit === false) assert.ok(page > 1000, `${label}: compiled 64-bit code ran (${page})`);
    if(options.jit_switches?.x64_page_compat32) assert.ok(page32 > 0, `${label}: the page tier compiled compatibility-mode code (${page32})`);
    console.log(`PASS (${label}): ${cases.length} SSSE3 cases in 64-bit and compatibility mode, ${FAULT_CASES.length} faults, as QEMU and the SDM model`);
}

// The page tier has templates for PSHUFB and PALIGNR (register and aligned
// memory sources): a hot loop of them runs without steps (x64_page_stat(4))
const ITERATIONS = 100000;
const hot = assemble("ssse3-hot", long_mode_guest(`
mov rax,cr4
or eax,3 << 9
mov cr4,rax
movdqu xmm9,[samples]
mov ecx,${ITERATIONS}
.loop:
movdqu xmm8,[samples + 16]
pshufb xmm8,xmm9
palignr xmm8,[samples + 32],5
pshufb xmm10,[samples + 48]
palignr xmm11,xmm8,20
dec ecx
jnz .loop
movdqu [${OUT + 16}],xmm8
movdqu [${OUT + 32}],xmm10
movdqu [${OUT + 48}],xmm11
`, `
align 16
samples: db ${Array.from(samples.subarray(0, 64)).join(",")}
`));
let steps, retired;
const result = await actual(hot, {length: 64, timeout: 60000,
    options: {cpu_features: ["SSSE3"], disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
    inspect: emulator => {
        steps = emulator.v86.cpu.wm.exports.x64_page_stat(4);
        retired = emulator.v86.cpu.wm.exports.x64_page_stat(1);
    }});
const xmm8 = model(PALIGNR, model(0x00, sample(1), sample(0)), sample(2), 5);
assert.deepEqual(Uint8Array.from(result.subarray(16, 32)), xmm8, "hot loop: XMM8");
assert.deepEqual(Uint8Array.from(result.subarray(48, 64)), model(PALIGNR, new Uint8Array(16), xmm8, 20), "hot loop: XMM11");
assert.ok(retired > ITERATIONS * 4 && steps < ITERATIONS / 10, `page tier templates: ${retired} retired, ${steps} steps`);
console.log(`PASS (x64 page tier): PSHUFB and PALIGNR templates (${retired} instructions retired natively, ${steps} steps)`);
