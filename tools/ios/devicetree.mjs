#!/usr/bin/env node
// An Apple device tree, printed (docs/iphone4-plan.md S0; src/apple/devicetree.js):
//
//   node tools/ios/devicetree.mjs <DeviceTree.bin> [<path>] [--json]
//
// Values print as strings when they are printable and NUL-terminated, else
// as 32-bit cells (up to 16), else as hexadecimal; "*" marks a placeholder.

import fs from "node:fs";
import { dt_parse, dt_find, dt_walk, dt_cells } from "../../src/apple/devicetree.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const [file, start = "/"] = args.filter(a => a !== "--json");
if(!file) throw new Error("node tools/ios/devicetree.mjs <DeviceTree.bin> [<path>] [--json]");
const root = dt_parse(new Uint8Array(fs.readFileSync(file)));
const top = dt_find(root, start);
if(!top) throw new Error(`no ${start}`);

const show = v =>
{
    const strings = String.fromCharCode(...v).split("\0");
    const printable = v.length && v[v.length - 1] === 0 && strings.slice(0, -1).every(s => /^[\x20-\x7e]+$/.test(s));
    if(printable) return strings.slice(0, -1).map(s => JSON.stringify(s)).join(", ");
    if(v.length % 4 === 0 && v.length && v.length <= 64) return "<" + dt_cells(v).map(x => "0x" + x.toString(16)).join(" ") + ">";
    if(v.length <= 64) return "[" + Array.from(v, x => x.toString(16).padStart(2, "0")).join("") + "]";
    return `[${v.length} bytes: ${Array.from(v.subarray(0, 32), x => x.toString(16).padStart(2, "0")).join("")}…]`;
};

if(json)
{
    const out = {};
    dt_walk(top, (p, node) => { out[p] = Object.fromEntries(node.properties.map(q => [q.name, show(q.value)])); });
    console.log(JSON.stringify(out, null, 1));
}
else
{
    dt_walk(top, (p, node) =>
    {
        console.log(p);
        for(const q of node.properties) console.log(`    ${q.placeholder ? "*" : " "}${q.name.padEnd(28)} ${show(q.value)}`);
    });
}
