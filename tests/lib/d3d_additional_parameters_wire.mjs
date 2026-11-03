import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_additional_parameters_wire(bytes, result) {
    assert.equal(result.owners.length, 2);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: i + 8, device: 0, created: 0, destroyed: 0, hello: 0, ended: 0, textures: [], chains: []}]));
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "CREATE_SWAP_CHAIN", "DESTROY_SWAP_CHAIN", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected additional-parameter rendering/Reset traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(s.created++, 0); assert.equal(q.width, 128); assert.equal(q.height, 96); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert(q.device_handle); s.device = q.device_handle;}
            if (op === P.OP.CREATE_TEXTURE_2D) {const q=decode("CreateTexture2D"),i=s.textures.length;assert.equal(s.api,9);assert.equal(q.device_handle,s.device);assert.equal(q.width,[96,128][i]);assert.equal(q.height,[80,96][i]);assert.equal(q.format,22);assert.equal(q.level_count,1);assert.equal(q.pool,0);assert.equal(q.usage,1);assert.equal(q.multisample_type,0);assert(q.resource_handle&&!s.textures.some(t=>t.handle===q.resource_handle));s.textures.push({handle:q.resource_handle,retired:false});}
            if (op === P.OP.CREATE_SWAP_CHAIN) {const q=decode("CreateSwapChain"),i=s.chains.length;assert.equal(s.api,9);assert.equal(q.device_handle,s.device);assert.equal(q.width,[96,128][i]);assert.equal(q.height,[80,96][i]);assert.equal(q.back_buffer_handle,s.textures[i].handle);assert(q.swap_chain_handle&&!s.chains.some(c=>c.handle===q.swap_chain_handle));s.chains.push({handle:q.swap_chain_handle,texture:q.back_buffer_handle,retired:false});}
            if (op === P.OP.DESTROY_SWAP_CHAIN) {const q = decode("DestroySwapChain"), c = s.chains.find(c => c.handle === q.swap_chain_handle && !c.retired); assert(c); assert.equal(q.device_handle, s.device); c.retired = true;}
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {assert.equal(q.resource_handle, s.device); assert(s.chains.every(c => c.retired) && s.textures.every(t => t.retired)); s.destroyed++; s.device = 0;}
                else {assert.equal(q.resource_kind, 3); const t = s.textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && s.chains.some(c => c.texture === t.handle && c.retired)); t.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.created, 1); assert.equal(s.destroyed, 1); assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.textures.length, s.api === 9 ? 2 : 0); assert.equal(s.chains.length, s.api === 9 ? 2 : 0);
        const expected=[0,1].map(kind=>{const width=kind?128:96,height=kind?96:80;return 'ADDITIONAL PARAMETERS api='+s.api+' case='+kind+' width='+width+' height='+height+' callerWidth='+(s.api===9?width:0)+' callerHeight='+(s.api===9?height:0)+' count=1 callerNull='+kind+' cached=1';});
        expected.push('ADDITIONAL STATUS api='+s.api+' accepted=2 refused=1 implicit=128x96 unchangedFailure=1 deviceRefs=1','PASS additional parameters API='+s.api);
        assert.equal(result.logs['ACP'+s.api+'.TXT'].replace(/\r/g,'').trim(),expected.join('\n'));
    }
    return {perAPI, deviceLifetimes: 2, successfulSDKChains: 4, hostChains: 2, backingTextures: 2, refusedCounts: 2, renderingCommands: 0};
}
