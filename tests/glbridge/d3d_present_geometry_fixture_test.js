"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_present_geometry_wire} = await import("../lib/d3d_present_geometry_wire.mjs"), m = require("./fixtures/d3d_present_geometry_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_present_geometry_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_present_geometry_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_present_geometry_wire(b, result), {perAPI: m.perAPI, frames: m.frames, deviceLifetimes: 2, resets: 4, viewportCommands: 3});
    const targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, expected] of [["createWidth", "CreateDevice", "width", P.OP.CREATE_DEVICE], ["resetWidth", "ResetDevice", "width", P.OP.RESET], ["old", "ResetDevice", "old_device_handle", P.OP.RESET], ["new", "ResetDevice", "new_device_handle", P.OP.RESET], ["depth", "ResetDevice", "auto_depth_stencil_format", P.OP.RESET], ["viewport", "SetViewport", "width", P.OP.SET_VIEWPORT], ["color", "Clear", "color", P.OP.CLEAR], ["present", "Present", "width", P.OP.PRESENT], ["destroy", "DestroyResource", "resource_handle", P.OP.DESTROY_RESOURCE]]) if (op === expected && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 9);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_present_geometry_wire(bad, result), undefined, name);}
    for(const [api,from,to]of[[8,'callerWidth=0','callerWidth=128'],[9,'callerWidth=128','callerWidth=0'],[8,'count=1','count=0']])assert.throws(()=>inspect_present_geometry_wire(b,{...result,logs:{...result.logs,['GEO'+api+'.TXT']:result.logs['GEO'+api+'.TXT'].replace(from,to)}}));
    console.log('PASS frozen XP present geometry: six frames, four Resets, guest viewport/color/depth and version-specific caller parameters, twelve semantic corruptions');
})().catch(e => {console.error(e); process.exitCode = 1;});
