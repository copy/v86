"use strict";
const assert = require("node:assert/strict"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), reference = require("./fixtures/d3d_format_layout_reference.json");
(async () => {
    const {inspect_format_layouts_wire} = await import("../lib/d3d_format_layouts_wire.mjs"), geometry = new Map(reference.geometry.map(([format, ...shape]) => [format, shape]));
    function wire(api, mutate = "") {
        const commands = [];
        for (const [index, format] of reference.frontendFormats[api].entries()) {
            const handle = 1000 + index, [bw, bh, bytes] = geometry.get(format);
            commands.push({opcode: P.OP.CREATE_TEXTURE_2D, payload: P.encode("CreateTexture2D", {device_handle: 7, resource_handle: handle, width: 8, height: 8, level_count: 4, format})});
            for (let level = 0; level < (mutate === "missing" && index === 0 ? 3 : 4); ++level) {
                const size = 8 >> level, pitch = Math.ceil(size / bw) * bytes, rows = Math.ceil(size / bh), data = Buffer.alloc(pitch * rows);
                for (let row = 0; row < rows; ++row) for (let col = 0; col < pitch; ++col) data[row * pitch + col] = (api + (format & 255) + level * 17 + row * 11 + col * 3) & 255;
                if (mutate === "byte" && index === 0 && level === 0) data[3] ^= 1;
                commands.push({opcode: P.OP.UPDATE_TEXTURE, payload: P.encode("UpdateTexture", {resource_handle: handle, level, width: size, height: size, depth: 1, row_pitch: pitch + (mutate === "pitch" && index === 0 && level === 0 ? 1 : 0), slice_pitch: data.length, data_bytes: data.length}), blobs: [{field: "data_offset", data}]});
            }
        }
        const batch = Buffer.from(P.encodeBatch(commands)), packet = Buffer.alloc(20 + batch.length);
        packet.writeUInt32LE(api, 0); packet.writeUInt32LE(8 + batch.length, 8); packet.writeUInt16LE(0xffe1, 12); packet.writeUInt16LE(0xffff, 14); packet.writeUInt32LE(batch.length, 16); batch.copy(packet, 20); return packet;
    }
    const valid8 = wire(8), valid9 = wire(9), result = inspect_format_layouts_wire(Buffer.concat([valid8, valid9]), [8, 9]);
    assert.deepEqual(result.map(r => [r.api, r.textures, r.levels]), [[8, 34, 136], [9, 48, 192]]);
    for (const mutation of ["byte", "pitch", "missing"]) assert.throws(() => inspect_format_layouts_wire(Buffer.concat([wire(8, mutation), valid9]), [8, 9]));
    console.log("PASS format layout wire oracle: 328 exact mip payloads; corrupted upload byte/pitch and missing level rejected");
})().catch(error => {console.error(error); process.exitCode = 1;});
