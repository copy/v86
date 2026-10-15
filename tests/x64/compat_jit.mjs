#!/usr/bin/env node
// Compiled 32-bit code in IA-32e compatibility mode (x64_page_compat32):
// the same hot compatibility-mode routine runs twice under 4-level paging
// with NX. Between the runs, 64-bit code remaps a data page (PTE write +
// INVLPG), which the already compiled code must observe (the 32-bit TLB it
// reads inline is filled from x64 translations). The loop mixes loads,
// stores, PUSH/CALL/RET and patches a CALLed routine after compilation.
// One page (dual) runs as 64-bit and as 32-bit code (bytes that decode
// alike: each mode's function of the same physical page), called in loops
// from both modes; between the runs, 64-bit code patches it (a write to a
// page with a compatibility-mode function). A loop reads a routine's
// immediate and writes it back incremented through one base register and
// displacement page, then calls it: the write must not take the
// translation the reads keep (x64_fast_lookup's kept translations, one
// per kind), as the code page refuses writes to the inline lookups.
// Results must equal the interpreter's, and with x64_page_compat32 the x64
// page tier's compiled code must have run (docs/jit-unification-plan.md
// P7.2, M6's acceptance; the region tiers' arm went with them in M11).
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const ITERATIONS = 200000, PATCHED = 60000, DUAL = 40000, SMC = 3000;
const body = `
; 4 KiB page table at 0x210000 for linear 0x600000..0x7FFFFF (identity), NX
mov rdi,0x210000
mov eax,0x600003
mov ecx,512
.pt:
mov [rdi],rax
add eax,0x1000
add rdi,8
loop .pt
mov rax,0x210003
bts rax,63
mov [0x202018],rax
mov rax,cr3
mov cr3,rax
mov dword [0x700000],0x5EED0001
mov dword [0x600000],0x10101010
call dual64
mov rax,HIGH+second
mov [0x301000],rax
jmp run_compat
second:
; phase 2: linear 0x600000 now maps physical 0x700000
mov qword [0x210000],0x700003
invlpg [0x600000]
; dual's XOR EBX, EAX becomes SUB EBX, EAX (both modes' functions go)
mov byte [dual+2],0x29
call dual64
mov rax,HIGH+done
mov [0x301000],rax
jmp run_compat
run_compat:
push 8
mov eax,compat_entry
push rax
o64 retf
done:
mov rsi,0x601000
mov rdi,0x300010
mov ecx,9
rep movsq
jmp body_end
; the dual page from 64-bit code: EAX at 0x601030 + phase * 4
dual64:
mov ecx,${DUAL}
mov eax,1
mov ebx,7
.loop:
mov edx,dual
call rdx
dec ecx
jnz .loop
mov edx,[0x301008]
mov [0x601030+rdx*4],eax
ret
body_end:
`;
const data = `
bits 32
compat_entry:
mov ecx,${ITERATIONS}
xor eax,eax
xor edx,edx
xor edi,edi
mov dword [helper+2],0x11111111
.loop:
mov ebx,ecx
and ebx,1023
add eax,[0x600000+ebx*4]
mov [0x600000+ebx*4],eax
lea edi,[edi+eax*2+1]
xor edx,eax
rol edx,3
push eax
call helper
pop esi
add edi,esi
dec ecx
jnz .loop
mov ebx,[0x301008]
mov [0x601000+ebx*8],eax
mov [0x601004+ebx*8],edx
mov [0x601010+ebx*8],edi
mov eax,[0x600000]
mov [0x601020+ebx*4],eax
; patch the CALLed routine and run it again
mov dword [helper+2],0x22222222
mov ecx,${PATCHED}
.loop2:
call helper
dec ecx
jnz .loop2
mov [0x601028+ebx*4],edx
; the dual page from 32-bit code: EAX at 0x601038 + phase * 4
mov ecx,${DUAL}
mov eax,1
mov ebx,7
.dual:
call dual
dec ecx
jnz .dual
mov ebx,[0x301008]
mov [0x601038+ebx*4],eax
; the routine's immediate read and written through EBX: EDX at 0x601040
; + phase * 4
mov ecx,${SMC}
mov ebx,smc
xor edx,edx
.smc:
mov eax,[ebx+2]
inc eax
mov [ebx+2],eax
call ebx
dec ecx
jnz .smc
mov ebx,[0x301008]
mov [0x601040+ebx*4],edx
inc dword [0x301008]
jmp 0x18:back_to_64
; its own page: patching it leaves the loop's compiled code in place
align 4096
helper:
add edx,0x11111111
ret
; ADD EDX, imm32 (the immediate at +2), patched by the loop above
align 4096
smc:
add edx,0x01010101
ret
; ADD EAX, EBX; XOR EBX, EAX; RET in either mode
align 4096
dual:
add eax,ebx
xor ebx,eax
ret
bits 64
back_to_64:
jmp [0x301000]
`;
const directory = assemble("compat-jit", long_mode_guest(body, data));
const results = {};
for(const [name, jit, page32] of [["interpreter", false, false], ["page tier, compat interpreted", true, false],
    ["page tier, compat32", true, true]])
{
    let page;
    const result = await actual(directory, {length: 88, timeout: 120000,
        options: jit ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
            jit_switches: {x64_page_compat32: page32 ? 1 : 0}} : {},
        inspect: emulator => {
            const x = emulator.v86.cpu.wm.exports;
            page = {compat_compiles: x.x64_page_stat(36), native: x.x64_page_stat(1)};
        }});
    results[name] = result;
    console.log(`${name}: ${result.subarray(16, 80).toString("hex")} page tier ${JSON.stringify(page)}`);
    if(page32) assert.ok(page.compat_compiles > 0 && page.native > ITERATIONS * 10, "the page tier ran the compatibility-mode code");
}
const view = results.interpreter;
// per phase: EAX/EDX at +0/+4 (+8), EDI at +16 (+8), first data dword at +32 (+4)
assert.notEqual(view.readUInt32LE(16 + 4), view.readUInt32LE(16 + 12), "phase 2 ran on the remapped page");
// the dual page: 64-bit results at +48 (+4), 32-bit ones at +56 (+4)
assert.notEqual(view.readUInt32LE(16 + 48), view.readUInt32LE(16 + 52), "phase 2 ran the patched dual page in 64-bit mode");
assert.notEqual(view.readUInt32LE(16 + 56), view.readUInt32LE(16 + 60), "phase 2 ran the patched dual page in compatibility mode");
// the patched routine: the sum of its immediates
assert.notEqual(view.readUInt32LE(16 + 64), 0, "the patched routine ran");
for(const name of Object.keys(results)) assert.deepEqual(results[name], view, `${name} agrees with the interpreter`);
console.log("PASS compatibility-mode JIT: loads/stores, CALL/RET, patched code (also through a register its reads use), a remapped page and a page run in both modes agree with the interpreter");
