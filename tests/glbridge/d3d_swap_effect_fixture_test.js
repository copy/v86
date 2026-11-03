"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_swap_effect_wire} = await import("../lib/d3d_swap_effect_wire.mjs"), m = require("./fixtures/d3d_swap_effect_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_swap_effect_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_swap_effect_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_swap_effect_wire(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, deviceLifetimes: 9, successfulResets: 20, chains: 7, textures: 7, acceptedMatrixCalls: 21, refusedMatrixCalls: 39, refusedResets: 13, failedPresentsWithoutCommands: 13, drawOrPresentCommands: 0});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["textureWidth", "CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["backing", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["chainWidth", "CreateSwapChain", "width", "CREATE_SWAP_CHAIN"], ["destroyChain", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["old", "ResetDevice", "old_device_handle", "RESET"], ["new", "ResetDevice", "new_device_handle", "RESET"], ["quality", "ResetDevice", "multisample_quality", "RESET"], ["depth", "ResetDevice", "enable_auto_depth_stencil", "RESET"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
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
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_swap_effect_wire(bad, result), undefined, name);}
    for (const [from, to] of [["effect=4 count=1 constructor=1", "effect=5 count=1 constructor=1"], ["cached=1", "cached=0"], ["routes=3", "routes=2"], ["resetLost=1", "resetLost=0"]]) assert.throws(() => inspect_swap_effect_wire(b, {...result, logs: {...result.logs, "SFX8.TXT": result.logs["SFX8.TXT"].replace(from, to)}}));
    assert.throws(() => inspect_swap_effect_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP swap-effect validation: 21 accepted and 39 refused matrix calls, nine device lifetimes, twenty successful and thirteen refused Resets, no Present traffic; eighteen semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
