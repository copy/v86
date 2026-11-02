"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { gunzipSync } = require("node:zlib"), { createHash } = require("node:crypto");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const directory = path.join(__dirname,"fixtures"), bytes = gunzipSync(fs.readFileSync(path.join(directory,"d3d7_processed_clip_xp.bin.gz")));
const metadata = JSON.parse(fs.readFileSync(path.join(directory,"d3d7_processed_clip_xp.json")));
assert.equal(createHash("sha256").update(bytes).digest("hex"),metadata.traceSha256);
let carrier = 0, frames = 0, processed = false, processedDraws = 0, directDraws = 0, removed = 0;
while (carrier < bytes.length) {
    const size = bytes.readUInt32LE(carrier+8), packet = bytes.subarray(carrier+20,carrier+12+size), header = W.readHeader(packet);
    assert.equal(bytes.readUInt16LE(carrier+12),0xffe1);assert.equal(bytes.readUInt32LE(carrier+16),size-8);
    W.checkStream(header.view,header.end,header.commandCount);
    for (let at = P.STRUCTS.BatchHeader.size;at<header.end;) {
        const opcode = header.view.getUint16(at,true), size = header.view.getUint32(at+P.F.CommandHeader.size,true), payload = at+P.STRUCTS.CommandHeader.size;
        const structure = P.commandStruct(opcode), value = P.decode(structure,header.view,payload,size-P.STRUCTS.CommandHeader.size);
        if (opcode === P.OP.UPDATE_TEXTURE || opcode === P.OP.GUEST_LOG) {
            const first = opcode === P.OP.UPDATE_TEXTURE ? value.data_offset : payload+P.STRUCTS.GuestLog.size;
            const count = opcode === P.OP.UPDATE_TEXTURE ? value.data_bytes : value.text_bytes;
            assert(first>=payload && first+count<=at+size);assert(packet.subarray(first,first+count).every(byte=>byte===0));removed+=count;
        }
        if (opcode === P.OP.SET_FVF) processed = (value.fvf & 0xe) === 4;
        if (opcode === P.OP.END_SCENE) frames++;
        if (opcode === P.OP.DRAW_PRIMITIVE_UP) {
            assert.equal(value.primitive_type,4);assert.equal(value.vertex_bytes,value.vertex_count*value.stride);
            if (processed) {
                processedDraws++;assert.equal(value.stride,20);
                for (let vertex=0;vertex<value.vertex_count;vertex++) {
                    const at=value.vertex_data_offset+vertex*value.stride;
                    for (let c=0;c<4;c++) assert(Number.isFinite(header.view.getFloat32(at+c*4,true)));
                    assert(header.view.getFloat32(at+12,true)>0,"processed homogeneous W must be positive after clipping");
                    assert.equal(header.view.getUint32(at+16,true)>>>24,255);
                }
            } else {directDraws++;assert.equal(value.stride,16);assert.equal(value.vertex_count,3);}
        }
        at+=size;
    }
    carrier+=12+size;
}
assert.equal(carrier,bytes.length);assert.equal(frames,18);assert.equal(directDraws,6);assert.equal(processedDraws,12);
assert.equal(removed,metadata.removedPayloads.reduce((total,item)=>total+item.bytes,0));
const reference=JSON.parse(fs.readFileSync(path.join(directory,"d3d_clip_zero_w_reference.json")));
assert.equal(reference.vertices.length,5);
for (const vertex of reference.vertices) assert(vertex.position.every(Number.isFinite) && vertex.position[3]>0);
console.log("PASS public XP clipping fixture: eighteen real draw calls, positive processed W, unrelated pixel/text payloads absent");
