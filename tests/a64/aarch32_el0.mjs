#!/usr/bin/env node
// AArch32 EL0 under the bare-metal AArch64 EL1 (docs/aarch32-plan.md Q0.2,
// Q1): the cases of tests/a64/aarch32/*.a32.S, run by tests/a64/aarch32/el0.c
// on QEMU (cortex-a35, which has AArch32 EL0) and on v86 with profile v3;
// the outputs must be the same. A64_AARCH32_CASES=q1 (default): which binary.
// A64_AARCH32_REFERENCE_ONLY=1: QEMU's output only. A64_AARCH32_DRIVER: the
// EL1 driver, tests/a64/aarch32/<driver>.c (default el0).
import assert from "node:assert/strict";
import { build, reference, actual, root } from "./guest_runner.mjs";

const cases = process.env.A64_AARCH32_CASES || "q1";
// (A64_AARCH32_DRIVER=debug: tests/a64/aarch32/debug.c, the cases with the debug registers)
const driver = process.env.A64_AARCH32_DRIVER || "el0";
const directory = build("aarch32-" + cases, [root + `tests/a64/aarch32/${driver}.c`, root + "tests/a64/aarch32/el0_run.S",
    root + `tests/a64/aarch32/${cases}.a32.S`], { cflags: [`-DCASES=${cases}_a32`] });
const expected = await reference(directory);
assert.equal(expected.status, "ok", "QEMU: " + expected.status + "\n" + expected.text);
if(+process.env.A64_AARCH32_REFERENCE_ONLY)
{
    console.log(expected.text);
    process.exit(0);
}
const got = await actual(directory, { options: { cpu_profile: "generic-arm64-compat32" } });
const a = expected.text.split("\n"), b = got.text.split("\n");
for(let i = 0; i < Math.max(a.length, b.length); i++)
{
    if(a[i] !== b[i])
    {
        console.log(`first difference at line ${i + 1}:\n  QEMU: ${a[i]}\n  v86:  ${b[i]}\n(context: ${a.slice(Math.max(0, i - 2), i).join(" | ")})`);
        break;
    }
}
assert.equal(got.status, "ok", "v86: " + got.status);
assert.equal(got.text, expected.text, "v86's output is QEMU's");
console.log(`PASS: ${cases}: ${a.filter(l => l.startsWith("case")).length} exits as QEMU's`);
