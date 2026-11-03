"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_multisample_chain_wire} = await import("../lib/d3d_multisample_chain_wire.mjs"), m = require("./fixtures/d3d_multisample_chain_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_multisample_chain_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_multisample_chain_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_multisample_chain_wire(b, result), {perAPI: m.perAPI, frames: m.frames, ownerReleases: m.ownerReleases, deviceLifetimes: 2, resets: 2, chains: 2, textures: 2, chainPresents: 4, revivalCycles: 64, privateObjectsFinalized: 2});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["device", "CreateDevice", "device_handle", "CREATE_DEVICE"], ["backing", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["format", "CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["presentChain", "PresentSwapChain", "swap_chain_handle", "PRESENT_SWAP_CHAIN"], ["reserved", "PresentSwapChain", "reserved", "PRESENT_SWAP_CHAIN"], ["presentWidth", "PresentSwapChain", "width", "PRESENT_SWAP_CHAIN"], ["color", "Clear", "color", "CLEAR"], ["old", "ResetDevice", "old_device_handle", "RESET"], ["new", "ResetDevice", "new_device_handle", "RESET"], ["destroyDevice", "DestroySwapChain", "device_handle", "DESTROY_SWAP_CHAIN"], ["chain", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 15);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_multisample_chain_wire(bad, result), undefined, name);}
    for (const [from, to] of [["cycles=32", "cycles=0"], ["independent=1", "independent=0"], ["cached=1", "cached=0"], ["privateFinalized=1", "privateFinalized=2"]]) assert.throws(() => inspect_multisample_chain_wire(b, {...result, logs: {...result.logs, "MSC8.TXT": result.logs["MSC8.TXT"].replace(from, to)}}));
    assert.throws(() => inspect_multisample_chain_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP true-MSAA additional chains: 4x samples for both APIs, 32 cycles each, four frames, binding-only Reset and exact private finalization; twenty semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
