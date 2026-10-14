#!/usr/bin/env node
// The import rule of src/rust/x86tpl (docs/jit-unification-plan.md P2.10):
// the x86 leaf templates are shared by every x86 engine, so they name none
// of them: not the x64 page tier (crate::x64), the IR runtime (crate::ir::runtime), the JIT's composition root
// (crate::jit) nor the region pipeline (crate::ir::{backend, mir, hir,
// passes, lowering}). Checks every crate:: and super:: path in the module's
// code (comments and strings stripped), and that a super:: path stays in
// x86tpl.
//
// Usage: tools/check_x86tpl_imports.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "src/rust/x86tpl");
const FORBIDDEN = [
    /^crate::x64\b/,
    /^crate::ir::runtime\b/,
    /^crate::jit\b/,
    /^crate::ir::(backend|mir|hir|passes|lowering)\b/,
];

/** The code of a Rust file without comments, strings and character literals */
function code(text)
{
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/b?"(?:[^"\\]|\\.)*"/g, "\"\"")
        .replace(/'(?:[^'\\]|\\.)'/g, "' '");
}

/** The paths a `use` tree names, one per leaf: crate::a::{b, c::d} gives crate::a::b, crate::a::c::d */
function use_paths(tree, prefix = "")
{
    tree = tree.trim();
    const brace = tree.indexOf("{");
    if(brace < 0) return [prefix + tree.replace(/\s+as\s+\w+$/, "")];
    const head = prefix + tree.slice(0, brace);
    const inner = tree.slice(brace + 1, tree.lastIndexOf("}"));
    const parts = [];
    let depth = 0, start = 0;
    for(let i = 0; i < inner.length; i++)
    {
        if(inner[i] === "{") depth++;
        else if(inner[i] === "}") depth--;
        else if(inner[i] === "," && depth === 0)
        {
            parts.push(inner.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(inner.slice(start));
    return parts.filter(p => p.trim()).flatMap(p => use_paths(p, head));
}

const problems = [];
let checked = 0;
for(const file of fs.readdirSync(DIR).filter(f => f.endsWith(".rs")).sort())
{
    const text = code(fs.readFileSync(path.join(DIR, file), "utf8"));
    const paths = [];
    for(const [, tree] of text.matchAll(/\buse\s+([^;]+);/g)) paths.push(...use_paths(tree.replace(/\s+/g, " ")));
    // (paths written out in the code, outside use declarations)
    for(const [found] of text.replace(/\buse\s+[^;]+;/g, "").matchAll(/\b(?:crate|super)(?:::\w+)+/g)) paths.push(found);
    for(const p of paths.map(p => p.replace(/\s+/g, "")))
    {
        checked++;
        if(FORBIDDEN.some(re => re.test(p))) problems.push(`src/rust/x86tpl/${file}: ${p}`);
        // (x86tpl/mod.rs's own modules are its children; super:: from them stays in x86tpl)
        if(file === "mod.rs" && p.startsWith("super::")) problems.push(`src/rust/x86tpl/${file}: ${p} leaves x86tpl`);
        if(/^super::super\b/.test(p)) problems.push(`src/rust/x86tpl/${file}: ${p} leaves x86tpl`);
    }
}
if(problems.length)
{
    console.error("x86tpl names an engine (docs/jit-unification-plan.md P2.10):\n  " + problems.join("\n  "));
    process.exit(1);
}
console.log(`check_x86tpl_imports: ${checked} paths in src/rust/x86tpl, none into an engine`);
