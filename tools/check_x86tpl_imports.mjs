#!/usr/bin/env node
// The import rules of the shared JIT modules, checked on every crate:: and
// super:: path in their code (comments and strings stripped), and that a
// super:: path stays in the module:
//
// - src/rust/x86tpl (docs/jit-unification-plan.md P2.10): the x86 leaf
//   templates are shared by every x86 engine, so they name none of them: not
//   the x64 page tier (crate::x64) nor the JIT's composition root
//   (crate::jit); the region pipeline and its runtime (crate::ir) went in
//   M11, and no crate::ir path resolves.
// - src/rust/jitrt (P5.1, cross-phase rule 12): the ISA-neutral runtime
//   names only std, crate::page, crate::wasmgen and crate::leb (and itself),
//   and has no feature = "aarch64": ISA differences come through
//   jitrt::host::Env or type parameters.
// - src/rust/pagegen (P5.9): the page functions' neutral skeleton names only
//   std, crate::wasmgen, crate::leb, crate::jitrt and itself, and has no
//   feature = "aarch64": the ISAs implement its PageEmitter.
//
// Usage: tools/check_x86tpl_imports.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const MODULES = [
    { name: "x86tpl", rule: "names an engine (P2.10)", allowed: p => !/^crate::(x64|jit)\b/.test(p) },
    { name: "jitrt", rule: "names something but std, page, wasmgen and leb (P5.1)",
        allowed: p => /^crate::(page|wasmgen|leb|jitrt)\b/.test(p) || /^(super|self)::/.test(p) },
    { name: "pagegen", rule: "names something but std, wasmgen, leb and jitrt (P5.9)",
        allowed: p => /^crate::(wasmgen|leb|jitrt|pagegen)\b/.test(p) || /^(super|self)::/.test(p) },
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
const counts = [];
for(const { name, rule, allowed } of MODULES)
{
    const dir = path.join(ROOT, "src/rust", name);
    let checked = 0;
    for(const file of fs.readdirSync(dir).filter(f => f.endsWith(".rs")).sort())
    {
        const raw = fs.readFileSync(path.join(dir, file), "utf8"), text = code(raw);
        const where = `src/rust/${name}/${file}`;
        const without_comments = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if((name === "jitrt" || name === "pagegen") && /feature\s*=\s*"aarch64"/.test(without_comments)) problems.push(`${where}: feature = "aarch64" (cross-phase rule 12)`);
        const paths = [];
        for(const [, tree] of text.matchAll(/\buse\s+([^;]+);/g)) paths.push(...use_paths(tree.replace(/\s+/g, " ")));
        // (paths written out in the code, outside use declarations)
        for(const [found] of text.replace(/\buse\s+[^;]+;/g, "").matchAll(/\b(?:crate|super)(?:::\w+)+/g)) paths.push(found);
        for(const p of paths.map(p => p.replace(/\s+/g, "")))
        {
            checked++;
            if(/^(crate|super|self)::/.test(p) && !allowed(p)) problems.push(`${where}: ${p} ${rule}`);
            // (mod.rs's own modules are its children; super:: from them stays in the module)
            if(file === "mod.rs" && p.startsWith("super::")) problems.push(`${where}: ${p} leaves ${name}`);
            if(/^super::super\b/.test(p)) problems.push(`${where}: ${p} leaves ${name}`);
        }
    }
    counts.push(`${checked} paths in src/rust/${name}`);
}
if(problems.length)
{
    console.error("import rules of the shared JIT modules (docs/jit-unification-plan.md P2.10, P5.1):\n  " + problems.join("\n  "));
    process.exit(1);
}
console.log(`check_x86tpl_imports: ${counts.join(", ")}, all within their rules`);
