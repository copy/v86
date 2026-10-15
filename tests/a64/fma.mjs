#!/usr/bin/env node
// The A64 page tier's FP fast path (docs/arm64-virt-android16-plan.md P6,
// "A64 JIT 的语义红线"; J2): a hot loop of the four scalar multiply-adds,
// divisions, multiplications and additions with FPSR.IXC set (tests/a64/fma.c)
// gives the same bits and FPSR on QEMU, the interpreter, and the page tier
// with a64_relaxed_fma off and on; where the host fuses relaxed SIMD's
// multiply-adds, the compiled loop calls no helper (SoftFloat) at all.
import assert from "node:assert/strict";
import { build, reference, actual } from "./guest_runner.mjs";

process.env.A64_MMU = "1";
const ROUNDS = 20000;
const directory = build("fma", [new URL("fma.c", import.meta.url).pathname], { cflags: [`-DROUNDS=${ROUNDS}`] });
const line = result => {
    assert.equal(result.status, "ok", result.text);
    return result.text.trim();
};
const expected = line(await reference(directory));
delete process.env.A64_JIT;
assert.equal(line(await actual(directory)), expected, "the interpreter against QEMU");
process.env.A64_JIT = "1";
for(const fma of [0, 1])
{
    process.env.A64_JIT_SWITCHES = `a64_relaxed_fma=${fma}`;
    let result;
    try
    {
        result = await actual(directory);
    }
    catch(e)
    {
        // (a host that does not fuse refuses a64_relaxed_fma=1)
        if(fma && /cannot be 1/.test(String(e))) { console.log("fma: the host does not fuse relaxed multiply-adds"); continue; }
        throw e;
    }
    assert.equal(line(result), expected, `the page tier with a64_relaxed_fma=${fma} against QEMU`);
    const t = result.page_tier;
    console.log(`a64_relaxed_fma=${fma}: ${t.retired} native instructions, ${t.helpers} helper calls`);
    if(fma) assert.ok(t.helpers < 100, `the fused loop calls the SoftFloat helpers ${t.helpers} times`);
}
console.log(`fma: ${expected}; passed`);
