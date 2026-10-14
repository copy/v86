#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setImmediate as set_immediate } from "node:timers";
import { fileURLToPath } from "node:url";
import { smp_modes, with_smp_mode, compiled_hits, published } from "../lib/smp_modes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const mutation = process.env.SMP_MUTATION || "";
assert.ok(["", "flush-on-switch", "no-shootdown"].includes(mutation));
const kernel = root + `build/smp/coherence${mutation ? "-" + mutation : ""}.bin`;
fs.mkdirSync(root + "build/smp", { recursive: true });
const assembled = spawnSync("nasm", [...(mutation === "no-shootdown" ? ["-DSKIP_SHOOTDOWN"] : []), "-f", "bin", "-o", kernel, root + "tests/smp/coherence.asm"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);
const CONTROL = 0x380000;
const RECORDS = CONTROL + 0x100;
const OLD = 0xA5A51111;
const NEW = 0x5A5A2222;
const seeds = process.env.SMP_SEEDS ? process.env.SMP_SEEDS.split(",").map(Number) : Array.from({ length: 10 }, (_, i) => i + 1);
const modes = smp_modes();
const quantums = process.env.SMP_QUANTUMS?.split(",").map(Number) || [17, 257, 4096];

async function run(cores, seed, quantum, mode, writer = "guest", asynchronous = false)
{
    const iterations = 128 + seed * 7;
    const emulator = new V86(with_smp_mode({
        graphics_adapter: "bochs_vga",
        multiboot: { url: kernel },
        memory_size: 16 << 20,
        acpi: true,
        cpu_cores: cores,
        cpu_quantum: quantum,
        cpu_schedule_seed: seed,
        disable_jit: mode === "interpreter",
        experimental_smp_jit: true,
        ir_sync_publication: !asynchronous,
        ir_region_budget: { hot_threshold: 2, promotion_threshold: 8 },
        autostart: false,
        log_level: 0,
    }, mode));
    const label = `${mode} cores=${cores} seed=${seed} quantum=${quantum} writer=${writer} async=${asynchronous}`;
    try
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        const cpu = emulator.v86.cpu;
        const e = cpu.wm.exports;
        if(mode !== "interpreter")
        {
            assert.equal(e.ir_auto_set_idle_mode(0, 1), 1);
            assert.equal(e.ir_auto_set_page_threshold(2), 1);
            if(mode === "region") assert.equal(e.ir_auto_set_page_mode(0), 1);
        }
        const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        const word = address => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(address, true);
        memory.setUint32(CONTROL, cores, true);
        memory.setUint32(CONTROL + 4, iterations, true);
        memory.setUint32(CONTROL + 52, mode === "interpreter" ? 1 : 0, true);
        memory.setUint32(0x400000, OLD, true);
        memory.setUint32(0x800000, NEW, true);
        memory.setUint32(0x391FFD, 0xFFFFFF00, true);
        memory.setUint32(0x392001, 0x12345678, true);
        // Only establish independent entry contexts. The guest performs all
        // coherence operations; the harness never flushes a runtime TLB.
        const switch_core = cpu.switch_core.bind(cpu);
        let dma_wrote = false;
        cpu.switch_core = id => {
            switch_core(id);
            if(mutation === "flush-on-switch") cpu.full_clear_tlb();
            if(writer === "dma" && id === 1 && word(CONTROL + 24) === 1 && !dma_wrote)
            {
                // Use the same physical RAM write barrier as DMA/IDE/virtio.
                // The guest sees completion and skips its own SMC store.
                cpu.write_blob(Uint8Array.of(0x33, 0x33, 0x33, 0x33), 0x101001);
                new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(CONTROL + 48, 1, true);
                dma_wrote = true;
            }
        };
        const entry = cpu.save_core_state();
        for(let id = 0; id < cores; id++)
        {
            cpu.switch_core(id);
            cpu.load_core_state(entry);
            cpu.reg32[7] = id;
            cpu.cores[id].running = true;
        }
        cpu.switch_core(0);
        const deadline = performance.now() + 30000;
        let rounds = 0;
        let hot_hits = 0;
        let max_slice = 0;
        while(Array.from({ length: cores }, (_, id) => word(RECORDS + id * 64)).some((value, id) => value !== 0xD0D0 + id))
        {
            assert.equal(word(CONTROL + 44), 0, `${label}: unexpected guest exception`);
            if(performance.now() >= deadline) throw new Error(`${label}: timeout phase=${word(CONTROL + 24)} diagnostics=${JSON.stringify(cpu.get_diagnostics())}`);
            const before_steps = cpu.cores.map(core => core.steps);
            cpu.run_cores();
            for(let id = 0; id < cores; id++)
            {
                const slice = cpu.cores[id].steps - before_steps[id];
                max_slice = Math.max(max_slice, slice);
                // JIT polls occur at block/activation boundaries. For this
                // fixture allow one 256-step activation beyond the request;
                // the interpreter only permits STI's one shadow instruction.
                assert.ok(slice <= quantum + (mode === "interpreter" ? 1 : 256), `${label}: bounded core ${id} slice (${slice})`);
            }
            const hot_published = published(e, 0x101000);
            const function_hits = e.ir_cache_entry_stat(0x101000, 0, 1, 1) >>> 0;
            // Tier-0 bypasses per-record hit accounting; the only cross-page
            // call/return chain in this fixture is the published hot function.
            // (the page tier counts no calls per function: its native
            // instructions, once the page has one)
            hot_hits = Math.max(hot_hits, function_hits, mode === "tier0" && hot_published ? e.ir_t0_chains() >>> 0 : 0,
                mode === "pages" && hot_published ? e.x64_page_stat(1) >>> 0 : 0);
            if(hot_hits > 0) new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(CONTROL + 52, 1, true);
            rounds++;
            if((rounds & (asynchronous ? 7 : 127)) === 0) await new Promise(resolve => set_immediate(resolve));
        }
        const total = cores * iterations;
        assert.equal(word(CONTROL + 8), total, `${label}: LOCK XADD counter`);
        assert.equal(word(CONTROL + 12), total, `${label}: implicit XCHG spinlock`);
        assert.equal(word(0x390FFF), total, `${label}: cross-page LOCK INC`);
        assert.equal(word(0x391FFD), (0xFFFFFF00 + total) >>> 0, `${label}: unaligned cross-page CMPXCHG8B`);
        assert.equal(word(0x392001), 0x12345678 + Math.floor((0xFFFFFF00 + total) / 0x100000000), `${label}: CMPXCHG8B high-word carry`);
        const tickets = Array.from({ length: cores }, (_, id) => word(RECORDS + id * 64 + 4)).reduce((a, b) => a + b, 0);
        assert.equal(tickets, total * (total - 1) / 2, `${label}: unique XADD tickets`);
        assert.equal(word(CONTROL + 32), OLD, `${label}: remote PTE write does not flush another core's TLB`);
        assert.equal(word(CONTROL + 36), NEW, `${label}: IPI + INVLPG publishes new mapping`);
        assert.equal(word(CONTROL + 40), writer === "dma" ? 0x33333333 : 0x22222222, `${label}: cross-core SMC invalidates compiled code`);
        if(writer === "dma") assert.equal(dma_wrote, true, `${label}: DMA writer ran`);
        assert.equal(word(CONTROL + 28), 1, `${label}: exactly one shootdown IPI`);
        const hits = compiled_hits(e);
        if(mode !== "interpreter")
        {
            assert.ok(hits > 0, `${label}: compiled code must actually execute: ${JSON.stringify(cpu.get_jit_info().ir)}`);
            assert.ok(hot_hits > 0, `${label}: the modified function must execute from compiled code before SMC`);
        }
        else assert.equal(hits, 0, `${label}: interpreter reference has no JIT hits`);
        return { rounds, hits, max_slice };
    }
    finally
    {
        await emulator.destroy();
    }
}

let cases = 0;
for(const mode of modes)
{
    let hits = 0;
    let max_slice = 0;
    for(const quantum of quantums)
    {
        for(const seed of seeds)
        {
            const result = await run(2, seed, quantum, mode);
            hits += result.hits;
            max_slice = Math.max(max_slice, result.max_slice);
            cases++;
        }
        console.log(`${mode}: ${seeds.length} seeds × 2 cores × quantum ${quantum}: LOCK/XCHG/CMPXCHG8B, cross-core SMC, stale TLB and IPI shootdown passed`);
    }
    for(const cores of [4, 8])
    {
        const result = await run(cores, 1, 257, mode);
        hits += result.hits;
        cases++;
    }
    hits += (await run(2, 1, 257, mode, "dma")).hits;
    cases++;
    if(mode !== "interpreter")
    {
        hits += (await run(2, 1, 257, mode, "guest", true)).hits;
        cases++;
    }
    console.log(`${mode}: 4/8-core coherence, DMA physical writer and publication variants passed; compiled activations=${hits}, maximum observed slice=${max_slice}`);
}
console.log(`SMP coherence: ${cases} cases passed`);
