#!/usr/bin/env node
// REP MOVS/STOS faults with the x64 page tier's REP templates in legacy mode
// (docs/jit-unification-plan.md P3.1t and P7.3(5); written for IR Tier-0's,
// deleted in P7.5): a hot loop of REP MOVSD and REP STOSD whose last
// iteration's source, or destination, runs across the end of the mapped
// 64 MiB. The template leaves an operand that crosses a page to the
// interpreter, which copies to the page's end and faults; compiled code must leave
// exactly the interpreter's state: the registers (ESI, EDI and ECX where the
// copy stopped), the exception, CR2 and the bytes copied.
//
//   node tests/ir/differential/tier0_rep_fault.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build). The page tier compiles at
// 2000 instructions.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 20000;
// the last mapped bytes: 16 of them before 64 MiB
const EDGE = 0x4000000 - 16;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];

function program(stos)
{
    // ECX = 8; ESI, EDI in DATA; on the last iteration ([DATA+124] = 1) the
    // source (MOVS) or the destination (STOS) at EDGE instead
    const loop = [
        0xB9, ...u32(8),                                // MOV ECX, 8
        0xBE, ...u32(DATA + 0x100),                     // MOV ESI, DATA+0x100
        0xBF, ...u32(DATA + 0x200),                     // MOV EDI, DATA+0x200
        0xB8, ...u32(0),                                // MOV EAX, 0
        0x83, 0x3D, ...u32(DATA + 124), 0x01,           // CMP DWORD [DATA+124], 1
        0x75, 0x05,                                     // JNE +5
        stos ? 0xBF : 0xBE, ...u32(EDGE),               // MOV EDI/ESI, EDGE
        0xF3, stos ? 0xAB : 0xA5,                       // REP STOSD / REP MOVSD
        0xFF, 0x0D, ...u32(DATA + 124),                 // DEC DWORD [DATA+124]
    ];
    loop.push(0x0F, 0x85, ...u32(-(loop.length + 6)), 0xF4); // JNZ top; HLT
    return loop;
}

async function machine(compiled)
{
    const vm = new V86({
        graphics_adapter: "bochs_vga", wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, ir_sync_publication: true,
        ...compiled ? { jit_switches: { x64_legacy_heat: 2000, ...jit_switches_from_env() } } : {},
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
    return { vm, cpu, e };
}

async function run({ vm, cpu, e }, code, page)
{
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.set(code, CODE + page * 0x1000);
    for(let k = 0; k < 64; k++) view.setUint32(DATA + 0x100 + 4 * k, 0x01010101 * (k + 1), true);
    cpu.mem8.fill(0, DATA + 0x200, DATA + 0x300);
    for(let k = 0; k < 16; k++) cpu.mem8[EDGE + k] = 0xA0 + k;
    view.setUint32(DATA + 124, ITERATIONS, true);
    view.setUint32(0x608, 0, true);
    cpu.reg32.fill(0);
    cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE + page * 0x1000;
    e.update_state_flags();
    e.full_clear_tlb();
    const entries = e.x64_page_stat(13);
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        assert(performance.now() < end, `timeout: eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)}`);
        await sleep(0);
    }
    await vm.stop();
    return {
        regs: Array.from(cpu.reg32.subarray(0, 8), v => v >>> 0).filter((_, r) => r !== 4),
        status: view.getUint32(0x608, true),
        cr2: cpu.cr[2] >>> 0,
        counter: view.getUint32(DATA + 124, true),
        copied: Array.from(cpu.mem8.subarray(DATA + 0x200, DATA + 0x220)),
        edge: Array.from(cpu.mem8.subarray(EDGE, EDGE + 16)),
        entries: e.x64_page_stat(13) - entries,
    };
}

const reference = await machine(false), compiled = await machine(true);
for(const [page, stos] of [[0, false], [1, true]]) {
    const code = program(stos);
    const expected = await run(reference, code, page), actual = await run(compiled, code, page);
    assert(actual.entries > 0, `${stos ? "STOS" : "MOVS"}: no page function ran`);
    assert.equal(expected.status >>> 0, (0x80000000 | 14) >>> 0, `${stos ? "STOS" : "MOVS"}: the reference took no #PF: ${expected.status.toString(16)}`);
    for(const key of ["regs", "status", "cr2", "counter", "copied", "edge"])
        assert.deepEqual(actual[key], expected[key], `${stos ? "STOS" : "MOVS"}: ${key} differs`);
    console.log(`${stos ? "REP STOSD" : "REP MOVSD"}: #PF at ${expected.cr2.toString(16)} after ${ITERATIONS - 1} iterations, ` +
        `ESI ${expected.regs[6 - 1].toString(16)} EDI ${expected.regs[7 - 1].toString(16)} ECX ${expected.regs[1]}: as the interpreter`);
}
await reference.vm.destroy();
await compiled.vm.destroy();
console.log("PASS: REP MOVSD and STOSD faulting across the end of mapped memory leave the interpreter's state in the page tier");
process.exit(0);
