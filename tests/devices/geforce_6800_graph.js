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
// Reusing an instance for another class must not retain the old clip state.
word(0x4000, 0x43); assert.equal(graph.object(0, 0x4000).methods.size, 0);
device.registers.set(0x400324, 17); device.registers.set(0x400328, 0xC001);
graph.written(0x400328, 0xC001); assert.equal(device.registers.get(0x400324), 18);
device.registers.set(0x400324, 17); assert.equal(graph.read(0x400328), 0xC001);
console.log("PASS: NV40 PGRAPH contexts, precise/atomic DMA notifiers, faults, IRQ acknowledgement and snapshot");
