#!/usr/bin/env node
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
const source = long_mode_guest(`
mov ecx,200000
xor r8d,r8d
xor r9d,r9d
call hot_loop
mov [0x300008],r8
mov [0x300010],r9
; Patch the immediate through the LOW alias of the currently cached high code.
mov byte [hot_loop+3],7
mov ecx,200000
xor r8d,r8d
xor r9d,r9d
call hot_loop
mov [0x300018],r8
mov [0x300020],r9
`, `
hot_loop:
add r8,byte 3
xor r9,r8
sub ecx,1
jnz hot_loop
ret
`);
const dir = assemble("cache", source);
const config = {length: 40};
const oracle = await reference(dir, config);
// (the second arm interprets the 32-bit setup code: ir_tier0 off; it ran it
// in the region tiers until M11 of docs/jit-unification-plan.md)
for(const [backend, ir_tier0] of [["pages", true], ["pages, 32-bit code interpreted", false]])
{
    let retired = 0, rejected = 0;
    const result = await actual(dir, {...config, options: {disable_jit: false, experimental_smp_jit: true,
        ir_tier0, ir_sync_publication: true}, inspect: emulator => {
        const ex = emulator.v86.cpu.wm.exports;
        retired = ex.x64_page_stat(1); rejected = ex.x64_page_stat(5);
        assert.ok(retired > 1000, "runtime executed actual native instructions");
        assert.ok(rejected > 0, "a write through the low alias retired the page function of the high RIP");
    }});
    assert.deepEqual(result, oracle, backend + " native result agrees with QEMU after SMC");
    console.log(`PASS ${backend}: ${retired} native retirements, ${rejected} page functions invalidated`);
}
