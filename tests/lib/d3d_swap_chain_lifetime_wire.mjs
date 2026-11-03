import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_swap_chain_lifetime_wire(bytes, result) {
    assert.equal(result.owners.length, 1);
    const s = {owner: result.owners[0], active: 0, devices: [], textures: [], chains: [], hello: 0, ended: 0};
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(name => P.OP[name]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8);
        assert.equal(bytes.readUInt32LE(at), s.owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true);
            assert(allowed.has(op), "unexpected Reset/rendering traffic: " + op);
            const decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"); assert.equal(s.active, 0); assert(s.devices.length < 3);
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1);
                assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0);
                assert(q.device_handle && !s.devices.some(d => d.handle === q.device_handle)); s.active = q.device_handle; s.devices.push({handle: s.active, retired: false});
            }
            if (op === P.OP.CREATE_TEXTURE_2D) {
                const q = decode("CreateTexture2D"); assert.equal(q.device_handle, s.active); assert.equal(q.width, 96); assert.equal(q.height, 64);
                assert.equal(q.format, 22); assert.equal(q.level_count, 1); assert.equal(q.pool, 0); assert.equal(q.usage, 1); assert.equal(q.multisample_type, 0);
                assert(q.resource_handle && !s.textures.some(t => t.handle === q.resource_handle)); s.textures.push({handle: q.resource_handle, device: s.active, retired: false});
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {
                const q = decode("CreateSwapChain"); assert.equal(q.device_handle, s.active); assert.equal(q.width, 96); assert.equal(q.height, 64);
                const texture = s.textures.find(t => t.handle === q.back_buffer_handle && !t.retired); assert(texture && texture.device === s.active);
                assert(q.swap_chain_handle && !s.chains.some(c => c.handle === q.swap_chain_handle)); s.chains.push({handle: q.swap_chain_handle, device: s.active, texture: texture.handle, retired: false});
            }
            if (op === P.OP.DESTROY_SWAP_CHAIN) {
                const q = decode("DestroySwapChain"), c = s.chains.find(c => c.handle === q.swap_chain_handle && !c.retired); assert(c && c.device === q.device_handle && c.device === s.active); c.retired = true;
            }
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {
                    const d = s.devices.find(d => d.handle === q.resource_handle && !d.retired); assert(d && d.handle === s.active);
                    assert(s.textures.filter(t => t.device === s.active).every(t => t.retired)); assert(s.chains.filter(c => c.device === s.active).every(c => c.retired)); d.retired = true; s.active = 0;
                } else {
                    assert.equal(q.resource_kind, 3); const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && t.device === s.active);
                    assert(s.chains.some(c => c.texture === t.handle && c.retired)); t.retired = true;
                }
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.active, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.devices.length, 3); assert.equal(s.textures.length, 4); assert.equal(s.chains.length, 4);
    for (const [i, d] of s.devices.entries()) {assert(d.retired); assert.equal(s.chains.filter(c => c.device === d.handle).length, [3, 0, 1][i]);}
    assert(s.textures.every(t => t.retired) && s.chains.every(c => c.retired));
    assert.equal(result.logs["CHN9.TXT"].replace(/\r/g, "").trim(), ["CHAIN PIN index=1 stable=1 retired=1", "CHAIN PIN index=0 stable=1 retired=1", "CHAIN PIN index=2 stable=1 retired=1", "SWAPCHAIN LIFETIME api=9 implicitCycles=32 additional=4 deviceLifetimes=3 zeroRelease=64 revivals=32 devicePinDeltas=0 lastOwners=2 factoryFinal=1", "PASS swap-chain lifetime API=9"].join("\n"));
    return {perOwner: s, deviceLifetimes: 3, additionalChains: 4, backingTextures: 4, renderingCommands: 0};
}
