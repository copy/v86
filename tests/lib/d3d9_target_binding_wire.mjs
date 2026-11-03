import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_target_binding_wire(bytes, result) {
    assert.equal(result.owners.length, 1); assert.deepEqual(result.releases, result.owners);
    const s = {owner: result.owners[0], api: 9, hello: 0, ended: 0, devices: [], textures: [], rtBindings: 0, depthBindings: 0, resets: 0, clears: 0, copies: 0}, frames = [], handles = new Set(); let current;
    const colors = [0xffb02010,0xff1040c0], expectedRT = [...Array(33).fill(0), -1,0,-1,0,2,4,-1], expectedDepth = [...Array(33).fill(1), -1,1,-1,1,3];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "CLEAR", "STRETCH_RECT", "PRESENT", "RESET", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "SET_VERTEX_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_B", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(n => P.OP[n]));
    function primary(q) {assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);}
    function newHandle(handle) {assert(handle && !handles.has(handle)); handles.add(handle);}
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), s.owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected target-binding draw/readback traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert(!current || current.retired); assert(s.devices.length < 3); primary(q); newHandle(q.device_handle); current = {index: s.devices.length, handle: q.device_handle, handles: [q.device_handle], target: 0, depth: 0, retired: false}; s.devices.push(current);}
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"), i = s.textures.length; assert(current && !current.retired && i < 5); assert.equal(current.index, i < 2 ? 0 : i < 4 ? 1 : 2); assert.equal(q.device_handle, current.handle); newHandle(q.resource_handle);
                assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.usage, i === 1 || i === 3 ? 2 : 1); assert.equal(q.format, i === 1 || i === 3 ? 75 : 22); assert.equal(q.pool, 0); assert.equal(q.level_count, 1); assert.equal(q.multisample_type, i < 2 ? 4 : 0); assert.equal(q.multisample_quality, 0);
                s.textures.push({handle: q.resource_handle, deviceIndex: current.index, samples: q.multisample_type, usage: q.usage, retired: false});
            }
            if (op === P.OP.SET_RENDER_TARGET) {
                const q = decode("SetRenderTarget"), wanted = expectedRT[s.rtBindings++]; assert(wanted !== undefined && current && !current.retired); assert.equal(q.device_handle, current.handle); assert.equal(q.target_index, 0); assert.equal(q.color_texture_handle, wanted < 0 ? 0 : s.textures[wanted].handle); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0);
                if (wanted >= 0) {assert(!s.textures[wanted].retired); assert.equal(s.textures[wanted].deviceIndex, current.index);} current.target = q.color_texture_handle;
            }
            if (op === P.OP.SET_DEPTH_STENCIL_SURFACE_LEVEL) {
                const q = decode("SetDepthStencilSurfaceLevel"), wanted = expectedDepth[s.depthBindings++]; assert(wanted !== undefined && current && !current.retired); assert.equal(q.device_handle, current.handle); assert.equal(q.depth_texture_handle, wanted < 0 ? 0 : s.textures[wanted].handle); assert.equal(q.depth_level, 0); assert.equal(q.width, wanted < 0 ? 0 : 32); assert.equal(q.height, wanted < 0 ? 0 : 24);
                if (wanted >= 0) {assert(!s.textures[wanted].retired); assert.equal(s.textures[wanted].deviceIndex, current.index);} current.depth = q.depth_texture_handle;
            }
            if (op === P.OP.CLEAR) {const q = decode("Clear"), step = s.clears++; assert(current && current.index === 0 && !current.retired); assert.equal(q.device_handle, current.handle); assert.equal(current.target, s.textures[0].handle); assert.equal(current.depth, s.textures[1].handle); assert.equal(q.clear_flags, 1); assert.equal(q.color, colors[step]); assert.equal(q.depth, 1); assert.equal(q.stencil, 0); assert.equal(q.rect_count, 0); assert.equal(s.rtBindings, step ? 35 : 33); assert.equal(s.depthBindings, step ? 35 : 33);}
            if (op === P.OP.STRETCH_RECT) {
                const q = decode("StretchRect"); assert.equal(current.index, 0); assert.equal(q.device_handle, current.handle); assert.equal(q.source_texture_handle, s.textures[0].handle); assert.equal(q.destination_texture_handle, 0); assert.equal(q.filter_point, 1); assert.equal(s.clears, ++s.copies);
                for (const field of ["source_level", "source_face", "destination_level", "destination_face", "source_left", "source_top", "destination_left", "destination_top"]) assert.equal(q[field], 0);
                for (const field of ["source_right", "destination_right"]) assert.equal(q[field], 32); for (const field of ["source_bottom", "destination_bottom"]) assert.equal(q[field], 24);
            }
            if (op === P.OP.PRESENT) {const q = decode("Present"), step = frames.length; assert(step < 2 && current.index === 0 && !current.retired && !current.target && !current.depth); assert.equal(q.device_handle, current.handle); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(s.clears, step + 1); assert.equal(s.copies, step + 1); assert.equal(s.rtBindings, step ? 36 : 34); assert.equal(s.depthBindings, step ? 36 : 34); assert(!s.textures[0].retired && !s.textures[1].retired); frames.push({owner: s.owner, api: 9, device: current.handle, texture: s.textures[0].handle, depth: s.textures[1].handle, width: 32, height: 24, samples: 4, step, color: colors[step]});}
            if (op === P.OP.RESET) {const q = decode("ResetDevice"); assert.equal(current.index, 0); assert.equal(s.resets++, 0); assert.equal(frames.length, 2); assert.equal(s.rtBindings, 37); assert.equal(s.depthBindings, 37); assert.equal(q.old_device_handle, current.handle); primary(q); newHandle(q.new_device_handle); current.handle = q.new_device_handle; current.handles.push(current.handle); current.target = current.depth = 0; assert(s.textures.length === 2 && s.textures.every(t => !t.retired));}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource"); assert(current && !current.retired);
                if (!q.resource_kind) {assert.equal(q.resource_handle, current.handle); assert(s.textures.filter(t => t.deviceIndex === current.index).every(t => t.retired)); assert.equal(s.textures.length, current.index === 0 ? 2 : current.index === 1 ? 4 : 5); assert.equal(s.rtBindings, current.index === 0 ? 37 : current.index === 1 ? 38 : 40); assert.equal(s.depthBindings, current.index === 0 ? 37 : 38); current.retired = true;}
                else {assert.equal(q.resource_kind, 3); const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && t.deviceIndex === current.index); if (current.index === 0) assert.equal(s.resets, 1); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert(s.devices.length === 3 && s.devices.every(d => d.retired)); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert(s.ended === 0 || s.ended === 1); assert.equal(s.devices.length, 3); assert(s.devices.every(d => d.retired)); assert.equal(s.textures.length, 5); assert(s.textures.every(t => t.retired)); assert.equal(s.rtBindings, 40); assert.equal(s.depthBindings, 38); assert.equal(s.resets, 1); assert.equal(frames.length, 2); assert.equal(s.copies, 2);
    const expected = ["BIND REVIVAL rounds=32 surfaces=2 publicRefs=0 activeDeviceRefs=2 queriedDeviceRefs=4 containerDeviceRefs=5 privateRetained=2", ...["FFB02010", "FF1040C0"].map((color, i) => "BIND FRAME index=" + i + " color=" + color + " samples=4 clearPublicRefs=0 resolvedToPrimary=1 presented=1 queryRefs=1"), "BIND RESET publicRefs=0 deviceRefsBefore=1 accepted=1 privateFinalized=2 callbackRefs=1 factoryRefs=1", "BIND FINAL publicRefs=0 applicationDeviceRefs=1 returnedDeviceRefs=0 privateFinalized=2 callbackRefs=1 factoryRefs=1", "BIND UNBIND publicRefs=0 privateFinalized=1 callbackRefs=2 factoryRefs=1", "BIND STATUS logicalDevices=3 reset=1 frames=2 revivals=64 privateFinalized=5 publicBindingRefs=0 factoryRefs=1", "PASS target bindings API=9"];
    assert.equal(result.logs["BND9.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perAPI: [s], ownerReleases: result.releases, frames, logicalDevices: 3, wireDeviceHandles: 4, backingTextures: 5, resets: 1, publicZeroRevivals: 64, privateObjectsFinalized: 5, renderTargetBindings: 40, depthBindings: 38, draws: 0};
}
