"use strict";
const assert = require("node:assert/strict"), Uploads = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_uploads.js");
const retired = [], stats = {}, device = {
    createBuffer(descriptor) { assert.equal(descriptor.usage, 12);return { descriptor, data: new Uint8Array(descriptor.size) }; },
    queue: { writeBuffer(buffer, offset, data, at, count) { buffer.data.set(data.subarray(at, at + count), offset); } },
};
const ring = new Uploads(device, b => retired.push(b), stats), destination = {};
const input = Uint8Array.of(1, 2, 3, 4), first = ring.buffer(destination, 8, input);input.fill(99);
const second = ring.buffer(destination, 12, Uint8Array.of(5, 6, 7, 8));
assert.equal(second.sourceOffset % 256, 0);assert.equal(first.source, second.source);
const texture = ring.texture({ texture: {} }, Uint8Array.of(10, 11, 12, 13, 20, 21, 22, 23),
    { bytesPerRow: 4, rowsPerImage: 2 }, { width: 1, height: 2, depthOrArrayLayers: 1 });
ring.flush();
assert.deepEqual([...first.source.data.subarray(first.sourceOffset, first.sourceOffset + 4)], [1, 2, 3, 4], "arena input is copied at recording time");
assert.deepEqual([...texture.source.buffer.data.subarray(texture.source.offset + 256, texture.source.offset + 260)], [20, 21, 22, 23]);
const seen = [];
ring.replay({ copyBufferToBuffer(...args) { seen.push(args); } }, first);assert.equal(seen[0][2], destination);
ring.replay({ copyBufferToTexture(...args) { seen.push(args); } }, texture);assert.equal(seen[1][0].bytesPerRow, 256);
ring.reserve(4 << 20);assert.equal(ring.chunks.length, 2, "overflow advances to a distinct live chunk");
ring.reset();const reused = ring.buffer(destination, 0, Uint8Array.of(9, 8, 7, 6));assert.equal(reused.sourceOffset, 0);assert.equal(reused.source, first.source);
ring.reset();ring.reserve(9 << 20);assert.equal(retired[0], first.source, "growing a pooled chunk retires its old GPU allocation");
ring.release();assert.equal(retired.length, 3);assert.equal(ring.chunks.length, 0);
console.log("D9WG uploads: input lifetime, padded rows, ordered copies, pooled reuse/growth and owner retirement checked");
