#!/usr/bin/env node
// The CPUID features of docs/simd-xsave-plan.md (SSSE3 to x86-64-v3 and
// XSAVE): where each is reported, what it depends on, which CPU profiles may
// have it, and the milestone that opens it. The instruction forms of each are
// in gen/isa_forms.json (`make isa-forms`).
//
// This is the single source for
//   src/rust/cpu/features.rs  the constants between the GENERATED markers
//   src/cpu_features.js       the table for JavaScript (settings cpu_features)
// Regenerate with `node gen/cpu_features.js`; `--check` fails if either is
// stale. Both also validate the table against gen/isa_forms.json and against
// the observed CPUID contract (tests/platform/cpu-contract.json): a feature
// reports its bit in exactly the profiles it is open in or requested by, and
// nowhere else.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

// Features of the current profiles that the plan builds on
export const EXISTING = ["FPU", "MMX", "FXSR", "SSE", "SSE2", "SSE3", "CMPXCHG16B", "LAHF64", "POPCNT"];

// cpuid: [leaf, subleaf, register, bit]
// requires: features that must be present too (a profile without them is rejected)
// profiles: the CPU profiles (cpu_type) the feature may be opened in
// open: the profiles it is open in now (reported by CPUID); [] while planned
// disabled: what the encodings do when the feature is not present (default #UD)
export const FEATURES = [
    // M1: x86-64-v2 (with the CX16, LAHF/SAHF, POPCNT and SSE3 of the x64 profile)
    { name: "SSSE3", cpuid: [1, 0, "ecx", 9], requires: ["SSE3"], milestone: "M1", phase: "P3" },
    { name: "SSE4.1", cpuid: [1, 0, "ecx", 19], requires: ["SSSE3"], milestone: "M1", phase: "P4b" },
    { name: "SSE4.2", cpuid: [1, 0, "ecx", 20], requires: ["SSE4.1", "POPCNT"], milestone: "M1", phase: "P4b" },
    // POPCNT is reported already; the plan audits its forms
    { name: "POPCNT", cpuid: [1, 0, "ecx", 23], requires: [], milestone: "existing", phase: "P4b", open: ["x86", "x86_64"] },

    // M2: XSAVE with x87 and SSE state; OSXSAVE (CPUID.1:ECX[27]) mirrors CR4.OSXSAVE
    { name: "XSAVE", cpuid: [1, 0, "ecx", 26], requires: ["FXSR"], min_cpuid_level: 0xD, state: ["x87", "SSE"], milestone: "M2", phase: "P2" },

    // M3: AVX, with the YMM state component. AVX includes the VEX forms of the
    // SSSE3 and SSE4 instructions (and every AVX processor has SSE4.2)
    { name: "AVX", cpuid: [1, 0, "ecx", 28], requires: ["XSAVE", "SSE4.2"], state: ["YMM"], milestone: "M3", phase: "P5-P6" },

    // M4: x86-64-v3, opened together
    { name: "AVX2", cpuid: [7, 0, "ebx", 5], requires: ["AVX"], min_cpuid_level: 7, milestone: "M4", phase: "P7-P8" },
    { name: "FMA", cpuid: [1, 0, "ecx", 12], requires: ["AVX"], milestone: "M4", phase: "P11" },
    { name: "F16C", cpuid: [1, 0, "ecx", 29], requires: ["AVX"], milestone: "M4", phase: "P11" },
    // VEX-encoded general-purpose instructions: not gated by CR4.OSXSAVE or XCR0
    { name: "BMI1", cpuid: [7, 0, "ebx", 3], requires: [], min_cpuid_level: 7, milestone: "M4", phase: "P10",
        disabled: { TZCNT: "BSF" } },
    { name: "BMI2", cpuid: [7, 0, "ebx", 8], requires: [], min_cpuid_level: 7, milestone: "M4", phase: "P10" },
    // in an extended leaf, which only the x86-64 profile has (Q7)
    { name: "LZCNT", cpuid: [0x80000001, 0, "ecx", 5], requires: [], milestone: "M4", phase: "P10",
        profiles: ["x86_64"], disabled: { LZCNT: "BSR" } },
    { name: "MOVBE", cpuid: [1, 0, "ecx", 22], requires: [], milestone: "M4", phase: "P10" },

    // M5: the XSAVE family (CPUID.(EAX=0DH,ECX=1):EAX)
    { name: "XSAVEOPT", cpuid: [0xD, 1, "eax", 0], requires: ["XSAVE"], milestone: "M5", phase: "P9" },
    { name: "XSAVEC", cpuid: [0xD, 1, "eax", 1], requires: ["XSAVE"], milestone: "M5", phase: "P9" },
    { name: "XGETBV1", cpuid: [0xD, 1, "eax", 2], requires: ["XSAVE"], milestone: "M5", phase: "P9" },
    // the last step of M5 (Q3)
    { name: "XSAVES", cpuid: [0xD, 1, "eax", 3], requires: ["XSAVEC"], milestone: "M5", phase: "P9" },
];

// The milestones released to the public setting cpu_features (4.1): all of
// them since P12; a feature of a later one would be for tests and
// development (12.1) and warn unless cpu_features_unreleased is set
// (src/cpu.js)
export const RELEASED = ["M1", "M2", "M3", "M4", "M5"];

const PROFILES = ["x86", "x86_64"];
const REGISTERS = ["eax", "ebx", "ecx", "edx"];

function validate()
{
    const names = new Set(FEATURES.map(f => f.name));
    for(const f of FEATURES)
    {
        assert.ok(!EXISTING.includes(f.name) || f.milestone === "existing", f.name + ": listed as existing");
        for(const r of f.requires) assert.ok(names.has(r) || EXISTING.includes(r), `${f.name}: unknown requirement ${r}`);
        for(const p of f.profiles || PROFILES) assert.ok(PROFILES.includes(p), `${f.name}: profile ${p}`);
        for(const p of f.open || []) assert.ok((f.profiles || PROFILES).includes(p), `${f.name}: open in ${p}, which may not have it`);
        assert.ok(REGISTERS.includes(f.cpuid[2]) && f.cpuid[3] >= 0 && f.cpuid[3] < 32, f.name + ": CPUID location");
    }
    // one bit per feature
    const at = new Map();
    for(const f of FEATURES)
    {
        const key = f.cpuid.join(":");
        assert.ok(!at.has(key), `${f.name} and ${at.get(key)} share CPUID ${key}`);
        at.set(key, f.name);
    }
    // requirements form no cycle, and a feature is open only where they are
    const by_name = new Map(FEATURES.map(f => [f.name, f]));
    const visit = (f, seen) => {
        assert.ok(!seen.includes(f.name), "requirement cycle: " + [...seen, f.name].join(" -> "));
        for(const r of f.requires)
        {
            const g = by_name.get(r);
            if(!g) continue;
            visit(g, [...seen, f.name]);
            for(const p of f.open || []) assert.ok((g.open || []).includes(p), `${f.name} is open in ${p} without ${r}`);
        }
    };
    for(const f of FEATURES) visit(f, []);
}

/** Every extension with forms in gen/isa_forms.json has a feature here */
function check_forms()
{
    const forms = JSON.parse(fs.readFileSync(path.join(ROOT, "gen/isa_forms.json"), "utf8"));
    const names = new Set(FEATURES.map(f => f.name));
    for(const isa of Object.keys(forms.counts)) assert.ok(names.has(isa), "gen/isa_forms.json: no feature for " + isa);
    return forms;
}

/**
 * The opcode table (gen/x86_table.js) has a row with the right feature for
 * every legacy form of gen/isa_forms.json in the three-byte maps, and no
 * others; one for TZCNT and LZCNT; and one per VEX form (gen/vex_table.js)
 */
async function check_table(forms)
{
    const { default: table, opcode_map, opcode_prefix } = await import("./x86_table.js");
    const key = (map, prefix, byte) => `${map} ${prefix || "-"} ${byte.toString(16).padStart(2, "0")}`;
    const legacy = f => f.encoding === "legacy" && (f.map === "0F38" || f.map === "0F3A" || f.isa[0] === "BMI1" || f.isa[0] === "LZCNT");
    const expected = new Map();
    for(const f of forms.forms.filter(legacy))
    {
        expected.set(key(f.map, f.prefix === "NP" ? "" : f.prefix, f.byte), f.isa[0]);
    }
    const actual = new Map();
    for(const e of table)
    {
        const map = opcode_map(e.opcode);
        if(map !== "0F38" && map !== "0F3A" && !(map === "0F" && (e.feature === "BMI1" || e.feature === "LZCNT"))) continue;
        const prefix = opcode_prefix(e.opcode);
        actual.set(key(map, prefix ? prefix.toString(16).toUpperCase() : "", e.opcode & 0xFF), e.feature);
    }
    assert.deepEqual([...actual].sort(), [...expected].sort(), "gen/x86_table.js legacy rows and gen/isa_forms.json disagree");
    const vex = table.filter(e => e.vex).map(e => `${e.form} ${e.feature}`).sort();
    assert.deepEqual(vex, forms.forms.filter(f => f.encoding === "VEX").map(f => `${f.id} ${f.isa[0]}`).sort(),
        "gen/x86_table.js VEX rows and gen/isa_forms.json disagree");
    return actual.size + vex.length;
}

/** Each feature's bit is set in the contract exactly where it is open or requested */
function check_contract()
{
    const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/platform/cpu-contract.json"), "utf8"));
    const problems = [];
    for(const f of FEATURES)
    {
        const [leaf, subleaf, register, bit] = f.cpuid;
        const key = "0x" + leaf.toString(16).padStart(8, "0") + "." + subleaf;
        for(const [profile, [cpu_type, requested]] of Object.entries(CONTRACT_PROFILES))
        {
            const expected = (f.open || []).includes(cpu_type) || requested.includes(f.name);
            const values = contract.profiles[profile].cpuid[key];
            assert.ok(values, `cpu-contract.json: ${profile} has no CPUID ${key}`);
            const set = (parseInt(values[REGISTERS.indexOf(register)], 16) >>> bit & 1) === 1;
            if(set !== expected) problems.push(`${f.name}: CPUID ${key} ${register}[${bit}] is ${+set} in ${profile}, expected ${+expected}`);
        }
    }
    assert.deepEqual(problems, [], "CPUID contract and gen/cpu_features.js disagree");
}

// Feature sets by name (Q4); x86-64 levels need the x86-64 profile's CX16,
// LAHF/SAHF, POPCNT and SSE3 too
export const PRESETS = {
    "x86-64-v2": ["SSSE3", "SSE4.1", "SSE4.2"],
    "x86-64-v3": ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "AVX2", "FMA", "F16C", "BMI1", "BMI2", "LZCNT", "MOVBE"],
};

// cpu_type "x86_64" without cpu_features: every released feature of its
// profile (the owner's decision of 2026-10-17; src/cpu.js,
// X86_64_DEFAULT_FEATURES), which the contract's x64-1 and x64-4 record
const X86_64_DEFAULT = feature_bits().filter(f => RELEASED.includes(f.milestone) && (f.profiles || PROFILES).includes("x86_64")).map(f => f.name);

// The contract profiles (tools/cpu_contract.mjs): their cpu_type and the
// features they request
const CONTRACT_PROFILES = {
    "legacy-1": ["x86", []], "legacy-4": ["x86", []], "x64-1": ["x86_64", X86_64_DEFAULT], "x64-4": ["x86_64", X86_64_DEFAULT],
    "legacy-v2": ["x86", PRESETS["x86-64-v2"]], "x64-v2": ["x86_64", PRESETS["x86-64-v2"]],
    "legacy-xsave": ["x86", ["XSAVE"]], "x64-xsave": ["x86_64", ["XSAVE"]],
    "legacy-avx": ["x86", [...PRESETS["x86-64-v2"], "XSAVE", "AVX"]], "x64-avx": ["x86_64", [...PRESETS["x86-64-v2"], "XSAVE", "AVX"]],
    // (M4: the 32-bit profile has x86-64-v3's features but LZCNT, Q7; M5)
    "legacy-v3": ["x86", PRESETS["x86-64-v3"].filter(f => f !== "LZCNT")], "x64-v3": ["x86_64", PRESETS["x86-64-v3"]],
    "legacy-xsaves": ["x86", ["XSAVE", "XSAVEOPT", "XSAVEC", "XGETBV1", "XSAVES"]],
    "x64-xsaves": ["x86_64", ["XSAVE", "XSAVEOPT", "XSAVEC", "XGETBV1", "XSAVES"]],
};

/** The features that are not always present, with their bit in the machine's set */
export function feature_bits()
{
    return FEATURES.filter(f => f.milestone !== "existing").map((f, bit) => ({ ...f, bit }));
}

const rust_name = name => name.replace(".", "_");
// a basic leaf is reported only up to cpuid_level; XSAVE needs leaf 0xD too
const min_level = f => Math.max(f.min_cpuid_level || 1, f.cpuid[0] < 0x80000000 ? f.cpuid[0] : 1);
const hex = n => "0x" + n.toString(16).toUpperCase();

function rust_consts()
{
    const bits = feature_bits();
    const index = new Map(bits.map(f => [f.name, f.bit]));
    const mask = names => names.filter(n => index.has(n)).map(n => rust_name(n)).join(" | ") || "0";
    const lines = [];
    for(const f of bits) lines.push(`pub const ${rust_name(f.name)}: u32 = 1 << ${f.bit};`);
    lines.push(`pub const COUNT: usize = ${bits.length};`);
    lines.push(`pub const ALL: u32 = ${hex((2 ** bits.length) - 1)};`);
    lines.push("/// The other features each one requires (the always-present ones left out)");
    lines.push("#[rustfmt::skip]");
    lines.push(`pub const REQUIRES: [u32; COUNT] = [${bits.map(f => mask(f.requires)).join(", ")}];`);
    lines.push("/// Where CPUID reports each: (leaf, subleaf, register: 0 = EAX .. 3 = EDX, bit)");
    lines.push("#[rustfmt::skip]");
    lines.push(`pub const CPUID: [(u32, u32, usize, u32); COUNT] = [${bits.map(f => `(${hex(f.cpuid[0])}, ${f.cpuid[1]}, ${REGISTERS.indexOf(f.cpuid[2])}, ${f.cpuid[3]})`).join(", ")}];`);
    lines.push("/// The lowest maximum basic leaf (cpuid_level) that lets CPUID report each");
    lines.push("#[rustfmt::skip]");
    lines.push(`pub const MIN_CPUID_LEVEL: [u32; COUNT] = [${bits.map(f => hex(min_level(f))).join(", ")}];`);
    lines.push("/// Features the legacy (x86) profile may not have");
    lines.push(`pub const X86_64_ONLY: u32 = ${mask(bits.filter(f => f.profiles && !f.profiles.includes("x86")).map(f => f.name))};`);
    return lines.join("\n") + "\n";
}

function js_file()
{
    const bits = feature_bits();
    const table = Object.fromEntries(bits.map(f => [f.name, {
        bit: f.bit,
        requires: f.requires.filter(r => bits.some(g => g.name === r)),
        min_cpuid_level: min_level(f),
        profiles: f.profiles || PROFILES,
        released: RELEASED.includes(f.milestone),
    }]));
    return `// Generated by gen/cpu_features.js from its feature table; do not edit.

/**
 * The CPU features of docs/simd-xsave-plan.md: bit in the machine's set
 * (src/rust/cpu/features.rs), required features, the lowest cpuid_level that
 * reports it, the CPU profiles that may have it and whether its milestone is
 * released (else it is for tests and development)
 */
export const CPU_FEATURES = ${JSON.stringify(table, null, 4)};

/** Feature sets by name */
export const CPU_FEATURE_PRESETS = ${JSON.stringify(PRESETS, null, 4)};
`;
}

const BEGIN = "// BEGIN GENERATED by gen/cpu_features.js (edit the table there)\n";
const END = "// END GENERATED\n";
const RUST_PATH = path.join(ROOT, "src/rust/cpu/features.rs");
const JS_PATH = path.join(ROOT, "src/cpu_features.js");

function rust_file(current)
{
    const start = current.indexOf(BEGIN);
    const end = current.indexOf(END);
    assert.ok(start !== -1 && end > start, "src/rust/cpu/features.rs: GENERATED markers missing");
    return current.slice(0, start + BEGIN.length) + rust_consts() + current.slice(end);
}

async function main()
{
    validate();
    for(const [name, features] of Object.entries(PRESETS))
    {
        for(const f of features) assert.ok(feature_bits().some(g => g.name === f), `preset ${name}: unknown feature ${f}`);
    }
    const forms = check_forms();
    const rows = await check_table(forms);
    check_contract();
    const outputs = [[RUST_PATH, rust_file(fs.readFileSync(RUST_PATH, "utf8"))], [JS_PATH, js_file()]];
    for(const [file, content] of outputs)
    {
        const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        if(process.argv.includes("--check")) assert.equal(current, content, `${path.relative(ROOT, file)} is stale: run node gen/cpu_features.js`);
        else if(current !== content) fs.writeFileSync(file, content);
    }
    const open = FEATURES.filter(f => (f.open || []).length && f.milestone !== "existing").map(f => f.name);
    console.log(`${FEATURES.length} features, ${forms.total} forms (${rows} rows agree); open: ${open.length ? open.join(" ") : "none"} (contract agrees)`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url))
{
    await main();
}
