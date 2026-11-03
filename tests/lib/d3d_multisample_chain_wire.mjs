import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_multisample_chain_wire(bytes, result) {
    assert.equal(result.owners.length, 2); assert.equal(new Set(result.owners).size, 2); assert.deepEqual(result.releases, result.owners);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: i + 8, device: 0, handles: [], texture: 0, chain: 0, target: 0, chainRetired: false, textureRetired: false, hello: 0, ended: 0, bindings: 0, clears: 0, presents: 0, resets: 0, destroyed: 0}])), frames = [], colors = [0xffb02010, 0xff1040c0];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "SET_SCISSOR_RECT", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "CLEAR", "PRESENT_SWAP_CHAIN", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected chain revival command: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.multisample_type, 0);
                if (reset) {assert.equal(q.old_device_handle, s.device); assert.equal(s.presents, 2); assert.equal(s.clears, 2); assert(!s.chainRetired && !s.textureRetired); assert.equal(s.resets++, 0);}
                else assert.equal(s.handles.length, 0);
                const handle = reset ? q.new_device_handle : q.device_handle; assert(handle && !s.handles.includes(handle)); s.handles.push(handle); s.device = handle;
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"); assert.equal(q.device_handle, s.device); assert(!s.texture && q.resource_handle && !s.handles.includes(q.resource_handle)); s.texture = q.resource_handle;
                assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.format, 22); assert.equal(q.usage, 1); assert.equal(q.pool, 0); assert.equal(q.level_count, 1); assert.equal(q.multisample_type, 4);
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {
                const q = decode("CreateSwapChain"); assert.equal(q.device_handle, s.device); assert(!s.chain && q.swap_chain_handle && q.swap_chain_handle !== s.texture); s.chain = q.swap_chain_handle;
                assert.equal(q.back_buffer_handle, s.texture); assert.equal(q.width, 32); assert.equal(q.height, 24); assert(q.hwnd); s.hwnd = q.hwnd; s.x = q.x; s.y = q.y;
            }
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(q.device_handle, s.device); assert.equal(q.target_index, 0); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0); assert.equal(q.color_texture_handle, s.texture); assert.equal(s.bindings++, 0); s.target = s.texture;}
            if (op === P.OP.CLEAR) {const q = decode("Clear"), step = s.clears++; assert(step < 2); assert.equal(s.presents, step); assert.equal(q.device_handle, s.device); assert.equal(s.target, s.texture); assert(!s.chainRetired && !s.textureRetired); assert.equal(q.clear_flags, 1); assert.equal(q.rect_count, 0); assert.equal(q.color, colors[step]);}
            if (op === P.OP.PRESENT_SWAP_CHAIN) {
                const q = decode("PresentSwapChain"), step = s.presents++; assert(step < 2); assert.equal(s.clears, step + 1); assert(!s.chainRetired && !s.textureRetired); assert.equal(q.device_handle, s.device); assert.equal(q.swap_chain_handle, s.chain); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.hwnd, s.hwnd); assert.equal(q.x, s.x); assert.equal(q.y, s.y); assert.equal(q.reserved, 0);
                frames.push({owner: s.owner, api: s.api, step, device: s.device, texture: s.texture, chain: s.chain, width: 32, height: 24, color: colors[step]});
            }
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"); assert.equal(q.device_handle, s.device); assert.equal(q.swap_chain_handle, s.chain); assert.equal(s.resets, 1); assert.equal(s.presents, 2); assert(!s.chainRetired && !s.textureRetired); s.chainRetired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource"); assert.equal(s.resets, 1); assert.equal(s.presents, 2);
                if (q.resource_kind === 0) {assert.equal(q.resource_handle, s.device); assert(s.chainRetired && s.textureRetired); assert.equal(s.destroyed++, 0); s.device = 0;}
                else {assert.equal(q.resource_kind, 3); assert.equal(q.resource_handle, s.texture); assert(s.chainRetired && !s.textureRetired); s.textureRetired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.device, 0); assert.equal(s.handles.length, 2); assert.equal(s.hello, 1); assert.equal(s.bindings, 1); assert.equal(s.clears, 2); assert.equal(s.presents, 2); assert.equal(s.resets, 1); assert.equal(s.destroyed, 1); assert(s.chainRetired && s.textureRetired);
        const expected = ["MSCHAIN CAPS api=" + s.api + " samples=4 available=1" + (s.api === 9 ? " levels=1" : ""), "MSCHAIN BUFFER api=" + s.api + " width=32 height=24 samples=" + (4), "MSCHAIN FRAME api=" + s.api + " step=0 color=FFB02010", "MSCHAIN COUNTERS api=" + s.api + " cycles=32 independent=1 cached=1 privateRetained=1", "MSCHAIN FRAME api=" + s.api + " step=1 color=FF1040C0", "MSCHAIN CLEANUP api=" + s.api + " bindingRetained=1 reset=1 privateFinalized=1 deviceRefs=1", "PASS multisample chains API=" + s.api];
        assert.equal(result.logs["MSC" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, frames, ownerReleases: result.releases, deviceLifetimes: 2, resets: 2, chains: 2, textures: 2, chainPresents: 4, revivalCycles: 64, privateObjectsFinalized: 2};
}
