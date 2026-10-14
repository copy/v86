#!/usr/bin/env node
// The x86-64 CPU profile advertises RDTSCP (CPUID.80000001h:EDX[27]) in every
// mode, and a 32-bit Linux kernel on cpu_type: "x86_64" uses it with EFER.LMA
// clear (rdtsc_ordered). RDTSCP used to be implemented only by the long-mode
// engine; 32-bit code took #UD. In 32-bit protected mode it returns the TSC in
// EDX:EAX and IA32_TSC_AUX in ECX (all 32 bits, with an operand-size prefix
// too), and with CR4.TSD it raises #GP at CPL 3 but not at CPL 0. The legacy
// profile does not advertise it and keeps #UD. Interpreted, then compiled:
// the probe repeats until the IR compiles its page, and a new TSC_AUX each
// round shows every RDTSCP reads the current one.
// Compiled compatibility-mode code (EFER.LMA set) steps through the same
// 32-bit instruction, which must agree with the long-mode engine: RDTSCP in
// either profile there.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

// (the flags live with the results: a store to the code page would keep the
// JIT from compiling the probe)
const OUT = 0x300000, BAD = OUT + 4, FEATURES = OUT + 8, FAULTED = OUT + 12, MISMATCHES = OUT + 16,
    FAULTS = OUT + 20, RECORDS = OUT + 32, ROUNDS = 100000;
const TSS = 0x2F0000, KERNEL_STACK = 0x200000, INTERRUPT_STACK = 0x1F0000, USER_STACK = 0x1E0000;
// TSC_AUX in each round (the round counter counts down to 1)
const AUX = 0x12340000;
const SENTINELS = [0xEEEEEEEE, 0xDDDDDDDD, 0xCCCCCCCC];
const STEPS = ["CPL 0", "CPL 0, o16, CR4.TSD", "CPL 3, CR4.TSD", "CPL 3"];
// the vector each step raises, or 0
const EXPECTED = {x64: [0, 0, 13, 0], legacy: [6, 6, 6, 6]};

const directory = assemble("protected-mode-rdtscp", `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
%macro probe 0-1
mov dword [${FAULTED}],0
mov eax,${SENTINELS[0]}
mov edx,${SENTINELS[1]}
mov ecx,${SENTINELS[2]}
%1 rdtscp
call record
%endmacro
start:
cli
; a GDT with ring 3 segments and a TSS, then an IDT whose #UD and #GP
; handlers skip the faulting RDTSCP and flag it; INT 30h (clear CR4.TSD) and
; INT 31h (back to ring 0) are open to ring 3
lgdt [gdtr]
jmp 8:.flat
.flat:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,${KERNEL_STACK}
mov dword [${TSS + 4}],${INTERRUPT_STACK}
mov dword [${TSS + 8}],16
mov word [${TSS + 102}],104
mov ax,0x28
ltr ax
mov ebx,0
.gate:
mov eax,other
mov dx,0x8E00
call set_gate
inc ebx
cmp ebx,0x32
jb .gate
mov ebx,6
mov eax,ud_handler
call set_gate
mov ebx,13
mov eax,gp_handler
call set_gate
mov ebx,0x30
mov eax,clear_tsd
mov dx,0xEE00
call set_gate
mov ebx,0x31
mov eax,to_kernel
call set_gate
lidt [idtr]
mov eax,0x80000001
cpuid
mov [${FEATURES}],edx
mov ebp,${ROUNDS}
round:
mov edi,${RECORDS}
lea esi,[ebp + ${AUX}]
mov eax,cr4
and eax,~4
mov cr4,eax
; only a CPU with RDTSCP has TSC_AUX
test dword [${FEATURES}],1 << 27
jz .no_aux
mov ecx,0xC0000103
mov eax,esi
xor edx,edx
wrmsr
.no_aux:
rdtsc
mov [edi],eax
mov [edi + 4],edx
add edi,8
probe
mov eax,cr4
or eax,4
mov cr4,eax
probe o16
push 0x23
push ${USER_STACK}
push 2
push 0x1B
push .user
iret
.user:
mov ax,0x23
mov ds,ax
mov es,ax
probe
int 0x30
probe
int 0x31
round_end:
rdtsc
mov [edi],eax
mov [edi + 4],edx
dec ebp
jnz round
mov dword [${OUT}],0xC064C064
.halt:
hlt
jmp .halt
; [FAULTED], EAX, EDX, ECX; ECX must be this round's TSC_AUX unless it faulted
record:
mov ebx,[${FAULTED}]
mov [edi],ebx
mov [edi + 4],eax
mov [edi + 8],edx
mov [edi + 12],ecx
add edi,16
test ebx,ebx
jnz .faulted
cmp ecx,esi
je .done
inc dword [${MISMATCHES}]
jmp .done
.faulted:
inc dword [${FAULTS}]
.done:
ret
; eax: handler, ebx: vector, dx: type
set_gate:
mov [idt + ebx * 8],ax
mov word [idt + ebx * 8 + 2],8
mov [idt + ebx * 8 + 4],dx
shr eax,16
mov [idt + ebx * 8 + 6],ax
ret
gp_handler:
mov dword [${FAULTED}],13
add esp,4                       ; the error code
jmp skip
ud_handler:
mov dword [${FAULTED}],6
skip:                           ; past RDTSCP (3 bytes) or o16 RDTSCP (4)
push eax
mov eax,[esp + 4]
cmp byte [eax],0x66
pop eax
jne .short
inc dword [esp]
.short:
add dword [esp],3
iret
clear_tsd:
push eax
mov eax,cr4
and eax,~4
mov cr4,eax
pop eax
iret
to_kernel:
mov esp,${KERNEL_STACK}
mov ax,16
mov ds,ax
mov es,ax
jmp round_end
other:
mov dword [${BAD}],0xBAD
.stop:
hlt
jmp .stop
align 8
; (accessed bits set: segment loads leave the code page alone)
gdt: dq 0,0x00CF9B000000FFFF,0x00CF93000000FFFF,0x00CFFB000000FFFF,0x00CFF3000000FFFF
dd ${(TSS & 0xFFFF) << 16 | 0x67},${TSS & 0xFF000000 | 0x8900 | TSS >>> 16 & 0xFF}
gdtr: dw 6 * 8 - 1
dd gdt
idtr: dw 0x32 * 8 - 1
dd idt
idt: times 0x32 dq 0
image_end:
`);

const hex = x => "0x" + (x >>> 0).toString(16);
for(const [profile, cpu_type] of [["x64", "x86_64"], ["legacy", undefined]])
{
    const expected = EXPECTED[profile];
    for(const [name, jit] of [["interpreter", false], ["JIT", true]])
    {
        const run = `${profile} profile, ${name}`;
        let ir;
        const result = await actual(directory, {length: RECORDS + 8 + 16 * STEPS.length + 8 - OUT, timeout: 120000,
            options: {...(cpu_type ? {cpu_type} : {}), ...(jit ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true} : {})},
            setup: emulator => { if(jit) emulator.v86.cpu.wm.exports.ir_auto_set_idle_mode(0, 1); },
            inspect: emulator => { ir = emulator.v86.cpu.get_jit_info().ir; }});
        const word = at => result.readUInt32LE(at - OUT);
        const tsc = at => BigInt(word(at + 4)) << 32n | BigInt(word(at));
        assert.equal(word(BAD), 0, `${run}: no exception other than #UD and #GP`);
        assert.equal(!!(word(FEATURES) & 1 << 27), profile === "x64", `${run}: CPUID.80000001h:EDX[27] (RDTSCP)`);
        // the last round's records: its first RDTSC, the steps, its last RDTSC
        const times = [tsc(RECORDS)];
        STEPS.forEach((step, i) => {
            const at = RECORDS + 8 + 16 * i;
            const [vector, eax, edx, ecx] = [0, 4, 8, 12].map(offset => word(at + offset));
            assert.equal(vector, expected[i], `${run}: ${step}: raised ${vector}, expected ${expected[i]}`);
            if(vector)
            {
                assert.deepEqual([eax, edx, ecx].map(hex), SENTINELS.map(hex), `${run}: ${step}: the faulting RDTSCP left EAX, EDX, ECX alone`);
            }
            else
            {
                assert.equal(hex(ecx), hex(AUX + 1), `${run}: ${step}: ECX = TSC_AUX`);
                times.push(tsc(at + 4));
            }
        });
        times.push(tsc(RECORDS + 8 + 16 * STEPS.length));
        times.slice(1).forEach((time, i) => assert.ok(time >= times[i], `${run}: TSC goes backwards: ${times.map(time => "0x" + time.toString(16))}`));
        assert.equal(word(MISMATCHES), 0, `${run}: rounds where ECX was not that round's TSC_AUX`);
        assert.equal(word(FAULTS), ROUNDS * expected.filter(Boolean).length, `${run}: faults over all rounds`);
        // (32-bit protected-mode code in the x64 page tier)
        if(jit) assert.ok(ir.page_tier.activations > 0 && ir.page_tier.native_instructions > 0,
            `${run}: compiled code ran: ${JSON.stringify(ir.page_tier)}`);
        console.log(`PASS 32-bit RDTSCP (${run}): ${profile === "x64" ? "EDX:EAX = TSC, ECX = TSC_AUX, #GP at CPL 3 with CR4.TSD" : "#UD"}`);
    }
}

const COMPAT_AUX = 0x5A5A0001, ITERATIONS = 5000000;
const compat = assemble("compat-rdtscp", long_mode_guest(`
mov ecx,0xC0000103
mov eax,${COMPAT_AUX}
xor edx,edx
wrmsr
push 8
mov eax,compat_entry
push rax
o64 retf
back:
`, `
bits 32
; RDTSC, the last of the RDTSCPs, RDTSC; how many RDTSCPs missed TSC_AUX
compat_entry:
rdtsc
mov [${OUT + 16}],eax
mov [${OUT + 20}],edx
mov ebp,${ITERATIONS}
xor edi,edi
.loop:
mov ecx,${SENTINELS[2]}
rdtscp
cmp ecx,${COMPAT_AUX}
je .same
inc edi
.same:
dec ebp
jnz .loop
mov [${OUT + 24}],eax
mov [${OUT + 28}],edx
rdtsc
mov [${OUT + 32}],eax
mov [${OUT + 36}],edx
mov [${OUT + 12}],edi
jmp 0x18:back_to_64
bits 64
back_to_64:
mov rax,HIGH+back
jmp rax
`));
for(const [profile, cpu_type] of [["x64", "x86_64"], ["legacy", undefined]])
{
    for(const [name, jit] of [["interpreter", false], ["compat JIT", true]])
    {
        const run = `compatibility mode, ${profile} profile, ${name}`;
        let ir;
        const result = await actual(compat, {length: 40, timeout: 60000,
            options: {...(cpu_type ? {cpu_type} : {}), ...(jit ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true} : {})},
            setup: emulator => {
                const exports = emulator.v86.cpu.wm.exports;
                exports.x64_set_compat_jit(jit);
                if(jit) exports.ir_auto_set_idle_mode(0, 1);
            },
            inspect: emulator => { ir = emulator.v86.cpu.get_jit_info().ir; }});
        const tsc = at => BigInt(result.readUInt32LE(at + 4)) << 32n | BigInt(result.readUInt32LE(at));
        assert.equal(result.readUInt32LE(12), 0, `${run}: RDTSCPs whose ECX was not TSC_AUX`);
        assert.ok(tsc(16) <= tsc(24) && tsc(24) <= tsc(32), `${run}: RDTSCP's EDX:EAX between the RDTSCs`);
        // (32-bit protected-mode code in the x64 page tier)
        if(jit) assert.ok(ir.page_tier.activations > 0 && ir.page_tier.native_instructions > 0,
            `${run}: compiled code ran: ${JSON.stringify(ir.page_tier)}`);
        console.log(`PASS RDTSCP (${run})`);
    }
}
