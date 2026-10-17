#!/usr/bin/env node
// The arm64 kvm-unit-tests subset of docs/arm64-virt-android16-plan.md P0.6
// (upstream arm/unittests.cfg entries, and fpu.flat, pl031.flat and
// spinlock-test.flat run directly), built by build.sh for each translation
// granule and run by run.mjs.
//
//   node tests/kvm-unit-tests/arm64.mjs [--qemu] [--single-core] [4k 16k 64k]
//   (without --qemu the cases run on v86's ARM core, its cooperative cores for
//   the SMP ones (P3.9), and the 16k and 64k builds with profile v1.1's
//   granules; --single-core only the cases of one core)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const MAX_SMP = 4;
// (the interpreter's cores take turns: the spinlock test's 4 x 10 million
// lock rounds need longer there than the 60 s the others get)
const V86_TIMEOUT = { "spinlock-test": 300 };
// [name, file, cores, test_args, memory MiB]
export const CASES = [
    ["selftest-setup", "selftest", 2, "setup smp=2 mem=256", 256],
    ["selftest-vectors-kernel", "selftest", 1, "vectors-kernel"],
    ["selftest-vectors-user", "selftest", 1, "vectors-user"],
    ["selftest-smp", "selftest", MAX_SMP, "smp"],
    ["psci", "psci", MAX_SMP, ""],
    ["timer", "timer", 1, ""],
    ["gicv3-ipi", "gic", MAX_SMP, "ipi"],
    ["gicv3-active", "gic", MAX_SMP, "active"],
    ["cache", "cache", 1, ""],
    ["debug-bp", "debug", 1, "bp"],
    ["debug-wp", "debug", 1, "wp"],
    ["debug-sstep", "debug", 1, "ss"],
    ["fpu-context", "fpu", 2, ""],
    ["pl031", "pl031", 1, ""],
    ["spinlock-test", "spinlock-test", MAX_SMP, ""],
];

const args = process.argv.slice(2);
const qemu = args.includes("--qemu");
const single_core = args.includes("--single-core");
const granules = args.filter(a => /^\d+k$/.test(a));
let failed = 0;
for(const granule of granules.length ? granules : ["4k", "16k", "64k"])
{
    const build = spawnSync("bash", [here + "build.sh", "arm64-" + granule], { encoding: "utf8" });
    if(build.status !== 0) { console.log(`arm64-${granule}: build failed\n${build.stdout.slice(-3000)}${build.stderr}`); process.exit(1); }
    for(const [name, file, cores, test_args, memory] of CASES)
    {
        if(single_core && cores > 1) continue;
        const timeout = !qemu && V86_TIMEOUT[name] || 60;
        const once = () => spawnSync("node", [here + "run.mjs", "--arm64", ...(qemu ? ["--qemu"] : granule !== "4k" ? ["--granules-all"] : []),
            "--cores", String(cores), ...(memory ? ["--memory", String(memory)] : []), "--append", test_args, "--timeout", String(timeout),
            `${here}../../build/kvm-unit-tests/arm64-${granule}/arm/${file}.flat`], { encoding: "utf8" });
        let run = once(), note = "";
        // (the timer test's "latency within 10 ms" checks measure the host:
        // a loaded machine fails them now and then, so they get one retry)
        const failures = run.stdout.match(/^FAIL: .*$/gm) || [];
        if(run.status !== 0 && failures.length && failures.every(line => /latency within/.test(line)))
        {
            note = ` (retried after ${failures.join("; ")})`;
            run = once();
        }
        const result = run.stdout.trim().split("\n").pop();
        console.log(`arm64-${granule} ${name}: ${result}${note}`);
        if(run.status !== 0) { failed++; console.log(run.stdout.slice(-2000)); }
    }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
