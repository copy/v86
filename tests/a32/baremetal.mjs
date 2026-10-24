#!/usr/bin/env node
// The bare-metal AArch32 guests (tests/a32/runner.mjs) on QEMU's cortex-a15
// and on v86 (cpu_type "arm32"): each the same output (docs/aarch32-plan.md
// R2-R4). system.c: the modes, the exceptions, CP15, VFP's enables; mmu.c:
// the short and long descriptors; platform.c: PSCI, the timers and the
// GICv3 CPU interface, a second core.
//
//   node tests/a32/baremetal.mjs [name...]     A32_TARGET=qemu|v86 runs one side
import { build32, compare, root } from "./runner.mjs";

const TESTS = {
    system: { sources: ["system.c", "system_asm.S"] },
    mmu: { sources: ["mmu.c", "mmu_asm.S", "system_asm.S"] },
    platform: { sources: ["platform.c"], cores: 2 },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TESTS);
let failures = 0;
for(const name of names)
{
    const test = TESTS[name];
    if(!test) throw new Error("no test " + name + "; there are " + Object.keys(TESTS).join(", "));
    const directory = build32(name, test.sources.map(s => root + "tests/a32/" + s));
    const results = await compare(directory, { timeout: 30000, cores: test.cores || 1 });
    let failed = false;
    for(const [target, r] of Object.entries(results))
    {
        if(r.status !== "ok") { console.log(`${name} on ${target}: ${r.status}\n${r.text}`); failed = true; }
    }
    if(results.qemu && results.v86)
    {
        const a = results.qemu.text.split("\n"), b = results.v86.text.split("\n");
        for(let i = 0; i < Math.max(a.length, b.length); i++)
        {
            if(a[i] !== b[i]) { console.log(`${name}: line ${i + 1}\n  qemu: ${a[i]}\n  v86:  ${b[i]}`); failed = true; }
        }
        if(!failed) console.log(`PASS: ${name}: ${a.length} lines the same`);
    }
    else for(const [target, r] of Object.entries(results)) console.log(`${name} on ${target}:\n${r.text}`);
    failures += failed;
}
process.exit(failures ? 1 : 0);
