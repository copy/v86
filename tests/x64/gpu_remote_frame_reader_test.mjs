#!/usr/bin/env node
import assert from "node:assert/strict";
import {frame_reader} from "./gpu_remote_renderer.mjs";

function wire(bytes,{fin=true,opcode=2,masked=true}={})
{
    const count=bytes.length,extended=count<126?0:count<65536?2:8;
    const header=Buffer.alloc(2+extended+(masked?4:0));header[0]=(fin?128:0)|opcode;
    header[1]=(masked?128:0)|(extended===0?count:extended===2?126:127);
    if(extended===2)header.writeUInt16BE(count,2);
    if(extended===8)header.writeBigUInt64BE(BigInt(count),2);
    const payload=Buffer.from(bytes),mask=[0x19,0xA3,0x57,0xD1];
    if(masked)
    {
        header.set(mask,2+extended);
        for(let i=0;i<count;i++)payload[i]^=mask[i&3];
    }
    return Buffer.concat([header,payload]);
}
for(const size of [0,1,125,126,257])
{
    const expected=Buffer.from(Array.from({length:size},(_,i)=>(i*73+11)&255)),encoded=wire(expected);
    for(let split=0;split<=encoded.length;split++)
    {
        const messages=[],read=frame_reader(message=>messages.push(message));
        read(encoded.subarray(0,split));read(encoded.subarray(split));
        assert.deepEqual(messages,[expected],"every two-chunk header/payload split");
    }
    const messages=[],read=frame_reader(message=>messages.push(message));
    for(const byte of encoded)read(Buffer.of(byte));
    assert.deepEqual(messages,[expected],"one-byte socket chunks");
}
{
    const messages=[],read=frame_reader(message=>messages.push(message));
    const stream=Buffer.concat([wire(Buffer.from("first"),{fin:false}),wire(Buffer.from("ignored"),{opcode:9}),
        wire(Buffer.from(" second"),{opcode:0}),wire(Buffer.from("third"),{masked:false}),wire(Buffer.alloc(0),{opcode:8})]);
    for(let at=0;at<stream.length;at+=3)read(stream.subarray(at,at+3));
    assert.deepEqual(messages,[Buffer.from("first second"),Buffer.from("third"),null],"continuations, ignored control frames, unmasked messages and close");
}
{
    const expected=Buffer.alloc(4*1024*1024+7);
    for(let i=0;i<expected.length;i++)expected[i]=(i*29+(i>>>12))&255;
    const encoded=wire(expected),messages=[],read=frame_reader(message=>messages.push(message));
    for(let at=0;at<encoded.length;at+=32749)
    {
        const chunk=Buffer.from(encoded.subarray(at,at+32749));read(chunk);chunk.fill(0);
    }
    assert.deepEqual(messages,[expected],"64-bit length, buffer growth and independent input ownership");
    read(wire(Buffer.from("later")));
    assert.deepEqual(messages,[expected,Buffer.from("later")],"completed messages survive buffer reuse");
}
{
    const messages=[],read=frame_reader(message=>messages.push(message));
    const second=wire(Buffer.alloc(8000,9));
    read(Buffer.concat([wire(Buffer.alloc(60000,7)),second.subarray(0,333)]));read(second.subarray(333));
    assert.deepEqual(messages,[Buffer.alloc(60000,7),Buffer.alloc(8000,9)],"consume and reuse the receive buffer");
}
console.log("PASS: remote GPU WebSocket header splits, fragmentation, masking, close, large readbacks and ownership");
