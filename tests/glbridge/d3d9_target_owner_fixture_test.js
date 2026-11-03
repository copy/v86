"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_target_owner_wire} = await import("../lib/d3d9_target_owner_wire.mjs"), m = require("./fixtures/d3d9_target_owner_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_target_owner_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_target_owner_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_target_owner_wire(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, deviceLifetimes: 2, foreignProfiles: 8, refusedForeignBindings: 256, localBindings: 5, textureObjects: 7, additionalChains: 1, drawOrPresentOrResetCommands: 0});
    const fields = [
        ["width", "CreateDevice", "width", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"],
        ["textureDevice", "CreateTexture2D", "device_handle", "CREATE_TEXTURE_2D"], ["textureWidth", "CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["usage", "CreateTexture2D", "usage", "CREATE_TEXTURE_2D"], ["textureFormat", "CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"],
        ["edge", "CreateTextureCube", "edge_length", "CREATE_TEXTURE_CUBE"], ["chainBuffer", "CreateSwapChain", "back_buffer_handle", "CREATE_SWAP_CHAIN"], ["chainWidth", "CreateSwapChain", "width", "CREATE_SWAP_CHAIN"], ["chainDestroy", "DestroySwapChain", "swap_chain_handle", "DESTROY_SWAP_CHAIN"], ["destroyKind", "DestroyResource", "resource_kind", "DESTROY_RESOURCE"],
        ...["device_handle", "target_index", "color_texture_handle", "color_face", "color_level"].map(n => [n, "SetRenderTarget", n, "SET_RENDER_TARGET"]),
    ], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 17);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_target_owner_wire(bad, result), undefined, name);}
    for (const [from, to] of [["rounds=8", "rounds=0"], ["refused=32", "refused=0"], ["stateUnchanged=1", "stateUnchanged=0"], ["localBindings=5", "localBindings=0"]]) assert.throws(() => inspect_target_owner_wire(b, {...result, logs: {...result.logs, "OWN9.TXT": result.logs["OWN9.TXT"].replace(from, to)}}));
    assert.throws(() => inspect_target_owner_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP D3D9 target owners: eight foreign profiles, 256 refused calls without foreign binding commands, five local bindings, two device lifetimes and exact target/chain retirement; twenty-two semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
