#!/usr/bin/env node
// Litmus tests (tests/parallel/litmus.asm) on cooperative cores (the
// reference) and on cores in vCPU workers that run at the same time:
// atomic counters and spin locks (also locked operations of different widths
// on the same bytes), message passing, store buffering with
// MFENCE, cross-modifying code, IPI wake-ups of halted cores and concurrent
// accessed/dirty updates; then (LITMUS_LONG_MODE, default 1) every core
// enters 64-bit mode for LOCK CMPXCHG16B against LOCK ADD on the same qword,
// and 32-bit compatibility mode (WOW64's) for locked dword counters, which
// the JIT modes compile in the page tier (x64_page_compat32, P7.2).
//
// LITMUS_MODES: comma-separated from cooperative, cooperative-jit, parallel,
// parallel-jit (default: all but parallel-jit), and a64-cooperative (the
// A64 litmus tests on the ARM core's cooperative cores, tests/a64/litmus.mjs);
// LITMUS_CORES (default 2,4); LITMUS_ROUNDS (default 2000).
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PARALLEL_WASM, ROOT } from "./guest.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const kernel = ROOT + "build/parallel-litmus.bin";
const assembled = spawnSync("nasm", ["-f", "bin", "-o", kernel, ROOT + "tests/parallel/litmus.asm"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);

const CONTROL = 0x380000;
const modes = (process.env.LITMUS_MODES || "cooperative,cooperative-jit,parallel").split(",");
const core_counts = (process.env.LITMUS_CORES || "2,4").split(",").map(Number);
const rounds = +process.env.LITMUS_ROUNDS || 2000;
const long_mode = process.env.LITMUS_LONG_MODE !== "0";
const PHASES = ["", "message passing", "store buffering", "cross-modifying code", "accessed/dirty bits"];
const IPI_COUNT = 0x180;

async function run(mode, cores)
{
    const parallel = mode.startsWith("parallel");
    const jit = mode.endsWith("-jit");
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        multiboot: { url: kernel }, memory_size: 32 << 20, acpi: true, cpu_cores: cores,
        disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true, cpu_type: long_mode ? "x86_64" : "x86",
        ...(jit ? { jit_switches: { x64_page_compat32: 1 } } : {}),
        ...(parallel ? { parallel: true, wasm_path: PARALLEL_WASM } : {}),
        autostart: false, log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const cpu = emulator.v86.cpu;
    const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    view().setUint32(CONTROL, cores, true);
    view().setUint32(CONTROL + 4, rounds, true);
    view().setUint32(CONTROL + 0x340, long_mode ? 1 : 0, true);
    const t0 = performance.now();
    emulator.run();
    const deadline = t0 + 300000;
    while(view().getUint32(CONTROL + 128, true) !== cores)
    {
        if(performance.now() > deadline)
        {
            const d = cpu.get_diagnostics();
            throw new Error(`${mode} ${cores} cores: not finished, ${view().getUint32(CONTROL + 128, true)} done: ` +
                JSON.stringify({ cores: d.cores.map(c => [c.state, c.linear_ip]), parallel: d.parallel }));
        }
        await delay(20);
    }
    const ms = performance.now() - t0;
    const u32 = offset => view().getUint32(CONTROL + offset, true);
    const u16 = offset => view().getUint16(CONTROL + offset, true);
    const expected = cores * rounds;
    // mixed widths: every dword and word add increments the low word, which
    // wraps once 2 * expected reaches 2^16; the upper word only takes the
    // carries of the wraps a dword add made (a word add drops its carry), so
    // it is at most the number of wraps
    const mixed_carries = u16(0x304);
    const mixed_wraps = Math.floor(2 * expected / 0x10000);
    const counters = { inc: u32(16), xadd: u32(20), cmpxchg: u32(24), xchg_lock: u32(28), bts_lock: u32(32),
        cmpxchg8b: u32(40) + u32(44) * 2 ** 32, mixed_widths: u16(0x302),
        ...(long_mode ? { cmpxchg16b_low: u32(0x320) + u32(0x324) * 2 ** 32, cmpxchg16b_high: u32(0x328) + u32(0x32C) * 2 ** 32,
            compat_xadd: u32(0x350), compat_cmpxchg: u32(0x354), compat_inc: u32(0x358) } : {}) };
    const errors = PHASES.map((_, i) => u32(64 + 4 * i));
    const ipis = Array.from({ length: cores }, (_, core) => u32(IPI_COUNT + 4 * core));
    const steps = cpu.get_diagnostics().parallel?.cores.map(c => c.steps + (jit ? " (" + c.jit + " compiled entries)" : ""));
    // (cores on this thread: their compatibility-mode functions)
    const compat_compiles = jit && !parallel ? cpu.wm.exports.x64_page_stat(36) : null;
    await emulator.destroy();
    if(long_mode && compat_compiles !== null) assert.ok(compat_compiles > 0, `${mode} ${cores} cores: the page tier compiled the compatibility-mode loop`);
    assert.deepEqual(counters, { inc: expected, xadd: 2 * expected, cmpxchg: expected, xchg_lock: expected,
        bts_lock: expected, cmpxchg8b: expected, mixed_widths: 2 * expected % 0x10000,
        ...(long_mode ? { cmpxchg16b_low: 2 * expected, cmpxchg16b_high: expected,
            compat_xadd: expected, compat_cmpxchg: 3 * expected, compat_inc: expected } : {}) }, `${mode} ${cores} cores: atomic counters`);
    assert.ok(mixed_carries <= mixed_wraps,
        `${mode} ${cores} cores: mixed widths: ${mixed_carries} carries into the upper word, but the low word wrapped ${mixed_wraps} times`);
    errors.forEach((count, i) => i && assert.equal(count, 0, `${mode} ${cores} cores: ${PHASES[i]}: ${count} violations`));
    assert.deepEqual(ipis, Array(cores).fill(rounds), `${mode} ${cores} cores: IPIs received per core`);
    console.log(`${mode} ${cores} cores: ${rounds} rounds passed in ${(ms / 1000).toFixed(1)}s` +
        (steps ? `, worker steps ${steps.join("/")}` : "") + (compat_compiles ? `, ${compat_compiles} compatibility-mode compiles` : ""));
}

for(const cores of core_counts)
{
    for(const mode of modes)
    {
        if(mode === "a64-cooperative")
        {
            // (the ARM core's own litmus guest and checks, tests/a64/litmus.mjs)
            const a64 = spawnSync("node", [ROOT + "tests/a64/litmus.mjs", "--cores", String(cores), "--rounds", String(rounds)],
                { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
            assert.equal(a64.status, 0, `a64-cooperative ${cores} cores:\n${a64.stdout}`);
            console.log(a64.stdout.trim());
            continue;
        }
        await run(mode, cores);
    }
}
console.log("litmus tests passed");
