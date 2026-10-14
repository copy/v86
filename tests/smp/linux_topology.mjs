#!/usr/bin/env node

// Topology OS acceptance: unmodified 32-bit Linux 4.16 SMP from images/linux4.iso.
// Firmware starts APs, Linux brings them online, sysfs reports one package,
// and concurrent ELF32 processes bind to every CPU and complete real work.
// No host writes to CPU contexts or firmware counts occur in this test.
import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";
import { with_smp_mode } from "../lib/smp_modes.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const local = path => url.fileURLToPath(new URL(path, import.meta.url));
const affinity_probe = fs.readFileSync(local("../../build/smp/affinity_probe"));
const TIMEOUT_MS = 120000;
// (tests/lib/smp_modes.mjs)
const jit_mode = process.env.SMP_JIT_MODE || "interpreter";
assert.ok(["interpreter", "region", "pages"].includes(jit_mode), "SMP_JIT_MODE must be interpreter, region or pages");
const counts = process.env.CPU_COUNTS ? process.env.CPU_COUNTS.split(",").map(Number) : [1, 2, 3, 4, 8];
assert.ok(counts.every(count => Number.isInteger(count) && count >= 1 && count <= 8));
const transcript_directory = process.env.C2_LOG_DIR;
if(transcript_directory) fs.mkdirSync(transcript_directory, { recursive: true });

// The bundled SeaBIOS config disables SMBIOS. If a replacement BIOS emits
// Type 4, it must still describe one socket with N cores and N threads.
function check_smbios(cpu, count)
{
    const memory = cpu.mem8;
    const view = new DataView(memory.buffer, memory.byteOffset);
    const text = (address, length) => String.fromCharCode(...memory.subarray(address, address + length));
    for(let address = 0xF0000; address < 0x100000; address += 16)
    {
        if(text(address, 4) !== "_SM_") continue;
        const entry_length = memory[address + 5];
        assert.equal(memory.subarray(address, address + entry_length).reduce((sum, byte) => sum + byte, 0) & 255, 0, "SMBIOS entry checksum");
        const start = view.getUint32(address + 0x18, true);
        const end = start + view.getUint16(address + 0x16, true);
        assert.ok(end <= memory.length, "SMBIOS table in RAM");
        let packages = 0;
        for(let position = start; position < end;)
        {
            const type = memory[position];
            const length = memory[position + 1];
            assert.ok(length >= 4 && position + length <= end, "bounded SMBIOS structure");
            if(type === 4)
            {
                packages++;
                assert.ok(length >= 0x28, "SMBIOS Type 4 includes core/thread counts");
                assert.equal(memory[position + 0x23], count, "SMBIOS core count");
                assert.equal(memory[position + 0x24], count, "SMBIOS enabled core count");
                assert.equal(memory[position + 0x25], count, "SMBIOS thread count");
            }
            position += length;
            while(position + 1 < end && (memory[position] !== 0 || memory[position + 1] !== 0)) position++;
            position += 2;
            if(type === 127) break;
        }
        assert.equal(packages, 1, "SMBIOS describes one processor package");
        return "one package";
    }
    return "not emitted";
}

async function test(count)
{
    const emulator = new V86(with_smp_mode({
        graphics_adapter: "bochs_vga",
        wasm_path: process.env.WASM_PATH,
        bios: { url: local("../../bios/seabios.bin") },
        vga_bios: { url: local("../../bios/vgabios.bin") },
        cdrom: { url: local("../../images/linux4.iso") },
        memory_size: 128 << 20,
        cpu_cores: count,
        acpi: true,
        disable_jit: jit_mode === "interpreter",
        experimental_smp_jit: jit_mode !== "interpreter",
        ir_sync_publication: true,
        ir_region_budget: { hot_threshold: 8, promotion_threshold: 128 },
        autostart: false,
        filesystem: {},
        log_level: 0,
    }, jit_mode, false));
    let serial = "";
    let cpu;
    let timeout;
    let phase = "load";
    let rounds = 0;
    let summary;
    const per_core_jit = Array.from({ length: count }, () => ({ region: 0, pages: 0 }));
    const jit_counts = () => ({
        region: cpu.wm.exports.ir_cache_stat(2) >>> 0,
        // (instructions the page tier ran natively)
        pages: cpu.wm.exports.x64_page_stat(1) >>> 0,
    });
    emulator.add_listener("serial0-output-byte", byte => {
        const character = String.fromCharCode(byte);
        serial += character;
        if(+process.env.SHOW_LOGS) process.stdout.write(character);
    });

    async function run_until(label, predicate)
    {
        phase = label;
        const deadline = performance.now() + TIMEOUT_MS;
        while(!predicate())
        {
            assert.ok(performance.now() < deadline, `${count} CPUs: ${label} timed out`);
            assert.ok(!serial.includes("Kernel panic"), "Linux kernel panic");
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    try
    {
        await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("emulator load timed out")), 15000);
            emulator.add_listener("emulator-loaded", resolve);
            emulator.add_listener("emulator-error", reject);
        });
        clearTimeout(timeout);
        cpu = emulator.v86.cpu;
        const run_cores = cpu.run_cores.bind(cpu);
        cpu.run_cores = () => { rounds++; return run_cores(); };
        if(jit_mode !== "interpreter")
        {
            if(jit_mode === "region") assert.equal(cpu.wm.exports.ir_auto_set_page_mode(0), 1);
            // Counter deltas are attributed at scheduler boundaries, without
            // changing dispatch, memory or CPU state. Single-core normal mode
            // uses main_loop; multicore uses run_cpu_slice.
            const method = count === 1 ? "main_loop" : "run_cpu_slice";
            const execute = cpu[method].bind(cpu);
            cpu[method] = (...args) => {
                const core = cpu.active_core;
                const before = jit_counts();
                const result = execute(...args);
                const after = jit_counts();
                per_core_jit[core].region += (after.region - before.region) >>> 0;
                per_core_jit[core].pages += (after.pages - before.pages) >>> 0;
                return result;
            };
        }
        await emulator.create_file("c2-affinity", affinity_probe);
        const script = `
set -eu
printf 'C2_KERNEL '; uname -a
printf 'C2_ONLINE '; cat /sys/devices/system/cpu/online
for d in /sys/devices/system/cpu/cpu[0-9]*; do
    id=\${d##*cpu}
    printf 'C2_TOPOLOGY id=%s package=%s core=%s threads=%s package_cpus=%s\\n' "$id" "$(cat "$d/topology/physical_package_id")" "$(cat "$d/topology/core_id")" "$(cat "$d/topology/thread_siblings_list")" "$(cat "$d/topology/core_siblings_list")"
done
cp /mnt/c2-affinity /tmp/c2-affinity
chmod 755 /tmp/c2-affinity
for id in ${Array.from({ length: count }, (_, id) => id).join(" ")}; do
    /tmp/c2-affinity "$id" &
done
wait
echo C2_DONE
`;
        await emulator.create_file("c2-topology.sh", Buffer.from(script));
        const boot_started = performance.now();
        emulator.run();
        await run_until("boot to shell", () => /~% $/.test(serial));
        const boot_wall_ms = Math.round(performance.now() - boot_started);
        const boot_jit = per_core_jit.map(counters => ({ ...counters }));
        emulator.serial0_send("sh /mnt/c2-topology.sh\n");
        await run_until("topology and affinity progress", () => serial.includes("C2_DONE\r\n") || serial.includes("C2_DONE\n"));
        await emulator.stop();
        assert.ok(!serial.includes("C2_AFFINITY_FAIL"), "affinity/getcpu/progress fixture failed");
        assert.match(serial, /C2_KERNEL Linux [^\r\n]*SMP/, "kernel was built with SMP");
        const expected_list = count === 1 ? "0" : `0-${count - 1}`;
        assert.equal(serial.match(/C2_ONLINE ([^\r\n]+)/)?.[1], expected_list, "every configured CPU is online");
        const topology = [...serial.matchAll(/C2_TOPOLOGY id=(\d+) package=(-?\d+) core=(-?\d+) threads=([^ ]+) package_cpus=([^\r\n]+)/g)];
        assert.equal(topology.length, count, "one topology record per configured CPU");
        const seen = new Set();
        for(const [, id_text, package_id, core_id, threads, package_cpus] of topology)
        {
            const id = +id_text;
            assert.ok(id < count && !seen.has(id), "unique valid CPU ID");
            seen.add(id);
            assert.equal(+package_id, 0, `CPU ${id}: one physical package`);
            assert.equal(+core_id, id, `CPU ${id}: distinct physical core`);
            assert.equal(threads, id_text, `CPU ${id}: one thread per core`);
            assert.equal(package_cpus, expected_list, `CPU ${id}: package membership`);
        }
        const progress = [...serial.matchAll(/C2_PROGRESS id=(\d+) cpu=(\d+) iterations=(\d+)/g)];
        assert.equal(progress.length, count, "each bound process completed work");
        assert.deepEqual(progress.map(match => +match[1]).sort((a, b) => a - b), [...seen].sort((a, b) => a - b));
        for(const [, id, actual_cpu, iterations] of progress)
        {
            assert.equal(actual_cpu, id, "getcpu agrees with sched_setaffinity before/after progress");
            assert.equal(+iterations, 100000, "bound arithmetic work completed and checksum matched");
        }
        const smbios = check_smbios(cpu, count);
        const hits = jit_counts();
        const workload_jit = per_core_jit.map((counters, id) => ({
            region: counters.region - boot_jit[id].region,
            pages: counters.pages - boot_jit[id].pages,
        }));
        if(jit_mode === "interpreter") assert.deepEqual(hits, { region: 0, pages: 0 }, "interpreter reference executed no compiled code");
        else
        {
            assert.ok(hits[jit_mode] > 0, `${jit_mode} compiled code actually executed`);
            if(jit_mode === "region") assert.equal(hits.pages, 0, "region arm did not execute the page tier");
            for(let id = 0; id < count; id++)
            {
                assert.ok(per_core_jit[id][jit_mode] > 0, `CPU ${id}: ${jit_mode} activations`);
                assert.ok(workload_jit[id][jit_mode] > 0, `CPU ${id}: ${jit_mode} ran after boot during the affinity workload`);
            }
        }
        summary = { count, jit_mode, rounds, boot_wall_ms, total_wall_ms: Math.round(performance.now() - boot_started),
            smbios, hits, per_core_jit, workload_jit };
        console.log(`${jit_mode} ${count} CPUs: Linux topology and bound progress passed ${JSON.stringify(summary)}`);
    }
    catch(error)
    {
        const vga_text = cpu && Array.from({ length: 25 }, (_, row) =>
            Array.from({ length: 80 }, (_, column) => String.fromCharCode(cpu.mem8[0xB8000 + (row * 80 + column) * 2] || 32)).join("").trimEnd()).join("\n");
        console.error(JSON.stringify({ count, jit_mode, phase, rounds, per_core_jit, serial_tail: serial.slice(-20000), vga_text, diagnostics: cpu?.get_diagnostics() }, null, 2));
        throw error;
    }
    finally
    {
        if(transcript_directory)
        {
            fs.writeFileSync(`${transcript_directory}/linux4-${count}cpu.log`, serial);
            if(summary) fs.writeFileSync(`${transcript_directory}/linux4-${count}cpu.json`, JSON.stringify(summary, null, 2) + "\n");
        }
        clearTimeout(timeout);
        await emulator.destroy();
    }
}

for(const count of counts) await test(count);
