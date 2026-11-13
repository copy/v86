import assert from "node:assert/strict";
import { test } from "node:test";
import { attach_ios_install_api,persist_install_boot } from "../../src/ios/install_api.js";
import { IOS_TRUST_ARENA_BYTES,IOS_STATIC_TRUST_HEAD } from "../../src/ios/runtime_trust.js";
class Emulator{}attach_ios_install_api(Emulator);
test("public installation methods report legacy support and forward Worker arguments",async()=>{
 const legacy=new Emulator();assert.equal((await legacy.ios_install_status()).supported,false);
 const calls=[],worker=new Emulator();worker.worker_controller={serialize:f=>f(),rpc:(name,args)=>{calls.push([name,args]);return Promise.resolve({});}};
 const chunk=Uint8Array.of(1,2,3);await worker.ios_install_write("task",12,chunk);
 assert.deepEqual(calls,[["ios_install_write",["task",12,chunk]]]);
 const paused=new Emulator();paused.is_running=()=>false;await assert.rejects(paused.ios_install_begin({}),/Resume/);
});
test("a failed durable flush never publishes trust or resumes the CPU",async()=>{
 const key="01".repeat(20),events=[],state={format:"v86-ios-install-state",version:1,build:"10B329",generation:2,token:"aa".repeat(32),system_hashes:[key],apps:[],pending:null};
 const arena={physical:0x41000000,virtual:0x81000000,size:IOS_TRUST_ARENA_BYTES,used:0,head:IOS_STATIC_TRUST_HEAD};
 const ptr=new Uint8Array(4);new DataView(ptr.buffer).setUint32(0,arena.head,true);
 const cpu={read_blob_physical:()=>ptr,devices:{apple_nand:{buffer:{writeback:true,flush:done=>done(new Error("storage unavailable"))}}}};
 const emulator={v86:{cpu},is_running:()=>true,stop:async()=>events.push("stop"),run:async()=>events.push("run")};
 const install={next_boot:{install:state},trusted:new Set([key]),arena,progress:v=>events.push(v),publish_trust:()=>events.push("publish")};
 await assert.rejects(persist_install_boot(emulator,install),/storage unavailable/);
 assert.equal(events[0],"stop");assert.equal(events[1].phase,"interrupted");assert.ok(!events.includes("publish"));assert.ok(!events.includes("run"));
});
