#!/usr/bin/env node
// Lifecycle of vCPU workers (docs/multicore.md):
// stop-the-world while every core runs the litmus kernel
// (tests/parallel/litmus.asm), snapshots taken mid-run and restored into
// another machine, destroy while running, a failing worker (an exception, a
// trap inside the machine's critical sections, a worker that exits) and the
// "auto" backend policy's fallback.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PARALLEL_WASM, ROOT } from "./guest.mjs";
import { with_jit_switches } from "../lib/jit_switches.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const kernel = ROOT + "build/parallel-litmus.bin";
const assembled = spawnSync("nasm", ["-f", "bin", "-o", kernel, ROOT + "tests/parallel/litmus.asm"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);

const CONTROL = 0x380000;
const CORES = +process.env.CPU_CORES || 4;
const JIT = !+process.env.DISABLE_JIT;

async function machine(rounds, options = {})
{
    const emulator = new V86(with_jit_switches({
        graphics_adapter: "bochs_vga",
        multiboot: { url: kernel }, memory_size: 32 << 20, acpi: true, cpu_cores: CORES,
        disable_jit: !JIT, experimental_smp_jit: JIT, ir_sync_publication: true,
        parallel: true, wasm_path: PARALLEL_WASM, autostart: false, log_level: 0, ...options,
    }));
    const errors = [];
    emulator.add_listener("emulator-error", error => errors.push(error));
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    const cpu = emulator.v86.cpu;
    const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    view().setUint32(CONTROL, CORES, true);
    view().setUint32(CONTROL + 4, rounds, true);
    return { emulator, cpu, view, errors, u32: offset => view().getUint32(CONTROL + offset, true) };
}

function check_results(m, rounds, label)
{
    const expected = CORES * rounds;
    assert.deepEqual([16, 20, 24, 28, 32, 40].map(m.u32), [expected, 2 * expected, expected, expected, expected, expected],
        label + ": atomic counters");
    for(let phase = 1; phase < 5; phase++) assert.equal(m.u32(64 + 4 * phase), 0, label + ": errors in phase " + phase);
    assert.deepEqual(Array.from({ length: CORES }, (_, core) => m.u32(0x180 + 4 * core)), Array(CORES).fill(rounds),
        label + ": IPIs per core");
}

async function until_finished(m, label, timeout = 300000)
{
    const deadline = performance.now() + timeout;
    while(m.u32(128) !== CORES)
    {
        if(performance.now() > deadline)
        {
            throw new Error(label + ": not finished: " + JSON.stringify(m.cpu.get_diagnostics().parallel));
        }
        await delay(10);
    }
}

// 1. stop-the-world under load: the cores stop mid-phase (in barriers, spin
//    locks, HLT waiting for an IPI) and go on; one stop also saves a snapshot
{
    const rounds = 20000;
    const m = await machine(rounds);
    m.emulator.run();
    let stops = 0, snapshot = null;
    while(m.u32(128) !== CORES && stops < 400)
    {
        await delay(1 + Math.random() * 8);
        await m.emulator.stop();
        const status = m.cpu.get_diagnostics().parallel;
        for(const core of status.cores)
        {
            // parked, or never started (finished cores halt with interrupts off, still parked)
            assert.ok(core.status === "parked", `stop ${stops}: vCPU ${core.core} is ${core.status}`);
        }
        if(stops === 20) snapshot = await m.emulator.save_state();
        stops++;
        m.emulator.run();
    }
    await until_finished(m, "stops");
    check_results(m, rounds, "stops");
    assert.ok(snapshot, "a snapshot was taken mid-run");
    await m.emulator.destroy();
    console.log(`stop-the-world: ${stops} stops while running, results exact`);

    // 2. the snapshot continues in another machine
    const restored = await machine(rounds);
    await restored.emulator.restore_state(snapshot);
    assert.notEqual(restored.u32(128), CORES, "the snapshot was taken before the end");
    restored.emulator.run();
    await until_finished(restored, "restored");
    check_results(restored, rounds, "restored");
    await restored.emulator.destroy();
    console.log("snapshot taken mid-run finishes exactly in another machine");
}

// 3. destroy while every core runs: no worker executes afterwards
{
    const m = await machine(1000000);
    m.emulator.run();
    await delay(200);
    const steps = () => m.cpu.parallel.status().cores.map(core => core.steps);
    assert.ok(steps().every(n => n > 0), "the vCPUs ran");
    await m.emulator.destroy();
    const after = steps();
    await delay(300);
    assert.deepEqual(steps(), after, "no vCPU runs after destroy");
    console.log("destroy stops every vCPU");
}

// 4. a failing vCPU stops the machine with "emulator-error"; the machine's
//    thread does not hang on a lock the failed core held
for(const kind of ["throw", "trap", "exit"])
{
    const m = await machine(1000000, { parallel_fault: { core: CORES - 1, after_slices: 20, kind } });
    m.emulator.run();
    const deadline = performance.now() + 20000;
    while(!m.errors.length)
    {
        assert.ok(performance.now() < deadline, kind + ": no emulator-error");
        await delay(10);
    }
    assert.match(String(m.errors[0].message || m.errors[0]), kind === "exit" ? /exited/ : /vCPU \d failed/);
    assert.equal(m.emulator.is_running(), false, kind + ": the machine stopped");
    // the IOAPIC's lock (held by the trapping core) is free: this takes it
    m.cpu.wm.exports["get_ioapic_addr"]();
    const status = m.cpu.get_diagnostics().parallel;
    assert.ok(status.failure, kind + ": diagnostics name the failure");
    assert.equal(status.cores[CORES - 2].status, "failed");
    m.emulator.run();
    await delay(50);
    assert.equal(m.emulator.is_running(), false, kind + ": a failed machine does not run again");
    await assert.rejects(m.emulator.save_state(), kind + ": no snapshot of a failed machine");
    await m.emulator.destroy();
    console.log(`failing vCPU (${kind}): machine stopped, error reported, locks released`);
}

// 5. "auto" keeps the requested cores cooperative where parallel execution
//    is unavailable (here: a CPU core that is not v86-parallel.wasm)
{
    const rounds = 500;
    const m = await machine(rounds, { parallel: "auto", wasm_path: ROOT + "build/v86.wasm" });
    const execution = m.cpu.get_diagnostics().execution;
    assert.deepEqual(execution, { mode: "cooperative", fallback: "v86-parallel.wasm unavailable" });
    m.emulator.run();
    await until_finished(m, "auto fallback");
    check_results(m, rounds, "auto fallback");
    await m.emulator.destroy();
    const forced = new V86({ graphics_adapter: "bochs_vga", multiboot: { url: kernel }, memory_size: 32 << 20, acpi: true, cpu_cores: CORES,
        parallel: true, wasm_path: ROOT + "build/v86.wasm", autostart: false, log_level: 0 });
    const error = await new Promise(resolve => {
        forced.add_listener("emulator-error", resolve);
        forced.add_listener("emulator-loaded", () => resolve(null));
    });
    assert.match(String(error?.message), /not v86-parallel\.wasm/, "forced parallel fails without the parallel build");
    await forced.destroy();
    const auto = await machine(rounds, { parallel: "auto" });
    assert.deepEqual(auto.cpu.get_diagnostics().execution, { mode: "parallel", fallback: null });
    await auto.emulator.destroy();
    console.log("auto policy: parallel where possible, cooperative fallback with a reason");
}

console.log("parallel lifecycle tests passed");
