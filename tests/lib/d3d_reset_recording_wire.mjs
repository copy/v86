import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
export function inspect_reset_recording_wire(bytes, result) {
    assert.equal(result.owners.length, 2);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: i + 8, device: 0, handles: [], resources: [], resets: 0, created: 0, destroyed: 0, hello: 0, ended: 0}]));
    const kinds = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 3, 3];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "CREATE_BUFFER", "CREATE_TEXTURE_2D", "CREATE_TEXTURE_CUBE", "CREATE_TEXTURE_VOLUME", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(name => {assert(Number.isInteger(P.OP[name]), name); return P.OP[name];}));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length);
        const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at));
        assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true);
            assert(allowed.has(op), "recorded bindings or rendering unexpectedly reached the host: " + op);
            const decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                assert.equal(q.width, 64); assert.equal(q.height, 64); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1);
                assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0);
                if (reset) {
                    assert.equal(q.old_device_handle, s.device); assert.equal(s.resources.length, s.resets);
                    assert(s.resources.every(r => r.retired !== null), "Reset queued before recorded resource retirement"); s.resets++;
                } else {assert.equal(s.created++, 0); assert.equal(s.device, 0);}
                const handle = reset ? q.new_device_handle : q.device_handle;
                assert(handle && !s.handles.includes(handle)); s.handles.push(handle); s.device = handle;
            }
            const creation = [P.OP.CREATE_BUFFER, P.OP.CREATE_TEXTURE_2D, P.OP.CREATE_TEXTURE_CUBE, P.OP.CREATE_TEXTURE_VOLUME].indexOf(op);
            if (creation >= 0) {
                const q = decode(["CreateBuffer", "CreateTexture2D", "CreateTextureCube", "CreateTextureVolume"][creation]), i = s.resources.length, kind = creation ? creation + 2 : q.resource_kind;
                assert.equal(kind, kinds[i]); assert.equal(q.device_handle, s.device); assert.equal(q.pool, 0); assert.equal(q.usage, 0); assert.equal(s.resets, i + 1);
                if (creation) {
                    assert.equal(q.format, 21); assert.equal(q.level_count, 2);
                    if (creation === 2) assert.equal(q.edge_length, 4); else {assert.equal(q.width, 4); assert.equal(q.height, 4);}
                    if (creation === 3) assert.equal(q.depth, 4);
                } else {assert.equal(q.byte_count, 16); assert.equal(q.fvf, kind === 1 ? 2 : 101);}
                assert(q.resource_handle && !s.resources.some(r => r.handle === q.resource_handle));
                s.resources.push({handle: q.resource_handle, kind, born: s.resets, retired: null});
            }
            if (op === P.OP.DESTROY_RESOURCE) {
                const q = decode("DestroyResource");
                if (!q.resource_kind) {assert.equal(q.resource_handle, s.device); assert(s.resources.every(r => r.retired !== null)); s.destroyed++; s.device = 0;}
                else {const r = s.resources.find(r => r.handle === q.resource_handle && r.retired === null); assert(r); assert.equal(q.resource_kind, r.kind); assert.equal(r.born, s.resets); r.retired = s.resets;}
            }
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.created, 1); assert.equal(s.destroyed, 1); assert.equal(s.hello, 1); assert.equal(s.ended, 1);
        assert.equal(s.resets, 13); assert.equal(s.handles.length, 14); assert.equal(s.resources.length, 12); assert(s.resources.every(r => r.born === r.retired));
        const expected = [];
        for (let family = 0; family < 5; family++) for (let held = 0; held < 2; held++) expected.push("RECORDING CASE api=" + s.api + " family=" + family + " held=" + held + " finalized=1");
        for (let invalid = 0; invalid < 2; invalid++) expected.push("RECORDING INPUT api=" + s.api + " invalid=" + invalid + " preserved=1 finalized=1");
        expected.push("RESET RECORDING api=" + s.api + " accepted=13 refused=7 finalized=12 recordings=26 endInvalid=13 families=5 held=5 sole=5 invalidPreserved=2", "PASS reset recording API=" + s.api);
        assert.equal(result.logs["REC" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, resources: 24, resets: 26, renderingCommands: 0};
}
