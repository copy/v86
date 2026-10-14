#!/usr/bin/env node
// IA-32e compatibility-mode (WOW64) pages that wait for their Tier-0 compile
// while 64-bit code runs (docs/jit-unification-plan.md P4.6, the JIT switch
// x64_long_visit). A compatibility-mode phase heats PAGES code pages past
// the page threshold, faster than one compile a frame takes them; 64-bit
// code then runs for many frames, and the compatibility-mode pages run
// again. Without the switch the pages left in the queue wait through every
// long-mode frame (the step profile's starved frames); with it, long-mode
// frames compile them (one a frame, under the CR3 and CPL they were queued
// with, with their state flags) and the second compatibility-mode phase
// runs their functions. Results equal the interpreter's either way.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {set_jit_switches} from "../../src/jit_switches.js";
import {step_profile} from "../../tools/step_profile.mjs";

const PAGES = 12, ITERATIONS = 20000, SPIN = 20000000;
const page = n => `
align 4096
page${n}:
mov ecx,${ITERATIONS}
.loop:
add eax,ecx
rol eax,${n % 7 + 1}
dec ecx
jnz .loop
ret`;
const body = `
mov rax,HIGH+second
mov [0x301000],rax
jmp run_compat
second:
; 64-bit work for many frames
mov rcx,${SPIN}
.spin:
add rdx,rcx
dec rcx
jnz .spin
mov [0x300050],rdx
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
xor eax,eax
${Array.from({length: PAGES}, (_, n) => `call page${n}`).join("\n")}
mov ebx,[0x301008]
mov [0x601000+ebx*4],eax
inc dword [0x301008]
jmp 0x18:back_to_64
${Array.from({length: PAGES}, (_, n) => page(n)).join("\n")}
bits 64
back_to_64:
jmp [0x301000]
`;
const directory = assemble("long-visit", long_mode_guest(body, data));
const results = {}, runs = {};
for(const [name, jit, long_visit] of [["interpreter", false, false], ["compat JIT", true, false], ["compat JIT, x64_long_visit", true, true]])
{
    let tier0 = null, starved = 0, frames = 0;
    results[name] = await actual(directory, {length: 88, timeout: 300000,
        // (Tier-0's compatibility-mode pages: the page tier's are the default since M9)
        options: jit ? {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true, jit_switches: {x64_page_compat32: 0}} : {},
        setup: emulator => {
            const cpu = emulator.v86.cpu, x = cpu.wm.exports;
            x.x64_set_compat_jit(jit);
            if(jit)
            {
                x.ir_auto_set_idle_mode(0, 1);
                set_jit_switches(x, cpu.wasm_memory, {step_profile: 1, x64_long_visit: +long_visit}, "long_visit");
            }
        },
        inspect: emulator => {
            const cpu = emulator.v86.cpu;
            tier0 = cpu.get_jit_info().ir?.tier0;
            for(const r of step_profile(cpu.wm.exports))
            {
                if(/ event starved\b/.test(r.name)) starved += r.count;
                if(r.name.endsWith(" event frame")) frames += r.count;
            }
        }});
    runs[name] = {starved, frames, page_functions: tier0?.page_functions ?? 0};
    console.log(`${name}: starved frames ${starved} of ${frames}, Tier-0 ${JSON.stringify(tier0)}`);
}
for(const name of Object.keys(results)) assert.deepEqual(results[name], results.interpreter, `${name} agrees with the interpreter`);
const off = runs["compat JIT"], on = runs["compat JIT, x64_long_visit"];
assert.ok(off.starved >= 10, `without x64_long_visit pages wait through long-mode frames: ${JSON.stringify(off)}`);
assert.ok(on.starved * 4 <= off.starved, `x64_long_visit compiles them in long-mode frames: ${JSON.stringify(on)} against ${JSON.stringify(off)}`);
// (without it the second phase is over before the pages' turn comes)
assert.ok(on.page_functions >= PAGES && off.page_functions < on.page_functions,
    `every compatibility-mode page compiled with x64_long_visit: ${JSON.stringify(runs)}`);
console.log(`PASS x64_long_visit: starved frames ${off.starved} of ${off.frames} without, ${on.starved} with; compatibility-mode ` +
    `page functions ${off.page_functions} without, ${on.page_functions} with; results agree with the interpreter`);
