#!/usr/bin/env node
// Alpine aarch64 ISA corpus scan (docs/arm64-virt-android16-plan.md P0.10):
// every AArch64 ELF in the pinned ISO's apks (and in --repo DIR, an offline
// repository, P6.7) is taken apart; the words of its executable sections are
// decoded by the decode oracle (tests/a64/oracle/decode.mjs) with the v1
// profile's features and with all of LLVM's. Reported:
//
// - the encoding families and mnemonics of the v1-valid words, weighted by
//   how often they occur (P2.10 samples by these weights),
// - the words valid only beyond v1, by the extension that makes them valid
//   and by mnemonic, with the ELFs they are in (each needs a verdict: must
//   implement, confirmed unused, or runtime-probed),
// - the p_align of every LOAD segment (16 and 64 KiB pages, P8.6).
//
//   node tools/a64_isa_scan.mjs [--repo DIR] [--json FILE]
//
// The full result goes to build/a64-linux/isa-scan.json (or FILE).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { prepare, ROOT } from "../tests/lib/alpine_image.mjs";
import { apkindex, parse_apkindex } from "./alpine_gpu_repo.mjs";
import { decode, llvm_mc } from "../tests/a64/oracle/decode.mjs";

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const profile = JSON.parse(fs.readFileSync(ROOT + "tests/platform/a64-profile.json", "utf8"));

// LLVM features beyond v1, tried one at a time (with what each needs): the
// Advanced SIMD ones before SVE, whose SVE2 crypto features imply them, and
// SVE before SME, which also accepts the streaming-compatible SVE encodings
const EXTENSIONS = [
    "lse", "rcpc", "rcpc-immo", "rcpc3", "rdm", "fullfp16", "fp16fml", "dotprod", "sha3", "sm4", "i8mm", "bf16",
    "pauth", "bti", "mte", "rand", "sb", "ssbs", "predres", "flagm", "altnzcv", "fptoint", "jsconv", "complxnum",
    "ccpp", "ccdp", "lor", "pan", "pan-rwv", "uaops", "ras", "rasv2", "mops", "hbc", "ls64", "wfxt", "cssc", "lse128",
    "the", "gcs", "chk", "xs", "nmi", "tme", "spe", "ete", "trbe", "brbe", "el2vmsa", "el3", "sel2", "vh",
    "sve", "sve,+sve2", "sve,+sve2,+sve2-aes", "sve,+sve2,+sve2-sha3", "sve,+sve2,+sve2-sm4", "sve,+sve2,+sve2-bitperm",
    "sve,+f64mm", "sve,+f32mm", "sve,+sve2p1", "sme", "sme,+sme2", "sme,+sme2,+sme2p1", "lut", "fp8", "faminmax", "fprcvt", "lsfe", "lsui", "occmo",
    "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8.5a", "v8.6a", "v8.7a", "v8.8a", "v8.9a", "v9a", "v9.1a", "v9.2a", "v9.3a", "v9.4a", "v9.5a", "v9.6a",
];

/** The members of a tar archive: [{ name, data }] for regular files */
function tar_files(tar)
{
    const files = [];
    let long_name = null, pax_path = null;
    for(let offset = 0; offset + 512 <= tar.length;)
    {
        const header = tar.subarray(offset, offset + 512);
        if(header.every(b => b === 0)) break;
        const field = (at, length) => header.subarray(at, at + length).toString("latin1").replace(/\0.*$/s, "");
        const size = parseInt(field(124, 12).trim(), 8) || 0;
        const type = String.fromCharCode(header[156] || 48);
        const data = tar.subarray(offset + 512, offset + 512 + size);
        let name = field(0, 100);
        if(field(257, 5) === "ustar" && field(345, 155)) name = field(345, 155) + "/" + name;
        if(type === "L") long_name = data.toString("latin1").replace(/\0.*$/s, "");
        else if(type === "x")
        {
            const m = data.toString("utf8").match(/^\d+ path=(.*)$/m);
            pax_path = m ? m[1] : null;
        }
        else
        {
            if(type === "0") files.push({ name: long_name || pax_path || name, data });
            long_name = pax_path = null;
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

/** An AArch64 ELF's executable bytes and LOAD alignments, or null */
function elf(data)
{
    if(data.length < 64 || data.readUInt32BE(0) !== 0x7F454C46 || data[4] !== 2 || data[5] !== 1 || data.readUInt16LE(18) !== 183) return null;
    const phoff = Number(data.readBigUInt64LE(32)), shoff = Number(data.readBigUInt64LE(40));
    const phentsize = data.readUInt16LE(54), phnum = data.readUInt16LE(56), shentsize = data.readUInt16LE(58), shnum = data.readUInt16LE(60);
    const aligns = [], code = [];
    const loads = [];
    for(let i = 0; i < phnum; i++)
    {
        const at = phoff + i * phentsize;
        if(data.readUInt32LE(at) !== 1) continue;
        const flags = data.readUInt32LE(at + 4), offset = Number(data.readBigUInt64LE(at + 8)), filesz = Number(data.readBigUInt64LE(at + 32));
        aligns.push(Number(data.readBigUInt64LE(at + 48)));
        if(flags & 1) loads.push(data.subarray(offset, offset + filesz));
    }
    for(let i = 0; i < shnum && shoff; i++)
    {
        const at = shoff + i * shentsize;
        const type = data.readUInt32LE(at + 4), flags = Number(data.readBigUInt64LE(at + 8));
        const offset = Number(data.readBigUInt64LE(at + 24)), size = Number(data.readBigUInt64LE(at + 32));
        if(type !== 8 && flags & 4 && size) code.push(data.subarray(offset, offset + size));
    }
    return { aligns, code: code.length ? code : loads };
}

const { directory } = await prepare("aarch64-virt", ["apks"]);
const apks = fs.readdirSync(directory + "apks/aarch64").filter(n => n.endsWith(".apk")).map(n => directory + "apks/aarch64/" + n);
const index = parse_apkindex(apkindex(fs.readFileSync(directory + "apks/aarch64/APKINDEX.tar.gz")));
const repo = option("--repo");
if(repo)
{
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".apk") ? [path.join(d, e.name)] : []);
    apks.push(...walk(repo));
}

const occurrences = new Map();  // word -> static count
const where = new Map();        // word -> Set of ELFs (the first few)
const elfs = [];
let words_total = 0;
for(const apk of apks.sort())
{
    const tar = zlib.gunzipSync(fs.readFileSync(apk));
    for(const { name, data } of tar_files(tar))
    {
        const parsed = elf(data);
        if(!parsed) continue;
        const file = path.basename(apk, ".apk") + ":" + name;
        let words = 0;
        for(const bytes of parsed.code)
        {
            for(let at = 0; at + 4 <= bytes.length; at += 4)
            {
                const word = bytes.readUInt32LE(at);
                occurrences.set(word, (occurrences.get(word) || 0) + 1);
                const set = where.get(word);
                if(!set) where.set(word, new Set([file]));
                else if(set.size < 4) set.add(file);
                words++;
            }
        }
        words_total += words;
        elfs.push({ file, words, p_align: parsed.aligns });
    }
}

const unique = [...occurrences.keys()];
const v1 = decode(unique), all = decode(unique, "+all");
const by_word = new Map(unique.map((w, i) => [w, { v1: v1[i], all: all[i] }]));
const beyond = unique.filter(w => !by_word.get(w).v1.valid && by_word.get(w).all.valid);
const extension_of = new Map();
let pending = beyond;
for(const extension of EXTENSIONS)
{
    if(!pending.length) break;
    const results = decode(pending, profile.llvm_mattr + ",+" + extension);
    pending = pending.filter((w, i) => {
        if(!results[i].valid) return true;
        extension_of.set(w, extension.replace(/^.*\+/, ""));
        return false;
    });
}
for(const w of pending) extension_of.set(w, "unknown");

const FAMILIES = { "100": "data processing (immediate)", "101": "branches, exceptions, system", "x1x0": "loads and stores",
    "x101": "data processing (register)", "x111": "SIMD and FP" };
const family = w => {
    const op0 = w >>> 25 & 0xF;
    if((op0 & 0b1110) === 0b1000) return FAMILIES["100"];
    if((op0 & 0b1110) === 0b1010) return FAMILIES["101"];
    if((op0 & 0b0101) === 0b0100) return FAMILIES["x1x0"];
    if((op0 & 0b0111) === 0b0101) return FAMILIES["x101"];
    if((op0 & 0b0111) === 0b0111) return FAMILIES["x111"];
    return "reserved, SME, SVE";
};
const families = {}, mnemonics = {}, extensions = {};
let valid_total = 0, invalid_total = 0, beyond_total = 0;
for(const [w, count] of occurrences)
{
    const { v1: d, all: a } = by_word.get(w);
    if(d.valid)
    {
        valid_total += count;
        families[family(w)] = (families[family(w)] || 0) + count;
        mnemonics[d.mnemonic] = (mnemonics[d.mnemonic] || 0) + count;
    }
    else if(a.valid)
    {
        beyond_total += count;
        const extension = extension_of.get(w);
        const e = extensions[extension] ||= { count: 0, mnemonics: {} };
        e.count += count;
        const m = e.mnemonics[a.mnemonic] ||= { count: 0, elfs: new Set(), example: "" };
        m.count += count;
        m.example ||= `${w.toString(16).padStart(8, "0")} ${a.text}`;
        for(const f of where.get(w)) if(m.elfs.size < 8) m.elfs.add(f);
    }
    else invalid_total += count;
}
const sorted = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
const align_histogram = {};
for(const e of elfs) for(const a of e.p_align) align_histogram[a] = (align_histogram[a] || 0) + 1;
const result = {
    iso: profile.reference && undefined, llvm_mc: llvm_mc().version, mattr: profile.llvm_mattr,
    apks: apks.length, packages_in_index: index.size, elfs: elfs.length, words: words_total, unique_words: unique.length,
    v1_valid: valid_total, beyond_v1: beyond_total, invalid_everywhere: invalid_total,
    families: sorted(families), mnemonics: sorted(mnemonics),
    extensions: Object.fromEntries(Object.entries(extensions).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, {
        count: v.count, mnemonics: Object.fromEntries(Object.entries(v.mnemonics).sort((a, b) => b[1].count - a[1].count)
            .map(([m, x]) => [m, { count: x.count, example: x.example, elfs: [...x.elfs] }])) }])),
    p_align: align_histogram,
    p_align_below_64k: elfs.filter(e => e.p_align.some(a => a < 65536)).map(e => e.file),
    per_elf: elfs,
};
delete result.iso;
const out = option("--json") || ROOT + "build/a64-linux/isa-scan.json";
fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
console.log(`${apks.length} apks, ${elfs.length} AArch64 ELFs, ${words_total} words of code (${unique.length} distinct); llvm-mc ${result.llvm_mc}`);
console.log(`v1-valid ${valid_total}, valid only beyond v1 ${beyond_total}, invalid with every feature ${invalid_total}`);
console.log("families: " + Object.entries(result.families).map(([k, v]) => `${k} ${(100 * v / valid_total).toFixed(1)}%`).join(", "));
console.log("top mnemonics: " + Object.entries(result.mnemonics).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(", "));
for(const [extension, e] of Object.entries(result.extensions))
{
    console.log(`beyond v1: ${extension} (${e.count})`);
    for(const [m, x] of Object.entries(e.mnemonics).slice(0, 12)) console.log(`    ${m} ${x.count}: ${x.example}; in ${x.elfs.slice(0, 3).join(", ")}`);
}
console.log("LOAD p_align: " + Object.entries(align_histogram).map(([k, v]) => `${k}: ${v}`).join(", ") +
    `; ELFs with a LOAD segment aligned below 64 KiB: ${result.p_align_below_64k.length}`);
console.log("wrote " + out);
