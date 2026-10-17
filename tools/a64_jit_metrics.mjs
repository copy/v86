#!/usr/bin/env node
// The A64 page tier's Alpine metrics (docs/jit-unification-plan.md P6.6b,
// docs/arm64-virt-android16-plan.md P6 "验收（A4）", measured as P0.9 says):
// Alpine's initramfs stage with the probe (tests/a64/linux_boot.mjs) on 1, 2
// and 4 cores, interpreted and with the page tier, each the median of
// --sessions runs (3). Per configuration: probe_done_ms, the whole run's ms,
// MIPS, and with the page tier the compiles, compile time, evictions, the
// fewest free table slots, the share of instructions run natively, the
// page tier's steps per instruction, and the share of activations that
// chained into another page's function.
//
// Writes build/a64-linux/metrics.json and prints a Markdown table
// (docs/aarch64.md). Measure on a quiet machine. --stages initramfs,live
// adds the live stage (boot_to_login_ms, P6.6b); --baseline FILE also writes
// the medians with the build's `git describe`, the frozen Alpine baseline of
// P9.4 (tests/a64/perf-baseline.json).
//
// Usage: tools/a64_jit_metrics.mjs [--sessions N] [--cores 1,2,4] [--modes interpreter,jit]
//   [--stages initramfs,live] [--baseline FILE]   (TEST_RELEASE_BUILD=1: the release build)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sessions = +option("--sessions", 3);
const core_counts = option("--cores", "1,2,4").split(",").map(Number);
const modes = option("--modes", "interpreter,jit").split(",");
const stages = option("--stages", "initramfs").split(",");
const baseline = option("--baseline", undefined);

const median = values => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

function run(mode, cores, stage)
{
    const env = { ...process.env, A64_STAGE: stage, A64_CORES: String(cores) };
    delete env.A64_JIT;
    if(mode === "jit") env.A64_JIT = "1";
    const r = spawnSync("node", ["tests/a64/linux_boot.mjs"], { cwd: ROOT, env, encoding: "utf8", maxBuffer: 1 << 28 });
    const line = r.stdout.split("\n").find(l => l.startsWith("{\"tag\""));
    if(r.status !== 0 || !line) throw new Error(`${stage} ${mode} ${cores}c: status ${r.status}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
    const result = JSON.parse(line);
    const t = result.page_tier;
    return {
        ...(stage === "live" ? { boot_to_login_ms: result.boot_to_login_ms } : {}),
        probe_done_ms: result.probe_done_ms,
        ms: result.ms,
        mips: result.mips,
        ...(t ? {
            compiles: t.compiled,
            compile_ms: Math.round(t.compile_ms),
            evictions: t.evictions,
            table_free_low: t.table_free_low,
            native_share: t.retired / result.retired_instructions,
            steps_per_instruction: t.steps / result.retired_instructions,
            chained_share: t.activations ? t.chained / t.activations : 0,
        } : {}),
    };
}

const results = {};
for(const stage of stages)
{
    for(const cores of core_counts)
    {
        for(const mode of modes)
        {
            const runs = [];
            for(let i = 0; i < sessions; i++)
            {
                const r = run(mode, cores, stage);
                console.error(`${stage} ${mode} ${cores}c session ${i + 1}: ${JSON.stringify(r)}`);
                runs.push(r);
            }
            const summary = Object.fromEntries(Object.keys(runs[0]).map(k => [k, median(runs.map(r => r[k]))]));
            results[`${stage === "initramfs" ? "" : stage + "-"}${mode}-${cores}c`] = { median: summary, runs };
        }
    }
}

const out = path.join(ROOT, "build/a64-linux/metrics.json");
fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), sessions, results }, null, 2) + "\n");
if(baseline)
{
    const describe = spawnSync("git", ["-C", ROOT, "describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.resolve(baseline), JSON.stringify({
        about: "The frozen Alpine performance baseline (docs/arm64-virt-android16-plan.md P9.4): tools/a64_jit_metrics.mjs's medians",
        build: describe, release_build: !!+process.env.TEST_RELEASE_BUILD, date: new Date().toISOString().slice(0, 10), sessions,
        results: Object.fromEntries(Object.entries(results).map(([name, r]) => [name, r.median])),
    }, null, 2) + "\n");
}

const pct = x => x === undefined ? "–" : (100 * x).toFixed(x < 0.01 ? 2 : 1) + "%";
const n = x => x === undefined ? "–" : String(x);
console.log("| Configuration | boot_to_login_ms | probe_done_ms | run ms | MIPS | compiles | compile ms | evictions | fewest free slots | native | steps/instr. | chained activations |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for(const [name, { median: m }] of Object.entries(results))
{
    console.log(`| ${name} | ${n(m.boot_to_login_ms)} | ${m.probe_done_ms} | ${m.ms} | ${m.mips} | ${n(m.compiles)} | ${n(m.compile_ms)} | ${n(m.evictions)} | ${n(m.table_free_low)} | ` +
        `${pct(m.native_share)} | ${m.steps_per_instruction === undefined ? "–" : m.steps_per_instruction.toExponential(1)} | ${pct(m.chained_share)} |`);
}
console.log(`(medians of ${sessions} sessions; ${out})`);
