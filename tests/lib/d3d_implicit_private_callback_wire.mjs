import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_implicit_private_callback_wire(bytes, result) {
    assert.equal(result.owners.length, 2); assert.equal(new Set(result.owners).size, 2); assert.deepEqual(result.releases, result.owners);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: 8 + i, hello: 0, device: 0, created: [], destroyed: [], targets: 0, depths: 0, ended: 0}]));
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected implicit callback rendering/Reset/resource traffic: " + op);
            if (op === P.OP.HELLO) {assert.equal(s.created.length, 0); assert.equal(s.hello++, 0);}
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"); assert.equal(s.hello, 1); assert.equal(s.device, 0); assert(s.created.length < 5); assert(q.device_handle && !s.created.includes(q.device_handle));
                assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);
                s.device = q.device_handle; s.created.push(s.device);
            }
            if (op === P.OP.SET_RENDER_TARGET) {
                const q = decode("SetRenderTarget"); assert.equal(s.created.length, 2); assert.equal(s.destroyed.length, 1); assert.equal(s.targets++, 0); assert.equal(q.device_handle, s.device); assert.equal(q.target_index, 0); assert.equal(q.color_texture_handle, 0); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0);
            }
            if (op === P.OP.SET_DEPTH_STENCIL_SURFACE_LEVEL) {
                const q = decode("SetDepthStencilSurfaceLevel"); assert.equal(s.created.length, 2); assert.equal(s.destroyed.length, 1); assert.equal(s.depths++, 0); assert.equal(q.device_handle, s.device); assert.equal(q.depth_texture_handle, 0xffffffff); assert.equal(q.depth_level, 0); assert.equal(q.width, 32); assert.equal(q.height, 24);
            }
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource"); assert(s.device); assert.equal(q.resource_kind, 0); assert.equal(q.resource_handle, s.device); assert.equal(s.created.length, s.destroyed.length + 1);
                if (s.created.length >= 2) {assert.equal(s.targets, 1); assert.equal(s.depths, 1);}
                s.destroyed.push(s.device); s.device = 0;
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); assert.equal(s.destroyed.length, 5); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.hello, 1); assert.equal(s.device, 0); assert.equal(s.created.length, 5); assert.deepEqual(s.destroyed, s.created); assert.equal(s.targets, 1); assert.equal(s.depths, 1); assert(s.ended === 0 || s.ended === 1);
        const expected = Array.from({length: 5}, (_, i) => `IMPLICIT CALLBACK order=${i} finalized=${i === 4 ? 3 : 2} queryDeviceRefs=1 retainedParent=${i === 3 ? 1 : 0} reinserted=${i === 4 ? 1 : 0} factoryRefs=1`);
        expected.push("IMPLICIT STATUS devices=5 privateFinalized=11 protectedQueries=11 retainedParent=1 reinserted=1 factoryRefs=1", "PASS implicit private callbacks API=" + s.api);
        assert.equal(result.logs["IPC" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, ownerReleases: result.releases, deviceLifetimes: 10, privateObjectsFinalized: 22, protectedQueries: 22, retainedParents: 2, reentrantInsertions: 2, renderTargetBindings: 2, depthBindings: 2, renderingOrResetCommands: 0};
}
