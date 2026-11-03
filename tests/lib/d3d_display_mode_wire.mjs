import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_display_mode_wire(bytes, result) {
    assert.equal(result.owners.length, 2);
    const states = new Map();
    for (const [index, api] of [8, 9].entries()) {
        const lines = result.logs["DSP" + api + ".TXT"].replace(/\r/g, "").trim().split("\n"); assert.equal(lines.length, 8);
        const snapshots = lines.slice(0, 6).map((line, step) => {
            const m = /^DISPLAY QUERY api=(\d) step=(\d) width=(\d+) height=(\d+) format=(\d+) refresh=(\d+) backWidth=128 backHeight=128$/.exec(line); assert(m);
            assert.equal(Number(m[1]), api); assert.equal(Number(m[2]), step);
            const snapshot = {step, width: Number(m[3]), height: Number(m[4]), format: Number(m[5]), refresh: Number(m[6])};
            assert(snapshot.width >= 640 && snapshot.height >= 480 && snapshot.refresh > 1 && [22, 23].includes(snapshot.format)); return snapshot;
        });
        for (const [step, width, height, format] of [[1, 640, 480, 22], [2, 800, 600, 22], [3, 640, 480, 23], [4, 800, 600, 23]]) { const s = snapshots[step]; assert.equal(s.width, width); assert.equal(s.height, height); assert.equal(s.format, format); }
        assert.deepEqual({...snapshots[5], step: 0}, snapshots[0]);
        assert.equal(lines[6], "DISPLAY STATUS api=" + api + " lifetimes=4 snapshots=6 unchangedBuffers=6 restored=1"); assert.equal(lines[7], "PASS live display queries");
        const owner = result.owners[index]; states.set(owner, {owner, api, snapshots, devices: [], textures: [], chains: [], active: 0, hello: 0, ended: 0});
    }
    const allowed = new Set([P.OP.HELLO, P.OP.CREATE_DEVICE, P.OP.SET_RENDER_STATE, P.OP.SET_MATERIAL, P.OP.WINDOW_STATE, P.OP.DESTROY_RESOURCE, P.OP.SESSION_END, P.OP.GUEST_LOG, P.OP.CREATE_TEXTURE_2D, P.OP.CREATE_SWAP_CHAIN, P.OP.DESTROY_SWAP_CHAIN]);
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true); assert(allowed.has(op), "display query unexpectedly emits rendering/reset traffic");
            const decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"), formats = [s.snapshots[0].format, 22, 23, s.snapshots[5].format]; assert(!s.active && s.devices.length < 4);
                assert.equal(q.width, 128); assert.equal(q.height, 128); assert.equal(q.backbuffer_format, formats[s.devices.length]); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.multisample_type, 0);
                assert(!s.devices.some(d => d.handle === q.device_handle)); s.devices.push({handle: q.device_handle, format: q.backbuffer_format, window: q.hwnd, retired: false}); s.active = q.device_handle;
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"); assert.equal(s.api, 9); assert.equal(q.device_handle, s.active); assert.equal(q.width, 96); assert.equal(q.height, 64); assert.equal(q.level_count, 1); assert.equal(q.pool, 0); assert.equal(q.usage, 1); assert.equal(q.multisample_type, 0); assert.equal(q.format, s.devices.at(-1).format);
                assert(!s.textures.some(t => t.handle === q.resource_handle)); s.textures.push({handle: q.resource_handle, device: s.active, retired: false});
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {
                const q = decode("CreateSwapChain"); assert.equal(s.api, 9); assert.equal(q.device_handle, s.active); assert.equal(q.width, 96); assert.equal(q.height, 64); assert.equal(q.hwnd, s.devices.at(-1).window);
                assert(s.textures.some(t => t.handle === q.back_buffer_handle && t.device === s.active && !t.retired)); assert(!s.chains.some(c => c.handle === q.swap_chain_handle)); s.chains.push({handle: q.swap_chain_handle, device: s.active, retired: false});
            }
            if (op === P.OP.DESTROY_SWAP_CHAIN) { const q = decode("DestroySwapChain"), c = s.chains.find(c => c.handle === q.swap_chain_handle && !c.retired); assert(c && c.device === q.device_handle && c.device === s.active); c.retired = true; }
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) { const d = s.devices.find(d => d.handle === q.resource_handle && !d.retired); assert(d && d.handle === s.active); assert(s.textures.filter(t => t.device === s.active).every(t => t.retired)); assert(s.chains.filter(c => c.device === s.active).every(c => c.retired)); d.retired = true; s.active = 0; }
                else { assert.equal(q.resource_kind, 3); const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && t.device === s.active); t.retired = true; }
            }
            if (op === P.OP.SESSION_END) { assert(!s.active); s.ended++; }
            x += length;
        }
        at += 12 + size;
    }
    for (const s of states.values()) { assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.devices.length, 4); assert(s.devices.every(d => d.retired)); assert.equal(s.textures.length, s.api === 9 ? 4 : 0); assert.equal(s.chains.length, s.api === 9 ? 4 : 0); }
    return {perAPI: [...states.values()], deviceLifetimes: 8, additionalChains: 4, backingTextures: 4, snapshots: 12, renderingCommands: 0};
}
