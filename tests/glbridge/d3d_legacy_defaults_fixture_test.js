"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_legacy_defaults_wire: inspect, legacy_default_scenes: scenes} = await import("../lib/d3d_legacy_defaults_wire.mjs"), m = require("./fixtures/d3d_legacy_defaults_xp.json"), reference = require("./fixtures/d3d_legacy_defaults_reference.json"), b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_legacy_defaults_xp.bin.gz"))), hash = data => crypto.createHash("sha256").update(data).digest("hex"), result = {owners: m.owners, releases: m.ownerReleases, logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_legacy_defaults_reference.json"))), m.referenceSha256); assert.deepEqual(reference.scenes, scenes());
    const actual = inspect(b, result); for (const key of Object.keys(actual)) assert.deepEqual(actual[key], m[key]);
    const fields = [["CreateDevice", "width", "CREATE_DEVICE"], ["CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["CreateTexture2D", "level_count", "CREATE_TEXTURE_2D"], ["UpdateTexture", "row_pitch", "UPDATE_TEXTURE"], ["UpdateTexture", "width", "UPDATE_TEXTURE"], ["UpdateTexture", "data_bytes", "UPDATE_TEXTURE"], ["DrawPrimitiveUP", "primitive_count", "DRAW_PRIMITIVE_UP"], ["DrawPrimitiveUP", "vertex_bytes", "DRAW_PRIMITIVE_UP"], ["ReadbackSurface", "texture_handle", "READBACK_SURFACE"], ["ReadbackSurface", "request_id", "READBACK_SURFACE"], ["ReadbackSurface", "format", "READBACK_SURFACE"], ["ReadbackSurface", "width", "READBACK_SURFACE"], ["ReadbackSurface", "destination_pitch", "READBACK_SURFACE"], ["ReadbackSurface", "response_offset", "READBACK_SURFACE"], ["DestroyResource", "resource_kind", "DESTROY_RESOURCE"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[kind + field]) targets[kind + field] = p + P.F[kind][field];
            if (op === P.OP.UPDATE_TEXTURE && !targets.uploadPixel) targets.uploadPixel = start + b.readUInt32LE(p + P.F.UpdateTexture.data_offset);
            if (op === P.OP.DRAW_PRIMITIVE_UP && !targets.diffuseAlpha) targets.diffuseAlpha = start + b.readUInt32LE(p + P.F.DrawPrimitiveUP.vertex_data_offset) + 16;
            // Target the last applicable state before the first draw, so a later
            // legitimate initialization write cannot hide the mutation.
            if (!targets.diffuseAlpha && op === P.OP.SET_TEXTURE_STAGE_STATE && b.readUInt32LE(p + 4) === 0 && b.readUInt32LE(p + 8) === 4) targets.alphaOp = p + 12;
            if (!targets.diffuseAlpha && op === P.OP.SET_RENDER_STATE && b.readUInt32LE(p + 4) === 41) targets.v1KeyDefault = p + 8;
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 21);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect(bad, result), undefined, name);}
    for (const [from, to] of [["key=1", "key=0"], ["specular=1", "specular=0"], ["normalize=1", "normalize=0"], ["alpha=64", "alpha=255"], ["modernRejected=2", "modernRejected=0"]]) assert.throws(() => inspect(b, {...result, logs: {"LDEF.TXT": result.logs["LDEF.TXT"].replace(from, to)}}));
    assert.throws(() => inspect(b, {...result, releases: []})); assert.throws(() => inspect(b.subarray(0, b.length - 1), result));
    console.log("PASS frozen XP legacy D3D defaults: four creation APIs, sixteen draws/readbacks, 1024 independent RGBA pixels and 28 semantic corruptions");
})().catch(error => {console.error(error); process.exitCode = 1;});
