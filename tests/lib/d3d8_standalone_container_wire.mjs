import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_standalone_container_wire(bytes, result) {
    assert.equal(result.owners.length, 1); assert.deepEqual(result.releases, result.owners);
    const owner = result.owners[0], s = {owner, api: 8, device: 0, hello: 0, ended: 0, created: 0, destroyed: 0, resources: []}, handles = new Set();
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "CREATE_TEXTURE_2D", "CREATE_TEXTURE_CUBE", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "SET_SCISSOR_RECT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8); assert.equal(bytes.readUInt32LE(at), owner); assert(size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected standalone container rendering/Reset traffic: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE) {const q = decode("CreateDevice"); assert.equal(s.created++, 0); assert(q.device_handle); s.device = q.device_handle; handles.add(s.device); assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1); assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0); assert.equal(q.multisample_quality, 0);}
            if (op === P.OP.CREATE_TEXTURE_2D || op === P.OP.CREATE_TEXTURE_CUBE) {
                const cube = op === P.OP.CREATE_TEXTURE_CUBE, q = decode(cube ? "CreateTextureCube" : "CreateTexture2D"), i = s.resources.length; assert(i < 8); assert.equal(cube, i === 5 || i === 7); assert.equal(q.device_handle, s.device); assert(q.resource_handle && !handles.has(q.resource_handle)); handles.add(q.resource_handle);
                assert.equal(q.format, i === 2 || i === 3 ? 75 : 22); assert.equal(q.usage, i < 2 || i >= 6 ? 1 : i < 4 ? 2 : 0); assert.equal(q.pool, i === 4 || i === 5 ? 1 : 0); assert.equal(q.level_count, 1);
                if (cube) {assert.equal(q.edge_length, 8); assert.equal(q.reserved, 0);} else {assert.equal(q.width, i >= 4 ? 8 : 32); assert.equal(q.height, i >= 4 ? 8 : 24); assert.equal(q.multisample_type, i === 1 || i === 3 ? 4 : 0); assert.equal(q.multisample_quality, 0);}
                assert(s.resources.every(r => r.retired)); s.resources.push({handle: q.resource_handle, kind: cube ? 4 : 3, format: q.format, pool: q.pool, retired: false});
            }
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (q.resource_kind === 0) {assert.equal(q.resource_handle, s.device); assert.equal(s.resources.length, 8); assert(s.resources.every(r => r.retired)); assert.equal(s.destroyed++, 0); s.device = 0;}
                else {const r = s.resources.find(r => r.handle === q.resource_handle && !r.retired); assert(r); assert.equal(q.resource_kind, r.kind); r.retired = true;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); assert.equal(s.ended++, 0);}
            x += length;
        }
        at += 12 + size;
    }
    assert.equal(s.hello, 1); assert.equal(s.created, 1); assert.equal(s.destroyed, 1); assert(s.ended === 0 || s.ended === 1); assert.equal(s.device, 0); assert.equal(s.resources.length, 8); assert(s.resources.every(r => r.retired));
    const expected = Array.from({length: 5}, (_, i) => "SURFACE CONTAINER kind=" + i + " rounds=8 deviceQueries=16 refused=56 nullGuards=2 balanced=1 deviceRefs=1");
    expected.push(...Array.from({length: 4}, (_, i) => "SURFACE CONTROL kind=" + i + " cube=" + (i & 1) + " renderTarget=" + (i >= 2 ? 1 : 0) + " accepted=4 refused=5 shared=1 deviceRefs=1"), "SURFACE STATUS profiles=5 deviceQueries=80 refused=280 nullGuards=10 controls=4 hiddenTextureExposed=0 deviceRefs=1", "PASS standalone containers API=8");
    assert.equal(result.logs["SCN8.TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    return {perAPI: [s], ownerReleases: result.releases, deviceLifetimes: 1, standaloneProfiles: 5, acceptedDeviceQueries: 80, refusedStandaloneQueries: 280, nullGuards: 10, retainedTextureCubeControls: 4, backingTextures2D: 6, backingTexturesCube: 2, drawOrPresentOrResetCommands: 0};
}
