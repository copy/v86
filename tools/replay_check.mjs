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
// - The parallel build's test cores too (build/v86-ir-test-parallel.wasm,
//   P5.0): the generated code with atomic guest memory, loaded as the
//   machine instance (state slot 0, where v86.wasm has the state block), for
//   each base's corpus (a record says which memory it was made for, so the
//   recordings, made with build/v86.wasm, are not replayed there), compared
//   without the modules' name sections. --no-parallel skips them, as does a
//   base without the target.
// - Exit 1 when a record's bytes differ, unless --allow-changes (a change
//   meant to alter generated code reports which records it changed);
//   --allow-changes x64 allows only that engine's (the only one now).
//
// Usage: tools/replay_check.mjs [--base REV] [--base-wasm f] [--new-wasm f]
//        [--records file.x6r ...] [--allow-changes [x64]] [--no-parallel]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../src/const.js";
import { instantiate_v86 } from "../src/parallel/relocate.js";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const BASE_DIR = path.join(ROOT, "build/core-split/base");
const ARTIFACT = "build/v86-ir-test-release.wasm", PARALLEL_ARTIFACT = "build/v86-ir-test-parallel.wasm";
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

/** The base's test core (`artifact`): built in the base worktree at `rev`, or null without its target */
function build_base(rev, artifact = ARTIFACT)
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
    if(artifact !== ARTIFACT && !fs.readFileSync(path.join(BASE_DIR, "Makefile"), "utf8").includes(artifact + ":")) return null;
    run(BASE_DIR, "make", [artifact]);
    return path.join(BASE_DIR, artifact);
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
    // (a parallel build imports its memory: instantiate_v86 makes it and
    // relocates the module as the machine instance)
    const { instance } = await instantiate_v86(fs.readFileSync(file), { env });
    return instance.exports;
}

/** A module's bytes without its "name" custom section */
function without_names(bytes)
{
    const parts = [bytes.subarray(0, 8)];
    for(let at = 8; at < bytes.length;)
    {
        const start = at, id = bytes[at++];
        let size = 0, shift = 0, byte;
        do { byte = bytes[at++]; size += (byte & 0x7F) * 2 ** shift; shift += 7; } while(byte & 0x80);
        const payload = at;
        at += size;
        if(id === 0 && bytes[payload] === 4 && String.fromCharCode(...bytes.subarray(payload + 1, payload + 5)) === "name") continue;
        parts.push(bytes.subarray(start, at));
    }
    return Buffer.concat(parts);
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
// (the parallel build's cores: [base, next], or null)
const parallel = await (async () => {
    if(args.includes("--no-parallel") || option("--base-wasm")) return null;
    const base_parallel = build_base(option("--base") || "HEAD", PARALLEL_ARTIFACT);
    if(!base_parallel)
    {
        console.log("replay-check: the base has no parallel test core (before P5.0): the parallel build skipped");
        return null;
    }
    run(ROOT, "make", [PARALLEL_ARTIFACT]);
    return [await load(base_parallel), await load(path.join(ROOT, PARALLEL_ARTIFACT))];
})();
// (the engines whose changes are allowed: --allow-changes alone, every one)
const allow_at = args.indexOf("--allow-changes");
const allow_list = allow_at >= 0 && args[allow_at + 1] && !args[allow_at + 1].startsWith("--") ? args[allow_at + 1].split(",") : null;
const allowed = engine => allow_at >= 0 && (!allow_list || allow_list.includes(engine.name));
for(const name of allow_list || []) if(!ENGINES.some(e => e.name === name)) throw new Error(`--allow-changes: no engine ${name}`);
let differ = 0, total = 0, blocking = 0;
const builds = [{ label: "", cores: [base, next], recordings: true, strip: x => x },
    ...parallel ? [{ label: " (parallel build)", cores: parallel, recordings: false, strip: x => x && without_names(x) }] : []];
for(const { label, cores: [base, next], recordings, strip } of builds)
for(const engine of ENGINES)
{
    const sources = [["corpus", (base[engine.prefix + "record_corpus"](), records_of(base, engine))],
        ...recordings ? options("--records").filter(f => f.endsWith(engine.extension)).map(f => [path.basename(f), read_records(f)]) : []];
    for(const [name, records] of sources)
    {
        let changed = 0, refused = 0;
        const examples = [];
        for(const record of records)
        {
            const a = strip(replay(base, engine, record)), b = strip(replay(next, engine, record));
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
        console.log(`replay-check ${engine.name} ${name}${label}: ${records.length} records, ${changed} differ, ${refused} compile in neither` +
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
