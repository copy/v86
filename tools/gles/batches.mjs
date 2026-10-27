#!/usr/bin/env node
// A recorded boot's GLES batches (tests/gles/lib.mjs's recording_renderer:
// each batch a u32 length, then the batch), read as the page's executor
// reads them (src/gles/gles_batch.js): every record and every command
// decoded. Prints the records and commands by kind, the bytes, and with
// --shaders <dir> writes each distinct shader source there (the GLSL ES
// corpus: tests/glbridge/glsl_es_wgsl_test.js).
//
// usage: node tools/gles/batches.mjs <recording> [--shaders <dir>]
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { read_gles_batch } from "../../src/gles/gles_batch.js";

const [file, ...rest] = process.argv.slice(2);
if(!file) throw new Error("usage: node tools/gles/batches.mjs <recording> [--shaders <dir>]");
const shaders_dir = rest[0] === "--shaders" ? rest[1] : null;
const bytes = new Uint8Array(fs.readFileSync(file));
const records = new Map(), commands = new Map(), shaders = new Map();
let batches = 0, at = 0;
const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);
while(at < bytes.length)
{
    if(at + 4 > bytes.length) throw new Error(`${file}: a length cut off at ${at}`);
    const length = new DataView(bytes.buffer, at, 4).getUint32(0, true);
    const batch = bytes.subarray(at + 4, at + 4 + length);
    if(batch.length !== length) throw new Error(`${file}: batch ${batches} cut off`);
    for(const record of read_gles_batch(batch, true))
    {
        count(records, record.name);
        if(record.name !== "COMMAND") continue;
        count(commands, record.command.name);
        if(record.command.name === "glShaderString")
        {
            const source = new TextDecoder().decode(record.args[1]).replace(/\0[^]*$/, "");
            shaders.set(create_hash("sha256").update(source).digest("hex").slice(0, 16), source);
        }
    }
    batches++;
    at += 4 + length;
}
const sorted = map => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));
console.log(JSON.stringify({ batches, bytes: bytes.length, records: sorted(records), commands: sorted(commands), shaders: shaders.size }, null, 1));
if(shaders_dir)
{
    fs.mkdirSync(shaders_dir, { recursive: true });
    for(const [hash, source] of shaders)
    {
        // (the stage: what it writes)
        const stage = /gl_Frag(Color|Data)/.test(source) ? "frag" : "vert";
        fs.writeFileSync(path.join(shaders_dir, hash + "." + stage), source);
    }
}
