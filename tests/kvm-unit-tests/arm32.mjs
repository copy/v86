#!/usr/bin/env node
// The 32-bit arm kvm-unit-tests of docs/aarch32-plan.md R5.1 (upstream
// arm/unittests.cfg's entries for arm; its timer, cache, debug and fpu
// tests are arm64's, the gicv2 ones need a GICv2, pci-test the PCIe host
// the 32-bit virt has not), built by build.sh arm and run by run.mjs.
//
//   node tests/kvm-unit-tests/arm32.mjs [--qemu]
//   (without --qemu on v86's cpu_type "arm32", its cooperative cores for the SMP cases)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const MAX_SMP = 4;
// (the interpreter's cores take turns: the spinlock test's rounds need longer
// there; sieve's three sieves of 100 MB are some 5 billion instructions)
const V86_TIMEOUT = { "spinlock-test": 300, sieve: 1800 };
// [name, file, cores, test_args, memory MiB]
const CASES = [
    ["selftest-setup", "selftest", 2, "setup smp=2 mem=256", 256],
    ["selftest-vectors-kernel", "selftest", 1, "vectors-kernel"],
    ["selftest-vectors-user", "selftest", 1, "vectors-user"],
    ["selftest-smp", "selftest", MAX_SMP, "smp"],
    // (no PMU in profile arm32-v1, none in the reference's cortex-a15 with pmu=off: skipped)
    ["pmu-cycle-counter", "pmu", 1, "cycle-counter 0"],
    ["gicv3-ipi", "gic", MAX_SMP, "ipi"],
    ["gicv3-active", "gic", MAX_SMP, "active"],
    ["psci", "psci", MAX_SMP, ""],
    ["pl031", "pl031", 1, ""],
    ["spinlock-test", "spinlock-test", MAX_SMP, ""],
    // (its three 100 MB mallocs: more than the default memory)
    ["sieve", "sieve", 1, "", 256],
];

const qemu = process.argv.includes("--qemu");
const build = spawnSync("bash", [here + "build.sh", "arm"], { encoding: "utf8" });
if(build.status !== 0) { console.log(`arm: build failed\n${build.stdout.slice(-3000)}${build.stderr}`); process.exit(1); }
let failed = 0;
for(const [name, file, cores, test_args, memory] of CASES)
{
    const timeout = !qemu && V86_TIMEOUT[name] || 60;
    const run = spawnSync("node", [here + "run.mjs", "--arm32", ...(qemu ? ["--qemu"] : []),
        "--cores", String(cores), ...(memory ? ["--memory", String(memory)] : []), "--append", test_args, "--timeout", String(timeout),
        `${here}../../build/kvm-unit-tests/arm/arm/${file}.flat`], { encoding: "utf8" });
    const result = run.stdout.trim().split("\n").pop();
    // (exit(77), EXIT: STATUS=77 (code 38): the test found nothing to test and skipped)
    const skipped = /code=38 /.test(result) && /test skipped/.test(run.stdout);
    console.log(`arm ${name}: ${skipped ? "SKIPPED " + result : result}`);
    if(run.status !== 0 && !skipped) { failed++; console.log(run.stdout.slice(-2000)); }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
