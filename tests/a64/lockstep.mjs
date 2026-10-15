#!/usr/bin/env node
// A bare-metal guest in lockstep on QEMU and v86 (docs/arm64-virt-android16-plan.md
// P2, a debugging aid): QEMU runs it with its execlog plugin logging every
// instruction and the registers it changed (X0-X30, SP, CPSR's NZCV, V0-V31,
// FPSR); v86 then single-steps it (a64_step) and logs the same. The first
// instruction where the PC or a changed register differs is printed with the
// instructions before it. QEMU clears NZCV when it takes an exception
// (pstate_write); AArch64.TakeException leaves it, as v86 does: at an
// exception entry v86 adopts QEMU's flags and the difference is not reported.
//
//   node tests/a64/lockstep.mjs <directory of guest.bin> [--max N] [--context N] [--memory MiB] [--granules-all]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { reference, qemu_binary, root, RESULT, DONE } from "./guest_runner.mjs";
import { STATE_OFFSETS } from "../../src/arm/state_layout.js";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const directory = path.resolve(args[0]) + "/";
const MAX = +option("--max", 5000000);
const CONTEXT = +option("--context", 8);

// ---- QEMU's trace
const plugin = path.dirname(qemu_binary()) + "/../../qemu-9.2.0/build/contrib/plugins/libexeclog." +
    (process.platform === "darwin" ? "dylib" : "so");
assert.ok(fs.existsSync(plugin), "no execlog plugin at " + plugin + " (tools/a64_qemu/build.sh)");
const log = directory + "lockstep-qemu.log";
fs.rmSync(log, { force: true });
const expected = await reference(directory, {
    memory: +option("--memory", 256),
    timeout: 600000,
    extra: ["-plugin", plugin + ",reg=x*,reg=sp,reg=cpsr,reg=v*,reg=fpsr", "-d", "plugin", "-D", log],
});
console.log(`QEMU: ${expected.status}`);

const LINE = /^\d+, 0x([0-9a-f]+), 0x([0-9a-f]+), "([^"]*)"(.*)$/;
const qemu = [];
// (streamed: a trace can be gigabytes)
for await (const line of readline.createInterface({ input: fs.createReadStream(log, { encoding: "latin1" }), crlfDelay: Infinity }))
{
    const m = LINE.exec(line);
    if(!m) continue;
    const changes = new Map();
    for(const [, name, value] of m[4].matchAll(/, ([a-z0-9_]+) -> 0x([0-9a-f]+)/g))
    {
        if(!/^(x\d+|sp|cpsr|v\d+|fpsr)$/.test(name)) continue;
        changes.set(name, name === "cpsr" ? (BigInt("0x" + value) & 0xF0000000n).toString(16) : BigInt("0x" + value).toString(16));
    }
    qemu.push({ pc: BigInt("0x" + m[1]), word: m[2], text: m[3], changes });
    if(qemu.length >= MAX) break;
}
console.log(`QEMU: ${qemu.length} instructions traced`);

// ---- v86, one instruction at a time
const { V86 } = await import("../../src/main.js");
const emulator = new V86({
    cpu_type: "arm64", graphics_adapter: "none", memory_size: +option("--memory", 256) << 20, autostart: false, log_level: 0,
    wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm",
    kernel: { url: directory + "guest.bin" },
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu;
if(args.includes("--granules-all")) cpu.wm.exports["a64_set_granules"](7);
const memory = () => new DataView(cpu.wasm_memory.buffer);
const base = cpu.state_base;
function registers()
{
    const view = memory();
    const r = new Map();
    for(let i = 0; i < 31; i++) r.set("x" + i, view.getBigUint64(base + STATE_OFFSETS.x + 8 * i, true).toString(16));
    r.set("sp", view.getBigUint64(base + STATE_OFFSETS.x + 8 * 31, true).toString(16));
    r.set("cpsr", ((view.getUint32(base + STATE_OFFSETS.nzcv, true) & 0xF0000000) >>> 0).toString(16));
    for(let i = 0; i < 32; i++)
    {
        const at = base + STATE_OFFSETS.v + 16 * i;
        r.set("v" + i, (view.getBigUint64(at, true) | view.getBigUint64(at + 8, true) << 64n).toString(16));
    }
    r.set("fpsr", view.getUint32(base + STATE_OFFSETS.fpsr, true).toString(16));
    return r;
}
const pc = () => memory().getBigUint64(base + STATE_OFFSETS.pc, true);
const done = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset + RESULT - 0x40000000, 4).getUint32(0, true) === DONE;
const step = cpu.wm.exports["a64_step"];

let before = registers();
const history = [];
let diverged = false;
// (QEMU's boot stub at the start of RAM runs first: skip to v86's entry)
const first = qemu.findIndex(q => q.pc === pc());
assert.ok(first >= 0, "QEMU never reached v86's entry " + pc().toString(16));
// (and leaves X0-X3 as the boot protocol says, X0 the DTB, which v86 does not have yet: take QEMU's)
for(const q of qemu.slice(0, first))
{
    for(const [name, value] of q.changes)
    {
        const r = /^x(\d+)$/.exec(name);
        if(r) memory().setBigUint64(base + STATE_OFFSETS.x + 8 * +r[1], BigInt("0x" + value), true);
    }
}
before = registers();
for(let i = first; i < qemu.length; i++)
{
    const q = qemu[i];
    const at = pc();
    const record = { i, pc: at, q, changes: null };
    history.push(record);
    if(history.length > CONTEXT) history.shift();
    if(at !== q.pc)
    {
        console.log(`PC differs at instruction ${i}: QEMU ${q.pc.toString(16)} v86 ${at.toString(16)}`);
        diverged = true;
        break;
    }
    const previous = before;
    step();
    // (a fetch that aborts is a step of its own in v86; QEMU's log folds it into the instruction before)
    if(i + 1 < qemu.length && pc() !== qemu[i + 1].pc) step();
    const vbar = memory().getBigUint64(base + STATE_OFFSETS.vbar_el1, true);
    if(pc() >= vbar && pc() < vbar + 0x800n && q.changes.has("cpsr"))
    {
        memory().setUint32(base + STATE_OFFSETS.nzcv, Number(BigInt("0x" + q.changes.get("cpsr"))), true);
    }
    const after = registers();
    const changes = new Map();
    for(const [name, value] of after) if(before.get(name) !== value) changes.set(name, value);
    record.changes = changes;
    before = after;
    // (compare what either side says changed)
    const names = new Set([...changes.keys(), ...q.changes.keys()]);
    const wrong = [...names].filter(name => (q.changes.get(name) ?? null) !== (changes.get(name) ?? null) &&
        !(q.changes.has(name) && !changes.has(name) && q.changes.get(name) === after.get(name)));
    if(wrong.length)
    {
        console.log(`registers differ after instruction ${i}:`);
        for(const r of history)
        {
            const fmt = map => [...(map || new Map())].map(([k, v]) => `${k}=${v}`).join(" ");
            console.log(`  #${r.i} ${r.pc.toString(16)} ${r.q.word} ${r.q.text}\n      qemu ${fmt(r.q.changes)}\n      v86  ${fmt(r.changes)}`);
        }
        for(const name of wrong) console.log(`  ${name}: QEMU ${q.changes.get(name) ?? "(unchanged)"} v86 ${changes.get(name) ?? "(unchanged) " + after.get(name)}`);
        // (every register QEMU reported, as it stands before this instruction, against v86's before it)
        const state = new Map();
        for(const r of qemu.slice(0, i)) for(const [name, value] of r.changes) state.set(name, value);
        const mismatched = [...state].filter(([name, value]) => previous.get(name) !== value);
        console.log(`  before it: v2 ${previous.get("v2")} v3 ${previous.get("v3")} qemu-state v2 ${state.get("v2")} v3 ${state.get("v3")}`);
        console.log("  before it, registers that differ: " + (mismatched.map(([name, value]) => `${name} qemu ${value} v86 ${previous.get(name)}`).join(", ") || "none"));
        diverged = true;
        break;
    }
}
if(!diverged) console.log(`v86: the same ${qemu.length} instructions` + (done() ? ", guest done" : ""));
await emulator.destroy();
process.exit(diverged ? 1 : 0);
