#!/usr/bin/env node
// The A64 page tier against the interpreter (docs/jit-unification-plan.md
// P6.5, J2): random programs of the integer forms the page tier compiles
// (arithmetic, logical, moves, bitfields, shifts, multiply and divide, flags
// and their readers, loads and stores with every addressing mode, pairs,
// literals, acquire/release), mixed with control flow (forward conditional
// branches, counted loops, calls, indirect branches) and with forms it steps
// (CRC32, RBIT, FP moves and arithmetic, exclusives and their spins, system
// register reads).
// Each program is a function the bare-metal guest (MMU on: A64_MMU) calls
// ROUNDS times on its registers and a 1 KiB buffer kept across the calls;
// the registers, NZCV and the buffer at the end must be the same on the
// interpreter and on the page tier (compiling at the first boundary:
// A64_JIT_HOT=1), bit for bit.
//
//   node tests/a64/page_fuzz.mjs [--programs N] [--length N] [--rounds N] [--seed S]
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, actual, root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const PROGRAMS = +option("--programs", 40);
const LENGTH = +option("--length", 120);
const ROUNDS = +option("--rounds", 64);
const SEED = +option("--seed", 1);

let state = BigInt(SEED) * 0x9E3779B97F4A7C15n & (1n << 64n) - 1n || 1n;
function next64()
{
    state ^= state << 13n & (1n << 64n) - 1n;
    state ^= state >> 7n;
    state ^= state << 17n & (1n << 64n) - 1n;
    return state;
}
const rand = n => Number(next64() % BigInt(n));
const pick = list => list[rand(list.length)];

// registers the program computes in (x8 holds the buffer, x16 and x17 are addressing and loop scratch)
const REGS = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
const x = () => "x" + pick(REGS);
const w = () => "w" + pick(REGS);
const r = () => (rand(2) ? x : w)();
const same = () => { const n = pick(REGS); return rand(2) ? ["x" + n, "x" + pick(REGS), "x" + pick(REGS)] : ["w" + n, "w" + pick(REGS), "w" + pick(REGS)]; };
const CONDS = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al"];
// (CSET and its kin take no AL)
const CONDS_NOT_AL = CONDS.slice(0, -1);
const SHIFTS = ["lsl", "lsr", "asr"];
const EXTENDS = ["uxtb", "uxth", "uxtw", "sxtb", "sxth", "sxtw"];
const imm12 = () => rand(4096);
const LOGICAL_IMMS = ["#0xff", "#0xffff", "#0xf0f0f0f0f0f0f0f0", "#0x5555555555555555", "#0x7ffffffffffffffe", "#0xfffffff0", "#0x3c"];
const LOGICAL_IMMS32 = ["#0xff", "#0xffff", "#0xf0f0f0f0", "#0x55555555", "#0x7ffffffe", "#0xfffffff0", "#0x3c"];

// (vector registers v0-v7 in an arrangement)
const ARRANGEMENTS = ["8b", "16b", "4h", "8h", "2s", "4s", "2d"];
const v = t => `v${rand(8)}.${t}`;

let label = 0;
/** One random instruction, or a short sequence (a construct) */
function instruction(depth)
{
    const kind = rand(55);
    const [d, a, b] = same();
    const wide = d.startsWith("x");
    switch(kind)
    {
        case 0: return `add ${d}, ${a}, #${imm12()}`;
        case 1: return `subs ${d}, ${a}, #${imm12()}${rand(2) ? ", lsl #12" : ""}`;
        case 2: return `${pick(["add", "sub", "adds", "subs"])} ${d}, ${a}, ${b}, ${pick(SHIFTS)} #${rand(wide ? 64 : 32)}`;
        case 3: return `${pick(["add", "sub", "adds", "subs"])} ${d}, ${a}, ${wide ? "w" + b.slice(1) : b}, ${pick(EXTENDS)} #${rand(5)}`;
        case 4: return `${pick(["and", "orr", "eor", "ands"])} ${d}, ${a}, ${pick(wide ? LOGICAL_IMMS : LOGICAL_IMMS32)}`;
        case 5: return `${pick(["and", "orr", "eor", "bic", "orn", "eon", "ands", "bics"])} ${d}, ${a}, ${b}, ${pick([...SHIFTS, "ror"])} #${rand(wide ? 64 : 32)}`;
        case 6: return `${pick(["movz", "movn", "movk"])} ${d}, #${rand(65536)}, lsl #${wide ? 16 * rand(4) : 16 * rand(2)}`;
        case 7: return `${pick(["ubfm", "sbfm", "bfm"])} ${d}, ${a}, #${rand(wide ? 64 : 32)}, #${rand(wide ? 64 : 32)}`;
        case 8: return `extr ${d}, ${a}, ${b}, #${rand(wide ? 64 : 32)}`;
        case 9: return `${pick(["adc", "adcs", "sbc", "sbcs"])} ${d}, ${a}, ${b}`;
        case 10: return `${pick(["ccmp", "ccmn"])} ${a}, ${rand(2) ? b : "#" + rand(32)}, #${rand(16)}, ${pick(CONDS)}`;
        case 11: return `${pick(["csel", "csinc", "csinv", "csneg"])} ${d}, ${a}, ${b}, ${pick(CONDS)}`;
        case 12: return `${pick(["madd", "msub"])} ${d}, ${a}, ${b}, ${wide ? x() : w()}`;
        case 13: return `${pick(["smaddl", "smsubl", "umaddl", "umsubl"])} ${x()}, ${w()}, ${w()}, ${x()}`;
        case 14: return `${pick(["smulh", "umulh"])} ${x()}, ${x()}, ${x()}`;
        case 15: return `${pick(["udiv", "sdiv", "lslv", "lsrv", "asrv", "rorv"])} ${d}, ${a}, ${b}`;
        case 16: return `${pick(["rev16", "rev", "clz", "cls"])} ${d}, ${a}`;
        case 17: return `cmp ${a}, ${b}\n    cset ${d}, ${pick(CONDS_NOT_AL)}`;
        case 18: return `adr ${x()}, .`;
        // loads and stores: x8 + an offset in the buffer
        case 19: case 20: {
            const size = pick([["b", 1, w], ["h", 2, w], ["", 4, w], ["", 8, x], ["sb", 1, x], ["sh", 2, x], ["sw", 4, x], ["sb", 1, w], ["sh", 2, w]]);
            const load = size[0].startsWith("s") || rand(2);
            const reg = size[2]();
            const op = load ? "ldr" + size[0] : "str" + size[0];
            const offset = rand(1024 / size[1]) * size[1];
            return `${op} ${reg}, [x8, #${offset}]`;
        }
        case 21: {
            // unscaled, pre- and post-index through x16
            const sz = pick([["", 8, x], ["", 4, w], ["b", 1, w], ["h", 2, w]]);
            const base = 256 + rand(512);
            const imm = rand(64) - 32;
            const load = rand(2);
            const form = pick([`[x16, #${imm}]`, `[x16, #${imm}]!`, `[x16], #${imm}`]);
            const op = (form.startsWith("[x16, #") && !form.endsWith("!") ? (load ? "ldur" : "stur") : load ? "ldr" : "str") + sz[0];
            return `add x16, x8, #${base}\n    ${op} ${sz[2]()}, ${form}`;
        }
        case 22: {
            // register offset
            const sz = pick([["", 8, x, 3], ["", 4, w, 2], ["h", 2, w, 1], ["b", 1, w, 0]]);
            return `mov x16, #${rand(64)}\n    ${rand(2) ? "ldr" : "str"}${sz[0]} ${sz[2]()}, [x8, x16, lsl #${rand(2) ? sz[3] : 0}]`;
        }
        case 23: {
            const pair = rand(2) ? ["x", 8] : ["w", 4];
            const offset = rand(16) * pair[1];
            const form = pick([`[x16, #${offset}]`, `[x16, #${offset}]!`, `[x16], #${offset}`]);
            const r1 = pair[0] + pick(REGS);
            let r2 = pair[0] + pick(REGS);
            while(r2 === r1) r2 = pair[0] + pick(REGS);
            return `add x16, x8, #${rand(512)}\n    ${rand(2) ? "ldp" : "stp"} ${r1}, ${r2}, ${form}`;
        }
        case 24: return `ldr ${x()}, ${label++ % 2 ? "." : ".+8"}`;
        case 25: return `add x16, x8, #${8 * rand(64)}\n    ${pick(["ldar", "stlr"])} ${x()}, [x16]`;
        // control flow
        case 26: case 27: {
            if(depth > 1) return "nop";
            const n = ++label;
            const test = pick([`b.${pick(CONDS)}`, `cbz ${r()},`, `cbnz ${r()},`, `tbz ${x()}, #${rand(64)},`, `tbnz ${x()}, #${rand(64)},`]);
            const body = Array.from({ length: 1 + rand(3) }, () => instruction(depth + 1)).join("\n    ");
            return `${test} 1${n}f\n    ${body}\n1${n}:`;
        }
        case 28: {
            if(depth > 0) return "nop";
            const n = ++label;
            const body = Array.from({ length: 1 + rand(4) }, () => instruction(depth + 1)).join("\n    ");
            return `mov x17, #${2 + rand(6)}\n2${n}:\n    ${body}\n    subs x17, x17, #1\n    b.ne 2${n}b`;
        }
        // (calls only from the body: a leaf calling a leaf could recurse forever)
        case 29: return depth === 0 ? `bl leaf_${rand(3)}` : "nop";
        case 30: { const n = ++label; return `adr x16, 3${n}f\n    br x16\n    ${instruction(depth + 1)}\n3${n}:`; }
        // forms the page tier steps
        case 31: return `${pick(["crc32b", "crc32h", "crc32w", "crc32cb"])} ${w()}, ${w()}, ${w()}`;
        case 32: return `rbit ${d}, ${a}`;
        case 33: return `fmov d0, ${x()}\n    fmov d1, ${x()}\n    fadd d2, d0, d1\n    fmov ${x()}, d2`;
        case 34: {
            // (not in a loop: the status register is the loop's counter)
            if(depth > 0) return "clrex";
            const value = x();
            let status = pick(REGS);
            while("x" + status === value) status = pick(REGS);
            return `add x16, x8, #${8 * rand(64)}\n    ldxr ${x()}, [x16]\n    stxr w${status}, ${value}, [x16]`;
        }
        case 35: return `mrs ${x()}, nzcv`;
        case 36: return `msr nzcv, ${x()}`;
        case 37: return `${pick(["lsl", "lsr", "asr", "ror"])} ${d}, ${a}, #${rand(wide ? 64 : 32)}`;
        case 38: {
            const op = pick(["sxtb", "sxth", "uxtb", "uxth"]);
            return `${op} ${op.startsWith("u") ? "w" + d.slice(1) : d}, w${a.slice(1)}`;
        }
        // SIMD&FP loads and stores (S, D, Q; single and pair), and moves into general registers
        case 39: {
            const [reg, size] = pick([["s", 4], ["d", 8], ["q", 16]]);
            return `${rand(2) ? "ldr" : "str"} ${reg}${rand(8)}, [x8, #${rand(1024 / size) * size}]`;
        }
        case 40: {
            const [reg, size] = pick([["s", 4], ["d", 8], ["q", 16]]);
            const a1 = rand(8);
            const a2 = (a1 + 1 + rand(7)) % 8;
            const form = pick([`[x16, #${size * rand(4)}]`, `[x16, #${size * rand(4)}]!`, `[x16], #${size * rand(4)}`]);
            // (aligned, or not: with cores in workers an unaligned store is a plain one)
            return `add x16, x8, #${rand(2) ? 16 * rand(32) : 256 + rand(256)}\n    ${rand(2) ? "ldp" : "stp"} ${reg}${a1}, ${reg}${a2}, ${form}`;
        }
        case 41: return `${pick(["fmov " + x() + ", d" + rand(8), "umov " + x() + ", v" + rand(8) + ".d[1]", "fmov " + w() + ", s" + rand(8)])}`;
        case 42: return `add x16, x8, #${256 + rand(512)}\n    ${rand(2) ? "ldr" : "str"} q${rand(8)}, [x16, #${16 * (rand(8) - 4)}]!`;
        // scalar FP on ordinary values (the page tier's fast path) and back into a general register
        case 43: case 44: {
            const p = rand(2) ? "d" : "s";
            const [f1, f2, f3, f4] = [rand(8), rand(8), rand(8), rand(8)];
            const op = pick(["fadd", "fsub", "fmul", "fdiv", "fnmul"]);
            return `scvtf ${p}${f1}, ${x()}\n    scvtf ${p}${f2}, ${w()}\n    ${op} ${p}${f3}, ${p}${f1}, ${p}${f2}\n` +
                `    ${pick(["fmadd", "fmsub", "fnmadd", "fnmsub"])} ${p}${f4}, ${p}${f3}, ${p}${f2}, ${p}${f1}\n    fcvtzs ${x()}, ${p}${f4}`;
        }
        case 45: {
            const p = rand(2) ? "d" : "s";
            return `${pick(["fabs", "fneg", "fmov"])} ${p}${rand(8)}, ${p}${rand(8)}\n    fcmp${rand(2) ? "e" : ""} ${p}${rand(8)}, ${rand(2) ? p + rand(8) : "#0.0"}\n    cset ${d}, ${pick(CONDS_NOT_AL)}`;
        }
        // AdvSIMD vector forms (the page tier's NEON templates, and helper calls)
        case 47: {
            const op = pick(["add", "sub", "cmeq", "cmtst", "cmgt", "cmge", "cmhi", "cmhs", "smax", "umax", "smin", "umin", "mul", "urhadd", "sqadd"]);
            const arrangements = ["add", "sub", "cmeq", "cmtst", "cmgt", "cmge", "cmhi", "cmhs", "sqadd"].includes(op) ? ARRANGEMENTS : ARRANGEMENTS.slice(0, 6);
            const t = pick(arrangements);
            return `${op} ${v(t)}, ${v(t)}, ${v(t)}`;
        }
        case 48: {
            const t = pick(["8b", "16b"]);
            return `${pick(["and", "bic", "orr", "orn", "eor", "bsl", "bit", "bif"])} ${v(t)}, ${v(t)}, ${v(t)}`;
        }
        case 49: {
            const t = pick(ARRANGEMENTS);
            switch(rand(6))
            {
                case 0: { const b8 = pick(["8b", "16b"]); return `${pick(["not", "cnt"])} ${v(b8)}, ${v(b8)}`; }
                case 1: return `${pick(["abs", "neg"])} ${v(t)}, ${v(t)}`;
                case 2: return `${pick(["cmeq", "cmgt", "cmge", "cmle", "cmlt"])} ${v(t)}, ${v(t)}, #0`;
                case 3: { const [op, ts] = pick([["rev64", ARRANGEMENTS.slice(0, 6)], ["rev32", ARRANGEMENTS.slice(0, 4)], ["rev16", ["8b", "16b"]]]); const r = pick(ts); return `${op} ${v(r)}, ${v(r)}`; }
                case 4: { const [narrow, source] = pick([["8b", "8h"], ["4h", "4s"], ["2s", "2d"]]); return `xtn ${v(narrow)}, ${v(source)}`; }
                default: { const [narrow, source] = pick([["16b", "8h"], ["8h", "4s"], ["4s", "2d"]]); return `xtn2 ${v(narrow)}, ${v(source)}`; }
            }
        }
        case 50: {
            const t = pick(ARRANGEMENTS);
            const esize = { b: 8, h: 16, s: 32, d: 64 }[t.slice(-1)];
            const op = pick(["shl", "sshr", "ushr"]);
            return `${op} ${v(t)}, ${v(t)}, #${op === "shl" ? rand(esize) : 1 + rand(esize)}`;
        }
        case 51: switch(rand(9))
        {
            case 0: return pick([`movi ${v("16b")}, #${rand(256)}`, `movi ${v("8b")}, #${rand(256)}`, `movi ${v("2d")}, #0xff00ff0000ffff00`, `movi d${rand(8)}, #0x00ff00ff00ff00ff`,
                `movi ${v("4s")}, #${rand(256)}, lsl #${8 * rand(4)}`, `mvni ${v("2s")}, #${rand(256)}, msl #${pick([8, 16])}`, `fmov ${v("4s")}, #1.5`, `fmov ${v("2d")}, #-2.0`]);
            case 1: return `${pick(["orr", "bic"])} ${v(pick(["4s", "2s"]))}, #${rand(256)}, lsl #${8 * rand(4)}`;
            case 2: { const [t, r] = pick([["8b", w], ["16b", w], ["4h", w], ["8h", w], ["2s", w], ["4s", w], ["2d", x]]); return `dup ${v(t)}, ${r()}`; }
            case 3: { const [t, e, n] = pick([["16b", "b", 16], ["8h", "h", 8], ["4s", "s", 4], ["2d", "d", 2], ["8b", "b", 16], ["2s", "s", 4]]); return `dup ${v(t)}, v${rand(8)}.${e}[${rand(n)}]`; }
            case 4: { const [e, n, r] = pick([["b", 16, w], ["h", 8, w], ["s", 4, w], ["d", 2, x]]); return `mov v${rand(8)}.${e}[${rand(n)}], ${r()}`; }
            case 5: { const [e, n] = pick([["b", 16], ["h", 8], ["s", 4], ["d", 2]]); return `mov v${rand(8)}.${e}[${rand(n)}], v${rand(8)}.${e}[${rand(n)}]`; }
            case 6: return pick([`umov ${w()}, v${rand(8)}.b[${rand(16)}]`, `umov ${w()}, v${rand(8)}.h[${rand(8)}]`, `mov ${w()}, v${rand(8)}.s[${rand(4)}]`,
                `mov ${x()}, v${rand(8)}.d[${rand(2)}]`, `smov ${x()}, v${rand(8)}.b[${rand(16)}]`, `smov ${w()}, v${rand(8)}.h[${rand(8)}]`, `smov ${x()}, v${rand(8)}.s[${rand(4)}]`]);
            case 7: return pick([`fmov d${rand(8)}, ${x()}`, `fmov s${rand(8)}, ${w()}`, `fmov v${rand(8)}.d[1], ${x()}`, `fmov ${x()}, v${rand(8)}.d[1]`]);
            default: { const [e, n] = pick([["b", 16], ["h", 8], ["s", 4], ["d", 2]]); return `mov ${e}${rand(8)}, v${rand(8)}.${e}[${rand(n)}]`; }
        }
        case 52: {
            if(rand(3) === 0) { const q = rand(2); return `ext ${v(q ? "16b" : "8b")}, ${v(q ? "16b" : "8b")}, ${v(q ? "16b" : "8b")}, #${rand(q ? 16 : 8)}`; }
            const t = pick([...ARRANGEMENTS.slice(0, 6), "2d"]);
            return `${pick(["zip1", "zip2", "uzp1", "uzp2", "trn1", "trn2"])} ${v(t)}, ${v(t)}, ${v(t)}`;
        }
        case 53: {
            // vector FP on ordinary values (converted integers): the fast path, FMLA and FMLS fused
            const t = pick(["2s", "4s", "2d"]);
            const [f1, f2, f3] = [rand(8), rand(8), rand(8)];
            return `scvtf v${f1}.${t}, v${f1}.${t}\n    scvtf v${f2}.${t}, v${f2}.${t}\n` +
                `    ${pick(["fadd", "fsub", "fmul", "fdiv", "fmla", "fmls"])} v${f3}.${t}, v${f1}.${t}, v${f2}.${t}`;
        }
        case 54: {
            // a load-exclusive spin (the same value at the same load: a yield from the helper,
            // P3.9), its result used after it and the register changed before the next one
            if(depth > 0) return "nop";
            const n = ++label;
            const loaded = x();
            let sum = x();
            while(sum === loaded) sum = x();
            return `mov x17, #${6 + rand(6)}\n4${n}:\n    add x16, x8, #${8 * rand(64)}\n    ldxr ${loaded}, [x16]\n` +
                `    add ${sum}, ${sum}, ${loaded}\n    eor ${loaded}, ${loaded}, #1\n    subs x17, x17, #1\n    b.ne 4${n}b\n    clrex`;
        }
        default: return `${pick(["ubfx", "sbfx"])} ${d}, ${a}, #${rand(wide ? 32 : 16)}, #${1 + rand(wide ? 32 : 16)}`;
    }
}

function program(n)
{
    // (half the programs start with FPSR.IXC set: the FP fast path's condition)
    const fpsr = n % 2 ? "mov x16, #0x10\n    msr fpsr, x16" : "msr fpsr, xzr";
    const body = Array.from({ length: LENGTH }, () => instruction(0)).join("\n    ");
    const leaf = k => `leaf_${k}:\n    ${Array.from({ length: 3 }, () => instruction(2)).join("\n    ")}\n    ret`;
    return `// generated by tests/a64/page_fuzz.mjs (seed ${SEED}, program ${n})
    .text
    .balign 4096
    .global fuzz_body
fuzz_body:
    stp x29, x30, [sp, #-16]!
    mov x8, x0
${REGS.map(i => `    ldr x${i}, [x8, #${1024 + 8 * i}]`).join("\n")}
    ldr x16, [x8, #${1024 + 8 * 16}]
    msr nzcv, x16
    ${fpsr}
    ${body}
${REGS.map(i => `    str x${i}, [x8, #${1024 + 8 * i}]`).join("\n")}
    mrs x16, nzcv
    str x16, [x8, #${1024 + 8 * 16}]
    ldp x29, x30, [sp], #16
    ret
${[0, 1, 2].map(leaf).join("\n")}
`;
}

const HARNESS = `#include <a64.h>
#include <stdio.h>
#include <stdint.h>
void fuzz_body(uint64_t *buffer);
static uint64_t buffer[(1024 + 8 * 17) / 8 + 1] __attribute__((aligned(64)));
int main(int argc, char **argv)
{
    uint64_t s = SEED;
    for(unsigned i = 0; i < sizeof(buffer) / 8; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; buffer[i] = s; }
    for(int round = 0; round < ROUNDS; round++) fuzz_body(buffer);
    for(unsigned i = 0; i < sizeof(buffer) / 8; i++) printf("%016lx%c", (unsigned long)buffer[i], i % 4 == 3 ? '\\n' : ' ');
    printf("\\n");
    return 0;
}
`;

const directory = root + "build/a64-page-fuzz/";
fs.mkdirSync(directory, { recursive: true });
process.env.A64_MMU = "1";
let differences = 0, compiled = 0, native = 0, steps = 0;
for(let n = 0; n < PROGRAMS; n++)
{
    const seed = next64();
    fs.writeFileSync(directory + "fuzz.S", program(n));
    fs.writeFileSync(directory + "harness.c", HARNESS);
    const guest = build("page-fuzz", [directory + "harness.c", directory + "fuzz.S"], { cflags: [`-DSEED=${seed}ULL`, `-DROUNDS=${ROUNDS}`] });
    delete process.env.A64_JIT;
    const interpreted = await actual(guest);
    process.env.A64_JIT = "1";
    process.env.A64_JIT_HOT = "1";
    const jit = await actual(guest);
    assert.equal(interpreted.status, "ok", `program ${n} (interpreter): ${interpreted.status}\n${interpreted.text}`);
    assert.equal(jit.status, "ok", `program ${n} (page tier): ${jit.status}\n${jit.text}`);
    const t = jit.page_tier;
    compiled += t.compiled;
    native += t.retired;
    steps += t.steps;
    if(interpreted.text !== jit.text)
    {
        differences++;
        fs.copyFileSync(directory + "fuzz.S", directory + `fuzz-diff-${n}.S`);
        console.log(`program ${n}: differs (kept as fuzz-diff-${n}.S)\n interpreter:\n${interpreted.text}\n page tier:\n${jit.text}`);
    }
}
delete process.env.A64_JIT;
console.log(`page fuzz: ${PROGRAMS} programs of ${LENGTH} constructs x ${ROUNDS} rounds, ${differences} differences ` +
    `(page tier: ${compiled} compiles, ${native} native instructions, ${steps} steps)`);
assert.ok(native > 0, "the page tier ran code");
process.exit(differences ? 1 : 0);
