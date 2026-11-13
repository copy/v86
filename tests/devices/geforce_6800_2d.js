#!/usr/bin/env node
import assert from "node:assert/strict";
import { NVDMA } from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import { NVGraph } from "../../src/graphics_adapters/geforce_6800/nv_graph.js";
import { NVTrace } from "../../src/graphics_adapters/geforce_6800/nv_trace.js";
const vram = new Uint8Array(2 << 20), ram = new Uint8Array(64 << 10), ramin = new DataView(vram.buffer, 1 << 20);
const device = { vram: () => vram, vram_size: vram.length, registers: new Map([[0x200, 0xFFFFFFFF], [0x400720, 1]]),
    trace: new NVTrace(), time: () => 0x123456780n, update_irq() {}, vga: { lfb_region: 1 },
    machine: { is_bus_master: () => true, mmio_ram_mark_dirty() {},
        validate_physical_range(at, n) { if(at < 0 || at + n > ram.length) throw new RangeError("RAM"); },
        read_physical: (at, n) => ram.slice(at, at + n), write_physical: (bytes, at) => ram.set(bytes, at) } };
device.dma = new NVDMA(device);
const graph = new NVGraph(device), engine = graph.engine2d;
function word(at, value) { ramin.setUint32(at, value >>> 0, true); }
function object(at, type, methods) { word(at, type); const o = graph.object(0, at); o.methods = new Map(methods); return o; }
function dma(at, flags, limit, pte) { word(at, flags); word(at + 4, limit); word(at + 8, pte); }
function call(o, at, value) { assert(engine.method(o, at, value)); }
const surface = object(0x5000, 0x3062, [[0x184, 0x100], [0x188, 0x100], [0x300, 10], [0x304, 0x200020], [0x308, 0], [0x30C, 0]]);
dma(0x1000, 0x303D, 4095, 0x3); dma(0x1100, 0x2303D, 4095, 0x1002); dma(0x1200, 0x3003, 31, 0x8002);
const rop = object(0x5100, 0x43, [[0x300, 0xCC]]);
const gdi = object(0x5200, 0x4A, [[0x198, 0x500], [0x18C, 0x510], [0x2FC, 1], [0x3FC, 0x12345678]]);
call(gdi, 0x400, 2 << 16 | 1); call(gdi, 0x404, 3 << 16 | 2);
const view = new DataView(vram.buffer);
for(let y = 0; y < 4; y++) for(let x = 0; x < 8; x++) assert.equal(view.getUint32(y * 32 + x * 4, true), x >= 2 && x < 5 && y >= 1 && y < 3 ? 0x12345678 : 0);
// Exhaust the ROP3 truth table for all eight combinations of P,S,D.
for(let code = 0; code < 256; code++) for(let combo = 0; combo < 8; combo++)
    assert.equal(engine.rop(code, combo & 2 ? 0xFFFFFFFF : 0, combo & 1 ? 0xFFFFFFFF : 0, combo & 4 ? 0xFFFFFFFF : 0), code & 1 << combo ? 0xFFFFFFFF : 0);
for(let i = 0; i < 8; i++) view.setUint32(i * 4, i + 1, true);
const blit = object(0x5300, 0x9F, [[0x19C, 0x500], [0x2FC, 3], [0x300, 0], [0x304, 2]]);
call(blit, 0x308, 1 << 16 | 6);
assert.deepEqual(Array.from({length:8}, (_, i) => view.getUint32(i * 4, true)), [1,2,1,2,3,4,5,6], "overlap uses original source");
const clip = object(0x5400, 0x19, [[0x300, 1 << 16 | 3], [0x304, 1 << 16 | 2]]);
blit.methods.set(0x188, 0x540); blit.methods.set(0x304, 1 << 16); call(blit, 0x308, 1 << 16 | 8);
assert.equal(view.getUint32(32 + 3 * 4, true), 2, "clip adjusts source origin");
// 8-bit and 16-bit destinations use exactly their pixel width.
for(const [format, bpp, color] of [[1, 1, 0xAB], [4, 2, 0xBEEF]])
{
    vram.fill(0, 0, 128); surface.methods.set(0x300, format); gdi.methods.set(0x3FC, color);
    call(gdi, 0x400, 0); call(gdi, 0x404, 1 << 16 | 1);
    assert.equal(bpp === 1 ? vram[0] : view.getUint16(0, true), color); assert.equal(vram[bpp], 0);
}
const copy = object(0x5500, 0x39, [[0x180, 0x120], [0x184, 0x110], [0x188, 0x100],
    [0x30C, 8], [0x310, 128], [0x314, 16], [0x318, 12], [0x31C, 5], [0x320, 3], [0x324, 0x101]]);
ram.set(Array.from({length:64}, (_, i) => i + 1), 0x1000); vram.fill(255, 0x8000, 0x8020);
call(copy, 0x328, 0);
for(let y = 0; y < 3; y++) assert.deepEqual(vram.slice(128 + y * 12, 133 + y * 12), ram.slice(0x1008 + y * 16, 0x100D + y * 16));
assert.equal(view.getBigUint64(0x8010, true), device.time()); assert.equal(view.getUint32(0x801C, true), 0);
assert.equal(view.getUint32(0x800C, true), 0xFFFFFFFF, "M2MF writes notifier at 0x10 only");
vram.fill(77, 128, 160); word(0x1004, 140);
assert.throws(() => call(copy, 0x328, 0), RangeError);
assert.deepEqual([...vram.subarray(128, 160)], Array(32).fill(77), "late row fault leaves whole transfer unchanged");
assert.equal(engine.method(gdi, 0x2000, 1), false);
word(0x1004, 4095); surface.methods.set(0x300, 4); vram.fill(0, 0, 128);
const ifc = object(0x5600, 0x308A, [[0x19C, 0x500], [0x2FC, 3], [0x300, 1], [0x304, 0], [0x308, 2 << 16 | 2]]);
call(ifc, 0x30C, 2 << 16 | 3);
call(ifc, 0x400, 0x07E0F800);
const streamState = graph.get_state(); graph.set_state(streamState);
const resumed = graph.object(0, 0x5600);
call(resumed, 0x400, 0xDEAD001F); // third pixel cropped; high word is row padding
call(resumed, 0x400, 0xFFFF001F); call(resumed, 0x400, 0xBEEF0000);
assert.equal(view.getUint16(0, true), 0xF800); assert.equal(view.getUint16(2, true), 0x07E0);
assert.equal(view.getUint16(4, true), 0); assert.equal(view.getUint16(32, true), 0x001F);
assert.equal(view.getUint16(34, true), 0xFFFF); assert.equal(view.getUint16(36, true), 0);
// Transparent and opaque monochrome streams, including byte bit order and clipping.
const mono = graph.object(0, 0x5200);
mono.methods.set(0x3FC, 0); mono.methods.set(0x7F4, 0xFFFF); mono.methods.set(0x7F8, 1 << 16 | 8);
mono.methods.set(0x7EC, 0); mono.methods.set(0x7F0, 4 << 16 | 8); mono.methods.set(0x304, 2);
call(mono, 0x7FC, 2 << 16); call(mono, 0x800, 5);
assert.equal(view.getUint16(64, true), 0xFFFF); assert.equal(view.getUint16(66, true), 0);
assert.equal(view.getUint16(68, true), 0xFFFF);
mono.methods.set(0xBE4, 0); mono.methods.set(0xBE8, 4 << 16 | 8);
mono.methods.set(0xBEC, 0xF800); mono.methods.set(0xBF0, 0x07E0);
mono.methods.set(0xBF4, 1 << 16 | 8); mono.methods.set(0xBF8, 1 << 16 | 8); mono.methods.set(0x304, 1);
call(mono, 0xBFC, 3 << 16); call(mono, 0xC00, 0x80);
assert.equal(view.getUint16(96, true), 0x07E0); assert.equal(view.getUint16(98, true), 0xF800);
const target = graph.object(0, 0x5000); target.methods.set(0x300, 10); target.methods.set(0x30C, 256);
view.setUint32(0x1000, 0xFFFF0000, true); view.setUint32(0x1004, 0xFF00FF00, true);
view.setUint32(0x1008, 0xFF0000FF, true); view.setUint32(0x100C, 0xFFFFFFFF, true);
const scale = object(0x5700, 0x89, [[0x184, 0x100], [0x198, 0x500], [0x300, 3], [0x304, 3],
    [0x308, 0], [0x30C, 4 << 16 | 4], [0x310, 0], [0x314, 4 << 16 | 4], [0x318, 0x80000], [0x31C, 0x80000],
    [0x400, 2 << 16 | 2], [0x404, 1 << 16 | 8], [0x408, 0x1000]]);
word(0x1004, 0x1FFF); call(scale, 0x40C, 0);
assert.equal(view.getUint32(256, true), 0xFFFF0000); assert.equal(view.getUint32(268, true), 0xFF00FF00);
assert.equal(view.getUint32(352, true), 0xFF0000FF); assert.equal(view.getUint32(364, true), 0xFFFFFFFF);
scale.methods.set(0x404, 1 << 24 | 1 << 16 | 8); call(scale, 0x40C, 0);
assert.equal(view.getUint32(256 + 32 + 4, true), 0xFF9F4040, "bilinear interpolation samples pixel centers");
assert.deepEqual(engine.sample(new Uint8Array([16,128,235,128]), 2, 1, 4, 5, 0, 0), [0,0,0,255]);
assert.deepEqual(engine.sample(new Uint8Array([16,128,235,128]), 2, 1, 4, 5, 1, 0), [255,255,255,255]);
assert.deepEqual(engine.sample(new Uint8Array([128,16,128,235]), 2, 1, 4, 6, 1, 0), [255,255,255,255]);
const swz = object(0x5800, 0x309E, [[0x184, 0x100], [0x300, 1 << 24 | 2 << 16 | 1], [0x304, 512]]);
const upload = object(0x5900, 0x308A, [[0x19C, 0x580], [0x2FC, 3]]);
engine.render(upload, engine.surface(upload, 0x19C), [0,0,4,2], (x,y) => x + y * 4, [0x18C, 0x190]);
assert.deepEqual([...vram.subarray(512,520)], [0,1,4,5,2,3,6,7], "rectangular Morton layout");
assert.deepEqual([...engine.readrow(engine.surface(upload, 0x19C), 0, 1, 4)], [4,5,6,7]);
const blend = object(0x5A00, 0x4A, [[0x198, 0x500], [0x2FC, 5]]);
view.setUint32(256, 0xFF0000FF, true);
engine.render(blend, engine.surface(blend, 0x198), [0,0,1,1], () => [128,0,0,128], [0x188,0x18C,0x190,0x194]);
assert.equal(view.getUint32(256,true), 0xFF80007F, "premultiplied source over destination");
console.log("PASS: NV40 8/16/32-bit fills, exhaustive ROP3, clipped/overlapping blits, PCI M2MF and atomic completion/faults");
console.log("PASS: IFC row padding/crop and mid-row snapshot, GDI transparent/opaque bitmap expansion and bit order");
console.log("PASS: nearest/bilinear scaling, both packed YUV orders, rectangular Morton surfaces and premultiplied blending");
