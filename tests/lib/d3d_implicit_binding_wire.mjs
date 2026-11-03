import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_implicit_binding_wire(bytes, result) {
    assert.equal(result.owners.length, 2); assert.equal(new Set(result.owners).size, 2); assert.deepEqual(result.releases, result.owners);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: 8 + i, hello: 0, device: 0, handles: [], created: 0, destroyed: 0, resets: 0, targets: 0, depths: 0, clears: 0, presents: 0, ended: 0}])), frames = [], colors = [0xffb02010, 0xff1040c0];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "RESET", "CLEAR", "PRESENT", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    function primary(q) {assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);}
    function handle(s, id) {assert(id && !s.handles.includes(id)); s.handles.push(id); s.device = id;}
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected implicit binding traffic: " + op);
            if (op === P.OP.HELLO) {assert.equal(s.created, 0); assert.equal(s.hello++, 0);}
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(s.hello, 1); assert.equal(s.device, 0); assert(s.created < 3); primary(q); handle(s, q.device_handle); s.created++;}
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert(s.device); assert.equal(s.clears, s.created === 1 ? 0 : 2); assert.equal(q.device_handle, s.device); assert.equal(q.target_index, 0); assert.equal(q.color_texture_handle, 0); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0); s.targets++; if (s.created === 1) assert(s.targets <= 33); else assert.equal(s.targets, s.created === 2 ? 34 : 35);}
            if (op === P.OP.SET_DEPTH_STENCIL_SURFACE_LEVEL) {const q = decode("SetDepthStencilSurfaceLevel"); assert(s.device); assert.equal(q.device_handle, s.device); assert.equal(q.depth_texture_handle, 0xffffffff); assert.equal(q.depth_level, 0); assert.equal(q.width, 32); assert.equal(q.height, 24); s.depths++; assert.equal(s.depths, s.targets);}
            if (op === P.OP.CLEAR) {const q = decode("Clear"), step = s.clears++; assert(step < 2); assert.equal(s.created, 1); assert.equal(s.presents, step); assert.equal(s.targets, 33); assert.equal(s.depths, 33); assert.equal(q.device_handle, s.device); assert.equal(q.clear_flags, 1); assert.equal(q.color, colors[step]); assert.equal(q.rect_count, 0); assert.equal(q.depth, 1); assert.equal(q.stencil, 0);}
            if (op === P.OP.PRESENT) {const q = decode("Present"), step = s.presents++; assert(step < 2); assert.equal(s.created, 1); assert.equal(s.resets, 0); assert.equal(s.clears, step + 1); assert.equal(q.device_handle, s.device); assert.equal(q.width, 32); assert.equal(q.height, 24); frames.push({owner: s.owner, api: s.api, device: s.device, step, width: 32, height: 24, samples: 0, color: colors[step]});}
            if (op === P.OP.RESET) {const q = decode("ResetDevice"); assert.equal(s.created, 1); assert.equal(s.destroyed, 0); assert.equal(s.resets++, 0); assert.equal(s.presents, 2); assert.equal(s.targets, 33); assert.equal(s.depths, 33); assert.equal(q.old_device_handle, s.device); primary(q); handle(s, q.new_device_handle);}
            if (op === P.OP.DESTROY_RESOURCE) {const q = decode("DestroyResource"); assert(s.device); assert.equal(s.resets, 1); assert.equal(s.presents, 2); assert.equal(q.resource_kind, 0); assert.equal(q.resource_handle, s.device); assert.equal(s.created, ++s.destroyed); assert.equal(s.targets, s.created === 1 ? 33 : s.created === 2 ? 34 : 35); assert.equal(s.depths, s.targets); s.device = 0;}
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); assert.equal(s.destroyed, 3); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.hello, 1); assert.equal(s.device, 0); assert.equal(s.handles.length, 4); assert.equal(s.created, 3); assert.equal(s.destroyed, 3); assert.equal(s.targets, 35); assert.equal(s.depths, 35); assert.equal(s.resets, 1); assert.equal(s.clears, 2); assert.equal(s.presents, 2); assert(s.ended === 0 || s.ended === 1);
        const expected = ["IMPLICIT BIND rounds=32 revivals=64 publicRefs=0 activeDeviceRefs=1 queryDeviceRefs=3 privateRetained=2", "IMPLICIT FRAME index=0 color=FFB02010 publicRefs=0 presented=1", "IMPLICIT FRAME index=1 color=FF1040C0 publicRefs=0 presented=1", "IMPLICIT RESET refused=2 accepted=1 privateRetained=2 cachedIdentity=1 finalPrivateFinalized=2 callbackRefs=1 factoryRefs=1", "IMPLICIT FINAL publicRefs=0 privateFinalized=2 callbackRefs=1 factoryRefs=1", "IMPLICIT LAST publicRefs=0 privateFinalized=2 callbackRefs=1 factoryRefs=1", "IMPLICIT BIND STATUS devices=3 reset=1 refusedReset=2 frames=2 revivals=64 privateFinalized=6 publicBindingRefs=0 factoryRefs=1", "PASS implicit private bindings API=" + s.api];
        assert.equal(result.logs["IBD" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, frames, ownerReleases: result.releases, logicalDevices: 6, wireDeviceHandles: 8, privateObjectsFinalized: 12, publicZeroRevivals: 128, resets: 2, refusedResets: 4, renderTargetBindings: 70, depthBindings: 70, primaryPresents: 4};
}
