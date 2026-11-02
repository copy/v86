"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { gunzipSync } = require("node:zlib"), { createHash } = require("node:crypto");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
for (const api of [7, 8, 9]) {
    const directory = path.join(__dirname, "fixtures"), stem = "d3d" + api + "_processed_user_clip_xp";
    const bytes = gunzipSync(fs.readFileSync(path.join(directory, stem + ".bin.gz")));
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, stem + ".json")));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.traceSha256);
    const modes = api === 7 ? 4 : 6;
    let carrier = 0, frames = 0, draws = 0, removed = 0, userMask = 0;
    while (carrier < bytes.length) {
        const size = bytes.readUInt32LE(carrier + 8), packet = bytes.subarray(carrier + 20, carrier + 12 + size), header = W.readHeader(packet);
        assert.equal(bytes.readUInt16LE(carrier + 12), 0xffe1);assert.equal(bytes.readUInt32LE(carrier + 16), size - 8);
        W.checkStream(header.view, header.end, header.commandCount);
        for (let at = P.STRUCTS.BatchHeader.size; at < header.end;) {
            const opcode = header.view.getUint16(at, true), size = header.view.getUint32(at + P.F.CommandHeader.size, true);
            const payload = at + P.STRUCTS.CommandHeader.size, value = P.decode(P.commandStruct(opcode), header.view, payload, size - P.STRUCTS.CommandHeader.size);
            assert(![P.OP.DRAW_PRIMITIVE, P.OP.DRAW_INDEXED_PRIMITIVE, P.OP.DRAW_INDEXED_PRIMITIVE_UP].includes(opcode), "all recorded calls must consume the clipping path");
            if (opcode === P.OP.UPDATE_TEXTURE || opcode === P.OP.SET_CURSOR_PROPERTIES || opcode === P.OP.GUEST_LOG) {
                const first = opcode !== P.OP.GUEST_LOG ? value.data_offset : payload + P.STRUCTS.GuestLog.size;
                const count = opcode !== P.OP.GUEST_LOG ? value.data_bytes : value.text_bytes;
                assert(first >= payload && first + count <= at + size);assert(packet.subarray(first, first + count).every(byte => byte === 0));removed += count;
            }
            if (opcode === P.OP.SET_RENDER_STATE && value.state === 152) userMask = value.value;
            if (opcode === P.OP.DRAW_PRIMITIVE_UP) {
                const mode = frames % modes, processed = mode !== 0 && mode !== 3;
                const stride = processed ? (api === 9 && mode === 5 ? 24 : 20) : 16;
                assert.equal(userMask, processed ? 0 : 1 << Math.floor(frames / modes), "host user planes must be suspended only for CPU-clipped output");
                assert.equal(draws, frames);++draws;assert.equal(value.primitive_type, 4);assert.equal(value.stride, stride);
                assert.equal(value.vertex_bytes, value.vertex_count * stride);
                if (!processed) assert.equal(value.vertex_count, 3);
                else for (let vertex = 0; vertex < value.vertex_count; ++vertex) {
                    const first = value.vertex_data_offset + vertex * stride, position = first + (stride === 24 ? 4 : 0);
                    for (let c = 0; c < 4; ++c) assert(Number.isFinite(header.view.getFloat32(position + c * 4, true)));
                    assert(header.view.getFloat32(position + 12, true) > 0, "clipped vertices must have positive RHW");
                    assert.equal(header.view.getUint32(first + (stride === 24 ? 0 : 16), true) >>> 24, 255);
                }
            }
            if (opcode === P.OP.END_SCENE) {
                assert.equal(userMask, 1 << Math.floor(frames / modes), "original user-plane mask must be restored before EndScene");
                ++frames;assert.equal(draws, frames);
            }
            at += size;
        }
        carrier += 12 + size;
    }
    assert.equal(carrier, bytes.length);assert.equal(frames, 6 * modes);assert.equal(draws, frames);
    assert.equal(removed, metadata.removedPayloads.reduce((total, item) => total + item.bytes, 0));
}
console.log("PASS real XP D3D7/8/9 user-plane fixtures: 96 COM draws, positive clipped W, mask suspend/restore and sanitized payloads");
