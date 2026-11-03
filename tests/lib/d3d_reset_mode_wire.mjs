import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url), P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const widths = [128, 640, 640, 800, 640, 128], heights = [128, 480, 480, 600, 480, 128];
const colors = [0xff102030, 0xff204060, 0xff306090, 0xff4080a0, 0xff50a0c0, 0xff60c0e0];
const resetAtFrame = [0, 1, 3, 4, 5, 6];
export function inspect_reset_mode_wire(bytes, result) {
    assert.equal(result.owners.length, 2);
    const states = new Map(result.owners.map((owner, unicode) => [owner, {owner, unicode, device: 0, created: 0, destroyed: 0, resets: [], frames: [], reports: [], firstWindow: 0, secondWindow: 0, pendingClear: null}]));
    const frames = [];
    for (let at = 0; at < bytes.length;) {
        assert(at + 20 <= bytes.length);
        const size = bytes.readUInt32LE(at + 8), s = states.get(bytes.readUInt32LE(at));
        assert(s && size >= 8 && at + 12 + size <= bytes.length);
        assert.equal(bytes.readUInt16LE(at + 12), 0xffe1); assert.equal(bytes.readUInt32LE(at + 16), size - 8);
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet);
        W.checkStream(h.view, h.end, h.commandCount);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true);
            const decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.CREATE_DEVICE) {
                const q = decode("CreateDevice"); assert.equal(s.created++, 0); assert.equal(q.width, 128); assert.equal(q.height, 128); assert.equal(q.windowed, 1); assert.equal(q.multisample_type, 0); assert.equal(q.enable_auto_depth_stencil, 0);
                s.device = q.device_handle; s.firstWindow = q.hwnd; assert(s.firstWindow);
            }
            if (op === P.OP.RESET) {
                const q = decode("ResetDevice"), i = s.resets.length;
                assert(i < 6); assert.equal(q.old_device_handle, s.device); assert.notEqual(q.new_device_handle, s.device);
                assert.equal(q.width, [640, 33, 640, 800, 640, 128][i]); assert.equal(q.height, [480, 33, 480, 600, 480, 128][i]); assert.equal(q.windowed, i === 5 ? 1 : 0); assert.equal(q.backbuffer_format, 22); assert.equal(q.multisample_type, 0); assert.equal(q.enable_auto_depth_stencil, 0);
                if (i < 4) assert.equal(q.hwnd, s.firstWindow);
                else if (i === 4) { s.secondWindow = q.hwnd; assert(s.secondWindow && s.secondWindow !== s.firstWindow); }
                else assert.equal(q.hwnd, s.secondWindow);
                s.device = q.new_device_handle; s.resets.push(q); s.pendingClear = null;
            }
            if (op === P.OP.WINDOW_STATE) s.reports.push(decode("WindowState"));
            if (op === P.OP.CLEAR) {
                const q = decode("Clear"), phase = s.frames.length;
                assert.equal(q.device_handle, s.device); assert.equal(s.resets.length, resetAtFrame[phase]); assert.equal(q.clear_flags, 1); assert.equal(q.rect_count, 0); assert.equal(q.color, colors[phase]); assert.equal(s.pendingClear, null); s.pendingClear = q.color;
            }
            if (op === P.OP.PRESENT) {
                const q = decode("Present"), phase = s.frames.length, full = phase > 0 && phase < 5;
                assert(phase < 6); assert.equal(q.device_handle, s.device); assert.equal(q.width, widths[phase]); assert.equal(q.height, heights[phase]); assert.equal(s.resets.length, resetAtFrame[phase]); assert.equal(s.pendingClear, colors[phase]);
                assert.equal(q.hwnd, phase < 4 ? s.firstWindow : s.secondWindow);
                if (full) { assert.equal(q.x, 0); assert.equal(q.y, 0); }
                const report = s.reports.findLast(r => r.device_handle === s.device && r.hwnd === q.hwnd && !!(r.flags & P.C.D9WG_WINDOW_FULLSCREEN) === full && r.client_width === q.width && r.client_height === q.height);
                assert(report, "missing final mode/window report before Present");
                const frame = {owner: s.owner, unicode: s.unicode, phase, device: s.device, window: q.hwnd, width: q.width, height: q.height, color: s.pendingClear, fullscreen: full};
                s.frames.push(frame); frames.push(frame); s.pendingClear = null;
            }
            if (op === P.OP.DESTROY_RESOURCE) { const q = decode("DestroyResource"); assert.equal(q.resource_kind, 0); assert.equal(q.resource_handle, s.device); s.destroyed++; }
            assert(![P.OP.CREATE_BUFFER, P.OP.CREATE_TEXTURE_2D, P.OP.CREATE_TEXTURE_CUBE, P.OP.CREATE_TEXTURE_VOLUME, P.OP.READBACK_SURFACE, P.OP.CREATE_SWAP_CHAIN, P.OP.DRAW_PRIMITIVE_UP, P.OP.DRAW_INDEXED_PRIMITIVE, P.OP.DRAW_INDEXED_PRIMITIVE_UP].includes(op));
            x += length;
        }
        at += 12 + size;
    }
    for (const s of states.values()) {
        assert.equal(s.created, 1); assert.equal(s.destroyed, 1); assert.equal(s.resets.length, 6); assert.equal(s.frames.length, 6);
        const lines = result.logs["MODE" + s.unicode + ".TXT"].replace(/\r/g, "").trim().split("\n"); assert.equal(lines.length, 8);
        for (let phase = 0; phase < 6; phase++) assert.equal(lines[phase], "MODE FRAME " + phase + " width=" + widths[phase] + " height=" + heights[phase] + " color=" + colors[phase].toString(16).toUpperCase());
        const match = /^MODE STATUS unicode=(\d) accepted=5 refused=1 frames=6 sizeInside=0 customInside=(\d+) posInside=(\d+) restored=1$/.exec(lines[6]);
        assert(match); assert.equal(Number(match[1]), s.unicode); assert(Number(match[2]) > 0 && Number(match[2]) === Number(match[3])); assert.equal(lines[7], "PASS reset mode");
        s.customInside = Number(match[2]); s.positionsInside = Number(match[3]);
    }
    return {perOwner: [...states.values()], frames, queuedResets: 12, successfulResets: 10, rejectedModeResets: 2};
}
