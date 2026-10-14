#!/usr/bin/env node
// The byte-identity check of the JITs' generated code
// (docs/jit-unification-plan.md P2.0, cross-phase rule 4): records of
// compilations of the x64 page tier (src/rust/x64/replay.rs) replayed in a
// base build and in the working tree, under fixed pseudo addresses, must give
// the same bytes. (IR Tier-0's, *.t0r, went with it in P7.5.) The records are
// each base's synthetic corpus (every SSE form the page tier's templates
// take) and any recordings given with --records (made with
// tools/replay_record.mjs from real workloads, *.x6r).
//
// - BASE (--base, default HEAD) builds build/v86-ir-test-release.wasm in the
//   worktree build/core-split/base (shared with core_split_check.mjs), the
//   working tree its own; --base-wasm and --new-wasm take built ones instead.
// - Exit 1 when a record's bytes differ, unless --allow-changes (a change
//   meant to alter generated code reports which records it changed);
//   --allow-changes x64 allows only that engine's (the only one now).
//
// Usage: tools/replay_check.mjs [--base REV] [--base-wasm f] [--new-wasm f]
//        [--records file.x6r ...] [--allow-changes [x64]]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../src/const.js";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const BASE_DIR = path.join(ROOT, "build/core-split/base");
const ARTIFACT = "build/v86-ir-test-release.wasm";
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const options = name => args.flatMap((a, i) => a === name && args[i + 1] ? [args[i + 1]] : []);

function run(cwd, command, command_args)
{
    console.log(`[replay-check] ${path.relative(ROOT, cwd) || "."}: ${command} ${command_args.join(" ")}`);
    const r = spawnSync(command, command_args, { cwd, stdio: "inherit" });
    if(r.status !== 0) throw new Error(`${command} ${command_args.join(" ")} failed in ${cwd}`);
}
function git(cwd, ...git_args)
{
    const r = spawnSync("git", ["-C", cwd, ...git_args], { encoding: "utf8" });
    if(r.status !== 0) throw new Error("git " + git_args.join(" ") + ": " + r.stderr.trim());
    return r.stdout.trim();
}

/** The base's test core: built in the base worktree at `rev` */
function build_base(rev)
{
    const commit = git(ROOT, "rev-parse", rev);
    if(!fs.existsSync(path.join(BASE_DIR, ".git")))
    {
        fs.mkdirSync(path.dirname(BASE_DIR), { recursive: true });
        git(ROOT, "worktree", "add", "--detach", BASE_DIR, commit);
    }
    else if(git(BASE_DIR, "rev-parse", "HEAD") !== commit || git(BASE_DIR, "status", "--porcelain", "--untracked-files=no"))
    {
        git(BASE_DIR, "checkout", "--detach", "--force", commit);
    }
    run(BASE_DIR, "make", [ARTIFACT]);
    return path.join(BASE_DIR, ARTIFACT);
}

async function load(file)
{
    const module = await WebAssembly.compile(fs.readFileSync(file));
    const env = {};
    for(const { module: from, name, kind } of WebAssembly.Module.imports(module))
    {
        if(from !== "env") continue;
        if(kind === "function") env[name] = () => 0;
        else if(kind === "table") env[name] = new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET });
    }
    const { exports } = await WebAssembly.instantiate(module, { env });
    return exports;
}

// the exports of each engine: <prefix>record_count, ..., <prefix>replay
const ENGINES = [{ name: "x64", prefix: "x64_page_", extension: ".x6r" }];

/** The records a core holds for an engine (<prefix>record_*) */
function records_of(e, engine)
{
    const list = [], p = engine.prefix;
    for(let i = 0, n = e[p + "record_count"](); i < n; i++)
    {
        list.push(new Uint8Array(e["memory"].buffer, e[p + "record_address"](i), e[p + "record_length"](i)).slice());
    }
    return list;
}
/** Records saved by tools/replay_record.mjs: each a u32 length, then its bytes */
export function read_records(file)
{
    const bytes = fs.readFileSync(file), list = [];
    for(let at = 0; at + 4 <= bytes.length;)
    {
        const n = bytes.readUInt32LE(at);
        list.push(new Uint8Array(bytes.subarray(at + 4, at + 4 + n)));
        at += 4 + n;
    }
    return list;
}
function replay(e, engine, record)
{
    const p = engine.prefix;
    const at = e[p + "replay_input"](record.length);
    new Uint8Array(e["memory"].buffer, at, record.length).set(record);
    const n = e[p + "replay"]();
    return n ? new Uint8Array(e["memory"].buffer, e[p + "replay_output"](), n).slice() : null;
}
const same = (a, b) => a === b || a && b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
/** A short name of a record: its first instruction's bytes, from the first entry */
function describe(engine, record)
{
    // (magic 4, flags, the entry count, the entries, the next bytes' count and them, the page)
    const view = Buffer.from(record), entries = view.readUInt16LE(5), first = view.readUInt16LE(7);
    const next_at = 7 + 2 * entries, page = next_at + 2 + view.readUInt16LE(next_at);
    return `+${first.toString(16)}: ${view.subarray(page + first, page + first + 8).toString("hex")}`;
}

const base_wasm = option("--base-wasm") || build_base(option("--base") || "HEAD");
const new_wasm = option("--new-wasm") || (run(ROOT, "make", [ARTIFACT]), path.join(ROOT, ARTIFACT));
const [base, next] = [await load(base_wasm), await load(new_wasm)];
if(!base["x64_page_replay"] || !next["x64_page_replay"])
{
    console.log(`replay-check: ${!base["x64_page_replay"] ? "the base" : "the working tree"} has no replay (ir-test-hooks before P2.0): skipped`);
    process.exit(0);
}
// (the engines whose changes are allowed: --allow-changes alone, every one)
const allow_at = args.indexOf("--allow-changes");
const allow_list = allow_at >= 0 && args[allow_at + 1] && !args[allow_at + 1].startsWith("--") ? args[allow_at + 1].split(",") : null;
const allowed = engine => allow_at >= 0 && (!allow_list || allow_list.includes(engine.name));
for(const name of allow_list || []) if(!ENGINES.some(e => e.name === name)) throw new Error(`--allow-changes: no engine ${name}`);
let differ = 0, total = 0, blocking = 0;
for(const engine of ENGINES)
{
    const sources = [["corpus", (base[engine.prefix + "record_corpus"](), records_of(base, engine))],
        ...options("--records").filter(f => f.endsWith(engine.extension)).map(f => [path.basename(f), read_records(f)])];
    for(const [name, records] of sources)
    {
        let changed = 0, refused = 0;
        const examples = [];
        for(const record of records)
        {
            const a = replay(base, engine, record), b = replay(next, engine, record);
            if(!a && !b) refused++;
            else if(!same(a, b))
            {
                changed++;
                if(examples.length < 8) examples.push(describe(engine, record) + (a && b ? ` (${a.length} -> ${b.length} bytes)` : a ? " (no longer compiles)" : " (compiles now)"));
            }
        }
        total += records.length;
        differ += changed;
        if(!allowed(engine)) blocking += changed;
        console.log(`replay-check ${engine.name} ${name}: ${records.length} records, ${changed} differ, ${refused} compile in neither` +
            (examples.length ? "\n  " + examples.join("\n  ") : ""));
    }
}
if(blocking)
{
    console.log(`replay-check: ${differ} of ${total} records give other bytes` + (blocking < differ ? `, ${blocking} where no change is allowed` : ""));
    process.exit(1);
}
if(differ)
{
    console.log(`replay-check: ${differ} of ${total} records give other bytes, allowed (--allow-changes ${allow_list ? allow_list.join(",") : ""})`);
    process.exit(0);
}
console.log(`replay-check: ${total - differ} of ${total} records give the same bytes`);
