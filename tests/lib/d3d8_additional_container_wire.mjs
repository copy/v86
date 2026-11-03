import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_additional_container_wire(bytes, result) {
    assert.equal(result.owners.length, 1);
    const owner = result.owners[0], s = {owner, api: 8, device: 0, created: 0, destroyed: 0, hello: 0, ended: 0, textures: [], chains: []};
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "CREATE_TEXTURE_CUBE", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected container rendering/Reset traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(s.created++, 0); assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 0); assert.equal(q.multisample_type, 0); assert(q.device_handle); s.device = q.device_handle;}
            if (op === P.OP.CREATE_TEXTURE_2D || op === P.OP.CREATE_TEXTURE_CUBE) {
                const cube = op === P.OP.CREATE_TEXTURE_CUBE, q = decode(cube ? "CreateTextureCube" : "CreateTexture2D"), index = s.textures.length; assert(index < 3); assert.equal(cube, index === 2); assert.equal(q.device_handle, s.device); assert(q.resource_handle && !s.textures.some(t => t.handle === q.resource_handle));
                assert.equal(q.format, index ? 21 : 22); assert.equal(q.level_count, 1); assert.equal(q.pool, index ? 1 : 0); assert.equal(q.usage, index ? 0 : 1);
                if (index) {assert(s.textures[index - 1].retired); assert(s.chains[0].retired);}
                if (cube) assert.equal(q.edge_length, 4);
                else {assert.equal(q.width, index ? 4 : 32); assert.equal(q.height, index ? 4 : 24); assert.equal(q.multisample_type, 0);}
                s.textures.push({handle: q.resource_handle, kind: cube ? 4 : 3, retired: false});
            }
            if (op === P.OP.CREATE_SWAP_CHAIN) {const q = decode("CreateSwapChain"); assert.equal(s.textures.length, 1); assert.equal(q.device_handle, s.device); assert.equal(q.width, 32); assert.equal(q.height, 24); assert.equal(q.back_buffer_handle, s.textures[0].handle); assert(q.swap_chain_handle && !s.chains.length); s.chains.push({handle: q.swap_chain_handle, retired: false});}
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"); assert.equal(q.device_handle, s.device); assert.equal(q.swap_chain_handle, s.chains[0].handle); assert(!s.chains[0].retired && !s.textures[0].retired); s.chains[0].retired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {assert.equal(q.resource_handle, s.device); assert.equal(s.textures.length, 3); assert(s.textures.every(t => t.retired) && s.chains[0].retired); s.destroyed++; s.device = 0;}
                else {const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && s.chains[0].retired); assert.equal(q.resource_kind, t.kind); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.created, 1); assert.equal(s.destroyed, 1); assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.chains.length, 1); assert.equal(s.textures.length, 3); assert(s.chains[0].retired && s.textures.every(t => t.retired));
    const expected = [0, 1, 2].map(phase => "CONTAINER8 phase=" + phase + " device=2 refused=7 null=1 exactRef=1");
    expected.push("CONTAINER8 TEXTURE kinds=2 valid=2 rejectedDevice=2 exactRef=1", "CONTAINER8 LIFETIME cached=1 chainReleasedFirst=1 privateRetained=1 deviceRefs=0 factoryRefs=0", "PASS additional container API=8");
    assert.equal(result.logs["CNT8.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perAPI: [s], deviceLifetimes: 1, hostChains: 1, textureObjects: 3, deviceContainerQueries: 6, refusedContainerIIDs: 21, nullContainerOutputs: 3, ordinaryTextureContainerQueries: 2, renderingCommands: 0};
}
