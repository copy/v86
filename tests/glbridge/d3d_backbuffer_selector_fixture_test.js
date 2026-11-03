"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_backbuffer_selector_wire} = await import("../lib/d3d_backbuffer_selector_wire.mjs"), m = require("./fixtures/d3d_backbuffer_selector_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_backbuffer_selector_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_backbuffer_selector_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_backbuffer_selector_wire(b, result), {perAPI: m.perAPI, deviceLifetimes: 2, successfulQueries: 15, invalidQueries: 30, nullQueries: 15, preservedOutputs: 30, renderingCommands: 0});
    const targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for (const [name, kind, field, expected] of [["width", "CreateDevice", "width", P.OP.CREATE_DEVICE], ["pool", "CreateTexture2D", "pool", P.OP.CREATE_TEXTURE_2D], ["device", "CreateSwapChain", "device_handle", P.OP.CREATE_SWAP_CHAIN], ["backing", "CreateSwapChain", "back_buffer_handle", P.OP.CREATE_SWAP_CHAIN], ["chainWidth", "CreateSwapChain", "width", P.OP.CREATE_SWAP_CHAIN], ["chainDestroy", "DestroySwapChain", "swap_chain_handle", P.OP.DESTROY_SWAP_CHAIN], ["kind", "DestroyResource", "resource_kind", P.OP.DESTROY_RESOURCE]]) if (op === expected && !targets[name]) targets[name] = p + P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 7);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_backbuffer_selector_wire(bad, result), undefined, name);}
    for(const [api,from,to]of[[8,'invalid=10','invalid=9'],[9,'preserved=10','preserved=0']])assert.throws(()=>inspect_backbuffer_selector_wire(b,{...result,logs:{...result.logs,['SEL'+api+'.TXT']:result.logs['SEL'+api+'.TXT'].replace(from,to)}}));
    console.log('PASS frozen XP backbuffer selectors: fifteen successful queries, thirty preserved invalid outputs, fifteen NULL refusals, two retired devices and nine semantic corruptions');
})().catch(e => {console.error(e); process.exitCode = 1;});
