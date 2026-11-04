// Peripheral contracts used during the 10B329 bootstrap; no Apple images.
import assert from "node:assert/strict";
import { AppleVIC } from "../../src/apple/vic.js";
import { AppleTimer } from "../../src/apple/timer.js";
import { AppleCLCD } from "../../src/apple/clcd.js";
import { AppleCDMA } from "../../src/apple/cdma.js";
import { AppleI2C } from "../../src/apple/i2c.js";
import { AppleUART } from "../../src/apple/uart.js";

let now = 0, signals = 0;
const ports = new Map(), output = [], inputs = new Map();
const cpu = {
    clock: { now: () => now },
    wm: { exports: { a32_set_interrupt_lines: (irq, fiq) => { signals = +irq + 2 * fiq; } } },
    io: { register_mmio: (address, size, port) => ports.set(address, port) },
};
const bus = { register: (event, receive) => inputs.set(event, receive), send: (_, byte) => output.push(byte) };
const vic = new AppleVIC(cpu), timer = new AppleTimer(cpu, vic);
new AppleUART(cpu, bus);
const uart = ports.get(0x82500000), pmgr = ports.get(0xBF100000), intc = ports.get(0xBF200000);
uart.write(0x20, 1, 65);
assert.deepEqual(output, [65]);
inputs.get("serial0-input")(90);
assert.equal(uart.read(0x10), 7);
assert.equal(uart.read(0x24), 90);
assert.equal(uart.read(0x10), 6);

intc.write(0x10, 4, 1 << 6);
intc.write(0x118, 4, 0xABC);
pmgr.write(0x2008, 4, 48000);
pmgr.write(0x2010, 4, 1);
now++;
assert.equal(pmgr.read(0x2000), 24000);
assert.equal(timer.timer(), 1);
assert.equal(signals, 0);
now++;
timer.timer();
assert.equal(signals, 1);
assert.equal(intc.read(0), 1 << 6);
assert.equal(intc.read(0xF00), 0xABC);
assert.equal(signals, 0);
intc.write(0xF00, 4, 0);
assert.equal(signals, 1);
pmgr.write(0x2010, 4, 2);
assert.equal(signals, 0);
intc.write(0x1000C, 4, 1 << 31);
intc.write(0x10010, 4, 1 << 31);
intc.write(0x10018, 4, 1 << 31);
assert.equal(signals, 2);
const saved = vic.get_state();
vic.reset();
assert.equal(signals, 0);
vic.set_state(saved);
assert.equal(signals, 2);
intc.write(0x1001C, 4, 1 << 31);
assert.equal(signals, 0);
console.log("PASS: N90 UART, timer deadline, VIC IRQ/FIQ, acknowledge and restore");

new AppleCDMA(cpu);
const dma = ports.get(0x87000000);
dma.write(4, 4, 0x20);
assert.equal(dma.read(0x14), 0x20);
dma.write(12, 4, 0x20);
assert.equal(dma.read(0x14), 0);
dma.write(0x100C, 4, 200);
dma.write(0x1000, 4, 2);
assert.equal(dma.read(0x100C), 0);
pmgr.write(0x1014, 4, 0xA05);
assert.equal(pmgr.read(0x1014), 0xA55);

new AppleI2C(cpu, 0x83200000, 19, vic, true);
const i2c = ports.get(0x83200000);
intc.write(0x10, 4, 1 << 19);
i2c.write(0, 4, 0x74);
i2c.write(8, 4, 0x30);
i2c.write(0x10, 4, 7);
i2c.write(0x18, 4, 1);
i2c.write(0x24, 4, 4);
assert.equal(signals, 1);
assert.equal(i2c.read(0x20), 8);
i2c.write(0x0C, 4, 0x10);
assert.equal(signals, 0);
i2c.write(0, 4, 0x33);
i2c.write(0x24, 4, 4);
assert.equal(i2c.read(0x0C), 0x20);
console.log("PASS: CDMA gating, PMGR acknowledgement, I2C completion and missing slave");


const hub = { add_source() {}, set_mode() {}, set_size_graphical() {} };
cpu.ram_offset = () => -1;
const panel = new AppleCLCD(cpu, hub, vic);
const display = ports.get(0x89000000);
vic.reset();
intc.write(0x10010, 4, 1 << 10);
intc.write(0x10128, 4, 0x8000002A);
display.write(0x1028, 4, 1);
panel.on_vblank();
assert.equal(signals, 1);
assert.equal(intc.read(0xF00), 0x8000002A);
assert.equal(display.read(0x102C), 1);
display.write(0x102C, 4, 1);
intc.write(0x10F00, 4, 0);
intc.write(0xF00, 4, 0);
assert.equal(signals, 0);
panel.on_vblank();
assert.equal(signals, 1);
console.log("PASS: CLCD retrace through chained VIC1, guest status acknowledgement and next frame");

const { AppleH2FMI } = await import("../../src/apple/h2fmi.js");
const fmi = new AppleH2FMI(cpu, 0x81200000);
const ids = new Uint8Array(256);
ids.set([0xEC, 0xD7, 0x94, 0x72]);
fmi.configure(ids, 0);
const seq = ports.get(0x81240000), fifo = ports.get(0x81200000);
seq.write(12, 4, 1);
seq.write(0x14, 4, 0x90);
seq.write(0x10, 4, 9);
assert.equal(seq.read(0x44), 9);
seq.write(0x44, 4, 9);
assert.equal(seq.read(0x44), 0);
fifo.write(4, 4, 3);
assert.equal(fifo.read(12), 2);
assert.equal(fifo.read(0x14), 0x7294D7EC);
assert.equal(fifo.read(0x14), 0);
seq.write(12, 4, 2);
seq.write(0x10, 4, 9);
assert.equal(fifo.read(0x14), 0xFFFFFFFF);
console.log("PASS: H2FMI chip select, READ ID, absent CE and completion acknowledgement");

let presented;
const displayRAM = new Uint8Array(640 * 960 * 4);
cpu.mem8 = displayRAM;
cpu.ram_offset = () => 0;
hub.update_buffer = layers => { presented = layers[0].pixels.data; };
const backlight = new AppleI2C(cpu, 0x83200000, 19, vic, true, level => panel.set_backlight(level));
displayRAM.set([0x20, 0x40, 0x80, 0]);
panel.render();
assert.deepEqual(Array.from(presented.subarray(0, 4)), [128, 64, 32, 255]);
backlight.write(0, 0x74);
backlight.write(0x10, 0x68);
backlight.write(0x18, 1);
backlight.write(0x20, 0);
backlight.write(0x24, 5);
panel.render();
assert.deepEqual(Array.from(presented.subarray(0, 4)), [0, 0, 0, 255]);
backlight.write(0x20, 0x15);
backlight.write(0x24, 5);
panel.render();
assert.deepEqual(Array.from(presented.subarray(0, 4)), [128, 64, 32, 255]);
console.log("PASS: PMU backlight off/on changes displayed pixels and preserves guest VRAM");

// The real IOP starts CDMA before the boot-page transfer but after the
// full-page transfer request. Both orders see the same descriptor/data.
const memory = new Uint8Array(4096), received = [];
const controllerCPU = {
    io: { register_mmio() {} }, mem8: memory,
    ram_offset: (a, n) => a >= 0 && a + n <= memory.length ? a : -1,
    write_blob_physical: (bytes, a) => memory.set(bytes, a),
    read_blob_physical: (a, n) => memory.subarray(a, a + n),
};
const channelDMA = new AppleCDMA(controllerCPU, (n, level) => received.push([n, level]));
let completeRead;
const media = { read(bus, ce, row, done) {
    assert.deepEqual([bus, ce, row], [0, 0, 0x10203]);
    completeRead = done;
} };
const flashPort = new AppleH2FMI(controllerCPU, 0x81200000, 0, media, () => {}, channelDMA);
flashPort.configure(ids, 0);
const descriptor = new DataView(memory.buffer);
descriptor.setUint32(0x104, 0x103, true);
descriptor.setUint32(0x108, 0x200, true);
descriptor.setUint32(0x10C, 4, true);
const issue = () => {
    flashPort.write(0x100C, 1);
    flashPort.write(0x1018, 0x02030002);
    flashPort.write(0x101C, 1);
    flashPort.write(0x1014, 0x3000);
    flashPort.write(0x1010, 11);
};
const arm = () => {
    channelDMA.write(0x5008, 0x81200014);
    channelDMA.write(0x500C, 4);
    channelDMA.write(0x5014, 0x100);
    channelDMA.write(0x5000, 0x1C0009);
};
for(const early of [true, false])
{
    flashPort.reset();
    issue();
    assert.equal(flashPort.read(0x1044), 0);
    completeRead(Uint8Array.of(0, 1, 11, 22, 33, 44));
    assert.equal(flashPort.read(0x1044), 11);
    memory.fill(0, 0x200, 0x204);
    if(early) arm();
    flashPort.write(4, 3);
    if(!early) arm();
    assert.deepEqual(Array.from(memory.subarray(0x200, 0x204)), [11, 22, 33, 44]);
    assert.equal(channelDMA.read(0x5000), 0x80008);
    assert.deepEqual(received.at(-1), [5, true]);
    channelDMA.write(0x5000, 0x80000);
    assert.deepEqual(received.at(-1), [5, false]);
}
issue();
flashPort.reset();
completeRead(Uint8Array.of(99));
assert.equal(flashPort.read(0x1044), 0, "stale read cannot complete after reset");
console.log("PASS: NAND row/column, async completion, both CDMA request orders and reset during read");

// The firmware sends data and spare bytes via separate scatterlists, then
// confirms the program and polls for completion before sampling status.
let programmed = null, finishProgram, erasedRow;
media.program = (bus, ce, row, page, done) => {
    assert.deepEqual([bus, ce, row], [0, 0, 0x10203]);
    programmed = page;
    finishProgram = done;
};
media.erase = (bus, ce, row, done) => { erasedRow = row; done(); };
flashPort.reset();
issue();
completeRead(Uint8Array.of(0, 1, 90, 91, 92, 93));
flashPort.write(0x1044, 11);
flashPort.write(4, 3);
flashPort.write(4, 6); // IOP resets both FIFOs before arming the program channels
arm();
assert.equal(channelDMA.read(0x500C), 4, "a previous read must not consume the next program descriptor");
flashPort.write(0x100C, 1);
flashPort.write(0x1018, 0x02030002);
flashPort.write(0x101C, 1);
flashPort.write(0x1014, 0x80);
flashPort.write(0x1010, 9);
assert.equal(flashPort.read(0x1044), 9);
flashPort.write(0x1044, 9);
flashPort.write(0, 0xF5);
flashPort.write(4, 5);
channelDMA.write(0x6008, 0x81200018);
channelDMA.write(0x600C, 4);
channelDMA.write(0x6014, 0x100);
channelDMA.write(0x6000, 9);
flashPort.write(0x1014, 0x1000);
flashPort.write(0x1010, 2);
assert.deepEqual(Array.from(programmed.subarray(0, 6)), [255, 255, 11, 22, 33, 44]);
assert.deepEqual(Array.from(programmed.subarray(8192, 8196)), [11, 22, 33, 44]);
assert.equal(flashPort.read(0x1044), 0);
finishProgram();
assert.equal(flashPort.read(0x1044), 2);
flashPort.write(0x1044, 2);
flashPort.write(0x1018, 0x10200);
flashPort.write(0x1014, 0xD060);
flashPort.write(0x1010, 11);
assert.equal(erasedRow, 0x10200);
assert.equal(flashPort.read(0x1044), 11);
console.log("PASS: NAND program payload, spare DMA, confirm, asynchronous completion and block erase");

// A page can end halfway through a descriptor. Restoring at that point
// must resume at the saved byte and interrupt only after the final page.
descriptor.setUint32(0x100, 0x120, true);
descriptor.setUint32(0x104, 3, true);
descriptor.setUint32(0x10C, 6, true);
descriptor.setUint32(0x124, 0x103, true);
descriptor.setUint32(0x128, 0x220, true);
descriptor.setUint32(0x12C, 2, true);
channelDMA.write(0x500C, 8);
channelDMA.write(0x5014, 0x100);
channelDMA.write(0x5000, 9);
const port = 0x81200014;
channelDMA.transfer(port, Uint8Array.of(1, 2, 3, 4), true);
assert.equal(channelDMA.read(0x500C), 4);
assert.equal(channelDMA.read(0x5000), 9);
const dmaState = channelDMA.get_state();
channelDMA.reset();
channelDMA.set_state(dmaState);
channelDMA.transfer(port, Uint8Array.of(5, 6, 7, 8), true);
assert.equal(channelDMA.read(0x5000), 0x80008);
assert.deepEqual([...memory.subarray(0x200, 0x206), ...memory.subarray(0x220, 0x222)], [1, 2, 3, 4, 5, 6, 7, 8]);
console.log("PASS: CDMA burst resumes inside a scatterlist descriptor after snapshot restore");

// The IOP refills a descriptor list when it receives the completion IRQ
// with bytes still outstanding. Place that boundary inside one FIFO read.
flashPort.reset();
issue();
completeRead(Uint8Array.of(0, 0, 15, 16, 17, 18));
descriptor.setUint32(0x104, 0x103, true);
descriptor.setUint32(0x108, 0x200, true);
descriptor.setUint32(0x10C, 2, true);
arm();
flashPort.write(4, 3);
assert.equal(channelDMA.read(0x5000), 0x80008);
assert.equal(channelDMA.read(0x500C), 2);
assert.deepEqual([...memory.subarray(0x200, 0x202)], [15, 16]);
flashPort.set_state(flashPort.get_state());
channelDMA.set_state(channelDMA.get_state());
descriptor.setUint32(0x108, 0x220, true);
channelDMA.write(0x5000, 0x80000);
channelDMA.write(0x5000, 9);
assert.deepEqual([...memory.subarray(0x220, 0x222)], [17, 18]);
assert.equal(channelDMA.read(0x500C), 0);
assert.equal(channelDMA.read(0x5000), 0x80008);
console.log("PASS: NAND CDMA list refill interrupts preserve residual count and FIFO position across restore");

// A fast spare channel must not advance the IOP to another NAND row
// while the data channel is stopped for its descriptor refill interrupt.
flashPort.reset();
flashPort.write(0, 0xF5);
issue();
const fullRow = new Uint8Array(8192 + 436);
fullRow.set([21, 22, 23, 24], 2);
completeRead(fullRow);
channelDMA.write(0x600C, 2);
channelDMA.write(0x6000, 9);
flashPort.write(4, 3);
assert.equal(channelDMA.read(0x600C), 0);
assert.equal(flashPort.read(0xC) & 2, 0, "read completion waits for the data channel");
channelDMA.write(0x500C, 2);
channelDMA.write(0x5000, 9);
assert.equal(flashPort.read(0xC) & 2, 2);
console.log("PASS: spare completion waits for NAND data DMA before retiring the read");

// Reads on separate CEs may overlap. Switching back before draining the
// FIFO must select that chip's row even after saving and restoring.
const callbacks = [];
const banks = new AppleH2FMI(controllerCPU, 0x81200000, 0, {
    read(bus, ce, row, done) { callbacks[ce] = done; },
});
const twoIds = new Uint8Array(256);
twoIds[0] = twoIds[8] = 0xEC;
banks.configure(twoIds, 0);
for(const mask of [1, 2])
{
    banks.write(0x100C, mask);
    banks.write(0x1014, 0x3000);
    banks.write(0x1010, 11);
}
callbacks[1](Uint8Array.of(22, 0, 0, 0));
callbacks[0](Uint8Array.of(11, 0, 0, 0));
const bankState = banks.get_state();
banks.reset();
banks.set_state(bankState);
for(const [mask, byte] of [[2, 22], [1, 11]])
{
    banks.write(0x100C, mask);
    assert.equal(banks.read(0x14), byte);
}
console.log("PASS: interleaved chip read registers survive out-of-order completions and restore");

// An erase on CE1 can overlap an array read on CE0. NAND STATUS is
// chip-local; completing one operation must not discard the other one's IRQ.
let finishErase;
banks.nand.erase = (_bus, _ce, _row, done, fail) => { finishErase = { done, fail }; };
banks.reset();
banks.write(0x100C, 1);
banks.write(0x1014, 0x3000);
banks.write(0x1010, 11);
banks.write(0x1014, 0x70);
assert.equal(banks.read(0x1024) & 0x40, 0, "CE0 stays busy until its read completes");
banks.write(0x100C, 2);
assert.equal(banks.read(0x1024), 0xC0, "CE1 is independently ready");
banks.write(0x1014, 0xD060);
banks.write(0x1010, 9);
callbacks[0](Uint8Array.of(31, 0, 0, 0));
assert.equal(banks.read(0x1044), 11);
banks.write(0x1044, 11);
banks.write(0x1014, 0x70);
assert.equal(banks.read(0x1024) & 0x40, 0, "CE1 is still erasing");
finishErase.fail();
assert.equal(banks.read(0x1044), 9);
assert.equal(banks.read(0x1024), 0xC1);
const failedState = banks.get_state();
banks.reset();
banks.set_state(failedState);
assert.equal(banks.read(0x1024), 0xC1);
banks.write(0x100C, 1);
assert.equal(banks.read(0x1024), 0xC0);
banks.write(0x1014, 0);
assert.equal(banks.read(0x14), 31);
console.log("PASS: overlapping read and erase keep separate ready, fail and completion state per NAND chip");

// Boot-page programs do not use CDMA. 10B329 polls the TX FIFO before
// writing three 512-byte sectors, acknowledging each one independently.
flashPort.reset();
flashPort.write(0, 0xF0);
flashPort.write(0x100C, 1);
flashPort.write(0x1018, 0x02030000);
flashPort.write(0x101C, 1);
flashPort.write(0x1014, 0x80);
flashPort.write(0x1010, 9);
for(let sector = 0; sector < 3; sector++)
{
    flashPort.write(4, 5);
    assert.equal(flashPort.read(0x1C) & 0x18, 0x18);
    for(let word = 0; word < 128; word++)
    {
        if(sector === 1 && word === 99)
        {
            const state = flashPort.get_state();
            flashPort.reset();
            flashPort.set_state(state);
        }
        flashPort.write(0x14, sector * 128 + word);
    }
    assert.equal(flashPort.read(0x1C) & 0x18, 0);
    assert.equal(flashPort.read(0xC) & 2, 2);
    flashPort.write(0xC, 2);
}
flashPort.write(0x1014, 0x1000);
flashPort.write(0x1010, 2);
for(let i = 0; i < 384; i++)
    assert.equal(new DataView(programmed.buffer, programmed.byteOffset).getUint32(i * 4, true), i);
assert.ok(programmed.subarray(1536).every(b => b === 255));
finishProgram();
console.log("PASS: PIO boot-page programming, individual FIFO sectors and snapshot during a sector");

// The guest AES driver first configures both channels without START and
// then reads each control register back to set START. Both AP IRQs fire.
const aesPorts = new Map(), aesIrqs = [];
const pair = new AppleCDMA({ ...controllerCPU, io: { register_mmio(base, len, port) { aesPorts.set(base, port); } } },
    (n, level) => aesIrqs.push([n, level]));
const aesPort = aesPorts.get(0x87800000), cdmaPort = aesPorts.get(0x87000000);
const wr = (offset, value) => cdmaPort.write(offset, 4, value);
function pairTransfer(config, key, iv, input)
{
    for(let i = 0; i < 4; i++) aesPort.write(0x1010 + 4 * i, 4, iv.readUInt32LE(i * 4));
    for(let i = 0; i < key.length; i += 4) aesPort.write(0x1020 + i, 4, key.readUInt32LE(i));
    aesPort.write(0x1000, 4, config);
    memory.set(input, 0x400);
    for(const [n, addr, mode] of [[1, 0x400, 0x188], [2, 0x600, 0x88]])
    {
        const d = 0x300 + n * 16;
        descriptor.setUint32(d, 0, true);
        descriptor.setUint32(d + 4, n === 1 ? 0x30103 : 0x103, true);
        descriptor.setUint32(d + 8, addr, true);
        descriptor.setUint32(d + 12, input.length, true);
        wr(n * 4096, 2);
        wr(n * 4096 + 20, d);
        wr(n * 4096, mode);
        wr(n * 4096 + 12, input.length);
        assert.equal(pair.read(n * 4096), mode);
    }
    wr(0x1000, pair.read(0x1000) | 1);
    assert.equal(pair.read(0x100C), input.length);
    wr(0x2000, pair.read(0x2000) | 1);
    assert.deepEqual(aesIrqs.slice(-2), [[1, true], [2, true]]);
    for(const n of [1, 2])
    {
        assert.ok(pair.read(n * 4096) & 0x80000);
        assert.equal(pair.read(n * 4096 + 12), 0);
    }
    return Buffer.from(memory.subarray(0x600, 0x600 + input.length));
}
const blockIV = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const blockKey = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
const clear = Buffer.from("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51", "hex");
const encrypted = Buffer.from("7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2", "hex");
assert.deepEqual(pairTransfer(0x130100, blockKey, blockIV, clear), encrypted);
assert.deepEqual(pairTransfer(0x120100, blockKey, blockIV, encrypted), clear);
const uid835 = pairTransfer(0x030100, Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(16, 1));
assert.equal(uid835.toString("hex"), "75cbb019857f831fffd9e66d0110f2a9");
console.log("PASS: paired CDMA AES-CBC encrypt/decrypt, fixed N90 UID derivation and both completion interrupts");
