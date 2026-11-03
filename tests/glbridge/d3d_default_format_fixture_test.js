"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), {gunzipSync} = require("node:zlib");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async () => {
    const {inspect_default_format_wire} = await import("../lib/d3d_default_format_wire.mjs"), m = require("./fixtures/d3d_default_format_xp.json");
    const b = gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/d3d_default_format_xp.bin.gz"))), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), result = {owners: [m.perOwner.owner], logs: m.sdkLogs};
    assert.equal(hash(b), m.traceSha256); assert.equal(hash(fs.readFileSync(path.join(__dirname, "fixtures/d3d_default_format_reference.json"))), m.referenceSha256);
    assert.deepEqual(inspect_default_format_wire(b, result), {perOwner: m.perOwner, deviceLifetimes: 3, resets: 3, additionalChains: 3, backingTextures: 3, fullscreenRefusals: 2, renderingCommands: 0});
    const targets = Object.create(null);
    for (let at = 0; at < b.length;) {
        const size = b.readUInt32LE(at + 8), start = at + 20, end = at + 12 + size;
        for (let x = start + P.STRUCTS.BatchHeader.size; x < end;) {
            const op = b.readUInt16LE(x), length = b.readUInt32LE(x + P.F.CommandHeader.size), p = x + P.STRUCTS.CommandHeader.size;
            for(const[name,kind,field,expected]of[['constructor','CreateDevice','backbuffer_format',P.OP.CREATE_DEVICE],['reset','ResetDevice','backbuffer_format',P.OP.RESET],['old','ResetDevice','old_device_handle',P.OP.RESET],['new','ResetDevice','new_device_handle',P.OP.RESET],['texture','CreateTexture2D','format',P.OP.CREATE_TEXTURE_2D],['textureDevice','CreateTexture2D','device_handle',P.OP.CREATE_TEXTURE_2D],['backing','CreateSwapChain','back_buffer_handle',P.OP.CREATE_SWAP_CHAIN],['chainDestroy','DestroySwapChain','swap_chain_handle',P.OP.DESTROY_SWAP_CHAIN],['deviceDestroy','DestroyResource','resource_handle',P.OP.DESTROY_RESOURCE]])if(op===expected&&!targets[name])targets[name]=p+P.F[kind][field];
            x += length;
        }
        at = end;
    }
    assert.equal(Object.keys(targets).length, 9);
    for (const [name, at] of Object.entries(targets)) {const bad = Buffer.from(b); bad.writeUInt32LE((bad.readUInt32LE(at) ^ 1) >>> 0, at); assert.throws(() => inspect_default_format_wire(bad, result), undefined, name);}
    for(const[from,to]of[['label=constructorUnknown32 format=22','label=constructorUnknown32 format=23'],['label=resetUnknown16 format=23 desktop=23','label=resetUnknown16 format=23 desktop=22'],['invalidFullscreenReset=1','invalidFullscreenReset=0']])assert.throws(()=>inspect_default_format_wire(b,{...result,logs:{'FMT9.TXT':result.logs['FMT9.TXT'].replace(from,to)}}));
    console.log('PASS frozen XP default formats: three device lifetimes/Resets/chains, live 16/32-bit selection, explicit preservation, fullscreen refusals and twelve semantic corruptions');
})().catch(e => {console.error(e); process.exitCode = 1;});
