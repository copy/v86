#!/usr/bin/env node
// Real Linux cross-core stress: fork/shared publication, signal delivery, migration,
// IDE sectors and NE2K frames while the whole machine is stopped and restored.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { setImmediate as set_immediate } from "node:timers";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { smp_modes, with_smp_mode, mode_hits } from "../lib/smp_modes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const module_url = new URL(process.env.V86_MODULE || (+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js"), import.meta.url);
const { V86 } = await import(module_url.href);
const mutation = process.env.SMP_OS_MUTATION || "";
assert.ok(["", "network-corruption"].includes(mutation));
const modes = smp_modes();
const seeds = process.env.SMP_SEEDS?.split(",").map(Number) || Array.from({ length: 10 }, (_, i) => i + 1);
const quantums = process.env.SMP_QUANTUMS?.split(",").map(Number) || [257, 4096];
const cores = +(process.env.CPU_CORES || 4);
const parallel = +process.env.PARALLEL;
const rounds = +(process.env.SMP_ROUNDS || 256);
const timeout_ms = +(process.env.SMP_TIMEOUT_MS || 180000);
const log_dir = process.env.C3_LOG_DIR;
const boot_cache = process.env.C3_BOOT_CACHE;
if(boot_cache) fs.mkdirSync(boot_cache, { recursive: true });
if(log_dir) fs.mkdirSync(log_dir, { recursive: true });
assert.ok(Number.isInteger(cores) && cores >= 2 && cores <= 8);
assert.ok(Number.isInteger(rounds) && rounds >= 16 && rounds <= 4096 && rounds % 8 === 0);
assert.ok(seeds.length && seeds.every(seed => Number.isInteger(seed) && seed >= 1 && seed <= 0xFFFFFFFF));
assert.ok(quantums.length && quantums.every(quantum => Number.isInteger(quantum) && quantum >= 1 && quantum <= 100000));
fs.mkdirSync(path.join(root, "build/smp"), { recursive: true });
function command(program, args)
{
    const result = spawnSync(program, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${program}: ${result.stderr || result.error}`);
    return result.stdout.trim();
}
const target = command("rustc", ["-vV"]).match(/host: (.+)/)[1];
const linker = process.env.LD_LLD || path.join(command("rustc", ["--print", "sysroot"]), "lib/rustlib", target, "bin/rust-lld");
command(process.env.CLANG || "clang", ["--target=i386-unknown-linux-gnu", "-m32", "-O2", "-ffreestanding", "-fno-stack-protector", "-fno-pic", "-fno-builtin", "-mno-sse", "-mno-mmx", "-c", path.join(root, "tests/smp/os_stress_guest.c"), "-o", path.join(root, "build/smp/os_stress_guest.o")]);
command(linker, ["-flavor", "gnu", "-m", "elf_i386", "-static", "-e", "_start", "-o", path.join(root, "build/smp/os_stress_guest"), path.join(root, "build/smp/os_stress_guest.o")]);
const guest = fs.readFileSync(path.join(root, "build/smp/os_stress_guest"));
const digest = data => create_hash("sha256").update(data).digest("hex");
const wasm_bytes = fs.readFileSync(process.env.WASM_PATH || path.join(root, +process.env.TEST_RELEASE_BUILD ? "build/v86.wasm" : "build/v86-debug.wasm"));
const wasm_module = await WebAssembly.compile(wasm_bytes);
const media = { javascript_entry: digest(fs.readFileSync(module_url)), wasm: digest(wasm_bytes), linux4: digest(fs.readFileSync(path.join(root, "images/linux4.iso"))), guest: digest(guest), disk_sha256: digest(new Uint8Array(4 << 20)), disk: "4 MiB zero-filled disposable IDE disk; writes at 1 MiB + (seed & 31) * 8192" };

for(const mode of modes)
{
    const disk = new Uint8Array(4 << 20);
    // PARALLEL=1: the application processors run in vCPU workers
    const emulator = new V86(with_smp_mode({ graphics_adapter: "bochs_vga", ...(parallel ? { wasm_path: path.join(root, "build/v86-parallel.wasm"), parallel: true } :
        { wasm_fn: async imports => (await WebAssembly.instantiate(wasm_module, imports)).exports }),
        bios: { url: path.join(root, "bios/seabios.bin") }, vga_bios: { url: path.join(root, "bios/vgabios.bin") },
        cdrom: { url: path.join(root, "images/linux4.iso") }, hda: { buffer: disk.buffer },
        memory_size: 128 << 20, cpu_cores: cores, acpi: true, cpu_schedule_seed: seeds[0],
        disable_jit: mode === "interpreter", experimental_smp_jit: mode !== "interpreter",
        ...(mode === "region" ? { ir_page_mode: false } : {}),
        ir_sync_publication: true, ir_region_budget: { hot_threshold: 8, promotion_threshold: 128 },
        filesystem: {}, net_device: { type: "ne2k" }, autostart: false, log_level: 0 }, mode, false));
    let serial = "", phase = "load", cpu, packets = 0, received = 0, poweroffs = 0, disk_reads = 0, disk_writes = 0;
    const started_ms = performance.now();
    const results = [];
    const frame_lengths = new Set();
    const per_core_jit = Array.from({ length: cores }, () => 0);
    emulator.add_listener("serial0-output-byte", byte => { const ch = String.fromCharCode(byte); serial += ch; if(+process.env.SHOW_LOGS) process.stdout.write(ch); });
    emulator.add_listener("acpi-power-off", () => poweroffs++);
    emulator.add_listener("ide-read-end", event => { if(event[0] === 0) disk_reads += event[1]; });
    emulator.add_listener("ide-write-end", event => { if(event[0] === 0) disk_writes += event[1]; });
    emulator.bus.register("net0-send", packet => {
        if(packet.length < 14 || packet[12] !== 0x88 || packet[13] !== 0xB5) return;
        packets++;
        frame_lengths.add(packet.length);
        if(+process.env.SHOW_LOGS) console.log(`C3_HOST_PACKET length=${packet.length} bytes=${Buffer.from(packet.subarray(0, 32)).toString("hex")}`);
        const reply = Uint8Array.from(packet);
        reply.fill(255, 0, 6); reply.set([2,0,0,0,0,2], 6);
        if(mutation === "network-corruption") reply[18] ^= 1;
        set_immediate(() => { received++; emulator.bus.send("net0-receive", reply); });
    });
    async function until(label, predicate)
    {
        phase = label;
        const deadline = performance.now() + timeout_ms;
        while(!predicate())
        {
            assert.ok(performance.now() < deadline, `${mode}: ${label} timed out`);
            assert.ok(!serial.includes("Kernel panic"), "kernel panic");
            assert.ok(!serial.includes("C3_FAIL"), serial.slice(-1000));
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }
    function summary(text, seed)
    {
        const record = text.match(new RegExp(`C3_DONE seed=${seed} rounds=(\\d+) cores=(\\d+) signals=(\\d+) io=(\\d+) cpu_checks=([\\d,]+)`));
        assert.ok(record, "guest completion record");
        assert.equal(+record[1], rounds); assert.equal(+record[2], cores); assert.ok(+record[3] > 0); assert.equal(+record[4], rounds / 8);
        const cpu_checks = record[5].split(",").map(Number);
        assert.equal(cpu_checks.length, cores); assert.ok(cpu_checks.every(value => value === rounds), "every core receives exactly one affinity/getcpu check per round");
        return { rounds: +record[1], cores: +record[2], io: +record[4], cpu_checks };
    }
    async function run_round(seed, quantum, snapshot)
    {
        const round_started_ms = performance.now();
        cpu.scheduler_seed = seed;
        cpu.scheduler_quantum = quantum;
        if(parallel) for(let core = 1; core < cores; core++) per_core_jit[core] = cpu.parallel.core_counters(core).jit;
        const begin = serial.length, net_before = packets, reads_before = disk_reads, writes_before = disk_writes, jit_before = per_core_jit.slice();
        emulator.serial0_send(`/tmp/c3-stress ${cores} ${seed} ${rounds}\n`);
        await until(`seed=${seed} quantum=${quantum} active`, () => serial.slice(begin).includes(`C3_ACTIVE seed=${seed}\r\n`));
        let saved;
        if(snapshot)
        {
            await emulator.stop();
            const stopped = cpu.get_machine_core_state();
            const clock = cpu.clock.get_state();
            saved = await emulator.save_state();
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.deepEqual(cpu.get_machine_core_state(), stopped, "stop freezes every core");
            assert.deepEqual(cpu.clock.get_state(), clock, "stop freezes machine time");
            emulator.run();
        }
        await until(`seed=${seed} quantum=${quantum} completion`, () => serial.slice(begin).includes(`C3_DONE seed=${seed} `));
        await until("shell after workload", () => /~% $/.test(serial));
        await emulator.stop();
        const first = summary(serial.slice(begin), seed);
        assert.ok(packets - net_before >= rounds / 8, "guest uses emulated NE2K transmit");
        assert.equal(received, packets, "every frame echoed through NE2K receive");
        assert.ok(disk_reads - reads_before >= rounds / 8 * 4096, "O_DIRECT reads reach IDE");
        assert.ok(disk_writes - writes_before >= rounds / 8 * 4096, "O_DIRECT writes reach IDE");
        if(saved)
        {
            await emulator.restore_state(saved);
            const replay_begin = serial.length;
            emulator.run();
            await until("snapshot replay", () => serial.slice(replay_begin).includes(`C3_DONE seed=${seed} `));
            await until("shell after replay", () => /~% $/.test(serial));
            await emulator.stop();
            assert.deepEqual(summary(serial.slice(replay_begin), seed), first, "restored OS processes preserve publication/migration/disk/network work");
        }
        if(parallel) for(let core = 1; core < cores; core++) per_core_jit[core] = cpu.parallel.core_counters(core).jit;
        const jit = per_core_jit.map((value, i) => value - jit_before[i]);
        if(mode === "interpreter") assert.ok(jit.every(value => value === 0));
        else assert.ok(jit.every(value => value > 0), "each core executes compiled code during workload");
        if(mode === "region") assert.equal(cpu.wm.exports.x64_page_stat(1), 0, "region arm does not execute the page tier");
        const record = { seed, quantum, wall_ms: Math.round(performance.now() - round_started_ms), snapshot: !!saved, ...first, packets: packets - net_before, disk_read_bytes: disk_reads - reads_before, disk_write_bytes: disk_writes - writes_before, jit };
        results.push(record);
        console.log(`${mode}: OS stress passed ${JSON.stringify(record)}`);
        emulator.run();
    }
    try
    {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("load timeout")), 15000);
            emulator.add_listener("emulator-loaded", () => { clearTimeout(timer); resolve(); });
            emulator.add_listener("emulator-error", reject);
        });
        cpu = emulator.v86.cpu;
        const e = cpu.wm.exports;
        if(mode === "region") assert.equal(e.ir_auto_set_page_mode(0), 1);
        const run_slice = cpu.run_cpu_slice.bind(cpu);
        const jit_count = () => mode_hits(e, mode);
        cpu.run_cpu_slice = budget => { const id = cpu.active_core, before = jit_count(); const r = run_slice(budget); per_core_jit[id] += (jit_count() - before) >>> 0; return r; };
        // (with vCPU workers the machine's own core runs through main_loop)
        const main_loop = cpu.main_loop.bind(cpu);
        cpu.main_loop = () => { const before = jit_count(); const r = main_loop(); per_core_jit[0] += (jit_count() - before) >>> 0; return r; };
        const cached = boot_cache && path.join(boot_cache, `linux4-${mode}-${cores}.bin`);
        if(cached && fs.existsSync(cached)) await emulator.restore_state(Uint8Array.from(fs.readFileSync(cached)).buffer);
        else
        {
            emulator.run();
            await until("boot", () => /~% $/.test(serial));
            await emulator.stop();
            if(cached) fs.writeFileSync(cached, new Uint8Array(await emulator.save_state()));
        }
        await emulator.create_file("c3-stress", guest);
        emulator.run();
        emulator.serial0_send("cp /mnt/c3-stress /tmp/c3-stress; chmod 755 /tmp/c3-stress; ifconfig eth0 up; echo C3_READY\n");
        await until("guest setup", () => serial.includes("C3_READY\r\n") && /~% $/.test(serial));
        for(const quantum of quantums) for(const seed of seeds) await run_round(seed, quantum, seed === seeds[0]);
        const reset_begin = serial.length;
        await emulator.restart();
        await until("whole machine reboot", () => serial.slice(reset_begin).includes("Files send via emulator") && /~% $/.test(serial));
        emulator.serial0_send("printf 'C3_REBOOT_ONLINE '; cat /sys/devices/system/cpu/online; poweroff -f\n");
        await until("guest ACPI S5", () => poweroffs > 0 && !emulator.is_running());
        assert.match(serial.slice(reset_begin), new RegExp(`C3_REBOOT_ONLINE 0-${cores - 1}`));
        assert.equal(cpu.clock.paused, true, "S5 pauses the machine clock");
        const powered_off = cpu.get_machine_core_state();
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.deepEqual(cpu.get_machine_core_state(), powered_off, "S5 leaves every core stopped");
        console.log(`${mode}: reboot re-onlines ${cores} cores and guest ACPI S5 stops the machine`);
    }
    catch(error)
    {
        const vga_text = cpu && Array.from({ length: 25 }, (_, row) => Array.from({ length: 80 }, (_, column) =>
            String.fromCharCode(cpu.mem8[0xB8000 + (row * 80 + column) * 2] || 32)).join("").trimEnd()).join("\n");
        console.error(JSON.stringify({ mode, phase, packets, received, serial_tail: serial.slice(-15000), vga_text, diagnostics: cpu?.get_diagnostics() }, null, 2));
        if(log_dir && cpu)
        {
            await emulator.stop();
            const failure_state = await emulator.save_state();
            fs.writeFileSync(path.join(log_dir, `os-stress-${mode}-failure.bin`), new Uint8Array(failure_state));
            cpu.switch_core(0);
            const ip = cpu.instruction_pointer[0] >>> 0;
            const physical = cpu.translate_address_system_read(ip);
            const instruction = { ip, physical, registers: [...cpu.reg32].map(value => value >>> 0),
                bytes: Buffer.from(cpu.mem8.subarray(physical, physical + 64)).toString("hex") };
            fs.writeFileSync(path.join(log_dir, `os-stress-${mode}-instruction.json`), JSON.stringify(instruction, null, 2) + "\n");
            if(+process.env.SMP_RECOVER_INTERPRETER)
            {
                await emulator.restore_state(failure_state);
                const budget = cpu.ir_region_budget;
                assert.equal(cpu.wm.exports.ir_auto_config(0, budget.hot_threshold, budget.promotion_threshold, budget.max_source_bytes, budget.execution_budget, budget.rep_iterations), 1);
                const recovery_begin = serial.length;
                emulator.run();
                const recovery_deadline = performance.now() + 30000;
                while(performance.now() < recovery_deadline && !/Files send via emulator[\s\S]*~% $/.test(serial.slice(recovery_begin)))
                    await new Promise(resolve => setTimeout(resolve, 20));
                await emulator.stop();
                const recovery = { reached_shell: /~% $/.test(serial.slice(recovery_begin)), serial: serial.slice(recovery_begin), diagnostics: cpu.get_diagnostics() };
                fs.writeFileSync(path.join(log_dir, `os-stress-${mode}-recovery.json`), JSON.stringify(recovery, null, 2) + "\n");
                console.log("interpreter recovery " + JSON.stringify(recovery));
            }
        }
        throw error;
    }
    finally
    {
        if(log_dir)
        {
            fs.writeFileSync(path.join(log_dir, `os-stress-${mode}.log`), serial);
            fs.writeFileSync(path.join(log_dir, `os-stress-${mode}.json`), JSON.stringify({ media, mode, cores, mutation, wall_ms: Math.round(performance.now() - started_ms), results, packets, received, frame_lengths: [...frame_lengths], poweroffs, disk_reads, disk_writes, per_core_jit }, null, 2) + "\n");
        }
        await emulator.destroy();
    }
}
