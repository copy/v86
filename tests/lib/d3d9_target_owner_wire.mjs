import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_target_owner_wire(bytes, result) {
    assert.equal(result.owners.length, 1); assert.deepEqual(result.releases, result.owners);
    const s = {owner: result.owners[0], api: 9, hello: 0, ended: 0, devices: [], resources: [], chains: [], bindings: []}, handles = new Set();
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "CREATE_TEXTURE_CUBE", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), s.owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected target-owner rendering/depth/Reset traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"), index = s.devices.length; assert(index < 2); assert(q.device_handle && !handles.has(q.device_handle)); handles.add(q.device_handle); s.devices.push({index, handle: q.device_handle, retired: false});
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);
            }
            if (op === P.OP.CREATE_TEXTURE_2D || op === P.OP.CREATE_TEXTURE_CUBE) {
                const cube = op === P.OP.CREATE_TEXTURE_CUBE, q = decode(cube ? "CreateTextureCube" : "CreateTexture2D"), i = s.resources.length, d = s.devices[i < 5 ? 1 : 0];
                assert(i < 7 && d && !d.retired); assert.equal(cube, i === 2 || i === 6); assert.equal(q.device_handle, d.handle); assert(q.resource_handle && !handles.has(q.resource_handle)); handles.add(q.resource_handle);
                assert.equal(q.usage, i === 4 ? 2 : 1); assert.equal(q.format, i === 4 ? 75 : 22); assert.equal(q.pool, 0); assert.equal(q.level_count, 1);
                if (cube) {assert.equal(q.edge_length, 32); assert.equal(q.reserved, 0);} else {assert.equal(q.width, i === 4 ? 64 : 32); assert.equal(q.height, i === 4 ? 64 : 24); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);}
                assert(s.resources.every(r => r.retired)); s.resources.push({handle: q.resource_handle, device: d.handle, kind: cube ? 4 : 3, retired: false});
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {
                const q = decode("CreateSwapChain"); assert.equal(s.resources.length, 4); assert.equal(s.chains.length, 0); assert.equal(q.device_handle, s.devices[1].handle); assert.equal(q.back_buffer_handle, s.resources[3].handle); assert.equal(q.width, 32); assert.equal(q.height, 24); assert(q.swap_chain_handle && !handles.has(q.swap_chain_handle)); handles.add(q.swap_chain_handle); s.chains.push({handle: q.swap_chain_handle, retired: false});
            }
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"); assert.equal(q.device_handle, s.devices[1].handle); assert.equal(q.swap_chain_handle, s.chains[0].handle); assert(!s.chains[0].retired && !s.resources[3].retired); s.chains[0].retired = true;}
            if (op === P.OP.SET_RENDER_TARGET) {
                const q = decode("SetRenderTarget"), index = s.bindings.length, wanted = [[0,5,0], [0,5,0], [0,-1,0], [3,6,5], [3,-1,0]][index]; assert(wanted); assert(!s.devices[0].retired && s.devices[1].retired);
                assert.equal(q.device_handle, s.devices[0].handle); assert.equal(q.target_index, wanted[0]); assert.equal(q.color_texture_handle, wanted[1] < 0 ? 0 : s.resources[wanted[1]].handle); assert.equal(q.color_level, 0); assert.equal(q.color_face, wanted[2]);
                if (wanted[1] >= 0) {assert.equal(s.resources[wanted[1]].device, q.device_handle); assert(!s.resources[wanted[1]].retired);}
                s.bindings.push({slot: q.target_index, resource: q.color_texture_handle, face: q.color_face});
            }
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {const d = s.devices.find(d => d.handle === q.resource_handle && !d.retired); assert(d); assert(s.resources.filter(r => r.device === d.handle).every(r => r.retired)); assert(s.chains.length === 1 && s.chains[0].retired); if (d.index === 1) {assert.equal(s.resources.length, 5); assert.equal(s.bindings.length, 0);} else {assert.equal(s.resources.length, 7); assert.equal(s.bindings.length, 5);} d.retired = true;}
                else {const r = s.resources.find(r => r.handle === q.resource_handle && !r.retired); assert(r); assert.equal(q.resource_kind, r.kind); if (r === s.resources[3]) assert(s.chains[0].retired); if (r === s.resources[5]) assert.equal(s.bindings.length, 3); if (r === s.resources[6]) assert.equal(s.bindings.length, 5); r.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert(s.devices.length === 2 && s.devices.every(d => d.retired)); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert(s.ended === 0 || s.ended === 1); assert.equal(s.devices.length, 2); assert(s.devices.every(d => d.retired)); assert.equal(s.resources.length, 7); assert(s.resources.every(r => r.retired)); assert.equal(s.bindings.length, 5); assert.equal(s.chains.length, 1); assert(s.chains[0].retired);
    const expected = Array.from({length: 8}, (_, i) => "OWNER FOREIGN kind=" + i + " rounds=8 slots=4 refused=32 referencesUnchanged=1 stateUnchanged=1 sourceDeviceRefs=1");
    expected.push("OWNER STATUS foreignProfiles=8 refused=256 rounds=8 slots=4 localBindings=5 viewportScissorControls=1 allResourcesReleased=1", "PASS target owners API=9");
    assert.equal(result.logs["OWN9.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perAPI: [s], ownerReleases: result.releases, deviceLifetimes: 2, foreignProfiles: 8, refusedForeignBindings: 256, localBindings: 5, textureObjects: 7, additionalChains: 1, drawOrPresentOrResetCommands: 0};
}
