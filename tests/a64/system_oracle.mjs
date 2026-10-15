#!/usr/bin/env node
// Exceptions and the system controls of the A64 core against QEMU
// (docs/arm64-virt-android16-plan.md P3.2): every fault point records the
// syndrome (ESR_EL1), FAR_EL1 where the class defines it, ELR_EL1,
// SPSR_EL1, X0-X7 and NZCV as the exception left them, and the vector it
// came through; QEMU's records and v86's must be equal. The cases run at
// EL1 and at EL0 (an ERET to the case's code; the EL0 code ends with SVC
// #0xFFFF), with the MMU off, under the SCTLR_EL1, CPACR_EL1 and
// CNTKCTL_EL1 settings they name: UNDEF in its forms (UDF, SMC and HVC
// where they UNDEF, HLT, unallocated and read-only system registers, EL1
// registers from EL0), the WFI/WFE, FP/SIMD, system register and cache
// maintenance traps, an illegal exception return, SVC, BRK, instruction
// and data aborts, PC and SP alignment, exclusives, and the SP0 vectors.
// (DC ZVA with the MMU off and NZCV on entry differ by the allowed list;
// where QEMU deviates from the Arm ARM, SP alignment, WFE at EL0 and the
// DAIFSet trap's syndrome, v86 is held to the architecture's syndrome.)
//
//   node tests/a64/system_oracle.mjs [--rounds N] [--seed S]
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, reference, actual, root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const ROUNDS = +option("--rounds", 3);
const SEED = +option("--seed", 1);

let state = BigInt(SEED) * 0x9E3779B97F4A7C15n & (1n << 64n) - 1n || 1n;
function next64()
{
    state ^= state << 13n & (1n << 64n) - 1n;
    state ^= state >> 7n;
    state ^= state << 17n & (1n << 64n) - 1n;
    return state;
}
const hex = v => "0x" + BigInt.asUintN(64, BigInt(v)).toString(16);

// SCTLR_EL1 bits the cases change (the rest stays as the runtime set it)
const UCI = 1n << 26n, UCT = 1n << 15n, DZE = 1n << 14n, UMA = 1n << 9n, NTWI = 1n << 16n, NTWE = 1n << 18n, SA = 1n << 3n, SA0 = 1n << 4n;
const ALL_EL0 = UCI | UCT | DZE | UMA | NTWI | NTWE;
const HOLE = "0x0b000000";

// [name, level, { sctlr_clear, sctlr_set, cpacr, cntkctl }, body, v86_only]: the body runs with x0-x7
// random and x8 pointing at a 64-byte scratch block in RAM. A v86_only case is one where the
// reference deviates from the Arm ARM (tests/platform/a64-profile.json's allowed list): v86's record
// is held to the architecture's syndrome instead ([taken, ESR])
const CASES = [
    ["udf", 1, {}, "udf #0"],
    ["smc", 1, {}, "smc #0"],
    ["hlt", 1, {}, "hlt #0"],
    ["brk", 1, {}, "brk #0x1234"],
    ["svc", 1, {}, "svc #0x42"],
    ["unallocated sysreg", 1, {}, "mrs x0, s3_7_c15_c15_7"],
    ["msr to MIDR", 1, {}, "msr s3_0_c0_c0_0, x1"],
    ["fp off", 1, { cpacr: 0 }, "fmov d0, x1"],
    ["simd off", 1, { cpacr: 0 }, "add v0.4s, v1.4s, v2.4s"],
    ["fp off: FPCR", 1, { cpacr: 0 }, "mrs x0, fpcr"],
    ["fp EL0 only at EL1", 1, { cpacr: 1 }, "fmov d0, x1\n    fmov x2, d0"],
    ["load from a hole", 1, {}, `mov x1, #${HOLE}\n    ldr x0, [x1]`],
    ["store to a hole", 1, {}, `mov x1, #${HOLE}\n    str x2, [x1, #8]`],
    ["load pair from a hole", 1, {}, `mov x1, #${HOLE}\n    ldp x2, x3, [x1]`],
    ["unaligned load (Device)", 1, {}, "add x1, x8, #3\n    ldr x0, [x1]"],
    ["unaligned store (Device)", 1, {}, "add x1, x8, #2\n    str w0, [x1]"],
    ["unaligned exclusive", 1, {}, "add x1, x8, #4\n    ldxr x0, [x1]"],
    ["unaligned acquire", 1, {}, "add x1, x8, #2\n    ldar w0, [x1]"],
    ["write-back then fault", 1, {}, `mov x1, #${HOLE}\n    ldr x0, [x1, #16]!`],
    ["PC alignment", 1, {}, "adr x1, 1f\n    add x1, x1, #2\n    br x1\n1:  nop"],
    ["instruction abort", 1, {}, `mov x1, #${HOLE}\n    blr x1`],
    ["SP alignment", 1, { sctlr_set: SA }, "mov x3, sp\n    add x2, x3, #8\n    mov sp, x2\n    ldr x0, [sp]\n    mov sp, x3", [1, 0x9a000000n]],
    ["illegal exception return", 1, {}, "adr x1, 1f\n    msr elr_el1, x1\n    mov x2, #0x9\n    msr spsr_el1, x2\n    eret\n1:  add x0, x0, #1"],
    ["svc on SP0", 1, {}, "msr spsel, #0\n    svc #0x7\n    msr spsel, #1"],
    ["undef on SP0", 1, {}, "msr spsel, #0\n    udf #1\n    msr spsel, #1"],
    ["drps", 1, {}, ".inst 0xd6bf03e0"],
    ["dcps1", 1, {}, ".inst 0xd4a00001"],
    ["flags and svc", 1, {}, "cmp x0, x1\n    svc #0x9"],
    // EL0
    ["EL0: EL1 register", 0, {}, "mrs x0, sctlr_el1"],
    ["EL0: CTR_EL0 trapped", 0, { sctlr_clear: UCT }, "mrs x0, ctr_el0"],
    // (L1Ip differs by the allowed list: the profile's PIPT, the reference's VIPT)
    ["EL0: CTR_EL0 allowed", 0, { sctlr_set: UCT }, "mrs x0, ctr_el0\n    bic x0, x0, #0xC000"],
    ["EL0: DCZID allowed", 0, {}, "mrs x0, dczid_el0"],
    ["EL0: DC ZVA trapped", 0, { sctlr_clear: DZE }, "dc zva, x8"],
    ["EL0: DAIF trapped", 0, { sctlr_clear: UMA }, "msr daifset, #2", [3, 0x620cd3e4n]],
    ["EL0: DAIF read trapped", 0, { sctlr_clear: UMA }, "mrs x0, daif"],
    ["EL0: DAIF allowed", 0, { sctlr_set: UMA }, "mrs x0, daif"],
    ["EL0: WFI trapped", 0, { sctlr_clear: NTWI }, "wfi"],
    // (the ERET into EL0 set the event register: the first WFE consumes it, the second would wait and traps)
    ["EL0: WFE trapped", 0, { sctlr_clear: NTWE }, "wfe\n    wfe", [3, 0x07e00001n]],
    ["EL0: FP trapped", 0, { cpacr: 1 }, "fmov d0, x1"],
    ["EL0: FP off", 0, { cpacr: 0 }, "fmov d0, x1"],
    ["EL0: SVC", 0, {}, "svc #7"],
    ["EL0: HVC", 0, {}, "hvc #0"],
    ["EL0: SMC", 0, {}, "smc #0"],
    ["EL0: BRK", 0, {}, "brk #1"],
    ["EL0: load from a hole", 0, {}, `mov x1, #${HOLE}\n    ldr x0, [x1]`],
    ["EL0: PC alignment", 0, {}, "adr x1, 1f\n    add x1, x1, #1\n    br x1\n1:  nop"],
    ["EL0: instruction abort", 0, {}, `mov x1, #${HOLE}\n    br x1`],
    ["EL0: DC CIVAC trapped", 0, { sctlr_clear: UCI }, "dc civac, x8"],
    ["EL0: DC CIVAC allowed", 0, { sctlr_set: UCI }, "dc civac, x8"],
    ["EL0: IC IVAU trapped", 0, { sctlr_clear: UCI }, "ic ivau, x8"],
    ["EL0: CNTVCT trapped", 0, { cntkctl: 0 }, "mrs x0, cntvct_el0\n    mov x0, #1"],
    ["EL0: CNTFRQ allowed", 0, { cntkctl: 2 }, "mrs x0, cntfrq_el0"],
    ["EL0: CNTP_CTL trapped", 0, { cntkctl: 3 }, "mrs x0, cntp_ctl_el0"],
    ["EL0: SP alignment", 0, { sctlr_set: SA0 }, "mov x3, #0x4080\n    movk x3, #0x4060, lsl #16\n    add x3, x3, #4\n    mov sp, x3\n    ldr x0, [sp]", [3, 0x9a000000n]],
    ["EL0: MSR SPSel", 0, {}, "msr spsel, #1"],
    ["EL0: unaligned exclusive", 0, {}, "add x1, x8, #1\n    ldaxr w0, [x1]"],
];

// one entry per case and round: its random registers
const runs = [];
for(let round = 0; round < ROUNDS; round++)
{
    for(const [name, level, setup, body, v86_only] of CASES)
    {
        runs.push({ name, level, setup, body, v86_only, x: Array.from({ length: 8 }, next64), nzcv: next64() & 0xF0000000n });
    }
}

// record (88 bytes): taken (1 current SPx, 2 current SP0, 3 lower), ESR, FAR, ELR, SPSR, X0-X7 at the exception, NZCV after
function guest()
{
    const L = [".text", ".balign 4", ".global run_cases", "run_cases:",
        "    stp x29, x30, [sp, #-96]!", "    stp x19, x20, [sp, #16]", "    stp x21, x22, [sp, #32]", "    stp x23, x24, [sp, #48]",
        "    stp x25, x26, [sp, #64]", "    stp x27, x28, [sp, #80]",
        "    mrs x27, vbar_el1", "    mrs x26, sctlr_el1", "    mrs x25, cpacr_el1", "    mov x19, sp",
        "    adr x1, sys_vectors", "    msr vbar_el1, x1", "    isb"];
    runs.forEach((r, n) => {
        const sctlr_clear = r.setup.sctlr_clear ?? 0n, sctlr_set = r.setup.sctlr_set ?? 0n;
        const cpacr = r.setup.cpacr === undefined ? 3n << 20n : BigInt(r.setup.cpacr) << 20n;
        const cntkctl = BigInt(r.setup.cntkctl ?? 0);
        L.push(`// case ${n}: ${r.name}`,
            `    adrp x20, record_${n}`, `    add x20, x20, :lo12:record_${n}`, `    adr x21, done_${n}`,
            // (EL0 cases: everything allowed but what the case clears)
            `    ldr x1, =${hex(sctlr_clear)}`, `    ldr x2, =${hex(sctlr_set | (r.level === 0 ? ALL_EL0 & ~sctlr_clear : 0n))}`,
            "    bic x1, x26, x1", "    orr x1, x1, x2", "    msr sctlr_el1, x1",
            `    ldr x1, =${hex(cpacr)}`, "    msr cpacr_el1, x1", `    ldr x1, =${hex(cntkctl)}`, "    msr cntkctl_el1, x1", "    isb",
            `    adrp x8, scratch_${n}`, `    add x8, x8, :lo12:scratch_${n}`, `    adrp x9, regs_${n}`, `    add x9, x9, :lo12:regs_${n}`,
            "    ldr x10, [x9, #64]", "    msr nzcv, x10",
            "    ldp x0, x1, [x9]", "    ldp x2, x3, [x9, #16]", "    ldp x4, x5, [x9, #32]", "    ldp x6, x7, [x9, #48]");
        if(r.level === 0)
        {
            L.push(`    adr x10, el0_${n}`, "    msr elr_el1, x10", "    ldr x10, [x9, #64]", "    msr spsr_el1, x10", "    eret",
                `el0_${n}:`, "    " + r.body, "    svc #0xFFFF");
        }
        else
        {
            L.push("    " + r.body, "    svc #0xFFFF");
        }
        L.push(`done_${n}:`, "    mov sp, x19", "    msr sctlr_el1, x26", "    msr cpacr_el1, x25", "    msr cntkctl_el1, xzr", "    isb",
            "    mrs x10, nzcv", "    str x10, [x20, #104]");
    });
    L.push("    msr vbar_el1, x27", "    isb", "    mov sp, x19",
        "    ldp x19, x20, [sp, #16]", "    ldp x21, x22, [sp, #32]", "    ldp x23, x24, [sp, #48]", "    ldp x25, x26, [sp, #64]",
        "    ldp x27, x28, [sp, #80]", "    ldp x29, x30, [sp], #96", "    ret", ".ltorg");
    // the vectors: record and return to x21 at EL1h, the record's "taken" says which vector
    const handler = kind => [
        "    stp x0, x1, [x20, #40]", "    stp x2, x3, [x20, #56]", "    stp x4, x5, [x20, #72]", "    stp x6, x7, [x20, #88]",
        "    mrs x0, esr_el1", "    str x0, [x20, #8]",
        // (FAR where the class defines it: aborts, PC alignment)
        "    lsr x1, x0, #26", "    mov x2, xzr", "    cmp x1, #0x20", "    b.lo 8f", "    cmp x1, #0x25", "    b.hi 8f", "    cmp x1, #0x23", "    b.eq 8f",
        "    mrs x2, far_el1", "8:  str x2, [x20, #16]",
        "    mrs x0, elr_el1", "    str x0, [x20, #24]", "    mrs x0, spsr_el1", "    str x0, [x20, #32]",
        // (the end marker, SVC #0xFFFF: ESR 0x5600FFFF, is no fault)
        "    mrs x0, esr_el1", "    mov x1, #0xFFFF", "    movk x1, #0x5600, lsl #16", "    cmp x0, x1", "    b.eq 9f",
        `    mov x0, #${kind}`, "    str x0, [x20]",
        "9:  msr elr_el1, x21", "    mov x0, #0x3c5", "    msr spsr_el1, x0", "    eret"];
    // (each vector branches to its handler: 0x000 current EL with SP0, 0x200 with SPx, 0x400 a lower EL)
    L.push(".balign 2048", "sys_vectors:", "    b sync_sp0", ".balign 0x200", "    b sync_spx", ".balign 0x200", "    b sync_lower",
        ".balign 0x800", "sync_sp0:", ...handler(2), "sync_spx:", ...handler(1), "sync_lower:", ...handler(3));
    L.push(".data", ".balign 64");
    runs.forEach((r, n) => {
        L.push(`regs_${n}:`, ...r.x.map(v => `    .quad ${hex(v)}`), `    .quad ${hex(r.nzcv)}`, ".balign 64",
            `scratch_${n}:`, "    .zero 64", `record_${n}:`, "    .zero 112", ".balign 64");
    });
    L.push(".text", ".global case_records", ".balign 8", "case_records:");
    runs.forEach((_, n) => L.push(`    .quad record_${n}`));
    return L.join("\n") + "\n";
}

const MAIN = `#include <a64.h>
#include <stdio.h>
void run_cases(void);
extern const unsigned long case_records[];
int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    run_cases();
    for(int i = 0; i < ${runs.length}; i++)
    {
        const unsigned long *r = (const unsigned long *)case_records[i];
        printf("%d", i);
        for(int k = 0; k < 14; k++) printf(" %lx", r[k]);
        printf("\\n");
    }
    return 0;
}
`;

const NAMES = ["taken", "esr", "far", "elr", "spsr", "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "nzcv"];
const directory_base = root + "build/a64-system-oracle/";
fs.mkdirSync(directory_base, { recursive: true });
fs.writeFileSync(directory_base + "cases.S", guest());
fs.writeFileSync(directory_base + "main.c", MAIN);
const directory = build("system-oracle", [directory_base + "cases.S", directory_base + "main.c"]);
const expected = await reference(directory, { timeout: 120000 });
assert.equal(expected.status, "ok", "QEMU: " + expected.status + " " + expected.text.slice(-500));
const got = await actual(directory, { timeout: 300000 });
assert.equal(got.status, "ok", "v86: " + got.status + " " + got.text.slice(-500));
const want = expected.text.trim().split("\n"), have = got.text.trim().split("\n");
assert.equal(have.length, want.length, "line count");
let differences = 0;
const kinds = new Set();
for(let i = 0; i < want.length; i++)
{
    const w = want[i].split(" "), h = have[i].split(" ");
    if(w[1] !== "0") kinds.add(BigInt("0x" + w[2]) >> 26n);
    if(runs[i].v86_only)
    {
        // (the reference deviates here: v86 against the architecture's syndrome)
        const [taken, esr] = runs[i].v86_only;
        if(+h[1] === taken && BigInt("0x" + h[2]) === esr) continue;
        differences++;
        console.log(`DIFF ${runs[i].name} (EL${runs[i].level}): v86 taken ${h[1]} esr ${h[2]}, the architecture ${taken} ${esr.toString(16)}`);
        continue;
    }
    if(want[i] === have[i]) continue;
    differences++;
    const fields = w.slice(1).map((value, k) => value === h[k + 1] ? null : `${NAMES[k]} qemu ${value} v86 ${h[k + 1]}`).filter(Boolean);
    console.log(`DIFF ${runs[i].name} (EL${runs[i].level}): ${fields.join(", ")}`);
}
console.log(`system oracle: ${want.length} fault points (${CASES.length} cases x ${ROUNDS}, ` +
    `exception classes ${[...kinds].sort((a, b) => Number(a - b)).map(k => "0x" + k.toString(16)).join(" ")}), ${differences} differences`);
process.exit(differences ? 1 : 0);
