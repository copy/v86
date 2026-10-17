#!/usr/bin/env node
// The A64 page tier's access cache across ASID switches and TLBIs
// (docs/jit-unification-plan.md P6.4; tests/a64/asid.c): the same output on
// QEMU, the interpreter, and the page tier with a64_asid_tag 0, 1 and 2 (auto)
import assert from "node:assert/strict";
import { build, reference, actual } from "./guest_runner.mjs";

const directory = build("asid", [new URL("asid.c", import.meta.url).pathname]);
const text = result => {
    assert.equal(result.status, "ok", result.text);
    return result.text.trim();
};
const expected = text(await reference(directory));
delete process.env.A64_MMU;
delete process.env.A64_JIT;
assert.equal(text(await actual(directory)), expected, "the interpreter against QEMU");
process.env.A64_JIT = "1";
for(const tag of [0, 1, 2])
{
    process.env.A64_JIT_SWITCHES = `a64_asid_tag=${tag}`;
    const result = await actual(directory);
    assert.equal(text(result), expected, `the page tier with a64_asid_tag=${tag} against QEMU`);
    const t = result.page_tier;
    console.log(`a64_asid_tag=${tag}: ${t.retired} native instructions, ${t.access_fills} access cache fills`);
}
console.log(expected.split("\n").slice(-1)[0]);
console.log("asid: passed");
