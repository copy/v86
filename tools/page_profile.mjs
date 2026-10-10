#!/usr/bin/env node
// Where a page function spends its time, per host instruction
// (docs/profiling.md): runs a benchmark on the test core
// (build/v86-ir-test-release.wasm, ir-test-hooks) under V8's sampling
// profiler (node --prof) while recording what the x64 page tier (with
// --isa i686, Tier-0; with --isa compat32, the page tier in compatibility
// mode) compiles, saves the last module whose page holds the given
// instruction bytes, has V8's optimizing compiler print that module's code
// (node --no-liftoff --print-wasm-code) and maps the ticks that fell in the
// optimized function of the same size onto it. Sizes differ when the
// recorded and the replayed module differ (pinned addresses): then it says so.
//
// Usage: node tools/page_profile.mjs <benchmark> <hex bytes> [--isa x86_64|i686|compat32]
//        [--switches name=value,...] [--runs 6] [--min 20] [--interval 50]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf("--" + name); return i < 0 ? fallback : args[i + 1]; };
const [name, hex] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(isa|switches|runs|min|interval|child)$/));
const isa = option("isa", "x86_64");
process.chdir(ROOT);

if(args.includes("--child"))
{
    // the profiled run: record, run, save the module of the page
    const out = option("child");
    const prefix = isa === "i686" ? "ir_t0_" : "x64_page_";
    const { load_pe, boot_images, create, execute } = await import("../tests/bench/machine.mjs");
    const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
    const bench = manifest.benchmarks.find(b => b.name === name);
    if(!bench) throw new Error(`no benchmark ${name}`);
    const switches = Object.fromEntries(option("switches", "").split(",").filter(Boolean).map(kv => { const [k, v] = kv.split("="); return [k, +v]; }));
    if(isa === "compat32" && switches.x64_page_compat32 === undefined) switches.x64_page_compat32 = 1;
    const machine = await create({ label: "profile", isa, wasm: "build/v86-ir-test-release.wasm", switches }, bench, boot_images(manifest));
    const e = machine.e;
    if(!e[prefix + "record_start"]) throw new Error("build/v86-ir-test-release.wasm has no replay hooks (ir-test-hooks)");
    e[prefix + "record_start"]();
    for(let run = 0, runs = +option("runs", 6); run < runs; run++)
    {
        const s = await execute(machine, load_pe(isa === "x86_64" ? bench.image64 : bench.image), bench.iterations);
        console.log(`run ${run}: ${s.ms.toFixed(0)} ms`);
    }
    const needle = Uint8Array.from(hex.replace(/\s+/g, "").match(/../g).map(h => parseInt(h, 16)));
    const holds = record => { outer: for(let i = 0; i + needle.length <= record.length; i++) { for(let j = 0; j < needle.length; j++) if(record[i + j] !== needle[j]) continue outer; return true; } return false; };
    let module;
    for(let i = 0, n = e[prefix + "record_count"](); i < n; i++)
    {
        const record = new Uint8Array(e.memory.buffer, e[prefix + "record_address"](i), e[prefix + "record_length"](i)).slice();
        if(!holds(record)) continue;
        // (the module as it ran; a build without output records replays it)
        if(e[prefix + "record_output_length"]?.(i))
        {
            module = new Uint8Array(e.memory.buffer, e[prefix + "record_output_address"](i), e[prefix + "record_output_length"](i)).slice();
            continue;
        }
        new Uint8Array(e.memory.buffer, e[prefix + "replay_input"](record.length), record.length).set(record);
        const length = e[prefix + "replay"]();
        module = new Uint8Array(e.memory.buffer, e[prefix + "replay_output"](), length).slice();
    }
    e[prefix + "record_stop"]();
    await machine.vm.destroy();
    if(!module) throw new Error("no compiled page holds those bytes");
    fs.writeFileSync(out, module);
    process.exit(0);
}

if(!name || !hex)
{
    console.error("usage: node tools/page_profile.mjs <benchmark> <hex bytes> [--isa x86_64|i686|compat32] [--switches a=1,...] [--runs 6] [--min 20]");
    process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), "page-profile-"));
const log = path.join(work, "v8.log"), wasm = path.join(work, "page.wasm");
const passed = args.filter((a, i) => a !== "--child" && args[i - 1] !== "--child");
const child = spawnSync(process.execPath, ["--prof", `--prof-sampling-interval=${option("interval", 50)}`, `--logfile=${log}`, "--no-logfile-per-isolate",
    url.fileURLToPath(import.meta.url), ...passed, "--child", wasm], { encoding: "utf8", maxBuffer: 1 << 28 });
process.stdout.write(child.stdout);
if(child.status !== 0) { process.stderr.write(child.stderr); process.exit(1); }
const printed = spawnSync(process.execPath, ["--no-liftoff", "--no-wasm-lazy-compilation", "--print-wasm-code", "-e",
    `new WebAssembly.Module(require("fs").readFileSync(${JSON.stringify(wasm)}))`], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout;
const fn = /^name: (\S+)/m.exec(printed)?.[1];
const size = +(/Body \(size = (\d+)/.exec(printed)?.[1] ?? 0);
// the optimized code objects of the function, and the ticks
const codes = [], ticks = [];
for(const line of fs.readFileSync(log, "utf8").split("\n"))
{
    if(line.startsWith("code-creation,"))
    {
        const f = line.split(",");
        if(f[6] === fn) codes.push({ start: parseInt(f[4], 16), size: +f[5], optimized: f[f.length - 1] === "*" });
    }
    else if(line.startsWith("tick,")) ticks.push(parseInt(line.split(",")[1], 16));
}
const code = codes.filter(c => c.optimized && c.size === size).at(-1);
if(!code)
{
    console.log(`${fn}: no optimized code of ${size} bytes among ${JSON.stringify(codes.map(c => [c.size, c.optimized]))}: the replayed module differs`);
    process.exit(1);
}
const counts = new Map();
let inside = 0;
for(const t of ticks) if(t >= code.start && t < code.start + code.size) { inside++; counts.set(t - code.start, (counts.get(t - code.start) || 0) + 1); }
console.log(`${fn}: ${inside} of ${ticks.length} ticks (${(100 * inside / ticks.length).toFixed(1)}%) in its optimized code (${size} bytes)`);
const min = +option("min", 20);
for(const line of printed.split("\n"))
{
    const m = /^0x[0-9a-f]+\s+([0-9a-f]+)\s+[0-9a-f]+\s+(.*)$/.exec(line);
    if(!m) continue;
    const n = counts.get(parseInt(m[1], 16)) || 0;
    if(n >= min) console.log(`${m[1].padStart(6)} ${String(n).padStart(6)} ${(100 * n / inside).toFixed(1).padStart(5)}%  ${m[2]}`);
}
fs.rmSync(work, { recursive: true, force: true });
