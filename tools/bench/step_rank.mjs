#!/usr/bin/env node
// What 64-bit code costs the host outside compiled code, ranked
// (docs/jit-unification-plan.md P4.1). Two runs of one workload: one with
// the JIT switch step_profile on gives the counts (its histogram makes each
// step slower, so its time is not used), one with it off the host time (the
// cores' runtime). The counts are scaled by the two records' retired
// instructions; a class's host time is its count times its cost, measured
// by tests/x64/system_bench.mjs. Classes may overlap (a SYSCALL is a step of
// P4.7's class and a chainable exit of P4.3's).
//
//   node tools/bench/step_rank.mjs <counts log> <time log> [--phase desktop|end]
//       [--counts-window <phase>,<phase>] [--time-window <phase>,<phase>] [--costs <system_bench output>]
//
// The logs hold JIT_STATS records (tools/bench/jit_stats.mjs; the Windows
// harness writes one at the desktop, one at the end and one for each
// "jitstats <phase>" command, `phase`); a window is the difference of two.
import fs from "node:fs";
import { step_key_fields } from "../step_profile.mjs";

// ns, tests/x64/system_bench.mjs on an Apple M1 Pro, release build, 2026-10-10
// (exit: what ending an activation adds to a step, POPFQ toggling AC less
// POPFQ; cold: an instruction run outside compiled code, a miss)
const COSTS = {
    cpuid: 66, popfq: 86, retry: 149, iretq: 206, syscall: 362, port_in: 174, hpet: 325, fxsave: 3892,
    mov_cr3: 180, cr0_ts: 219, nm: 880, rdtsc: 52, exit: 61, interp: 52, cold: 70, tier0_step: 35,
};

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const phase = option("--phase") || "end";
const windows = [option("--counts-window"), option("--time-window")];
const costs_file = option("--costs");
const costs = {...COSTS};
if(costs_file)
{
    // system_bench's output line ({ns_per_event, ns_per_instruction})
    const line = fs.readFileSync(costs_file, "utf8").split("\n").find(l => l.startsWith("{"));
    const measured = JSON.parse(line);
    Object.assign(costs, measured.ns_per_event, measured.ns_per_instruction);
    if(measured.ns_per_event.popfq_ac !== undefined) costs.exit = measured.ns_per_event.popfq_ac - measured.ns_per_event.popfq;
}
const [counts_log, time_log] = args;
if(!counts_log || !time_log) throw new Error("step_rank.mjs <counts log> <time log> [--phase desktop|end] [--costs file]");

function record(file, window)
{
    const records = fs.readFileSync(file, "utf8").split("\n").filter(l => l.startsWith("JIT_STATS ")).map(l => JSON.parse(l.slice(10)));
    const find = name => {
        const chosen = records.filter(r => (r.phase || "desktop") === name).pop();
        if(!chosen) throw new Error(`${file}: no JIT_STATS record of phase ${name} (${records.map(r => r.phase || "desktop")})`);
        return chosen;
    };
    if(!window) return find(phase);
    // (the second record less the first; a key out of the first's rows counts from 0)
    const [from, to] = window.split(",").map(find);
    const before = new Map((from.steps || []).map(r => [r.key, r.count]));
    const ledger = to.ledger && Object.fromEntries(Object.entries(to.ledger).map(([mode, ways]) =>
        [mode, Object.fromEntries(Object.entries(ways).map(([way, n]) => [way, n - (from.ledger?.[mode]?.[way] || 0)]))]));
    return {...to, retired_total: to.retired_total - from.retired_total, ledger,
        runtime_ms: to.runtime_ms && to.runtime_ms.map((ms, core) => ms - from.runtime_ms[core]),
        steps: to.steps && to.steps.map(r => ({...r, count: r.count - (before.get(r.key) || 0)})).filter(r => r.count > 0)
            .sort((a, b) => b.count - a.count)};
}
const counted = record(counts_log, windows[0]), timed = record(time_log, windows[1]);
if(!counted.steps) throw new Error(`${counts_log}: the record has no step profile (JIT_SWITCHES=step_profile=1)`);
const scale = timed.retired_total / counted.retired_total;
const host_ms = timed.runtime_ms ? timed.runtime_ms.reduce((a, b) => a + b, 0) : 1000 * timed.desktop_s;
const rows = counted.steps.map(r => ({...r, f: step_key_fields(r.key)}));
const event = (name, detail) => rows.filter(r => r.f.stepper === "event" && r.name.split(" ").slice(2).join(" ") === (detail ? `${name} ${detail}` : name))
    .reduce((sum, r) => sum + r.count, 0);
const page_step = r => r.f.stepper === "x64page" && !r.f.retry;
const opcode = (map, ...opcodes) => r => page_step(r) && r.f.map === map && !r.f.vex && opcodes.includes(r.f.opcode);

const CLASSES = [
    {task: "P4.2", name: "retries", match: r => r.f.stepper === "x64page" && r.f.retry, cost: costs.retry},
    {task: "P4.3", name: "chainable step exits (the exit)", events: [["step-exit", "chainable"]], cost: costs.exit},
    {task: "P4.4", name: "FXSAVE, FXRSTOR", events: [["fxstate", "FXSAVE"], ["fxstate", "FXRSTOR"]], cost: costs.fxsave / 2},
    {task: "P4.4", name: "XSAVE family, XRSTOR (FXSAVE's cost)", events: [["fxstate", "XSAVE"], ["fxstate", "XRSTOR"]], cost: costs.fxsave / 2},
    {task: "P4.5c", name: "misses (instructions interpreted in 64-bit mode)",
        events: ["disabled", "no-code", "cold", "compiling", "compile", "recompile", "unserved", "shadow", "trap-flags", "breakpoints",
            "events", "halt"].map(d => ["miss", d]), cost: costs.cold},
    {task: "P4.7", name: "SYSCALL, SYSRETQ", match: opcode(1, 0x05, 0x07), cost: costs.syscall / 2},
    {task: "P4.8", name: "IRETQ", match: opcode(0, 0xCF), cost: costs.iretq},
    {task: "P4.9", name: "MOV to CR0/CR3/CR4", match: opcode(1, 0x22), cost: costs.mov_cr3},
    {task: "P4.11", name: "port I/O (the step; not the device)", match: opcode(0, 0x6C, 0x6D, 0x6E, 0x6F, 0xE4, 0xE5, 0xE6, 0xE7, 0xEC, 0xED, 0xEE, 0xEF),
        cost: costs.port_in},
    {task: "P4.12", name: "POPFQ", match: opcode(0, 0x9D), cost: costs.popfq},
];
const claimed = new Set();
for(const c of CLASSES)
{
    if(c.match)
    {
        const matched = rows.filter(c.match);
        matched.forEach(r => claimed.add(r));
        c.count = matched.reduce((sum, r) => sum + r.count, 0);
    }
    else c.count = c.events.reduce((sum, [name, detail]) => sum + event(name, detail), 0);
}
// (x64_miss_run interprets several instructions a miss: with the mode
// ledger, the class is its 64-bit instructions run outside compiled code)
const outside = counted.ledger?.long64?.interpreted;
if(outside !== undefined) CLASSES.find(c => c.task === "P4.5c").count = outside;
const others = rows.filter(r => page_step(r) && !claimed.has(r));
CLASSES.push({task: "-", name: "other steps of the x64 page tier", count: others.reduce((sum, r) => sum + r.count, 0), cost: costs.cpuid});
// (IR Tier-0's steps: in logs from before P7.5 only)
const tier0 = rows.filter(r => r.f.stepper === "tier0");
CLASSES.push({task: "P3/P7", name: "Tier-0 steps (all modes)", count: tier0.reduce((sum, r) => sum + r.count, 0), cost: costs.tier0_step});

for(const c of CLASSES)
{
    c.scaled = c.count * scale;
    c.ms = c.scaled * c.cost / 1e6;
    c.share = c.ms / host_ms;
}
const percent = x => (100 * x).toFixed(2) + "%";
console.log(`counts: ${counts_log} ${windows[0] || phase} (${counted.retired_total} retired), time: ${time_log} ${windows[1] || phase} ` +
    `(${timed.retired_total} retired, ${(host_ms / 1000).toFixed(1)} s host), scale ${scale.toFixed(3)}`);
console.log("task   class                                              count (time run)   ns     host ms   share");
for(const c of [...CLASSES].sort((a, b) => b.ms - a.ms))
{
    console.log(`${c.task.padEnd(6)} ${c.name.padEnd(50)} ${Math.round(c.scaled).toString().padStart(14)} ${String(Math.round(c.cost)).padStart(6)} ` +
        `${c.ms.toFixed(0).padStart(9)} ${percent(c.share).padStart(7)}${c.share >= 0.005 ? "  >= 0.5%" : ""}`);
}
console.log("other steps, most first: " + others.slice(0, 15).map(r => `${r.name.replace(/^long64 x64page /, "")} ${Math.round(r.count * scale)}`).join(", "));
const frames = event("frame"), starved = ["", "pending", "other-cr3", "this-cr3"].reduce((sum, d) => sum + event("starved", d), 0);
console.log(`P4.6: starved frames ${starved} of ${frames} (${frames ? percent(starved / frames) : "-"}; the condition is >= 1%)`);
console.log(`open question 4: HPET reads ${Math.round(event("hpet-read") * scale)}, PM timer reads ${Math.round(event("pm-timer-read") * scale)}; ` +
    `open question 5: #NM ${Math.round(event("#NM") * scale)}, CLTS ${Math.round(event("CLTS") * scale)}, CR0.TS writes ${Math.round(event("CR0.TS") * scale)}, ` +
    `FXSAVE ${Math.round(event("fxstate", "FXSAVE") * scale)}, FXRSTOR ${Math.round(event("fxstate", "FXRSTOR") * scale)}, ` +
    `XSAVE ${Math.round(event("fxstate", "XSAVE") * scale)}, XRSTOR ${Math.round(event("fxstate", "XRSTOR") * scale)} (in the time run's scale)`);
console.log(`exits: retry ${Math.round(event("exit", "retry") * scale)}, step ${Math.round(event("exit", "step") * scale)} ` +
    `(chainable ${Math.round(event("step-exit", "chainable") * scale)}, barrier ${Math.round(event("step-exit", "barrier") * scale)}), ` +
    `budget ${Math.round(event("exit", "budget") * scale)}, leave ${Math.round(event("exit", "leave") * scale)}, unknown ${Math.round(event("exit", "unknown") * scale)}`);
const exits = event("exit", "retry") + event("exit", "step");
console.log(`exits and retries per host second (M4's exit criterion): ${Math.round(exits * scale / (host_ms / 1000))}`);
if(counted.ledger)
{
    // the step share s (docs/profiling.md): per mode and s_total
    const share = ways => {
        const total = Object.values(ways).reduce((a, b) => a + b, 0);
        return total ? ((ways.tier0_step || 0) + (ways.page_step || 0) + (ways.page_retry || 0)) / total : 0;
    };
    const all = {};
    for(const ways of Object.values(counted.ledger)) for(const [way, n] of Object.entries(ways)) all[way] = (all[way] || 0) + n;
    console.log("s: " + Object.entries(counted.ledger).map(([mode, ways]) => `${mode} ${percent(share(ways))}`).join(", ") + `; s_total ${percent(share(all))}`);
}
