#!/usr/bin/env node
// tests/a64/platform_probe.c (PSCI over HVC, HVC #1, SMC, loads from
// physical addresses with nothing mapped) against the reference's results in
// tests/a64/platform_probe.expected, which v86's virt machine copies
// (docs/arm64-virt-android16-plan.md P0.2 and the profile's IMPLEMENTATION
// DEFINED choices). A64_TARGET=qemu|v86; A64_PLATFORM_RECORD=1 rewrites the
// expected file from the QEMU reference.
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, root, target } from "./guest_runner.mjs";

const machine = target();
const expected_file = root + "tests/a64/platform_probe.expected";
const result = await machine.run(build("platform-probe", [root + "tests/a64/platform_probe.c"]));
assert.equal(result.status, "ok", result.text);
if(process.env.A64_PLATFORM_RECORD)
{
    assert.equal(machine.name, "qemu", "the expected results come from the reference");
    fs.writeFileSync(expected_file, result.text);
    console.log("wrote " + expected_file);
}
else
{
    assert.equal(result.text, fs.readFileSync(expected_file, "latin1"), machine.name + " differs from platform_probe.expected");
    console.log(`platform probe: ${machine.name} matches (${result.text.trim().split("\n").length} checks)`);
}
