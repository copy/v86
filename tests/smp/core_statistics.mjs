#!/usr/bin/env node

// Architectural counters across interpreter and page-tier execution.
// Initial protected-mode contexts are injected only to isolate accounting.
// All increments, REP progress, faults and halts come from guest instructions.
import assert from "node:assert/strict";
import { setImmediate as set_immediate } from "node:timers";
import { smp_modes, with_smp_mode, mode_hits } from "../lib/smp_modes.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const modes = smp_modes();
// SMP_CORES=1: CPU 0's program alone (IR Tier-0's REP template ran on one core
// only, until P7.5: its elements must count the same)
const fields = ["retired_instructions", "rep_elements", "faults", "halt_count", "runtime_ms"];
const specifications = [
    { loops: 2048, elements: 1000, destination: 0x40000, fault: "ud" },
    { loops: 2085, elements: 0, destination: 0x44000, fault: "none" },
    { loops: 2122, elements: 10, destination: 0x4FFB, fault: "pf" },
];
specifications.length = Number(process.env.SMP_CORES || specifications.length);
// (alone, CPU 0 loops long enough for the page tier to compile its page)
if(specifications.length === 1) specifications[0].loops = 1 << 18;
const u32 = value => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24];
const COMPARED = 24;

function guest(core)
{
    const { loops, elements, destination, fault } = specifications[core];
    return Uint8Array.from([
        0x90, 0x66, 0x90,                   // nop; prefixed nop: two instructions
        0xBF, ...u32(0x48000 + core),       // mov edi, ordinary STOSB destination
        0xB0, 0x5A, 0xAA,                  // mov al, 5A; stosb (not a REP element)
        0xB9, ...u32(loops), 0x31, 0xC0,   // mov ecx, loops; xor eax,eax
        0x40, 0x49, 0x75, 0xFC,            // inc eax; dec ecx; jnz: exactly 3N
        0xBE, ...u32(0x52000),              // mov esi, zeros
        0xBF, ...u32(0x53000),              // mov edi, zeros
        0xB9, ...u32(COMPARED),             // mov ecx, COMPARED
        0xF3, 0xA6,                        // repe cmpsb: COMPARED elements, all equal
        0xB9, ...u32(elements),             // mov ecx, REP count
        0xBF, ...u32(destination),          // mov edi, REP destination
        0xB0, 0x5A,                        // mov al, 5A
        ...(fault === "pf" ? [0x67] : []),// force address16 element path for #PF
        0xF3, 0xAA,                        // rep stosb: one retirement on completion
        ...(fault === "ud" ? [0x0F, 0x0B] : []),
        0xF4,                              // normal or exception-handler HLT
    ]);
}

function initialize(cpu)
{
    const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const write = (address, value) => memory.setUint32(address, value >>> 0, true);
    write(0x28008, 0xFFFF); write(0x2800C, 0xCF9B00);
    write(0x28010, 0xFFFF); write(0x28014, 0xCF9300);
    for(const vector of [6, 14])
    {
        write(0x29000 + vector * 8, 0x80000);
        write(0x29004 + vector * 8, 0x38E00); // interrupt gate -> 08:00030000
    }
    cpu.mem8[0x30000] = 0xF4; // fault handler: hlt
    cpu.mem8.set([0x90, 0x90, 0xF4], 0x32000); // later snapshot mutation
    write(0x90000, 0x91003);
    for(let page = 0; page < 1024; page++) write(0x91000 + page * 4, page << 12 | 3);
    write(0x91000 + 5 * 4, 0); // REP on CPU 2 commits five bytes then faults
    for(let core = 0; core < specifications.length; core++)
    {
        cpu.switch_core(core);
        const ip = 0x10000 + core * 0x1000;
        cpu.mem8.set(guest(core), ip);
        cpu.reg32.fill(0);
        cpu.reg32[4] = 0x80000 - core * 0x1000;
        cpu.instruction_pointer[0] = cpu.previous_ip[0] = ip;
        cpu.flags[0] = 2;
        cpu.in_hlt[0] = 0;
        cpu.gdtr_offset[0] = 0x28000;
        cpu.gdtr_size[0] = 23;
        cpu.idtr_offset[0] = 0x29000;
        cpu.idtr_size[0] = 0x7FF;
        cpu.cr[0] = 0x80010011 | 0;
        cpu.cr[3] = 0x90000;
        cpu.cr[4] = 0;
        cpu.protected_mode[0] = cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_limits.fill(-1, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.sreg.set([16, 8, 16, 16, 16, 16]);
        cpu.segment_access_bytes.set([0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
        cpu.update_state_flags();
        cpu.full_clear_tlb();
        cpu.cores[core].running = true;
    }
    cpu.switch_core(0);
}

function statistics(cpu)
{
    const diagnostics = cpu.get_diagnostics().cores;
    return diagnostics.map((core, id) => Object.fromEntries(fields.map((field, index) => {
        const value = cpu.wm.exports.core_statistics_get(id, index);
        assert.equal(core[field], value, `CPU ${id}: ${field} diagnostic agrees with counter`);
        return [field, value];
    })));
}

async function halted(cpu, label)
{
    const deadline = performance.now() + 15000;
    let rounds = 0;
    while(cpu.get_diagnostics().cores.some(core => core.state !== "halted"))
    {
        assert.ok(performance.now() < deadline, `${label}: guest timed out ${JSON.stringify(cpu.get_diagnostics())}`);
        cpu.run_cores();
        if(++rounds % 16 === 0) await new Promise(resolve => set_immediate(resolve));
    }
    return rounds;
}

for(const mode of modes)
{
    const emulator = new V86(with_smp_mode({
        graphics_adapter: "bochs_vga",
        wasm_path: process.env.WASM_PATH,
        memory_size: 16 << 20, acpi: true, cpu_cores: specifications.length,
        cpu_quantum: 17, cpu_schedule_seed: 42,
        disable_jit: mode === "interpreter", experimental_smp_jit: true, ir_sync_publication: true,
        autostart: false, log_level: 0,
    }, mode));
    try
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        const cpu = emulator.v86.cpu;
        const ex = cpu.wm.exports;
        assert.equal(typeof ex.core_statistics_get, "function", "rebuild Wasm with architectural statistics exports");
        initialize(cpu);
        const hits = () => mode_hits(ex, mode);
        const per_core_hits = specifications.map(() => 0);
        const run_cpu_slice = cpu.run_cpu_slice.bind(cpu);
        cpu.run_cpu_slice = budget => {
            const core = cpu.active_core;
            const before = hits();
            const result = run_cpu_slice(budget);
            per_core_hits[core] += (hits() - before) >>> 0;
            return result;
        };
        const hits_before = hits();
        cpu.clock.resume();
        const rounds = await halted(cpu, mode);
        cpu.clock.pause();
        // (one core does not run through run_cpu_slice: all hits are its)
        if(specifications.length === 1) per_core_hits[0] = (hits() - hits_before) >>> 0;
        const original = statistics(cpu);
        for(let core = 0; core < specifications.length; core++)
        {
            const specification = specifications[core];
            const expected = {
                retired_instructions: specification.loops * 3 + (specification.fault === "pf" ? 15 : 16),
                rep_elements: COMPARED + (specification.fault === "pf" ? 5 : specification.elements),
                faults: specification.fault === "none" ? 0 : 1,
                halt_count: 1,
            };
            for(const field of Object.keys(expected))
            {
                assert.equal(original[core][field], expected[field], `${mode} CPU ${core}: exact ${field}`);
            }
            assert.ok(original[core].runtime_ms > 0, `${mode} CPU ${core}: measured execution time`);
            assert.equal(cpu.mem8[0x48000 + core], 0x5A, "ordinary STOSB executed but is not a REP element");
            cpu.switch_core(core);
            assert.equal(cpu.reg32[0], (specification.loops & ~255) | 0x5A, "arithmetic loop reached its exact terminal value");
            assert.equal(cpu.reg32[1], specification.fault === "pf" ? 5 : 0, "REP remaining count");
            if(specification.fault === "pf") assert.equal(cpu.cr[2], 0x5000, "fault occurs after five successful REP elements");
            if(mode !== "interpreter") assert.ok(per_core_hits[core] > 0, `${mode} CPU ${core}: compiled code really executed`);
        }
        assert.ok(cpu.mem8.slice(0x40000, 0x40000 + 1000).every(byte => byte === 0x5A), "completed REP committed all 1000 stores");
        if(specifications.length > 2) assert.deepEqual(Array.from(cpu.mem8.slice(0x4FFB, 0x5001)), [0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0]);
        if(mode === "interpreter")
        {
            assert.equal(ex.x64_page_stat(1), 0);
            assert.ok(cpu.cores[0].steps > original[0].retired_instructions,
                "REP continuation and fault dispatches must not inflate architectural retirement");
        }
        if(specifications.length === 1)
        {
            // (the snapshot checks below are about separate cores)
            console.log(`${mode}, one core: exact statistics passed ${JSON.stringify({ per_core_hits, counters: original })}`);
            continue;
        }

        const saved = await emulator.save_state();
        cpu.switch_core(1);
        cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x32000;
        cpu.in_hlt[0] = 0;
        cpu.clock.resume();
        await halted(cpu, `${mode} snapshot mutation`);
        cpu.clock.pause();
        const changed = statistics(cpu);
        assert.deepEqual(changed[0], original[0], "executing CPU 1 does not charge CPU 0");
        assert.deepEqual(changed[2], original[2], "executing CPU 1 does not charge CPU 2");
        assert.equal(changed[1].retired_instructions, original[1].retired_instructions + 3);
        assert.equal(changed[1].halt_count, original[1].halt_count + 1);
        assert.ok(changed[1].runtime_ms > original[1].runtime_ms);
        await emulator.restore_state(saved);
        assert.deepEqual(statistics(cpu), original, "whole-machine snapshot restores every core's exact counters and runtime");
        cpu.reboot_internal();
        assert.deepEqual(statistics(cpu), specifications.map(() => Object.fromEntries(fields.map(field => [field, 0]))),
            "machine reset clears all counters including APs and accumulated runtime");
        console.log(`${mode}: exact per-core statistics, successful/empty/faulting REP, ordinary STOSB, #UD/#PF, HLT, snapshot/reset passed ${JSON.stringify({ rounds, per_core_hits, counters: original })}`);
    }
    finally { await emulator.destroy(); }
}

// Snapshots predating the per-core extension have no statistics to restore.
// They must start at zero rather than inheriting the destination VM's history.
const legacy_vm = new V86({ graphics_adapter: "bochs_vga", acpi: true, cpu_cores: 1, memory_size: 16 << 20,
    wasm_path: process.env.WASM_PATH, disable_jit: true, autostart: false, log_level: 0 });
try
{
    await new Promise(resolve => legacy_vm.add_listener("emulator-loaded", resolve));
    const cpu = legacy_vm.v86.cpu;
    const run = () => {
        cpu.sreg[1] = cpu.segment_offsets[1] = 0;
        cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x1000;
        cpu.mem8.set([0x90, 0xF4], 0x1000);
        cpu.flags[0] = 2;
        cpu.in_hlt[0] = 0;
        cpu.full_clear_tlb();
        cpu.run_cpu_slice(4);
    };
    run();
    const saved = await legacy_vm.save_state();
    run();
    assert.equal(statistics(cpu)[0].retired_instructions, 4);
    const set_state = cpu.set_state.bind(cpu);
    cpu.set_state = state => {
        state.length = 96; // keep the clock, omit the optional per-core extension
        set_state(state);
    };
    await legacy_vm.restore_state(saved);
    assert.deepEqual(statistics(cpu)[0], Object.fromEntries(fields.map(field => [field, 0])),
        "legacy snapshot without counters cannot inherit destination execution history");
    console.log("legacy snapshot: missing per-core statistics restore as zero");
}
finally { await legacy_vm.destroy(); }
