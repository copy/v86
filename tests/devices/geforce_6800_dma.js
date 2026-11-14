#!/usr/bin/env node
import assert from "node:assert/strict";
import { NVDMA } from "../../src/graphics_adapters/geforce_6800/nv_dma.js";

const vram = new Uint8Array(2 << 20), ram = new Uint8Array(64 << 10);
const ramin = new DataView(vram.buffer, 1 << 20);
let master = false, dirty = 0;
const machine = {
    is_bus_master: () => master,
    validate_physical_range: (at, size) => { if(at < 0 || at + size > ram.length) throw new RangeError("outside guest RAM"); },
    read_physical: (at, size) => ram.slice(at, at + size),
    write_physical: (bytes, at) => ram.set(bytes, at),
    mmio_ram_mark_dirty: () => dirty++,
};
const device = { machine, vram_size: vram.length, vram: () => vram, vga: { lfb_region: 1 }, registers: new Map() };
const engine = new NVDMA(device);
const object = (at, flags, limit, ...ptes) => {
    ramin.setUint32(at, flags, true); ramin.setUint32(at + 4, limit, true);
    ptes.forEach((pte, i) => ramin.setUint32(at + 8 + i * 4, pte, true));
    return engine.descriptor(at);
};
// Inclusive limits and adjustment within a physical page; a linear object can
// cross page boundaries without consuming a second PTE.
let d = object(0x100, 0xFF00303D, 63, 0x8002);
const pattern = Uint8Array.from({ length: 64 }, (_, i) => i);
engine.write(d, 0, pattern);
assert.deepEqual(vram.subarray(0x8FF0, 0x9030), pattern);
assert.deepEqual(engine.read(d, 0, 64), pattern);
assert.throws(() => engine.read(d, 1, 64), /limit/);
assert.throws(() => engine.read(d, -1, 1), /limit/);
assert.throws(() => engine.read(d, 0, 1.5), /limit/);
assert.equal(engine.read(d, 64, 0).length, 0);
assert.equal(dirty, 1);

// Paged objects can map adjacent logical pages to discontiguous physical pages.
d = object(0x200, 0xFFC0103D, 15, 0xA003, 0xC003);
engine.write(d, 0, pattern.subarray(0, 16));
assert.deepEqual(vram.subarray(0xAFFC, 0xB000), pattern.subarray(0, 4));
assert.deepEqual(vram.subarray(0xC000, 0xC00C), pattern.subarray(4, 16));
assert.deepEqual(engine.read(d, 0, 16), pattern.subarray(0, 16));
ramin.setUint32(0x20C, 0xC001, true); // read-only second page
const before = vram.slice(0xAFFC, 0xB000);
assert.throws(() => engine.write(d, 0, new Uint8Array(16).fill(255)), /page access/);
assert.deepEqual(vram.subarray(0xAFFC, 0xB000), before, "a later page fault never partially writes");
ramin.setUint32(0x20C, 0xC000, true);
assert.throws(() => engine.read(d, 0, 16), /page access/);

// Bus mastering gates system RAM only, not internal VRAM operations.
d = object(0x300, 0x0002303D, 63, 0x1002);
assert.throws(() => engine.read(d, 0, 1), /bus mastering/);
master = true;
engine.write(d, 0, pattern); assert.deepEqual(ram.subarray(0x1000, 0x1040), pattern);
assert.deepEqual(engine.read(d, 0, 64), pattern);
d = object(0x340, 0x0002303D, 8191, 0xF002);
assert.throws(() => engine.read(d, 4096, 1), /outside guest RAM/);

assert.throws(() => engine.descriptor(0xFFFFF), /outside RAMIN/);
assert.throws(() => object(0x400, 0x3000, 1, 2), /class/);
assert.throws(() => object(0x400, 0x3D, 1, 2), /page table/);
d = object(0x400, 0x00007002, 63, 0x8000);
assert.equal(engine.read(d, 0, 1).length, 1);
assert.throws(() => engine.write(d, 0, new Uint8Array(1)), /access denied/);
d = object(0x400, 0x0000B003, 63, 0x8002);
assert.throws(() => engine.read(d, 0, 1), /access denied/);
engine.write(d, 0, new Uint8Array([91])); assert.equal(vram[0x8000], 91);

object(0x500, 0x00C2303D, 1023, 0x1002);
engine.load_cache(0x500);
assert.equal(device.registers.get(0x3230), 0x8002300C);
assert.equal(device.registers.get(0x3234), 1023);
assert.equal(device.registers.get(0x323C), 0x1002);

// Scalar FIFO reads preserve byte order and adjusted, discontiguous mappings.
for(const target of [0, 2])
{
    master = true;
    d = object(0x600, 0xFFF0103D | target << 16, 7, 0x2003, 0x4003);
    const memory = target ? ram : vram;
    memory[0x2FFF] = 0x81; memory.set([0x23, 0x45, 0xE7, 0xAB, 0xCD, 0xEF, 0x09], 0x4000);
    assert.equal(engine.read32(d, 0), 0xE7452381, "word split across two physical pages");
    assert.equal(engine.read32(d, 0, false), 0x812345E7, "big-endian split word");
    assert.equal(engine.read32(d, 1), 0xABE74523, "unaligned physical word within one page");
    assert.equal(engine.read32(d, 1, false), 0x2345E7AB);
    assert.throws(() => engine.read32(d, 5), /limit/);
    ramin.setUint32(0x60C, 0x4000, true);
    assert.throws(() => engine.read32(d, 0), /page access/, "PTE edits are checked on every scalar read");
    ramin.setUint32(0x60C, 0x4003, true);
    if(target)
    {
        master = false;
        assert.throws(() => engine.read32(d, 1), /bus mastering/);
    }
}
d = object(0x640, 0xB003, 7, 0x2003);
assert.throws(() => engine.read32(d, 0), /access denied/);
console.log("PASS: NV40 DMA inclusive limits, linear/paged mappings, permissions, PCI DMA and CACHE1 descriptor load");
