#!/usr/bin/env node
// AArch32's speed against A64's (docs/aarch32-plan.md Q6.4): the integer
// kernels of tests/bench/src, the same C, built for A64 (run at EL1), A32
// and T32 (armv7, run at EL0 under the 64-bit EL1: tests/a64/aarch32/bench.c)
// and timed on v86 with the page tier (A64_JIT=1 unless A64_BENCH_JIT=0;
// a64_page_aarch32 as A64_AARCH32_PAGE says, default 1): the host's time of
// each run less that of a run of no iterations (the machine's start; the
// guest's counter is the harness's clock); the checksums of the three
// builds must agree. The gate: 32-bit takes at most twice A64's time (the
// geometric mean of the kernels). --arm32 (R5.3's E level): the A32 and T32
// builds run at PL1 on cpu_type "arm32" instead (tests/a32/bench.c: the
// 32-bit kernel's view, the MMU on with short descriptors).
//
//   node tests/a64/aarch32_bench.mjs [--kernels hash,sort,...] [--scale N] [--arm32]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build, actual, root } from "./guest_runner.mjs";
import { build32 as build_arm32, actual32 } from "../a32/runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
// (tests/bench/suite.json's iterations, divided by the scale; not chase,
// whose 2 MiB list the A64 image's layout has no room for, nor muldiv,
// whose 64-bit divisions are AEABI library calls on armv7)
const KERNELS = { bytecode: 310, vcall: 490, strings: 85, bitboard: 370, recursion: 390, lz: 13, hash: 66, sort: 24 };
const names = option("--kernels", Object.keys(KERNELS).join(",")).split(",");
const SCALE = +option("--scale", 0.1);
const arm32 = args.includes("--arm32");

const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout.match(/host: (\S+)/)[1];
const lld = process.env.LD_LLD || `${spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).stdout.trim()}/lib/rustlib/${host}/bin/rust-lld`;
const clang = process.env.CLANG || "clang";
const run = (program, list) => {
    const r = spawnSync(program, list, { encoding: "utf8" });
    assert.equal(r.status, 0, program + " " + list.join(" ") + "\n" + r.stderr);
    return r.stdout;
};

// the 32-bit builds: linked at EL0's alias of PHYSICAL (el0_map.h), stack 8 MiB up
const PHYSICAL = 0x44000000, BASE = PHYSICAL + 0x80000000;
const COMMON = ["-O2", "-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-fno-vectorize", "-fno-slp-vectorize"];

function build32(name, source, iterations, thumb)
{
    const directory = `${root}build/a64-aarch32-bench/${name}-${iterations}-${thumb ? "t32" : "a32"}/`;
    fs.mkdirSync(directory, { recursive: true });
    const target = ["--target=armv7a-none-eabi", "-march=armv8-a", "-mfloat-abi=soft", thumb ? "-mthumb" : "-marm"];
    const objects = [];
    for(const [file, extra] of [[source, []], [root + "tests/a64/aarch32/bench_rt.c", ["-DBENCH32"]],
        [root + "tests/a64/aarch32/bench_start.S", thumb ? ["-DTHUMB"] : []]])
    {
        const object = directory + path.basename(file).replace(/\.[cS]$/, ".o");
        run(clang, [...target, ...COMMON, ...extra, "-c", "-o", object, file]);
        objects.push(object);
    }
    // (data in pages of its own, as a program's: writes into a page of code recompile it)
    const script = directory + "link.ld";
    fs.writeFileSync(script, `ENTRY(_start)
SECTIONS
{
    . = 0x${BASE.toString(16)};
    .text : { *(.text.start) *(.text .text.*) }
    .rodata : { *(.rodata .rodata.*) }
    . = ALIGN(4096);
    .data : { *(.data .data.*) }
    . = ALIGN(16);
    __bss_start = .;
    .bss : { *(.bss .bss.* COMMON) }
    __bss_end = ALIGN(16);
    __stack_top = 0x${(BASE + 0x800000).toString(16)};
}
`);
    run(lld, ["-flavor", "gnu", "-m", "armelf", "-T", script, "-o", directory + "bench.elf", ...objects]);
    run(lld, ["-flavor", "gnu", "-m", "armelf", "-T", script, "--oformat=binary", "-o", directory + "bench.bin", ...objects]);
    const symbols = Object.fromEntries(run(process.env.NM || "nm", [directory + "bench.elf"])
        .split("\n").map(l => l.split(" ")).filter(p => p.length === 3).map(([a, , s]) => [s, parseInt(a, 16)]));
    const wrapper = directory + "bench32.S";
    fs.writeFileSync(wrapper, `    .section .rodata\n    .balign 4096\n    .global bench32\nbench32:\n    .incbin "${directory}bench.bin"\n` +
        `    .global bench32_end\nbench32_end:\n`);
    return build(`aarch32-bench-${name}-${iterations}-${thumb ? "t32" : "a32"}`, [root + "tests/a64/aarch32/bench.c", root + "tests/a64/aarch32/el0_run.S", wrapper], {
        cflags: [`-DITERATIONS=${iterations}`, `-DNAME="${name}"`, "-DBENCH32", "-DA64_MMU", `-DBENCH32_PHYSICAL=0x${PHYSICAL.toString(16)}UL`,
            `-DBENCH32_BASE=0x${BASE.toString(16)}UL`, `-DBENCH32_ENTRY=0x${symbols._start.toString(16)}UL`, `-DBENCH32_BSS_START=0x${symbols.__bss_start.toString(16)}UL`,
            `-DBENCH32_BSS_END=0x${symbols.__bss_end.toString(16)}UL`, `-DBENCH32_THUMB=${thumb ? 1 : 0}`],
    });
}

process.env.A64_MMU = "1";
if(process.env.A64_BENCH_JIT !== "0")
{
    process.env.A64_JIT = "1";
    process.env.A64_JIT_HOT = process.env.A64_JIT_HOT || "2000";
    process.env.A64_JIT_SWITCHES = "a64_page_aarch32=" + (process.env.A64_AARCH32_PAGE || "1");
}
const builds = (name, source, iterations) => [
    ["a64", build(`aarch32-bench-${name}-${iterations}-a64`, [root + "tests/a64/aarch32/bench.c", source, root + "tests/a64/aarch32/bench_rt.c"],
        { cflags: [`-DITERATIONS=${iterations}`, `-DNAME="${name}"`, "-fno-vectorize", "-fno-slp-vectorize"], general_regs_only: true })],
    ...(arm32 ? [false, true].map(thumb => [thumb ? "t32" : "a32", build_arm32(`bench-${name}-${iterations}-${thumb ? "t32" : "a32"}`,
        [root + "tests/a32/bench.c", source, root + "tests/a64/aarch32/bench_rt.c"],
        { cflags: [`-DITERATIONS=${iterations}`, `-DNAME="${name}"`, "-fno-vectorize", "-fno-slp-vectorize"], thumb })]) : [
        ["a32", build32(name, source, iterations, false)],
        ["t32", build32(name, source, iterations, true)],
    ]),
];
/** a run: its checksum and the host's milliseconds */
async function measure(directory, what, kind)
{
    const started = performance.now();
    const r = arm32 && kind !== "a64" ?
        await actual32(directory, { timeout: +(process.env.A64_BENCH_TIMEOUT || 600000) }) :
        await actual(directory, { timeout: +(process.env.A64_BENCH_TIMEOUT || 600000), options: { cpu_profile: "generic-arm64-compat32" } });
    const ms = performance.now() - started;
    assert.equal(r.status, "ok", `${what}: ${r.status}\n${r.text}`);
    assert.ok(!/an exception/.test(r.text), `${what}: ${r.text}`);
    const m = r.text.match(/checksum (\w+)/);
    assert.ok(m, `${what}: ${r.text}`);
    return { checksum: m[1], ms };
}
// (the machine's start: a run of no iterations, the best of three)
const baseline = {};
for(const [kind, directory] of builds(names[0], `${root}tests/bench/src/${names[0]}.c`, 0))
{
    const times = [];
    for(let i = 0; i < 3; i++) times.push((await measure(directory, kind + " baseline", kind)).ms);
    baseline[kind] = Math.min(...times);
}
console.log(`baseline (the machine's start): ${Object.entries(baseline).map(([k, v]) => k + " " + v.toFixed(0) + " ms").join(", ")}`);
const results = [];
for(const name of names)
{
    const source = `${root}tests/bench/src/${name}.c`;
    const iterations = Math.max(1, Math.round(KERNELS[name] / SCALE));
    const row = { name, iterations };
    for(const [kind, directory] of builds(name, source, iterations))
    {
        const m = await measure(directory, `${name} ${kind}`, kind);
        row[kind] = { checksum: m.checksum, ms: Math.max(1, m.ms - baseline[kind]) };
    }
    assert.equal(row.a32.checksum, row.a64.checksum, name + ": A32's checksum is A64's");
    assert.equal(row.t32.checksum, row.a64.checksum, name + ": T32's checksum is A64's");
    console.log(`${name}: A64 ${row.a64.ms.toFixed(0)} ms, A32 ${row.a32.ms.toFixed(0)} ms (x${(row.a32.ms / row.a64.ms).toFixed(2)}), ` +
        `T32 ${row.t32.ms.toFixed(0)} ms (x${(row.t32.ms / row.a64.ms).toFixed(2)})`);
    results.push(row);
}
const mean = kind => Math.exp(results.reduce((n, r) => n + Math.log(r[kind].ms / r.a64.ms), 0) / results.length);
console.log(`aarch32 bench${arm32 ? " (arm32, PL1)" : ""}: 32-bit against A64 (geometric means): A32 x${mean("a32").toFixed(2)}, T32 x${mean("t32").toFixed(2)}`);
