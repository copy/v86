#!/usr/bin/env node
// Condense a G0 trace into the driver's register inventory. "modeled" means
// the captured access took an implemented path; it is not a conformance claim.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function summarize_nv40_trace(trace)
{
    const hex = value => "0x" + (value >>> 0).toString(16).padStart(8, "0");
    const key = e => e.space + ":" + (e.space === "mmio" ? e.offset : e.offset & ~255).toString(16) + ":" + (e.write ? "w" : "r");
    const first = new Map((trace.first || []).map(e => [key(e), e]));
    const registers = [];
    const spaces = {};
    for(const [name, count] of trace.counts)
    {
        const [space, offset, access] = name.split(":"), e = first.get(name);
        spaces[space] = (spaces[space] || 0) + count;
        if(space === "mmio") registers.push({ offset: hex(parseInt(offset, 16)), access, count,
            behavior: e ? e.implemented ? "modeled" : "storage/default" : "not captured",
            ...(e ? { firstValue: hex(e.value), firstSequence: e.sequence } : {}) });
    }
    registers.sort((a, b) => parseInt(a.offset, 16) - parseInt(b.offset, 16) || a.access.localeCompare(b.access));
    return { version: 1, totalEvents: trace.events.length + trace.dropped, retainedEvents: trace.events.length,
        droppedEvents: trace.dropped, untrackedSummaryEvents: trace.untracked, spaces,
        mostRead: registers.filter(r => r.access === "r").sort((a, b) => b.count - a.count).slice(0, 10),
        registers };
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    if(!process.argv[2]) throw new Error("Usage: node tools/nv40_trace_report.mjs <trace.json> [report.json]");
    const result = JSON.stringify(summarize_nv40_trace(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))), null, 2) + "\n";
    if(process.argv[3]) fs.writeFileSync(process.argv[3], result);
    else process.stdout.write(result);
}
