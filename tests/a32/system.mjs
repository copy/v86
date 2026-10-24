#!/usr/bin/env node
// tests/a32/system.c on QEMU's cortex-a15 and on v86 (cpu_type "arm32"): the
// same output (docs/aarch32-plan.md R2). A32_TARGET=qemu|v86 runs one.
import { build32, compare, root } from "./runner.mjs";

const directory = build32("system", [root + "tests/a32/system.c", root + "tests/a32/system_asm.S"]);
const results = await compare(directory, { timeout: 30000 });
let failed = false;
for(const [name, r] of Object.entries(results))
{
    if(r.status !== "ok") { console.log(`${name}: ${r.status}\n${r.text}`); failed = true; }
}
if(results.qemu && results.v86)
{
    const a = results.qemu.text.split("\n"), b = results.v86.text.split("\n");
    for(let i = 0; i < Math.max(a.length, b.length); i++)
    {
        if(a[i] !== b[i]) { console.log(`line ${i + 1}\n  qemu: ${a[i]}\n  v86:  ${b[i]}`); failed = true; }
    }
    if(!failed) console.log(`PASS: system: ${a.length} lines the same`);
}
else for(const [name, r] of Object.entries(results)) console.log(`${name}:\n${r.text}`);
process.exit(failed ? 1 : 0);
