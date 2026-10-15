#!/usr/bin/env node
// The local gates of docs/jit-unification-plan.md (P0.9; the GitHub CI is left
// alone for now, open question 1):
//
// make jit-gate, before each commit:
//   git diff --check, state-layout-check, warning-free `cargo check` of the
//   plain and the parallel build and of the ARM core's two (ARM64 plan
//   P1.0: --features aarch64, aarch64,parallel), rustfmt, eslint (when installed: ESLINT,
//   node_modules/.bin/eslint or npx's cache), the import rule of
//   src/rust/x86tpl (P2.10), the cores' boundaries
//   (tools/check_a64_imports.mjs) and, when something that feeds build/v86.wasm
//   changed, core-split-check (ARM64 plan P0.7); when x64 or shared JIT code
//   changed, replay-check (P2.0: the generated code byte for byte,
//   tools/replay_check.mjs; REPLAY_ALLOW_CHANGES=x64 for a change meant to
//   alter the page tier's code), the leaf digests (P2.1: jit-leaf-tests,
//   tests/x86tpl), x64-page-tier-tests and x64-legacy32-tests (the page
//   tier's 32-bit and 16-bit code). The changes are the uncommitted ones, or
//   without any the last commit's, or those since --base REV. (The region
//   freeze of P7.6 went with the region tiers in M11.)
// make jit-gate-full, at a milestone's exit and before a default flips:
//   the same with both test targets, then jit-core-tests (R-JIT: the Rust
//   unit tests, the decoder, the interpreter's REP engine, the decode rules)
//   and every level of the release gate with --quick.
//
// Performance is not gated automatically (open question 2): the R, F, S and D
// conditions are measured with tests/bench/gate.mjs where a change needs them.
//
// Usage: tools/jit_gate.mjs [--full] [--base REV] [--keep-going]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const full = args.includes("--full"), keep_going = args.includes("--keep-going");
const base_index = args.indexOf("--base");
const base = base_index >= 0 ? args[base_index + 1] : null;

function git(...git_args)
{
    const r = spawnSync("git", ["-C", ROOT, ...git_args], { encoding: "utf8" });
    if(r.status !== 0) throw new Error("git " + git_args.join(" ") + ": " + r.stderr.trim());
    return r.stdout.trim();
}
const lines = text => text.split("\n").filter(Boolean);

let changed, compared_with;
const untracked = lines(git("ls-files", "--others", "--exclude-standard"));
if(base)
{
    changed = [...lines(git("diff", "--name-only", base)), ...untracked];
    compared_with = base;
}
else
{
    changed = [...lines(git("diff", "--name-only", "HEAD")), ...untracked];
    compared_with = "HEAD";
    if(!changed.length)
    {
        changed = lines(git("diff", "--name-only", "HEAD~1", "HEAD"));
        compared_with = "HEAD~1 (the last commit)";
    }
}
const any = (...patterns) => changed.some(p => patterns.some(re => re.test(p)));

// shared JIT code: both test targets
const SHARED = [/^src\/rust\/(jit|jit_switches|lib|step_profile)\.rs$/, /^src\/rust\/(wasmgen|jitrt|x86tpl|cpu|decode)\//, /^src\/cpu\.js$/, /^gen\//, /^Cargo\.(toml|lock)$/];
const feeds_core = any(/^src\/rust\//, /^Cargo\.(toml|lock)$/, /^\.cargo\//, /^gen\//, /^lib\//, /^Makefile$/);
const x64_tests = full || any(/^src\/rust\/x64\//, ...SHARED);

// eslint: ESLINT, the project's node_modules, or the copy npx cached most
// recently (~/.npm/_npx/*/node_modules/eslint)
function find_eslint()
{
    if(process.env.ESLINT) return process.env.ESLINT;
    const local = path.join(ROOT, "node_modules/.bin/eslint");
    if(fs.existsSync(local)) return local;
    const cache = path.join(os.homedir(), ".npm/_npx");
    const copies = fs.existsSync(cache) ? fs.readdirSync(cache).map(d => path.join(cache, d, "node_modules/eslint/bin/eslint.js")).filter(f => fs.existsSync(f)) : [];
    return copies.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}
const eslint = find_eslint();
const eslint_command = eslint && [...(eslint.endsWith(".js") ? ["node", eslint] : [eslint]), "src", "tests", "gen", "lib", "examples", "tools"];
const warning_free = { RUSTFLAGS: "-D warnings" };
// recordings of real compilations (tools/replay_record.mjs), when made
const replay_dir = path.join(ROOT, "build/replay");
const replay_records = fs.existsSync(replay_dir) ? fs.readdirSync(replay_dir).filter(f => /\.x6r$/.test(f)).flatMap(f => ["--records", path.join("build/replay", f)]) : [];
const cargo_check = ["check", "--release", "--target", "wasm32-unknown-unknown"];

const steps = [
    { name: "git diff --check", command: ["git", "diff", "--check", base || "HEAD"] },
    { name: "state-layout-check", command: ["make", "state-layout-check"] },
    { name: "cargo check (warning-free)", command: ["cargo", ...cargo_check], env: warning_free },
    { name: "cargo check --features parallel (warning-free)", command: ["cargo", ...cargo_check, "--features", "parallel"], env: warning_free },
    { name: "cargo check --features aarch64 (warning-free)", command: ["cargo", ...cargo_check, "--features", "aarch64"], env: warning_free },
    { name: "cargo check --features aarch64,parallel (warning-free)", command: ["cargo", ...cargo_check, "--features", "aarch64,parallel"],
        env: warning_free },
    { name: "rustfmt", command: ["make", "rustfmt"] },
    { name: "eslint", command: eslint_command, skip: eslint ? null : "eslint not installed (set ESLINT to its bin/eslint.js)" },
    { name: "x86tpl and jitrt imports (P2.10, P5.1)", command: ["node", "tools/check_x86tpl_imports.mjs"] },
    { name: "the cores' boundaries (ARM64 plan P1.0)", command: ["node", "tools/check_a64_imports.mjs"] },
    { name: "core-split-check (ARM64 plan P0.7)", command: ["node", "tools/core_split_check.mjs", ...(base ? ["--base", base] : [])],
        skip: feeds_core || full ? null : "nothing that feeds build/v86.wasm changed" },
    // (P2.0: the base's and the working tree's generated code, byte for
    // byte, for the synthetic corpus and the recordings in build/replay)
    { name: "replay-check (P2.0)", command: ["node", "tools/replay_check.mjs", ...(base ? ["--base", base] : []), ...replay_records,
        ...(process.env.REPLAY_ALLOW_CHANGES ? ["--allow-changes", process.env.REPLAY_ALLOW_CHANGES] : [])],
        skip: x64_tests ? null : "no x64 or shared JIT change" },
    { name: "leaf digests (P2.1)", command: ["make", "jit-leaf-tests"],
        skip: x64_tests ? null : "no x64 or shared JIT change" },
    { name: "x64-page-tier-tests", command: ["make", "x64-page-tier-tests"], skip: x64_tests ? null : "no x64 or shared JIT change" },
    { name: "x64-legacy32-tests", command: ["make", "x64-legacy32-tests"], skip: x64_tests ? null : "no x64 or shared JIT change" },
    { name: "jit-switch-tests", command: ["make", "jit-switch-tests"],
        skip: full || any(/jit_switches\.(rs|js|mjs)$/, /^tests\/api\/jit-switches\.js$/) ? null : "the switch registry did not change" },
];
if(full)
{
    steps.push({ name: "jit-core-tests", command: ["make", "jit-core-tests"] });
    steps.push({ name: "release gate, every level --quick", command: ["make", "platform-release-gate", "GATE_ARGS=--quick"] });
}

console.log(`[jit-gate] ${full ? "full" : "quick"}; ${changed.length} changed paths against ${compared_with}`);
const results = [];
let failed = false;
for(const step of steps)
{
    if(step.skip || failed && !keep_going)
    {
        results.push({ name: step.name, status: step.skip ? "skipped: " + step.skip : "not run" });
        continue;
    }
    console.log(`\n[jit-gate] ${step.name}: ${step.command.join(" ")}`);
    const start = Date.now();
    const r = spawnSync(step.command[0], step.command.slice(1), { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...step.env } });
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    const ok = r.status === 0;
    if(!ok) failed = true;
    results.push({ name: step.name, status: (ok ? "ok" : "FAILED") + ` (${seconds} s)` });
}

console.log("\n[jit-gate] summary:");
for(const { name, status } of results) console.log(`  ${name.padEnd(48)} ${status}`);
if(failed)
{
    console.log("[jit-gate] FAILED");
    process.exit(1);
}
console.log("[jit-gate] passed");
