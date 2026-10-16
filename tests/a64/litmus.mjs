#!/usr/bin/env node
// The A64 litmus tests (tests/a64/litmus.c; docs/arm64-virt-android16-plan.md
// P3.9) on v86's cooperative cores, and with --qemu on the fixed reference
// too: every forbidden outcome must count 0 (the cooperative cores run one
// at a time, so their accesses are sequentially consistent and the weak
// outcomes do not occur at all; only the forbidden ones are judged), the
// LDXR/STXR counter must be exact, every store-exclusive after another
// core's store must fail, no core may read through a stale translation
// after TLBI VAE1IS, and the SGI and WFE/SEV rings must go round. (QEMU's
// store-exclusive compares values, so on the reference a store of the same
// value does not make it fail: that line is only reported there, as
// tests/a64/linux_probe.c's excl_aba is.)
//
// LITMUS_MODES (P8.4): comma-separated from cooperative, cooperative-jit
// (the A64 page tier), parallel and parallel-jit (cores 1 and up in vCPU
// workers, v86-arm64-parallel.wasm: their accesses really interleave, so
// weak outcomes may occur; the store-exclusive compares values there, as on
// the reference, so exclusive-cleared is only reported); default cooperative.
//
//   node tests/a64/litmus.mjs [--qemu] [--cores 2,4] [--rounds N]
import assert from "node:assert/strict";
import { build, reference, actual, root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const core_counts = option("--cores", "2,4").split(",").map(Number);
const rounds = +option("--rounds", 1000);
const directory = build("litmus", [new URL("litmus.c", import.meta.url).pathname], { cflags: [`-DROUNDS=${rounds}`] });
const modes = (process.env.LITMUS_MODES || "cooperative").split(",");
const MODE_OPTIONS = {
    "cooperative": {},
    "cooperative-jit": { jit_switches: { a64_page: 1 }, ir_sync_publication: true },
    "parallel": { parallel: true, parallel_wasm_path: root + "build/v86-arm64-parallel.wasm" },
    "parallel-jit": { parallel: true, parallel_wasm_path: root + "build/v86-arm64-parallel.wasm", jit_switches: { a64_page: 1 } },
};
for(const mode of modes) assert.ok(MODE_OPTIONS[mode], "LITMUS_MODES: " + mode);

function check(label, result, reference = false)
{
    assert.equal(result.status, "ok", `${label}: ${result.status}\n${result.text}`);
    const lines = result.text.trim().split("\n");
    const field = (line, key) => +line.match(new RegExp(`\\b${key}=(\\d+)`))[1];
    for(const line of lines)
    {
        if(/forbidden=/.test(line)) assert.equal(field(line, "forbidden"), 0, `${label}: ${line}`);
        if(/expected=/.test(line) && !(reference && /^exclusive-cleared/.test(line)))
        {
            const key = line.match(/ (\w+)=\d+ expected=/)[1];
            assert.equal(field(line, key), field(line, "expected"), `${label}: ${line}`);
        }
        if(/stale=/.test(line)) assert.equal(field(line, "stale"), 0, `${label}: ${line}`);
    }
    console.log(`${label}:\n  ${lines.join("\n  ")}`);
}

for(const cores of core_counts)
{
    for(const mode of modes)
    {
        const start = performance.now();
        check(`v86 ${mode}, ${cores} cores`, await actual(directory, { cores, timeout: 600000, options: MODE_OPTIONS[mode] }),
            mode.startsWith("parallel"));
        console.log(`  (${((performance.now() - start) / 1000).toFixed(1)} s)`);
    }
    if(args.includes("--qemu")) check(`QEMU, ${cores} cores`, await reference(directory, { cores, timeout: 120000 }), true);
}
console.log("litmus: passed");
