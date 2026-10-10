#!/usr/bin/env node
// Compiled 32-bit code in IA-32e compatibility mode (x64_set_compat_jit):
// the same hot compatibility-mode routine runs twice under 4-level paging
// with NX. Between the runs, 64-bit code remaps a data page (PTE write +
// INVLPG), which the already compiled code must observe (the 32-bit TLB it
// reads inline is filled from x64 translations). The loop mixes loads,
// stores, PUSH/CALL/RET and patches a CALLed routine after compilation.
// Results must equal the interpreter's, and compiled code must have run:
// Tier-0's, or with x64_page_compat32 the x64 page tier's
// (docs/jit-unification-plan.md P7.2).
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const ITERATIONS = 200000, PATCHED = 60000;
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
mov rax,HIGH+second
mov [0x301000],rax
jmp run_compat
second:
; phase 2: linear 0x600000 now maps physical 0x700000
mov qword [0x210000],0x700003
invlpg [0x600000]
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
mov ecx,8
rep movsq
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
inc dword [0x301008]
jmp 0x18:back_to_64
; its own page: patching it leaves the loop's compiled code in place
align 4096
helper:
add edx,0x11111111
ret
bits 64
back_to_64:
jmp [0x301000]
`;
const directory = assemble("compat-jit", long_mode_guest(body, data));
const results = {};
for(const [name, jit, compat, page32] of [["interpreter", false, false, false], ["page tier, compat interpreted", true, false, false],
    ["page tier + compat JIT", true, true, false], ["page tier, compat32", true, false, true]])
{
    let tier0, page;
    const result = await actual(directory, {length: 80, timeout: 120000,
        options: jit ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true,
            jit_switches: {x64_page_compat32: page32 ? 1 : 0}} : {},
        setup: emulator => {
            const x = emulator.v86.cpu.wm.exports;
            x.x64_set_compat_jit(compat);
            if(jit) x.ir_auto_set_idle_mode(0, 1);
        },
        inspect: emulator => {
            const x = emulator.v86.cpu.wm.exports;
            tier0 = emulator.v86.cpu.get_jit_info().ir?.tier0;
            page = {compat_compiles: x.x64_page_stat(36), native: x.x64_page_stat(1)};
        }});
    results[name] = result;
    console.log(`${name}: ${result.subarray(16, 80).toString("hex")} tier-0 ${JSON.stringify(tier0)} page tier ${JSON.stringify(page)}`);
    if(compat) assert.ok(tier0.activations > 0 && tier0.page_functions > 0, "compiled compatibility-mode code ran");
    if(page32) assert.ok(page.compat_compiles > 0 && page.native > ITERATIONS * 10, "the page tier ran the compatibility-mode code");
}
const view = results.interpreter;
// per phase: EAX/EDX at +0/+4 (+8), EDI at +16 (+8), first data dword at +32 (+4)
assert.notEqual(view.readUInt32LE(16 + 4), view.readUInt32LE(16 + 12), "phase 2 ran on the remapped page");
for(const name of Object.keys(results)) assert.deepEqual(results[name], view, `${name} agrees with the interpreter`);
console.log("PASS compatibility-mode JIT: loads/stores, CALL/RET, patched code and a remapped page agree with the interpreter");
