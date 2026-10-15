#!/usr/bin/env node
// Hot pages compiled with inline access cache lookups (x64_hot_inline,
// docs/jit-unification-plan.md P4.14) in the parallel build, whose guest
// memory accesses are atomics that need natural alignment: a hot loop of
// unaligned loads and stores must give the interpreter's results, and no
// more retries than with outlined lookups (an inline lookup's unaligned
// access calls the module's lookup function, which bounces reads and passes
// unaligned write hosts to the code that handles them, not the runtime's
// x64_page_access, which would refuse them).
import assert from "node:assert/strict";
import { assemble, actual } from "./guest_runner.mjs";
import { long_mode_guest } from "./guest_builder.mjs";

const BUFFER = 0x400000, ROUNDS = 20000;
const directory = assemble("unaligned-parallel", long_mode_guest(`
mov rdi, ${BUFFER}
mov ecx, ${ROUNDS}
xor eax, eax
hot:
mov [rdi + 1], eax
mov [rdi + 6], ax
mov [rdi + 11], rax
add eax, [rdi + 3]
add rax, [rdi + 9]
movzx edx, word [rdi + 13]
add eax, edx
mov rdx, rcx
and edx, 255
lea rdi, [${BUFFER} + rdx * 8 + 5]
dec ecx
jnz hot
mov [0x300008], rax
`));
const parallel = new URL("../../build/v86-parallel.wasm", import.meta.url).pathname;
const runs = [];
for(const [label, options] of [
    ["interpreter", { disable_jit: true }],
    ["outlined", { wasm_path: parallel, disable_jit: false, ir_sync_publication: true, jit_switches: { x64_hot_inline: 0 } }],
    ["hot inline", { wasm_path: parallel, disable_jit: false, ir_sync_publication: true, jit_switches: { x64_hot_inline: 1, x64_hot_count: 4096 } }],
])
{
    let memory, retries, native, hot;
    await actual(directory, {
        length: 8, timeout: 120000, options,
        inspect: emulator => {
            const cpu = emulator.v86.cpu;
            memory = Buffer.from(cpu.mem8.slice(BUFFER, BUFFER + 4096)).toString("hex") + Buffer.from(cpu.mem8.slice(0x300008, 0x300010)).toString("hex");
            const stat = i => cpu.wm.exports.x64_page_stat ? cpu.wm.exports.x64_page_stat(i) : 0;
            [retries, native, hot] = [stat(2), stat(1), stat(33)];
        },
    });
    runs.push({ label, memory, retries, native, hot });
    console.log(`${label}: retries ${retries}, native ${native}, hot recompiles ${hot}`);
}
const [reference, outlined, inline] = runs;
assert.equal(outlined.memory, reference.memory, "outlined lookups give the interpreter's results");
assert.equal(inline.memory, reference.memory, "inline lookups give the interpreter's results");
assert.ok(outlined.native > ROUNDS * 5 && inline.native > ROUNDS * 5, "the page tier ran the loop");
assert.ok(inline.hot >= 1, "the hot page was recompiled with inline lookups");
assert.ok(inline.retries <= outlined.retries, `no more retries inline (${inline.retries}) than outlined (${outlined.retries})`);
console.log("PASS unaligned_parallel: unaligned loads and stores of a hot page in the parallel build");
