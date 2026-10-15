#!/usr/bin/env node
// Legacy-mode code over several pages in a loop (the x64 page tier, P7.3).
//
// 1. Straight-line code: the first instruction of each page, entered from
//    the page before, must be an entry of its page's function. Before M9 it
//    was not (straight-line code is no entry), and every page after the first
//    stepped through to its end on each round: tests/rust/sse4.mjs's
//    PCMPxSTRx program, 23 KiB without a branch, ran a third of its
//    instructions as steps.
// 2. One instruction per page and a jump to the next (as 708.pages), one
//    multi-page function (P7.3b), with chaining and without (x64_chaining=0,
//    an engine without Wasm tail calls): until M9 the entry of a multi-page
//    function left a value per page on the stack, which only a chaining
//    function's final return hid; without chaining each failed validation.
//
//   node tests/ir/differential/page_crossing.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CODE = 0x500000, COUNTER = 0x600000, PAGES = 6;
const le32 = n => [...new Uint8Array(new Int32Array([n]).buffer)];
// DEC DWORD [COUNTER]; JNZ program start; HLT
const round_end = body => {
    body.push(0xFF, 0x0D, ...le32(COUNTER));
    body.push(0x0F, 0x85, ...le32(-(body.length + 6)), 0xF4);
};

// ADD EAX, imm32 (5 bytes: instructions straddle the page ends) over PAGES
// pages
function straight_line() {
    const body = [];
    let adds = 0;
    while(body.length < PAGES * 4096 - 32) { body.push(0x05, 1, 0, 0, 0); adds++; }
    round_end(body);
    return { body, adds, rounds: 200 };
}
// At each page's start ADD EAX, 1, then JMP to the next page (from the last
// one, the round's end)
function hops() {
    const body = [];
    for(let p = 0; p < PAGES; p++) {
        while(body.length < p * 4096) body.push(0x90);
        body.push(0x05, 1, 0, 0, 0);
        if(p < PAGES - 1) body.push(0xE9, ...le32((p + 1) * 4096 - (body.length + 5)));
    }
    round_end(body);
    return { body, adds: PAGES, rounds: 4000 };
}

async function run({ body, adds, rounds }, switches, check) {
    const vm = new V86({ jit_switches: switches, graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 128 << 20, ir_sync_publication: true,
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

    cpu.mem8.set(body, CODE);
    new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(COUNTER, rounds, true);
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
    const label = JSON.stringify(switches);
    assert.equal(cpu.reg32[0] >>> 0, adds * rounds >>> 0, `${label}: EAX`);
    const stats = {
        ran: e.x64_page_stat(1) - native, stepped: e.x64_page_stat(4) - steps,
        failed: e.x64_page_stat(7), spans: e.x64_page_stat(38),
    };
    await vm.destroy();
    assert.equal(stats.failed, 0, `${label}: ${stats.failed} page functions failed to compile or were rejected`);
    check(stats, label, adds * rounds);
    console.log(`PASS ${label}: ${stats.ran} instructions native, ${stats.stepped} steps, ${stats.spans} multi-page functions`);
}

await run(straight_line(), {}, ({ ran, stepped }, label, adds) => {
    // (the first rounds run interpreted until the pages are hot)
    assert.ok(ran > adds * 0.6, `${label}: the page tier ran ${ran} of ${adds} additions natively`);
    assert.ok(stepped < 200, `${label}: ${stepped} steps (each page's first instruction is an entry)`);
});
for(const chaining of [1, 0]) {
    await run(hops(), { x64_chaining: chaining, x64_span_crossings: 16, x64_legacy_heat: 2000 }, ({ ran, spans }, label, adds) => {
        assert.ok(spans > 0, `${label}: no multi-page function`);
        assert.ok(ran > adds, `${label}: the page tier ran ${ran} instructions natively`);
    });
}
process.exit(0);
