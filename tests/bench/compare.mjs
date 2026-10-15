#!/usr/bin/env node
// Compares two configurations of one core (docs/jit-unification-plan.md P0.8):
// N sessions of tests/bench/run.mjs, each with the arm under test (the JIT
// switches of --switches-a) and the baseline arm (--switches-b) on the same
// core, the runner alternating the arms' order within each benchmark; then
// tests/bench/gate.mjs judges the sessions. With --aa both arms run
// --switches-a, which measures the noise a gate has to stay clear of.
//
// Usage: tests/bench/compare.mjs --switches-a "name=value,..." [--switches-b "..."]
//        [--wasm build/v86.wasm] [--sessions 3] [--level R|F|S|D]
//        [--target name,...] [--quick] [--filter re] [--runs n] [--aa]
// The session files go to build/bench/compare-<time>-<n>.json.

import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(name);

const switches_a = value("--switches-a") || "";
const aa = flag("--aa");
const switches_b = aa ? switches_a : value("--switches-b") || "";
if(!aa && switches_a === switches_b)
{
    console.error("compare.mjs: --switches-a and --switches-b are the same; use --aa to measure the noise");
    process.exit(2);
}
const sessions = Number(value("--sessions") || 3);
const level = value("--level") || "R";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const run_args = ["--wasm", value("--wasm") || "build/v86.wasm", "--switches-a", switches_a, "--switches-b", switches_b];
if(flag("--quick")) run_args.push("--quick");
for(const name of ["--filter", "--runs"]) if(value(name) !== undefined) run_args.push(name, value(name));

const files = [];
for(let n = 1; n <= sessions; n++)
{
    const out = `build/bench/compare-${stamp}-${n}.json`;
    console.log(`[compare] session ${n}/${sessions}: ${switches_a || "(defaults)"} against ${switches_b || "(defaults)"}`);
    const r = spawnSync("node", ["tests/bench/run.mjs", ...run_args, "--out", out], { cwd: ROOT, stdio: "inherit" });
    if(r.status !== 0) process.exit(r.status ?? 1);
    files.push(out);
}

const gate_args = aa ? ["--aa"] : ["--level", level, ...value("--target") ? ["--target", value("--target")] : []];
const r = spawnSync("node", ["tests/bench/gate.mjs", ...gate_args, ...files], { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
