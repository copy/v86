// Peripheral contracts used during the 10B329 bootstrap; no Apple images.
import assert from "node:assert/strict";
import { AppleVIC } from "../../src/apple/vic.js";
import { AppleTimer } from "../../src/apple/timer.js";
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
