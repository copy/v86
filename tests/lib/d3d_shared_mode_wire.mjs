import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const widths = [128, 640, 640, 800, 640, 128, 640], heights = [128, 480, 480, 600, 480, 128, 480];
const colors = [0xff102030, 0xff204060, 0xff306090, 0xff4080a0, 0xff50a0c0, 0xff60c0e0, 0xff70e0f0], resetAtFrame = [0, 1, 3, 4, 5, 6, 6];
export function inspect_shared_mode_wire(bytes, result) {
    assert.equal(result.owners.length, 4);
    const cases = [[8, 0], [8, 1], [9, 0], [9, 1]], states = new Map(cases.map(([api, unicode], i) => [result.owners[i], {owner: result.owners[i], api, unicode, active: 0, devices: [], handles: [], resets: [], frames: [], reports: [], firstWindow: 0, secondWindow: 0, pendingClear: null, ended: 0}])), frames = [];
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length); const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at)); assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet); W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true), decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"), i = s.devices.length; assert(!s.active && i < 3); assert.equal(q.width, [128, 33, 640][i]); assert.equal(q.height, [128, 33, 480][i]); assert.equal(q.windowed, i === 0 ? 1 : 0); assert.equal(q.backbuffer_format, 22); assert.equal(q.multisample_type, 0); assert.equal(q.enable_auto_depth_stencil, 0);
                if (!i) { s.firstWindow = q.hwnd; assert(s.firstWindow); } else assert.equal(q.hwnd, s.firstWindow);
                assert(!s.handles.includes(q.device_handle)); s.handles.push(q.device_handle); s.active = q.device_handle; s.devices.push({initial: q.device_handle, handle: q.device_handle, rejectedConstructor: i === 1, retired: false});
            }
            if (op === P.OP.RESET) {
                const q = decode("ResetDevice"), i = s.resets.length; assert.equal(s.devices.length, 1); assert(i < 6); assert.equal(q.old_device_handle, s.active); assert(!s.handles.includes(q.new_device_handle));
                assert.equal(q.width, [640, 33, 640, 800, 640, 128][i]); assert.equal(q.height, [480, 33, 480, 600, 480, 128][i]); assert.equal(q.windowed, i === 5 ? 1 : 0); assert.equal(q.backbuffer_format, 22); assert.equal(q.multisample_type, 0); assert.equal(q.enable_auto_depth_stencil, 0);
                if (i < 4) assert.equal(q.hwnd, s.firstWindow); else if (i === 4) { s.secondWindow = q.hwnd; assert(s.secondWindow && s.secondWindow !== s.firstWindow); } else assert.equal(q.hwnd, s.secondWindow);
                s.handles.push(q.new_device_handle); s.active = q.new_device_handle; s.devices[0].handle = s.active; s.resets.push(q); s.pendingClear = null;
            }
            if (op === P.OP.WINDOW_STATE) s.reports.push(decode("WindowState"));
            if (op === P.OP.CLEAR) { const q = decode("Clear"), phase = s.frames.length; assert(phase < 7); assert.equal(q.device_handle, s.active); assert.equal(s.resets.length, resetAtFrame[phase]); assert.equal(s.devices.length, phase === 6 ? 3 : 1); assert.equal(q.clear_flags, 1); assert.equal(q.rect_count, 0); assert.equal(q.color, colors[phase]); assert.equal(s.pendingClear, null); s.pendingClear = q.color; }
            if (op === P.OP.PRESENT) {
                const q = decode("Present"), phase = s.frames.length, full = phase > 0 && phase !== 5; assert(phase < 7); assert.equal(q.device_handle, s.active); assert.equal(q.width, widths[phase]); assert.equal(q.height, heights[phase]); assert.equal(s.resets.length, resetAtFrame[phase]); assert.equal(s.pendingClear, colors[phase]); assert.equal(q.hwnd, phase === 4 || phase === 5 ? s.secondWindow : s.firstWindow);
                if (full) { assert.equal(q.x, 0); assert.equal(q.y, 0); }
                assert(s.reports.some(r => r.device_handle === s.active && r.hwnd === q.hwnd && !!(r.flags & P.C.D9WG_WINDOW_FULLSCREEN) === full && r.client_width === q.width && r.client_height === q.height), "missing shared mode/window report");
                const frame = {owner: s.owner, api: s.api, unicode: s.unicode, phase, device: s.active, window: q.hwnd, width: q.width, height: q.height, color: s.pendingClear, fullscreen: full}; s.frames.push(frame); frames.push(frame); s.pendingClear = null;
            }
            if (op === P.OP.DESTROY_RESOURCE) { const q = decode("DestroyResource"), d = s.devices.at(-1); assert.equal(q.resource_kind, 0); assert.equal(q.resource_handle, s.active); assert(d && !d.retired); assert.equal(s.frames.length, s.devices.length < 3 ? 6 : 7); d.retired = true; s.active = 0; }
            if (op === P.OP.SESSION_END) { assert(!s.active); s.ended++; }
            assert(![P.OP.CREATE_BUFFER, P.OP.CREATE_TEXTURE_2D, P.OP.CREATE_TEXTURE_CUBE, P.OP.CREATE_TEXTURE_VOLUME, P.OP.READBACK_SURFACE, P.OP.CREATE_SWAP_CHAIN, P.OP.DRAW_PRIMITIVE_UP, P.OP.DRAW_INDEXED_PRIMITIVE, P.OP.DRAW_INDEXED_PRIMITIVE_UP].includes(op)); x += length;
        }
        at += 12 + size;
    }
    for (const s of states.values()) {
        assert.equal(s.devices.length, 3); assert(s.devices.every(d => d.retired)); assert.equal(s.handles.length, 9); assert.equal(s.resets.length, 6); assert.equal(s.frames.length, 7); assert.equal(s.ended, 1);
        const lines = result.logs["M" + s.api + s.unicode + ".TXT"].replace(/\r/g, "").trim().split("\n"); assert.equal(lines.length, 9);
        for (let phase = 0; phase < 7; phase++) assert.equal(lines[phase], "MODE FRAME " + phase + " width=" + widths[phase] + " height=" + heights[phase] + " color=" + colors[phase].toString(16).toUpperCase());
        const m = /^MODE STATUS api=(\d) unicode=(\d) accepted=5 refused=1 constructors=1 ctorRefused=1 frames=7 sizeInside=0 customInside=(\d+) posInside=(\d+) restored=1$/.exec(lines[7]); assert(m); assert.equal(Number(m[1]), s.api); assert.equal(Number(m[2]), s.unicode); assert(Number(m[3]) > 0 && Number(m[3]) === Number(m[4])); assert.equal(lines[8], "PASS reset mode"); s.customInside = Number(m[3]); s.positionsInside = Number(m[4]);
    }
    return {perOwner: [...states.values()], frames, queuedResets: 24, successfulResets: 20, rejectedModeResets: 4, deviceLifetimes: 12, successfulFullscreenConstructors: 4, rejectedConstructors: 4};
}
