"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_implicit_private_callback_wire: inspect} = await import("../lib/d3d_implicit_private_callback_wire.mjs"), m = require("./fixtures/d3d_implicit_private_callback_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_implicit_private_callback_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs, releases: m.ownerReleases};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_implicit_private_callback_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect(b, result), {perAPI: m.perAPI, ownerReleases: m.ownerReleases, deviceLifetimes: 10, privateObjectsFinalized: 22, protectedQueries: 22, retainedParents: 2, reentrantInsertions: 2, renderTargetBindings: 2, depthBindings: 2, renderingOrResetCommands: 0});
    const fields = [["width", "CreateDevice", "width", "CREATE_DEVICE"], ["height", "CreateDevice", "height", "CREATE_DEVICE"], ["device", "CreateDevice", "device_handle", "CREATE_DEVICE"], ["format", "CreateDevice", "backbuffer_format", "CREATE_DEVICE"], ["autoDepth", "CreateDevice", "enable_auto_depth_stencil", "CREATE_DEVICE"], ["depthFormat", "CreateDevice", "auto_depth_stencil_format", "CREATE_DEVICE"], ["samples", "CreateDevice", "multisample_type", "CREATE_DEVICE"], ["quality", "CreateDevice", "multisample_quality", "CREATE_DEVICE"], ["targetDevice", "SetRenderTarget", "device_handle", "SET_RENDER_TARGET"], ["targetIndex", "SetRenderTarget", "target_index", "SET_RENDER_TARGET"], ["targetHandle", "SetRenderTarget", "color_texture_handle", "SET_RENDER_TARGET"], ["depthDevice", "SetDepthStencilSurfaceLevel", "device_handle", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["depthHandle", "SetDepthStencilSurfaceLevel", "depth_texture_handle", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["depthWidth", "SetDepthStencilSurfaceLevel", "width", "SET_DEPTH_STENCIL_SURFACE_LEVEL"], ["destroyKind", "DestroyResource", "resource_kind", "DESTROY_RESOURCE"], ["destroyHandle", "DestroyResource", "resource_handle", "DESTROY_RESOURCE"]], targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, opcode] of fields) if (op === P.OP[opcode] && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 16);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect(bad, result), undefined, name);}
    for (const api of [8, 9]) for (const [from, to] of [["finalized=2", "finalized=1"], ["queryDeviceRefs=1", "queryDeviceRefs=0"], ["retainedParent=1", "retainedParent=0"], ["reinserted=1", "reinserted=0"]]) {const name = "IPC" + api + ".TXT"; assert.throws(() => inspect(b, {...result, logs: {...result.logs, [name]: result.logs[name].replace(from, to)}}));}
    assert.throws(() => inspect(b, {...result, releases: []})); assert.throws(() => inspect(b.subarray(0, b.length - 1), result));
    console.log("PASS frozen XP implicit private callbacks: ten devices, twenty-two protected finalizers, retained parents and reentrant insertion; twenty-six semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
