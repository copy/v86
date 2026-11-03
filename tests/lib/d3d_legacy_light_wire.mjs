import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function legacy_light_scenes() {
    const sizes = [76, 80, 80, 76, 80, 80, 80, 76, 76], flags = [1, 0, 3, 1, 1, 2, 2, 1, 1], enabled = [1, 0, 1, 1, 1, 0, 0, 0, 1];
    return sizes.flatMap((inputSize, step) => [1, 3].map(route => {
        const color = enabled[step] ? step === 8 ? 0xffff0000 : 0xff0040ff : 0xff000000;
        return {index: step * 2 + (route === 3 ? 1 : 0), step, route, inputSize, effectiveFlags: flags[step], enabled: enabled[step], color, pixels: Array(64).fill(color)};
    }));
}
export function inspect_legacy_light_wire(bytes, result) {
    assert.deepEqual(result.owners, [result.owners[0]]); assert(result.owners[0]); assert.deepEqual(result.releases, result.owners);
    const owner = result.owners[0], scenes = legacy_light_scenes(), frames = [], draws = [], textures = [], enabled = [], lights = [], states = [];
    let device = 0, created = 0, destroyed = 0, retired = false, target = 0, projection, viewport, hello = 0, clears = 0, lightWrites = 0, enableWrites = 0;
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length); assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8); const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + 16, length - 16);
            if (op === P.OP.HELLO) assert.equal(hello++, 0);
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(created++, 0); assert(q.device_handle && q.hwnd); assert.deepEqual([q.width, q.height, q.backbuffer_format], [800, 600, 22]); device = q.device_handle;}
            if (op === P.OP.CREATE_TEXTURE_2D) {const q = decode("CreateTexture2D"); assert.equal(textures.length, 0); assert.equal(q.device_handle, device); assert.deepEqual([q.width, q.height, q.format, q.level_count, q.pool, q.usage], [8, 8, 21, 1, 0, 1]); textures.push(q.resource_handle);}
            if (op === P.OP.SET_RENDER_TARGET) {const q = decode("SetRenderTarget"); assert.equal(q.device_handle, device); target = q.color_texture_handle;}
            if (op === P.OP.SET_VIEWPORT) {const q = decode("SetViewport"); assert.equal(q.device_handle, device); viewport = q;}
            if (op === P.OP.SET_TRANSFORM) {const q = decode("SetTransform"); assert.equal(q.device_handle, device); if (q.state === 3) projection = Array.from(q.matrix);}
            if (op === P.OP.SET_RENDER_STATE) {const q = decode("SetRenderState"); assert.equal(q.device_handle, device); states[q.state] = q.value;}
            if (op === P.OP.SET_LIGHT) {const q = decode("SetLight"); assert.equal(q.device_handle, device); assert(q.index < 8); lights[q.index] = q; lightWrites++;}
            if (op === P.OP.LIGHT_ENABLE) {const q = decode("LightEnable"); assert.equal(q.device_handle, device); assert(q.index < 8); assert(q.enable === 0 || q.enable === 1); enabled[q.index] = q.enable; enableWrites++;}
            if (op === P.OP.CLEAR) {const q = decode("Clear"); assert.equal(q.device_handle, device); assert.equal(q.color, 0xff010203); clears++;}
            if (op === P.OP.DRAW_PRIMITIVE_UP || op === P.OP.DRAW_INDEXED_PRIMITIVE_UP) {
                const q = decode(op === P.OP.DRAW_PRIMITIVE_UP ? "DrawPrimitiveUP" : "DrawIndexedPrimitiveUP"), scene = scenes[draws.length]; assert(scene); assert.equal(q.device_handle, device); assert.equal(target, textures[0]); assert(!retired); assert.equal(clears, scene.index + 1); assert.deepEqual([q.primitive_type, q.primitive_count, q.stride, q.vertex_count, q.vertex_bytes], [4, 2, 32, 6, 192]); assert(q.vertex_data_offset + q.vertex_bytes <= packet.length); assert(viewport); assert.deepEqual([viewport.x, viewport.y, viewport.width, viewport.height, viewport.min_z, viewport.max_z], [0, 0, 8, 8, 0, 1]); assert.deepEqual(projection, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
                assert.equal(enabled[0], scene.enabled, "size-selected activation lost"); assert.deepEqual(enabled.slice(1, 8), Array(7).fill(0)); const light = lights[0]; assert(light); assert.equal(light.type, 3); assert.deepEqual(Array.from(light.diffuse), scene.step === 8 ? [1, 0, 0, 1] : [0, .25, 1, 1]); assert.deepEqual(Array.from(light.specular), [2, 5, 6, 7].includes(scene.step) ? [0, 0, 0, 0] : scene.step === 8 ? [1, 0, 0, 1] : [0, .25, 1, 1]); assert.deepEqual(Array.from(light.ambient), [0, 0, 0, 0]); assert.deepEqual(Array.from(light.direction), [0, 0, 1]); assert.equal(states[137], 1); assert.equal(states[29], 0);
                const vertices = [], xy = [[-1, 1], [1, 1], [-1, -1], [-1, -1], [1, 1], [1, -1]]; assert.equal(op, scene.route === 1 ? P.OP.DRAW_INDEXED_PRIMITIVE_UP : P.OP.DRAW_PRIMITIVE_UP);
                if (scene.route === 1) {assert.deepEqual([q.index_format, q.index_count, q.index_bytes], [101, 6, 12]); assert(q.index_data_offset + q.index_bytes <= packet.length); for (let i = 0; i < 6; i++) assert.equal(packet.readUInt16LE(q.index_data_offset + i * 2), i);}
                for (let v = 0; v < 6; v++) {const pos = q.vertex_data_offset + v * 32, position = [0, 4, 8].map(n => packet.readFloatLE(pos + n)); assert.deepEqual(position, scene.route === 1 ? [4 + 4 * xy[v][0], 4 - 4 * xy[v][1], .5] : [...xy[v], .5]); if (scene.route === 1) {assert.equal(packet.readFloatLE(pos + 12), 1); assert.equal(packet.readUInt32LE(pos + 16), scene.color, "CPU lit diffuse lost");} else assert.deepEqual([12, 16, 20].map(n => packet.readFloatLE(pos + n)), [0, 0, -1], "raw normal layout lost"); assert.equal(packet.readFloatLE(pos + 24), 0); assert.equal(packet.readFloatLE(pos + 28), 0); vertices.push(position);}
                draws.push({index: scene.index, route: scene.route, vertices, op});
            }
            if (op === P.OP.READBACK_SURFACE) {const q = decode("ReadbackSurface"), scene = scenes[frames.length]; assert(scene); assert.equal(draws.length, frames.length + 1); assert.equal(q.device_handle, device); assert.equal(q.texture_handle, textures[0]); assert.deepEqual([q.format, q.width, q.height, q.level, q.face, q.first_row, q.row_count, q.destination_pitch, q.destination_bytes], [21, 8, 8, 0, 0, 0, 8, 32, 256]); assert.equal(q.request_id, frames.length + 1); assert.equal(q.response_offset, P.C.D9WG_READBACK_REGION_OFFSET); frames.push({owner, device, texture: q.texture_handle, request: q.request_id, ...scene});}
            if (op === P.OP.DESTROY_RESOURCE) {const q = decode("DestroyResource"); assert.equal(frames.length, 18); if (q.resource_kind === 0) {assert.equal(q.resource_handle, device); assert(retired); assert.equal(destroyed++, 0); device = 0;} else {assert.equal(q.resource_kind, 3); assert.equal(q.resource_handle, textures[0]); assert(!retired); retired = true;}}
            assert(op !== P.OP.PRESENT && op !== P.OP.PRESENT_SWAP_CHAIN); x += length;
        }
        at += 12 + size;
    }
    assert.equal(hello, 1); assert.equal(created, 1); assert.equal(destroyed, 1); assert.equal(textures.length, 1); assert(retired); assert.equal(frames.length, 18); assert.equal(draws.length, 18); assert.equal(clears, 18); assert(lightWrites >= 9 && enableWrites >= 72);
    const lines = scenes.map(s => `LIGHT FRAME step=${s.step} route=${s.route} inputSize=${s.inputSize} effectiveFlags=${s.effectiveFlags} enabled=${s.enabled} color=${s.color.toString(16).toUpperCase()} readback=1`); lines.push("LIGHT STATUS states=9 routes=2 frames=18 readbacks=18 malformedRefusals=2 detachedIsolation=1 specularQueries=9 factoryRefs=0", "PASS legacy DX3 and D3DLIGHT2 flags"); assert.equal(result.logs["LLIGHT.TXT"].replace(/\r/g, "").trim(), lines.join("\n"));
    return {owners: result.owners, ownerReleases: result.releases, textures, frames, draws, lightWrites, enableWrites, createdDevices: 1, readbacks: 18, pixels: 1152};
}
