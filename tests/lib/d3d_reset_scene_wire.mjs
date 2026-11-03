import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {inspect_reset_status_wire} from "./d3d_reset_status_wire.mjs";
const require = createRequire(import.meta.url);
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");

export function inspect_reset_scene_wire(bytes, result) {
    const logs = {...result.logs};
    for (const api of [8, 9]) {
        const file = "RST" + api + ".TXT", lines = logs[file].replace(/\r/g, "").trim().split("\n");
        assert.equal(lines.length, 4);
        assert.equal(lines[2], "RESET SCENE " + api + " resetOpen=8 endRefused=15 freshPairs=15");
        logs[file] = [lines[0], lines[1], lines[3]].join("\n");
    }
    const analysis = inspect_reset_status_wire(bytes, {...result, logs});
    const scenes = new Map(analysis.perAPI.map(s => [s.owner, {api: s.api, device: 0, active: false, begins: 0, ends: 0, openResets: 0}]));
    for (let at = 0; at < bytes.length;) {
        const size = bytes.readUInt32LE(at + 8), s = scenes.get(bytes.readUInt32LE(at));
        const packet = bytes.subarray(at + 20, at + 12 + size), h = W.readHeader(packet);
        for (let x = P.STRUCTS.BatchHeader.size; x < h.end;) {
            const op = h.view.getUint16(x, true), length = h.view.getUint32(x + P.F.CommandHeader.size, true);
            const decode = name => P.decode(name, h.view, x + P.STRUCTS.CommandHeader.size, length - P.STRUCTS.CommandHeader.size);
            if (op === P.OP.CREATE_DEVICE) s.device = decode("CreateDevice").device_handle;
            if (op === P.OP.BEGIN_SCENE || op === P.OP.END_SCENE) {
                assert.equal(decode("DeviceOnly").device_handle, s.device);
                const begin = op === P.OP.BEGIN_SCENE;
                assert.equal(s.active, !begin, "invalid Scene transition on wire");
                s.active = begin;
                if (begin) s.begins++; else s.ends++;
            }
            if (op === P.OP.RESET) {
                if (s.active) s.openResets++;
                s.active = false;
                s.device = decode("ResetDevice").new_device_handle;
            }
            if (op === P.OP.DRAW_PRIMITIVE_UP) assert(s.active, "drawing after Reset must start a new Scene");
            x += length;
        }
        at += 12 + size;
    }
    for (const s of scenes.values()) {
        assert(!s.active);
        assert.equal(s.begins, 24);
        assert.equal(s.ends, 16);
        assert.equal(s.openResets, 8);
    }
    return {...analysis, scenes: [...scenes.values()]};
}
