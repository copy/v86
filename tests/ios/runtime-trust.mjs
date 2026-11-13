import assert from "node:assert/strict";
import { test } from "node:test";
import { IOS_TRUST_ARENA_BYTES,IOS_TRUST_HEAD_PHYSICAL,IOS_STATIC_TRUST_HEAD,runtime_trust_node,publish_runtime_trust } from "../../src/ios/runtime_trust.js";
function setup(){
    const arena={physical:0x41000000,virtual:0x81000000,size:IOS_TRUST_ARENA_BYTES,used:0,head:IOS_STATIC_TRUST_HEAD};
    const ram=new Map(),writes=[];const pointer=new Uint8Array(4);new DataView(pointer.buffer).setUint32(0,arena.head,true);ram.set(IOS_TRUST_HEAD_PHYSICAL,pointer);
    const cpu={read_blob_physical:(at,n)=>ram.get(at).slice(0,n),write_blob_physical:(b,at)=>{writes.push(at);ram.set(at,b.slice());}};
    return {arena,ram,writes,cpu};
}
test("AMFI publication links immutable nodes and publishes the head last",()=>{
    const s=setup();publish_runtime_trust(s.cpu,s.arena,["02".repeat(20),"01".repeat(20),"01".repeat(20)]);
    const first=s.ram.get(0x41000000),copy=first.slice(),v=new DataView(first.buffer);
    assert.equal(v.getUint32(0,true),IOS_STATIC_TRUST_HEAD);assert.equal(v.getUint32(20,true),2);
    assert.deepEqual([...first.subarray(24,44)],new Array(20).fill(1));assert.deepEqual(s.writes,[0x41000000,IOS_TRUST_HEAD_PHYSICAL]);
    const next=s.arena.physical+s.arena.used;publish_runtime_trust(s.cpu,s.arena,["03".repeat(20)]);
    assert.deepEqual(first,copy);assert.equal(new DataView(s.ram.get(next).buffer).getUint32(0,true),0x81000000);
    assert.equal(new DataView(s.ram.get(IOS_TRUST_HEAD_PHYSICAL).buffer).getUint32(0,true),s.arena.head);
});
test("invalid, full or externally modified arenas fail before any RAM write",()=>{
    const s=setup();assert.throws(()=>runtime_trust_node({...s.arena,physical:0},["01".repeat(20)]),/Invalid/);
    assert.throws(()=>runtime_trust_node({...s.arena,used:IOS_TRUST_ARENA_BYTES,head:s.arena.virtual},["01".repeat(20)]),/Restart/);
    s.ram.get(IOS_TRUST_HEAD_PHYSICAL).fill(0);assert.throws(()=>publish_runtime_trust(s.cpu,s.arena,["01".repeat(20)]),/changed/);
    assert.deepEqual(s.writes,[]);
});
