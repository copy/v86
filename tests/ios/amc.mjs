import assert from "node:assert/strict";
import { AppleAMC, AMC_RAM_SIZE } from "../../src/apple/amc.js";

const ports = new Map(), irq = new Map(), mapped = [];
const cpu = {
    wasm_memory: { buffer: new ArrayBuffer(1 << 20) }, device_regions: [],
    mmio_ram_allocate(size) { const n = this.device_regions.length;this.device_regions.push({ size, backing: n * 0x40000 });return n; },
    mmio_ram_backing(n) { return this.device_regions[n].backing; },
    io: { register_mmio: (base, size, port) => ports.set(base, { size, ...port }) },
    wm: { exports: { a64_bus_map_device: (...args) => { mapped.push(args);return true; } } },
};
const amc = new AppleAMC(cpu, (n, value) => irq.set(n, value));
assert.deepEqual(mapped.map(a => [a[0], a[2]]), [[0x84000000, 0x40000], [0x84300000, 0x5000]]);
const regs = ports.get(0x84100000);
assert.equal(regs.size, 0x3000);
regs.write(0x8f0, 4, 3); // original panic access: configuration persists
assert.equal(regs.read(0x8f0), 3);
assert.equal(regs.read(0xa44), AMC_RAM_SIZE);
for(const bank of [0, 0x20, 0x100, 0x180, 0x240, 0x280, 0x2c0])
{
    regs.write(bank + 0x10, 4, 4);
    assert.equal(regs.read(bank + 0x14) & 7, 7);
    regs.write(bank + 0x10, 4, 0x10);
    assert.equal(regs.read(bank + 0x14) & 7, 0);
}
assert.ok([...irq.values()].every(value => !value), "engine reset manufactures no audio completion");
amc.complete(4);
assert.equal(regs.read(0xa98), 4);
assert.equal(irq.get(0), false, "masked completion stays pending without an IRQ");
regs.write(0xa8c, 4, 4);
assert.equal(irq.get(0), true, "source 2 raises controller 0's aggregate output");
regs.write(0xc48, 4, 4);
assert.equal(irq.get(0), false);
assert.equal(regs.read(0xc4c), 4);
amc.memory().set([11, 22, 33], 0x20400);
amc.memory(1)[3] = 17;
const saved = amc.get_state();
amc.reset();amc.set_state(saved);
assert.deepEqual([...amc.memory().slice(0x20400, 0x20403)], [11, 22, 33]);
assert.equal(amc.memory(1)[3], 17);
assert.equal(amc.local(-1, 8), false);
assert.equal(amc.local(0x3ffff, 2), false);
assert.equal(amc.local(0x40000, 0), true);
amc.set_state(null);
assert.equal(amc.memory()[0x20400], 0);
console.log("PASS: N90 AMC memory, engine reset, source-owned IRQs, bounds and snapshots");
