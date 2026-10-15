#!/usr/bin/env node
// The A64 decode oracle (docs/arm64-virt-android16-plan.md P0.5; P2.1
// compares the v86 decoder with it): llvm-mc --disassemble with the
// profile's -mattr (tests/platform/a64-profile.json llvm_mattr), so an
// encoding of a feature outside the profile is invalid. UDF is the
// permanently undefined encoding and counts as invalid; LLVM's "potentially
// undefined" (CONSTRAINED UNPREDICTABLE) encodings are valid and flagged.
// System register accesses decode whatever the register: whether one exists
// is the system register table's business (P3.1), not the decoder's.
//
//   node tests/a64/oracle/decode.mjs --self-test
//   node tests/a64/oracle/decode.mjs --sample N [--seed S]
//       N encodings, stratified over the top 8 bits, decoded into
//       build/a64-oracle/sample-<S>.json: [[hex, valid, mnemonic], ...]
//   node tests/a64/oracle/decode.mjs --check FILE
//       FILE holds the v86 decoder's [[hex, valid, mnemonic], ...] (P2.1);
//       fails on a different validity or mnemonic
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const profile = JSON.parse(fs.readFileSync(root + "tests/platform/a64-profile.json", "utf8"));

export function llvm_mc()
{
    const candidates = [process.env.LLVM_MC, "/opt/homebrew/opt/llvm/bin/llvm-mc", "/usr/local/opt/llvm/bin/llvm-mc", "llvm-mc"].filter(Boolean);
    for(const candidate of candidates)
    {
        const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
        if(result.status === 0) return { path: candidate, version: result.stdout.match(/LLVM version ([\d.]+)/)?.[1] };
    }
    throw new Error("llvm-mc not found (Homebrew llvm, or LLVM_MC=<path>)");
}

/**
 * Decode 32-bit words: [{ word, valid, text, mnemonic, unpredictable }]
 */
export function decode(words, mattr = profile.llvm_mattr)
{
    const { path } = llvm_mc();
    const results = [];
    const CHUNK = 100000;
    for(let start = 0; start < words.length; start += CHUNK)
    {
        const chunk = words.slice(start, start + CHUNK);
        const input = chunk.map(w => [0, 8, 16, 24].map(s => "0x" + ((w >>> s) & 0xFF).toString(16)).join(" ")).join("\n") + "\n";
        const run = spawnSync(path, ["--disassemble", "-triple=aarch64", "-mattr=" + mattr], { input, encoding: "utf8", maxBuffer: 1 << 30 });
        assert.equal(run.status, 0, run.stderr.slice(0, 2000));
        const invalid = new Set(), unpredictable = new Set();
        for(const m of run.stderr.matchAll(/^<stdin>:(\d+):\d+: warning: (invalid instruction encoding|potentially undefined instruction encoding)/gm))
        {
            (m[2].startsWith("invalid") ? invalid : unpredictable).add(+m[1] - 1);
        }
        const lines = run.stdout.split("\n").filter(line => line.startsWith("\t")).map(line => line.trim().replace(/\s+/g, " "));
        let next = 0;
        chunk.forEach((word, i) => {
            if(invalid.has(i)) { results.push({ word, valid: false, text: "", mnemonic: "", unpredictable: false }); return; }
            const text = lines[next++];
            assert.ok(text !== undefined, "llvm-mc printed fewer instructions than it decoded");
            const mnemonic = text.split(/[ .]/)[0];
            results.push({ word, valid: mnemonic !== "udf", text, mnemonic, unpredictable: unpredictable.has(i) });
        });
        assert.equal(next, lines.length, "llvm-mc printed more instructions than it decoded");
    }
    return results;
}

// (a xorshift generator: the same sample on every host)
function sample(count, seed)
{
    let state = BigInt(seed) * 0x9E3779B97F4A7C15n & 0xFFFFFFFFFFFFFFFFn || 1n;
    const next = () => {
        state ^= state << 13n & 0xFFFFFFFFFFFFFFFFn;
        state ^= state >> 7n;
        state ^= state << 17n & 0xFFFFFFFFFFFFFFFFn;
        return Number(state & 0xFFFFFFn);
    };
    const words = [];
    for(let i = 0; i < count; i++) words.push(((i & 0xFF) << 24 | next()) >>> 0);
    return words;
}

const hex = w => (w >>> 0).toString(16).padStart(8, "0");

// Encodings whose result the profile fixes (A64 encodings, little-endian words)
const SELF_TEST = [
    [0xD503201F, "nop"], [0x4E284800, "aese"], [0x0EE0E000, "pmull"], [0x5E004000, "sha256h"], [0x5E280800, "sha1h"],
    [0x1AC04000, "crc32b"], [0xC85FFC20, "ldaxr"], [0x8B020020, "add"], [0x1E602820, "fadd"], [0x4EA01C00, "mov"],
    [0xD503233F, "hint"], [0xD5380000, "mrs"], [0xD508871F, "tlbi"], [0xD50B7520, "ic"], [0xD50B7420, "dc"],
    [0x00000000, null],     // UDF #0
    [0xB8200020, null],     // LDADD (LSE)
    [0x4E809400, null],     // SDOT (DotProd)
    [0x1EE02800, null],     // FADD Hd (FP16)
    [0x04200000, null],     // SVE ADD
    [0xD50B7E20, "dc"],     // DC CIVAC
    [0xCE608000, null],     // SHA512H (FEAT_SHA512 is not in v1)
    [0xDAC10000 | 0x3E0, null], // PACIA (PAuth)
];

if(import.meta.url === `file://${process.argv[1]}`)
{
    const args = process.argv.slice(2);
    const { path, version } = llvm_mc();
    if(args[0] === "--self-test")
    {
        const results = decode(SELF_TEST.map(([w]) => w));
        let failed = 0;
        results.forEach((r, i) => {
            const want = SELF_TEST[i][1];
            const ok = want === null ? !r.valid : r.valid && r.mnemonic === want;
            if(!ok) { failed++; console.log(`${hex(r.word)}: llvm-mc "${r.text}" (valid ${r.valid}), expected ${want || "invalid"}`); }
        });
        console.log(`A64 decode oracle self-test: llvm-mc ${version} (${path}), -mattr=${profile.llvm_mattr}: ${results.length - failed}/${results.length}`);
        process.exit(failed ? 1 : 0);
    }
    else if(args[0] === "--sample")
    {
        const count = +args[1], seed = args[2] === "--seed" ? +args[3] : 1;
        const results = decode(sample(count, seed));
        const directory = root + "build/a64-oracle/";
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(directory + `sample-${seed}.json`, "[\n" + results.map(r => JSON.stringify([hex(r.word), r.valid ? 1 : 0, r.mnemonic])).join(",\n") + "\n]\n");
        const groups = new Map();
        for(const r of results)
        {
            const op0 = (r.word >>> 25 & 0xF).toString(2).padStart(4, "0");
            const g = groups.get(op0) || { total: 0, valid: 0 };
            g.total++;
            g.valid += r.valid;
            groups.set(op0, g);
        }
        console.log(`llvm-mc ${version}: ${count} encodings (seed ${seed}), ${results.filter(r => r.valid).length} valid; by op0 (bits 28:25):`);
        for(const [op0, g] of [...groups].sort()) console.log(`  ${op0}: ${g.valid}/${g.total}`);
    }
    else if(args[0] === "--check")
    {
        const rows = JSON.parse(fs.readFileSync(args[1], "utf8"));
        const results = decode(rows.map(([w]) => parseInt(w, 16) >>> 0));
        const differences = new Map();
        rows.forEach(([w, valid, mnemonic], i) => {
            const r = results[i];
            const problem = !!valid !== r.valid ? `v86 ${valid ? "valid" : "UNDEF"}, llvm-mc ${r.valid ? r.text : "invalid"}` :
                valid && mnemonic !== r.mnemonic ? `mnemonic v86 ${mnemonic}, llvm-mc ${r.mnemonic}` : null;
            if(problem)
            {
                const key = (r.mnemonic || mnemonic || "?") + ": " + problem.replace(/ .*/, "");
                if(!differences.has(key)) differences.set(key, { count: 0, example: `${w}: ${problem}` });
                differences.get(key).count++;
            }
        });
        for(const [key, { count, example }] of differences) console.log(`${key} x${count} (e.g. ${example})`);
        console.log(`${rows.length} encodings, ${[...differences.values()].reduce((n, d) => n + d.count, 0)} differences`);
        process.exit(differences.size ? 1 : 0);
    }
    else
    {
        console.log("usage: decode.mjs --self-test | --sample N [--seed S] | --check FILE");
        process.exit(2);
    }
}
