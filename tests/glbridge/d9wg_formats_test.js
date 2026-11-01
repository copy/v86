"use strict";
const assert = require("node:assert/strict");
const F = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js");
const native = Uint8Array.from([0x33, 0x66, 0x99, 0x80, 0x40, 0x20, 0x10, 0xff]), copied = new Uint8Array(8);
F.expandRowToGPU(21, native, 0, 2, copied, 0);assert.deepEqual(copied, native);
assert.equal(F.formatToGPU(21), "bgra8unorm");assert.equal(F.isRenderableGPUFormat("bgra8unorm"), true);
const readback = new Uint8Array(8);F.packGPUReadbackRow(21, "bgra8unorm", copied, 0, 2, readback, 0);assert.deepEqual(readback, native);
const packed = new Uint8Array(65536 * 2), rgba = new Uint8Array(65536 * 4), roundtrip = new Uint8Array(packed.length);
for (let i = 0; i < 65536; i++) new DataView(packed.buffer).setUint16(i * 2, i, true);
F.expandRowToGPU(23, packed, 0, 65536, rgba, 0);
// R=4, G=16, B=4: exact widened bytes, including the replicated low bits.
assert.deepEqual([...rgba.subarray(0x2204 * 4, 0x2204 * 4 + 4)], [33, 65, 33, 255]);
F.packGPUReadbackRow(23, "rgba8unorm", rgba, 0, 65536, roundtrip, 0);assert.deepEqual(roundtrip, packed);
const rg16 = new Uint8Array(8);F.expandRowToGPU(34, Uint8Array.of(0xff, 0xff, 0, 0), 0, 1, rg16, 0);
assert.deepEqual([...rg16], [0, 0x3c, 0, 0, 0, 0x3c, 0, 0x3c]);
for (const format of [111, 112, 113]) {
    const bpp = F.gpuBytesPerTexel(format), source = Uint8Array.from([1, 0x7e, 0, 0xfc, 0x01, 0x80, 0x55, 0x7c].slice(0, bpp));
    const upload = new Uint8Array(bpp), readback = new Uint8Array(bpp);
    F.expandRowToGPU(format, source, 0, 1, upload, 0);assert.deepEqual(upload, source);
    F.packGPUReadbackRow(format, F.formatToGPU(format), upload, 0, 1, readback, 0);assert.deepEqual(readback, source, "NaN/Inf/-0 half payloads stay exact");
}
for (const format of [111, 112, 113, 114, 115, 116]) assert(F.formatToGPU(format));
assert.equal(F.formatToGPU(0xffffffff), null);
assert.deepEqual(F.nativeFillRGBA(23, 0x2204).map(v => Math.round(v * 255)), [33, 65, 33, 255]);
assert.deepEqual(F.nativeFillRGBA(22, 0x996633).map(v => Math.round(v * 255)), [153, 102, 51, 255]);
assert.deepEqual(F.nativeFillRGBA(21, 0x80996633).map(v => Math.round(v * 255)), [153, 102, 51, 128]);
console.log("D9WG formats: native BGRA upload/readback, all 65536 RGB565 round trips and missing channels checked");
