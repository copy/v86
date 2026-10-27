#!/usr/bin/env node
// FEAT_PAN (profile v2, cpu_profile: "generic-arm64"; tests/a64/pan.c): the same
// output on QEMU's -cpu max (the cortex-a35 reference has no PAN), the
// interpreter and the page tier; profile v1.1 has no PAN (the test says so
// and stops).
import assert from "node:assert/strict";
import { build, reference, actual } from "./guest_runner.mjs";

const directory = build("pan", [new URL("pan.c", import.meta.url).pathname]);
const text = result => {
    assert.equal(result.status, "ok", result.text);
    return result.text.trim();
};
const expected = text(await reference(directory, { extra: ["-cpu", "max,pmu=off,sve=off,cntfrq=1000000000"] }));
assert.match(expected, /^FEAT_PAN: yes/, "QEMU's -cpu max has PAN");
delete process.env.A64_MMU;
delete process.env.A64_JIT;
const v2 = { options: { cpu_profile: "generic-arm64" } };
assert.equal(text(await actual(directory, v2)), expected, "the interpreter against QEMU");
process.env.A64_JIT = "1";
const jit = await actual(directory, v2);
assert.equal(text(jit), expected, "the page tier against QEMU");
console.log(`page tier: ${jit.page_tier.retired} native instructions, ${jit.page_tier.access_fills} access cache fills`);
delete process.env.A64_JIT;
const v1 = await actual(directory, { options: { cpu_profile: "generic-arm64-v1.1" } });
assert.equal(v1.text.trim(), "FEAT_PAN: no", "profile v1.1 has no PAN");
console.log(expected);
console.log("pan: passed");
