import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_swap_effect_wire(bytes, result) {
    assert.equal(result.owners.length, 2); assert.equal(new Set(result.owners).size, 2); assert.deepEqual(result.releases, result.owners);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: i + 8, device: 0, temporary: 0, devices: [], hello: 0, ended: 0, resets: 0, textures: [], chains: []}]));
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    const allHandles = new Map(result.owners.map(owner => [owner, new Set()]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet), handles = allHandles.get(s.owner); W.checkStream(h.view, h.end, h.commandCount);
        function newHandle(value) {assert(value && !handles.has(value)); handles.add(value); return value;}
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected swap-effect rendering/Present traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0); assert(!s.temporary);
                if (reset) {assert.equal(q.old_device_handle, s.device); assert(s.chains.every(c => c.retired) && s.textures.every(t => t.retired)); s.device = newHandle(q.new_device_handle); s.devices[0].handles.push(s.device); s.resets++; assert(s.resets <= 10);}
                else {const device = {handles: [newHandle(q.device_handle)], retired: false}; s.devices.push(device); assert(s.devices.length <= (s.api === 8 ? 5 : 4)); if (s.devices.length === 1) s.device = q.device_handle; else s.temporary = q.device_handle;}
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {const q = decode("CreateTexture2D"); assert(!s.temporary && s.device); assert.equal(q.device_handle, s.device); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.format, 22); assert.equal(q.usage, 1); assert.equal(q.pool, 0); assert.equal(q.level_count, 1); assert.equal(q.multisample_type, 0); s.textures.push({handle: newHandle(q.resource_handle), retired: false}); assert(s.textures.length <= (s.api === 8 ? 4 : 3));}
            if (op === P.OP.CREATE_SWAP_CHAIN) {const q = decode("CreateSwapChain"), t = s.textures[s.chains.length]; assert(t && !t.retired); assert.equal(q.device_handle, s.device); assert.equal(q.back_buffer_handle, t.handle); assert.equal(q.width, 32); assert.equal(q.height, 24); assert(q.hwnd); s.chains.push({handle: newHandle(q.swap_chain_handle), texture: t.handle, retired: false});}
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"), c = s.chains.find(c => c.handle === q.swap_chain_handle && !c.retired); assert.equal(q.device_handle, s.device); assert(c); c.retired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (q.resource_kind === 0) {
                    const d = s.devices.find(d => d.handles.includes(q.resource_handle) && !d.retired); assert(d);
                    if (q.resource_handle === s.temporary) s.temporary = 0;
                    else {assert.equal(q.resource_handle, s.device); assert.equal(s.resets, 10); assert(s.chains.every(c => c.retired) && s.textures.every(t => t.retired)); assert(s.devices.slice(1).every(d => d.retired)); s.device = 0;}
                    d.retired = true;
                } else {assert.equal(q.resource_kind, 3); const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && s.chains.some(c => c.texture === t.handle && c.retired)); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); assert.equal(s.temporary, 0); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        const count = s.api === 8 ? 4 : 3, bad = [[0, 1], [5, 1], [0xffffffff, 1], [3, 2], [3, 3], [4, 2], ...(s.api === 9 ? [[4, 1]] : [])];
        assert.equal(s.hello, 1); assert(s.ended === 0 || s.ended === 1); assert.equal(s.resets, 10); assert.equal(s.device, 0); assert.equal(s.temporary, 0); assert.equal(s.devices.length, count + 1); assert.equal(s.devices[0].handles.length, 11); assert(s.devices.every(d => d.retired)); assert.equal(s.textures.length, count); assert.equal(s.chains.length, count); assert(s.textures.every(t => t.retired) && s.chains.every(c => c.retired));
        const expected = Array.from({length: count}, (_, i) => "SWAP ACCEPT api=" + s.api + " effect=" + (i + 1) + " count=1 constructor=1 reset=1 additional=1 cached=1");
        expected.push(...bad.map(([effect, count]) => "SWAP REFUSE api=" + s.api + " effect=" + effect + " count=" + count + " routes=3 unchanged=1 nullOutputs=1 resetLost=1 recovered=1"), "SWAP STATUS api=" + s.api + " accepted=" + count * 3 + " refused=" + bad.length * 3 + " successfulResets=10 cached=1 deviceRefs=1 factoryRefs=2", "PASS swap-effect validation API=" + s.api);
        assert.equal(result.logs["SFX" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, ownerReleases: result.releases, deviceLifetimes: 9, successfulResets: 20, chains: 7, textures: 7, acceptedMatrixCalls: 21, refusedMatrixCalls: 39, refusedResets: 13, failedPresentsWithoutCommands: 13, drawOrPresentCommands: 0};
}
