#!/usr/bin/env node
// Tier-0 instruction fetch faults: a hot loop calls a function on another
// page and every 64 iterations unmaps that page (PTE present bit, INVLPG), so
// entering the callee's page function must fault on the fetch. The #PF
// handler records the faulting EIP and CR2 and maps the page back. The fault
// frame must name the callee's first instruction: a stale EIP (the last
// retired instruction, on the caller's page) makes IRET re-execute it, which
// is how XP lost lsass/csrss and bugchecked in NTFS when pageable code was
// paged out.
//
//   node tests/ir/differential/tier0_fetch_fault.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
// JIT_SWITCHES=x64_page_legacy32=1: the x64 page tier runs the code instead
// (docs/jit-unification-plan.md P7.3), compiling at 2000 instructions.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const page_tier = jit_switches_from_env().x64_page_legacy32 === 1;
const engine = page_tier ? "the page tier" : "Tier-0";

const CALLER = 0x500000, CALLEE = 0x502000, HANDLER = 0x503000, DATA = 0x600000, STACK = 0x610000;
const PTE = 0x11000 + (CALLEE >>> 12) * 4, ITERATIONS = 50000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const rel = (from, to) => u32(to - from >>> 0);

// EBX = DATA: [ebx+124] loop counter, [ebx+120] calls, [ebx+116] last CR2,
// [ebx+112] last fault EIP, [ebx+108] faults, [ebx+104] faults elsewhere.
const caller = [];
caller.push(0xF6, 0x43, 124, 63);                                   // top: TEST BYTE [ebx+124], 63
caller.push(0x75, 14);                                              // JNZ call
caller.push(0x83, 0x25, ...u32(PTE), 0xFE);                         // AND DWORD [pte], ~1
caller.push(0x0F, 0x01, 0x3D, ...u32(CALLEE));                      // INVLPG [callee]
caller.push(0xE8, ...rel(CALLER + caller.length + 5, CALLEE));      // call: CALL callee
caller.push(0xFF, 0x4B, 124);                                       // DEC DWORD [ebx+124]
caller.push(0x0F, 0x85, ...rel(CALLER + caller.length + 6, CALLER)); // JNZ top
caller.push(0xF4);                                                  // HLT
const callee = [0xFF, 0x43, 120, 0xC3];                             // INC DWORD [ebx+120]; RET
const handler = [
    0x50,                                                           // PUSH EAX
    0x8B, 0x44, 0x24, 0x08,                                         // MOV EAX, [esp+8] (EIP)
    0x89, 0x43, 112,                                                // MOV [ebx+112], EAX
    0x3D, ...u32(CALLEE),                                           // CMP EAX, callee
    0x74, 3,                                                        // JE +3
    0xFF, 0x43, 104,                                                // INC DWORD [ebx+104]
    0x0F, 0x20, 0xD0,                                               // MOV EAX, CR2
    0x89, 0x43, 116,                                                // MOV [ebx+116], EAX
    0xFF, 0x43, 108,                                                // INC DWORD [ebx+108]
    0x83, 0x0D, ...u32(PTE), 0x01,                                  // OR DWORD [pte], 1
    0x0F, 0x01, 0x3D, ...u32(CALLEE),                               // INVLPG [callee]
    0x58,                                                           // POP EAX
    0x83, 0xC4, 0x04,                                               // ADD ESP, 4 (error code)
    0xCF,                                                           // IRETD
];

async function machine(tier0) {
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: wasm, disable_jit: !tier0, memory_size: 128 << 20, // reference: the interpreter only
        // (the page tier counts each instruction, compiles early, and its
        // functions are installed as they are compiled)
        ...tier0 ? { jit_switches: { ...page_tier ? { x64_block_count: 0, x64_legacy_heat: 2000 } : { x64_page_legacy32: 0 }, ...jit_switches_from_env() } } : {},
        ...tier0 && page_tier ? { ir_sync_publication: true } : {},
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
    if(tier0) assert(e.ir_auto_set_tier0(1));
    return { vm, cpu, e, tier0 };
}

async function run({ vm, cpu, e, tier0 }) {
    cpu.mem8.set(caller, CALLER);
    cpu.mem8.set(callee, CALLEE);
    cpu.mem8.set(handler, HANDLER);
    cpu.mem8.fill(0, DATA, DATA + 128);
    cpu.mem8.fill(0, STACK - 0x1000, STACK);
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    view.setUint32(DATA + 124, ITERATIONS, true);
    // Vector 14: a present 32-bit interrupt gate to the handler.
    view.setUint16(0x7000 + 14 * 8, HANDLER & 0xFFFF, true);
    view.setUint16(0x7000 + 14 * 8 + 2, 8, true);
    view.setUint16(0x7000 + 14 * 8 + 4, 0x8E00, true);
    view.setUint16(0x7000 + 14 * 8 + 6, HANDLER >>> 16, true);
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CALLER;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${tier0 ? engine : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `status ${view.getUint32(0x608, true).toString(16)} counter ${view.getUint32(DATA + 124, true)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        status: view.getUint32(0x608, true),
        eip: cpu.instruction_pointer[0] >>> 0,
        esp: cpu.reg32[4] >>> 0,
        calls: view.getUint32(DATA + 120, true),
        faults: view.getUint32(DATA + 108, true),
        stray: view.getUint32(DATA + 104, true),
        fault_eip: view.getUint32(DATA + 112, true),
        cr2: view.getUint32(DATA + 116, true),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        pages: !tier0 ? 0 : page_tier ? e.x64_page_stat(37) : e.ir_t0_stat(0),
        native: page_tier && tier0 ? e.x64_page_stat(1) : 0,
    };
}

const reference = await run(await machine(false));
const tier0 = await run(await machine(true));
assert.equal(reference.stray, 0, "the interpreter reported a fault away from the callee");
assert.equal(reference.faults, Math.floor(ITERATIONS / 64), "the interpreter took one fetch fault per unmapping");
assert(tier0.pages > 0, `no ${engine} page was compiled`);
assert(!page_tier || tier0.native > 0, "the page tier ran no instruction natively");
const strip = ({ pages, native, ...rest }) => rest;
const { pages, native } = tier0, actual = strip(tier0), expected = strip(reference);
assert.deepEqual(actual, expected, `${engine} fetch faults differ from the interpreter`);
console.log(`PASS: ${expected.faults} fetch faults on a callee page of ${engine} (${pages} page compiles` +
    `${page_tier ? `, ${native} native instructions` : ""}) match the interpreter`);
process.exit(0);
