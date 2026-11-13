#!/usr/bin/env node
import assert from "node:assert/strict";
import { NVDMA } from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import { NVGraph } from "../../src/graphics_adapters/geforce_6800/nv_graph.js";
import { NVTrace } from "../../src/graphics_adapters/geforce_6800/nv_trace.js";

const vram = new Uint8Array(2 << 20), ramin = new DataView(vram.buffer, 1 << 20);
let irq = 0, dirty = 0;
const device = { vram: () => vram, vram_size: vram.length, registers: new Map([[0x200, 0xFFFFFFFF], [0x400720, 1]]),
    trace: new NVTrace(), time: () => 0x123456789ABCDE0n, update_irq() { irq++; }, vga: { lfb_region: 1 },
    machine: { wake() {}, is_bus_master: () => true, mmio_ram_mark_dirty() { dirty++; } } };
device.dma = new NVDMA(device);
let graph = new NVGraph(device);
function word(at, value) { ramin.setUint32(at, value >>> 0, true); }
function method(channel, instance, at, value) { return graph.method(channel, 3, instance, at, value); }
word(0x4000, 0x19);
method(0, 0x4000, 0x300, 0x20001); method(0, 0x4000, 0x304, 0x60005);
method(1, 0x4000, 0x300, 0x40003);
assert.equal(graph.object(0, 0x4000).methods.get(0x300), 0x20001);
assert.equal(graph.object(1, 0x4000).methods.get(0x300), 0x40003, "contexts isolated by channel");
const saved = graph.get_state(); graph = new NVGraph(device); graph.set_state(saved);
assert.equal(graph.object(0, 0x4000).methods.get(0x304), 0x60005, "object state survives snapshot");
word(0x4100, 0x3003); word(0x4104, 31); word(0x4108, 0x8002);
vram.fill(255, 0x8000, 0x8020);
method(0, 0x4000, 0x180, 0x410); method(0, 0x4000, 0x104, 1);
assert.equal(new DataView(vram.buffer).getBigUint64(0x8000, true), device.time());
assert.deepEqual([...vram.subarray(0x8008, 0x8010)], new Array(8).fill(0));
assert.equal(device.registers.get(0x400100), 1); assert.equal(device.registers.get(0x400108), 1);
assert.equal(dirty, 1); assert(irq);
graph.written(0x400100, 1); device.registers.set(0x400100, 0);
assert.equal(device.registers.get(0x400108), 0, "interrupt acknowledgement clears source");
graph.notification(graph.object(0,0x4000),16,true);graph.notification(graph.object(0,0x4000),0,true);
graph.written(0x400100,1);
assert.equal(device.registers.get(0x400108),0x8000,"ordinary acknowledgement retains pending buffer notification");
graph.written(0x400100,0x10000);assert.equal(device.registers.get(0x400108),0);
device.registers.set(0x400100,0);
// Invalid DMA must leave all sixteen bytes untouched, including the completion word.
word(0x4104, 7); vram.fill(255, 0x8000, 0x8010);
method(0, 0x4000, 0x104, 0);
assert.deepEqual([...vram.subarray(0x8000, 0x8010)], new Array(16).fill(255));
assert.equal(device.registers.get(0x400108), 0x100); assert.equal(device.registers.get(0x400720), 0);
assert.equal(method(0, 0x4000, 0x300, 9), false, "fault suspends graph FIFO access");
graph.written(0x400100, 1); device.registers.set(0x400100, 0); device.registers.set(0x400720, 1);
method(2, 0x4000, 0x666, 0x1234);
assert.equal(device.registers.get(0x400704), 2 << 20 | 3 << 16 | 0x666);
assert.equal(device.registers.get(0x400708), 0x1234);
assert.equal(device.registers.get(0x400108), 0x40, "unknown method raises ILLEGAL_MTHD");
assert.equal(graph.faults.at(-1).method,0x666);assert.match(graph.faults.at(-1).reason,/unimplemented/);
assert.equal(graph.faults.at(-2).source,0x100,"DMA exceptions and method traps share the bounded diagnostic history");
// Reusing an instance for another class must not retain the old clip state.
word(0x4000, 0x43); assert.equal(graph.object(0, 0x4000).methods.size, 0);
device.registers.set(0x400324, 17); device.registers.set(0x400328, 0xC001);
graph.written(0x400328, 0xC001); assert.equal(device.registers.get(0x400324), 18);
device.registers.set(0x400324, 17); assert.equal(graph.read(0x400328), 0xC001);
console.log("PASS: NV40 PGRAPH contexts, precise/atomic DMA notifiers, faults, IRQ acknowledgement and snapshot");
// Real Curie uploads address one vector at a time; the last component advances
// the pointer. Half an instruction must survive a snapshot without duplication.
device.registers.set(0x400720,1);device.registers.set(0x400108,0);
word(0x4200,0x4097);method(0,0x4200,0x1E9C,5);
method(0,0x4200,0xB80,0x11111111);method(0,0x4200,0xB84,0x22222222);
const curieSaved=graph.get_state();graph=new NVGraph(device);graph.set_state(curieSaved);
method(0,0x4200,0xB88,0x33333333);method(0,0x4200,0xB8C,0x44444444);
method(0,0x4200,0xB90,0x55555555);
assert.deepEqual([...graph.engine3d.vertex_program(graph.object(0,0x4200),5,2)],
    [0x11111111,0x22222222,0x33333333,0x44444444,0x55555555,0,0,0]);
method(0,0x4200,0x1EFC,3);
for(let i=0;i<4;i++)method(0,0x4200,0x1F10+i*4,0x3F800000+i);
assert.deepEqual([...graph.engine3d.vertex_constants(graph.object(0,0x4200),3,1)],
    [0x3F800000,0x3F800001,0x3F800002,0x3F800003]);
word(0x4104,31);vram.fill(255,0x8000,0x8020);
method(0,0x4200,0x1A4,0x410);method(0,0x4200,0x1D6C,16);method(0,0x4200,0x1D70,0xDEADBEEF);
assert.equal(new DataView(vram.buffer).getUint32(0x8010,true),0xDEADBEEF);
assert.deepEqual([...vram.subarray(0x8014,0x8020)],Array(12).fill(255),"fence writes one DWORD, without a notifier timestamp");
word(0x4104,17);vram.fill(255,0x8010,0x8020);method(0,0x4200,0x1D70,7);
assert.deepEqual([...vram.subarray(0x8010,0x8020)],Array(16).fill(255),"failed fence leaves all bytes untouched");
assert.equal(device.registers.get(0x400720),0);
word(0x4104,31);word(0x4100,0x103003);device.registers.set(0x400720,1);method(0,0x4200,0x1D70,8);
assert.equal(device.registers.get(0x400720),0,"fence DMA rejects a nonzero page adjustment");
assert.deepEqual([...vram.subarray(0x8010,0x8020)],Array(16).fill(255));
device.registers.set(0x400720,1);method(0,0x4200,0x1E9C,0x220);
assert.equal(device.registers.get(0x400720),0,"upload address bounds fault before modifying code");
device.registers.set(0x400720,1);method(0,0x4200,0x1808,5);
assert.equal(device.registers.get(0x400108)&0x40,0x40,"unimplemented drawing stays an explicit method trap");
console.log("PASS: NV40_3D control state, vector uploads across snapshots and checked four-byte fences");
device.registers.set(0x400720,1);device.registers.set(0x400108,0);device.registers.set(0x400104,0);device.registers.set(0x40008C,0x100000);
for(const value of [0,1,3,0xFFFFFFFF])
{
    method(2,0x4200,0x100,value);
    assert.equal(device.registers.get(0x400720),1,"Curie NOP preserves opaque driver data without an error");
}
assert.equal(device.registers.get(0x400108),0);
method(2,0x4200,0x104,2);
assert.equal(device.registers.get(0x400704),2<<20|3<<16|0x104,"PGRAPH trap uses hardware channel/subchannel fields");
assert.equal(device.registers.get(0x400108),2);assert.equal(device.registers.get(0x400104),0x2000);
assert.equal(device.registers.get(0x400720),0,"invalid notify mode still reports DATA_ERROR");
console.log("PASS: hardware PGRAPH trap fields and Curie NOP driver data");
// Capture programs when a draw begins, while the driver's BO is still alive.
// Later releases can overwrite its VRAM without destroying diagnostic input.
word(0x4400,0x4097);word(0x4300,0x3002);word(0x4304,0x9FFF);word(0x4308,3);
device.registers.set(0x400720,1);method(0,0x4400,0x1E9C,0);
[0x401F9C6C,0x0040000D,0x81000000,0x0001EF81].forEach((v,i)=>method(0,0x4400,0xB80+i*4,v));
method(0,0x4400,0x184,0x430);method(0,0x4400,0x8E4,0x9001);
[0x01001E81,0x001DC802,0,0,0x3F800000,0,0,0x3F800000].forEach((v,i)=>new DataView(vram.buffer).setUint32(0x9000+i*4,v,true));
const shaders=graph.engine3d.shaders(graph.object(0,0x4400));
assert.equal(shaders.vertex.bytecode[0],0xFFFE0300);assert.equal(shaders.fragment.bytecode[0],0xFFFF0300);
assert.deepEqual([...shaders.fragment.constant_values[0]],[0x3F800000,0,0,0x3F800000]);
device.trace.enabled=true;method(0,0x4400,0x1808,6);
vram.fill(0,0x9000,0x9020);
const captured=graph.engine3d.programs();assert.equal(captured.length,1);assert.deepEqual(captured[0].errors,[]);
assert.equal(captured[0].vertex.instructions[0].vector.name,"MOV");
assert.deepEqual(captured[0].fragment.constants[0],[0x3F800000,0,0,0x3F800000]);
console.log("PASS: draw-time shader capture survives guest buffer release");

// Query reports publish a complete hardware report, including a precise clock.
device.registers.set(0x400720,1);word(0x4100,0x3003);word(0x4104,31);word(0x4108,0x8002);
method(0,0x4200,0x1A8,0x410);method(0,0x4200,0x17C8,2);method(0,0x4200,0x17CC,1);
graph.object(0,0x4200).methods.set(0x50008,123);
const querySaved=graph.get_state();graph=new NVGraph(device);graph.set_state(querySaved);
method(0,0x4200,0x1800,0x01000010);
assert.equal(new DataView(vram.buffer).getBigUint64(0x8010,true),device.time());
assert.equal(new DataView(vram.buffer).getUint32(0x8018,true),123);
assert.equal(new DataView(vram.buffer).getUint32(0x801C,true),0);
word(0x4104,23);vram.fill(255,0x8010,0x8020);method(0,0x4200,0x1800,0x01000010);
assert.deepEqual([...vram.subarray(0x8010,0x8020)],Array(16).fill(255),"invalid report DMA writes no partial timestamp/count");
assert.match(graph.faults.at(-1).reason,/DMA/);
device.registers.set(0x400720,1);method(0,0x4200,0x17C8,1);
assert.equal(graph.object(0,0x4200).methods.get(0x50008),0);
method(0,0x4200,0x17CC,2);assert.equal(device.registers.get(0x400720),0,"query enable is boolean");
console.log("PASS: NV40 query report layout, precise clock, snapshot counter and atomic DMA failure");

// A flip wait holds later methods until the display interrupt advances READ.
device.registers.set(0x400720,1);
method(0,0x4200,0x120,0);method(0,0x4200,0x124,2);method(0,0x4200,0x128,3);
method(0,0x4200,0x12C,0);assert.equal(graph.flips[1][1],0,"WRITE wraps at modulo");
method(0,0x4200,0x130,0);assert.equal(graph.busy,true);assert.equal(graph.read(0x400700),0x4000,"flip waits expose SYNC_STALL while the raster engine is idle");
const flipSaved=graph.get_state();graph=new NVGraph(device);graph.set_state(flipSaved);assert.equal(graph.busy,true);
graph.written(0x40071C,2);assert.equal(graph.busy,false);assert.equal(graph.flips[1][0],1);
assert.equal(graph.read(0x40071C),0,"increment strobe does not latch");
word(0x4500,0x9F);method(0,0x4500,0x120,3);method(0,0x4500,0x124,4);
assert.deepEqual(graph.flips[1].slice(0,2),[1,0],"BLIT and Curie use separate counters");
method(0,0x4200,0x128,0);method(0,0x4200,0x124,7);method(0,0x4200,0x12C,0);
assert.equal(graph.flips[1][1],0,"zero modulo retains the hardware three-bit wrap");
method(0,0x4200,0x120,8);assert.equal(device.registers.get(0x400720),0,"out-of-range counter faults");
graph.set_state([1,flipSaved[1],flipSaved[2]]);assert.equal(graph.busy,false,"legacy snapshots start without pending flip waits");
console.log("PASS: independent flip counters, modulo wrap, ISR wake, pending wait snapshot and v1 migration");

device.registers.set(0x400720,1);word(0x4104,31);
const queryObject=graph.object(0,0x4200);queryObject.methods.set(0x50008,77);
method(0,0x4200,0x17C8,2);assert.equal(queryObject.methods.get(0x50008),77,"ZCULL reset is independent of ZPASS");
method(0,0x4200,0x1EA8,0x202000);method(0,0x4200,0x1EAC,0);method(0,0x4200,0x1804,1);
for(let type=2;type<=5;type++)
{
    vram.fill(255,0x8010,0x8020);method(0,0x4200,0x1800,type<<24|16);
    assert.equal(new DataView(vram.buffer).getUint32(0x8018,true),0,"no hierarchical cull cache means no tile rejections");
    assert.equal(new DataView(vram.buffer).getUint32(0x801C,true),0);
}
assert.equal(device.registers.get(0x400720),1);
console.log("PASS: ZCULL control/report selectors and separate report reset groups");

device.registers.set(0x400720,1);device.registers.set(0x32E0,0x1234);
method(0,0x4200,0x120,2);method(0,0x4200,0x124,1);method(0,0x4200,0x128,3);
assert.equal(graph.read(0x400710)&0x77700000,0x32100000);
assert.equal(device.registers.get(0x40032C),0x01001234,"FIFO GRCTX becomes the valid current graph context");
device.registers.set(0x32E0,0x2345);method(1,0x4200,0x128,4);
assert.equal(graph.read(0x400710)&0x77700000,0x40000000);
const contextsSaved=graph.get_state();graph=new NVGraph(device);graph.set_state(contextsSaved);
device.registers.set(0x32E0,0x1234);method(0,0x4200,0x100,0);
assert.equal(graph.read(0x400710)&0x77700000,0x32100000,"context switch and snapshot preserve separate counters");
graph.written(0x400710,0x33200000);assert.deepEqual(graph.flips[1].slice(0,3),[3,2,3]);
console.log("PASS: SURF_TYPE flip fields and valid per-GRCTX counters across switches and snapshots");

word(0x4600,0x88);device.registers.set(0x400720,1);
for(const at of [0x184,0x188,0x18C])method(0,0x4600,at,0x410);
assert.equal(device.registers.get(0x400720),1,"DVD DMA context bindings do not execute a composite");
method(0,0x4600,0x33C,0);assert.equal(device.registers.get(0x400720),0,"unimplemented DVD composite remains an explicit trap");
console.log("PASS: NV10 DVD subpicture DMA binding without fabricated drawing completion");

// The driver can freeze/save a context, patch its inactive read counter in
// RAMIN and restore it. Interpret the transfer descriptors, not a driver offset.
device.registers.set(0x400720,1);device.registers.set(0x32E0,0x1234);
graph.flip_offset=-2;graph.program=new Map([[0,0x200008],[1,0x60000A],[2,0x1041C4]]);
method(0,0x4200,0x120,0);method(0,0x4200,0x124,0);method(0,0x4200,0x128,3);method(0,0x4200,0x130,0);
assert.equal(graph.busy,true);device.registers.set(0x400784,0x1234);device.registers.set(0x400310,0x20);
graph.written(0x400304,1);assert.equal(ramin.getUint32(0x12340+32,true)&0x77700000,0x30000000);
assert.equal(device.registers.get(0x400310)&0x60,0,"completed software transfer clears request flags");
device.registers.set(0x40032C,0x1234);word(0x12340+32,0x31000000);
assert.equal(graph.busy,false,"inactive RAMIN READ patch releases its pending flip wait");
device.registers.set(0x400310,0x40);graph.written(0x400304,1);
assert.deepEqual(graph.flips[1].slice(0,3),[1,0,3]);
console.log("PASS: decoded context transfer layout, inactive RAMIN flip patch and request acknowledgement");
