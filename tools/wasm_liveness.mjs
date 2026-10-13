#!/usr/bin/env node
// Which locals of a Wasm function are live where control merges: at each
// loop head and br_table (docs/jit-unification-plan.md M8: the page tier's
// register pressure at its dispatch tables, where V8 spills what does not
// fit). Takes a module tools/page_code.mjs saved (--save), analyses its
// largest function (the page function) and prints, per loop and br_table,
// its byte offset in the function body, how many i32/i64/v128 locals are
// live there, and which.
//
//   node tools/wasm_liveness.mjs module.wasm [--names 0:rax,16:rip,...]
import fs from "node:fs";

const [file, ...args] = process.argv.slice(2);
if(!file) { console.error("usage: node tools/wasm_liveness.mjs module.wasm"); process.exit(2); }
const b = fs.readFileSync(file);
let p = 8;
const u = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 127) * 2 ** s; s += 7; } while(x & 128); return r; };
const sleb = bits => { let r = 0n, s = 0n, x; do { x = BigInt(b[p++]); r |= (x & 127n) << s; s += 7n; } while(x & 128n); if(s < BigInt(bits) && x & 64n) r |= -1n << s; return r; };
const names = Object.fromEntries((args[args.indexOf("--names") + 1] || "").split(",").filter(Boolean).map(kv => kv.split(":")));

// The code section's function bodies; the module's imports count toward indices
const bodies = [];
while(p < b.length) {
    const id = b[p++], size = u(), end = p + size;
    if(id === 10) {
        const n = u();
        for(let i = 0; i < n; i++) { const len = u(); bodies.push([p, p + len]); p += len; }
    }
    p = end;
}
const [start, end] = bodies.reduce((a, c) => c[1] - c[0] > a[1] - a[0] ? c : a);
p = start;
const types = [];
for(let groups = u(); groups--;) { const count = u(), type = b[p++]; for(let i = 0; i < count; i++) types.push(type); }
// (function parameters come first: the page function takes one i32)
const params = 1;
const type_of = l => l < params ? 0x7f : types[l - params];
const TYPE = { 0x7f: "i32", 0x7e: "i64", 0x7b: "v128", 0x7d: "f32", 0x7c: "f64" };
const body_start = p;

// Decode: per instruction its offset, opcode, local (get/set/tee), branch
// depths and kind
const ins = [];
const memarg = () => { u(); u(); };
while(p < end) {
    const at = p - body_start, op = b[p++];
    const i = { at, op };
    if(op === 0x02 || op === 0x03 || op === 0x04) { const t = b[p]; if(t === 0x40 || t >= 0x6f) p++; else sleb(33); }
    else if(op === 0x0c || op === 0x0d) i.depth = u();
    else if(op === 0x0e) { const n = u(); i.depths = []; for(let k = 0; k <= n; k++) i.depths.push(u()); }
    else if(op === 0x10 || op === 0x12) u();
    else if(op === 0x11 || op === 0x13) { u(); u(); }
    else if(op >= 0x20 && op <= 0x22) i.local = u();
    else if(op === 0x23 || op === 0x24) u();
    else if(op >= 0x28 && op <= 0x3e) memarg();
    else if(op === 0x3f || op === 0x40) p++;
    else if(op === 0x41) sleb(32);
    else if(op === 0x42) sleb(64);
    else if(op === 0x43) p += 4;
    else if(op === 0x44) p += 8;
    else if(op === 0x1c) { const n = u(); p += n; }
    else if(op === 0xfc) { const sub = u(); if(sub >= 8 && sub <= 17) { if(sub === 8 || sub === 10 || sub === 12 || sub === 14) { u(); u(); } else u(); } }
    else if(op === 0xfd) {
        const sub = u();
        if(sub <= 11 || sub === 92 || sub === 93) memarg();
        else if(sub === 12 || sub === 13) p += 16;
        else if(sub >= 21 && sub <= 34) p++;
        else if(sub >= 84 && sub <= 91) { memarg(); p++; }
    }
    else if(op === 0xfe) { u(); if(b[p - 1] !== 3) memarg(); }
    ins.push(i);
}

// Structured control flow to successors (instruction indices)
const succ = ins.map(() => []);
const stack = [];   // {kind, start, else}
const ends = new Map(), elses = new Map();
for(let k = 0, s = []; k < ins.length; k++) {
    const op = ins[k].op;
    if(op === 0x02 || op === 0x03 || op === 0x04) s.push(k);
    else if(op === 0x05) elses.set(s[s.length - 1], k);
    else if(op === 0x0b && s.length) ends.set(s.pop(), k);
}
const target = (depth, k) => {
    const frame = stack[stack.length - 1 - depth];
    if(!frame) return ins.length; // the function's end
    return ins[frame].op === 0x03 ? frame + 1 : ends.get(frame) + 1;
};
for(let k = 0; k < ins.length; k++) {
    const { op } = ins[k];
    const next = k + 1;
    if(op === 0x02 || op === 0x03) { stack.push(k); succ[k].push(next); }
    else if(op === 0x04) { stack.push(k); succ[k].push(next); const e = elses.get(k); succ[k].push(e !== undefined ? e + 1 : ends.get(k) + 1); }
    else if(op === 0x05) { const frame = stack[stack.length - 1]; succ[k].push(ends.get(frame) + 1); }
    else if(op === 0x0b) { stack.pop(); succ[k].push(next); }
    else if(op === 0x0c) succ[k].push(target(ins[k].depth, k));
    else if(op === 0x0d) succ[k].push(next, target(ins[k].depth, k));
    else if(op === 0x0e) succ[k].push(...new Set(ins[k].depths.map(d => target(d, k))));
    else if(op === 0x0f || op === 0x12 || op === 0x13 || op === 0x00) {}
    else succ[k].push(next);
}

// Backward liveness to a fixpoint (bit sets as BigInt)
const zero = 0n;
const live_in = ins.map(() => zero);
let changed = true;
while(changed) {
    changed = false;
    for(let k = ins.length - 1; k >= 0; k--) {
        let out = zero;
        for(const s of succ[k]) if(s < ins.length) out |= live_in[s];
        const { op, local } = ins[k];
        let inn = out;
        if(op === 0x21 || op === 0x22) inn &= ~(1n << BigInt(local));
        if(op === 0x20) inn |= 1n << BigInt(local);
        if(inn !== live_in[k]) { live_in[k] = inn; changed = true; }
    }
}
const describe = set => {
    const locals = [];
    for(let l = 0; set >> BigInt(l); l++) if(set >> BigInt(l) & 1n) locals.push(l);
    const count = {};
    for(const l of locals) count[TYPE[type_of(l)] || type_of(l)] = (count[TYPE[type_of(l)] || type_of(l)] || 0) + 1;
    return `${locals.length} live (${Object.entries(count).map(([t, n]) => `${n} ${t}`).join(", ")}): ${locals.map(l => names[l] || `${TYPE[type_of(l)][1]}${l}`).join(" ")}`;
};
for(let k = 0; k < ins.length; k++) {
    if(ins[k].op === 0x03) console.log(`loop    @${ins[k].at.toString(16)}: ${describe(live_in[k])}`);
    if(ins[k].op === 0x0e) console.log(`br_table@${ins[k].at.toString(16)} (${ins[k].depths.length} targets): ${describe(live_in[k])}`);
}
