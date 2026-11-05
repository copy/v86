// Synthetic payloads exercise the native driver's SPI1 transmit-DMA mode,
// including its 32-byte callback ring and a refill inside one SPI request.
import assert from "node:assert/strict";
import { AppleSPI } from "../../src/apple/spi.js";
import { AppleCDMA } from "../../src/apple/cdma.js";

const memory = new Uint8Array(256 * 1024), view = new DataView(memory.buffer);
const cpu = {
    mem8: memory, io: { register_mmio() {} },
    ram_offset(address, size) { return address + size <= memory.length ? address : -1; },
    read_blob_physical(address, size) { return memory.subarray(address, address + size); },
    write_blob_physical(bytes, address) { memory.set(bytes, address); },
};
const interrupts = [], sent = [];
const dma = new AppleCDMA(cpu, (channel, level) => {
    if(level) interrupts.push([channel, dma.read(channel * 4096 + 0x14)]);
});
const spi = new AppleSPI(cpu, 1, () => {}, byte => { sent.push(byte); return byte ^ 0xff; }, dma);
const descriptor = (at, next, flags, address, size) => {
    [next, flags, address, size, 0, 0, 0, 0].forEach((value, i) => view.setUint32(at + 4 * i, value, true));
};
function arm(at, size)
{
    dma.write(0x12004, 0x20082);
    dma.write(0x12008, 0x82100010);
    dma.write(0x1200C, size);
    dma.write(0x12014, at);
    dma.write(0x12000, 0x19);
}
function request(size)
{
    spi.write(0, 13);
    spi.write(0x34, 0);
    spi.write(0x4C, size);
    spi.write(4, 0x4058);
}
const payload = Uint8Array.from({ length: 70019 }, (_, i) => (i * 17 ^ i >>> 8) & 255);
for(const early of [false, true])
{
    dma.reset(); spi.reset(); sent.length = interrupts.length = 0;
    memory.set(payload.subarray(0, 19), 0x4000);
    memory.set(payload.subarray(19), 0x8000);
    descriptor(0x100, 0x120, 3, 0x4000, 19);
    descriptor(0x120, 0x140, 0x303, 0x8000, payload.length - 19);
    if(early) arm(0x100, 0x40000000);
    request(payload.length);
    if(!early) arm(0x100, 0x40000000);
    assert.deepEqual(Uint8Array.from(sent), payload);
    assert.deepEqual(interrupts, [[18, 0x140]], "hardware cursor is visible before the callback interrupt");
    assert.equal(dma.read(0x1200C), 0x40000000 - payload.length);
    assert.equal(spi.rx.length, 0, "transmit-only clocks discard the returned bytes");
    spi.shift();
    assert.equal(sent.length, payload.length, "completed DMA cannot replay the SPI request");
    spi.set_state(spi.get_state()); spi.shift();
    assert.equal(sent.length, payload.length, "completed request remains retired after restore");
}
console.log("PASS: SPI1 transmit DMA streams a scattered payload in either request order and retires the native callback ring");

dma.reset(); spi.reset(); sent.length = interrupts.length = 0;
const bytes = Uint8Array.of(7, 19, 31, 43, 59, 71, 83, 97);
memory.set(bytes.subarray(0, 3), 0x4000);
memory.set(bytes.subarray(3), 0x8000);
descriptor(0x100, 0x120, 0x103, 0x4000, 3);
descriptor(0x120, 0x140, 0x103, 0x8000, 5);
arm(0x100, bytes.length); request(bytes.length);
assert.deepEqual(sent, [...bytes.subarray(0, 3)]);
assert.deepEqual(interrupts, [[18, 0x120]]);
assert.equal(dma.read(0x1200C), 5);
const dmaState = dma.get_state(), spiState = spi.get_state();
dma.reset(); spi.reset(); dma.set_state(dmaState); spi.set_state(spiState);
spi.shift();
assert.equal(sent.length, 3, "a stopped channel cannot consume the outstanding SPI suffix");
arm(0x120, 5);
assert.deepEqual(sent, [...bytes]);
assert.deepEqual(interrupts, [[18, 0x120], [18, 0x140]]);
assert.equal(dma.read(0x1200C), 0);
assert.equal(spi.dma_pending, null);
console.log("PASS: SPI DMA refill and in-flight snapshot preserve byte order, progress and exactly-once completion");

// Legacy PIO-only snapshots predate the extra DMA fields.
spi.set_state(spiState.slice(0, 3));
assert.equal(spi.dma_pending, null);
assert.equal(spi.dma_done, false);
console.log("PASS: SPI snapshots without DMA state retain their PIO registers and FIFOs");
