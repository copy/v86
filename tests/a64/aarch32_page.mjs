#!/usr/bin/env node
// AArch32's page functions against the interpreter (docs/aarch32-plan.md
// Q6): the AArch32 EL0 cases (tests/a64/aarch32/*.a32.S: branches and
// interworking, IT blocks and an exception inside one, VFP and Advanced
// SIMD traps) on v86 with the MMU on, interpreted and with the page tier
// (a64_page_aarch32, compiling at the first boundary); the outputs must be
// the same. A64_AARCH32_CASES: the case files (default q1,q3,q4);
// A64_AARCH32_PAGE: the switch's value (1; 2 helper calls only, 3 native
// branches only).
import assert from "node:assert/strict";
import { build, actual, root } from "./guest_runner.mjs";

process.env.A64_MMU = "1";
let failures = 0;
for(const cases of (process.env.A64_AARCH32_CASES || "q1,q3,q4").split(","))
{
    const directory = build("aarch32-page-" + cases, [root + "tests/a64/aarch32/el0.c", root + "tests/a64/aarch32/el0_run.S",
        root + `tests/a64/aarch32/${cases}.a32.S`], { cflags: [`-DCASES=${cases}_a32`, "-DA64_MMU"] });
    delete process.env.A64_JIT;
    const interpreted = await actual(directory, { options: { cpu_profile: "generic-arm64-compat32" } });
    process.env.A64_JIT = "1";
    process.env.A64_JIT_HOT = "1";
    process.env.A64_JIT_SWITCHES = "a64_page_aarch32=" + (process.env.A64_AARCH32_PAGE || "1");
    const compiled = await actual(directory, { options: { cpu_profile: "generic-arm64-compat32" } });
    assert.equal(interpreted.status, "ok", cases + " (interpreter): " + interpreted.status);
    assert.equal(compiled.status, "ok", cases + " (page tier): " + compiled.status);
    const a = interpreted.text.split("\n"), b = compiled.text.split("\n");
    const first = a.findIndex((line, i) => line !== b[i]);
    if(first >= 0 || a.length !== b.length)
    {
        failures++;
        console.log(`${cases}: differs at line ${first + 1}\n  interpreter: ${a[first]}\n  page tier:   ${b[first]}`);
        continue;
    }
    const t = compiled.page_tier;
    console.log(`PASS: ${cases}: the same (page tier: ${t.compiled} compiles, ${t.helpers} helper calls, ${t.steps} steps)`);
}
process.exit(failures ? 1 : 0);
