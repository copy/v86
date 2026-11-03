"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_additional_container_wire} = await import("../lib/d3d8_additional_container_wire.mjs"), m = require("./fixtures/d3d8_additional_container_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d8_additional_container_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d8_additional_container_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_additional_container_wire(b, result), {perAPI: m.perAPI, deviceLifetimes: 1, hostChains: 1, textureObjects: 3, deviceContainerQueries: 6, refusedContainerIIDs: 21, nullContainerOutputs: 3, ordinaryTextureContainerQueries: 2, renderingCommands: 0});
    const fields = [["createWidth", "CreateDevice", "width", "CREATE_DEVICE"], ["device", "CreateDevice", "device_handle", "CREATE_DEVICE"], ["backing", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["format", "CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["cube", "CreateTextureCube", "format", "CREATE_TEXTURE_CUBE"], ["chain", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 8);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_additional_container_wire(bad, result), undefined, name);}
    for (const [from, to] of [["device=2", "device=1"], ["exactRef=1", "exactRef=0"], ["chainReleasedFirst=1", "chainReleasedFirst=0"]]) assert.throws(() => inspect_additional_container_wire(b, {...result, logs: {...result.logs, "CNT8.TXT": result.logs["CNT8.TXT"].replace(from, to)}}));
    console.log("PASS frozen XP D3D8 additional container: device identity/exact references, rejected IIDs, cached buffer after chain Release, ordinary 2D/cube isolation and eleven semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
