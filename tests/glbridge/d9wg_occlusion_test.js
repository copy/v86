"use strict";
const assert = require("node:assert/strict");
const {countedDrawSegments, counterFitsFormats} = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_frame_replayer.js");
function primitives(topology, first, count) {
    const list = [];
    if (topology === "triangle-strip") {
        for (let i=0;i+2<count;i++) list.push(i&1 ? [first+i+1,first+i,first+i+2] : [first+i,first+i+1,first+i+2]);
    } else if (topology === "line-strip") {
        for (let i=0;i+1<count;i++) list.push([first+i,first+i+1]);
    } else {
        const width = topology === "triangle-list" ? 3 : topology === "line-list" ? 2 : 1;
        for (let i=0;i+width<=count;i+=width) list.push(Array.from({length:width},(_,j)=>first+i+j));
    }
    return list;
}
let checks = 0;
for (const topology of ["point-list","line-list","line-strip","triangle-list","triangle-strip"])
    for (const count of [0,1,2,3,4,257,258,259,515,903]) for (const instances of [1,3,257]) {
        const original = primitives(topology,0,count), expected=[], actual=[];
        for (let i=0;i<instances;i++) for (const triangle of original) expected.push([i,...triangle]);
        for (const segment of countedDrawSegments(topology,count,instances)) {
            const rendered = primitives(topology,segment.first,segment.count);
            assert(rendered.length*segment.instanceCount<=256,"half-float counter precision budget");
            for (let i=0;i<segment.instanceCount;i++) for (const triangle of rendered) actual.push([segment.firstInstance+i,...triangle]);
        }
        assert.deepEqual(actual,expected,topology+" primitive and instance order");++checks;
    }
assert(counterFitsFormats(["rgba8unorm","rgba8unorm","rgba8unorm","rgba8unorm"],{maxColorAttachmentBytesPerSample:64}));
assert(!counterFitsFormats(["rgba8unorm","rgba8unorm","rgba8unorm","rgba8unorm"],{maxColorAttachmentBytesPerSample:32}));
assert(!counterFitsFormats(new Array(4).fill("rgba32float"),{maxColorAttachmentBytesPerSample:64}));
assert(counterFitsFormats(new Array(4).fill("rgba32float"),{maxColorAttachmentBytesPerSample:128}));
assert(!counterFitsFormats(["rgba8unorm"],{maxColorAttachments:1,maxColorAttachmentBytesPerSample:64}));
assert(counterFitsFormats([],{maxColorAttachmentBytesPerSample:32}));
console.log("PASS exact occlusion topology: "+checks+" primitive/instance sequences, strip winding and adapter attachment bounds");
