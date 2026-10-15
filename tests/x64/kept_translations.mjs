#!/usr/bin/env node
// The translations an x64 page function keeps per base register while it runs
// (docs/jit-unification-plan.md P4.21, x64_fast_lookup with inline lookups)
// must not serve an access that only ends in their page: a hot loop reads and
// writes through RBX in a page and across the boundary with the page before
// it, the two mapped to physical pages that are not adjacent (4 KiB pages in
// reverse order), so a translation of the second page applied to the crossing
// access would reach the wrong memory. Results equal the interpreter's.
import assert from "node:assert/strict";
import { assemble, actual } from "./guest_runner.mjs";
import { long_mode_guest } from "./guest_builder.mjs";

// linear 0x800000-0x9FFFFF: a page table at 0x700000 maps page i to physical
// 0xA00000 + (511 - i) * 4096 (PD entry 4 points to it)
const TABLE = 0x700000, LINEAR = 0x800000, PHYSICAL = 0xA00000, ROUNDS = 30000;
const body = `
mov rdi, ${TABLE}
xor ecx, ecx
map:
mov eax, 511
sub eax, ecx
shl rax, 12
add rax, ${PHYSICAL} | 3
mov [rdi + rcx * 8], rax
inc ecx
cmp ecx, 512
jne map
mov qword [0x202020], ${TABLE} | 3
mov rax, cr3
mov cr3, rax
; the pattern: each byte of the 2 MiB its linear offset's low byte
mov rdi, ${LINEAR}
xor ecx, ecx
fill:
mov [rdi + rcx], cl
inc ecx
cmp ecx, 0x200000
jne fill
mov rbx, ${LINEAR + 0x5000}
xor r8, r8
xor r9, r9
mov ecx, ${ROUNDS}
hot:
mov rax, [rbx + 8]
add r8, rax
mov rdx, [rbx - 4]
add r9, rdx
mov [rbx - 2], ax
mov eax, [rbx + 16]
xor r8, rax
mov [rbx - 3], edx
add r9, [rbx - 6]
mov rdx, rcx
and edx, 7
shl edx, 12
mov rbx, ${LINEAR + 0x5000}
add rbx, rdx
dec ecx
jnz hot
mov [0x300008], r8
mov [0x300010], r9
`;
const directory = assemble("kept-translations", long_mode_guest(body));
const runs = [];
for(const [label, options] of [
    ["interpreter", { disable_jit: true }],
    ["page tier", { disable_jit: false, ir_sync_publication: true,
        jit_switches: { x64_fast_lookup: 1, x64_hot_inline: 1, x64_outline: 0 } }],
])
{
    let memory, native;
    await actual(directory, {
        length: 24, timeout: 120000, options: { memory_size: 64 << 20, ...options },
        inspect: emulator => {
            const cpu = emulator.v86.cpu;
            memory = Buffer.from(cpu.mem8.slice(0x300008, 0x300018)).toString("hex") +
                Buffer.from(cpu.mem8.slice(PHYSICAL, PHYSICAL + 0x200000)).toString("base64");
            native = cpu.wm.exports.x64_page_stat(1);
        },
    });
    runs.push({ label, memory, native });
}
assert.ok(runs[1].native > ROUNDS * 10, `the page tier ran the loop (${runs[1].native} native instructions)`);
assert.ok(runs[1].memory === runs[0].memory, "the page tier's results and memory equal the interpreter's");
console.log(`PASS kept_translations: page-crossing accesses through a register with a kept translation (${runs[1].native} native instructions)`);
