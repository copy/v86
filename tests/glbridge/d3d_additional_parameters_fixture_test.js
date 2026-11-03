"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_additional_parameters_wire} = await import("../lib/d3d_additional_parameters_wire.mjs"), m = require("./fixtures/d3d_additional_parameters_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_additional_parameters_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: m.perAPI.map(s => s.owner), logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_additional_parameters_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_additional_parameters_wire(b, result), {perAPI: m.perAPI, deviceLifetimes: 2, successfulSDKChains: 4, hostChains: 2, backingTextures: 2, refusedCounts: 2, renderingCommands: 0});
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
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_additional_parameters_wire(bad, result), undefined, name);}
    for(const[api,from,to]of[[8,'callerWidth=0','callerWidth=96'],[9,'callerNull=1','callerNull=0'],[8,'refused=1','refused=0']])assert.throws(()=>inspect_additional_parameters_wire(b,{...result,logs:{...result.logs,['ACP'+api+'.TXT']:result.logs['ACP'+api+'.TXT'].replace(from,to)}}));
    console.log('PASS frozen XP additional parameters: four SDK chains, two GPU chains/textures retired, stable creation geometry, count refusal and ten semantic corruptions');
})().catch(e => {console.error(e); process.exitCode = 1;});
