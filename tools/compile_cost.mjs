#!/usr/bin/env node
// What the x64 page tier's JIT switches cost V8 to compile
// (docs/profiling.md): records of real compilations (tools/replay_record.mjs
// for benchmarks, WIN_RECORD of tests/x64/windows_boot.mjs for Windows) are
// replayed on a test core (ir-test-hooks: build/v86-ir-test-release.wasm)
// with their switch bits replaced, once per configuration, and the modules
// of each configuration compiled eagerly on one thread, with Liftoff and
// with TurboFan (node --single-threaded --no-wasm-lazy-compilation). Prints
// the bytes and both compile times, each relative to the records' switches
// off (base). How M5 found what a hot recompile costs
// (docs/jit-unification-plan.md, appendix C).
//
// Usage: node tools/compile_cost.mjs <records.x6r> [--wasm core.wasm]
//        [--stride N: every Nth record] [--limit N] [--only name,...]
//        [--no-time]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../src/const.js";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const records_file = args[0];
if(!records_file || records_file.startsWith("--"))
{
    console.error("usage: node tools/compile_cost.mjs <records.x6r> [--wasm core.wasm] [--stride N] [--limit N] [--only name,...] [--no-time]");
    process.exit(2);
}
const core = option("--wasm", path.join(ROOT, "build/v86-ir-test-release.wasm"));
const stride = +option("--stride", 1), limit = +option("--limit", Infinity);
const only = option("--only", null)?.split(",");
const time = !args.includes("--no-time");

const module = await WebAssembly.compile(fs.readFileSync(core));
const env = {};
for(const { module: from, name, kind } of WebAssembly.Module.imports(module))
{
    if(from !== "env") continue;
    if(kind === "function") env[name] = () => 0;
    else if(kind === "table") env[name] = new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET });
}
const e = (await WebAssembly.instantiate(module, { env })).exports;
if(!e.x64_page_replay) throw new Error(`${core} has no replay hooks (build/v86-ir-test-release.wasm, ir-test-hooks)`);

// A record (src/rust/x64/replay.rs): "X6R1", flags (bit 3: outlined
// accesses), the entries, the next page's bytes, the page, the name, then a
// trailer that older records lack: the switch bits (1: the execution
// counter, 2: loops, 4: XMM locals, 8: the fast SSE checks, 16: i32
// operations, 32: the fast lookups, 64: the chained GPRs, 128: EFLAGS by
// observers) and the access cache's entries (u16).
function trailer_at(r)
{
    let at = 5;
    at += 2 + 2 * r.readUInt16LE(at);
    at += 2 + r.readUInt16LE(at);
    at += 4096;
    return at + 2 + r.readUInt16LE(at);
}
function variant(r, { counter = 0, outline = 1, bits = 0, jac = 1024 })
{
    const t = trailer_at(r);
    const v = Buffer.concat([r.subarray(0, t), Buffer.alloc(3)]);
    v[4] = v[4] & ~8 | outline << 3;
    v[t] = counter | bits;
    v.writeUInt16LE(jac, t + 1);
    return v;
}
function replay(record)
{
    const at = e.x64_page_replay_input(record.length);
    new Uint8Array(e.memory.buffer, at, record.length).set(record);
    const n = e.x64_page_replay();
    return n ? new Uint8Array(e.memory.buffer, e.x64_page_replay_output(), n).slice() : null;
}
/** Records as tools/replay_record.mjs saves them: each a u32 length, then its bytes */
function read_records(file)
{
    const bytes = fs.readFileSync(file), list = [];
    for(let at = 0; at + 4 <= bytes.length;)
    {
        const n = bytes.readUInt32LE(at);
        list.push(bytes.subarray(at + 4, at + 4 + n));
        at += 4 + n;
    }
    return list;
}
const SWITCH_BITS = { x64_loops: 2, x64_xmm_locals: 4, x64_sse_fast_check: 8, x64_i32_ops: 16, x64_fast_lookup: 32, x64_fast_chain: 64, x64_exit_flags: 128 };
const ALL = Object.values(SWITCH_BITS).reduce((a, b) => a | b);
// a cold compile with x64_hot_inline has the counter, a hot recompile inline lookups
const CONFIGS = [
    ["base", {}],
    ["x64_hot_inline, cold", { counter: 1 }],
    ["x64_hot_inline, hot", { outline: 0 }],
    ...Object.entries(SWITCH_BITS).map(([name, bits]) => [name, { bits }]),
    ["x64_jac_entries=2048", { jac: 2048 }],
    ["all, cold", { counter: 1, bits: ALL, jac: 2048 }],
    ["all, hot", { outline: 0, bits: ALL, jac: 2048 }],
];

const records = read_records(records_file).filter((r, i) => i % stride === 0).slice(0, limit);
console.log(`${records.length} records of ${records_file}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-cost-"));
const timer = path.join(dir, "timer.mjs");
fs.writeFileSync(timer, `import fs from "node:fs";
const bytes = fs.readFileSync(process.argv[2]);
let ms = 0;
for(let at = 0; at < bytes.length;)
{
    const n = bytes.readUInt32LE(at), m = bytes.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    const t0 = performance.now();
    new WebAssembly.Module(m);
    ms += performance.now() - t0;
}
console.log(ms);`);
// (the fastest of three Liftoff runs, one TurboFan run)
function compile_ms(file, tier)
{
    const flags = tier === "liftoff" ? ["--liftoff-only"] : ["--no-liftoff"];
    let best = Infinity;
    for(let i = 0; i < (tier === "liftoff" ? 3 : 1); i++)
    {
        const r = spawnSync(process.execPath, ["--single-threaded", "--no-wasm-lazy-compilation", ...flags, timer, file], { encoding: "utf8" });
        if(r.status !== 0) throw new Error("compiling failed: " + r.stderr);
        best = Math.min(best, +r.stdout);
    }
    return best;
}
let base;
try
{
    for(const [name, config] of CONFIGS)
    {
        if(only && name !== "base" && !only.some(o => name.startsWith(o))) continue;
        let bytes = 0, refused = 0;
        const chunks = [];
        for(const r of records)
        {
            const out = replay(variant(r, config));
            if(!out) { refused++; continue; }
            bytes += out.length;
            const length = Buffer.alloc(4);
            length.writeUInt32LE(out.length);
            chunks.push(length, Buffer.from(out));
        }
        const file = path.join(dir, "modules.bin");
        fs.writeFileSync(file, Buffer.concat(chunks));
        const row = { bytes, liftoff: time ? compile_ms(file, "liftoff") : 0, turbofan: time ? compile_ms(file, "turbofan") : 0 };
        base ||= row;
        const rel = key => (row[key] / base[key]).toFixed(3);
        console.log(`${name.padEnd(24)} ${(bytes / 1e6).toFixed(1).padStart(7)} MB ${rel("bytes")}` +
            (time ? `  Liftoff ${(row.liftoff / 1000).toFixed(2).padStart(6)} s ${rel("liftoff")}  TurboFan ${(row.turbofan / 1000).toFixed(2).padStart(7)} s ${rel("turbofan")}` : "") +
            (refused ? `  (${refused} refused)` : ""));
    }
}
finally
{
    fs.rmSync(dir, { recursive: true, force: true });
}
