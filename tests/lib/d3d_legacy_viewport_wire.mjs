import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function legacy_viewport_scenes() {
    return [1, 2].flatMap(viewport => [0, 1, 2].flatMap(projection => [1, 2, 3].map(route => {
        const color = viewport === 1 ? 0xffb02010 : 0xff1040c0, left = projection === 1 ? 8 : 5, right = projection === 0 ? 11 : 14, top = viewport === 1 ? 6 : 5, bottom = viewport === 1 ? 10 : 11;
        return {viewport, projection, route, color, rect: [left, top, right, bottom], pixels: Array.from({length: 256}, (_, p) => p % 16 >= left && p % 16 < right && Math.floor(p / 16) >= top && Math.floor(p / 16) < bottom ? color : p % 16 >= 2 && p % 16 < 14 && Math.floor(p / 16) >= 2 && Math.floor(p / 16) < 14 ? 0xff010203 : 0)};
    }))).map((s, index) => ({index, ...s}));
}
export function inspect_legacy_viewport_wire(bytes, result) {
    assert.deepEqual(result.owners, [result.owners[0]]); assert(result.owners[0]); assert.deepEqual(result.releases, result.owners);
    const owner = result.owners[0], scenes = legacy_viewport_scenes(), frames = [], draws = [], textures = [], matrices = []; let device = 0, created = 0, destroyed = 0, retired = false, target = 0, projectionMatrix, viewport, hello = 0, clears = 0;
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length); assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8); const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + 16, length - 16);
            if (op === P.OP.HELLO) assert.equal(hello++, 0);
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(created++, 0); assert(q.device_handle && q.hwnd); assert.equal(q.width, 800); assert.equal(q.height, 600); assert.equal(q.backbuffer_format, 22); device = q.device_handle;}
            if (op === P.OP.CREATE_TEXTURE_2D) {const q = decode("CreateTexture2D"); assert.equal(textures.length, 0); assert.equal(q.device_handle, device); assert.equal(q.width, 16); assert.equal(q.height, 16); assert.equal(q.format, 21); assert.equal(q.level_count, 1); assert.equal(q.pool, 0); textures.push(q.resource_handle);}
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(q.device_handle, device); target = q.color_texture_handle;}
            if (op === P.OP.SET_VIEWPORT) {const q = decode("SetViewport"); assert.equal(q.device_handle, device); viewport = q;}
            if (op === P.OP.SET_TRANSFORM) {const q = decode("SetTransform"); assert.equal(q.device_handle, device); if (q.state === 3) {projectionMatrix = Array.from(q.matrix); matrices.push(projectionMatrix);}}
            if (op === P.OP.CLEAR) {const q = decode("Clear"); assert.equal(q.device_handle, device); assert.equal(q.color, 0xff010203); clears++;}
            if (op === P.OP.DRAW_PRIMITIVE_UP || op === P.OP.DRAW_INDEXED_PRIMITIVE_UP) {
                const q = decode(op === P.OP.DRAW_PRIMITIVE_UP ? "DrawPrimitiveUP" : "DrawIndexedPrimitiveUP"), scene = scenes[draws.length]; assert(scene); assert.equal(q.device_handle, device); assert.equal(target, textures[0]); assert(!retired); assert.equal(clears, scene.index + 1); assert.equal(q.primitive_type, 4); assert.equal(q.primitive_count, 2); assert.equal(q.stride, 32); assert(q.vertex_count >= 4); assert.equal(q.vertex_bytes, q.vertex_count * q.stride); assert(q.vertex_data_offset + q.vertex_bytes <= packet.length); assert(viewport); assert.deepEqual([viewport.x, viewport.y, viewport.width, viewport.height, viewport.min_z, viewport.max_z], [2, 2, 12, 12, 0, 1]);
                const wantedMatrix = [scene.projection === 2 ? 1 : .5, 0, 0, 0, 0, scene.viewport === 1 ? Math.fround(1 / 3) : .5, 0, 0, 0, 0, scene.viewport === 1 ? 1 : .5, 0, scene.projection ? .5 : 0, 0, scene.viewport === 1 ? 0 : -.5, 1]; assert.deepEqual(projectionMatrix, wantedMatrix, "effective projection lost");
                const vertices = [], xy = [[-1, 1], [1, 1], [-1, -1], [-1, -1], [1, 1], [1, -1]]; assert.equal(q.vertex_count, 6); assert.equal(op, scene.route === 1 ? P.OP.DRAW_INDEXED_PRIMITIVE_UP : P.OP.DRAW_PRIMITIVE_UP);
                if (scene.route === 1) {assert.equal(q.index_format, 101); assert.equal(q.index_count, 6); assert.equal(q.index_bytes, 12); assert(q.index_data_offset + q.index_bytes <= packet.length); for (let i = 0; i < 6; i++) assert.equal(packet.readUInt16LE(q.index_data_offset + i * 2), i);}
                for (let v = 0; v < q.vertex_count; v++) {const at = q.vertex_data_offset + v * q.stride, position = [0, 4, 8, 12].map(n => packet.readFloatLE(at + n)), wanted = scene.route === 1 ? [8 + 3 * (xy[v][0] * (scene.projection === 2 ? 2 : 1) + (scene.projection ? 1 : 0)), 8 - (scene.viewport === 1 ? 2 : 3) * xy[v][1], .5, 1] : [xy[v][0], xy[v][1], scene.viewport === 1 ? .5 : 2, 0]; for (let c = 0; c < 4; c++) assert(Math.abs(position[c] - wanted[c]) < .00001, "wrong legacy viewport position/layout"); assert.equal(packet.readUInt32LE(at + 16), scene.color, "prelit diffuse lost"); assert.equal(packet.readUInt32LE(at + 20), 0x00102030, "prelit specular lost"); assert.equal(packet.readFloatLE(at + 24), v); assert.equal(packet.readFloatLE(at + 28), 5 - v); vertices.push(position);}

                draws.push({index: scene.index, route: scene.route, vertices, op});
            }
            if (op === P.OP.READBACK_SURFACE) {const q = decode("ReadbackSurface"), scene = scenes[frames.length]; assert(scene); assert.equal(draws.length, frames.length + 1); assert.equal(q.device_handle, device); assert.equal(q.texture_handle, textures[0]); assert.equal(q.format, 21); assert.equal(q.width, 16); assert.equal(q.height, 16); assert.equal(q.level, 0); assert.equal(q.face, 0); assert.equal(q.first_row, 0); assert.equal(q.row_count, 16); assert.equal(q.destination_pitch, 64); assert.equal(q.destination_bytes, 1024); assert.equal(q.request_id, frames.length + 1); assert.equal(q.response_offset, P.C.D9WG_READBACK_REGION_OFFSET); frames.push({owner, device, texture: q.texture_handle, request: q.request_id, ...scene});}
            if (op === P.OP.DESTROY_RESOURCE) {const q = decode("DestroyResource"); assert.equal(frames.length, 18); if (q.resource_kind === 0) {assert.equal(q.resource_handle, device); assert(retired); assert.equal(destroyed++, 0); device = 0;} else {assert.equal(q.resource_kind, 3); assert.equal(q.resource_handle, textures[0]); assert(!retired); retired = true;}}
            assert(op !== P.OP.PRESENT && op !== P.OP.PRESENT_SWAP_CHAIN); x += length;
        }
        at += 12 + size;
    }
    assert.equal(hello, 1); assert.equal(created, 1); assert.equal(destroyed, 1); assert.equal(textures.length, 1); assert(retired); assert.equal(frames.length, 18); assert.equal(draws.length, 18); assert.equal(clears, 18); assert(matrices.length >= 18);
    const lines = scenes.map(s => `LVP FRAME viewport=${s.viewport} projection=${s.projection} route=${s.route} color=${s.color.toString(16).toUpperCase()} readback=1`); lines.push("LVP STATUS viewports=2 projections=3 routes=3 frames=18 cpuVertices=36 payloadBytes=576 logicalQueries=12 factoryRefs=0", "PASS legacy viewport and execute colors"); assert.equal(result.logs["LVP.TXT"].replace(/\r/g, "").trim(), lines.join("\n"));
    return {owners: result.owners, ownerReleases: result.releases, textures, frames, draws, projectionWrites: matrices.length, createdDevices: 1, readbacks: 18, pixels: 4608};
}
