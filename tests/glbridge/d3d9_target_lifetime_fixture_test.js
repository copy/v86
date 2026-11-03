"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_target_lifetime_wire} = await import("../lib/d3d9_target_lifetime_wire.mjs"), m = require("./fixtures/d3d9_target_lifetime_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_target_lifetime_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_target_lifetime_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_target_lifetime_wire(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, deviceLifetimes: 6, surfaceProfiles: 7, backingTextures: 10, publicReferenceCycles: 112, privateObjectsFinalized: 12, deviceFirstLifetimes: 3, bindingOnlyLifetimes: 2, renderTargetBindings: 1, depthBindings: 1, drawOrPresentOrResetCommands: 0});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["height", "CreateDevice", "height", "CREATE_DEVICE"], ["depth", "CreateDevice", "enable_auto_depth_stencil", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["textureWidth", "CreateTexture2D", "width", "CREATE_TEXTURE_2D"], ["textureHeight", "CreateTexture2D", "height", "CREATE_TEXTURE_2D"], ["textureFormat", "CreateTexture2D", "format", "CREATE_TEXTURE_2D"], ["usage", "CreateTexture2D", "usage", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["levels", "CreateTexture2D", "level_count", "CREATE_TEXTURE_2D"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["resource", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"], ["target", "SetRenderTarget", "color_texture_handle", "SET_RENDER_TARGET"], ["depthTarget", "SetDepthStencilSurfaceLevel", "depth_texture_handle", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["depthWidth", "SetDepthStencilSurfaceLevel", "width", "SET_DEPTH_STENCIL_SURFACE_LEVEL"]], targets = Object.create(null);
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
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_target_lifetime_wire(bad, result), undefined, name);}
    for (const [from, to] of [["deviceRefs=2 surfaceRefs=1", "deviceRefs=3 surfaceRefs=1"], ["cycles=16", "cycles=0"], ["callbackRefs=2", "callbackRefs=1"], ["oneParentPin=1", "oneParentPin=0"], ["privateFinalized=12", "privateFinalized=11"]]) assert.throws(() => inspect_target_lifetime_wire(b, {...result, logs: {...result.logs, "TGT9.TXT": result.logs["TGT9.TXT"].replace(from, to)}}));
    assert.throws(() => inspect_target_lifetime_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP D3D9 standalone target lifetime: seven profiles, 112 public-reference cycles, six devices/ten textures, twelve finalizers with live parent pins, device-first and actual RT/depth binding-only cleanup; twenty-one semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
