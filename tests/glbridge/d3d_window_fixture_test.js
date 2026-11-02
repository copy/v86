"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{gunzipSync}=require("node:zlib"),P=require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
(async()=>{
 const {inspect_window_wire}=await import("../lib/d3d_window_wire.mjs"),metadata=require("./fixtures/d3d_window_state_xp.json"),bytes=gunzipSync(fs.readFileSync(path.join(__dirname,"fixtures/d3d_window_state_xp.bin.gz"))),result={owners:Object.keys(metadata.apiByOwner).map(Number),logs:metadata.win32Logs};
 assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),metadata.traceSha256);const wire=inspect_window_wire(bytes,metadata.batchPhases,result);assert.deepEqual(wire.steps,metadata.steps);assert.equal(wire.windowReports,27);assert.equal(wire.steps.length,22);
 for(const [api,phase,field]of [[9,2,"window_x"],[9,3,"client_width"],[8,5,"foreground_hwnd"],[7,8,"flags"]]){
  const corrupted=Buffer.from(bytes);let at=0,index=0,changed=0;
  while(at<corrupted.length){const size=corrupted.readUInt32LE(at+8),batch=metadata.batchPhases[index++],owner=corrupted.readUInt32LE(at),start=at+20,end=at+12+size;if(metadata.apiByOwner[owner]===api&&batch.phase===phase)for(let x=start+P.STRUCTS.BatchHeader.size;x<end;){const op=corrupted.readUInt16LE(x),length=corrupted.readUInt32LE(x+P.F.CommandHeader.size);if(op===P.OP.WINDOW_STATE){const address=x+P.STRUCTS.CommandHeader.size+P.F.WindowState[field];corrupted.writeUInt32LE(corrupted.readUInt32LE(address)^(field==="flags"?32:1),address);changed++;}x+=length;}at=end;
  }
  assert(changed);assert.throws(()=>inspect_window_wire(corrupted,metadata.batchPhases,result),/no window report matching independent Win32 state/,field+" corruption must be a semantic failure");
 }
 console.log("PASS frozen XP window fixture: trace SHA, 22 independent Win32 steps, 27 reports and four geometry/foreground/no-surface corruptions");
})().catch(error=>{console.error(error);process.exitCode=1});
