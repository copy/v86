#!/usr/bin/env node
import assert from "node:assert/strict";
import { NVDMA } from "../../src/graphics_adapters/geforce_6800/nv_dma.js";
import { NVGraph } from "../../src/graphics_adapters/geforce_6800/nv_graph.js";
import { NVTrace } from "../../src/graphics_adapters/geforce_6800/nv_trace.js";

const vram = new Uint8Array(2 << 20), ramin = new DataView(vram.buffer, 1 << 20);
let irq = 0, dirty = 0;
const device = { vram: () => vram, vram_size: vram.length, registers: new Map([[0x200, 0xFFFFFFFF], [0x400720, 1]]),
    trace: new NVTrace(), time: () => 0x123456789ABCDE0n, update_irq() { irq++; }, vga: { lfb_region: 1 },
    machine: { is_bus_master: () => true, mmio_ram_mark_dirty() { dirty++; } } };
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
assert.equal(device.registers.get(0x400704), 2 << 24 | 3 << 13 | 0x666);
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
