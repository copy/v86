import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function legacy_default_scenes() {
    return [1, 2, 3, 7].flatMap(api => [128, api < 7 ? 64 : 255, 64, 128].map((alpha, index) => ({api, index, alpha, alphaOp: index === 1 ? api < 7 ? 3 : 2 : index === 2 ? 3 : 2, pixels: Array(64).fill(((alpha << 24) | 0x804020) >>> 0)})));
}
export function inspect_legacy_defaults_wire(bytes, result) {
    assert.equal(result.owners.length, 1); assert.deepEqual(result.releases, result.owners);
    const owner = result.owners[0], scenes = legacy_default_scenes(), textures = [], frames = [], render = {}, stage = {}, bindings = {}, uploads = [], draws = [];
    let device = 0, created = 0, destroyed = 0, target = 0, ended = 0, hello = 0, displayModes = 0;
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length); assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.HELLO) assert.equal(hello++, 0);
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(created++, 0); assert(q.device_handle && q.hwnd); assert.equal(q.width, 800); assert.equal(q.height, 600); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.multisample_type, 0); device = q.device_handle;}
            if (op === P.OP.DD_SET_DISPLAY_MODE) {const q = decode("DDSetDisplayMode"); assert.equal(displayModes++, 0); assert.equal(q.device_handle, device); assert.equal(q.bits_per_pixel, 32); assert.equal(q.refresh_rate, 60);}
            if (op === P.OP.CREATE_TEXTURE_2D) {const q = decode("CreateTexture2D"), index = textures.length; assert(index < 12); assert.equal(q.device_handle, device); assert(q.resource_handle && !textures.some(t => t.handle === q.resource_handle)); assert.equal(q.width, index % 3 ? 1 : 8); assert.equal(q.height, q.width); assert.equal(q.level_count, 1); assert.equal(q.format, index % 3 === 2 ? 22 : 21); assert.equal(q.pool, 0); assert.equal(q.multisample_type, 0); textures.push({index, handle: q.resource_handle, retired: false, usage: q.usage});}
            if (op === P.OP.UPDATE_TEXTURE) {const q = decode("UpdateTexture"), t = textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t && t.index % 3); assert.equal(q.width, 1); assert.equal(q.height, 1); assert.equal(q.level, 0); assert.equal(q.row_pitch, 4); assert.equal(q.data_bytes, 4); assert(q.data_offset + 4 <= packet.length); assert.equal(packet.readUInt32LE(q.data_offset), t.index % 3 === 1 ? 0x80804020 : 0x00804020); uploads.push(t.index);}
            if (op === P.OP.SET_RENDER_STATE) {const q = decode("SetRenderState"); assert.equal(q.device_handle, device); assert.notEqual(q.state, 21, "obsolete blend state leaked to host"); render[q.state] = q.value;}
            if (op === P.OP.SET_TEXTURE_STAGE_STATE) {const q = decode("SetTextureStageState"); assert.equal(q.device_handle, device); stage[q.stage + ":" + q.state] = q.value;}
            if (op === P.OP.SET_TEXTURE) {const q = decode("SetTexture"); assert.equal(q.device_handle, device); bindings[q.stage] = q.texture_handle;}
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(q.device_handle, device); target = q.color_texture_handle;}
            if (op === P.OP.DRAW_PRIMITIVE_UP) {
                const q = decode("DrawPrimitiveUP"), scene = scenes[draws.length]; assert(scene); const group = Math.floor(draws.length / 4), rt = textures[group * 3], texture = textures[group * 3 + (scene.index === 1 ? 2 : 1)];
                assert.equal(q.device_handle, device); assert.equal(target, rt.handle); assert(!rt.retired && !texture.retired); assert.equal(bindings[0], texture.handle); assert.equal(stage["0:1"], 4); assert.equal(stage["0:4"], scene.alphaOp); assert.equal(stage["0:5"], 2); assert.equal(stage["0:6"], 1); assert.equal(render[41], scene.api === 1 ? 1 : 0); assert.equal(render[29], scene.api === 2 ? 1 : 0); assert.equal(render[143], scene.api < 7 ? 1 : 0);
                assert.equal(q.primitive_count, 2); assert(q.vertex_count >= 4); assert(q.stride >= 28); assert.equal(q.vertex_bytes, q.stride * q.vertex_count); assert(q.vertex_data_offset + q.vertex_bytes <= packet.length);
                for (let v = 0; v < q.vertex_count; v++) assert.equal(packet.readUInt32LE(q.vertex_data_offset + v * q.stride + 16), 0x40ffffff);
                draws.push({group, target: rt.handle, texture: texture.handle, ...scene});
            }
            if (op === P.OP.READBACK_SURFACE) {
                const q = decode("ReadbackSurface"), scene = scenes[frames.length], draw = draws[frames.length]; assert(scene && draw); assert.equal(draws.length, frames.length + 1); assert.equal(q.device_handle, device); assert.equal(q.texture_handle, draw.target); assert.equal(q.format, 21); assert.equal(q.width, 8); assert.equal(q.height, 8); assert.equal(q.level, 0); assert.equal(q.face, 0); assert.equal(q.first_row, 0); assert.equal(q.row_count, 8); assert.equal(q.destination_pitch, 32); assert.equal(q.destination_bytes, 256); assert.equal(q.response_offset, P.C.D9WG_READBACK_REGION_OFFSET); assert.equal(q.request_id, frames.length + 1); frames.push({owner, device, texture: q.texture_handle, request: q.request_id, width: 8, height: 8, ...scene});
            }
            if (op === P.OP.DESTROY_RESOURCE) {const q = decode("DestroyResource"); if (q.resource_kind === 0) {assert.equal(q.resource_handle, device); assert.equal(frames.length, 16); assert(textures.every(t => t.retired)); assert.equal(destroyed++, 0); device = 0;} else {assert.equal(q.resource_kind, 3); const t = textures.find(t => t.handle === q.resource_handle && !t.retired); assert(t); assert.equal(frames.length, (Math.floor(t.index / 3) + 1) * 4); t.retired = true;}}
            assert(op !== P.OP.PRESENT && op !== P.OP.PRESENT_SWAP_CHAIN, "unexpected presentation");
            if (op === P.OP.SESSION_END) {assert.equal(device, 0); assert.equal(ended++, 0);} x += length;
        }
        at += 12 + size;
    }
    assert.equal(created, 1); assert.equal(destroyed, 1); assert.equal(hello, 1); assert.equal(displayModes, 1); assert.equal(textures.length, 12); assert(textures.every(t => t.retired)); assert.equal(frames.length, 16); assert.equal(draws.length, 16); assert.deepEqual(uploads.sort((a, b) => a - b), [1, 2, 4, 5, 7, 8, 10, 11]);
    const lines = [1, 2, 3, 7].flatMap(api => [`DEFAULT CREATE api=${api} key=${api === 1 ? 1 : 0} specular=${api === 2 ? 1 : 0} normalize=${api < 7 ? 1 : 0} alpha=2 arg2=1 legacyIgnored=3 modernRejected=2`, ...scenes.filter(s => s.api === api).map(s => `DEFAULT FRAME api=${api} index=${s.index} alpha=${s.alpha} arg2=1 readback=1`)]);
    lines.push("DEFAULT STATUS versions=4 surfaces=12 frames=16 readbacks=16 factoryRefs=0", "PASS legacy D3D defaults and alpha"); assert.equal(result.logs["LDEF.TXT"].replace(/\r/g, "").trim(), lines.join("\n"));
    return {owners: result.owners, ownerReleases: result.releases, textures, frames, createdDevices: 1, logicalDevices: 4, draws: 16, uploads: 8, readbacks: 16, pixels: 1024};
}
