#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setImmediate as set_immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { smp_modes, with_smp_mode, compiled_hits } from "../lib/smp_modes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const mutation = process.env.SMP_MUTATION || "";
assert.ok(["", "publish-early"].includes(mutation));
fs.mkdirSync(root + "build/smp", { recursive: true });
const kernel = root + `build/smp/memory_order${mutation ? "-" + mutation : ""}.bin`;
const assembled = spawnSync("nasm", [...(mutation ? ["-DPUBLISH_EARLY"] : []), "-f", "bin", "-o", kernel, root + "tests/smp/memory_order.asm"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);
const seeds = process.env.SMP_SEEDS?.split(",").map(Number) || Array.from({ length: 10 }, (_, i) => i + 1);
const modes = smp_modes();
const quantums = process.env.SMP_QUANTUMS?.split(",").map(Number) || [17, 257, 4096];
const CONTROL = 0x380000;
const RECORDS = 0x381000;

async function run(cores, seed, quantum, mode)
{
    const count = 4096 + seed * 17;
    const emulator = new V86(with_smp_mode({ graphics_adapter: "bochs_vga", multiboot: { url: kernel }, memory_size: 16 << 20,
        acpi: true, cpu_cores: cores, cpu_quantum: quantum, cpu_schedule_seed: seed,
        disable_jit: mode === "interpreter", experimental_smp_jit: true, ir_sync_publication: true,
        autostart: false, log_level: 0 }, mode));
    const label = `${mode} cores=${cores} seed=${seed} quantum=${quantum}`;
    try
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        const cpu = emulator.v86.cpu;
        const e = cpu.wm.exports;
        const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        const word = address => view().getUint32(address, true);
        view().setUint32(CONTROL, count, true);
        const entry = cpu.save_core_state();
        for(let id = 0; id < cores; id++)
        {
            cpu.switch_core(id);
            cpu.load_core_state(entry);
            cpu.reg32[7] = id;
            cpu.cores[id].running = true;
        }
        cpu.switch_core(0);
        let rounds = 0;
        const deadline = performance.now() + 30000;
        while(Array.from({ length: cores }, (_, id) => word(RECORDS + id * 64)).some((value, id) => value !== 0xD0D0 + id))
        {
            assert.equal(word(CONTROL + 8), 0, `${label}: payload observed before publication or slot reused before read, sequence=${word(CONTROL + 4)}`);
            if(performance.now() >= deadline) throw new Error(`${label}: queue stalled ${JSON.stringify(cpu.get_diagnostics())}`);
            cpu.run_cores();
            if((++rounds & 1023) === 0) await set_immediate();
        }
        assert.equal(word(CONTROL + 8), 0, `${label}: queue payload mismatch`);
        for(let id = 0; id < cores; id++)
        {
            assert.equal(word(RECORDS + id * 64 + 8), count + 1, `${label}: core ${id} completed every item`);
            assert.equal(word(RECORDS + id * 64 + 4), id & 1 ? 0 : count * (count + 1) / 2, `${label}: consumer ${id} checksum`);
            assert.equal(word(0x390000 + (id >> 1) * 4096 + (id & 1 ? 0 : 64)), count, `${label}: queue fully drained`);
        }
        const hits = compiled_hits(e);
        if(mode !== "interpreter") assert.ok(hits > 0, `${label}: compiled queue actually executed`);
        else assert.equal(hits, 0);
        return hits;
    }
    finally { await emulator.destroy(); }
}

let cases = 0;
for(const mode of modes)
{
    let hits = 0;
    for(const quantum of quantums)
    {
        for(const seed of seeds)
        {
            hits += await run(2, seed, quantum, mode);
            cases++;
        }
    }
    for(const cores of [4, 8])
    {
        hits += await run(cores, 1, 257, mode);
        cases++;
    }
    console.log(`${mode}: lock-free publication/queue passed ${seeds.length} seeds × ${quantums.length} quantums, 2/4/8 cores; compiled activations=${hits}`);
}
console.log(`SMP memory ordering: ${cases} cases passed`);
