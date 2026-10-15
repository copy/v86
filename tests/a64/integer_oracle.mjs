#!/usr/bin/env node
// Integer, branch, load/store and exclusive instructions of the A64
// interpreter against QEMU (docs/arm64-virt-android16-plan.md P2.2: at least
// 2,000 cases, 0 differences). Each case is one instruction (or a branch
// with its two outcomes) with random X0-X14 and NZCV; X15 points at a
// 128-byte window of random memory. The guest (tests/a64/guest_runner.mjs)
// runs the cases and prints, per case, X0-X15, NZCV and a checksum of the
// window; QEMU's lines and v86's must be equal.
//
//   node tests/a64/integer_oracle.mjs [--cases N] [--seed S] [--filter family]
//   A64_TARGET=qemu runs QEMU only (to check the generator)
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, reference, actual, root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const CASES = +option("--cases", 2400);
const SEED = +option("--seed", 1);
const FILTER = option("--filter", null);
const BATCH = 400;

// ---- random values (a xorshift generator: the same cases everywhere)
let state = BigInt(SEED) * 0x9E3779B97F4A7C15n & (1n << 64n) - 1n || 1n;
function next64()
{
    state ^= state << 13n & (1n << 64n) - 1n;
    state ^= state >> 7n;
    state ^= state << 17n & (1n << 64n) - 1n;
    return state;
}
const rand = (n) => Number(next64() % BigInt(n));
const pick = list => list[rand(list.length)];
const SPECIAL = [0n, 1n, 2n, 0xFFFFFFFFFFFFFFFFn, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFn, 0x7FFFFFFFn,
    0x80000000n, 0xFFFFFFFF80000000n, 0x100000000n, 0x8000n, 0xFFn, 0xFF00FF00FF00FF00n];
function value()
{
    switch(rand(4))
    {
        case 0: return pick(SPECIAL);
        case 1: return next64() & 0xFFFFFFFFn;
        case 2: return BigInt(rand(64)) - 32n & (1n << 64n) - 1n;
        default: return next64();
    }
}
const hex = v => "0x" + v.toString(16);

// ---- the cases: assembly for one instruction, with the registers it uses
const X = () => "x" + rand(15);
const W = () => "w" + rand(15);
const Rboth = sf => sf ? X() : W();
const COND = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al"];

/** A valid logical immediate of a 64-bit (or 32-bit) operation */
function bitmask(sf)
{
    for(;;)
    {
        const esize = pick(sf ? [2, 4, 8, 16, 32, 64] : [2, 4, 8, 16, 32]);
        const ones = 1 + rand(esize - 1);
        const rotation = rand(esize);
        let element = (1n << BigInt(ones)) - 1n;
        const emask = (1n << BigInt(esize)) - 1n;
        if(rotation) element = (element >> BigInt(rotation) | element << BigInt(esize - rotation)) & emask;
        let result = 0n;
        for(let at = 0; at < (sf ? 64 : 32); at += esize) result |= element << BigInt(at);
        return result;
    }
}

const FAMILIES = {
    add_imm: () => { const sf = rand(2); return `${pick(["add", "adds", "sub", "subs"])} ${Rboth(sf)}, ${Rboth(sf)}, #${rand(4096)}${pick(["", ", lsl #12"])}`; },
    logical_imm: () => { const sf = rand(2); return `${pick(["and", "orr", "eor", "ands"])} ${Rboth(sf)}, ${Rboth(sf)}, #${hex(bitmask(sf))}`; },
    move_wide: () => { const sf = rand(2); return `${pick(["movz", "movn", "movk"])} ${Rboth(sf)}, #${rand(65536)}, lsl #${pick(sf ? [0, 16, 32, 48] : [0, 16])}`; },
    bitfield: () => {
        const sf = rand(2), width = sf ? 64 : 32;
        return `${pick(["sbfm", "bfm", "ubfm"])} ${Rboth(sf)}, ${Rboth(sf)}, #${rand(width)}, #${rand(width)}`;
    },
    extr: () => { const sf = rand(2); const r = Rboth(sf); return `extr ${r}, ${Rboth(sf)}, ${Rboth(sf)}, #${rand(sf ? 64 : 32)}`; },
    add_shifted: () => {
        const sf = rand(2);
        return `${pick(["add", "adds", "sub", "subs"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}, ${pick(["lsl", "lsr", "asr"])} #${rand(sf ? 64 : 32)}`;
    },
    add_extended: () => {
        const sf = rand(2);
        const ext = pick(sf ? ["uxtb", "uxth", "uxtw", "uxtx", "sxtb", "sxth", "sxtw", "sxtx"] : ["uxtb", "uxth", "uxtw", "sxtb", "sxth", "sxtw"]);
        const m = sf && (ext === "uxtx" || ext === "sxtx") ? X() : W();
        return `${pick(["add", "adds", "sub", "subs"])} ${Rboth(sf)}, ${Rboth(sf)}, ${m}, ${ext} #${rand(5)}`;
    },
    carry: () => { const sf = rand(2); return `${pick(["adc", "adcs", "sbc", "sbcs"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}`; },
    logical_shifted: () => {
        const sf = rand(2);
        return `${pick(["and", "bic", "orr", "orn", "eor", "eon", "ands", "bics"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}, ${pick(["lsl", "lsr", "asr", "ror"])} #${rand(sf ? 64 : 32)}`;
    },
    cond_compare: () => {
        const sf = rand(2);
        const operand = rand(2) ? Rboth(sf) : "#" + rand(32);
        return `${pick(["ccmn", "ccmp"])} ${Rboth(sf)}, ${operand}, #${rand(16)}, ${pick(COND)}`;
    },
    cond_select: () => { const sf = rand(2); return `${pick(["csel", "csinc", "csinv", "csneg"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}, ${pick(COND)}`; },
    multiply: () => {
        switch(rand(4))
        {
            case 0: { const sf = rand(2); return `${pick(["madd", "msub"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}`; }
            case 1: return `${pick(["smaddl", "smsubl", "umaddl", "umsubl"])} ${X()}, ${W()}, ${W()}, ${X()}`;
            default: return `${pick(["smulh", "umulh"])} ${X()}, ${X()}, ${X()}`;
        }
    },
    divide: () => { const sf = rand(2); return `${pick(["udiv", "sdiv"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}`; },
    variable_shift: () => { const sf = rand(2); return `${pick(["lslv", "lsrv", "asrv", "rorv"])} ${Rboth(sf)}, ${Rboth(sf)}, ${Rboth(sf)}`; },
    crc32: () => {
        const op = pick(["crc32b", "crc32h", "crc32w", "crc32x", "crc32cb", "crc32ch", "crc32cw", "crc32cx"]);
        return `${op} ${W()}, ${W()}, ${op.endsWith("x") ? X() : W()}`;
    },
    one_source: () => {
        const sf = rand(2);
        const op = pick(sf ? ["rbit", "rev16", "rev32", "rev", "clz", "cls"] : ["rbit", "rev16", "rev", "clz", "cls"]);
        return `${op} ${Rboth(sf)}, ${Rboth(sf)}`;
    },
    load_store: () => {
        // (naturally aligned: the MMU is off, so memory is Device memory)
        const size = rand(4), bytes = 1 << size;
        const offset = rand(128 / bytes) * bytes;
        const ops = [["strb", "ldrb", "ldrsb"], ["strh", "ldrh", "ldrsh"], ["str", "ldr", "ldrsw"], ["str", "ldr"]][size];
        const op = pick(ops);
        const r = op === "ldrsb" || op === "ldrsh" ? (rand(2) ? X() : W()) : size === 3 || op === "ldrsw" ? X() : W();
        const unscaled = (o) => o.replace(/^ldr/, "ldur").replace(/^str/, "stur");
        switch(rand(5))
        {
            case 0: return `${op} ${r}, [x15, #${offset}]`;
            case 1: return `${unscaled(op)} ${r}, [x15, #${offset - (offset >= bytes ? bytes : 0)}]`;
            case 2: return `${op} ${r}, [x15, #${Math.min(offset, 64)}]!`;
            case 3: return `${op} ${r}, [x15], #${pick([bytes, -bytes, 0, 2 * bytes])}`;
            default: {
                // (register offset: the index in X14 or W14, extended and scaled)
                const ext = pick(["lsl", "uxtw", "sxtw", "sxtx"]);
                const index = ext === "uxtw" || ext === "sxtw" ? "w14" : "x14";
                const scale = pick([0, size]);
                // (an element index, scaled by the shift or already in bytes)
                const element = BigInt(rand(128 / bytes / 2));
                return { asm: `${op} ${r === "x14" || r === "w14" ? (size === 3 ? "x13" : "w13") : r}, [x15, ${index}, ${ext} #${scale}]`,
                    x14: scale === size ? element : element * BigInt(bytes) };
            }
        }
    },
    pair: () => {
        const sf = rand(2), bytes = sf ? 8 : 4;
        const offset = rand(64 / bytes) * bytes;
        const op = pick(sf ? ["stp", "ldp"] : ["stp", "ldp", "ldpsw"]);
        const a = op === "ldpsw" ? "x" + rand(7) : (sf ? "x" : "w") + rand(7);
        const b = op === "ldpsw" ? "x" + (7 + rand(7)) : (sf ? "x" : "w") + (7 + rand(7));
        switch(rand(4))
        {
            case 0: return `${op} ${a}, ${b}, [x15, #${offset}]`;
            case 1: return `${op} ${a}, ${b}, [x15, #${offset}]!`;
            case 2: return `${op} ${a}, ${b}, [x15], #${pick([bytes, -2 * bytes, 0])}`;
            default: return `${op.replace("p", "np").replace("npsw", "psw")} ${a}, ${b}, [x15, #${offset}]`.replace("ldnpsw", "ldpsw");
        }
    },
    exclusive: () => {
        const size = rand(4), bytes = 1 << size;
        const suffix = ["b", "h", "", ""][size];
        const r = size === 3 ? X : W;
        const offset = rand(64 / bytes) * bytes;
        const acquire = rand(2) ? "a" : "";
        const release = rand(2) ? "l" : "";
        // (the store's status register differs from the others)
        const t = size === 3 ? "x" + rand(7) : "w" + rand(7);
        switch(rand(4))
        {
            case 0: return `add x15, x15, #${offset}\n    ld${acquire}xr${suffix} ${t}, [x15]\n    st${release}xr${suffix} w13, ${r().replace(/\d+/, d => String(7 + +d % 6))}, [x15]`;
            case 1: return `add x15, x15, #${offset}\n    st${release}xr${suffix} w13, ${r().replace(/\d+/, d => String(7 + +d % 6))}, [x15]`;
            case 2: return `add x15, x15, #${offset}\n    ld${acquire}xr${suffix} ${t}, [x15]\n    clrex\n    st${release}xr${suffix} w13, ${r().replace(/\d+/, d => String(7 + +d % 6))}, [x15]`;
            default: return `add x15, x15, #${offset}\n    ${rand(2) ? `ldar${suffix} ${t}` : `stlr${suffix} ${t}`}, [x15]`;
        }
    },
    exclusive_pair: () => {
        const sf = rand(2), bytes = sf ? 16 : 8;
        const reg = sf ? "x" : "w";
        const offset = rand(64 / bytes) * bytes;
        return `add x15, x15, #${offset}\n    ld${pick(["", "a"])}xp ${reg}1, ${reg}2, [x15]\n    st${pick(["", "l"])}xp w13, ${reg}${3 + rand(4)}, ${reg}${7 + rand(4)}, [x15]`;
    },
    branch: () => {
        const taken = (instruction) => `${instruction}, 1f\n    mov x0, #1\n    b 2f\n1:  mov x0, #2\n2:`;
        switch(rand(4))
        {
            case 0: return taken(`b.${pick(COND.concat(["nv"]))}`).replace("b.nv,", "b.nv").replace(/b\.(\w+), 1f/, "b.$1 1f");
            case 1: return taken(`${pick(["cbz", "cbnz"])} ${pick(["x", "w"])}${1 + rand(14)}`);
            case 2: { const sf = rand(2); return taken(`${pick(["tbz", "tbnz"])} ${sf ? "x" : "w"}${1 + rand(14)}, #${rand(sf ? 64 : 32)}`); }
            default: return `adr x1, .\n    adrp x2, .\n    adr x3, . + ${4 * rand(1000) - 2000}`;
        }
    },
    flags: () => pick([
        `mrs ${X()}, nzcv`,
        `msr nzcv, ${X()}`,
        `msr daifset, #${rand(16)}\n    mrs ${X()}, daif\n    msr daifclr, #15`,
        `mrs ${X()}, currentel`,
        `cmp ${X()}, ${X()}\n    cset ${X()}, ${pick(COND.slice(0, 14))}`,
    ]),
};

const families = Object.keys(FAMILIES).filter(name => !FILTER || name === FILTER);
const cases = [];
for(let n = 0; n < CASES; n++)
{
    const family = families[n % families.length];
    let generated = FAMILIES[family]();
    let x14 = null;
    if(typeof generated === "object") { x14 = generated.x14; generated = generated.asm; }
    const registers = Array.from({ length: 15 }, () => value());
    if(x14 !== null) registers[14] = x14;
    const flags = BigInt(rand(16)) << 28n;
    const memory = Array.from({ length: 16 }, () => next64());
    cases.push({ family, asm: generated, registers, flags, memory });
}

// ---- the guest of one batch
function guest(batch, first)
{
    const lines = [".text", ".balign 4", ".global run_cases", "run_cases:", "    stp x29, x30, [sp, #-96]!",
        "    stp x19, x20, [sp, #16]", "    stp x21, x22, [sp, #32]", "    stp x23, x24, [sp, #48]", "    stp x25, x26, [sp, #64]",
        "    stp x27, x28, [sp, #80]"];
    batch.forEach((c, i) => {
        const n = first + i;
        lines.push(`// case ${n}: ${c.family}`, `    adrp x28, input_${n}`, `    add x28, x28, :lo12:input_${n}`,
            "    ldr x16, [x28, #128]", "    msr nzcv, x16");
        for(let r = 0; r < 14; r += 2) lines.push(`    ldp x${r}, x${r + 1}, [x28, #${8 * r}]`);
        lines.push("    ldr x14, [x28, #112]", `    adrp x15, memory_${n}`, `    add x15, x15, :lo12:memory_${n}`, "    add x15, x15, #64");
        lines.push("    sub x15, x15, #64");
        lines.push("    " + c.asm);
        lines.push(`    adrp x28, output_${n}`, `    add x28, x28, :lo12:output_${n}`);
        for(let r = 0; r < 16; r += 2) lines.push(`    stp x${r}, x${r + 1}, [x28, #${8 * r}]`);
        lines.push("    mrs x16, nzcv", "    str x16, [x28, #128]");
    });
    lines.push("    ldp x19, x20, [sp, #16]", "    ldp x21, x22, [sp, #32]", "    ldp x23, x24, [sp, #48]", "    ldp x25, x26, [sp, #64]",
        "    ldp x27, x28, [sp, #80]", "    ldp x29, x30, [sp], #96", "    ret", ".data", ".balign 64");
    batch.forEach((c, i) => {
        const n = first + i;
        lines.push(`input_${n}:`, ...c.registers.map(v => `    .quad ${hex(v)}`), "    .quad 0", `    .quad ${hex(c.flags)}`, "    .quad 0",
            ".balign 64", `memory_${n}:`, ...c.memory.map(v => `    .quad ${hex(v)}`), ".balign 64",
            `output_${n}:`, "    .zero 136", ".balign 64");
    });
    lines.push(".text", ".global case_table", ".balign 8", "case_table:");
    batch.forEach((_, i) => lines.push(`    .quad output_${first + i}`, `    .quad memory_${first + i}`));
    return lines.join("\n") + "\n";
}

const MAIN = `#include <a64.h>
#include <stdio.h>
void run_cases(void);
extern const unsigned long case_table[][2];
int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    run_cases();
    for(int i = 0; i < CASE_COUNT; i++)
    {
        const unsigned long *out = (const unsigned long *)case_table[i][0];
        const unsigned long *memory = (const unsigned long *)case_table[i][1];
        unsigned long sum = 0;
        for(int k = 0; k < 16; k++) sum = (sum ^ memory[k]) * 0x100000001B3ul + k;
        printf("%d", FIRST + i);
        for(int r = 0; r < 17; r++) printf(" %lx", out[r]);
        printf(" %lx\\n", sum);
    }
    return 0;
}
`;

const directory_base = root + "build/a64-integer-oracle/";
fs.mkdirSync(directory_base, { recursive: true });
let differences = 0, compared = 0;
const only_qemu = process.env.A64_TARGET === "qemu";
for(let first = 0; first < cases.length; first += BATCH)
{
    const batch = cases.slice(first, first + BATCH);
    fs.writeFileSync(directory_base + `cases-${first}.S`, guest(batch, first));
    fs.writeFileSync(directory_base + `main-${first}.c`, MAIN.replace(/CASE_COUNT/g, String(batch.length)).replace(/FIRST/g, String(first)));
    const directory = build(`integer-oracle-${first}`, [directory_base + `cases-${first}.S`, directory_base + `main-${first}.c`],
        { general_regs_only: true });
    const expected = await reference(directory, { timeout: 120000 });
    assert.equal(expected.status, "ok", "QEMU: " + expected.text.slice(-2000));
    if(only_qemu) { compared += batch.length; continue; }
    const got = await actual(directory, { timeout: 300000 });
    assert.equal(got.status, "ok", "v86: " + got.text.slice(-2000));
    const want = expected.text.trim().split("\n"), have = got.text.trim().split("\n");
    assert.equal(have.length, want.length, "line count");
    for(let i = 0; i < want.length; i++)
    {
        compared++;
        if(want[i] !== have[i])
        {
            differences++;
            if(differences <= 20)
            {
                const c = cases[first + i];
                console.log(`DIFF case ${first + i} (${c.family}): ${c.asm.replace(/\n\s*/g, "; ")}\n  inputs ${c.registers.map(hex).join(" ")} nzcv ${hex(c.flags)}\n` +
                    `  qemu ${want[i]}\n  v86  ${have[i]}`);
            }
        }
    }
}
console.log(`integer oracle: ${compared} cases (${families.length} families, seed ${SEED}), ${differences} differences` + (only_qemu ? " (QEMU only)" : ""));
process.exit(differences ? 1 : 0);
