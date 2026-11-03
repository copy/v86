"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_reset_recording_wire} = await import("../lib/d3d_reset_recording_wire.mjs"), m = require("./fixtures/d3d_reset_recording_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_reset_recording_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_reset_recording_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_reset_recording_wire(b, result), {perAPI: m.perAPI, resources: 24, resets: 26, renderingCommands: 0});
    const targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, expected] of [["width", "ResetDevice", "width", P.OP.RESET], ["old", "ResetDevice", "old_device_handle", P.OP.RESET], ["new", "ResetDevice", "new_device_handle", P.OP.RESET], ["pool", "CreateTexture2D", "pool", P.OP.CREATE_TEXTURE_2D], ["kind", "CreateBuffer", "resource_kind", P.OP.CREATE_BUFFER], ["levels", "CreateTextureCube", "level_count", P.OP.CREATE_TEXTURE_CUBE], ["destroy", "DestroyResource", "resource_handle", P.OP.DESTROY_RESOURCE]]) if (op === expected && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 7);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_reset_recording_wire(bad, result), undefined, name);}
    for (const [api, from, to] of [[8, "family=4 held=1 finalized=1", "family=4 held=1 finalized=0"], [9, "invalid=1 preserved=1", "invalid=1 preserved=0"], [8, "accepted=13", "accepted=12"], [9, "refused=7", "refused=6"]]) assert.throws(() => inspect_reset_recording_wire(b, {...result, logs: {...result.logs, ["REC" + api + ".TXT"]: result.logs["REC" + api + ".TXT"].replace(from, to)}}));
    console.log("PASS frozen XP Reset recording: 26 successful Resets, 24 finalized resources, five families per API, deferred bindings and eleven semantic corruptions");
})().catch(e => {console.error(e); process.exitCode = 1;});
