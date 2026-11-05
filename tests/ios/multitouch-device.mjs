import assert from "node:assert/strict";
import { AppleMultitouch } from "../../src/apple/multitouch.js";
import { AppleGPIO } from "../../src/apple/s5l8930.js";
const touch = new AppleMultitouch();
const transact = bytes => Uint8Array.from(bytes, (byte, i) => touch.exchange(byte, i === 0, bytes.length));
const encode = value => [value >>> 8 & 255, value & 255, value >>> 24, value >>> 16 & 255];
const checked = bytes => {
    const sum = bytes.slice(2).reduce((a, b) => a + b, 0) & 65535;
    return [...bytes, sum >>> 8, sum & 255];
};
const query = (size = 2) => transact(Array.from({ length: size }, (_, i) => i === 0 ? 0x1A : i === 1 ? 0xA1 : i & 1 ? 0xE1 : 0x18));
assert.deepEqual([...query()], [0x18, 0xE1]);
transact([0x1F, 1]);
assert.equal(touch.running, false, "execution requires a valid uploaded payload");
transact(checked([0x1C, 0x73, ...encode(0x10008FFC)]));
const pending = touch.get_state(); touch.reset(); touch.set_state(pending);
assert.deepEqual([...query(8).slice(2, 6)], encode(0x5A020028));
transact(checked([0x1E, 0x33, ...encode(0x1000300C), ...encode(0xFF00), ...encode(0x12345678)]));
assert.deepEqual([...query()], [0x4A, 0xD1]);
assert.equal(touch.registers.get(0x1000300C), 0x5600);
const corrupt = checked([0x1E, 0x33, ...encode(0x1000300C), ...encode(0xFFFFFFFF), ...encode(7)]);
corrupt[15] ^= 1; transact(corrupt);
assert.equal(touch.registers.get(0x1000300C), 0x5600);
transact(checked([0x1E, 0x33, ...encode(0x10008FFC), ...encode(0xFFFFFFFF), ...encode(7)]));
assert.equal(touch.registers.get(0x10008FFC), 0x5A020028, "chip identification is read-only");

const payload = Uint8Array.from({ length: 70000 }, (_, i) => i * 31 & 255);
const header = [0x30, 1, payload.length / 4 >>> 8, payload.length / 4 & 255, ...encode(0x10000000)];
const headerSum = header.slice(2).reduce((a, b) => a + b, 0);
const payloadSum = payload.reduce((a, b) => a + b, 0);
const packet = Uint8Array.from([0x18, 0xE1, ...header, headerSum >>> 8, headerSum & 255, ...payload, ...encode(payloadSum)]);
for(let i = 0; i < 12345; i++) touch.exchange(packet[i], i === 0, packet.length);
const mid = touch.get_state(); touch.reset(); touch.set_state(mid);
for(let i = 12345; i < packet.length; i++) touch.exchange(packet[i], false, packet.length);
assert.equal(touch.loaded, true);
assert.equal(touch.packet.length, 12, "streamed firmware bytes are not retained");
assert.deepEqual([...query()], [0x4B, 0xC1]);
const broken = packet.slice(); broken[20000] ^= 1;
touch.reset(); transact(broken);
assert.equal(touch.loaded, false, "payload checksum rejects corruption");
assert.deepEqual([...query()], [0x18, 0xE1]);
transact(packet); transact([0x1F, 1]);
assert.equal(touch.running, true);
console.log("PASS: N1 bootloader checksums, masked registers, read-only ID, execution gating and streaming snapshot");

function runtime(command, id, sequence = 0)
{
    const request = new Array(16).fill(0); request[0] = command; request[1] = id; request[2] = sequence;
    const reply = transact(request), sum = reply.slice(0, 14).reduce((a, b) => a + b, 0);
    assert.equal(reply[14] | reply[15] << 8, sum);
    assert.equal(reply[0], command);
    return reply;
}
const version = runtime(0xE2, 0);
assert.deepEqual([...version.slice(2, 5)], [2, 0, 2]);
for(const [id, length] of [[0xD1, 4], [0xD3, 8], [0xD0, 4], [0xA1, 4], [0xD9, 8]])
{
    const info = runtime(0xE3, id);
    assert.deepEqual([...info.slice(1, 5)], [id, 0, length, 0]);
    for(const sequence of [0, 1])
    {
        const report = runtime(0xE6, id, sequence);
        assert.equal(report[1], id); assert.equal(report[2], sequence);
        if(id === 0xD9)
        {
            const view = new DataView(report.buffer);
            assert.equal(view.getUint32(3, true), 640); assert.equal(view.getUint32(7, true), 960);
        }
    }
}
assert.equal(runtime(0xE3, 0xFF)[2], 1);
const active = touch.get_state(); touch.reset(); touch.set_state(active);
assert.equal(touch.running, true);
const gpio = new AppleGPIO({ io: { register_mmio() {} } }, { set_line() {} });
gpio.outputs.set(20, level => { if(!level) touch.reset(); });
gpio.write(20 * 4, 1); assert.equal(touch.running, true);
gpio.write(20 * 4, 0); assert.equal(touch.running, false); assert.equal(touch.loaded, false);
console.log("PASS: N1 version, report geometry, both report phases, checksums, unsupported ID and reset");
