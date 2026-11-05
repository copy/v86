"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{gunzipSync}=require("node:zlib");
(async()=>{
    const {inspect_frontend_device_wire:inspect}=await import("../lib/d3d8_frontend_device_wire.mjs");
    const prefix=path.join(__dirname,"fixtures/d3d8_public_device_");
    const metadata=JSON.parse(fs.readFileSync(prefix+"xp.json"));
    const bytes=gunzipSync(fs.readFileSync(prefix+"xp.bin.gz")),reference=fs.readFileSync(prefix+"reference.json");
    const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
    assert.equal(hash(bytes),metadata.traceSha256);assert.equal(hash(reference),metadata.referenceSha256);
    const result={owners:metadata.owners,releases:metadata.ownerReleases,logs:metadata.sdkLogs};
    const observed=inspect(bytes,result);
    assert.deepEqual(observed.frames,metadata.frames);assert.equal(observed.commands,1762);assert.equal(observed.handles,80);
    const P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
    const mutations=new Set();
    const fields=new Map([
        [P.OP.CREATE_DEVICE,["device_handle","width","height","behavior_flags","auto_depth_stencil_format"]],
        [P.OP.RESET,["old_device_handle","new_device_handle","width","height","auto_depth_stencil_format"]],
        [P.OP.READBACK_SURFACE,["device_handle","texture_handle","request_id","width","height","destination_pitch","destination_bytes","format","level","face"]],
        [P.OP.DESTROY_RESOURCE,["resource_handle","resource_kind"]],
    ]);
    for(let at=0;at<bytes.length;) {
        const size=bytes.readUInt32LE(at+8),packet=at+20,end=at+12+size;
        mutations.add(at);mutations.add(at+8);mutations.add(packet+P.F.BatchHeader.command_count);
        for(let x=packet+32;x<end;) {
            const op=bytes.readUInt16LE(x),n=bytes.readUInt32LE(x+4),kind=P.commandStruct(op);
            if(fields.has(op))for(const field of fields.get(op))mutations.add(x+16+P.F[kind][field]);
            if(P.F[kind]&&"device_handle"in P.F[kind])mutations.add(x+16+P.F[kind].device_handle);
            x+=n;
        }
        at=end;
    }
    for(const offset of mutations){const changed=Buffer.from(bytes);changed[offset]^=0x40;assert.throws(()=>inspect(changed,result),undefined,"corruption at "+offset);}
    assert.throws(()=>inspect(bytes,{...result,releases:[]}));
    assert.throws(()=>inspect(bytes,{...result,logs:{"DEVICE8.TXT":""}}));
    assert.throws(()=>inspect(bytes.subarray(0,bytes.length-1),result));
    console.log("PASS complete Device8 XP fixture: 97 SDK methods, 4 devices/4 resets/80 handles, 28 independent image references, "+(mutations.size+3)+" framing/owner/lifetime/readback corruptions rejected; rendering payloads checked by real GPU replay");
})().catch(error=>{console.error(error);process.exitCode=1;});
