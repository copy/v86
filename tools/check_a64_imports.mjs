#!/usr/bin/env node
// The boundaries of the two Wasm cores (docs/arm64-virt-android16-plan.md
// "Wasm core", P0.11; docs/jit-unification-plan.md cross-phase rule 12),
// checked on the code of every Rust file (comments and strings stripped):
//
// - `feature = "aarch64"` is written only in src/rust/lib.rs, which selects
//   the modules and the ISA hooks of a core, and in src/rust/aarch64/;
// - src/rust/aarch64/ names no module of the x86 core (the ARM core is built
//   without them, src/rust/lib.rs): crate::cpu, x64, x86tpl, decode,
//   decode_rules, prefix, paging, x87_profiler, simd_corpus, state_flags,
//   softfloat, the x86 composition root crate::jit (the ARM core's is
//   aarch64::root), jit_switches, step_profile, profiler, js_api, gen, config;
// - no other module names crate::aarch64 (lib.rs's hooks call into it).
//
// Usage: tools/check_a64_imports.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const RUST = path.join(ROOT, "src/rust");
const X86_MODULES = ["cpu", "x64", "x86tpl", "decode", "decode_rules", "prefix", "paging", "x87_profiler", "simd_corpus", "state_flags",
    "softfloat", "jit", "jit_switches", "step_profile", "profiler", "js_api", "gen", "config"];

/** The code of a Rust file without comments, strings and character literals */
function code(text)
{
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/b?r#*"[\s\S]*?"#*/g, "\"\"")
        .replace(/b?"(?:[^"\\]|\\.)*"/g, "\"\"")
        .replace(/'(?:[^'\\]|\\.)'/g, "' '");
}

const walk = directory => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(directory, e.name)) : e.name.endsWith(".rs") ? [path.join(directory, e.name)] : []);

const problems = [];
let files = 0;
for(const file of walk(RUST))
{
    files++;
    const relative = path.relative(ROOT, file);
    const in_arm = relative.startsWith("src/rust/aarch64/");
    const text = fs.readFileSync(file, "utf8");
    const stripped = code(text);
    const line_of = index => text.slice(0, index).split("\n").length;
    // (the feature's name is a string, so it is looked for in the original text, outside comments)
    const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
    for(const m of uncommented.matchAll(/feature\s*=\s*"aarch64"/g))
    {
        if(!in_arm && relative !== "src/rust/lib.rs") problems.push(`${relative}:${line_of(m.index)}: feature = "aarch64" outside lib.rs and src/rust/aarch64/`);
    }
    for(const m of stripped.matchAll(/\bcrate::(\w+)/g))
    {
        if(in_arm && X86_MODULES.includes(m[1])) problems.push(`${relative}: the ARM core names the x86 module crate::${m[1]}`);
        if(!in_arm && m[1] === "aarch64" && relative !== "src/rust/lib.rs") problems.push(`${relative}: a shared or x86 module names crate::aarch64`);
    }
}
if(problems.length)
{
    for(const problem of problems) console.log(problem);
    console.log(`check_a64_imports: ${problems.length} problem(s)`);
    process.exit(1);
}
console.log(`check_a64_imports: ${files} Rust files, the cores' boundaries hold`);
