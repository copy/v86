"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { gunzipSync } = require("node:zlib"), { createHash } = require("node:crypto");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const directory = path.join(__dirname, "fixtures"), metadata = require("./fixtures/d3d9_processed_stream_clip_xp.json");
const bytes = gunzipSync(fs.readFileSync(path.join(directory, "d3d9_processed_stream_clip_xp.bin.gz")));
assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.traceSha256);
assert.equal(metadata.captureBuild.api, 9);assert.equal(metadata.captureBuild.frames, 12);
assert.deepEqual(metadata.pairs, [[0, 3], [1, 2]]);assert.equal(metadata.preservedProceduralTextureUploads, 1);
const texels = Buffer.alloc(16);metadata.proceduralTextureWords.forEach((word, i) => texels.writeUInt32LE(word, i*4));
let carrier = 0, presents = 0, remapped = false, remaps = 0, restores = 0, clipped = 0, mask = 0, kept = 0, removed = 0;
while (carrier < bytes.length) {
    const size = bytes.readUInt32LE(carrier + 8), packet = bytes.subarray(carrier + 20, carrier + 12 + size), header = W.readHeader(packet);
    assert.equal(bytes.readUInt16LE(carrier + 12), 0xffe1);assert.equal(bytes.readUInt32LE(carrier + 16), size - 8);
    W.checkStream(header.view, header.end, header.commandCount);
    for (let at = P.STRUCTS.BatchHeader.size; at < header.end;) {
        const opcode = header.view.getUint16(at, true), length = header.view.getUint32(at + P.F.CommandHeader.size, true), payload = at + P.STRUCTS.CommandHeader.size;
        const value = P.decode(P.commandStruct(opcode), header.view, payload, length - P.STRUCTS.CommandHeader.size);
        if (opcode === P.OP.UPDATE_TEXTURE || opcode === P.OP.GUEST_LOG || opcode === P.OP.SET_CURSOR_PROPERTIES) {
            const first = opcode === P.OP.GUEST_LOG ? payload + P.STRUCTS.GuestLog.size : value.data_offset;
            const count = opcode === P.OP.GUEST_LOG ? value.text_bytes : value.data_bytes;
            assert(first >= payload && first + count <= at + length);
            const data = packet.subarray(first, first + count);
            if (opcode === P.OP.UPDATE_TEXTURE && data.equals(texels)) { kept++;assert.equal(value.width, 2);assert.equal(value.height, 2);assert.equal(value.row_pitch, 8); }
            else { assert(data.every(byte => byte === 0), "unrelated pixel/text bytes are absent");removed += count; }
        }
        if (opcode === P.OP.SET_RENDER_STATE && value.state === 152) mask = value.value;
        if (opcode === P.OP.SET_FVF && value.fvf === 0) {
            assert(!remapped);assert.equal(value.element_count, 3);assert.equal(mask, 0);
            const elements = [];
            for (let i = 0; i < 3; ++i) elements.push(P.decode("VertexElement", header.view, payload + P.STRUCTS.SetFVF.size + i*8, 8));
            assert.deepEqual(elements.map(e => [e.stream,e.offset,e.type,e.usage,e.usage_index]), [[0,0,3,9,0],[0,16,4,10,0],[0,32,1,5,0]]);
            remapped = true;remaps++;
        }
        if (remapped && opcode === P.OP.DRAW_PRIMITIVE_UP) {
            assert.equal(value.primitive_type, 4);assert.equal(value.stride, 40);assert.equal(value.vertex_bytes, value.vertex_count*40);assert(value.vertex_count >= 3);
            for (let i = 0; i < value.vertex_count; ++i) {
                const vertex = value.vertex_data_offset + i*40;
                for (const offset of [0,4,8,12,32,36]) assert(Number.isFinite(header.view.getFloat32(vertex + offset, true)));
                assert(header.view.getFloat32(vertex + 12, true) > 0);
                assert.equal(header.view.getUint32(vertex + 16, true), 0xff80c0ff);
                assert(packet.subarray(vertex + 20, vertex + 32).every(byte => byte === 0), "gather padding is zeroed before emission");
            }
            clipped++;
        }
        if (remapped && opcode === P.OP.SET_VERTEX_DECLARATION) {
            assert(value.declaration_handle > 0);assert.equal(mask, presents < 4 ? 0 : 1);
            remapped = false;restores++;
        }
        if (opcode === P.OP.PRESENT) { assert(!remapped, "original declaration restored before Present");presents++; }
        at += length;
    }
    carrier += 12 + size;
}
assert.equal(carrier, bytes.length);assert.equal(presents, 12);assert.equal(remaps, 3);assert.equal(restores, 3);assert.equal(clipped, 3);assert.equal(kept, 1);
assert.equal(removed, metadata.removedPayloads.reduce((sum, row) => sum + row.bytes, 0));
console.log("PASS XP multi-stream fixture: twelve frames, three bounded one-stream clip emissions with restored layouts/plane masks, exact ARGB/coordinates and no unrelated pixel/text payloads");
