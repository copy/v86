import assert from "node:assert/strict";
import {setImmediate as tick} from "node:timers/promises";
import {attach_d3d_live_renderer} from "../lib/d3d_live_renderer.mjs";
function fixture(options) {
    const sent=[];let listener,closes=0;
    const live=attach_d3d_live_renderer({renderer:{listen(fn){listener=fn;},post(message){sent.push(message);}},close(){closes++;}},options);
    return {live,sent,reply:message=>listener(message),get closes(){return closes;}};
}
const message=(owner,generation)=>({ownerToken:owner,generation,flags:7,bytes:Uint8Array.of(1,2,3)});
{
    const f=fixture(),writes=[];
    const a=f.live.submit(message(31,1),(offset,bytes)=>writes.push([1,offset,...bytes]));
    const b=f.live.submit(message(32,2),(offset,bytes)=>writes.push([2,offset,...bytes]));
    const c=f.live.release(31);await tick();assert.equal(f.sent.length,1);
    assert.equal(f.sent[0].bytes.readUInt32LE(0),31);assert.equal(f.sent[0].bytes.readUInt32LE(4),7);
    assert.deepEqual([...f.sent[0].bytes.subarray(8)],[1,2,3]);
    f.reply({type:"write",offset:100,bytes:[9]});f.reply({type:"done",seq:1});await a;await tick();
    assert.equal(f.sent.length,2);assert.equal(f.sent[1].bytes.readUInt32LE(0),32);
    f.reply({type:"write",offset:101,bytes:[8]});f.reply({type:"done",seq:2});await b;await tick();
    assert.equal(f.sent.length,3);assert.equal(f.sent[2].bytes.length,8);assert.equal(f.sent[2].bytes.readUInt32LE(4),0xffffffff);
    f.reply({type:"done",seq:3});await c;await f.live.idle();assert.deepEqual(writes,[[1,100,9],[2,101,8]]);
    assert.deepEqual([f.live.stats.batches,f.live.stats.releases,f.live.stats.writes],[2,1,2]);f.live.close();assert.equal(f.closes,1);
}
for(const kind of ["lost","sequence","write","timeout","close","release-write"]) {
    const f=fixture({batch_timeout:20}),error=new Error("write failed");
    const work=kind==="release-write" ? f.live.release(31) : f.live.submit(message(31,1),()=>{throw error;});
    const rejected=assert.rejects(work,/lost|sequence|write failed|timed out|closed|Unexpected write/);
    const queued=f.live.submit(message(32,2),()=>assert.fail("stale generation write"));
    const queued_rejected=assert.rejects(queued);
    await tick();
    if(kind==="lost")f.reply({type:"lost",reason:"GPU lost"});
    if(kind==="sequence")f.reply({type:"done",seq:99});
    if(kind==="write"||kind==="release-write")f.reply({type:"write",offset:0,bytes:[]});
    if(kind==="close")f.live.close();
    await rejected;await queued_rejected;await assert.rejects(f.live.idle());assert.equal(f.sent.length,1);
    if(kind==="lost")assert.equal(f.live.stats.failure,"GPU lost","retain failure even when the previous snapshot was clean");
    if(kind!=="close")f.live.close();
}
{
    const f=fixture();f.reply({type:"done",seq:1});await assert.rejects(f.live.idle(),/without an active batch/);f.live.close();
    await assert.rejects(f.live.submit(message(1,1),()=>{}));
}
console.log("PASS live GPU queue: ordered owner/generation writes, release, six failure paths, no false completion or queued work after failure");
