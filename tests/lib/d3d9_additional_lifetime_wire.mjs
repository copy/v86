import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_additional_lifetime_wire(bytes, result) {
    assert.equal(result.owners.length, 1);
    const owner = result.owners[0], s = {owner, api: 9, device: 0, hello: 0, ended: 0, cases: []}, handles = new Set(); let current;
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected lifetime rendering command: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.multisample_type, 0);
                if (reset) {
                    assert.equal(q.old_device_handle, s.device); assert.equal(current.resets++, 0); assert.notEqual(current.index, 1); assert.equal(current.chainRetired, current.index === 0); assert.equal(current.textureRetired, current.index === 0); assert.equal(current.targets, current.index === 2 ? 1 : 0);
                } else {assert.equal(s.device, 0); const index = s.cases.length; assert(index < 3); current = {index, handles: [], texture: 0, chain: 0, textureRetired: false, chainRetired: false, resets: 0, targets: 0, destroyed: 0}; s.cases.push(current);}
                const handle = reset ? q.new_device_handle : q.device_handle; assert(handle && !handles.has(handle)); handles.add(handle); current.handles.push(handle); s.device = handle;
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"); assert.equal(q.device_handle, s.device); assert(!current.texture); assert(q.resource_handle && !handles.has(q.resource_handle)); handles.add(q.resource_handle); current.texture = q.resource_handle;
                assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.format, 22); assert.equal(q.level_count, 1); assert.equal(q.usage, 1); assert.equal(q.pool, 0); assert.equal(q.multisample_type, 0);
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {const q = decode("CreateSwapChain"); assert.equal(q.device_handle, s.device); assert(!current.chain && current.texture); assert(q.swap_chain_handle && !handles.has(q.swap_chain_handle)); handles.add(q.swap_chain_handle); current.chain = q.swap_chain_handle; assert.equal(q.back_buffer_handle, current.texture); assert.equal(q.width, 32); assert.equal(q.height, 24);}
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(current.index, 2); assert.equal(q.device_handle, s.device); assert.equal(q.color_texture_handle, current.texture); assert.equal(q.target_index, 0); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0); assert.equal(current.targets++, 0);}
            if (op === P.OP.SET_VIEWPORT) {const q = decode("SetViewport"); assert.equal(q.device_handle, s.device); const bound = current.index === 2 && !current.resets; assert.equal(q.width, bound ? 32 : 64); assert.equal(q.height, bound ? 24 : 64);}
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"); assert.equal(q.device_handle, s.device); assert.equal(q.swap_chain_handle, current.chain); assert(!current.chainRetired && !current.textureRetired); assert.equal(current.resets, current.index === 2 ? 1 : 0); current.chainRetired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {assert.equal(q.resource_handle, s.device); assert(current.chainRetired && current.textureRetired); assert.equal(current.resets, current.index === 1 ? 0 : 1); assert.equal(current.targets, current.index === 2 ? 1 : 0); assert.equal(current.destroyed++, 0); s.device = 0;}
                else {assert.equal(q.resource_kind, 3); assert.equal(q.resource_handle, current.texture); assert(current.chainRetired && !current.textureRetired); assert.equal(current.resets, current.index === 2 ? 1 : 0); current.textureRetired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert.equal(s.ended, 0); assert.deepEqual(result.releases, [owner]); assert.equal(s.cases.length, 3); assert(s.cases.every(c => c.destroyed === 1 && c.textureRetired && c.chainRetired));
    const expected = ["REF9 case=0 cycles=32 publicZero=1 devicePin=1 failedReset=1 recoveredReset=1 privateFinalized=1", "REF9 case=1 deviceFirst=1 chainFirst=1 chainRevivals=32 chainContainer=1 lastViewDevice=0 privateFinalized=1", "REF9 case=2 bindingOnly=1 reset=1 privateFinalized=1 deviceRefs=0", "PASS additional lifetime API=9"];
    assert.equal(result.logs["REF9.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perAPI: [s], ownerReleases: result.releases, deviceLifetimes: 3, resets: 2, chains: 3, textures: 3, renderTargetBindings: 1, cachedRevivalCycles: 32, chainContainerRevivalCycles: 32, refusedResetCalls: 1, privateObjectsFinalized: 3, drawOrPresentCommands: 0};
}
