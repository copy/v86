import assert from "node:assert/strict";
import { AppleLIS331DLH } from "../../src/apple/sensors.js";
import { AppleI2C } from "../../src/apple/i2c.js";

const edges = [], sensor = new AppleLIS331DLH((line, level) => edges.push([line, level]));
assert.equal(sensor.read(0x0F), 0x32);
sensor.write(0x0F, 0); assert.equal(sensor.read(0x0F), 0x32);
assert.equal(sensor.timer(10), 100);
assert.equal(sensor.read(0x27), 0);
sensor.write(0x22, 2 | 2 << 3);
sensor.write(0x20, 0x27);
assert.equal(sensor.timer(10), 20);
assert.equal(sensor.timer(29), 1);
sensor.timer(30);
assert.equal(sensor.read(0x27), 15);
assert.deepEqual(edges, [[0, true], [1, true]]);
const raw = () => Buffer.from(Array.from({ length: 6 }, (_, i) => sensor.read(0x28 + i)));
assert.equal(raw().readInt16LE(0), 16000, "one g is 1000 left-aligned 12-bit digits at +/-2g");
assert.equal(sensor.read(0x27), 0);
assert.deepEqual(edges.slice(-2), [[0, false], [1, false]]);
for(const [angle, values] of [[90, [0, 16000, 0]], [180, [-16000, 0, 0]], [270, [0, -16000, 0]], [0, [16000, 0, 0]]])
{
    assert.ok(sensor.set_orientation(angle));
    sensor.timer(sensor.next_sample);
    const data = raw();
    assert.deepEqual([0, 2, 4].map(at => data.readInt16LE(at)), values);
}
assert.equal(sensor.set_orientation(45), false);
assert.equal(sensor.set_gravity(NaN, 0, 0), false);
console.log("PASS: LIS331DLH identity, sampling period, data-ready lines, signed physical acceleration and four orientations");

sensor.write(0x23, 0x80);
sensor.set_gravity(0.25, -0.5, 1);
sensor.timer(sensor.next_sample);
assert.equal(sensor.read(0x28), 0xA0);
const saved = sensor.get_state();
sensor.set_gravity(1, 1, 1);
sensor.timer(sensor.next_sample);
assert.equal(sensor.read(0x29), 0x0F, "BDU keeps both halves of the 0.25g sample");
assert.ok(sensor.read(0x27) & 0x80);
sensor.set_state(saved);
assert.equal(sensor.read(0x29), 0x0F);
assert.equal(sensor.read(0x27) & 1, 0, "snapshot preserves a half-read axis");
assert.equal(raw().readInt16LE(2), -8000);
sensor.write(0x23, 0x50); // +/-4g, MSB first
sensor.timer(sensor.next_sample);
assert.equal(raw().readInt16BE(4), 8000);
sensor.write(0x23, 0x30); // +/-8g: nominal 3.9 mg/digit
sensor.timer(sensor.next_sample);
assert.equal(raw().readInt16LE(4), 4096);
sensor.write(0x23, 2); sensor.set_gravity(0, 0, 0);
sensor.timer(sensor.next_sample);
assert.deepEqual([0, 2, 4].map(at => sensor.regs[0x28 + at] | sensor.regs[0x29 + at] << 8), [4800, 4800, 5600]);
raw(); sensor.write(0x20, 7);
sensor.timer(1000000); assert.equal(sensor.read(0x27), 0);
sensor.set_state(null); assert.equal(sensor.read(0x20), 7);
console.log("PASS: BDU, overrun, in-flight snapshot, byte order, full scale, self-test and power-down");

sensor.write(0x22, 4); // INT1 threshold source, latched
sensor.write(0x30, 2); // positive X
sensor.write(0x32, 32); // 0.5g at +/-2g
sensor.write(0x33, 1); // two consecutive samples
sensor.write(0x20, 0x27);
sensor.timer(10); sensor.timer(30);
assert.equal(sensor.read(0x31), 2, "threshold duration has not elapsed");
sensor.timer(50);
assert.deepEqual(edges.at(-1), [0, true]);
sensor.set_gravity(-1, 0, 0); sensor.timer(70);
assert.equal(sensor.read(0x31), 0x42, "latched positive X event survives the reversal");
assert.deepEqual(edges.at(-1), [0, false]);
sensor.timer(90); assert.equal(sensor.read(0x31), 0);
sensor.reset();

// Exercise the actual controller's address and auto-increment phases.
const ports = new Map(), levels = [];
const cpu = { io: { register_mmio: (base, size, port) => ports.set(base, port) } };
const vic = { set_line: (irq, level) => levels.push(level) };
const bus = new AppleI2C(cpu, 0x83400000, 21, vic, false, null, null, new Map([[0x19, sensor]]));
const port = ports.get(0x83400000);
function transfer(address, register, count, bytes)
{
    port.write(0x0C, 4, 0x30);
    port.write(0, 4, address); port.write(0x10, 4, register); port.write(0x18, 4, count);
    if(bytes) bytes.forEach(byte => port.write(0x20, 4, byte));
    port.write(0x24, 4, bytes ? 5 : 4);
    return port.read(0x0C);
}
assert.equal(transfer(0x19, 0x0F, 1), 0x10);
assert.equal(port.read(0x20), 0x32);
assert.equal(transfer(0x19, 0xA0, 4, [0x27, 0, 2, 0x80]), 0x10);
assert.deepEqual(Array.from(sensor.regs.slice(0x20, 0x24)), [0x27, 0, 2, 0x80]);
sensor.timer(100); sensor.timer(120);
assert.equal(transfer(0x19, 0xA8, 6), 0x10);
assert.equal(port.read(0x20), 0x80);
const partial = bus.get_state();
assert.equal(port.read(0x20), 0x3E);
bus.set_state(partial); assert.equal(port.read(0x20), 0x3E);
assert.equal(transfer(0x18, 0x0F, 1), 0x20);
console.log("PASS: N90 accelerometer I2C address, register burst, missing slave and partial FIFO restore");
