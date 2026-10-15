#!/usr/bin/env node
// A remapped page of a multi-page function (docs/jit-unification-plan.md
// P7.3b, x64_page_clusters): a hot loop on one page calls into the next
// linear page and back, so the page tier compiles both into one function,
// and every 64th iteration points the second page's PTE at another physical
// page with other code (then INVLPG). The function verifies its pages at
// entry, and INVLPG ends an activation: the counters must be the
// interpreter's.
//
//   node tests/ir/differential/tier0_span_remap.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
// Runs the page tier (x64_page_legacy32 and x64_page_clusters) on top of
// JIT_SWITCHES.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The loop at CODE, the called page at CODE + 0x1000 (linear), backed by
// PAGE_A or PAGE_B (physical, identity mapped elsewhere)
const CODE = 0x500000, PAGE_A = 0x520000, PAGE_B = 0x521000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 60000;
const PTE = 0x11000 + ((CODE + 0x1000) >>> 12) * 4;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const rel = (from, to) => u32(to - from >>> 0);

// EBX = DATA: [ebx+124] loop counter, [ebx+120] A's calls, [ebx+116] B's
// calls, [ebx+112] PTE flips
const loop = [];
loop.push(0xF6, 0x43, 124, 63);                                     // top: TEST BYTE [ebx+124], 63
loop.push(0x75, 25);                                                // JNZ call
loop.push(0xA1, ...u32(PTE));                                       // MOV EAX, [pte]
loop.push(0x35, ...u32((PAGE_A ^ PAGE_B) >>> 0));                   // XOR EAX, A ^ B
loop.push(0xA3, ...u32(PTE));                                       // MOV [pte], EAX
loop.push(0x0F, 0x01, 0x3D, ...u32(CODE + 0x1000));                 // INVLPG [page]
loop.push(0xFF, 0x43, 112);                                         // INC DWORD [ebx+112]
loop.push(0xE8, ...rel(CODE + loop.length + 5, CODE + 0x1000));     // call: CALL page
loop.push(0xFF, 0x4B, 124);                                         // DEC DWORD [ebx+124]
loop.push(0x0F, 0x85, ...u32(-(loop.length + 6)));                  // JNZ top
loop.push(0xF4, 0xEB, 0xFE);                                        // HLT
const code_a = [0xFF, 0x43, 120, 0x01, 0xD1, 0xC3];                 // INC DWORD [ebx+120]; ADD ECX, EDX; RET
const code_b = [0xFF, 0x43, 116, 0x29, 0xD1, 0xC3];                 // INC DWORD [ebx+116]; SUB ECX, EDX; RET

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        ir_sync_publication: true,
        ...compiled ? { jit_switches: { x64_block_count: 0, x64_legacy_heat: 2000, ...jit_switches_from_env(),
            x64_page_legacy32: 1, x64_page_clusters: 1, x64_span_crossings: 64 } } : {},
        bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
    });
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run();
    const end = performance.now() + 15000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
        assert(performance.now() < end, "benchmark BIOS did not start");
        await sleep(1);
    }
    await vm.stop();
    if(compiled) assert(e.jit_set_page32(1));
    return { vm, cpu, e, compiled };
}

async function run({ vm, cpu, e, compiled }) {
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.fill(0xCC, CODE, CODE + 0x2000);
    cpu.mem8.set(loop, CODE);
    cpu.mem8.fill(0xCC, PAGE_A, PAGE_A + 0x2000);
    cpu.mem8.set(code_a, PAGE_A);
    cpu.mem8.set(code_b, PAGE_B);
    view.setUint32(PTE, PAGE_A | 3, true);
    cpu.mem8.fill(0, DATA, DATA + 128);
    cpu.mem8.fill(0, STACK - 0x1000, STACK);
    view.setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.fill(0);
    cpu.reg32[2] = 3; cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    e.full_clear_tlb();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${compiled ? "page tier" : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `counter ${view.getUint32(DATA + 124, true)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        status: view.getUint32(0x608, true),
        regs: Array.from(cpu.reg32, v => v >>> 0),
        a: view.getUint32(DATA + 120, true),
        b: view.getUint32(DATA + 116, true),
        flips: view.getUint32(DATA + 112, true),
        counter: view.getUint32(DATA + 124, true),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        spans: compiled ? e.x64_page_stat(38) : 0,
        native: compiled ? e.x64_page_stat(1) : 0,
    };
}

const reference = await run(await machine(false));
assert.equal(reference.a + reference.b, ITERATIONS, "the interpreter called the page once per iteration");
assert(reference.a > 0 && reference.b > 0, "the interpreter ran both mappings");
const compiled = await run(await machine(true));
assert(compiled.spans > 0, "the page tier compiled no span");
assert(compiled.native > ITERATIONS, "the page tier ran the loop's instructions natively too seldom");
const strip = ({ spans, native, ...rest }) => rest;
assert.deepEqual(strip(compiled), strip(reference), "a span's remapped page runs other code than in the interpreter");
console.log(`PASS: a span's second page remapped ${reference.flips} times: ${reference.a} calls to one mapping, ${reference.b} to the other, ` +
    `as in the interpreter (${compiled.spans} span compiles, ${compiled.native} native instructions)`);
process.exit(0);
