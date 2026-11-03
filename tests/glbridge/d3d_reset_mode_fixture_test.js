"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_reset_mode_wire} = await import("../lib/d3d_reset_mode_wire.mjs"), m = require("./fixtures/d3d_reset_mode_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_reset_mode_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    const result = {owners: m.perOwner.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_reset_mode_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_reset_mode_wire(b, result), {perOwner: m.perOwner, frames: m.frames, queuedResets: 12, successfulResets: 10, rejectedModeResets: 2});
    const targets = {}, reports = [];
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, expected] of [["width", "ResetDevice", "width", P.OP.RESET], ["handle", "ResetDevice", "old_device_handle", P.OP.RESET], ["windowed", "ResetDevice", "windowed", P.OP.RESET], ["window", "ResetDevice", "hwnd", P.OP.RESET], ["present", "Present", "height", P.OP.PRESENT], ["color", "Clear", "color", P.OP.CLEAR]]) if (op === expected && !targets[name]) targets[name] = p + P.F[kind][field];
            if (op === P.OP.WINDOW_STATE) reports.push(p + P.F.WindowState.flags);
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 6); assert(reports.length);
    for (const [name, at] of Object.entries(targets)) { const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_reset_mode_wire(bad, result), undefined, name); }
    const bad = Buffer.from(b); for (const at of reports) bad.writeUInt32LE((bad.readUInt32LE(at) ^ 16) >>> 0, at); assert.throws(() => inspect_reset_mode_wire(bad, result));
    for (const unicode of [0, 1]) assert.throws(() => inspect_reset_mode_wire(b, {...result, logs: {...result.logs, ["MODE" + unicode + ".TXT"]: result.logs["MODE" + unicode + ".TXT"].replace("sizeInside=0", "sizeInside=1")}}));
    assert.throws(() => inspect_reset_mode_wire(b, {...result, logs: {...result.logs, "MODE0.TXT": result.logs["MODE0.TXT"].replace("color=FF50A0C0", "color=FF50A0C1")}}));
    console.log("PASS frozen XP Reset mode: ANSI/Unicode mode/style/message restoration, twelve queued resets, ten successes, two rejected modes, twelve frames and ten semantic corruptions");
})().catch(e => { console.error(e); process.exitCode = 1; });
