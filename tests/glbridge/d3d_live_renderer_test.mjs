#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {create_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";
const P=createRequire(import.meta.url)("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const root=fileURLToPath(new URL("../../",import.meta.url));
const api=process.env.D3D_LIVE_API || "8";assert(["8","9","ddraw"].includes(api));
const prefix=root+"tests/glbridge/fixtures/"+(api==="ddraw" ? "ddraw_rop_dc_" : "d3d"+api+"_state_replay_");
const metadata=JSON.parse(fs.readFileSync(prefix+"xp.json")),reference=fs.readFileSync(prefix+"reference.json"),bytes=gunzipSync(fs.readFileSync(prefix+"xp.bin.gz"));
const hash=b=>createHash("sha256").update(b).digest("hex");
assert.equal(hash(bytes),metadata.traceSha256);assert.equal(hash(reference),metadata.referenceSha256);
const scenes=JSON.parse(reference).scenes,remote=await create_d3d_live_renderer();let frames=0,pixels=0;
try {
    for(let at=0;at<bytes.length;) {
        const ownerToken=bytes.readUInt32LE(at),flags=bytes.readUInt32LE(at+4),size=bytes.readUInt32LE(at+8);
        const packet=bytes.subarray(at+20,at+12+size),pv=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),reads=[];
        for(let x=P.STRUCTS.BatchHeader.size;x<packet.length;) {
            const length=pv.getUint32(x+P.F.CommandHeader.size,true);
            assert(length>=P.STRUCTS.CommandHeader.size && x+length<=packet.length);
            if(pv.getUint16(x,true)===P.OP.READBACK_SURFACE)reads.push(P.decode("ReadbackSurface",pv,x+P.STRUCTS.CommandHeader.size,length-P.STRUCTS.CommandHeader.size));
            x+=length;
        }
        let observed=0;
        await remote.submit({ownerToken,flags,bytes:bytes.subarray(at+12,at+12+size)},(offset,data)=>{
            const request=reads[observed];
            if(!request || offset!==(16<<20)-P.C.D9WG_RESPONSE_REGION_BYTES+request.response_offset)return;
            assert.equal(request.request_id,metadata.frames[frames].request);observed++;
            const view=new DataView(data.buffer,data.byteOffset,data.byteLength),scene=scenes[frames];assert(scene);
            assert.equal(view.getUint32(0,true),metadata.frames[frames].request);assert.equal(view.getUint32(P.F.ReadbackResponse.status,true),P.C.D9WG_RESPONSE_OK);
            assert.equal(data.length,16+scene.pixels.length*4);assert.equal(view.getUint32(4,true),scene.pixels.length*4);
            for(let p=0;p<scene.pixels.length;p++)assert.equal(view.getUint32(16+p*4,true),scene.pixels[p]);
            pixels+=scene.pixels.length;frames++;
        });
        assert.equal(observed,reads.length);at+=12+size;
    }
    assert.equal(frames,scenes.length);
    for(const owner of metadata.ownerReleases)await remote.release(owner);
    await remote.idle();
    assert.equal(remote.stats.snapshot.devices,0);assert.equal(remote.stats.snapshot.resources,0);
    assert.equal(remote.stats.snapshot.cleanup.length,metadata.ownerReleases.length);
    assert(remote.stats.snapshot.cleanup.every(row=>!row.devices&&!row.resources));
    assert.deepEqual(remote.stats.snapshot.gpuErrors,[]);assert.deepEqual(remote.stats.snapshot.hostErrors,[]);
    const output=path.resolve(process.env.D3D_LIVE_OUT || root+"build/d3d-review/live-renderer"+(process.env.GL_SWIFTSHADER==="1"?"-swift":"-metal")+"-"+api+".json");
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({status:"PASS",api,frames,pixels,traceSha256:metadata.traceSha256,...remote.stats},null,2)+"\n");
    console.log("PASS live "+(api==="ddraw"?"DirectDraw":"D3D"+api)+" remote GPU: "+frames+" images / "+pixels+" pixels, exact replies and complete owner cleanup");
} finally {remote.close();}
