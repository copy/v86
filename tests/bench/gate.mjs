#!/usr/bin/env node
// Gate decisions over benchmark sessions (docs/jit-unification-plan.md,
// cross-phase rule 2 and P0.8). Each session is a result file of
// tests/bench/run.mjs with the arm under test (--arm, default "ir") and a
// baseline arm. Per benchmark, the median over the sessions of the warm ratio
// (baseline time / arm time; above 1 is faster) is judged:
//
//   --level R  the suite's geometric mean >= 0.99 and each benchmark >= 0.97.
//              A benchmark below 0.97 is retested with --runs 7, and at 4
//              times the work when its runs last under 40 ms (the command is
//              printed); --retest file.json replaces its ratio by the
//              retest's (repeated: the last file with the benchmark).
//   --level F  each --target benchmark >= 1.05 and the suite >= 1.00.
//   --level S  the same-source members: int, memory and control benchmarks
//              whose instruction and data ratios (x86-64 / i686, fields of
//              make bench-same-source) are within 0.8-1.25, 563.memops
//              excluded: geometric mean >= 1.00, each >= 0.85.
//   --level D  the suite's geometric mean >= 1.00, each benchmark >= 0.95.
//   --aa       the sessions ran one core against itself: print the noise
//              (each benchmark's ratio range), no decision.
//
// The thresholds hold for medians of 3 alternating sessions or more; fewer
// sessions are judged with a warning. Exit status 0 when the gate passes.
//
// Usage: tests/bench/gate.mjs --level R|F|S|D [--target name,...] [--arm ir]
//        [--retest retest.json]... [--json out.json] [--aa] session.json...

import fs from "node:fs";

const LEVELS = {
    R: { suite: 0.99, each: 0.97, retest: true },
    F: { suite: 1.00, each: 0, target: 1.05 },
    S: { suite: 1.00, each: 0.85 },
    D: { suite: 1.00, each: 0.95 },
};
const SAME_SOURCE_CATEGORIES = new Set(["int", "memory", "control"]);
const SAME_SOURCE_EXCLUDED = new Set(["563.memops"]);

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const flag = name => { const i = args.indexOf(name); if(i >= 0) args.splice(i, 1); return i >= 0; };
const level = value("--level"), arm = value("--arm") || "ir", json_file = value("--json");
// (--retest may repeat: a later file's ratio replaces an earlier one's)
const retest_files = [];
for(let file; (file = value("--retest")) !== undefined;) retest_files.push(file);
const targets = (value("--target") || "").split(",").filter(Boolean);
const aa = flag("--aa");
const files = args;
if(!files.length || !aa && !LEVELS[level])
{
    console.error("usage: tests/bench/gate.mjs --level R|F|S|D [--target name,...] [--arm ir] [--retest f.json] [--json out.json] [--aa] session.json...");
    process.exit(2);
}

const median = values => {
    const s = [...values].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const geomean = values => Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);

/** {name: {category, ratios: [warm ratio per session], ...fields}} */
function collect(paths)
{
    const benchmarks = new Map();
    for(const p of paths)
    {
        const session = JSON.parse(fs.readFileSync(p, "utf8"));
        for(const r of session.results)
        {
            const a = r.arms?.[arm];
            if(r.error || !a || !(a.warm_ratio > 0)) continue;
            if(!benchmarks.has(r.name)) benchmarks.set(r.name, { category: r.category, ratios: [], ms: [], instruction_ratio: r.instruction_ratio, data_ratio: r.data_ratio });
            benchmarks.get(r.name).ratios.push(a.warm_ratio);
            if(a.warm > 0) benchmarks.get(r.name).ms.push(a.warm);
        }
    }
    return benchmarks;
}

const sessions = collect(files);
if(!sessions.size)
{
    console.error(`no results of the arm "${arm}" with a baseline in ${files.join(", ")}`);
    process.exit(2);
}

if(aa)
{
    console.log(`A/A noise over ${files.length} sessions (warm ratio, ideally 1):`);
    const spreads = [];
    for(const [name, b] of sessions)
    {
        const low = Math.min(...b.ratios), high = Math.max(...b.ratios);
        spreads.push(Math.max(high - 1, 1 - low));
        console.log(`  ${name.padEnd(18)} median ${median(b.ratios).toFixed(3)}  range ${low.toFixed(3)}-${high.toFixed(3)}`);
    }
    console.log(`suite geometric mean ${geomean([...sessions.values()].map(b => median(b.ratios))).toFixed(3)}; ` +
        `largest deviation ${Math.max(...spreads).toFixed(3)}, median deviation ${median(spreads).toFixed(3)}`);
    process.exit(0);
}

const rules = LEVELS[level];
const retest = new Map();
for(const file of retest_files) for(const [name, b] of collect([file])) retest.set(name, b);
let members = [...sessions.entries()];
if(level === "S")
{
    members = members.filter(([name, b]) => SAME_SOURCE_CATEGORIES.has(b.category) && !SAME_SOURCE_EXCLUDED.has(name) &&
        b.instruction_ratio >= 0.8 && b.instruction_ratio <= 1.25 && b.data_ratio >= 0.8 && b.data_ratio <= 1.25);
    if(!members.length)
    {
        console.error("level S: no benchmark has instruction_ratio and data_ratio within 0.8-1.25 (make bench-same-source results)");
        process.exit(2);
    }
}

const rows = members.map(([name, b]) => {
    const retested = retest.get(name);
    const ratio = retested ? median(retested.ratios) : median(b.ratios);
    return { name, category: b.category, sessions: b.ratios.length, ratio, retested: !!retested };
});
const suite = geomean(rows.map(r => r.ratio));
const problems = [];
if(suite < rules.suite) problems.push(`geometric mean ${suite.toFixed(3)} < ${rules.suite}`);
const below = rows.filter(r => r.ratio < rules.each);
for(const r of below) problems.push(`${r.name} ${r.ratio.toFixed(3)} < ${rules.each}` + (rules.retest && !r.retested ? " (retest with --runs 7)" : ""));
for(const name of targets)
{
    const r = rows.find(r => r.name === name);
    if(!r) problems.push(`target ${name}: no result`);
    else if(r.ratio < rules.target) problems.push(`target ${name} ${r.ratio.toFixed(3)} < ${rules.target}`);
}
if(level === "F" && !targets.length) problems.push("level F needs --target");

const fewest = Math.min(...rows.map(r => r.sessions));
console.log(`gate ${level} over ${files.length} session(s), arm "${arm}"${retest_files.length ? ", retest " + retest_files.join(", ") : ""}`);
if(fewest < 3) console.log(`warning: ${fewest} session(s) for some benchmarks; the thresholds hold for medians of 3 or more`);
for(const r of rows)
{
    const mark = r.ratio < rules.each ? "  <" : "";
    console.log(`  ${r.name.padEnd(18)} ${r.category.padEnd(8)} ${r.ratio.toFixed(3)}${r.retested ? " (retest)" : ""}${mark}`);
}
console.log(`geometric mean ${suite.toFixed(3)} (${rows.length} benchmarks)`);
const retests = rules.retest ? below.filter(r => !r.retested) : [];
if(retests.length)
{
    const session = JSON.parse(fs.readFileSync(files[0], "utf8"));
    const wasm = label => session.arms?.find(a => a.label === label)?.wasm;
    // (two configurations of one core, tests/bench/compare.mjs: their switches)
    const switches = label => Object.entries(session.arms?.find(a => a.label === label)?.switches || {}).map(([k, v]) => `${k}=${v}`).join(",");
    const configured = [["--switches-a", switches(arm)], ["--switches-b", switches("baseline")]].filter(([, v]) => v).map(([f, v]) => ` ${f} ${v}`).join("");
    // Runs of a few milliseconds are decided by a millisecond: a benchmark
    // shorter than 40 ms per run is retested at 4 times the work (a 718.avx.ymm
    // at 0.89 over 9 ms runs was 1.00 over 35 ms runs).
    const short = retests.some(r => median(sessions.get(r.name).ms) < 40);
    console.log(`retest: node tests/bench/run.mjs --filter '^(${retests.map(r => r.name.split(".")[0]).join("|")})' --runs 7` +
        `${short ? " --scale 4" : ""} --wasm ${wasm(arm)} --baseline ${wasm("baseline")}${configured} --out retest.json`);
}
if(json_file) fs.writeFileSync(json_file, JSON.stringify({ level, arm, sessions: files, suite, rows, problems }, null, 1));
console.log(problems.length ? "FAILED: " + problems.join("; ") : `gate ${level}: passed`);
process.exit(problems.length ? 1 : 0);
