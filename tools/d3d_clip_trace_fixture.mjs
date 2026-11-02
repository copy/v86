#!/usr/bin/env node
// Publish only the procedural draw commands. Primary-surface desktop pixels
// and diagnostic strings are irrelevant to offscreen comparisons and removed.
import fs from "node:fs";
import path from "node:path";
import { gzipSync as gzip_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import { createRequire as create_require } from "node:module";
import { fileURLToPath as file_url_to_path } from "node:url";
import { site_directory } from "../tests/lib/site.mjs";
const root = file_url_to_path(new URL("../", import.meta.url)), site = site_directory(root), require = create_require(import.meta.url);
const P = require("../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const api = Number(process.argv[3] || 7);if(![7, 8, 9].includes(api)) throw new Error("Unsupported clip fixture API");
const input = fs.readFileSync(process.argv[2] || root + "build/d3d-review/stage4d2h3-proxy-indexed/graphics.bin"), bytes = Buffer.from(input);
const allowed = new Set("HELLO GUEST_LOG CREATE_DEVICE DD_SET_DISPLAY_MODE CREATE_TEXTURE_2D DD_SET_COLOR_KEY UPDATE_TEXTURE SET_RENDER_TARGET SET_DEPTH_STENCIL_SURFACE_LEVEL SET_VIEWPORT SET_MATERIAL SET_TRANSFORM SET_RENDER_STATE SET_SAMPLER_STATE SET_TEXTURE_STAGE_STATE CREATE_BUFFER CLEAR UPDATE_BUFFER BEGIN_SCENE SET_FVF DRAW_PRIMITIVE_UP SET_STREAM_SOURCE SET_INDICES SET_VERTEX_SHADER CREATE_VERTEX_DECLARATION SET_VERTEX_DECLARATION END_SCENE DD_BLT WINDOW_STATE SET_CURSOR_PROPERTIES SET_CURSOR_POSITION SHOW_CURSOR PRESENT DESTROY_RESOURCE".split(" "));
const removed = [];let carrier = 0, scenes = 0;
while(carrier < bytes.length)
{
    if(carrier + 12 > bytes.length) throw new Error("Truncated capture");
    const size = bytes.readUInt32LE(carrier + 8), start = carrier + 20;
    if(size < 8 || size > bytes.length - carrier - 12 || bytes.readUInt16LE(carrier + 12) !== 0xffe1 ||
        bytes.readUInt16LE(carrier + 14) !== 0xffff || bytes.readUInt32LE(carrier + 16) !== size - 8) throw new Error("Invalid envelope");
    const packet = bytes.subarray(start, carrier + 12 + size), header = W.readHeader(packet);
    W.checkStream(header.view, header.end, header.commandCount);
    for(let at = P.STRUCTS.BatchHeader.size; at < header.end;)
    {
        const opcode = header.view.getUint16(at, true), name = P.OP_NAME[opcode], length = header.view.getUint32(at + P.F.CommandHeader.size, true);
        if(!allowed.has(name)) throw new Error("Unexpected command in procedural fixture: " + name);
        const payload = at + P.STRUCTS.CommandHeader.size, structure = P.commandStruct(opcode);
        const value = P.decode(structure, header.view, payload, length - P.STRUCTS.CommandHeader.size);
        if(name === "SET_VERTEX_SHADER" && value.shader_handle !== 0) throw new Error("Procedural fixture must not include shaders");
        if(name === "UPDATE_TEXTURE" || name === "SET_CURSOR_PROPERTIES" || name === "GUEST_LOG")
        {
            const first = name !== "GUEST_LOG" ? value.data_offset : payload + P.STRUCTS.GuestLog.size;
            const count = name !== "GUEST_LOG" ? value.data_bytes : value.text_bytes;
            if(first < payload || first + count > at + length) throw new Error("Invalid removable payload");
            bytes.fill(0, start + first, start + first + count);
            removed.push({ command: name, bytes: count });
        }
        if(name === "END_SCENE") ++scenes;
        at += length;
    }
    carrier += 12 + size;
}
if(scenes !== (api === 7 ? 18 : 36) || removed.filter(item => item.command === "UPDATE_TEXTURE").length !== (api === 7 ? 1 : 0)) throw new Error("Unexpected fixture scenes/uploads");
const hash = bytes => create_hash("sha256").update(bytes).digest("hex"), directory = path.join(root, "tests/glbridge/fixtures");
fs.writeFileSync(directory + "/d3d" + api + "_processed_clip_xp.bin.gz", gzip_sync(bytes));
const metadata = { description: "Procedural actual XP D3D" + api + " COM commands: six scenes, direct and processed buffer drawing. Unrelated texture/cursor pixels and diagnostic text zeroed; no OS or game assets.", api, scenes,
    sourceCaptureSha256: hash(input), traceSha256: hash(bytes), traceBytes: bytes.length, removedPayloads: removed,
    sourceSha256: {}, reference: "d3d_clip_zero_w_reference.json is the independent positive-W oracle; raw direct zero-W disagreement remains diagnostic.",
    scope: "Frozen host replay fixture; guest C changes still require fresh XP captures and native C tests." };
for(const name of [api === 7 ? "glbridge/sample/d3d7_native_clip_draw_reference.c" : "glbridge/sample/d3d_processed_clip_draw_test.c",
    api === 7 ? "glbridge/ddrawproxy/d3d7_proxy.inc" : "glbridge/d3d" + api + "proxy/d3d" + api + "_proxy.c", "glbridge/runtime/d9wg_clip.c", "glbridge/runtime/d9wg_clip.h", "glbridge/runtime/d9wg_clip_draw.c", "glbridge/runtime/d9wg_clip_draw.h", "glbridge/runtime/d9wg_vertex.c", "glbridge/runtime/d9wg_vertex.h"])
    metadata.sourceSha256[name] = hash(fs.readFileSync(site + "/" + name));
fs.writeFileSync(directory + "/d3d" + api + "_processed_clip_xp.json", JSON.stringify(metadata, null, 2) + "\n");
console.log("Prepared procedural XP trace, removed " + removed.reduce((total, item) => total + item.bytes, 0) + " unrelated bytes");
