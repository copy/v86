"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_display_mode_wire} = await import("../lib/d3d_display_mode_wire.mjs"), m = require("./fixtures/d3d_display_mode_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_display_mode_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_display_mode_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_display_mode_wire(b, result), {perAPI: m.perAPI, deviceLifetimes: 8, additionalChains: 4, backingTextures: 4, snapshots: 12, renderingCommands: 0});
    const targets = {};
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, expected] of [["width", "CreateDevice", "width", P.OP.CREATE_DEVICE], ["format", "CreateDevice", "backbuffer_format", P.OP.CREATE_DEVICE], ["height", "CreateTexture2D", "height", P.OP.CREATE_TEXTURE_2D], ["pool", "CreateTexture2D", "pool", P.OP.CREATE_TEXTURE_2D], ["backing", "CreateSwapChain", "back_buffer_handle", P.OP.CREATE_SWAP_CHAIN], ["chain", "DestroySwapChain", "swap_chain_handle", P.OP.DESTROY_SWAP_CHAIN], ["kind", "DestroyResource", "resource_kind", P.OP.DESTROY_RESOURCE]]) if (op === expected && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 7);
    for (const [name, at] of Object.entries(targets)) { const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_display_mode_wire(bad, result), undefined, name); }
    for (const api of [8, 9]) assert.throws(() => inspect_display_mode_wire(b, {...result, logs: {...result.logs, ["DSP" + api + ".TXT"]: result.logs["DSP" + api + ".TXT"].replace("step=1 width=640", "step=1 width=641")}}));
    assert.throws(() => inspect_display_mode_wire(b, {...result, logs: {...result.logs, "DSP8.TXT": result.logs["DSP8.TXT"].replace("lifetimes=4", "lifetimes=3")}}));
    console.log("PASS frozen XP live display queries: twelve 16/32-bit snapshots, eight device lifetimes, four additional chains/backing textures retired, no rendering traffic and ten semantic corruptions");
})().catch(e => { console.error(e); process.exitCode = 1; });
