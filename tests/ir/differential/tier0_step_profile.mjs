#!/usr/bin/env node
// The step profile of the x64 page tier in legacy mode (docs/jit-unification-
// plan.md P0.5; written for IR Tier-0, deleted in P7.5): a hot loop whose
// page function steps CPUID and an IN at the last byte of its page. The next
// linear page is mapped to another physical page, so the instruction's
// second byte must be read through the page tables: Tier-0's two-byte
// histogram used to read it from the next physical page. With the JIT switch
// step_profile on, both steps land under their StepKeys (32-bit protected
// mode, x64page), as often as the two-byte histogram (x64_page_steps) counts
// them; off, the profile is gone.
//
//   node tests/ir/differential/tier0_step_profile.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { get_jit_switches, set_jit_switches } from "../../../src/jit_switches.js";
import { step_key, step_key_name, step_profile } from "../../../tools/step_profile.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The loop starts at TOP, jumps to the IN at the last byte of its page; the
// next linear page (NEXT) is backed by the physical page ELSEWHERE, while
// the physical page after TOP's is filled with NOPs.
const TOP = 0x500F00, LAST = 0x500FFF, NEXT = 0x501000, ELSEWHERE = 0x700000;
const DATA = 0x600000, STACK = 0x610000, ITERATIONS = 20000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const top = [
    0x31, 0xC0,                                     // XOR EAX, EAX
    0x0F, 0xA2,                                     // CPUID
    0xBA, ...u32(0x80),                             // MOV EDX, 0x80
];
top.push(0xE9, ...u32(LAST - (TOP + top.length + 5))); // JMP last
const next = [0xFF, 0x0D, ...u32(DATA + 124)];      // DEC DWORD [DATA+124]
next.push(0x0F, 0x85, ...u32(TOP - (NEXT + next.length + 6)), 0xF4); // JNZ top; HLT

// the names of a few keys (tools/step_profile.mjs)
assert.equal(step_key_name(step_key({ opcode: 0xA2, map: 1 })), "prot32 x64page 0F A2");
assert.equal(step_key_name(step_key({ opcode: 0xA5, rep: true, mode: "long64", stepper: "x64page", retry: true })), "long64 x64page retry F3 A5");
assert.equal(step_key_name(step_key({ opcode: 0x18, map: 2, vex: true, vex_l: true, vex_pp: 1, mode: "long64" })), "long64 x64page VEX.256.66.0F38 18");
assert.equal(step_key_name(step_key({ opcode: 0xFF, reg: 2, mode: "real" })), "real x64page FF /2");

const vm = new V86({
    graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 128 << 20,
    // (page functions are installed as they are compiled)
    ir_sync_publication: true,
    // (the page tier compiles a page after 2000 instructions)
    jit_switches: { x64_legacy_heat: 2000 },
    bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
    disable_speaker: true, net_device: { type: "none" }, autostart: false,
});
await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
const cpu = vm.v86.cpu, e = cpu.wm.exports;
vm.run();
const ready = performance.now() + 15000;
while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
    assert(performance.now() < ready, "benchmark BIOS did not start");
    await sleep(1);
}
await vm.stop();
assert.equal(get_jit_switches(e, cpu.wasm_memory).step_profile, 0, "the step profile is off by default");
set_jit_switches(e, cpu.wasm_memory, { step_profile: 1 }, "tier0_step_profile");

const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
cpu.mem8.fill(0x90, TOP & ~0xFFF, NEXT + 0x1000);
cpu.mem8.set(top, TOP);
cpu.mem8[LAST] = 0xEC;                              // IN AL, DX
cpu.mem8.set(next, ELSEWHERE);
view.setUint32(0x11000 + (NEXT >>> 12) * 4, ELSEWHERE | 3, true);

async function run() {
    cpu.mem8.fill(0, DATA, DATA + 128);
    view.setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.fill(0);
    cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = TOP;
    e.update_state_flags();
    e.full_clear_tlb();
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout: eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} counter ${view.getUint32(DATA + 124, true)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    assert.equal(view.getUint32(0x608, true), 0, "the guest took an exception");
    assert.equal(view.getUint32(DATA + 124, true), 0);
}
// (the first run compiles the pages)
await run();
e.x64_page_steps_reset();
e.step_profile_reset();
await run();

const raw_in = e.x64_page_steps(0xFFEC), raw_cpuid = e.x64_page_steps(0xA20F);
assert.equal(e.x64_page_steps(0x90EC), 0, "the IN's second byte was read from the wrong physical page");
assert(raw_in >= ITERATIONS * 0.9 && raw_cpuid >= ITERATIONS * 0.9, `the page tier stepped the IN ${raw_in} and CPUID ${raw_cpuid} times`);
const steps = step_profile(e);
const count = key => steps.find(r => r.key === key)?.count ?? 0;
assert.equal(count(step_key({ opcode: 0xEC })), raw_in, `IN: ${JSON.stringify(steps.slice(0, 4))}`);
assert.equal(count(step_key({ opcode: 0xA2, map: 1 })), raw_cpuid, `CPUID: ${JSON.stringify(steps.slice(0, 4))}`);
assert.equal(e.step_profile_get(step_key({ opcode: 0xA2, map: 1 })), raw_cpuid);
assert.deepEqual(steps.slice(0, 2).map(r => r.name).sort(), ["prot32 x64page 0F A2", "prot32 x64page EC"]);

set_jit_switches(e, cpu.wasm_memory, { step_profile: 0 }, "tier0_step_profile");
assert.equal(e.step_profile_snapshot(), 0, "the profile is dropped when the switch goes off");
await vm.destroy();
console.log(`PASS: the page tier stepped CPUID ${raw_cpuid} times and the IN at a page's last byte ${raw_in} times, ` +
    `the same in the two-byte histogram and under their StepKeys`);
process.exit(0);
