#!/usr/bin/env node
// v86's choices among AArch32's CONSTRAINED UNPREDICTABLE behaviours at EL0
// (docs/arm32.md, docs/aarch32-plan.md): the cases of
// tests/a64/aarch32/unpredictable.a32.S under tests/a64/aarch32/el0.c with
// profile v3, interpreted and on the page tier (a64_page_aarch32 1, native,
// and 2, helper calls only; compiling at the first boundary). QEMU 9.2 takes
// T32's LDM and STM of one register as UNDEFINED where v86 (like Cortex-A
// cores and the Android emulator's QEMU) transfers it, so the exits are
// checked against the values here; the three runs must print the same.
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, actual, root } from "./guest_runner.mjs";

process.env.A64_MMU = "1";
const directory = build("aarch32-unpredictable", [root + "tests/a64/aarch32/el0.c", root + "tests/a64/aarch32/el0_run.S",
    root + "tests/a64/aarch32/unpredictable.a32.S"], { cflags: ["-DCASES=unpredictable_a32", "-DA64_MMU"] });
const binary = fs.readFileSync(directory + "unpredictable.a32.bin");

// per case: the SVC it ends with and registers' values (r10: how far the
// base moved), or the instruction (hw1 << 16 | hw2) that is UNDEFINED
const CASES = [
    { name: "ldm.w r8!, {r0}", svc: 1, r: { 0: 0x11223344, 10: 4 } },
    { name: "ldm.w r8, {r0}", svc: 2, r: { 0: 0x55667788, 10: 0 } },
    { name: "stm.w r8!, {r1}", svc: 3, r: { 0: 0x99AABBCC, 2: 0, 10: 4 } },
    { name: "stm.w r8, {r1}", svc: 4, r: { 0: 0xDDEEFF00, 10: 0 } },
    { name: "ldmdb r8!, {r0}", svc: 5, r: { 0: 0x13572468, 10: -4 } },
    { name: "stmdb r8!, {r1}", svc: 6, r: { 0: 0x75318642, 2: 0, 10: -4 } },
    { name: "ldm.w r8!, {lr}", svc: 7, r: { 14: 0xC0DECAFE, 10: 4 } },
    { name: "ldm.w r8, {pc}", svc: 8, r: { 0: 0x42, 10: 0 } },
    { name: "ldm.w in IT blocks", svc: 9, r: { 0: 0x22221111, 2: 0, 10: 4 } },
    { name: "ldm.w r8!, {r0} in a loop", svc: 10, r: { 6: 6, 10: 12 } },
    { name: "A32 ldm r8!, {r0}", svc: 11, r: { 0: 0xA5A55A5A, 10: 4 } },
    { name: "ldm.w r8!, {r8}", undefined: 0xE8B80100 },
    { name: "ldm.w r8, {}", undefined: 0xE8980000 },
    { name: "ldm.w r8, {sp}", undefined: 0xE8982000 },
    { name: "stm.w r8, {pc}", undefined: 0xE8888000 },
];

/** The driver's exits: per case its ESR, ELR (an offset into the binary) and R0-R14 */
function exits(text)
{
    const lines = text.split("\n");
    const result = [];
    for(let i = 0; i < lines.length; i++)
    {
        const m = lines[i].match(/^case (\d+)\.0: vector \d+ esr ([0-9a-f]+) elr ([+-]\d+)/);
        if(!m) continue;
        const r = lines[i + 1].trim().split(" ").map(v => Number(BigInt("0x" + v) & 0xFFFFFFFFn));
        result[+m[1]] = { esr: parseInt(m[2], 16), elr: +m[3], r };
    }
    return result;
}

const runs = [["interpreter", null], ["page tier", 1], ["page tier, helper calls", 2]];
let reference_text = null;
let failures = 0;
for(const [name, page] of runs)
{
    if(page === null) delete process.env.A64_JIT;
    else
    {
        process.env.A64_JIT = "1";
        process.env.A64_JIT_HOT = "1";
        process.env.A64_JIT_SWITCHES = "a64_page_aarch32=" + page;
    }
    const result = await actual(directory, { options: { cpu_profile: "generic-arm64-compat32" } });
    assert.equal(result.status, "ok", name + ": " + result.status + "\n" + result.text);
    if(page !== null) assert.ok(result.page_tier.compiled > 0, name + ": nothing compiled " + JSON.stringify(result.page_tier));
    const got = exits(result.text);
    assert.equal(got.length, CASES.length, name + ": the exits\n" + result.text);
    CASES.forEach((c, i) => {
        const e = got[i];
        const problems = [];
        if(c.undefined !== undefined)
        {
            const word = binary.readUInt16LE(e.elr) << 16 | binary.readUInt16LE(e.elr + 2);
            if(e.esr >>> 26 !== 0) problems.push(`ESR ${e.esr.toString(16)}, not an UNDEFINED instruction's`);
            else if(word >>> 0 !== c.undefined) problems.push(`ELR at ${(word >>> 0).toString(16)}`);
        }
        else
        {
            if(e.esr >>> 26 !== 0x11 || (e.esr & 0xFFFF) !== c.svc) problems.push(`ESR ${e.esr.toString(16)}, not SVC #${c.svc}'s`);
            for(const [r, value] of Object.entries(c.r))
            {
                if(e.r[r] !== value >>> 0) problems.push(`r${r} ${e.r[r].toString(16)}, not ${(value >>> 0).toString(16)}`);
            }
        }
        if(problems.length)
        {
            failures++;
            console.log(`FAIL: ${name}: case ${i} (${c.name}): ${problems.join(", ")}`);
        }
    });
    if(reference_text === null) reference_text = result.text;
    else if(result.text !== reference_text)
    {
        failures++;
        const a = reference_text.split("\n"), b = result.text.split("\n");
        const first = a.findIndex((line, i) => line !== b[i]);
        console.log(`FAIL: ${name}: differs from the interpreter at line ${first + 1}\n  interpreter: ${a[first]}\n  ${name}: ${b[first]}`);
    }
    const t = result.page_tier;
    console.log(`${name}: ${CASES.length} cases checked` + (page === null ? "" : ` (${t.compiled} compiles, ${t.helpers} helper calls, ${t.steps} steps)`));
}
if(!failures) console.log(`PASS: ${CASES.length} cases, the same interpreted and on the page tier`);
process.exit(failures ? 1 : 0);
