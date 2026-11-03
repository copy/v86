"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib"), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_target_binding_wire} = await import("../lib/d3d9_target_binding_wire.mjs"), m = require("./fixtures/d3d9_target_binding_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_target_binding_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d9_target_binding_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_target_binding_wire(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, frames: m.frames, logicalDevices: 3, wireDeviceHandles: 4, backingTextures: 5, resets: 1, publicZeroRevivals: 64, privateObjectsFinalized: 5, renderTargetBindings: 40, depthBindings: 38, draws: 0});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["samples", "CreateTexture2D", "multisample_type", "CREATE_TEXTURE_2D"], ["pool", "CreateTexture2D", "pool", "CREATE_TEXTURE_2D"], ["usage", "CreateTexture2D", "usage", "CREATE_TEXTURE_2D"], ["rtdevice_handle", "SetRenderTarget", "device_handle", "SET_RENDER_TARGET"], ["rttarget_index", "SetRenderTarget", "target_index", "SET_RENDER_TARGET"], ["rtcolor_texture_handle", "SetRenderTarget", "color_texture_handle", "SET_RENDER_TARGET"], ["rtcolor_level", "SetRenderTarget", "color_level", "SET_RENDER_TARGET"], ["rtcolor_face", "SetRenderTarget", "color_face", "SET_RENDER_TARGET"], ["depthdevice_handle", "SetDepthStencilSurfaceLevel", "device_handle", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["depthdepth_texture_handle", "SetDepthStencilSurfaceLevel", "depth_texture_handle", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["depthwidth", "SetDepthStencilSurfaceLevel", "width", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["color", "Clear", "color", "CLEAR"], ["flags", "Clear", "clear_flags", "CLEAR"], ["copysource_texture_handle", "StretchRect", "source_texture_handle", "STRETCH_RECT"], ["copydestination_texture_handle", "StretchRect", "destination_texture_handle", "STRETCH_RECT"], ["copysource_right", "StretchRect", "source_right", "STRETCH_RECT"], ["presentwidth", "Present", "width", "PRESENT"], ["presentdevice_handle", "Present", "device_handle", "PRESENT"], ["resetold_device_handle", "ResetDevice", "old_device_handle", "RESET"], ["resetnew_device_handle", "ResetDevice", "new_device_handle", "RESET"], ["resetwidth", "ResetDevice", "width", "RESET"], ["destroyresource_kind", "DestroyResource", "resource_kind", "DESTROY_RESOURCE"], ["destroyresource_handle", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 25);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_target_binding_wire(bad, result), undefined, name);}
    for (const [from, to] of [["rounds=32", "rounds=0"], ["publicRefs=0", "publicRefs=1"], ["privateFinalized=5", "privateFinalized=0"], ["clearPublicRefs=0", "clearPublicRefs=1"]]) assert.throws(() => inspect_target_binding_wire(b, {...result, logs: {...result.logs, "BND9.TXT": result.logs["BND9.TXT"].replace(from, to)}}));
    assert.throws(() => inspect_target_binding_wire(b, {...result, releases: []}));
    console.log("PASS frozen XP D3D9 target bindings: two true-MSAA Clear/resolve/Present frames, 64 public-zero revivals, bound-only Reset, three devices/five exact finalizers and resource-before-device cleanup; thirty semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
