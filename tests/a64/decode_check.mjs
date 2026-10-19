#!/usr/bin/env node
// The A64 decoder against the decode oracle (docs/arm64-virt-android16-plan.md
// P2.1): every word of a set is decoded by v86 (a64_decode_mnemonic of the
// ARM core) and by llvm-mc with the profile's features
// (tests/a64/oracle/decode.mjs); they must agree on whether it is an
// instruction and which. llvm-mc names an instruction by its preferred
// alias (mov, cmp, lsl, ...), v86 by the base instruction: ALIASES maps them.
//
// The set: every encoding of the classes whose fields are few enough
// (hints, system registers, system instructions, exception generation, the
// one- and two-source data processing opcodes, the PSTATE fields; every
// field of the FP/SIMD data processing group with a few register values,
// the AdvSIMD structure loads and stores), and a stratified sample of the
// rest of the 2^32 space. --no-fp-simd leaves out the FP and SIMD groups
// (as A1's decoder, which had none, was checked).
//
// --words FILE checks the words of a file instead (hexadecimal, one per line:
// the corpus of tests/a64/trace_replay.mjs, P2.10).
//
//   node tests/a64/decode_check.mjs [--sample N] [--seed S] [--no-fp-simd] [--words FILE]
import fs from "node:fs";
import { decode as oracle } from "./oracle/decode.mjs";
import { root } from "./guest_runner.mjs";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const SAMPLE = +option("--sample", 1000000);
const SEED = +option("--seed", 1);
const ALL_GROUPS = !args.includes("--no-fp-simd");

// llvm-mc's spelling -> v86's base mnemonics it may stand for
const ALIASES = {
    mov: ["add", "orr", "movz", "movn"], cmn: ["adds"], cmp: ["subs"], negs: ["subs"], neg: ["sub"], tst: ["ands"], mvn: ["orn"],
    asr: ["sbfm", "asrv"], sxtb: ["sbfm"], sxth: ["sbfm"], sxtw: ["sbfm"], sbfiz: ["sbfm"], sbfx: ["sbfm"],
    lsl: ["ubfm", "lslv"], lsr: ["ubfm", "lsrv"], uxtb: ["ubfm"], uxth: ["ubfm"], ubfiz: ["ubfm"], ubfx: ["ubfm"],
    bfi: ["bfm"], bfxil: ["bfm"], bfc: ["bfm"], ror: ["extr", "rorv"],
    cset: ["csinc"], cinc: ["csinc"], csetm: ["csinv"], cinv: ["csinv"], cneg: ["csneg"],
    mul: ["madd"], mneg: ["msub"], smull: ["smaddl"], smnegl: ["smsubl"], umull: ["umaddl"], umnegl: ["umsubl"],
    ngc: ["sbc"], ngcs: ["sbcs"],
    nop: ["hint"], yield: ["hint"], wfe: ["hint"], wfi: ["hint"], sev: ["hint"], sevl: ["hint"], esb: ["hint"], psb: ["hint"],
    csdb: ["hint"], dgh: ["hint"], tsb: ["hint"], bti: ["hint"], xpaclri: ["hint"], clrbhb: ["hint"],
    dc: ["sys"], ic: ["sys"], at: ["sys"], tlbi: ["sys"], ssbb: ["dsb"], pssbb: ["dsb"],
    rev64: ["rev"], ldur: ["ldur"], stur: ["stur"],
    // (the hint and prefetch spaces of later extensions: NOPs in v8.0)
    rprfm: ["prfm"], stshh: ["hint"], shuh: ["hint"], stcph: ["hint"], apas: ["sys"],
    // AdvSIMD
    sxtl: ["sshll"], sxtl2: ["sshll2"], uxtl: ["ushll"], uxtl2: ["ushll2"],
};
ALIASES.mov.push("ins", "dup", "umov", "orr");
ALIASES.mvn.push("not");
const same = (llvm, v86, text) => llvm === v86 || (ALIASES[llvm] || []).includes(v86) || llvm === "b" && /^b\./.test(text) && v86 === "b.cond";

/**
 * Where llvm-mc decodes more than the architecture allocates for profile v1
 * (its decoder ignores the features of these, or reads a field wider than
 * the encoding has): these words are not instructions, whatever it says
 */
function oracle_over_accepts(word, mnemonic, text)
{
    const system = (word & 0xFFC00000) >>> 0 === 0xD5000000;
    // MRS/MSR (register) need op0 = 1x (bit 20); with op0 = 0x they are
    // unallocated (MSR (immediate), "msr <pstatefield>, #imm", is another class)
    if(system && (mnemonic === "mrs" || mnemonic === "msr") && !(word >>> 20 & 1) && !/, #/.test(text)) return true;
    // FEAT_SYSREG128, FEAT_SME, FEAT_EBEP (PSTATE.PM)
    return ["mrrs", "msrr", "sysp", "smstart", "smstop"].includes(mnemonic) || /^msr PM, #/.test(text);
}

// ---- v86's decoder: the ARM core on its own
const wasm = fs.readFileSync(process.env.A64_WASM || root + "build/v86-arm64.wasm");
const module = new WebAssembly.Module(wasm);
const env = {};
for(const { name, kind } of WebAssembly.Module.imports(module))
{
    if(kind === "function") env[name] = () => 0n;
    if(kind === "table") env[name] = new WebAssembly.Table({ element: "anyfunc", initial: 13100 });
}
const core = new WebAssembly.Instance(module, { env }).exports;
const v86 = word => {
    const at = core.a64_decode_mnemonic(word) >>> 0;
    const bytes = new Uint8Array(core.memory.buffer, at, 16);
    return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
};

// ---- the words
/** Whether a word is in a group the decoder implements now */
function in_scope(word)
{
    if(ALL_GROUPS) return true;
    const op0 = word >>> 25 & 0xF;
    if((op0 & 0b0111) === 0b0111) return false; // scalar FP and AdvSIMD
    if((op0 & 0b0101) === 0b0100 && word >>> 26 & 1) return false; // SIMD&FP loads and stores
    return true;
}

const words = new Set();
const add = w => { if(in_scope(w >>> 0)) words.add(w >>> 0); };
// hints, barriers, PSTATE, system instructions and registers: every field (Rt 1 or 31)
for(let f = 0; f < 1 << 16; f++)
{
    for(const l of [0, 1]) for(const rt of [1, 31]) add(0xD5000000 | l << 21 | f << 5 | rt);
}
// exception generation: opc, op2, LL (imm16 1)
for(let opc = 0; opc < 8; opc++) for(let op2 = 0; op2 < 8; op2++) for(let ll = 0; ll < 4; ll++) add(0xD4000000 | opc << 21 | 1 << 5 | op2 << 2 | ll);
// unconditional branch (register): opc, op2, op3, Rn, op4
for(let opc = 0; opc < 16; opc++) for(let op3 = 0; op3 < 64; op3++) for(const op4 of [0, 1, 31]) for(const op2 of [31, 30]) for(const rn of [1, 31])
{
    add(0xD6000000 | opc << 21 | op2 << 16 | op3 << 10 | rn << 5 | op4);
}
// data processing (1 and 2 source), carry, conditional compare and select, 3 source: the opcode fields
for(let sf = 0; sf < 2; sf++) for(let s = 0; s < 2; s++) for(let opcode = 0; opcode < 64; opcode++)
{
    for(const opcode2 of [0, 1, 31]) add(sf << 31 | 1 << 30 | s << 29 | 0b11010110 << 21 | opcode2 << 16 | opcode << 10 | 2 << 5 | 3);
    add(sf << 31 | s << 29 | 0b11010110 << 21 | 4 << 16 | opcode << 10 | 2 << 5 | 3);
    add(sf << 31 | s << 29 | 0b11010000 << 21 | 4 << 16 | opcode << 10 | 2 << 5 | 3);
}
for(let w = 0; w < 1 << 16; w++)
{
    // conditional compare (op 30, S 29, cond, o2, o3, bit 11) and select (op2)
    add(0x1A400000 | (w & 0x7) << 29 | (w >> 3 & 0xF) << 12 | (w >> 7 & 3) << 10 | (w >> 9 & 1) << 4 | (w >> 10 & 1) << 31 | 0x1F << 16);
    add(0x1A800000 | (w & 0x7) << 29 | (w >> 3 & 0xF) << 12 | (w >> 7 & 3) << 10 | (w >> 10 & 1) << 31 | 2 << 16 | 3 << 5 | 4);
    // 3 source: sf, op54, op31, o0
    add(0x1B000000 | (w & 1) << 31 | (w >> 1 & 3) << 29 | (w >> 3 & 7) << 21 | (w >> 6 & 1) << 15 | 2 << 16 | 3 << 10 | 4 << 5 | 5);
}
// loads and stores: every top-level field with registers 1-3 (V = 0 and 1)
for(let w = 0; w < 1 << 16; w++)
{
    for(const v of [0, 1 << 26])
    {
        const word = (w & 0x3) << 30 | 0b111 << 27 | v | (w >> 2 & 3) << 24 | (w >> 4 & 3) << 22 | (w >> 6 & 1) << 21 |
            (w >> 7 & 0x1F) << 16 | (w >> 12 & 3) << 10 | (w >> 14 & 3) << 12 | 2 << 5 | 1;
        add(word);
        add(word & ~(1 << 27) | 1 << 28);
        add(word & ~(3 << 27) | 1 << 29 | (w >> 7 & 1) << 15);
    }
}
// FP/SIMD data processing (bits 28:25 = x111): every value of bits 31:28, 24:10, with Rn/Rd 2/1 and
// the low fields the FP classes use (imm5, opcode2, nzcv) and the modified immediates' defgh
for(let top = 0; top < 16; top++) for(let b24 = 0; b24 < 2; b24++) for(let mid = 0; mid < 1 << 14; mid++)
{
    const base = top << 28 | 0b111 << 25 | b24 << 24 | mid << 10;
    for(const low of [2 << 5 | 1, 0, 0b01000, 0b10000, 0b11000, 0x3FF, 1 << 5 | 0x11]) add(base | low);
}
// AdvSIMD structures: Q, bits 24:21, Rm, opcode, S, size (Rn 2, Rt 1; Rm 0, 3 and 31)
for(let q = 0; q < 2; q++) for(let b = 0; b < 16; b++) for(const rm of [0, 3, 31]) for(let op = 0; op < 64; op++)
{
    add(q << 30 | 0b0011 << 26 | b << 21 | rm << 16 | op << 10 | 2 << 5 | 1);
}
// the rest: stratified by the top 8 bits
let rng = BigInt(SEED) * 0x9E3779B97F4A7C15n & (1n << 64n) - 1n || 1n;
for(let i = 0; i < SAMPLE; i++)
{
    rng ^= rng << 13n & (1n << 64n) - 1n; rng ^= rng >> 7n; rng ^= rng << 17n & (1n << 64n) - 1n;
    add((i & 0xFF) << 24 | Number(rng & 0xFFFFFFn));
}

const words_file = option("--words", null);
const list = words_file ? fs.readFileSync(words_file, "utf8").split("\n").filter(Boolean).map(w => parseInt(w, 16) >>> 0) : [...words];
// (the decoder decodes every profile's encodings, the widest's: v2, with
// FEAT_PAN's MSR PAN; the executor refuses what the machine's profile lacks)
const decoded = oracle(list, JSON.parse(fs.readFileSync(root + "tests/platform/a64-profile.json", "utf8")).v2.llvm_mattr);
const differences = new Map();
let different = 0;
list.forEach((word, i) => {
    const mine = v86(word), theirs = decoded[i];
    const valid = mine !== "";
    const their_valid = theirs.valid && !oracle_over_accepts(word, theirs.mnemonic, theirs.text);
    let problem = null;
    if(valid !== their_valid) problem = `v86 ${valid ? mine : "UNDEF"}, llvm-mc ${theirs.valid ? theirs.text : "invalid"}`;
    else if(valid && !same(theirs.mnemonic, mine, theirs.text)) problem = `v86 ${mine}, llvm-mc ${theirs.text}`;
    if(!problem) return;
    different++;
    const key = (theirs.mnemonic || "invalid") + " / " + (mine || "UNDEF");
    if(!differences.has(key)) differences.set(key, { count: 0, example: (word >>> 0).toString(16).padStart(8, "0") + ": " + problem });
    differences.get(key).count++;
});
for(const [key, { count, example }] of [...differences].sort((a, b) => b[1].count - a[1].count).slice(0, 60))
{
    console.log(`${key} x${count}  e.g. ${example}`);
}
const instructions = decoded.filter((d, i) => d.valid && !oracle_over_accepts(list[i], d.mnemonic, d.text)).length;
console.log(`decode check: ${list.length} words${words_file ? " of " + words_file + ` (${instructions} instructions of profile v1)` : ""}` +
    `${ALL_GROUPS ? "" : " (no FP/SIMD)"}, ${different} differences`);
process.exit(different ? 1 : 0);
