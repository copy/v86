import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const widths = [128, 160, 96], heights = [96, 112, 80], colors = [0xff2468ac, 0xff359bce, 0xff46acdf];
export function inspect_present_geometry_wire(bytes, result) {
    assert.equal(result.owners.length, 2);
    const states = new Map(result.owners.map((owner, i) => [owner, {owner, api: i + 8, device: 0, handles: [], created: 0, destroyed: 0, resets: 0, clears: 0, presents: 0, viewports: 0, hello: 0, ended: 0}])), frames = [];
    const allowed = new Set(["HELLO", "CREATE_DEVICE", "RESET", "DESTROY_RESOURCE", "SET_RENDER_STATE", "SET_MATERIAL", "SET_VIEWPORT", "CLEAR", "PRESENT", "WINDOW_STATE", "SESSION_END", "GUEST_LOG", "SET_VERTEX_SHADER_CONSTANT_F", "SET_PIXEL_SHADER_CONSTANT_F", "SET_VERTEX_SHADER_CONSTANT_I", "SET_PIXEL_SHADER_CONSTANT_I", "SET_VERTEX_SHADER_CONSTANT_B", "SET_PIXEL_SHADER_CONSTANT_B"].map(n => P.OP[n]));
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            assert(allowed.has(op), "unexpected geometry probe command: " + op);
            if (op === P.OP.HELLO) s.hello++;
            if (op === P.OP.CREATE_DEVICE || op === P.OP.RESET) {
                const reset = op === P.OP.RESET, q = decode(reset ? "ResetDevice" : "CreateDevice");
                if (reset) {assert.equal(q.old_device_handle, s.device); assert.equal(s.presents, s.resets + 1); s.resets++;}
                else {assert.equal(s.created++, 0); assert.equal(s.device, 0);}
                assert.equal(q.width, widths[s.resets]); assert.equal(q.height, heights[s.resets]); assert.equal(q.backbuffer_format, 22); assert.equal(q.windowed, 1);
                assert.equal(q.enable_auto_depth_stencil, 1); assert.equal(q.auto_depth_stencil_format, 75); assert.equal(q.multisample_type, 0);
                const handle = reset ? q.new_device_handle : q.device_handle; assert(handle && !s.handles.includes(handle)); s.handles.push(handle); s.device = handle;
            }
            if (op === P.OP.SET_VIEWPORT) {const q = decode("SetViewport"); assert.equal(q.device_handle, s.device); assert.equal(q.width, widths[s.resets]); assert.equal(q.height, heights[s.resets]); assert.equal(s.viewports++, s.resets);}
            if (op === P.OP.CLEAR) {const q = decode("Clear"); assert.equal(q.device_handle, s.device); assert.equal(q.clear_flags, 3); assert.equal(q.color, colors[s.resets]); assert.equal(q.rect_count, 0); assert.equal(s.clears++, s.resets);}
            if (op === P.OP.PRESENT) {
                const q = decode("Present"); assert.equal(q.device_handle, s.device); assert.equal(q.width, widths[s.resets]); assert.equal(q.height, heights[s.resets]); assert.equal(s.presents++, s.resets); assert.equal(s.clears, s.presents); assert.equal(s.viewports, s.api === 9 ? s.presents : 0);
                frames.push({owner: s.owner, api: s.api, phase: s.resets, device: s.device, width: q.width, height: q.height});
            }
            if (op === P.OP.DESTROY_RESOURCE) {const q = decode("DestroyResource"); assert.equal(q.resource_kind, 0); assert.equal(q.resource_handle, s.device); assert.equal(s.presents, 3); s.destroyed++; s.device = 0;}
            if (op === P.OP.SESSION_END) {assert.equal(s.device, 0); s.ended++;}
            x += length;
        }
        at += 12 + size;
    }
    const perAPI = [...states.values()];
    for (const s of perAPI) {
        assert.equal(s.created, 1); assert.equal(s.destroyed, 1); assert.equal(s.hello, 1); assert.equal(s.ended, 1); assert.equal(s.resets, 2); assert.equal(s.presents, 3); assert.equal(s.viewports, s.api === 9 ? 3 : 0);
        const expected = widths.map((width, step) => "PRESENT GEOMETRY api=" + s.api + " step=" + step + " width=" + width + " height=" + heights[step] + " callerWidth=" + (s.api === 9 ? width : step === 2 ? 96 : 0) + " callerHeight=" + (s.api === 9 ? heights[step] : 0) + " count=1 hWindowNull=1");
        expected.push("PRESENT GEOMETRY STATUS frames=3 resets=2 viewport=3 color=3 depth=3 count=1", "PASS present geometry API=" + s.api);
        assert.equal(result.logs["GEO" + s.api + ".TXT"].replace(/\r/g, "").trim(), expected.join("\n"));
    }
    return {perAPI, frames, deviceLifetimes: 2, resets: 4, viewportCommands: 3};
}
