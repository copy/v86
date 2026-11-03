import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const widths = [128, 96, 80], heights = [128, 64, 96], targets = [1, 2, 0, 1, 2, 0, 0], colors = [0xffc02010, 0xff1030c0, 0xff208040, 0xffe06020, 0xff1030c0, 0xff208040, 0xff208040];
export function inspect_independent_chains_wire(bytes, result) {
    assert.equal(result.owners.length, 2);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: i + 8, device: 0, handles: [], textures: [], chains: [], target: 0, clearColors: [0, 0, 0], clears: 0, presents: 0, resets: 0, destroyed: 0, hello: 0, ended: 0}])), frames = [];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_TARGET", "SET_DEPTH_STENCIL_SURFACE_LEVEL", "SET_SCISSOR_RECT", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "CLEAR", "PRESENT", "PRESENT_SWAP_CHAIN", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected independent-chain command: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                if (reset) {assert.equal(q.old_device_handle, s.device); assert.equal(s.presents, 7); assert(s.textures.every(t => t.retired)); assert(s.chains.every(c => c.retired)); s.resets++;}
                else assert.equal(s.handles.length, 0);
                assert.equal(q.width, 128); assert.equal(q.height, 128); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.multisample_type, 0);
                const handle = reset ? q.new_device_handle : q.device_handle; assert(handle && !s.handles.includes(handle)); s.handles.push(handle); s.device = handle;
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"), index = s.textures.length + 1; assert(index <= 2); assert.equal(q.device_handle, s.device); assert(q.resource_handle && !s.textures.some(t => t.handle === q.resource_handle));
                assert.equal(q.width, widths[index]); assert.equal(q.height, heights[index]); assert.equal(q.format, 22); assert.equal(q.usage, 1); assert.equal(q.pool, 0); assert.equal(q.level_count, 1); assert.equal(q.multisample_type, s.api === 8 && index === 2 ? 4 : 0);
                s.textures.push({handle: q.resource_handle, width: q.width, height: q.height, samples: q.multisample_type, retired: false});
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {
                const q = decode("CreateSwapChain"), index = s.chains.length; assert(index < 2); assert.equal(q.device_handle, s.device); assert.equal(q.back_buffer_handle, s.textures[index].handle); assert(q.swap_chain_handle && !s.chains.some(c => c.handle === q.swap_chain_handle)); assert(q.hwnd);
                assert.equal(q.width, widths[index + 1]); assert.equal(q.height, heights[index + 1]); s.chains.push({handle: q.swap_chain_handle, texture: q.back_buffer_handle, hwnd: q.hwnd, x: q.x, y: q.y, retired: false});
            }
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(q.device_handle, s.device); assert.equal(q.target_index, 0); assert.equal(q.color_level, 0); assert.equal(q.color_face, 0); const index = q.color_texture_handle ? s.textures.findIndex(t => t.handle === q.color_texture_handle && !t.retired) + 1 : 0; assert(!q.color_texture_handle || index); s.target = index;}
            if (op === P.OP.CLEAR) {
                const q = decode("Clear"), expected = [[1, 0xffc02010], [2, 0xff1030c0], [0, 0xff208040], [1, 0xffe06020], [1, 0xffd0d020]][s.clears++];
                assert(expected); assert.equal(q.device_handle, s.device); assert.equal(q.clear_flags, 1); assert.equal(q.rect_count, 0); assert.equal(s.target, expected[0]); assert.equal(q.color, expected[1]);
                if (s.clears === 5) {assert(s.chains[0].retired); assert(!s.textures[0].retired); assert.equal(s.presents, 6);}
                s.clearColors[s.target] = q.color;
            }
            if (op === P.OP.PRESENT || op === P.OP.PRESENT_SWAP_CHAIN) {
                const step = s.presents++, target = targets[step], q = decode(op === P.OP.PRESENT ? "Present" : "PresentSwapChain"); assert(step < 7); assert.equal(q.device_handle, s.device); assert.equal(op, target ? P.OP.PRESENT_SWAP_CHAIN : P.OP.PRESENT); assert.equal(q.width, widths[target]); assert.equal(q.height, heights[target]); assert.equal(s.clearColors[target], colors[step]);
                if (target) {assert.equal(q.reserved, 0); const chain = s.chains[target - 1]; assert(!chain.retired); assert.equal(q.swap_chain_handle, chain.handle); assert.equal(q.hwnd, chain.hwnd); assert.equal(q.x, chain.x); assert.equal(q.y, chain.y);}
                if (step === 6) {assert(s.chains[0].retired && s.textures[0].retired); assert(!s.chains[1].retired && !s.textures[1].retired);}
                frames.push({owner: s.owner, api: s.api, step, target, device: s.device, chain: target ? s.chains[target - 1].handle : 0, texture: target ? s.textures[target - 1].handle : 0, width: widths[target], height: heights[target], color: colors[step]});
            }
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"), index = s.chains.findIndex(c => c.handle === q.swap_chain_handle), chain = s.chains[index]; assert.equal(q.device_handle, s.device); assert(chain && !chain.retired && !s.textures[index].retired); assert.equal(s.presents, index ? 7 : 6); chain.retired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (q.resource_kind === 0) {assert.equal(q.resource_handle, s.device); assert.equal(s.resets, 1); assert.equal(s.presents, 7); s.destroyed++; s.device = 0;}
                else {const index = s.textures.findIndex(t => t.handle === q.resource_handle), t = s.textures[index]; assert(t && !t.retired); assert(s.chains[index].retired); assert.equal(s.presents, index ? 7 : 6); assert.equal(q.resource_kind, 3); assert.equal(s.target, index ? 0 : 1); if (!index) assert.equal(s.clearColors[1], 0xffd0d020); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.handles.length, 2); assert.equal(s.destroyed, 1); assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.resets, 1); assert.equal(s.presents, 7); assert.equal(s.clears, 5); assert.equal(s.textures.length, 2); assert.equal(s.chains.length, 2); assert(s.textures.every(t => t.retired) && s.chains.every(c => c.retired));
        const expected = ["CHAIN BUFFER api=" + s.api + " index=0 width=96 height=64 samples=0 cached=1", "CHAIN BUFFER api=" + s.api + " index=1 width=80 height=96 samples=" + (s.api === 8 ? 4 : 0) + " cached=1", ...targets.map((target, step) => "CHAIN FRAME api=" + s.api + " step=" + step + " target=" + target + " color=" + colors[step].toString(16).toUpperCase()), "CHAIN LIFETIME api=" + s.api + " cached=1 isolatedPrivate=1 chainReleasedFirst=1 bindingRetained=1 privateFinalized=1 resetRecovered=1", "PASS independent chains API=" + s.api];
        assert.equal(result.logs["IND" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, frames, deviceLifetimes: 2, resets: 2, textures: 4, chains: 4, chainPresents: 8, primaryPresents: 6};
}
