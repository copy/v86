"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_standalone_container_wire} = await import("../lib/d3d9_standalone_container_wire.mjs"), m = require("./fixtures/d3d9_standalone_container_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_standalone_container_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_standalone_container_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_standalone_container_wire(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, deviceLifetimes: 1, standaloneProfiles: 5, acceptedDeviceQueries: 80, refusedStandaloneQueries: 280, nullGuards: 10, retainedTextureCubeControls: 2, backingTextures2D: 4, backingTexturesCube: 1, drawOrPresentOrResetCommands: 0});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["textureWidth", "CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["textureHeight", "CreateTexture2D", "height", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["textureFormat", "CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["edge", "CreateTextureCube", "edge_length", "CREATE_TEXTURE_CUBE"], ["cubePool", "CreateTextureCube", "pool", "CREATE_TEXTURE_CUBE"], ["cubeFormat", "CreateTextureCube", "format", "CREATE_TEXTURE_CUBE"], ["reserved", "CreateTextureCube", "reserved", "CREATE_TEXTURE_CUBE"], ["kind", "DestroyResource", "resource_kind", "DESTROY_RESOURCE"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 13);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_standalone_container_wire(bad, result), undefined, name);}
    for (const [from, to] of [["rounds=8", "rounds=0"], ["deviceQueries=16", "deviceQueries=0"], ["hiddenTextureExposed=0", "hiddenTextureExposed=1"], ["kind=cube accepted=4", "kind=cube accepted=3"]]) assert.throws(() => inspect_standalone_container_wire(b, {...result, logs: {...result.logs, "SCN9.TXT": result.logs["SCN9.TXT"].replace(from, to)}}));
    assert.throws(() => inspect_standalone_container_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP D3D9 standalone containers: five storage profiles, 80 device/280 refused queries, ten NULL guards, texture/cube controls, exact resource retirement and no rendering/Reset; eighteen semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
