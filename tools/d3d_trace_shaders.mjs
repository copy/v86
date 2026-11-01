#!/usr/bin/env node
// Recover the exact shader bytecode from a local recorded game journal.
// Output is private/ignored by default; no licensed game bytecode is committed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire as create_require } from "node:module";
const require = create_require(import.meta.url), P = require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const { GraphicsJournal } = require("../src/browser/glbridge/graphics_journal.js");
const input = process.argv[2], directory = process.argv[3] || "build/d3d-review/corpus";
if(!input) throw new Error("Usage: d3d_trace_shaders.mjs <private-journal.bin> [private-output-directory]");
fs.mkdirSync(directory, { recursive: true });
const source = fs.readFileSync(input), journal = GraphicsJournal.parse(source), shaders = new Map();let batches = 0;
for await (const record of GraphicsJournal.records(journal))
{
    if(record.barrier) continue;
    const bytes = record.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if(view.getUint16(0, true) !== P.C.V86GL_CTRL_D3D9_BATCH) continue;
    if(view.getUint16(2, true) !== 0xFFFF || view.getUint32(4, true) !== bytes.length - 8) throw new Error("Malformed journal envelope");
    const packet = bytes.subarray(8), data = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const header = P.decode("BatchHeader", data, 0), end = P.STRUCTS.BatchHeader.size + header.command_bytes;
    if(header.magic !== P.C.D9WG_MAGIC || end !== packet.length) throw new Error("Malformed game packet");
    for(let at = P.STRUCTS.BatchHeader.size; at < end;)
    {
        const command = P.decode("CommandHeader", data, at);
        if(command.size < P.STRUCTS.CommandHeader.size || at + command.size > end) throw new Error("Malformed game command");
        if(command.opcode === P.OP.CREATE_VERTEX_SHADER || command.opcode === P.OP.CREATE_PIXEL_SHADER)
        {
            const shader = P.decode("CreateVertexShader", data, at + P.STRUCTS.CommandHeader.size), size = shader.instruction_token_count * 4;
            if(size < 8 || shader.code_offset < at + P.STRUCTS.CommandHeader.size + P.STRUCTS.CreateVertexShader.size || shader.code_offset + size > at + command.size) throw new Error("Shader extends beyond its game command");
            const code = packet.subarray(shader.code_offset, shader.code_offset + size), hash = crypto.createHash("sha256").update(code).digest("hex");
            fs.writeFileSync(path.join(directory, hash + ".d9sh"), code);
            shaders.set(hash, { sha256: hash, bytes: size, version: new DataView(code.buffer, code.byteOffset, code.byteLength).getUint32(0, true) });
        }
        at += command.size;
    }
    if(++batches % 5000 === 0) console.log("Scanned " + batches + " recorded game batches");
}
fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ sourceSha256: crypto.createHash("sha256").update(source).digest("hex"), batches, shaders: [...shaders.values()] }, null, 2) + "\n");
console.log("Extracted " + shaders.size + " exact game shaders from " + batches + " batches into " + directory);
