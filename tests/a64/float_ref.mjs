#!/usr/bin/env node
// QEMU's float_convs and float_madds (tests/tcg/multiarch, built from the
// fixed QEMU source tree as bare-metal guests, -O0 as QEMU builds them)
// against tests/tcg/aarch64/*.ref (docs/arm64-virt-android16-plan.md P0.5).
// The sources and references stay in the QEMU tree (A64_QEMU_SRC, default
// build/a64-ref/qemu-9.2.0); A64_TARGET=qemu|v86 picks the machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, root, target } from "./guest_runner.mjs";

const source = process.env.A64_QEMU_SRC || root + "build/a64-ref/qemu-9.2.0/";
const multiarch = source + "tests/tcg/multiarch/";
assert.ok(fs.existsSync(multiarch + "float_convs.c"), "no QEMU source tree at " + source + " (P0.11)");
const machine = target();
let failed = 0;
for(const test of ["float_convs", "float_madds"])
{
    const directory = build(test.replace("_", "-"), [multiarch + test + ".c", multiarch + "libs/float_helpers.c"],
        { optimize: "-O0", cflags: ["-I", multiarch, "-fno-strict-aliasing"] });
    const result = await machine.run(directory);
    fs.writeFileSync(directory + machine.name + ".out", result.text);
    const expected = fs.readFileSync(source + `tests/tcg/aarch64/${test}.ref`, "latin1");
    if(result.status !== "ok" || result.text !== expected)
    {
        failed++;
        const lines = result.text.split("\n"), wanted = expected.split("\n");
        const first = lines.findIndex((line, i) => line !== wanted[i]);
        console.log(`${test}: ${result.status}, ${lines.length} lines (expected ${wanted.length}); first difference at line ${first + 1}:\n` +
            `  got:      ${lines[first]}\n  expected: ${wanted[first]}`);
    }
    else
    {
        console.log(`${test}: ${machine.name} matches ${test}.ref (${expected.split("\n").length - 1} lines)`);
    }
}
process.exit(failed ? 1 : 0);
