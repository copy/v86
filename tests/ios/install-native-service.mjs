// Owner-provided firmware only. Exercises the public API against the real
// native helper and a disposable, persistent NAND image.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { V86 } from "../../src/main.js";
import { prepare_ipa } from "../../src/ios/ipa_prepare.js";
const [directory,source]=process.argv.slice(2);
if(!directory||!source)throw new Error("usage: install-native-service.mjs disposable-service-probe app.ipa");
const input=fs.readFileSync(source),chunks=[];
const manifest=await prepare_ipa((at,n)=>input.subarray(at,at+n),input.length,b=>chunks.push(b),{graphics:!process.env.IPA_NO_GLES});
const ipa=Buffer.concat(chunks),nand=path.resolve(directory,"flash.img");
const renderer=process.env.IPA_NO_GLES?null:await(await import("../gles/chrome_renderer.mjs")).chrome_renderer();
const emulator=new V86({machine_type:"s5l8930",graphics_adapter:"none",log_level:0,autostart:true,
    gles_backdoor:!!renderer,graphics_adapter_renderer_channel:renderer,wasm_path:"build/v86-arm64.wasm",
    ios:{nand_boot:true,nand:{url:nand,size:fs.statSync(nand).size,disk_option:"read_write"},boot_args:"-v serial=3 rd=disk0s1s1"}});
let serial="",timer;const start=performance.now();
emulator.add_listener("serial0-output-byte",b=>serial+=String.fromCharCode(b));
emulator.add_listener("ios-install-progress",event=>console.log("installer",JSON.stringify(event)));
try{
 await new Promise((ok,no)=>{emulator.add_listener("emulator-loaded",ok);emulator.add_listener("emulator-error",no);});
 timer=setInterval(async()=>{
  fs.writeFileSync(path.join(directory,"serial.log"),serial);
  console.log(Math.round((performance.now()-start)/1000)+"s",await emulator.ios_install_status());
  if(process.env.IPA_DUMP_RAM){const c=emulator.v86.cpu;fs.writeFileSync(path.join(directory,"ram.bin"),Buffer.from(c.mem8.buffer,c.mem8.byteOffset,c.mem8.length));}
 },30000);
 const until=performance.now()+1200000;
 while(!(await emulator.ios_install_status()).available){
  assert.ok(performance.now()<until,"Native helper did not authenticate");assert.ok(!serial.includes("panic(cpu"),serial.slice(-4000));
  if(fs.existsSync(path.join(directory,"STOP")))throw new Error("Stopped diagnostic run");
  await new Promise(ok=>setTimeout(ok,1000));
 }
 const task=await emulator.ios_install_begin(manifest);console.log("begin",task);
 for(let at=0;at<ipa.length;at+=65536)await emulator.ios_install_write(task.install_id,at,ipa.subarray(at,at+65536));
 await emulator.ios_install_stage(task.install_id);
 const result=await emulator.ios_install_commit(task.install_id);assert.equal(result.installed,true);
 const found=await emulator.ios_install_lookup(manifest.bundle_id);assert.equal(found.installed,true);
 console.log("PASS: authenticated native transfer, durable trust publication, installation and exact application lookup");
}finally{
 clearInterval(timer);fs.writeFileSync(path.join(directory,"serial.log"),serial);
 try{await emulator.destroy();}finally{renderer?.close();}
}
