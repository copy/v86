"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_present_multisample_wire} = await import("../lib/d3d_present_multisample_wire.mjs"), m = require("./fixtures/d3d_present_multisample_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_present_multisample_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_present_multisample_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_present_multisample_wire(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, deviceLifetimes: 4, successfulResets: 11, chains: 2, textures: 2, acceptedMatrixCalls: 6, refusedMatrixCalls: 27, refusedResets: 9, failedPresentsWithoutCommands: 9, lockRefusals: 8, retainedUnsupportedAdditionalMSAA: 1, drawReadbackOrPresentCommands: 0});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["textureWidth", "CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["backing", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["chainWidth", "CreateSwapChain", "width", "CREATE_SWAP_CHAIN"], ["destroyChain", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["old", "ResetDevice", "old_device_handle", "RESET"], ["new", "ResetDevice", "new_device_handle", "RESET"], ["quality", "ResetDevice", "multisample_quality", "RESET"], ["resetSamples", "ResetDevice", "multisample_type", "RESET"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
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
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_present_multisample_wire(bad, result), undefined, name);}
    for (const [api, from, to] of [[8, "flags=1 locksRefused=4", "flags=0 locksRefused=4"], [8, "locksRefused=4", "locksRefused=0"], [8, "resetLost=1", "resetLost=0"], [9, "quality=1 flags=0", "quality=0 flags=0"], [9, "samples=4 unsupported=1", "samples=4 unsupported=0"]]) {
        const key = "MSP" + api + ".TXT"; assert(result.logs[key].includes(from));
        assert.throws(() => inspect_present_multisample_wire(b, {...result, logs: {...result.logs, [key]: result.logs[key].replace(from, to)}}));
    }
    assert.throws(() => inspect_present_multisample_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP presentation MSAA: six accepted and 27 refused matrix calls, four device lifetimes, eleven successful/nine refused Resets, eight unchanged lock refusals, retained D3D9 additional limit, no rendering/readback traffic; nineteen semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
