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
//   node tests/a64/litmus.mjs [--qemu] [--cores 2,4] [--rounds N]
import assert from "node:assert/strict";
import { build, reference, actual } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const core_counts = option("--cores", "2,4").split(",").map(Number);
const rounds = +option("--rounds", 1000);
const directory = build("litmus", [new URL("litmus.c", import.meta.url).pathname], { cflags: [`-DROUNDS=${rounds}`] });

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
    const start = performance.now();
    check(`v86 cooperative, ${cores} cores`, await actual(directory, { cores, timeout: 600000 }));
    console.log(`  (${((performance.now() - start) / 1000).toFixed(1)} s)`);
    if(args.includes("--qemu")) check(`QEMU, ${cores} cores`, await reference(directory, { cores, timeout: 120000 }), true);
}
console.log("litmus: passed");
