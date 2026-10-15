#!/usr/bin/env node
// Guest RAM reads as zero until something writes it, whatever the wasm heap
// it is allocated from held before (cpu/memory.rs allocate_memory). With
// ir_tier0 on, jit::reserve_compiler_heap (the region scheduler's until M11
// of docs/jit-unification-plan.md) frees 16 chunks of
// 2 MiB just before RAM is allocated in their place, and their allocator
// headers used to show up in guest RAM: 0x0020000A00400010 at 0x3FFEA0
// (reported as an x64 page tier write: no guest touched it), a header every
// 2 MiB and the heap's former end marker every 2 MiB + 64 KiB; in every
// configuration, the initial heap's end marker (0x28 at 0x9FDC). Checked in
// each configuration: before the first instruction, all of RAM is zero but
// the multiboot image; after a long-mode guest ran a loop (compiled by the
// page tier), RAM from 0x300000 to its end is zero but the guest's marker.
// With ir_tier0 on, 32 MiB of RAM lies within the memory the heap had used, and
// 64 MiB extends past it.
import assert from "node:assert/strict";
import fs from "node:fs";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const IMAGE = 0x100000, OUT = 0x300000, MARKER = 0xC064C064;
const directory = assemble("initial-ram", long_mode_guest(`
mov ecx,2000000
.loop:
add eax,ecx
dec ecx
jnz .loop
`));
const image = fs.readFileSync(directory + "guest.bin");
const hex = n => "0x" + n.toString(16).toUpperCase();
/** The first qwords that differ (a short message: assert's diff of 32 MiB
 * buffers would take forever), `base` being the guest address of byte 0 */
function differences(bytes, expected, base)
{
    if(bytes.equals(expected)) return "";
    const found = [];
    for(let i = 0; i < bytes.length && found.length < 8; i += 8)
    {
        const value = bytes.readBigUInt64LE(i), want = expected.readBigUInt64LE(i);
        if(value !== want) found.push(`${hex(base + i)}: ${hex(value)} (expected ${hex(want)})`);
    }
    return found.join(", ");
}

const page_tier = {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true};
for(const [label, options] of [
    ["interpreted", {}],
    ["x64 page tier", page_tier],
    ["x64 page tier, 64 MiB", {...page_tier, memory_size: 64 << 20}],
    ["x64 page tier without ir_tier0", {...page_tier, ir_tier0: false}],
])
{
    const size = options.memory_size || 32 << 20;
    const loaded = Buffer.alloc(size);
    image.copy(loaded, IMAGE);
    const finished = Buffer.alloc(size - OUT);
    finished.writeUInt32LE(MARKER, 0);
    let before, native = 0;
    const result = await actual(directory, {length: size - OUT, timeout: 120000, options,
        setup: emulator => {
            const cpu = emulator.v86.cpu;
            assert.equal(cpu.mem8.length, size);
            before = differences(Buffer.from(cpu.mem8.buffer, cpu.mem8.byteOffset, size), loaded, 0);
        },
        inspect: emulator => { native = emulator.v86.cpu.wm.exports.x64_page_stat(1); }});
    assert.equal(before, "", `${label}: before the first instruction, RAM is zero but the multiboot image`);
    assert.equal(differences(result, finished, OUT), "", `${label}: RAM from 0x300000 is zero but the marker`);
    if(options.disable_jit === false) assert.ok(native > 1000000, `${label}: compiled code ran (${native} instructions)`);
    console.log(`PASS (${label}): ${size >> 20} MiB of RAM read as zero until written`);
}
