#!/usr/bin/env node
// What an SMI handler that enters long mode itself finds (as OVMF's SMI entry
// does: src/rust/cpu/smm.rs, docs/uefi.md): the guest leaves upper halves in
// GDTR's and IDTR's bases, RSP and RAX, and its PML4 in extended RAM above
// 4 GiB (CR3's upper half), then sends itself an SMI from 64-bit code. Its
// handler at SMBASE + 0x8000 loads GDTR, IDTR and CR3 in 16-bit code (32-bit
// values), enables long mode, sets ESP in compatibility mode and reads them in
// 64-bit mode: the bases and CR3 zero-extended (LGDT, LIDT and MOV to CR3
// outside 64-bit mode), RSP and RAX without the old upper halves (the general
// registers' are cleared on SMM entry). RSM restores the guest's whole values.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const body = `
; the local APIC: PDPT[3] -> a page directory with its 2 MiB page (uncached)
mov qword [0x201018], 0x203003
mov eax, 0xFEE0009B
mov [0x203000+0x1F7*8], rax
mov rax, cr3
mov cr3, rax
; the SMI handler at SMBASE + 0x8000
lea rsi, [rel smi_handler]
mov edi, 0x38000
mov ecx, smi_handler_end - smi_handler
rep movsb
; GDTR and IDTR with an upper half in their bases (nothing reads either
; until they are restored: no segment loads, interrupts off)
sgdt [0x300100]
sidt [0x300110]
mov rbx, 0xFFFFFE3D00000000
mov rax, [0x300102]
or rax, rbx
mov [0x300122], rax
mov ax, [0x300100]
mov [0x300120], ax
lgdt [0x300120]
mov rax, [0x300112]
or rax, rbx
mov [0x300132], rax
mov ax, [0x300110]
mov [0x300130], ax
lidt [0x300130]
; the PML4 above 4 GiB: a page directory mapping linear 2 GiB to the
; extended RAM at 4 GiB (PDPT[2]), the PML4 copied there, CR3 pointing to it
mov qword [0x201010], 0x204003
mov rax, 0x100000083
mov [0x204000], rax
mov rax, cr3
mov cr3, rax
mov esi, 0x200000
mov edi, 0x80000000
mov ecx, 512
rep movsq
mov rax, 0x100000000
mov cr3, rax
; RSP and RAX with upper halves
mov rbp, rsp
mov rcx, 0x0000777700000000
or rsp, rcx
mov rax, 0x1111222233334444
; an SMI to this core: ICR delivery mode SMI, shorthand self
mov edi, 0xFEE00000
mov dword [rdi+0x310], 0
mov dword [rdi+0x300], 0x40200
mov [0x300008], rax
mov [0x300010], rsp
mov rsp, rbp
mov rax, cr3
mov [0x300018], rax
mov eax, 0x200000
mov cr3, rax
sgdt [0x300140]
sidt [0x300150]
lgdt [0x300100]
lidt [0x300110]
; what the handler saw
mov esi, 0x500300
mov edi, 0x300200
mov ecx, 0x38
rep movsb
`;
// (run at 0x3000:0x8000, its addresses linear through SMM's 4 GiB segments;
// the guest's GDT: 8 32-bit code, 16 data, 24 64-bit code)
const data = `
bits 16
smi_handler:
o32 lgdt [dword gdtr]
o32 lidt [dword smm_idtr]
mov eax, 0x200000
mov cr3, eax
mov eax, cr4
or eax, 0x20
mov cr4, eax
mov ecx, 0xC0000080
mov eax, 0x900
xor edx, edx
wrmsr
mov eax, cr0
or eax, 0x80000001
mov cr0, eax
jmp dword 8:(0x38000 + .compatibility - smi_handler)
bits 32
.compatibility:
mov ax, 16
mov ds, ax
mov ss, ax
mov esp, 0x3F000
jmp 24:(0x38000 + .long - smi_handler)
bits 64
.long:
sgdt [0x500300]
sidt [0x500310]
mov [0x500320], rsp
mov [0x500328], rax
mov rax, cr3
mov [0x500330], rax
rsm
smi_handler_end:
smm_idtr: dw 0x1FF
dd 0x12345000
`;
const directory = assemble("smm-entry-state", long_mode_guest(body, data));
const result = await actual(directory, {length: 0x300, timeout: 30000, options: {cpu_type: "x86_64", extended_memory_size: 2 << 20}});
const u64 = offset => result.readBigUInt64LE(offset);
const u16 = offset => result.readUInt16LE(offset);

assert.equal(u64(0), 0xC064C064n, "guest completed");
assert.equal(u64(0x202) >> 32n, 0n, "the handler's GDTR: a 32-bit base from 16-bit code, zero-extended");
assert.equal(u64(0x202), u64(0x102), "the handler's GDTR: the guest's table");
assert.equal(u16(0x200), u16(0x100), "the handler's GDTR limit");
assert.equal(u64(0x212), 0x12345000n, "the handler's IDTR: zero-extended");
assert.equal(u64(0x220), 0x3F000n, "RSP: ESP set in compatibility mode, no old upper half");
assert.equal(u64(0x228) >> 32n, 0n, "RAX: the upper half cleared on entry");
assert.equal(u64(0x230), 0x200000n, "CR3: set in 16-bit code, zero-extended");
assert.equal(u64(0x18), 0x100000000n, "CR3 after RSM: the PML4 above 4 GiB");
assert.equal(u64(0x08), 0x1111222233334444n, "RAX after RSM");
assert.equal(u64(0x10) >> 32n, 0x7777n, "RSP after RSM: its upper half");
assert.equal(u64(0x142), u64(0x122), "GDTR after RSM: the base with its upper half");
assert.equal(u64(0x152), u64(0x132), "IDTR after RSM: the base with its upper half");
console.log("X64_SMM_ENTRY_STATE_PASS");
