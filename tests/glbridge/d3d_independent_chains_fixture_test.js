"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_independent_chains_wire} = await import("../lib/d3d_independent_chains_wire.mjs"), m = require("./fixtures/d3d_independent_chains_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_independent_chains_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_independent_chains_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_independent_chains_wire(b, result), {perAPI: m.perAPI, frames: m.frames, deviceLifetimes: 2, resets: 2, textures: 4, chains: 4, chainPresents: 8, primaryPresents: 6});
    const fields = [["createWidth", "CreateDevice", "width", "CREATE_DEVICE"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["bufferWidth", "CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["backing", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["chain", "CreateSwapChain", "swap_chain_handle", "CREATE_SWAP_CHAIN"], ["reserved", "PresentSwapChain", "reserved", "PRESENT_SWAP_CHAIN"], ["window", "PresentSwapChain", "hwnd", "PRESENT_SWAP_CHAIN"], ["presentChain", "PresentSwapChain", "swap_chain_handle", "PRESENT_SWAP_CHAIN"], ["target", "SetRenderTarget", "color_texture_handle", "SET_RENDER_TARGET"], ["color", "Clear", "color", "CLEAR"], ["retire", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["destroy", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"], ["reset", "ResetDevice", "old_device_handle", "RESET"]], targets = Object.create(null);
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
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_independent_chains_wire(bad, result), undefined, name);}
    for (const [from, to] of [["cached=1", "cached=0"], ["isolatedPrivate=1", "isolatedPrivate=0"], ["privateFinalized=1", "privateFinalized=0"]]) assert.throws(() => inspect_independent_chains_wire(b, {...result, logs: {...result.logs, "IND8.TXT": result.logs["IND8.TXT"].replace(from, to)}}));
    console.log("PASS frozen XP independent chains: fourteen frames, four independent buffers/chains, 4x MSAA, early chain release and binding retention, sixteen semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
