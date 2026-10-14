#!/usr/bin/env node
// The x86-64 CPU profile has its IA-32e MSRs outside long mode too: a 32-bit
// kernel on cpu_type: "x86_64" sees CPUID.(EAX=7,ECX=0):EDX[29] and reads
// IA32_ARCH_CAPABILITIES (0x10A) with EFER.LME clear. That used to reach the
// 32-bit MSR table, which lacks it, and the debug build aborted on the unknown
// MSR (Linux 4 stopped at "Booting the kernel."). In 32-bit protected mode,
// RDMSR reads the value a 64-bit OS reads (tests/platform/cpu-contract.json),
// WRMSR to it raises #GP (read-only), and KERNEL_GS_BASE and TSC_AUX keep what
// is written and fault on what long mode refuses. Interpreted, then compiled:
// the probe repeats until the IR compiles its page (ir_rdmsr/ir_wrmsr).
import assert from "node:assert/strict";
import fs from "node:fs";
import {assemble, actual, root} from "./guest_runner.mjs";

// (the #GP flag lives with the results: a store to the code page would keep
// the JIT from compiling the probe)
const OUT = 0x300000, FAULTED = OUT + 12, RECORDS = OUT + 16, ROUNDS = 100000;
const contract = JSON.parse(fs.readFileSync(root + "tests/platform/cpu-contract.json", "utf8"));
const [arch_high, arch_low] = contract.profiles["x64-1"].msrs["0x0000010a"].split(":").map(x => parseInt(x, 16));
// [RDMSR or WRMSR, ECX, EDX, EAX written]
const STEPS = [
    ["read", 0xC0000080],
    ["read", 0x10A],
    ["write", 0x10A, 0, 0],
    ["write", 0xC0000102, 0xFFFF8000, 0x12345678],
    ["read", 0xC0000102],
    ["write", 0xC0000102, 0x00008000, 0],           // non-canonical
    ["write", 0xC0000103, 0, 0x2A],
    ["read", 0xC0000103],
    ["write", 0xC0000103, 1, 0x2A],                 // TSC_AUX is 32 bits
];
// per step: whether it raised #GP, then EAX and EDX after it
const EXPECTED = [
    [0, 0, 0],                                      // EFER: LME clear
    [0, arch_low, arch_high],
    [1, 0, 0],
    [0, 0x12345678, 0xFFFF8000],
    [0, 0x12345678, 0xFFFF8000],
    [1, 0, 0x00008000],
    [0, 0x2A, 0],
    [0, 0x2A, 0],
    [1, 0x2A, 1],
];

const directory = assemble("protected-mode-msrs", `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
; a GDT of its own (exceptions reload CS from it), then an IDT whose #GP
; handler skips the faulting RDMSR/WRMSR (2 bytes) and flags it
lgdt [gdtr]
jmp 8:.flat
.flat:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x200000
mov edi,idt
mov ecx,32
.gate:
mov eax,other
mov [edi],ax
mov word [edi + 2],8
mov word [edi + 4],0x8E00
shr eax,16
mov [edi + 6],ax
add edi,8
loop .gate
mov eax,gp_handler
mov [idt + 13 * 8],ax
shr eax,16
mov [idt + 13 * 8 + 6],ax
lidt [idtr]
mov eax,7
xor ecx,ecx
cpuid
mov [${OUT + 8}],edx
mov ebp,${ROUNDS}
.round:
call probe
dec ebp
jnz .round
mov dword [${OUT}],0xC064C064
.halt:
hlt
jmp .halt
probe:
mov edi,${RECORDS}
${STEPS.map(([op, msr, edx = 0, eax = 0]) => op === "read" ?
    `mov ecx,${msr}\ncall read` :
    `mov ecx,${msr}\nmov edx,${edx}\nmov eax,${eax}\ncall write`).join("\n")}
ret
read:
xor eax,eax
xor edx,edx
mov dword [${FAULTED}],0
rdmsr
jmp record
write:
mov dword [${FAULTED}],0
wrmsr
record:
mov ebx,[${FAULTED}]
mov [edi],ebx
mov [edi + 4],eax
mov [edi + 8],edx
add edi,12
ret
gp_handler:
mov dword [${FAULTED}],1
add esp,4                       ; the error code
add dword [esp],2               ; past RDMSR/WRMSR
iret
other:
mov dword [${OUT + 4}],0xBAD
.stop:
hlt
jmp .stop
align 8
gdt: dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF
gdtr: dw 3 * 8 - 1
dd gdt
idtr: dw 32 * 8 - 1
dd idt
idt: times 32 dq 0
image_end:
`);

const hex = x => "0x" + (x >>> 0).toString(16);
for(const [name, jit] of [["interpreter", false], ["JIT", true]])
{
    let ir;
    const result = await actual(directory, {length: 16 + 12 * STEPS.length, timeout: 120000,
        options: {cpu_type: "x86_64", ...(jit ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true} : {})},
        setup: emulator => { if(jit) emulator.v86.cpu.wm.exports.ir_auto_set_idle_mode(0, 1); },
        inspect: emulator => { ir = emulator.v86.cpu.get_jit_info().ir; }});
    assert.equal(result.readUInt32LE(4), 0, `${name}: no exception other than #GP`);
    assert.ok(result.readUInt32LE(8) & 1 << 29, `${name}: CPUID.(EAX=7,ECX=0):EDX[29] advertises IA32_ARCH_CAPABILITIES`);
    STEPS.forEach(([op, msr], i) => {
        const at = 16 + 12 * i;
        const observed = [0, 4, 8].map(offset => result.readUInt32LE(at + offset));
        assert.deepEqual(observed, EXPECTED[i].map(x => x >>> 0),
            `${name}: ${op === "read" ? "RDMSR" : "WRMSR"} ${hex(msr)}: #GP, EAX, EDX ${observed.map(hex)}, expected ${EXPECTED[i].map(hex)}`);
    });
    // (32-bit protected-mode code in the x64 page tier, else Tier-0)
    if(jit) assert.ok(ir.page_tier.activations > 0 && ir.page_tier.native_instructions > 0 || ir.tier0.page_functions > 0 && ir.tier0.activations > 0,
        `compiled code ran: ${JSON.stringify({ tier0: ir.tier0, page_tier: ir.page_tier })}`);
    console.log(`PASS 32-bit protected mode on the x86-64 profile (${name}): IA32_ARCH_CAPABILITIES = ${hex(arch_high)}:${hex(arch_low)}, read-only; KERNEL_GS_BASE and TSC_AUX`);
}
