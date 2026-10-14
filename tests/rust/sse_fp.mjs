// Exact SSE floating point in the 32-bit engines (docs/simd-xsave-plan.md
// 7.4, P4a, P4b): every SSE/SSE2/SSE3/SSE4.1 floating-point form (ROUND and
// DPPS/DPPD with tests/rust/sse4_model.mjs's use of the model), with register and
// memory sources, against the model of tests/rust/sse_fp_model.mjs (exact
// rational arithmetic, independent of SoftFloat and cpu/simd_fp.rs). Each
// case sets MXCSR (the four rounding modes, DAZ, FZ, masked and unmasked
// exceptions, PE set or not) and checks the destination, MXCSR and the fault:
// #XM, or #UD without CR4.OSXMMEXCPT, with the destination unchanged. Values
// include zeros, denormals, the normal extremes, infinities, QNaNs and SNaNs
// and results that overflow, underflow or are inexact. Every case runs in the
// interpreter, then hot under the page tier and the region tiers, whose native paths
// (x86tpl::native_fp) must be refused exactly where they would differ.
// Then the same cases run as 64-bit code in long mode under the x64 page
// tier (docs/jit-unification-plan.md P4.18: its templates with JIT_SWITCHES
// x64_sse_fast_check=1, else the forms it takes before P4.18).
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { FORMS, MXCSRS, bytes128, cases } from "./sse_fp_cases.mjs";
import { assemble, actual as run_guest } from "../x64/guest_runner.mjs";
import { long_mode_guest } from "../x64/guest_builder.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x300000, FAULTS = 0x3F0000, CASE = 0x3FF000, SKIP = 0x3FF004;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);

// the code of a case: MXCSR, the operands, the instruction, its results
const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
const movdqu_load = (r, a) => [0xF3, 0x0F, 0x6F, 0x05 | r << 3, ...u32(a)];
const movdqu_store = (r, a) => [0xF3, 0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
const movq_load = (r, a) => [0x0F, 0x6F, 0x05 | r << 3, ...u32(a)], movq_store = (r, a) => [0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
const mov_eax = a => [0xA1, ...u32(a)], store_eax = a => [0xA3, ...u32(a)];
const EMMS = [0x0F, 0x77];
/** The instruction: register 1 (XMM, MMX or EAX) and register 0 or [source] */
function instruction(form, memory, source, imm8)
{
    const rm = memory ? [0x05 | 1 << 3, ...u32(source)] : [0xC0 | 1 << 3 | 0];
    return [...form.prefix, 0x0F, ...(form.map ? [form.map] : []), form.code, ...rm, ...(form.imm8 ? [imm8] : [])];
}
function program(form, memory, list)
{
    const p = [];
    list.forEach((c, n) => {
        const base = DATA + n * 64;
        p.push(0xC7, 0x05, ...u32(CASE), ...u32(n));
        p.push(...ldmxcsr(base + 32));
        // register 1: the destination; register 0: the source (unless memory)
        if(form.kind === "to_gpr") p.push(0xB9, ...u32(0x5A5A5A5A)); // ecx (register 1)
        else if(form.kind === "to_mmx") p.push(...movq_load(1, base));
        else p.push(...movdqu_load(1, base));
        if(!memory)
        {
            if(form.kind === "from_gpr") p.push(0xB8, ...u32(Number(c.b & 0xFFFFFFFFn)));
            else if(form.kind === "from_mmx") p.push(...movq_load(0, base + 16));
            else p.push(...movdqu_load(0, base + 16));
        }
        p.push(...instruction(form, memory, base + 16, c.imm8));
        p.push(...stmxcsr(OUT + n * 32 + 16));
        if(form.kind === "comi") p.push(0x9C, 0x58, ...store_eax(OUT + n * 32));
        else if(form.kind === "to_gpr") p.push(0x89, 0x0D, ...u32(OUT + n * 32));
        else if(form.kind === "to_mmx") p.push(...movq_store(1, OUT + n * 32), ...EMMS);
        else p.push(...movdqu_store(1, OUT + n * 32));
        if(form.kind === "from_mmx") p.push(...EMMS);
    });
    return p;
}

const machines = [];
async function run(vm, code, warm, interpreter)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(Uint8Array.from(code), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 60000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && compiled_activations(e) === start)
    {
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it for the case, skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58);
    p.push(0xA1, ...u32(CASE), 0xC7, 0x04, 0x85, ...u32(FAULTS), ...u32(vector)); // mov [FAULTS + eax*4], vector
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true], [19, false]];
async function create_machines()
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 64 << 20,
            // (the SSE4.1 forms: ROUND, DPPS/DPPD)
            cpu_features: ["SSSE3", "SSE4.1"],
            ...arm, disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
        set.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    return set;
}

// The long-mode column: a form's cases as 64-bit code, LONG_ROUNDS times
// over (the page tier compiles each page during the first rounds), with an
// IDT whose handlers record a fault for the case and skip the instruction
// as above. A fault resumes at a jump's target, a block start of the page
// function, so the rest of the page runs compiled.
const L_DATA = 0x400000, L_OUT = 0x800000, L_FAULTS = 0xA00000, L_CASE = 0xA10000, L_SKIP = 0xA10004, L_IDT = 0xA20000;
const LONG_ROUNDS = 24;
/** The instruction in 64-bit code ([source] through a SIB byte: ModRM 0x05 is RIP-relative there) */
function instruction64(form, memory, source, imm8)
{
    const rm = memory ? [0x04 | 1 << 3, 0x25, ...u32(source)] : [0xC0 | 1 << 3 | 0];
    return [...form.prefix, 0x0F, ...(form.map ? [form.map] : []), form.code, ...rm, ...(form.imm8 ? [imm8] : [])];
}
function long_program(form, memory, list, xmm_exceptions)
{
    const lines = [];
    for(const [vector] of VECTORS)
    {
        const gate = L_IDT + vector * 16;
        lines.push(`lea rax, [rel fault${vector}]`, `mov [${gate}], ax`, `mov word [${gate + 2}], 24`, `mov word [${gate + 4}], 0x8E00`,
            "shr rax, 16", `mov [${gate + 6}], ax`, "shr rax, 16", `mov [${gate + 8}], eax`, `mov dword [${gate + 12}], 0`);
    }
    lines.push("lidt [rel idtr]", "mov rax, cr4", `or eax, ${xmm_exceptions ? 0x600 : 0x200}`, ...(xmm_exceptions ? [] : ["and eax, ~0x400"]),
        "mov cr4, rax", `mov r15d, ${LONG_ROUNDS}`, "cases:");
    list.forEach((c, n) => {
        const base = L_DATA + n * 64, out = L_OUT + n * 32;
        lines.push(`mov dword [${L_CASE}], ${n}`, `ldmxcsr [${base + 32}]`);
        if(form.kind === "to_gpr") lines.push("mov ecx, 0x5A5A5A5A");
        else if(form.kind === "to_mmx") lines.push(`movq mm1, [${base}]`);
        else lines.push(`movdqu xmm1, [${base}]`);
        if(!memory)
        {
            if(form.kind === "from_gpr") lines.push(`mov eax, ${Number(c.b & 0xFFFFFFFFn)}`);
            else if(form.kind === "from_mmx") lines.push(`movq mm0, [${base + 16}]`);
            else lines.push(`movdqu xmm0, [${base + 16}]`);
        }
        // (a fault skips the instruction and the 2-byte jump: L_SKIP)
        lines.push(`db ${instruction64(form, memory, base + 16, c.imm8).join(",")}`, `jmp short resume${n}`, `resume${n}:`,
            `stmxcsr [${out + 16}]`);
        if(form.kind === "comi") lines.push("pushfq", "pop rax", `mov [${out}], eax`);
        else if(form.kind === "to_gpr") lines.push(`mov [${out}], ecx`);
        else if(form.kind === "to_mmx") lines.push(`movq [${out}], mm1`, "emms");
        else lines.push(`movdqu [${out}], xmm1`);
        if(form.kind === "from_mmx") lines.push("emms");
    });
    lines.push("dec r15d", "jnz cases");
    const handlers = VECTORS.map(([vector, error_code]) => [`fault${vector}:`, "push rax", `mov eax, [${L_CASE}]`,
        `mov dword [${L_FAULTS} + rax * 4], ${vector}`, `mov eax, [${L_SKIP}]`, `add [rsp + ${error_code ? 16 : 8}], rax`, "pop rax",
        ...(error_code ? ["add rsp, 8"] : []), "iretq"].join("\n"));
    return long_mode_guest(lines.join("\n"), [...handlers, "align 8", `idtr: dw 4095`, `dq ${L_IDT}`].join("\n"));
}
/** Run the cases of `form` in long mode under the page tier: its outputs and fault vectors */
async function run_long(form, memory, list, xmm_exceptions, data)
{
    const directory = assemble(`sse-fp-model-${form.name}${memory ? "-mem" : ""}`, long_program(form, memory, list, xmm_exceptions));
    let out, faults, native;
    await run_guest(directory, {
        length: 8, timeout: 120000,
        options: { wasm_path: candidate, disable_jit: false, ir_sync_publication: true, cpu_features: ["SSSE3", "SSE4.1"] },
        setup: emulator => {
            const cpu = emulator.v86.cpu;
            cpu.mem8.set(data, L_DATA);
            cpu.mem8.fill(0, L_OUT, L_OUT + list.length * 32);
            cpu.mem8.fill(0, L_FAULTS, L_FAULTS + list.length * 4);
            cpu.mem8.set(u32(instruction64(form, memory, 0, 0).length + 2), L_SKIP);
        },
        inspect: emulator => {
            const cpu = emulator.v86.cpu;
            out = cpu.mem8.slice(L_OUT, L_OUT + list.length * 32);
            faults = cpu.mem8.slice(L_FAULTS, L_FAULTS + list.length * 4);
            native = cpu.wm.exports.x64_page_stat(1);
        },
    });
    return { out, faults, native };
}

/** Compare a run's outputs (and fault vectors) for `list` with the model */
function check(form, memory, list, run, out, fault_bytes, xmm_exceptions)
{
    const faults = new DataView(fault_bytes.buffer);
    const view = new DataView(out.buffer);
    list.forEach((c, n) => {
        const label = `${form.name}${memory ? " [mem]" : ""} case ${n} on ${run}: mxcsr ${c.mxcsr.toString(16)} a ${c.a.toString(16)} b ${c.b.toString(16)}${form.imm8 ? " imm8 " + c.imm8 : ""}`;
        const vector = faults.getUint32(n * 4, true);
        assert.equal(vector, c.fault ? xmm_exceptions ? 19 : 6 : 0, label + ": fault");
        assert.equal(view.getUint32(n * 32 + 16, true), c.after, label + ": MXCSR");
        // a faulting instruction leaves its destination alone
        const destination = form.kind === "to_gpr" ? 0x5A5A5A5An : form.kind === "comi" ? undefined : c.a;
        let actual, expected;
        if(form.kind === "comi")
        {
            actual = BigInt(view.getUint32(n * 32, true) & 0x8D5);
            expected = c.fault ? undefined : BigInt(c.result);
        }
        else if(form.kind === "to_gpr")
        {
            actual = BigInt(view.getUint32(n * 32, true));
            expected = c.fault ? destination : c.result & 0xFFFFFFFFn;
        }
        else if(form.kind === "to_mmx")
        {
            actual = view.getBigUint64(n * 32, true);
            expected = c.fault ? c.a & 0xFFFFFFFFFFFFFFFFn : c.result;
        }
        else
        {
            actual = view.getBigUint64(n * 32, true) | view.getBigUint64(n * 32 + 8, true) << 64n;
            expected = c.fault ? destination : c.result;
        }
        if(expected !== undefined) assert.equal(actual.toString(16), expected.toString(16), label + ": result");
    });
}

let total = 0, long_total = 0;
try
{
    machines.push(...await create_machines());
    for(const xmm_exceptions of [true, false])
    {
        // CR4.OSFXSR and OSXMMEXCPT (else unmasked exceptions are #UD), CR0.TS clear
        const cr4 = [0x0F, 0x20, 0xE0, 0x0D, ...u32(xmm_exceptions ? 0x600 : 0x200), ...(xmm_exceptions ? [] : [0x25, ...u32(~0x400 >>> 0)]), 0x0F, 0x22, 0xE0];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0x0F, 0x06, ...cr4];
        for(const form of xmm_exceptions ? FORMS : FORMS.filter(f => f.kind === "binary" && !f.double))
        {
            // (SSE_FP_ONLY=name: one form, for debugging)
            if(process.env.SSE_FP_ONLY && form.name !== process.env.SSE_FP_ONLY) continue;
            for(const memory of [false, true])
            {
                const list = cases(form);
                const length = instruction(form, memory, 0, 0).length;
                const code = loop([...prologue, ...program(form, memory, list)]);
                const data = new Uint8Array(list.length * 64);
                list.forEach((c, n) => {
                    data.set(bytes128(c.a), n * 64);
                    data.set(bytes128(c.b), n * 64 + 16);
                    data.set(u32(c.mxcsr), n * 64 + 32);
                });
                // (every run: the cold one is mostly interpreted, the program was rewritten)
                const runs = [];
                for(const [m, vm] of machines.entries())
                {
                    vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
                    VECTORS.forEach(([vector, error_code], i) => {
                        const h = HANDLER + i * 0x100;
                        vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
                        vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
                    });
                    vm.write_memory(Uint8Array.from(u32(length)), SKIP);
                    for(const warm of [true, false])
                    {
                        vm.write_memory(data, DATA);
                        vm.write_memory(new Uint8Array(list.length * 32), OUT);
                        vm.write_memory(new Uint8Array(list.length * 4), FAULTS);
                        vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
                        await run(vm, code, warm, vm === machines[0]);
                        runs.push({ run: `machine ${m} ${warm ? "hot" : "one round"}`, out: Uint8Array.from(vm.read_memory(OUT, list.length * 32)),
                            faults: Uint8Array.from(vm.read_memory(FAULTS, list.length * 4)) });
                    }
                }
                for(const { run, out, faults } of runs) check(form, memory, list, run, out, faults, xmm_exceptions);
                // (the long-mode column: SSE_FP_LONG=0 leaves it out)
                if(process.env.SSE_FP_LONG !== "0")
                {
                    const { out, faults, native } = await run_long(form, memory, list, xmm_exceptions, data);
                    // (each case runs some 10 instructions, which the page tier
                    // compiles from the third round on; a form it steps leaves
                    // a page function at each case)
                    assert.ok(native > list.length * 2 * LONG_ROUNDS, `${form.name}: the page tier ran the cases (${native} native instructions)`);
                    check(form, memory, list, "the x64 page tier", out, faults, xmm_exceptions);
                    long_total += list.length;
                }
                total += list.length;
            }
        }
        console.log(`PASS: ${xmm_exceptions ? "all forms, unmasked exceptions as #XM" : "unmasked exceptions as #UD without CR4.OSXMMEXCPT"}`);
    }
    console.log(`PASS: ${total} exact SSE floating-point cases (${FORMS.length} forms, register and memory sources, ${MXCSRS.length} MXCSR settings) match the model on 3 arms`);
    if(long_total) console.log(`PASS: ${long_total} of them as 64-bit code under the x64 page tier`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
