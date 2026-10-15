#!/usr/bin/env node
// make core-split-check (docs/arm64-virt-android16-plan.md P0.7,
// docs/jit-unification-plan.md cross-phase rule 12): builds build/v86.wasm of
// two revisions in this run, with one toolchain, and compares them with
// tools/wasm_diff.mjs.
//
// - BASE (--base, default HEAD) is built in the worktree build/core-split/base,
//   NEW in the working tree (default) or, with --new REV, in the worktree
//   build/core-split/new. The worktrees stay, so later runs build
//   incrementally.
// - When no changed path feeds the x86 core (only src/rust/aarch64/, docs,
//   tests, ...), the two modules must be identical: exit 1 otherwise. Else the
//   functions that differ are listed; an actual change asks for the R gate.
// - The size of build/v86.wasm and the medians of 5 compile and instantiate
//   times are printed, the baseline of the x86 core.
//
// Usage: tools/core_split_check.mjs [--base REV] [--new REV] [--json FILE]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { compare, code_changed, format } from "./wasm_diff.mjs";
import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../src/const.js";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "build/core-split");

// paths whose change can change build/v86.wasm (src/rust/aarch64/ is the ARM core's)
const FEEDS_X86_CORE = [/^src\/rust\/(?!aarch64\/)/, /^Cargo\.(toml|lock)$/, /^\.cargo\//, /^gen\//, /^lib\//, /^Makefile$/, /^tools\/rust-lld-wrapper$/];

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

function git(...git_args)
{
    const r = spawnSync("git", ["-C", ROOT, ...git_args], { encoding: "utf8" });
    if(r.status !== 0) throw new Error("git " + git_args.join(" ") + ": " + r.stderr.trim());
    return r.stdout.trim();
}

function run(cwd, command, command_args)
{
    console.log(`[core-split-check] ${path.relative(ROOT, cwd) || "."}: ${command} ${command_args.join(" ")}`);
    const r = spawnSync(command, command_args, { cwd, stdio: "inherit" });
    if(r.status !== 0) throw new Error(`${command} ${command_args.join(" ")} failed in ${cwd}`);
}

// The C objects that build/v86.wasm links (clang -flto bitcode). The Makefile
// rebuilds them only when their sources change, so the working tree's may come
// from an older clang than a fresh worktree's, which changes their functions.
const C_OBJECTS = ["build/softfloat.o", "build/zstddeclib.o"];

// a worktree at `dir` checked out at `commit`, its build/v86.wasm built; with
// share_objects, linked with the working tree's C objects
function build_worktree(name, commit, share_objects)
{
    const dir = path.join(WORK, name);
    if(!fs.existsSync(path.join(dir, ".git")))
    {
        fs.mkdirSync(WORK, { recursive: true });
        git("worktree", "add", "--detach", dir, commit);
    }
    else
    {
        // (a checkout rewrites files whose stat data changed, which makes cargo
        // compile again: skip it when the worktree is clean at the commit)
        const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        const dirty = spawnSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim();
        if(head !== commit || dirty)
        {
            const r = spawnSync("git", ["-C", dir, "checkout", "--detach", "--force", commit], { encoding: "utf8" });
            if(r.status !== 0) throw new Error("checkout in " + dir + ": " + r.stderr.trim());
        }
    }
    if(share_objects)
    {
        fs.mkdirSync(path.join(dir, "build"), { recursive: true });
        let relink = false;
        for(const object of C_OBJECTS)
        {
            const from = path.join(ROOT, object), to = path.join(dir, object);
            if(fs.existsSync(to) && Buffer.compare(fs.readFileSync(from), fs.readFileSync(to)) === 0) continue;
            fs.copyFileSync(from, to);
            relink = true;
        }
        // (cargo does not track objects passed as link arguments: without the
        // crate's fingerprint it compiles and links the crate again)
        if(relink)
        {
            const fingerprints = path.join(dir, "build/wasm32-unknown-unknown/release/.fingerprint");
            for(const entry of fs.existsSync(fingerprints) ? fs.readdirSync(fingerprints) : [])
            {
                if(entry.startsWith("v86-")) fs.rmSync(path.join(fingerprints, entry), { recursive: true, force: true });
            }
        }
    }
    run(dir, "make", ["build/v86.wasm"]);
    return path.join(dir, "build/v86.wasm");
}

function median(values)
{
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
}

async function timings(bytes)
{
    const compile = [], instantiate = [];
    for(let i = 0; i < 5; i++)
    {
        let t = performance.now();
        const module = await WebAssembly.compile(bytes);
        compile.push(performance.now() - t);
        const env = {};
        for(const { module: from, name, kind } of WebAssembly.Module.imports(module))
        {
            if(from !== "env") continue;
            if(kind === "function") env[name] = () => 0;
            else if(kind === "table") env[name] = new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET });
        }
        t = performance.now();
        await WebAssembly.instantiate(module, { env });
        instantiate.push(performance.now() - t);
    }
    return { compile_ms: +median(compile).toFixed(1), instantiate_ms: +median(instantiate).toFixed(1) };
}

const base = git("rev-parse", option("--base") || "HEAD");
const new_rev = option("--new");
const new_commit = new_rev ? git("rev-parse", new_rev) : null;

let changed;
if(new_commit)
{
    changed = git("diff", "--name-only", base, new_commit).split("\n").filter(Boolean);
}
else
{
    changed = [...git("diff", "--name-only", base).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean);
}
const feeding = changed.filter(p => FEEDS_X86_CORE.some(re => re.test(p)));

let base_wasm, new_wasm;
if(new_commit)
{
    // (two fresh worktrees: one clang builds both sides' C objects)
    base_wasm = build_worktree("base", base, false);
    new_wasm = build_worktree("new", new_commit, false);
}
else
{
    // (the base links the working tree's C objects unless their sources changed)
    const share = !changed.some(p => p.startsWith("lib/"));
    if(share) run(ROOT, "make", C_OBJECTS);
    else console.log("[core-split-check] lib/ changed: each side builds its own C objects");
    base_wasm = build_worktree("base", base, share);
    run(ROOT, "make", ["build/v86.wasm"]);
    new_wasm = path.join(ROOT, "build/v86.wasm");
}

const old_bytes = fs.readFileSync(base_wasm), new_bytes = fs.readFileSync(new_wasm);
const result = compare(old_bytes, new_bytes);
console.log(format(result, `${base.slice(0, 8)}:build/v86.wasm`, `${new_commit ? new_commit.slice(0, 8) : "working tree"}:build/v86.wasm`));

const measured = await timings(new_bytes);
const report = {
    base, new: new_commit || "working tree", changed_paths: changed.length, paths_feeding_x86_core: feeding,
    must_be_identical: feeding.length === 0, identical: result.identical, code_changed: !result.identical && code_changed(result),
    size: new_bytes.length, ...measured,
    functions_changed: result.functions.changed.length, functions_added: result.functions.added.length, functions_removed: result.functions.removed.length,
};
console.log(`v86.wasm: ${report.size} bytes, compile ${report.compile_ms} ms, instantiate ${report.instantiate_ms} ms (medians of 5)`);
if(option("--json")) fs.writeFileSync(option("--json"), JSON.stringify({ ...report, diff: result }, null, 1));

if(report.must_be_identical && !result.identical)
{
    console.error(`core-split-check: no change feeds the x86 core (${changed.length} changed paths), but build/v86.wasm differs`);
    process.exit(1);
}
if(report.code_changed)
{
    console.log(`core-split-check: ${report.functions_changed} functions changed, ${report.functions_added} added, ${report.functions_removed} removed: run the R gate (docs/jit-unification-plan.md cross-phase rule 2)`);
}
else
{
    console.log("core-split-check: no code change in build/v86.wasm");
}
