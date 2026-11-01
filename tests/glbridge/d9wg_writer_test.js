"use strict";
const assert = require("node:assert/strict");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const { D9WGWriter, d9wg_commands: commands, d9wg_encode: encode } = await import("../../src/graphics_adapters/vmware_svga/svga3d_d9wg.js");
    const writer = new D9WGWriter();let number = 0;
    for (const name of Object.keys(P.COMMANDS)) {
        const opcode = P.OP[name], struct = P.commandStruct(opcode), values = {};
        for (const [field, layout] of Object.entries(P.STRUCTS[struct].fields)) {
            const value = layout.type === "float" ? -1.25 : layout.type === "int32_t" ? -123 : 19;
            values[field] = layout.count === 1 ? value : new Array(layout.count).fill(value);
        }
        writer.command(opcode, values);
        const batch = writer.finish(23, 0), [command] = commands(batch);
        const expected = P.encode(struct, values);
        assert.deepEqual(batch.subarray(command.at, command.at + expected.length), expected, name);
        assert.deepEqual(encode(struct, values), expected, name + " standalone");
        assert.equal(P.decode("BatchHeader", new DataView(batch.buffer), 0).frame_id, 23);
        ++number;
    }
    assert.throws(() => writer.command(0xffff, {}), /Unknown/);
    assert.throws(() => encode("SetMaterial", { diffuse: [1, 2, 3] }), /array size/);
    assert.throws(() => encode("SetTexture", { texture_hanlde: 12 }), /Unknown D9WG field/);
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    writer.command(P.OP.UPDATE_BUFFER, { resource_handle: 3, byte_count: blob.length });
    writer.patch_field("data_offset", writer.data(blob));
    assert.throws(() => writer.patch_field("bad_offset", 1), /Invalid/);
    const batch = writer.finish(1, 0), [item] = commands(batch);
    const update = P.decode("UpdateBuffer", item.view, item.at);
    assert.deepEqual(batch.subarray(update.data_offset, update.data_offset + blob.length), blob);
    writer.command(P.OP.CLEAR, { rect_count: 1 }).struct("Rect", { left: -1, top: 2, right: 5, bottom: 7 });
    const rectBatch = writer.finish(1, 0), [clear] = commands(rectBatch);
    assert.deepEqual(P.decode("Rect", clear.view, clear.at + P.STRUCTS.Clear.size), { left: -1, top: 2, right: 5, bottom: 7 });
    assert.throws(() => commands(rectBatch.subarray(0, 12)), /short/);
    assert.throws(() => commands(rectBatch.subarray(0, rectBatch.length - 1)), /byte count/);
    const badSize = rectBatch.slice();new DataView(badSize.buffer).setUint32(P.STRUCTS.BatchHeader.size + P.F.CommandHeader.size, 0, true);
    assert.throws(() => commands(badSize), /command size/);
    const badCount = rectBatch.slice();new DataView(badCount.buffer).setUint32(P.F.BatchHeader.command_count, 4, true);
    assert.throws(() => commands(badCount), /command count/);
    console.log("D9WG named SVGA writer: " + number + " command layouts match canonical encoder, inline arrays and blobs checked");
})().catch(error => { console.error(error);process.exitCode = 1; });
