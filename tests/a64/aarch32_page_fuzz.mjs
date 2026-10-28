#!/usr/bin/env node
// AArch32's page functions against the interpreter (docs/aarch32-plan.md
// Q6.2, Q6.3; page_fuzz.mjs's A64 counterpart): random A32 and T32 programs
// of the forms the page tier compiles natively or by helper calls (data
// processing with every shift and condition, MOVW and MOVT, multiplies,
// extends, bit fields, loads and stores in every addressing mode, LDM, STM,
// PUSH and POP, IT blocks, forward branches, counted loops, calls, CBZ and
// CBNZ, VFP and its loads and stores, VLD1 and VST1), run at EL0 (tests/a64/aarch32/fuzz.c) ROUNDS times on their
// registers and a buffer; the buffer, the registers and NZCV at the end
// must be the same interpreted and with the page tier (a64_page_aarch32,
// compiling at the first boundary), bit for bit.
//
//   node tests/a64/aarch32_page_fuzz.mjs [--programs N] [--length N] [--rounds N] [--seed S] [--write DIR]
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, actual, root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const PROGRAMS = +option("--programs", 40);
const LENGTH = +option("--length", 100);
const ROUNDS = +option("--rounds", 32);
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

// the registers programs compute in (r8 holds the buffer, r11 counts loops,
// r12 is addressing scratch)
const REGS = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10];
const LOW = [0, 1, 2, 3, 4, 5, 6, 7];
const r = () => "r" + pick(REGS);
/** k distinct registers of REGS, in order */
const distinct = k => { const all = REGS.slice(); for(let i = all.length - 1; i > 0; i--) { const j = rand(i + 1); [all[i], all[j]] = [all[j], all[i]]; } return all.slice(0, k).sort((a, b) => a - b).map(n => "r" + n); };
const lo = () => "r" + pick(LOW);
const CONDS = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le"];
const SHIFTS = ["lsl", "lsr", "asr", "ror"];
// immediates both instruction sets encode
const IMMS = () => pick([rand(256), rand(256), 0xFF000000, 0x3FC00, 0x80000000, 0xF0000000, 0]);
const shift = () => { const kind = pick(SHIFTS); return rand(3) ? "" : rand(8) === 0 ? ", rrx" : `, ${kind} #${kind === "lsl" || kind === "ror" ? 1 + rand(31) : 1 + rand(32)}`; };

let label = 0;
let thumb = false;
/** an instruction's condition suffix: A32's any, T32's only in an IT block (it()) */
const cond = () => !thumb && rand(4) === 0 ? pick(CONDS) : "";

/** An Advanced SIMD data processing instruction (Q6.3 part 3): on D or Q
 * registers its operands from the buffer (VLDR), its result back there
 * (VSTR: both halves of a Q register), sometimes another D register too */
function neon_op()
{
    const q = rand(2) === 1;
    const R = () => q ? rand(16) : rand(32);
    const name = x => (q ? "q" : "d") + x;
    const [d, n, m] = [R(), R(), R()];
    const halves = x => q ? [2 * x, 2 * x + 1] : [x];
    const load = x => halves(x).map(h => `vldr d${h}, [r8, #${8 * rand(128)}]`);
    const store = x => halves(x).map(h => `vstr d${h}, [r8, #${8 * rand(128)}]`);
    const size = pick([8, 16, 32]);
    const shifted = (bits, shifts) => rand(256) * 2 ** pick(shifts) >>> 0;
    let op;
    switch(rand(9))
    {
        case 0: op = `${pick(["vadd", "vsub"])}.i${pick([8, 16, 32, 64])} ${name(d)}, ${name(n)}, ${name(m)}`; break;
        case 1: op = `${pick(["vand", "vbic", "vorr", "vorn", "veor", "vbsl", "vbit", "vbif"])} ${name(d)}, ${name(n)}, ${name(m)}`; break;
        case 2: op = `${pick(["vceq.i", "vtst.", "vcgt.s", "vcgt.u", "vcge.s", "vcge.u", "vmax.s", "vmax.u", "vmin.s", "vmin.u"])}${size} ${name(d)}, ${name(n)}, ${name(m)}`; break;
        case 3: op = `vmul.i${pick([16, 32])} ${name(d)}, ${name(n)}, ${name(m)}`; break;
        case 4: {
            const e = pick([8, 16, 32, 64]);
            op = rand(2) ? `vshl.i${e} ${name(d)}, ${name(m)}, #${rand(e)}` : `vshr.${pick(["s", "u"])}${e} ${name(d)}, ${name(m)}, #${1 + rand(e)}`;
            break;
        }
        case 5: op = pick([`vmov.i8 ${name(d)}, #${rand(256)}`, `vmov.i16 ${name(d)}, #${shifted(16, [0, 8])}`,
            `vmov.i32 ${name(d)}, #${shifted(32, [0, 8, 16, 24])}`, `vmvn.i32 ${name(d)}, #${shifted(32, [0, 8, 16, 24])}`,
            `vorr.i32 ${name(d)}, #${shifted(32, [0, 8, 16, 24])}`, `vbic.i16 ${name(d)}, #${shifted(16, [0, 8])}`,
            `vmov.i64 ${name(d)}, #0xff00ff0000ffff00`, `vmov.f32 ${name(d)}, #${pick(["1.0", "-2.5", "0.125"])}`,
            `vmov.i32 ${name(d)}, #0x${rand(256).toString(16)}ff`]); break;
        case 6: { const e = pick([8, 16, 32]); op = `vdup.${e} ${name(d)}, d${rand(32)}[${rand(64 / e)}]`; break; }
        case 7: op = rand(2) ? `vext.8 ${name(d)}, ${name(n)}, ${name(m)}, #${rand(q ? 16 : 8)}` :
            pick([`vrev64.${pick([8, 16, 32])}`, `vrev32.${pick([8, 16])}`, "vrev16.8"]) + ` ${name(d)}, ${name(m)}`; break;
        default: op = pick(["vmvn", "vcnt.8", `vabs.s${size}`, `vneg.s${size}`]) + ` ${name(d)}, ${name(m)}`; break;
    }
    return [...load(n), ...load(m), ...load(d), op, ...store(d), ...(rand(2) ? [`vstr d${rand(32)}, [r8, #${8 * rand(128)}]`] : [])].join("\n    ");
}

/** One instruction that may run conditionally (in an IT block or with a condition): no branch */
function plain(c = "")
{
    const s = c ? (rand(4) === 0 ? "s" : "") : (rand(3) === 0 ? "s" : "");
    switch(rand(30))
    {
        case 25: case 26: return c ? plain(c) : neon_op();
        case 27: case 28: {
            // transfers (Q6.3 part 4): the thread ID registers, VMRS, VMOV
            // between core registers and scalars, VDUP (core)
            const [a, b] = distinct(2), d = rand(32);
            const lane = e => rand(64 / e);
            switch(rand(5))
            {
                case 0: return `mcr${c} p15, 0, ${a}, c13, c0, 2
    mrc${c} p15, 0, ${b}, c13, c0, ${pick([2, 3])}`;
                case 1: return `vmov${c} s${rand(8)}, ${a}
    vmov${c} s${8 + rand(8)}, ${b}
    vcmp${c}.f32 s${rand(8)}, s${8 + rand(8)}
    ` +
                    (rand(2) ? `vmrs${c} APSR_nzcv, fpscr` : `vmrs${c} ${a}, fpscr`);
                case 2: { const t = pick(["s8", "u8", "s16", "u16", "32"]); return `vldr d${d}, [r8, #${8 * rand(128)}]
    vmov${c}.${t} ${a}, d${d}[${lane(+t.replace(/[su]/, ""))}]`; }
                case 3: { const e = pick([8, 16, 32]); return `vmov${c}.${e} d${d}[${lane(e)}], ${a}
    vmov${c} ${a}, ${b}, d${d}`; }
                default: {
                    const e = pick([8, 16, 32]), q = rand(2) ? rand(16) : -1;
                    return q >= 0 ? `vdup${c}.${e} q${q}, ${a}
    vstr d${2 * q + rand(2)}, [r8, #${8 * rand(128)}]` :
                        `vdup${c}.${e} d${d}, ${a}
    vmov${c} ${a}, ${b}, d${d}`;
                }
            }
        }
        case 0: case 1: return `${pick(["add", "adc", "sub", "sbc", "rsb", "and", "orr", "eor", "bic"])}${s}${c} ${r()}, ${r()}, ${r()}${shift()}`;
        case 2: case 3: return `${pick(["add", "adc", "sub", "sbc", "rsb", "and", "orr", "eor", "bic"])}${s}${c} ${r()}, ${r()}, #${IMMS()}`;
        case 4: return `${pick(["mov", "mvn"])}${s}${c} ${r()}, ${r()}${shift()}`;
        case 5: return `${pick(["mov", "mvn"])}${s}${c} ${r()}, #${IMMS()}`;
        case 6: return `${pick(["cmp", "cmn", "tst", "teq"])}${c} ${r()}, ${rand(2) ? r() + shift() : "#" + IMMS()}`;
        case 7: return `${pick(["lsl", "lsr", "asr", "ror"])}${s}${c} ${r()}, ${r()}, ${rand(2) ? "#" + (1 + rand(31)) : r()}`;
        case 8: return `${rand(2) ? "movw" : "movt"}${c} ${r()}, #${rand(65536)}`;
        case 9: return pick([`mul${c} ${r()}, ${r()}, ${r()}`, `mla${c} ${r()}, ${r()}, ${r()}, ${r()}`, `mls${c} ${r()}, ${r()}, ${r()}, ${r()}`]);
        case 10: { const [low, high] = distinct(2); return `${pick(["umull", "smull", "umlal", "smlal"])}${c} ${low}, ${high}, ${r()}, ${r()}`; }
        case 11: return `${pick(["uxtb", "uxth", "sxtb", "sxth"])}${c} ${r()}, ${r()}${rand(2) ? ", ror #" + pick([8, 16, 24]) : ""}`;
        case 12: return pick([`clz${c} ${r()}, ${r()}`, `rev${c} ${r()}, ${r()}`, `rev16${c} ${r()}, ${r()}`, `rbit${c} ${r()}, ${r()}`, `revsh${c} ${r()}, ${r()}`]);
        case 13: { const lsb = rand(32), width = 1 + rand(32 - lsb); return pick([`ubfx${c} ${r()}, ${r()}, #${lsb}, #${width}`, `sbfx${c} ${r()}, ${r()}, #${lsb}, #${width}`, `bfi${c} ${r()}, ${r()}, #${lsb}, #${width}`, `bfc${c} ${r()}, #${lsb}, #${width}`]); }
        case 14: case 15: {
            // a load or store of the buffer: an immediate offset
            // (A32's halfword and signed forms have 8 bits of offset)
            const [op, align] = pick([["ldr", 4], ["str", 4], ["ldrb", 1], ["strb", 1], ["ldrh", 2], ["strh", 2], ["ldrsb", 1], ["ldrsh", 2]]);
            const most = /h|sb/.test(op) ? 256 : 2048;
            return `${op}${c} ${r()}, [r8, #${align * rand(Math.min(255, most / align))}]`;
        }
        case 16: {
            // a register offset (the index masked into the buffer, as a byte offset of words)
            const [op, k] = pick([["ldr", 2], ["str", 2], ["ldrb", 0], ["strb", 0], ["ldrh", 1], ["strh", 1], ["ldrsh", 1], ["ldrsb", 0]]);
            // (A32 and T32 both shift a word's index by LSL #2)
            return k === 2 && rand(2) ? `and${c} r12, ${r()}, #0xff\n    ${op}${c} ${r()}, [r8, r12, lsl #2]` :
                `and${c} r12, ${r()}, #${k ? "0x3fc" : "0xff"}\n    ${op}${c} ${r()}, [r8, r12]`;
        }
        case 17: {
            // pre- and post-indexed with writeback, through r12
            const [op, a] = pick([["ldr", 4], ["str", 4], ["ldrb", 1], ["strb", 1], ["ldrh", 2], ["strh", 2]]);
            const off = a * (1 + rand(16));
            return `add${c} r12, r8, #${16 * rand(64)}\n    ` + (rand(2) ? `${op}${c} ${r()}, [r12, #${off}]!` : `${op}${c} ${r()}, [r12], #${rand(2) ? off : -off}`);
        }
        case 18: { const t = pick([0, 2, 4, 6]); return `${rand(2) ? "ldrd" : "strd"}${c} r${t}, r${t + 1}, [r8, #${8 * rand(32)}]`; }
        case 19: {
            // (T32's LDM and STM of one register are CONSTRAINED UNPREDICTABLE:
            // v86 transfers it; the assembler makes LDM IA! and STMDB! of one LDR and STR)
            const list = distinct(1 + rand(5)).join(", ");
            return `add${c} r12, r8, #${16 * rand(64)}\n    ${pick(["ldm", "stm", "ldmdb", "stmdb"])}${c} r12${rand(2) ? "!" : ""}, {${list}}`;
        }
        case 20: return `${pick(["qadd", "qsub", "uadd8", "usub16", "sadd16", "uhadd8", "sel"])}${c} ${r()}, ${r()}, ${r()}`;
        case 21: case 22: {
            // VFP's loads and stores (Q6.3): VLDR, VSTR of S and D, observed
            // through core registers; VLDM, VSTM through r12
            const [a, b] = distinct(2), d = rand(32), sr = rand(32);
            switch(rand(5))
            {
                case 0: return `vldr${c} d${d}, [r8, #${4 * rand(256)}]\n    vmov${c} ${a}, ${b}, d${d}`;
                case 1: return `vmov${c} d${d}, ${a}, ${b}\n    vstr${c} d${d}, [r8, #${4 * rand(256)}]`;
                case 2: return `vldr${c} s${sr}, [r8, #${4 * rand(256)}]\n    vmov${c} ${a}, s${sr}`;
                case 3: return `vmov${c} s${sr}, ${a}\n    vstr${c} s${sr}, [r8, #${4 * rand(256)}]`;
                default: {
                    const n = 1 + rand(4), f = rand(32 - n), wb = rand(2) ? "!" : "";
                    const list = `{d${f}-d${f + n - 1}}`;
                    return `add${c} r12, r8, #${16 * rand(48) + 64}\n    ` + pick([`vldmia${c} r12${wb}, ${list}`, `vstmia${c} r12${wb}, ${list}`,
                        `vldmdb${c} r12!, ${list}`, `vstmdb${c} r12!, ${list}`]) + `\n    vmov${c} ${a}, ${b}, d${f}`;
                }
            }
        }
        case 24: {
            // VFP's arithmetic and moves (Q6.3): values from integers, an
            // operation, back to a core register; D's through two core registers
            const [a, b] = distinct(2), x = rand(8), y = rand(8), z = rand(8), dd = rand(16);
            const op = pick(["vadd", "vsub", "vmul", "vnmul", "vdiv"]);
            const unary = pick(["vmov", "vabs", "vneg"]);
            return rand(2) ?
                `vmov${c} s${x}, ${a}\n    vcvt${c}.f32.s32 s${x}, s${x}\n    vmov${c} s${y}, ${b}\n    vcvt${c}.f32.s32 s${y}, s${y}\n    ` +
                `${op}${c}.f32 s${z}, s${x}, s${y}\n    ${unary}${c}.f32 s${z + 8}, s${z}\n    vmov${c} ${a}, s${z + 8}` :
                `vmov${c} s${x}, ${a}\n    vcvt${c}.f64.s32 d${x}, s${x}\n    vmov${c} s${y + 8}, ${b}\n    vcvt${c}.f64.s32 d${y + 8}, s${y + 8}\n    ` +
                `${op}${c}.f64 d${dd}, d${x}, d${y + 8}\n    ${unary}${c}.f64 d${dd + 16}, d${dd}\n    vmov${c} ${a}, ${b}, d${dd + 16}`;
        }
        case 23: {
            // VLD1, VST1 (multiple, all lanes): unconditional; through r12,
            // word aligned or not, with an alignment specifier or not
            if(c) return plain(c);
            const n = pick([1, 2, 3, 4]), f = rand(33 - n), [a, b] = distinct(2);
            const list = `{${Array.from({ length: n }, (_, i) => "d" + (f + i)).join(", ")}}`;
            const aligned = rand(3) === 0;
            const spec = aligned ? pick([":64", n === 2 || n === 4 ? ":128" : ":64"]) : "";
            // (constants both sets encode: 16 * k, then a small one)
            const skew = aligned ? 0 : 4 * rand(4) + pick([0, 0, 1, 2]);
            const op = rand(2) ? "vld1" : "vst1";
            return `add r12, r8, #${16 * rand(96)}\n    ${skew ? `add r12, r12, #${skew}\n    ` : ""}${op}.${pick([8, 16, 32, 64])} ${list}, [r12${spec}]${rand(2) ? "!" : ""}\n    vmov ${a}, ${b}, d${f}`;
        }
        default: return `vmov${c} s${rand(8)}, ${r()}\n    vcvt${c}.f32.s32 s${rand(8)}, s${rand(8)}\n    vadd${c}.f32 s${rand(8)}, s${rand(8)}, s${rand(8)}\n    vmov${c} ${r()}, s${rand(8)}`;
    }
}

/** One construct of the body: an instruction, an IT block, control flow */
function construct(depth)
{
    switch(rand(depth ? 6 : 14))
    {
        case 0: case 1: case 2: case 3: case 4: {
            const c = cond();
            return plain(c).split("\n    ").map(line => line).join("\n    ");
        }
        case 5: {
            if(!thumb) return plain(pick(CONDS));
            // an IT block: up to four instructions, each its own condition or the inverse
            const c = pick(CONDS), n = 1 + rand(4);
            const inverse = { eq: "ne", ne: "eq", cs: "cc", cc: "cs", mi: "pl", pl: "mi", vs: "vc", vc: "vs", hi: "ls", ls: "hi", ge: "lt", lt: "ge", gt: "le", le: "gt" };
            const pattern = Array.from({ length: n - 1 }, () => rand(2) ? "t" : "e");
            const conds = [c, ...pattern.map(p => p === "t" ? c : inverse[c])];
            // (an IT block's instructions one each: no multi-instruction plain forms)
            const body = conds.map(x => {
                let line;
                do line = plain(x); while(line.includes("\n"));
                return line;
            });
            return `it${pattern.join("")} ${c}\n    ${body.join("\n    ")}`;
        }
        case 6: { const l = label++; return `b${pick(CONDS)} 1${l}f\n    ${plain()}\n1${l}:`; }
        case 7: { const l = label++; return `b 1${l}f\n    ${plain()}\n1${l}:`; }
        case 8: {
            // a counted loop (r11 its counter)
            const l = label++;
            return `mov r11, #${2 + rand(5)}\n2${l}:\n    ${construct(depth + 1)}\n    ${construct(depth + 1)}\n    subs r11, r11, #1\n    bne 2${l}b`;
        }
        case 9: return `bl leaf_${rand(3)}`;
        case 10: {
            if(!thumb) return plain(cond());
            const l = label++;
            return `${pick(["cbz", "cbnz"])} ${lo()}, 1${l}f\n    ${plain()}\n1${l}:`;
        }
        case 11: {
            // (balanced: as many popped as pushed, into other registers maybe)
            const k = 1 + rand(4);
            return `push {${distinct(k).join(", ")}}\n    ${plain()}\n    pop {${distinct(k).join(", ")}}`;
        }
        case 12: return `mrs r12, apsr\n    eor r12, r12, #0x${pick(["40000000", "20000000", "80000000", "10000000"])}\n    msr apsr_nzcvq, r12`;
        default: return plain(cond());
    }
}

function program(n)
{
    thumb = n % 2 === 1;
    label = 0;
    const body = Array.from({ length: LENGTH }, () => construct(0)).join("\n    ");
    // (leaves return by BX LR, by POP of the PC or LDR of it from the
    // stack, A32's maybe early by a conditional BX)
    const leaf = k => {
        const body = Array.from({ length: 3 }, () => plain()).join("\n    ");
        const early = !thumb && rand(2) ? `cmp ${r()}, ${r()}\n    bx${pick(CONDS)} lr\n    ` : "";
        switch(k)
        {
            case 0: return `leaf_0:\n    ${early}${body}\n    bx lr`;
            case 1: return `leaf_1:\n    push {r4, lr}\n    ${early}${body}\n    pop {r4, pc}`;
            default: return `leaf_2:\n    push {lr}\n    ${body}\n    ldr pc, [sp], #4`;
        }
    };
    return `@ generated by tests/a64/aarch32_page_fuzz.mjs (seed ${SEED}, program ${n})
    .syntax unified
    .${thumb ? "thumb" : "arm"}
header:
    .word   ${thumb ? 1 : 0}
entry:
${[...REGS, 11].map(i => `    ldr r${i}, [r8, #${3072 + 4 * i}]`).join("\n")}
    ldr r12, [r8, #${3072 + 64}]
    msr apsr_nzcvq, r12
    mov r12, #${ROUNDS}
    str r12, [r8, #4092]
round:
    ${body}
    ldr r12, [r8, #4092]
    subs r12, r12, #1
    str r12, [r8, #4092]
    bne round
${[...REGS, 11].map(i => `    str r${i}, [r8, #${3072 + 4 * i}]`).join("\n")}
    mrs r12, apsr
    str r12, [r8, #${3072 + 64}]
    svc #0
    .balign 4
${[0, 1, 2].map(leaf).join("\n")}
`;
}

// (--write DIR: the programs written there, not run)
if(option("--write", null))
{
    for(let n = 0; n < PROGRAMS; n++) fs.writeFileSync(option("--write") + `/fuzz-${n}.a32.S`, program(n));
    process.exit(0);
}
const directory = root + "build/a64-aarch32-page-fuzz/";
fs.mkdirSync(directory, { recursive: true });
process.env.A64_MMU = "1";
let differences = 0, helpers = 0, retired = 0, steps = 0, finished = 0;
for(let n = 0; n < PROGRAMS; n++)
{
    const seed = next64();
    fs.writeFileSync(directory + "fuzz.a32.S", program(n));
    const guest = build("aarch32-page-fuzz", [root + "tests/a64/aarch32/fuzz.c", root + "tests/a64/aarch32/el0_run.S", directory + "fuzz.a32.S"],
        { cflags: [`-DSEED=${seed}ULL`, "-DA64_MMU"] });
    delete process.env.A64_JIT;
    const interpreted = await actual(guest, { options: { cpu_profile: "generic-arm64-compat32" } });
    process.env.A64_JIT = "1";
    process.env.A64_JIT_HOT = "1";
    process.env.A64_JIT_SWITCHES = "a64_page_aarch32=" + (process.env.A64_AARCH32_PAGE || "1");
    const compiled = await actual(guest, { options: { cpu_profile: "generic-arm64-compat32" } });
    assert.equal(interpreted.status, "ok", `program ${n} (interpreter): ${interpreted.status}\n${interpreted.text}`);
    assert.equal(compiled.status, "ok", `program ${n} (page tier): ${compiled.status}\n${compiled.text}`);
    const t = compiled.page_tier;
    // (a program that ends with its SVC, not an exception on the way)
    if(/^exit esr 4[46]000000/.test(interpreted.text)) finished++;
    else console.log(`program ${n}: ${interpreted.text.split("\n")[0]}`);
    helpers += t.helpers;
    retired += t.retired;
    steps += t.steps;
    if(interpreted.text !== compiled.text)
    {
        differences++;
        fs.copyFileSync(directory + "fuzz.a32.S", directory + `fuzz-diff-${n}.a32.S`);
        const a = interpreted.text.split("\n"), b = compiled.text.split("\n");
        const first = a.findIndex((line, i) => line !== b[i]);
        console.log(`program ${n} (${n % 2 ? "T32" : "A32"}): differs at line ${first + 1} (kept as fuzz-diff-${n}.a32.S)\n  interpreter: ${a[first]}\n  page tier:   ${b[first]}`);
    }
}
delete process.env.A64_JIT;
console.log(`aarch32 page fuzz: ${PROGRAMS} programs of ${LENGTH} constructs x ${ROUNDS} rounds (${finished} to their end), ${differences} differences ` +
    `(page tier: ${retired} retired, ${helpers} helper calls, ${steps} steps)`);
process.exit(differences ? 1 : 0);
