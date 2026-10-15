#!/usr/bin/env node
// Release gate (the release levels of docs/acpi.md, docs/x86-64.md,
// docs/multicore.md and docs/q35.md): runs the acceptance targets of each release level,
// records per target the command,
// exit status, duration and log tail, together with the commit, the
// uncommitted changes, the toolchain and the host, and writes
// build/release-gate/<time>/report.{json,md} plus one log per target.
//
// Usage: tools/release_gate.mjs [--levels R-base,R-ACPI,R-SMP32,...] [--quick]
//                               [--list] [--dry-run] [--keep-going]
// --quick runs the short targets of each level only (the long guest runs,
// hours on the interpreter, are marked "long").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// release level -> [make target, long?]
const LEVELS = {
    // the existing 32-bit CPU regressions (references from gdb on x86 Linux,
    // else from QEMU: tests/nasm/qemu_oracle.js)
    "R-base": [
        ["nasmtests", true], ["nasmtests-force-jit", true],
    ],
    "R-ACPI": [
        ["acpi-device-tests"], ["acpi-table-tests"], ["acpi-guest-tests"], ["acpi-sleep-tests", true],
    ],
    "R-SMP32": [
        ["platform-contract-tests"], ["smp-tests"], ["multicore-boot-tests"], ["multicore-clock-tests"],
        ["multicore-coherence-tests"], ["multicore-atomic-tests"], ["multicore-memory-order-tests"],
        ["multicore-statistics-tests"], ["multicore-topology-tests"], ["multicore-state-tests", true],
        ["multicore-linux-tests", true], ["multicore-linux-jit-tests", true], ["multicore-os-stress-tests", true],
    ],
    "R-x64-UP": [
        ["x64-decode-tests"], ["x64-system-tests"], ["x64-differential-tests"], ["x64-page-tier-tests"],
        ["highmem-tests"], ["x64-guest-tests", true],
    ],
    "R-x64-SMP": [
        ["x64-multicore-tests"], ["x64-multicore-guest-tests", true],
    ],
    "R-parallel": [
        ["multicore-parallel-tests", true], ["multicore-parallel-tests-release", true], ["multicore-parallel-browser-tests"],
        ["multicore-parallel-bench", true],
    ],
    "R-extended-memory": [
        ["extended-memory-tests"], ["x64-extended-guest-tests", true],
    ],
    // SSSE3, SSE4.1 and SSE4.2 (docs/simd-xsave-plan.md M1: cpu_features
    // "x86-64-v2"): every engine against SDM models, QEMU and gdb references
    "R-SSE4": [
        ["platform-contract-tests"], ["ssse3-tests"], ["sse4-tests"], ["sse3-tests"], ["sse-fp-tests"], ["sse-fault-tests"],
        ["packed-simd-tests"], ["decode-rules-tests"], ["x64-decode-tests"], ["nasmtests", true], ["nasmtests-force-jit", true],
    ],
    // XSAVE with the x87 and SSE state (docs/simd-xsave-plan.md M2:
    // cpu_features "XSAVE"): the codec, XSETBV/XGETBV, the state's lifecycle
    // across reset, snapshots and core switches, kvm-unit-tests x86/xsave
    "R-XSAVE": [
        ["platform-contract-tests"], ["xsave-tests"], ["kvm-unit-test-xsave"],
    ],
    // AVX, VEX.128 and VEX.256 (docs/simd-xsave-plan.md M3: cpu_features
    // "XSAVE" and "AVX"): every engine against SDM models and QEMU, the
    // YMM state
    "R-AVX": [
        ["platform-contract-tests"], ["xsave-tests"], ["decode-rules-tests"], ["x64-decode-tests"], ["isa-forms-check"],
        ["x64-differential-tests"], ["x64-page-tier-tests"], ["avx-tests", true],
    ],
    // x86-64-v3 (docs/simd-xsave-plan.md M4: cpu_features "x86-64-v3" with
    // cpu_type "x86_64"; the 32-bit profile has its features but LZCNT):
    // AVX2 with the gathers, BMI1/BMI2/LZCNT/TZCNT/MOVBE, FMA and F16C in
    // every engine against SDM models and QEMU; glibc's x86-64-v3 code and
    // the YMM state in a real guest
    "R-x86-64-v3": [
        ["platform-contract-tests"], ["decode-rules-tests"], ["x64-decode-tests"], ["isa-forms-check"],
        ["x64-differential-tests"], ["x64-page-tier-tests"], ["bmi-tests"], ["fma-tests"],
        ["avx-tests", true], ["x64-glibc-tests", true],
    ],
    // the XSAVE family (M5: XSAVEOPT, XGETBV(1), XSAVEC, XSAVES and
    // IA32_XSS): formats, the init and modified optimizations, the kernel's
    // compacted format in a real guest
    "R-XSAVE-ext": [
        ["platform-contract-tests"], ["xsave-tests"], ["kvm-unit-test-xsave"], ["x64-glibc-tests", true],
    ],
    // machine_type "q35": chipset, ACPI tables, AHCI (docs/q35.md, docs/ahci.md)
    "R-q35": [
        ["acpi-table-tests"], ["q35-device-tests"], ["q35-guest-tests", true], ["q35-hotplug-tests", true],
    ],
    // the JIT's and the decoder's tests outside the x64 targets
    // (docs/jit-unification-plan.md P0.9; R-IR until M11 deleted the region
    // tiers, whose tests .github/workflows/ir-core.yml still names)
    "R-JIT": [
        ["jit-core-tests"],
    ],
};

const args = process.argv.slice(2);
const option = name => args.includes(name);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const levels = (value("--levels") || Object.keys(LEVELS).join(",")).split(",");
for(const level of levels) if(!LEVELS[level]) throw new Error("unknown level " + level + " (" + Object.keys(LEVELS).join(", ") + ")");
const quick = option("--quick");

if(option("--list"))
{
    for(const level of levels) console.log(level + ": " + LEVELS[level].map(([t, long]) => t + (long ? " (long)" : "")).join(", "));
    process.exit(0);
}

const run_text = (command, argv) => {
    const result = spawnSync(command, argv, { cwd: root, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
};
const environment = {
    time: new Date().toISOString(),
    commit: run_text("git", ["rev-parse", "HEAD"]),
    uncommitted: (run_text("git", ["status", "--short"]) || "").split("\n").filter(Boolean),
    diff_stat: run_text("git", ["diff", "--stat", "HEAD"])?.split("\n").at(-1) || null,
    node: process.version,
    rustc: run_text("rustc", ["--version"]),
    java: spawnSync("java", ["-version"], { encoding: "utf8" }).stderr?.split("\n")[0] || null,
    nasm: run_text("nasm", ["-v"]),
    clang: run_text("clang", ["--version"])?.split("\n")[0] || null,
    qemu: run_text("qemu-system-x86_64", ["--version"])?.split("\n")[0] || null,
    host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
        memory_gb: Math.round(os.totalmem() / 2 ** 30) },
    levels, quick,
};

const directory = path.join(root, "build/release-gate", environment.time.replace(/[:.]/g, "-"));
fs.mkdirSync(directory, { recursive: true });
const results = [];

function make(target)
{
    return new Promise(resolve => {
        const log = fs.openSync(path.join(directory, target + ".log"), "w");
        const started = Date.now();
        const child = spawn("make", [target], { cwd: root, stdio: ["ignore", log, log] });
        child.on("close", code => {
            fs.closeSync(log);
            const text = fs.readFileSync(path.join(directory, target + ".log"), "utf8");
            resolve({ code, seconds: Math.round((Date.now() - started) / 1000), tail: text.split("\n").slice(-6).join("\n") });
        });
    });
}

let failed = false;
for(const level of levels)
{
    for(const [target, long] of LEVELS[level])
    {
        if(quick && long)
        {
            results.push({ level, target, status: "skipped (long)" });
            continue;
        }
        if(option("--dry-run") || failed && !option("--keep-going"))
        {
            results.push({ level, target, status: option("--dry-run") ? "not run (dry run)" : "not run (earlier failure)" });
            continue;
        }
        process.stdout.write(`${level} ${target} ... `);
        const { code, seconds, tail } = await make(target);
        const status = code === 0 ? "pass" : "FAIL";
        console.log(`${status} (${seconds} s)`);
        results.push({ level, target, status, seconds, log: target + ".log", tail });
        if(code !== 0) failed = true;
    }
}

const summary = Object.fromEntries(levels.map(level => {
    const rows = results.filter(r => r.level === level);
    const verdict = rows.every(r => r.status === "pass") ? "pass" :
        rows.some(r => r.status === "FAIL") ? "FAIL" : "incomplete";
    return [level, verdict];
}));
fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify({ environment, summary, results }, null, 2));
const md = [
    `# Release gate ${environment.time}`, "",
    `commit \`${environment.commit}\`, ${environment.uncommitted.length} uncommitted file(s) (${environment.diff_stat || "no diff"})`, "",
    `Node ${environment.node}; ${environment.rustc}; ${environment.java}; ${environment.nasm}; ${environment.clang}; ${environment.qemu}`, "",
    `Host: ${environment.host.cpu}, ${environment.host.cores} logical cores, ${environment.host.memory_gb} GiB, ${environment.host.platform}/${environment.host.arch}`, "",
    "| level | verdict |", "| --- | --- |", ...levels.map(level => `| ${level} | ${summary[level]} |`), "",
    "| level | target | status | seconds |", "| --- | --- | --- | --- |",
    ...results.map(r => `| ${r.level} | \`${r.target}\` | ${r.status} | ${r.seconds ?? ""} |`), "",
];
fs.writeFileSync(path.join(directory, "report.md"), md.join("\n"));
console.log(`report: ${path.relative(root, directory)}/report.md`);
console.log(JSON.stringify(summary));
process.exit(failed ? 1 : 0);
