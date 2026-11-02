import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire as create_require} from "node:module";
const require = create_require(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const reference = JSON.parse(fs.readFileSync(new URL("../glbridge/fixtures/d3d_format_layout_reference.json", import.meta.url))), geometry = new Map(reference.geometry.map(([format, ...shape]) => [format, shape]));
export function inspect_format_layouts_wire(bytes, owners) {
    assert.equal(owners.length, 2);
    const contexts = new Map(owners.map((owner, i) => [owner, {api: i + 8, textures: new Map(), levels: 0, bytes: 0}]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), c = contexts.get(bytes.readUInt32LE(at)); assert(c);
        assert(size >= 8 && at + 12 + size <= bytes.length); assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt16LE(at + 14), 0xffff); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), v = P.decode(P.commandStruct(op), h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size), name = P.OP_NAME[op];
            if (name === "CREATE_TEXTURE_2D") {
                assert(!c.textures.has(v.resource_handle)); assert(reference.frontendFormats[c.api].includes(v.format)); assert.equal(v.width, 8); assert.equal(v.height, 8); assert.equal(v.level_count, 4);
                c.textures.set(v.resource_handle, {format: v.format, seen: new Set()});
            }
            if (name === "UPDATE_TEXTURE") {
                const texture = c.textures.get(v.resource_handle); assert(texture); assert(v.level < 4); assert(!texture.seen.has(v.level), "readonly locks must not upload again");
                const [bw, bh, bytes] = geometry.get(texture.format), size = 8 >> v.level, pitch = Math.ceil(size / bw) * bytes, rows = Math.ceil(size / bh);
                assert.equal(v.width, size); assert.equal(v.height, size); assert.equal(v.x, 0); assert.equal(v.y, 0); assert.equal(v.z, 0); assert.equal(v.depth, 1); assert.equal(v.row_pitch, pitch); assert.equal(v.slice_pitch, pitch * rows); assert.equal(v.data_bytes, pitch * rows);
                assert(v.data_offset + v.data_bytes <= packet.length);
                for (let row = 0; row < rows; ++row) for (let col = 0; col < pitch; ++col) assert.equal(packet[v.data_offset + row * pitch + col], (c.api + (texture.format & 255) + v.level * 17 + row * 11 + col * 3) & 255, "independent SDK upload byte");
                texture.seen.add(v.level); ++c.levels; c.bytes += v.data_bytes;
            }
            assert(!["DRAW_PRIMITIVE", "DRAW_INDEXED_PRIMITIVE", "PRESENT"].includes(name)); x += length;
        }
        at += 12 + size;
    }
    return [...contexts.values()].map(c => {
        assert.equal(c.textures.size, reference.frontendFormats[c.api].length);
        assert.deepEqual([...c.textures.values()].map(t => t.format).sort((a, b) => a - b), [...reference.frontendFormats[c.api]].sort((a, b) => a - b));
        for (const t of c.textures.values()) assert.equal(t.seen.size, 4);
        return {api: c.api, textures: c.textures.size, levels: c.levels, bytes: c.bytes};
    });
}
