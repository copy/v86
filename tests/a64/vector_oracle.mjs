// Scalar FP, AdvSIMD, crypto and the SIMD&FP loads and stores of the A64
// interpreter against QEMU (docs/arm64-virt-android16-plan.md P2.5-P2.8,
// P2.11), the module behind tests/a64/simd_oracle.mjs, fp_oracle.mjs and
// crypto_oracle.mjs. Each case is one instruction
// word: random bits inside one class of the FP/SIMD encoding group that
// v86's decoder accepts (tests/a64/decode_check.mjs holds the decoder to
// llvm-mc), drawn so every mnemonic gets about the same share, registers
// limited to V0-V7 and X0-X9; or a SIMD&FP load or store on a 256-byte
// window (X8 points into it, X9 is an offset). V0-V7 start with random bits
// and special values (zeros, infinities, quiet and signaling NaNs,
// denormals, limits) in 32- and 64-bit lanes, X0-X7 random, NZCV random,
// FPCR random (RMode, FZ, DN, AHP), FPSR 0. The guest prints V0-V7, X0-X9,
// NZCV, FPSR and a checksum of the window per case; QEMU's lines and v86's
// must be equal.
//
// run({ name, classes, mnemonics, cases, seed, filter, fpcr, against }):
// `classes` the class names below (and "memory"), `mnemonics` only these,
// `filter` a class or mnemonic, `fpcr(n, round)` FPCR for case n, the
// round-th case of its mnemonic (default: random RMode, FZ, DN, AHP),
// `against` "qemu" (default) or "native": the same cases assembled as a
// macOS arm64 program and run on the host (P2.12, an Apple M1 Pro here).
// A64_TARGET=qemu runs QEMU only (to check the generator).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build, reference, actual, root } from "./guest_runner.mjs";

const BATCH = 400;
let rand, rand32, pick, next64;

/** The command line of the entry scripts: --cases N --seed S --filter F */
export function options(defaults)
{
    const args = process.argv.slice(2);
    const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
    return { ...defaults, cases: +option("--cases", defaults.cases), seed: +option("--seed", defaults.seed || 1),
        filter: option("--filter", defaults.filter || null) };
}

const hex = v => "0x" + v.toString(16);

const F32 = [0x00000000n, 0x80000000n, 0x7F800000n, 0xFF800000n, 0x7FC00000n, 0xFFC00000n, 0x7F800001n, 0xFFA00001n,
    0x7FC12345n, 0x00000001n, 0x807FFFFFn, 0x00400000n, 0x00800000n, 0x80800000n, 0x3F800000n, 0xBF800000n, 0x7F7FFFFFn,
    0xFF7FFFFFn, 0x4B000000n, 0x3F000000n, 0x3FC00000n, 0x4F000000n, 0xCF000000n, 0x5F000000n, 0xDF000000n, 0x477FE000n,
    0x387FC000n, 0x33800000n, 0x40490FDBn, 0x4EFFFFFFn, 0x3EAAAAABn, 0x00200000n, 0x7E800000n];
const F64 = [0x0000000000000000n, 0x8000000000000000n, 0x7FF0000000000000n, 0xFFF0000000000000n, 0x7FF8000000000000n,
    0x7FF0000000000001n, 0xFFF4000000000001n, 0x7FF8123456789ABCn, 0x0000000000000001n, 0x800FFFFFFFFFFFFFn,
    0x0010000000000000n, 0x3FF0000000000000n, 0xBFF0000000000000n, 0x7FEFFFFFFFFFFFFFn, 0x4330000000000000n,
    0x3FE0000000000000n, 0x41E0000000000000n, 0xC1E0000000000000n, 0x43E0000000000000n, 0xC3E0000000000000n,
    0x400921FB54442D18n, 0x47EFFFFFE0000000n, 0x3810000000000000n, 0x36A0000000000000n, 0x0004000000000000n,
    0x7FD0000000000000n, 0x41DFFFFFFFC00000n];
function lane64()
{
    switch(rand(6))
    {
        case 0: return pick(F64);
        case 1: return pick(F32) | pick(F32) << 32n;
        case 2: return (next64() & 0x8000FFFFFFFFFFFFn) | BigInt(rand(4) + 0x3FE) << 52n;
        case 3: return BigInt(rand(256)) - 128n & (1n << 64n) - 1n;
        default: return next64();
    }
}
const vector = () => lane64() | lane64() << 64n;
const SPECIAL = [0n, 1n, 2n, 0xFFFFFFFFFFFFFFFFn, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFn, 0x7FFFFFFFn,
    0x80000000n, 0x100000000n];
const xvalue = () => rand(3) ? next64() : pick(SPECIAL);

// ---- v86's decoder (the ARM core on its own)
const core = (() => {
    const module = new WebAssembly.Module(fs.readFileSync(process.env.A64_WASM || root + "build/v86-arm64.wasm"));
    const env = {};
    for(const { name, kind } of WebAssembly.Module.imports(module))
    {
        if(kind === "function") env[name] = () => 0n;
        if(kind === "table") env[name] = new WebAssembly.Table({ element: "anyfunc", initial: 13100 });
    }
    return new WebAssembly.Instance(module, { env }).exports;
})();
const mnemonic = word => {
    const at = core.a64_decode_mnemonic(word >>> 0) >>> 0;
    const bytes = new Uint8Array(core.memory.buffer, at, 16);
    return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
};

// ---- the classes (src/rust/aarch64/simd_decode.rs): mask, value, which fields are registers
const R = { d: 1, n: 2, m: 4, a: 8, table: 16, index: 32 };
const CLASSES = {
    aes: [0xFF3E0C00, 0x4E280800, R.d | R.n],
    table: [0xBF208C00, 0x0E000000, R.d | R.table | R.m],
    permute: [0xBF208C00, 0x0E000800, R.d | R.n | R.m],
    extract: [0xBF208400, 0x2E000000, R.d | R.n | R.m],
    copy: [0x9FE08400, 0x0E000400, R.d | R.n],
    three_same: [0x9F200400, 0x0E200400, R.d | R.n | R.m],
    three_different: [0x9F200C00, 0x0E200000, R.d | R.n | R.m],
    two_misc: [0x9F3E0C00, 0x0E200800, R.d | R.n],
    across: [0x9F3E0C00, 0x0E300800, R.d | R.n],
    modified_immediate: [0x9FF80400, 0x0F000400, R.d],
    shift_immediate: [0x9F800400, 0x0F000400, R.d | R.n],
    indexed: [0x9F000400, 0x0F000000, R.d | R.n | R.index],
    sha3: [0xFF208C00, 0x5E000000, R.d | R.n | R.m],
    sha2: [0xFF3E0C00, 0x5E280800, R.d | R.n],
    scalar_copy: [0xDFE08400, 0x5E000400, R.d | R.n],
    scalar_three_same: [0xDF200400, 0x5E200400, R.d | R.n | R.m],
    scalar_three_different: [0xDF200C00, 0x5E200000, R.d | R.n | R.m],
    scalar_two_misc: [0xDF3E0C00, 0x5E200800, R.d | R.n],
    scalar_pairwise: [0xDF3E0C00, 0x5E300800, R.d | R.n],
    scalar_shift_immediate: [0xDF800400, 0x5F000400, R.d | R.n],
    scalar_indexed: [0xDF000400, 0x5F000000, R.d | R.n | R.index],
    fp_fixed: [0x7F200000, 0x1E000000, R.d | R.n],
    fp_int: [0x7F20FC00, 0x1E200000, R.d | R.n],
    fp_dp1: [0xFF207C00, 0x1E204000, R.d | R.n],
    fp_compare: [0xFF203C00, 0x1E202000, R.n | R.m],
    fp_imm: [0xFF201FE0, 0x1E201000, R.d],
    fp_cond_compare: [0xFF200C00, 0x1E200400, R.n | R.m],
    fp_dp2: [0xFF200C00, 0x1E200800, R.d | R.n | R.m],
    fp_cond_select: [0xFF200C00, 0x1E200C00, R.d | R.n | R.m],
    fp_dp3: [0xFF000000, 0x1F000000, R.d | R.n | R.m | R.a],
    structure: [0xBE000000, 0x0C000000, 0],
};

function sanitize(word, regs)
{
    if(regs & R.d) word = word & ~0x1F | word & 7;
    if(regs & R.n) word = word & ~(0x1F << 5) | (word >>> 5 & 7) << 5;
    if(regs & R.table) word = word & ~(0x1F << 5) | (word >>> 5 & 3) << 5;
    if(regs & R.m) word = word & ~(0x1F << 16) | (word >>> 16 & 7) << 16;
    if(regs & R.a) word = word & ~(0x1F << 10) | (word >>> 10 & 7) << 10;
    if(regs & R.index)
    {
        // (Rm: bits 19:16; M, bit 20, is part of the index for 16-bit elements and of Rm otherwise)
        word = word & ~(0xF << 16) | (word >>> 16 & 7) << 16;
        if((word >>> 22 & 3) !== 1) word &= ~(1 << 20);
    }
    return word >>> 0;
}

/** A structure load or store: base X8, Rt 0-4 (four registers stay in V0-V7), Rm X9 or 31 */
function structure_word(word)
{
    word = word & ~0x3FF | 8 << 5 | rand(5);
    if(word >>> 23 & 1) word = word & ~(0x1F << 16) | (rand(2) ? 9 : 31) << 16;
    else word &= ~(0x1F << 16);
    return word >>> 0;
}

// the SIMD&FP register loads and stores, as assembly
const REG = ["b", "h", "s", "d", "q"];
/** Two different registers of a pair (a load of one register twice is CONSTRAINED UNPREDICTABLE) */
const pair = s => { const t = rand(8); return `${REG[s]}${t}, ${REG[s]}${(t + 1 + rand(7)) % 8}`; };
const MEMORY = [
    () => { const s = rand(5); return `${pick(["ldr", "str"])} ${REG[s]}${rand(8)}, [x8, #${(rand(8) << s)}]`; },
    () => { const s = rand(5); return `${pick(["ldur", "stur"])} ${REG[s]}${rand(8)}, [x8, #${-(rand(4) << s)}]`; },
    () => { const s = rand(5); return `${pick(["ldr", "str"])} ${REG[s]}${rand(8)}, [x8, #${(rand(4) << s) - (2 << s)}]!`; },
    () => { const s = rand(5); return `${pick(["ldr", "str"])} ${REG[s]}${rand(8)}, [x8], #${(rand(4) << s) - (2 << s)}`; },
    () => { const s = rand(5); return `${pick(["ldr", "str"])} ${REG[s]}${rand(8)}, [x8, x9${s ? pick(["", ", lsl #" + s]) : ""}]`; },
    () => { const s = 2 + rand(3); return `${pick(["ldp", "stp", "ldnp", "stnp"])} ${pair(s)}, [x8, #${(rand(4) << s) - (2 << s)}]`; },
    () => { const s = 2 + rand(3); return `${pick(["ldp", "stp"])} ${pair(s)}, [x8, #${(rand(3) << s) - (1 << s)}]!`; },
    () => { const s = 2 + rand(3); return `${pick(["ldp", "stp"])} ${pair(s)}, [x8], #${(rand(3) << s) - (1 << s)}`; },
    () => ({ literal: true, asm: `ldr ${pick(["s", "d", "q"])}${rand(8)}, LITERAL` }),
];
// ---- the guest of one batch (input: V0-V7 at 0, X0-X7 at 128, X9 at 192, NZCV 200, FPCR 208)
function guest(batch, first)
{
    const lines = [".text", ".balign 4", ".global run_cases", "run_cases:", "    stp x29, x30, [sp, #-96]!",
        "    stp x19, x20, [sp, #16]", "    stp x21, x22, [sp, #32]", "    stp x23, x24, [sp, #48]", "    stp x25, x26, [sp, #64]",
        "    stp x27, x28, [sp, #80]", "    stp d8, d9, [sp, #-64]!", "    stp d10, d11, [sp, #16]", "    stp d12, d13, [sp, #32]",
        "    stp d14, d15, [sp, #48]"];
    batch.forEach((c, i) => {
        const n = first + i;
        lines.push(`// case ${n}: ${c.key}`, `    adrp x28, input_${n}`, `    add x28, x28, :lo12:input_${n}`,
            "    ldr x16, [x28, #200]", "    msr nzcv, x16", "    ldr x16, [x28, #208]", "    msr fpcr, x16", "    msr fpsr, xzr");
        for(let r = 0; r < 8; r += 2) lines.push(`    ldp q${r}, q${r + 1}, [x28, #${16 * r}]`);
        for(let r = 0; r < 8; r += 2) lines.push(`    ldp x${r}, x${r + 1}, [x28, #${128 + 8 * r}]`);
        lines.push("    ldr x9, [x28, #192]", `    adrp x8, memory_${n}`, `    add x8, x8, :lo12:memory_${n}`, "    add x8, x8, #64");
        lines.push("    " + c.asm.replace("LITERAL", `literal_${n}`));
        lines.push(`    adrp x28, output_${n}`, `    add x28, x28, :lo12:output_${n}`);
        for(let r = 0; r < 8; r += 2) lines.push(`    stp q${r}, q${r + 1}, [x28, #${16 * r}]`);
        for(let r = 0; r < 10; r += 2) lines.push(`    stp x${r}, x${r + 1}, [x28, #${128 + 8 * r}]`);
        lines.push("    mrs x16, nzcv", "    str x16, [x28, #208]", "    mrs x16, fpsr", "    str x16, [x28, #216]", "    msr fpcr, xzr");
    });
    lines.push("    ldp d10, d11, [sp, #16]", "    ldp d12, d13, [sp, #32]", "    ldp d14, d15, [sp, #48]", "    ldp d8, d9, [sp], #64",
        "    ldp x19, x20, [sp, #16]", "    ldp x21, x22, [sp, #32]", "    ldp x23, x24, [sp, #48]", "    ldp x25, x26, [sp, #64]",
        "    ldp x27, x28, [sp, #80]", "    ldp x29, x30, [sp], #96", "    ret");
    lines.push(".balign 16");
    batch.forEach((c, i) => {
        lines.push(`literal_${first + i}:`, `    .quad ${hex(c.literal_value & (1n << 64n) - 1n)}`, `    .quad ${hex(c.literal_value >> 64n)}`);
    });
    lines.push(".data", ".balign 64");
    batch.forEach((c, i) => {
        const n = first + i;
        lines.push(`input_${n}:`);
        for(const v of c.v) lines.push(`    .quad ${hex(v & (1n << 64n) - 1n)}`, `    .quad ${hex(v >> 64n)}`);
        lines.push(...c.x.map(v => `    .quad ${hex(v)}`), `    .quad ${hex(c.x9)}`, `    .quad ${hex(c.nzcv)}`, `    .quad ${hex(c.fpcr)}`,
            "    .quad 0", ".balign 64", `memory_${n}:`, ...c.memory.map(v => `    .quad ${hex(v)}`), ".balign 64",
            `output_${n}:`, "    .zero 224", ".balign 64");
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
        for(int k = 0; k < 32; k++) sum = (sum ^ memory[k]) * 0x100000001B3ul + k;
        printf("%d", FIRST + i);
        // (X8 relative to the window: the hosts place it differently)
        for(int r = 0; r < 28; r++) printf(" %lx", r == 24 ? out[r] - (unsigned long)memory : out[r]);
        printf(" %lx\\n", sum);
    }
    return 0;
}
`;

const NAMES = [...Array.from({ length: 8 }, (_, r) => [`v${r}.lo`, `v${r}.hi`]).flat(), ...Array.from({ length: 10 }, (_, r) => "x" + r),
    "nzcv", "fpsr", "memory"];
function explain(want, have)
{
    const w = want.split(" "), h = have.split(" ");
    return w.slice(1).map((value, i) => value === h[i + 1] ? null : `${NAMES[i]} qemu ${value} v86 ${h[i + 1]}`).filter(Boolean).join(", ");
}

/**
 * The cases of a batch on the host (macOS arm64): the guest's assembly in
 * Mach-O syntax, its main with the host's libc; the lines it prints
 */
function native(batch, first, directory)
{
    assert.ok(process.platform === "darwin" && process.arch === "arm64", "the native oracle needs macOS on arm64");
    const asm = guest(batch, first)
        .replace(/adrp (x\d+), ([a-z_0-9]+)$/gm, "adrp $1, $2@PAGE")
        .replace(/:lo12:([a-z_0-9]+)/g, "$1@PAGEOFF")
        .replace(/\brun_cases\b/g, "_run_cases")
        // (absolute addresses belong in data on Mach-O)
        .replace(/\.text\n\.global case_table\n\.balign 8\ncase_table:/, ".data\n.global _case_table\n.balign 8\n_case_table:");
    fs.writeFileSync(directory + "native.S", asm);
    fs.writeFileSync(directory + "native.c", MAIN.replace("#include <a64.h>\n", "").replace(/CASE_COUNT/g, String(batch.length)).replace(/FIRST/g, String(first)));
    execFileSync("clang", ["-arch", "arm64", "-O1", "-o", directory + "native", directory + "native.c", directory + "native.S"]);
    return execFileSync(directory + "native", { encoding: "latin1", maxBuffer: 64 << 20 });
}

export async function run({ name = "simd", classes = null, mnemonics = null, cases: CASES = 6000, seed: SEED = 1, filter: FILTER = null,
    fpcr: FPCR = null, against = "qemu" })
{
    // ---- random values (xorshift: the same cases everywhere)
    let state = BigInt(SEED) * 0x9E3779B97F4A7C15n & (1n << 64n) - 1n || 1n;
    next64 = () => {
        state ^= state << 13n & (1n << 64n) - 1n;
        state ^= state >> 7n;
        state ^= state << 17n & (1n << 64n) - 1n;
        return state;
    };
    rand = n => Number(next64() % BigInt(n));
    rand32 = () => Number(next64() & 0xFFFFFFFFn) >>> 0;
    pick = list => list[rand(list.length)];

    // the pools: valid words of each class by mnemonic
    const pools = new Map();
    for(const [class_name, [mask, value, regs]] of Object.entries(CLASSES))
    {
        if(classes && !classes.includes(class_name)) continue;
        for(let k = 0; k < 6000; k++)
        {
            let word = (value | rand32() & ~mask) >>> 0;
            word = class_name === "structure" ? structure_word(word) : sanitize(word, regs);
            const m = mnemonic(word);
            if(!m) continue;
            const key = class_name === "structure" ? "struct:" + m : m;
            if(FILTER && FILTER !== class_name && FILTER !== m || mnemonics && !mnemonics.includes(m)) continue;
            if(!pools.has(key)) pools.set(key, { class: class_name, words: new Set() });
            pools.get(key).words.add(word);
        }
    }
    if((!classes || classes.includes("memory")) && (!FILTER || FILTER === "memory")) pools.set("memory", { class: "memory", words: null });

    const keys = [...pools.keys()].sort();
    const cases = [];
    for(let n = 0; n < CASES; n++)
    {
        const key = keys[n % keys.length];
        const pool = pools.get(key);
        let asm, word = null, literal = false;
        if(pool.words)
        {
            word = pick([...pool.words]);
            asm = `.inst ${hex(word)} // ${key}`;
        }
        else
        {
            const generated = pick(MEMORY)();
            if(typeof generated === "object") { literal = true; asm = generated.asm; }
            else asm = generated;
        }
        const fpcr = FPCR ? FPCR(n, Math.floor(n / keys.length)) : BigInt(rand(4)) << 22n | BigInt(rand(2)) << 24n | BigInt(rand(2)) << 25n | BigInt(rand(2)) << 26n;
        cases.push({
            key, class: pool.class, asm, word, literal, fpcr,
            v: Array.from({ length: 8 }, vector),
            x: Array.from({ length: 8 }, xvalue),
            x9: BigInt(rand(4) * 16),
            nzcv: BigInt(rand(16)) << 28n,
            memory: Array.from({ length: 32 }, () => lane64()),
            literal_value: vector(),
        });
    }

    const directory_base = root + `build/a64-${name}-oracle/`;
    fs.mkdirSync(directory_base, { recursive: true });
    let differences = 0, compared = 0;
    const by_key = new Map();
    const only_qemu = process.env.A64_TARGET === "qemu";
    for(let first = 0; first < cases.length; first += BATCH)
    {
        const batch = cases.slice(first, first + BATCH);
        fs.writeFileSync(directory_base + `cases-${first}.S`, guest(batch, first));
        fs.writeFileSync(directory_base + `main-${first}.c`, MAIN.replace(/CASE_COUNT/g, String(batch.length)).replace(/FIRST/g, String(first)));
        const directory = build(`${name}-oracle-${first}`, [directory_base + `cases-${first}.S`, directory_base + `main-${first}.c`]);
        const expected = against === "native" ? { status: "ok", text: native(batch, first, directory) } : await reference(directory, { timeout: 120000 });
        assert.equal(expected.status, "ok", "QEMU: " + JSON.stringify(expected.exception, (k, v) => typeof v === "bigint" ? hex(v) : v) + expected.text.slice(-2000));
        if(only_qemu) { compared += batch.length; continue; }
        const got = await actual(directory, { timeout: 300000 });
        assert.equal(got.status, "ok", "v86: " + JSON.stringify(got.exception, (k, v) => typeof v === "bigint" ? hex(v) : v) + got.text.slice(-2000));
        const want = expected.text.trim().split("\n"), have = got.text.trim().split("\n");
        assert.equal(have.length, want.length, "line count");
        for(let i = 0; i < want.length; i++)
        {
            compared++;
            if(want[i] === have[i]) continue;
            differences++;
            const c = cases[first + i];
            by_key.set(c.key, (by_key.get(c.key) || 0) + 1);
            if(differences <= 40)
            {
                console.log(`DIFF case ${first + i} (${c.key}): ${c.asm} fpcr ${hex(c.fpcr)}\n  ${explain(want[i], have[i]).replaceAll("qemu", against)}`);
            }
        }
    }
    if(by_key.size) console.log("differences by mnemonic: " + [...by_key].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));
    console.log(`${name} oracle: ${compared} cases (${keys.length} mnemonics and forms, seed ${SEED}), ${differences} differences` + (only_qemu ? " (QEMU only)" : ""));
    return { compared, differences, keys };
}
