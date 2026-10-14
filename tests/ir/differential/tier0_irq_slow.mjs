#!/usr/bin/env node
// Interrupts that a page function's own device access makes deliverable
// (docs/jit-unification-plan.md P3.0b; written for IR Tier-0, deleted in
// P7.5, now run on the x64 page tier in legacy mode, P7.3). A hot loop sends itself
// an IPI through the local APIC's ICR, then sends another while the TPR
// blocks it and lowers the TPR. Each interrupt must arrive right after the
// APIC write that made it deliverable: the handler compares the return EIP
// with the one the loop stored, and EOIs. The interpreter delivers inside
// the write, after EIP advanced; a page function, whose GPRs and EIP are
// in Wasm locals, must leave that write to the interpreter: the page tier
// retries device accesses there. Delivered inside a page function's write,
// the interrupt frame would be built from stale state, IF cleared and the
// vector left in service: no further interrupt arrives.
//
//   node tests/ir/differential/tier0_irq_slow.mjs [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
import { set_jit_switches } from "../../../src/jit_switches.js";
import { jit_switches_from_env } from "../../lib/jit_switches.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, HANDLER = 0x503000, DATA = 0x600000, STACK = 0x610000;
const APIC = 0xFEE00000, APIC_TABLE = 0x21000, VECTOR = 0x40, ITERATIONS = 20000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const apic_write = (register, value) => [0xC7, 0x05, ...u32(APIC + register), ...u32(value)]; // MOV DWORD [apic+r], imm32
const expect = eip => [0xC7, 0x43, 92, ...u32(eip)];                                         // MOV DWORD [ebx+92], imm32
const SELF_IPI = 1 << 18 | VECTOR; // fixed delivery, destination shorthand "self"

// EBX = DATA: [ebx+124] loop counter, [ebx+108] interrupts taken, [ebx+104]
// interrupts at another EIP than [ebx+92], [ebx+100] last such EIP, [ebx+96]
// instructions run while an interrupt was pending behind the TPR.
const code = [
    0xB0, 0xFF, 0xE6, 0x21, 0xE6, 0xA1,             // MOV AL, 0xFF; OUT 0x21, AL; OUT 0xA1, AL (mask the PIC)
    ...apic_write(0xF0, 0x1FF),                     // SVR: APIC software enabled
    ...apic_write(0x80, 0),                         // TPR 0
    0xFB,                                           // STI
];
const top = CODE + code.length;
const loop = [];
const at = () => top + loop.length;
loop.push(...expect(at() + 7 + 10));                // the IPI arrives after the ICR write
loop.push(...apic_write(0x300, SELF_IPI));
loop.push(...apic_write(0x80, 0xF0));               // TPR class 15: vector 0x40 waits
loop.push(...expect(at() + 7 + 10 + 3 + 10));       // ... until the TPR write below
loop.push(...apic_write(0x300, SELF_IPI));
loop.push(0xFF, 0x43, 96);                          // INC DWORD [ebx+96]
loop.push(...apic_write(0x80, 0));
loop.push(0xFF, 0x4B, 124);                         // DEC DWORD [ebx+124]
loop.push(0x0F, 0x85, ...u32(top - (at() + 6)));    // JNZ top
loop.push(0xFA, 0xF4);                              // CLI; HLT
code.push(...loop);
const handler = [
    0x50,                                           // PUSH EAX
    0x8B, 0x44, 0x24, 0x04,                         // MOV EAX, [esp+4] (EIP)
    0x3B, 0x43, 92,                                 // CMP EAX, [ebx+92]
    0x74, 6,                                        // JE +6
    0xFF, 0x43, 104,                                // INC DWORD [ebx+104]
    0x89, 0x43, 100,                                // MOV [ebx+100], EAX
    0xFF, 0x43, 108,                                // INC DWORD [ebx+108]
    ...apic_write(0xB0, 0),                         // EOI
    0x58,                                           // POP EAX
    0xCF,                                           // IRETD
];

async function machine(compiled) {
    const vm = new V86({
        graphics_adapter: "bochs_vga", acpi: true,
        wasm_path: wasm, disable_jit: !compiled, memory_size: 128 << 20, // reference: the interpreter only
        // (page functions are installed as they are compiled, not in a Promise
        // continuation, which the whole loop can run ahead of)
        ir_sync_publication: true,
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
    if(compiled) set_jit_switches(e, cpu.wasm_memory, { x64_legacy_heat: 2000, ...jit_switches_from_env() }, "tier0_irq_slow");
    return { vm, cpu, e, compiled };
}

async function run({ vm, cpu, e, compiled }) {
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    cpu.mem8.set(code, CODE);
    cpu.mem8.set(handler, HANDLER);
    cpu.mem8.fill(0, DATA, DATA + 128);
    cpu.mem8.fill(0, STACK - 0x1000, STACK);
    view.setUint32(DATA + 124, ITERATIONS, true);
    // The local APIC's page, identity mapped (the BIOS maps the first 64 MiB).
    cpu.mem8.fill(0, APIC_TABLE, APIC_TABLE + 4096);
    view.setUint32(0x10000 + (APIC >>> 22) * 4, APIC_TABLE | 3, true);
    view.setUint32(APIC_TABLE + (APIC >>> 12 & 1023) * 4, APIC | 3, true);
    // The vector's interrupt gate; the BIOS's IDT covers the exceptions only.
    view.setUint16(0x7000 + VECTOR * 8, HANDLER & 0xFFFF, true);
    view.setUint16(0x7000 + VECTOR * 8 + 2, 8, true);
    view.setUint16(0x7000 + VECTOR * 8 + 4, 0x8E00, true);
    view.setUint16(0x7000 + VECTOR * 8 + 6, HANDLER >>> 16, true);
    cpu.idtr_size[0] = 256 * 8 - 1;
    cpu.reg32.fill(0);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = CODE;
    e.update_state_flags();
    e.full_clear_tlb();
    vm.run();
    const end = performance.now() + 30000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            throw new Error(`timeout (${compiled ? "page tier" : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `status ${view.getUint32(0x608, true).toString(16)} counter ${view.getUint32(DATA + 124, true)}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        status: view.getUint32(0x608, true),
        eip: cpu.instruction_pointer[0] >>> 0,
        esp: cpu.reg32[4] >>> 0,
        counter: view.getUint32(DATA + 124, true),
        taken: view.getUint32(DATA + 108, true),
        misplaced: view.getUint32(DATA + 104, true),
        misplaced_eip: view.getUint32(DATA + 100, true),
        pending_runs: view.getUint32(DATA + 96, true),
        pages: compiled ? e.x64_page_stat(37) : 0,
        // (the APIC writes, MOV DWORD [disp32], imm32, the page tier retried
        // in the interpreter)
        apic_steps: compiled ? e.x64_page_stat(2) : 0,
    };
}

const reference = await run(await machine(false));
assert.equal(reference.status, 0, "the interpreter took an exception");
assert.equal(reference.taken, 2 * ITERATIONS, "the interpreter took two interrupts per iteration");
assert.equal(reference.misplaced, 0, `the interpreter delivered at ${reference.misplaced_eip.toString(16)}`);
assert.equal(reference.pending_runs, ITERATIONS);
assert.equal(reference.esp, STACK);

const page = await run(await machine(true));
assert(page.pages > 0, "no page was compiled");
assert(page.apic_steps >= ITERATIONS, `the page tier retried ${page.apic_steps} APIC writes; the loop did not run in a page function`);
const strip = ({ pages, apic_steps, ...rest }) => rest;
assert.deepEqual(strip(page), strip(reference), "interrupts from the page tier's APIC writes differ from the interpreter");
console.log(`PASS: ${reference.taken} interrupts from APIC writes in page tier pages (${page.pages} page compiles, ` +
    `${page.apic_steps} retries) match the interpreter`);
process.exit(0);
