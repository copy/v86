#!/usr/bin/env node
// The profile completeness report of docs/arm64-virt-android16-plan.md P9.4
// (G-Alpine) for tests/platform/a64-profile.json's profile:
//
// - encodings: every class of the Arm ARM's encoding index in
//   tests/a64/encodings.json has a status (implemented, UNDEF, HINT, ID
//   space) and the tests that cover it (the decoder against llvm-mc over
//   every class is tests/a64/decode_check.mjs, make a64-decode-tests);
// - ID registers: v86's, read at EL1 on one and four cores, equal the
//   profile's with no difference (tools/cpu_contract.mjs --a64-v86); with
//   --reference also the QEMU reference's within the allowed differences
//   (--a64-reference);
// - HWCAP: what Linux reports on v86 (the probe's hwcap and hwcap2, the
//   latest results of tests/a64/linux_boot.mjs in build/a64-linux/, every
//   kernel) against the profile's;
// - granules: the page size those results report for each kernel (4, 16
//   and 64 KiB), and with --kvm kvm-unit-tests arm64 at 4k, 16k and 64k on
//   v86 (tests/kvm-unit-tests/arm64.mjs).
//
// Writes build/a64-linux/profile-report.json, prints Markdown, exits 1 if
// an item is incomplete.
//
//   node tools/a64_profile_report.mjs [--reference] [--kvm]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const profile = JSON.parse(fs.readFileSync(ROOT + "/tests/platform/a64-profile.json", "utf8"));
const encodings = JSON.parse(fs.readFileSync(ROOT + "/tests/a64/encodings.json", "utf8"));
const report = { profile: profile.profile, items: {} };
let complete = true;
const item = (name, ok, details) => {
    report.items[name] = { ok, ...details };
    complete &&= ok;
};

// encodings
{
    const statuses = Object.keys(encodings.statuses);
    const counts = Object.fromEntries(statuses.map(s => [s, 0]));
    const unlisted = [], untested = [];
    for(const c of encodings.classes)
    {
        if(!statuses.includes(c.status)) unlisted.push(c.class);
        else counts[c.status]++;
        if(!c.tests || !c.tests.length) untested.push(c.class);
    }
    item("encodings", !unlisted.length && !untested.length,
        { classes: encodings.classes.length, counts, unclassified: unlisted, without_tests: untested });
}

function run(command, command_args, env = {})
{
    const started = performance.now();
    const r = spawnSync(command, command_args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
    return { ok: r.status === 0, seconds: Math.round((performance.now() - started) / 1000), tail: (r.stdout + r.stderr).trim().split("\n").slice(-3) };
}

// ID registers
{
    const v86 = run("node", ["tools/cpu_contract.mjs", "--a64-v86"]);
    const details = { v86 };
    let ok = v86.ok;
    if(args.includes("--reference"))
    {
        details.reference = run("node", ["tools/cpu_contract.mjs", "--a64-reference"]);
        ok &&= details.reference.ok;
    }
    item("id_registers", ok, details);
}

// HWCAP and the granules, from the latest Linux results
{
    const directory = ROOT + "/build/a64-linux/";
    const PAGE = { "16k": 16384, "64k": 65536 };
    const kernels = {};
    for(const file of fs.readdirSync(directory).filter(f => /^result-v86-.*\.json$/.test(f)).sort())
    {
        const result = JSON.parse(fs.readFileSync(directory + file, "utf8"));
        const ok = typeof result.ok === "string" && result.ok.match(/page_size=(\d+) hwcap=(0x[0-9a-f]+) hwcap2=(0x[0-9a-f]+)/);
        if(!ok) continue;
        const kernel = result.tag.match(/-(16k|64k|androidish)-\d+c$/)?.[1] || "stock";
        const k = kernels[kernel] ||= { runs: 0, page_sizes: [], hwcaps: [], hwcap2s: [] };
        k.runs++;
        for(const [list, value] of [[k.page_sizes, +ok[1]], [k.hwcaps, ok[2]], [k.hwcap2s, ok[3]]]) if(!list.includes(value)) list.push(value);
    }
    const hwcap_ok = Object.keys(kernels).length > 0 && Object.values(kernels).every(k => k.hwcaps.length === 1 &&
        +k.hwcaps[0] === +profile.hwcap.value && k.hwcap2s.length === 1 && +k.hwcap2s[0] === 0);
    item("hwcap", hwcap_ok, { profile: profile.hwcap, kernels });
    const granules = Object.fromEntries(Object.entries(kernels).map(([name, k]) => [name, k.page_sizes]));
    let granule_ok = ["stock", "16k", "64k"].every(name => kernels[name]) &&
        Object.entries(kernels).every(([name, k]) => k.page_sizes.length === 1 && k.page_sizes[0] === (PAGE[name] || 4096));
    const details = { linux_page_sizes: granules };
    if(args.includes("--kvm"))
    {
        details.kvm_unit_tests = run("node", ["tests/kvm-unit-tests/arm64.mjs", "4k", "16k", "64k"]);
        granule_ok &&= details.kvm_unit_tests.ok;
    }
    item("granules", granule_ok, details);
}

fs.writeFileSync(ROOT + "/build/a64-linux/profile-report.json", JSON.stringify(report, null, 2) + "\n");
const e = report.items.encodings, h = report.items.hwcap, g = report.items.granules, i = report.items.id_registers;
const mark = ok => ok ? "complete" : "INCOMPLETE";
console.log(`Profile \`${report.profile}\`:\n`);
console.log("| Item | | Result |\n| --- | --- | --- |");
console.log(`| Encodings | ${mark(e.ok)} | ${e.classes} classes of the encoding index: ` +
    Object.entries(e.counts).map(([s, n]) => `${n} ${s}`).join(", ") + `; every one with its tests (tests/a64/encodings.json) |`);
console.log(`| ID registers | ${mark(i.ok)} | v86's equal the profile's, 1 and 4 cores (\`cpu_contract.mjs --a64-v86\`)` +
    (i.reference ? `; the reference's within the allowed differences (\`--a64-reference\`)` : "") + " |");
console.log(`| HWCAP | ${mark(h.ok)} | ${profile.hwcap.value} (${profile.hwcap.names}), HWCAP2 0, on the kernels ` +
    Object.entries(h.kernels).map(([name, k]) => `${name} (${k.runs} runs)`).join(", ") + " |");
console.log(`| Granules | ${mark(g.ok)} | Linux's page size ` + Object.entries(g.linux_page_sizes).map(([name, s]) => `${name} ${s.join("/")}`).join(", ") +
    (g.kvm_unit_tests ? `; kvm-unit-tests arm64 4k/16k/64k ${g.kvm_unit_tests.ok ? "pass" : "FAIL"}` : "") + " |");
process.exit(complete ? 0 : 1);
