import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_target_lifetime_wire(bytes, result) {
    assert.equal(result.owners.length, 1); assert.deepEqual(result.releases, result.owners);
    const owner = result.owners[0], s = {owner, api: 9, device: 0, hello: 0, ended: 0, devices: []}, handles = new Set(); let current;
    const profiles = [[1,0,22], [1,4,22], [2,0,75], [2,4,75], [0,0,22]], perDevice = [profiles, [[1,4,22]], [[2,0,75]], [[0,0,22]], [[1,4,22]], [[2,0,75]]];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected target-lifetime rendering/Reset traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"); assert.equal(s.device, 0); const index = s.devices.length; assert(index < 6); assert(q.device_handle && !handles.has(q.device_handle)); handles.add(q.device_handle); s.device = q.device_handle; current = {index, handle: s.device, textures: [], bindings: 0, retired: false}; s.devices.push(current);
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"), wanted = perDevice[current.index][current.textures.length]; assert(wanted && s.device); assert(current.textures.every(t => t.retired)); assert.equal(q.device_handle, s.device); assert(q.resource_handle && !handles.has(q.resource_handle)); handles.add(q.resource_handle);
                assert.equal(q.width, current.index === 5 ? 64 : 32); assert.equal(q.height, current.index === 5 ? 64 : 24); assert.equal(q.format, wanted[2]); assert.equal(q.usage, wanted[0]); assert.equal(q.pool, 0); assert.equal(q.level_count, 1); assert.equal(q.multisample_type, wanted[1]); assert.equal(q.multisample_quality, 0); current.textures.push({handle: q.resource_handle, usage: q.usage, samples: q.multisample_type, retired: false});
            }
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(current.index, 4); assert.equal(q.device_handle, s.device); assert.equal(q.target_index, 0); assert.equal(q.color_texture_handle, current.textures[0].handle); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0); assert.equal(current.bindings++, 0);}
            if (op === P.OP.SET_DEPTH_STENCIL_SURFACE_LEVEL) {const q = decode("SetDepthStencilSurfaceLevel"); assert.equal(current.index, 5); assert.equal(q.device_handle, s.device); assert.equal(q.depth_texture_handle, current.textures[0].handle); assert.equal(q.depth_level, 0); assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(current.bindings++, 0);}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource"); assert(current && s.device);
                if (q.resource_kind === 0) {assert.equal(q.resource_handle, s.device); assert.equal(current.textures.length, perDevice[current.index].length); assert(current.textures.every(t => t.retired)); assert.equal(current.bindings, current.index >= 4 ? 1 : 0); assert(!current.retired); current.retired = true; s.device = 0;}
                else {assert.equal(q.resource_kind, 3); const t = current.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t); if (current.index >= 4) assert.equal(current.bindings, 1); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert(s.ended === 0 || s.ended === 1); assert.equal(s.device, 0); assert.equal(s.devices.length, 6); assert(s.devices.every(d => d.retired && d.textures.every(t => t.retired)));
    const expected = Array.from({length: 7}, (_, kind) => "TARGET PROFILE kind=" + kind + " samples=" + (kind === 1 || kind === 3 ? 4 : 0) + " cycles=16 deviceRefs=2 surfaceRefs=1 queryRefs=3 privateFinalized=1 callbackRefs=2 remainingDeviceRefs=1");
    expected.push(...[1,2,4].map(kind => "TARGET LASTVIEW kind=" + kind + " applicationDeviceRefs=1 queryRefs=2 callbackRefs=1 privateFinalized=1 factoryRefs=1"), ...[1,2].map(kind => "TARGET BOUND kind=" + kind + " callbackRefs=1 privateFinalized=1 deviceRefs=0 factoryRefs=1"), "TARGET STATUS profiles=7 devices=6 privateFinalized=12 oneParentPin=1 deviceFirst=3 bindingOnly=2 factoryRefs=1", "PASS target lifetime API=9");
    assert.equal(result.logs["TGT9.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perAPI: [s], ownerReleases: result.releases, deviceLifetimes: 6, surfaceProfiles: 7, backingTextures: 10, publicReferenceCycles: 112, privateObjectsFinalized: 12, deviceFirstLifetimes: 3, bindingOnlyLifetimes: 2, renderTargetBindings: 1, depthBindings: 1, drawOrPresentOrResetCommands: 0};
}
