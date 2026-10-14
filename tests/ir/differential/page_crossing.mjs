#!/usr/bin/env node
// Straight-line legacy-mode code over several pages in a loop (the x64 page
// tier, P7.3): the first instruction of each page, entered from the page
// before, must be an entry of its page's function. Before M9 it was not
// (straight-line code is no entry), and every page after the first stepped
// through to its end on each round: tests/rust/sse4.mjs's PCMPxSTRx program,
// 23 KiB without a branch, ran a third of its instructions as steps.
//
//   node tests/ir/differential/page_crossing.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CODE = 0x500000, COUNTER = 0x600000, PAGES = 6, ROUNDS = 200;

const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 128 << 20, ir_sync_publication: true,
    bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
    disable_speaker: true, net_device: { type: "none" }, autostart: false });
await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
const cpu = vm.v86.cpu, e = cpu.wm.exports;
vm.run();
const ready = performance.now() + 15000;
while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
    assert(performance.now() < ready, "benchmark BIOS did not start");
    await sleep(1);
}
await vm.stop();

// ADD EAX, imm32 (5 bytes: instructions straddle the page ends) over PAGES
// pages, then DEC DWORD [COUNTER]; JNZ top; HLT
const body = [];
let adds = 0;
while(body.length < PAGES * 4096 - 32) { body.push(0x05, 1, 0, 0, 0); adds++; }
body.push(0xFF, 0x0D, COUNTER & 255, COUNTER >> 8 & 255, COUNTER >> 16 & 255, 0);
body.push(0x0F, 0x85, ...new Uint8Array(new Int32Array([-(body.length + 6)]).buffer), 0xF4);
cpu.mem8.set(body, CODE);
new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(COUNTER, ROUNDS, true);
cpu.reg32[0] = 0;
cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
e.update_state_flags();
const native = e.x64_page_stat(1), steps = e.x64_page_stat(4);
vm.run();
const end = performance.now() + 30000;
while(!cpu.in_hlt[0]) {
    assert(performance.now() < end, "timeout");
    await sleep(1);
}
await vm.stop();
assert.equal(cpu.reg32[0] >>> 0, adds * ROUNDS >>> 0, "EAX");
const ran = e.x64_page_stat(1) - native, stepped = e.x64_page_stat(4) - steps;
await vm.destroy();
// (the first rounds run interpreted until the pages are hot)
assert.ok(ran > adds * ROUNDS * 0.6, `the page tier ran ${ran} of ${adds * ROUNDS} instructions natively`);
assert.ok(stepped < ROUNDS, `${stepped} steps (each page's first instruction is an entry)`);
console.log(`PASS: ${PAGES} pages of straight-line code, ${ROUNDS} rounds: ${ran} instructions native, ${stepped} steps`);
process.exit(0);
