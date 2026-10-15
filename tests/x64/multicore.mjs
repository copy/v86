#!/usr/bin/env node
// Real INIT/SIPI APs: no host writes to registers, runnable flags or page tables.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {setImmediate as yield_event} from "node:timers/promises";
import {fileURLToPath} from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = root + "build/x64-multicore/";
fs.mkdirSync(directory, {recursive: true});
const kernel = directory + "guest.bin";
const nasm = spawnSync("nasm", ["-f", "bin", "-o", kernel, root + "tests/x64/multicore.asm"], {encoding: "utf8"});
assert.equal(nasm.status, 0, nasm.stderr);
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const {CORE_STATE_RANGES, STATE_OFFSETS} = await import("../../src/state_layout.js");
const modes = process.env.X64_MODES?.split(",") || ["interpreter", "pages"];
const seeds = process.env.X64_SEEDS?.split(",").map(Number) || [1, 7];
const quantums = process.env.X64_QUANTUMS?.split(",").map(Number) || [17, 257];
const CONTROL = 0x380000, RECORDS = 0x390000, ITERATIONS = 512;
async function run(mode, seed, quantum)
{
    const label = `${mode} seed=${seed} quantum=${quantum}`;
    const emulator = new V86({graphics_adapter: "bochs_vga", multiboot: {url: kernel}, memory_size: 32 << 20, cpu_cores: 4,
        cpu_quantum: quantum, cpu_schedule_seed: seed, acpi: true, autostart: false,
        disable_jit: mode === "interpreter", experimental_smp_jit: true,
        ir_sync_publication: true, log_level: 0});
    let cpu, rounds = 0;
    const native = [0, 0, 0, 0];
    try
    {
        await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
        cpu = emulator.v86.cpu;
        const ex = cpu.wm.exports;
        const slice = cpu.run_cpu_slice.bind(cpu);
        cpu.run_cpu_slice = (...args) => {
            const core = cpu.active_core;
            const before = ex.x64_page_stat(1);
            const result = slice(...args);
            native[core] += ex.x64_page_stat(1) - before;
            return result;
        };
        const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        const word = offset => view().getUint32(offset, true);
        const quad = offset => view().getBigUint64(offset, true);
        function core_field(id, offset, size = 4)
        {
            if(cpu.active_core === id)
            {
                const data = new DataView(cpu.wasm_memory.buffer);
                return size === 1 ? data.getUint8(cpu.state_base + offset) : data.getUint32(cpu.state_base + offset, true);
            }
            const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
            assert.ok(index >= 0);
            const bytes = cpu.cores[id].saved[index];
            const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const local = offset - CORE_STATE_RANGES[index][0];
            return size === 1 ? data.getUint8(local) : data.getUint32(local, true);
        }
        async function until(phase, predicate)
        {
            const deadline = performance.now() + 60000;
            while(!predicate())
            {
                cpu.run_cores();
                rounds++;
                assert.equal(word(CONTROL + 32), 0, `${label} ${phase}: guest canary/TLB/MSR/vector failure`);
                if(performance.now() > deadline) throw new Error(`${label} ${phase}: timeout ${JSON.stringify(cpu.get_diagnostics())}`);
                await yield_event();
            }
        }
        await until("all four genuine long-mode APs at checkpoint", () => word(CONTROL + 16) === 4);
        assert.equal(quad(CONTROL), 4n * BigInt(ITERATIONS));
        assert.equal(quad(CONTROL + 8), BigInt.asUintN(64, ~quad(CONTROL)));
        for(let id = 0; id < 4; id++)
        {
            const at = RECORDS + id * 1024;
            if(id)
            {
                assert.equal(word(at) & 1, 0, `AP ${id}: reset real mode`);
                assert.equal(word(at + 4), 0x800, `AP ${id}: guest SIPI vector 8`);
            }
            assert.equal(quad(at + 8), 0xFFFF800000000000n + (BigInt(id) << 39n), `core ${id}: distinct full RIP alias`);
            assert.equal(quad(at + 24), 0xAABBCCDD00000000n + BigInt(id));
            assert.equal(word(at + 16), 0xA100 + id, `core ${id}: private mapping at common linear address`);
            assert.equal(core_field(id, STATE_OFFSETS.x64_cs_long, 1), 1);
            assert.equal(core_field(id, STATE_OFFSETS.x64_gpr_hi + 8 * 4), 0xAABBCCDD);
            assert.equal(core_field(id, STATE_OFFSETS.x64_gpr_ext_lo), id);
            const rip = BigInt(core_field(id, STATE_OFFSETS.instruction_pointer)) |
                BigInt(core_field(id, STATE_OFFSETS.x64_rip_hi)) << 32n;
            assert.equal(rip >> 39n, (0xFFFF800000000000n + (BigInt(id) << 39n)) >> 39n);
        }
        const snapshot = await emulator.save_state();
        async function finish()
        {
            view().setUint32(CONTROL + 20, 1, true); // documented guest release mailbox only
            await until("atomic contention completed", () => word(CONTROL + 24) === 4);
            await until("long-mode fixed, NMI and broadcast IPIs", () => word(CONTROL + 36) === 1);
            // Each core runs at its own alias HIGH + (id << 39).
            const alias = id => 0xFFFF800000000000n + (BigInt(id) << 39n);
            const idle = quad(RECORDS + 1024 + 384) - alias(1);
            assert.ok(idle > 0x100000n && idle < 0x110000n, "NMI return RIP is in the guest image");
            for(let id = 0; id < 4; id++)
            {
                const at = RECORDS + id * 1024;
                assert.equal(word(at + 56), id ? 2 : 0, `core ${id}: directed + all-excluding-self fixed IPI`);
                assert.equal(word(at + 60), id ? 1 : 0, `core ${id}: NMI IPI`);
                if(id) assert.equal(quad(at + 384), alias(id) + idle, `core ${id}: NMI interrupted the halted idle loop`);
            }
            assert.equal(quad(CONTROL), 8n * BigInt(ITERATIONS));
            assert.equal(quad(CONTROL + 8), BigInt.asUintN(64, ~quad(CONTROL)));
            for(let id = 0; id < 4; id++)
            {
                const at = RECORDS + id * 1024;
                assert.equal(word(at + 32), 0xA100 + id, `core ${id}: stale TLB survives core switch / snapshot`);
                assert.equal(word(at + 36), 0xB200 + id, `core ${id}: INVLPG sees private replacement`);
                assert.equal(word(at + 40), 0xAA000000 + id, `core ${id}: RDTSCP TSC_AUX`);
                assert.equal(word(at + 48), 0xD064, `core ${id}: finished`);
                assert.equal(word(at + 52), 0);
                assert.deepEqual(Buffer.from(cpu.mem8.slice(at + 256, at + 384)), Buffer.from(cpu.mem8.slice(at + 64, at + 192)), `core ${id}: all XMM8..15`);
            }
            return Buffer.from(cpu.mem8.slice(RECORDS, RECORDS + 4096));
        }
        const original = await finish();
        await emulator.restore_state(snapshot);
        assert.equal(word(CONTROL + 16), 4, "all checkpoint arrivals restored");
        assert.equal(word(CONTROL + 20), 0, "release flag restored");
        const restored = await finish();
        assert.deepEqual(restored, original, "snapshot replay has identical complete per-core results");
        if(mode === "interpreter") assert.deepEqual(native, [0, 0, 0, 0]);
        else assert.ok(native.every(count => count > 1000), `${label}: every core actually executed native i64 code: ${native}`);
        const result = {mode, seed, quantum, rounds, native, snapshot_bytes: snapshot.byteLength};
        console.log("PASS x64 four-core INIT/SIPI, state/TLB isolation, CX16, fixed/NMI/broadcast IPIs, snapshot " + JSON.stringify(result));
        return result;
    }
    catch(error)
    {
        if(cpu)
        {
            fs.writeFileSync(directory + "failure.json", JSON.stringify(cpu.get_diagnostics(), null, 2));
            fs.writeFileSync(directory + "failure-records.bin", Buffer.from(cpu.mem8.slice(RECORDS, RECORDS + 4096)));
        }
        throw error;
    }
    finally { await emulator.destroy(); }
}
const results = [];
for(const mode of modes) for(const seed of seeds) for(const quantum of quantums) results.push(await run(mode, seed, quantum));
fs.writeFileSync(directory + "results.json", JSON.stringify(results, null, 2) + "\n");
