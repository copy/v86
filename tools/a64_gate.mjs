#!/usr/bin/env node
// The local gates of docs/arm64-virt-android16-plan.md (P0.11; GitHub CI comes
// later, the owner's decision of 2026-10-09), beside make jit-gate:
//
// make a64-gate, before each commit:
//   the cores' boundaries (tools/check_a64_imports.mjs), the decode oracle's
//   self-test, the bare-metal reference checks on QEMU (float_convs and
//   float_madds against QEMU's .ref files, the platform probe, the ID
//   registers against the profile's allowed differences), the ARM core's
//   own targets (A1: its unit tests and the decoder against the oracle,
//   the integer oracle, the loader, the address space and the PL011 against
//   QEMU, the arm64 options; A2: the ID registers, the exceptions and MMU
//   oracles; A3: the litmus tests; A4: the page tier's fuzzer and FP fast
//   path) and, when something that feeds build/v86.wasm
//   changed, core-split-check (P0.7: a change only to src/rust/aarch64/
//   leaves v86.wasm byte for byte as it was).
// make a64-gate-full, at a milestone's exit and when the owner runs it:
//   the same, then the native arm64 oracle (P2.12, on macOS arm64), the long
//   reference runs (kvm-unit-tests arm64 at 4k, 16k and 64k, Alpine's
//   initramfs and live stages on 1, 2 and 4 cores, all on QEMU), the ARM
//   core's long runs (kvm-unit-tests on its cores; Alpine's initramfs,
//   single and lifecycle stages, on 2 and 4 cores, with kpti=1; the trace
//   replay and corpus; the portable core; A4: the oracles compiled, and
//   Alpine and kvm-unit-tests with the page tier) and the release levels R-a64-*
//   (tools/release_gate.mjs).
//
// The QEMU checks need the fixed reference (tools/a64_qemu/build.sh) and are
// skipped, said so, without it.
//
// Usage: tools/a64_gate.mjs [--full] [--base REV] [--keep-going]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const full = args.includes("--full"), keep_going = args.includes("--keep-going");
const base_index = args.indexOf("--base");
const base = base_index >= 0 ? args[base_index + 1] : null;

function git(...git_args)
{
    const r = spawnSync("git", ["-C", ROOT, ...git_args], { encoding: "utf8" });
    if(r.status !== 0) throw new Error("git " + git_args.join(" ") + ": " + r.stderr.trim());
    return r.stdout.trim();
}
const lines = text => text.split("\n").filter(Boolean);
let changed = [...lines(git("diff", "--name-only", base || "HEAD")), ...lines(git("ls-files", "--others", "--exclude-standard"))];
if(!base && !changed.length) changed = lines(git("diff", "--name-only", "HEAD~1", "HEAD"));
const feeds_core = changed.some(p => [/^src\/rust\//, /^Cargo\.(toml|lock)$/, /^\.cargo\//, /^gen\//, /^lib\//, /^Makefile$/].some(re => re.test(p)));

const qemu = process.env.A64_QEMU || path.join(ROOT, "build/a64-ref/qemu-9.2.0-install/bin/qemu-system-aarch64");
const no_qemu = fs.existsSync(qemu) ? null : "no QEMU reference (tools/a64_qemu/build.sh)";
const llvm_mc = spawnSync("node", ["-e", "import('./tests/a64/oracle/decode.mjs').then(m => m.llvm_mc())"], { cwd: ROOT }).status === 0;

const steps = [
    { name: "the cores' boundaries", command: ["node", "tools/check_a64_imports.mjs"] },
    { name: "decode oracle self-test", command: ["node", "tests/a64/oracle/decode.mjs", "--self-test"], skip: llvm_mc ? null : "no llvm-mc" },
    { name: "float_convs, float_madds (QEMU)", command: ["node", "tests/a64/float_ref.mjs"], skip: no_qemu },
    { name: "platform probe (QEMU)", command: ["node", "tests/a64/platform_probe.mjs"], skip: no_qemu },
    { name: "ID registers against the profile (QEMU)", command: ["node", "tools/cpu_contract.mjs", "--a64-reference"], skip: no_qemu },
    { name: "ARM core: unit tests, decoder (llvm-mc)", command: ["make", "--no-print-directory", "a64-decode-tests"], skip: llvm_mc ? null : "no llvm-mc" },
    { name: "ARM core: integer oracle (QEMU)", command: ["make", "--no-print-directory", "a64-isa-tests"], skip: no_qemu },
    { name: "ARM core: loader, address space, PL011 (QEMU)", command: ["make", "--no-print-directory", "a64-virt-device-tests"], skip: no_qemu },
    { name: "ARM core: arm64 options", command: ["make", "--no-print-directory", "a64-api-tests"] },
    { name: "ARM core: ID registers, exceptions (QEMU)", command: ["make", "--no-print-directory", "a64-system-tests"], skip: no_qemu },
    { name: "ARM core: MMU and TLB (QEMU)", command: ["make", "--no-print-directory", "a64-mmu-tests"], skip: no_qemu },
    { name: "ARM core: litmus on cooperative cores", command: ["make", "--no-print-directory", "a64-litmus-tests"] },
    { name: "ARM core: page tier against the interpreter (A4)", command: ["node", "tests/a64/page_fuzz.mjs"] },
    { name: "ARM core: page tier FP fast path (QEMU)", command: ["node", "tests/a64/fma.mjs"], skip: no_qemu },
    { name: "core-split-check (P0.7)", command: ["node", "tools/core_split_check.mjs", ...(base ? ["--base", base] : [])],
        skip: feeds_core || full ? null : "nothing that feeds build/v86.wasm changed" },
];
if(full)
{
    steps.push({ name: "FP, AdvSIMD, crypto on the host's arm64 CPU (P2.12)", command: ["make", "--no-print-directory", "a64-native-tests"],
        skip: process.platform === "darwin" && process.arch === "arm64" ? null : "not macOS on arm64" });
    steps.push({ name: "kvm-unit-tests arm64 4k/16k/64k (QEMU)", command: ["node", "tests/kvm-unit-tests/arm64.mjs", "--qemu"], skip: no_qemu });
    steps.push({ name: "ARM core: kvm-unit-tests, one core", command: ["make", "--no-print-directory", "a64-kvm-unit-tests"] });
    steps.push({ name: "ARM core: Alpine initramfs, single, lifecycle", command: ["make", "--no-print-directory", "a64-guest-tests"], skip: no_qemu });
    steps.push({ name: "ARM core: Alpine on 2 and 4 cores, kpti=1", command: ["make", "--no-print-directory", "a64-multicore-guest-tests"] });
    steps.push({ name: "ARM core: page tier, the oracles compiled (QEMU)", command: ["make", "--no-print-directory", "a64-page-tier-tests"], skip: no_qemu });
    steps.push({ name: "ARM core: Alpine and kvm-unit-tests with the page tier", command: ["make", "--no-print-directory", "a64-jit-guest-tests"], skip: no_qemu });
    steps.push({ name: "ARM core: Alpine trace replay and corpus (QEMU)", command: ["make", "--no-print-directory", "a64-trace-tests"], skip: no_qemu });
    steps.push({ name: "ARM core: the portable core (QEMU)", command: ["make", "--no-print-directory", "a64-portable-tests"], skip: no_qemu });
    for(const stage of ["initramfs", "live"])
    {
        for(const cores of [1, 2, 4])
        {
            steps.push({ name: `Alpine ${stage}, ${cores} core(s) (QEMU)`, command: ["node", "tests/a64/linux_boot.mjs"],
                env: { A64_LINUX_QEMU: "1", A64_STAGE: stage, A64_CORES: String(cores) }, skip: no_qemu });
        }
    }
    steps.push({ name: "release levels R-a64-*", command: ["node", "tools/release_gate.mjs", "--levels",
        "R-a64-isa,R-a64-sys,R-a64-virt,R-a64-UP,R-a64-SMP,R-a64-jit,R-a64-gpu,R-a64-parallel,R-a64-memory,R-a64-granule,R-a64-android-prep"] });
}

console.log(`[a64-gate] ${full ? "full" : "quick"}; ${changed.length} changed paths`);
const results = [];
let failed = false;
for(const step of steps)
{
    if(step.skip || failed && !keep_going)
    {
        results.push({ name: step.name, status: step.skip ? "skipped: " + step.skip : "not run" });
        continue;
    }
    console.log(`\n[a64-gate] ${step.name}: ${step.command.join(" ")}`);
    const start = Date.now();
    const r = spawnSync(step.command[0], step.command.slice(1), { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...step.env } });
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    if(r.status !== 0) failed = true;
    results.push({ name: step.name, status: (r.status === 0 ? "ok" : "FAILED") + ` (${seconds} s)` });
}

console.log("\n[a64-gate] summary:");
for(const { name, status } of results) console.log(`  ${name.padEnd(48)} ${status}`);
console.log(failed ? "[a64-gate] FAILED" : "[a64-gate] passed");
process.exit(failed ? 1 : 0);
