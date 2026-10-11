#!/usr/bin/env node
// The host time of single events in 64-bit code under the x64 page tier
// (docs/jit-unification-plan.md P4.0): a loop repeating one event N times,
// timed by the guest's own RDTSC (v86's TSC counts host nanoseconds), against
// the same loop with a NOP. The events are what compiled code leaves to the
// interpreter or leaves altogether: steps that continue (CPUID, POPFQ),
// a retry (a load the access cache refuses: past the end of RAM; a page-
// crossing one is served now, x64::pages::crossing_host), IRETQ,
// SYSCALL with SYSRETQ, port I/O (IN from port 80h), an HPET register read
// (MMIO), FXSAVE with FXRSTOR, MOV CR3, a TS write to CR0 with CLTS (both end
// the activation: CR0 changed), lazy FPU switching (TS set, #NM, CLTS,
// IRETQ), RDTSC (a helper call), an interrupt window (STI, an instruction in
// its shadow, CLI); and per instruction, code outside compiled code:
// interpreted, and cold (misses). P4.1 ranks the exits with these costs.
//
//   node tests/x64/system_bench.mjs [iterations=400000] [rounds=3] [event...]
//   node tests/x64/system_bench.mjs --events [iterations=20000] [event...]
// Each guest runs its loop twice, timing the second pass (the first compiles
// it). --events runs each guest once with the step profile on and prints its
// StepKeys and events per iteration of both passes instead
// (tests/x64/step_events.mjs checks them). Needs build/libv86.mjs with
// TEST_RELEASE_BUILD=1 (else src/main.js). JIT_SWITCHES applies.
import {fileURLToPath} from "node:url";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {set_jit_switches} from "../../src/jit_switches.js";
import {step_profile} from "../../tools/step_profile.mjs";

// The guest's 1 GiB identity map also accessible to CPL 3 (SYSRETQ's user code)
const USER_PAGES = `or dword [0x200000],4
or dword [0x200800],4
or dword [0x201000],4
mov rdi,0x202000
mov ecx,512
.user_pages:
or dword [rdi],4
add rdi,8
loop .user_pages
mov rax,cr3
mov cr3,rax`;
// IDT vector 7 (#NM) to nm_handler, the IDT at 5 MiB
const NM_IDT = `mov rdi,0x500000+7*16
lea rax,[rel nm_handler]
mov [rdi],ax
mov word [rdi+2],0x18
mov word [rdi+4],0x8E00
shr rax,16
mov [rdi+6],ax
shr rax,16
mov [rdi+8],eax
mov dword [rdi+12],0
mov word [0x501000],0xFFF
mov rax,0x500000
mov [0x501002],rax
lidt [0x501000]`;

// Each event: its loop body; setup before the loop; handlers (code after
// the guest's end); `scale` of the iterations; emulator options. In the loop
// rbx points at data (4 MiB), r8 counts, r13 the pass, r14 the start time.
export const EVENTS = {
    base: {loop: "nop"},
    cpuid: {loop: "xor eax,eax\ncpuid"},
    popfq: {loop: "pushfq\npopfq"},
    // (POPFQ toggling AC: a step that ends the activation, chainable; less
    // popfq, what ending it adds to a step)
    popfq_ac: {loop: "pushfq\nxor dword [rsp],0x40000\npopfq"},
    // (192 MiB past the data: no RAM there, no device either)
    retry: {loop: "mov rax,[rbx+0xC000000]"},
    iretq: {loop: "mov rax,rsp\npush 16\npush rax\npushfq\npush 24\nlea rax,[rel .next]\npush rax\niretq\n.next:"},
    // (the loop at CPL 3: SYSRETQ enters it, a SYSCALL with r9 set leaves)
    syscall: {
        setup: `${USER_PAGES}
mov ecx,0xC0000080
rdmsr
or eax,1
wrmsr
mov ecx,0xC0000081
xor eax,eax
mov edx,0x00080018
wrmsr
mov ecx,0xC0000082
lea rax,[rel syscall_entry]
mov rdx,rax
shr rdx,32
wrmsr
mov ecx,0xC0000084
xor eax,eax
xor edx,edx
wrmsr
xor r9d,r9d
lea rcx,[rel .user]
pushfq
pop r11
o64 sysret
.user:`,
        loop: "syscall",
        leave: "mov r9d,1\nsyscall",
        handlers: `syscall_entry:
test r9d,r9d
jnz bench_done
o64 sysret`,
    },
    port_in: {loop: "in al,0x80"},
    // (Q35's HPET: its 2 MiB at 0xFEC00000 uncached, read the main counter)
    hpet: {
        setup: `mov qword [0x201018],0x203003
mov rax,0xFEC0009B
mov [0x203000+0x1F6*8],rax
mov rax,cr3
mov cr3,rax
mov rsi,0xFED000F0`,
        loop: "mov eax,[rsi]",
        options: {machine_type: "q35", hpet: true},
    },
    fxsave: {setup: "mov rax,cr4\nor eax,0x600\nmov cr4,rax", loop: "fxsave [rbx]\nfxrstor [rbx]", scale: 0.1},
    mov_cr3: {loop: "mov rax,cr3\nmov cr3,rax"},
    cr0_ts: {loop: "mov rax,cr0\nor eax,8\nmov cr0,rax\nclts"},
    // (#NM at FNOP, the handler clears TS and returns to it)
    nm: {setup: NM_IDT, loop: "mov rax,cr0\nor eax,8\nmov cr0,rax\nfnop", handlers: "nm_handler:\nclts\niretq", scale: 0.5},
    rdtsc: {loop: "rdtsc"},
    // (an interrupt window: STI, NOP in its shadow, CLI; the PICs masked,
    // the guest has no IDT)
    sti: {setup: "mov al,0xFF\nout 0x21,al\nout 0xA1,al", loop: "sti\nnop\ncli"},
    // Instructions outside compiled code, ns per instruction: interpreted
    // with the x64 page tier off (its run() returns at once), and code that
    // stays cold: COLD_PAGES pages run once, each a loop of 1801
    // instructions, under the tier's compile threshold (2000), so every
    // instruction is a cold miss (P4.5c)
    interp: {loop: "nop", options: {jit_switches: {x64_page: 0}}, per_instruction: 3},
    cold: {cold: true},
};

const COLD_PAGES = 180, COLD_INSTRUCTIONS = 1 + 600 * 3 + 1;
// (cold: one pass of one iteration)
export const iterations = (name, n) => EVENTS[name].cold ? 1 : Math.max(1, Math.round(n * (EVENTS[name].scale ?? 1)));
/** The iterations of the untimed first pass, which compiles the loop's page */
export const WARM = 5000;
/** Instructions per iteration of the events timed per instruction */
export const per_instruction = name => EVENTS[name].cold ? COLD_PAGES * COLD_INSTRUCTIONS : EVENTS[name].per_instruction;

/** The guest of event `name`: WARM iterations, then `n` (scaled) timed into 0x300008 */
export function guest(name, n)
{
    const event = EVENTS[name];
    // (each page: its loop, then a jump over the padding to the next page)
    if(event.cold) return long_mode_guest(`rdtsc
shl rdx,32
or rax,rdx
mov r14,rax
jmp cold_pages
%macro COLD_PAGE 0
mov ecx,600
%%loop:
nop
dec ecx
jnz %%loop
jmp %%next
align 4096,db 0xCC
%%next:
%endmacro
align 4096,db 0xCC
cold_pages:
%rep ${COLD_PAGES}
COLD_PAGE
%endrep
rdtsc
shl rdx,32
or rax,rdx
sub rax,r14
mov [0x300008],rax
bench_done:`);
    return long_mode_guest(`mov rbx,0x400000
${event.setup || ""}
xor r13d,r13d
.pass:
mov r8d,${WARM}
test r13d,r13d
jz .start
mov r8d,${iterations(name, n)}
.start:
rdtsc
shl rdx,32
or rax,rdx
mov r14,rax
.loop:
${event.loop}
dec r8d
jnz .loop
rdtsc
shl rdx,32
or rax,rdx
sub rax,r14
mov [0x300008],rax
inc r13d
cmp r13d,2
jb .pass
${event.leave || ""}
bench_done:`, event.handlers || "");
}

const JIT = {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true};

/** Run event `name`'s guest: the loop's nanoseconds; with `profile`, also
 * the step profile (after `inspect`, which gets the emulator); `switches`:
 * JIT switches for this run */
export async function run(name, n, {profile = false, inspect, switches = {}} = {})
{
    const directory = assemble(`system-bench-${name}`, guest(name, n));
    let records;
    const options = {...JIT, ...EVENTS[name].options};
    options.jit_switches = {...options.jit_switches, ...switches};
    const result = await actual(directory, {length: 16, timeout: 300000, options,
        setup: emulator => {
            const cpu = emulator.v86.cpu;
            // (the runner steps the cores itself: the machine clock, and with
            // it the TSC, would stand still)
            cpu.clock.resume();
            if(profile) set_jit_switches(cpu.wm.exports, cpu.wasm_memory, {step_profile: 1}, "system_bench");
        },
        inspect: emulator => {
            inspect?.(emulator);
            if(profile) records = step_profile(emulator.v86.cpu.wm.exports);
        }});
    return {ns: Number(result.readBigUint64LE(8)), records};
}

async function main()
{
    const args = process.argv.slice(2);
    const events = args[0] === "--events";
    if(events) args.shift();
    const numbers = args.filter(a => /^\d+$/.test(a)).map(Number);
    const names = args.filter(a => !/^\d+$/.test(a));
    for(const name of names) if(!EVENTS[name]) throw new Error(`no event ${name}: ${Object.keys(EVENTS).join(" ")}`);
    if(events)
    {
        const n = numbers[0] || 20000;
        for(const name of names.length ? names : Object.keys(EVENTS))
        {
            const {records} = await run(name, n, {profile: true});
            const count = EVENTS[name].cold ? COLD_PAGES * 600 : WARM + iterations(name, n);
            const rows = records.filter(r => r.count >= count / 4).slice(0, 12)
                .map(r => `${r.name} ${+(r.count / count).toFixed(2)}`);
            console.log(`${name} (${count} iterations): ${rows.join(", ")}`);
        }
        return;
    }
    const N = numbers[0] || 400000, ROUNDS = numbers[1] || 3;
    const chosen = ["base", ...(names.length ? names : Object.keys(EVENTS)).filter(name => name !== "base")];
    const times = {};
    for(let round = 0; round < ROUNDS; round++)
    {
        for(const name of chosen)
        {
            (times[name] ??= []).push((await run(name, N)).ns / iterations(name, N));
        }
    }
    const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
    const base = median(times.base);
    const result = {iterations: N, rounds: ROUNDS, base_ns: +base.toFixed(2), ns_per_event: {}, ns_per_instruction: {}};
    for(const name of chosen.slice(1))
    {
        if(per_instruction(name)) result.ns_per_instruction[name] = +(median(times[name]) / per_instruction(name)).toFixed(1);
        else result.ns_per_event[name] = +(median(times[name]) - base).toFixed(1);
    }
    console.log(JSON.stringify(result));
}

if(process.argv[1] === fileURLToPath(import.meta.url)) await main();
