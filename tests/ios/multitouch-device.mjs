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
assert.deepEqual([...runtime(0xE6, 0xD1, 1).slice(3, 7)], [0x55, 0, 0, 0], "N1F55 family report");
assert.deepEqual([...runtime(0xE6, 0xD3, 1).slice(3, 8)], [1, 15, 10, 1, 0],
    "sensor report separates byte order, rows, columns and BCD version from the family");
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
            assert.equal(view.getUint32(3, true), 5000); assert.equal(view.getUint32(7, true), 7500);
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

transact(packet); transact([0x1F, 1]);
let interrupts = 0; touch.interrupt = () => interrupts++;
function frame_request(sequence, size = 16)
{
    const bytes = new Array(size).fill(0);
    bytes[0] = 0xEB; bytes[1] = sequence; bytes[2] = size === 16 ? 0 : 1;
    const check = bytes.slice(0, 14).reduce((a, b) => a + b, 0);
    bytes[size - 2] = check & 255; bytes[size - 1] = check >>> 8;
    return bytes;
}
const idle = transact(frame_request(1));
assert.equal(idle[1] | idle[2] << 8, 0);
touch.set_contacts([[1, 160, 240]], 100);
touch.set_contacts([[1, 320, 480]], 120);
touch.set_contacts([], 140);
assert.equal(interrupts, 3);
for(const [i, event] of [3, 4, 7].entries())
{
    const sequence = i % 2 + 1, header = transact(frame_request(sequence));
    const size = header[1] | header[2] << 8;
    assert.equal(size, 54);
    const request = frame_request(sequence, size + 5);
    if(i === 0)
    {
        const bad = request.slice(); bad[bad.length - 1] ^= 1; transact(bad);
        assert.equal(touch.frames.length, 3, "a corrupt request cannot consume the contact");
    }
    for(let j = 0; j < 17; j++) touch.exchange(request[j], j === 0, request.length);
    const saved = touch.get_state(); touch.reset(); touch.set_state(saved);
    const response = [...request.slice(17)].map(byte => touch.exchange(byte, false, request.length));
    assert.equal(response.length, size - 12);
    const before = touch.frames.length, full = transact(request);
    assert.equal(touch.frames.length, before, "retrying one sequence does not consume the next frame");
    assert.equal(full.slice(0, 5).reduce((a, b) => a + b, 0) & 255, 0);
    assert.equal(full[2] | full[3] << 8, size);
    assert.equal(full[full.length - 2] | full[full.length - 1] << 8,
        full.slice(5, -2).reduce((a, b) => a + b, 0));
    assert.deepEqual([...full.slice(5, 9)], [0x44, i, 24, 1]);
    assert.equal(full[5 + 24 + 1], event);
    assert.equal(full[5 + 24 + 2], 1, "report a finger, not an unclassified contact");
}
assert.equal(touch.frames.length, 0);
assert.equal(transact(frame_request(2))[1], 0, "the following sequence acknowledges the final frame");
touch.set_contacts([[2, -10, 2000], [3, 1, 2]], 200);
const two = touch.frames[0];
assert.equal(two[16], 2);
assert.deepEqual(two.slice(28, 32), [0xAD, 0xFF, 0xB4, 0xFF], "clipped edges are signed sensor coordinates");
assert.equal(touch.get_state()[11][0].length, 80);
touch.reset(); assert.equal(touch.frames.length, 0); assert.equal(touch.contacts.size, 0);
console.log("PASS: N1 down/move/up frames, two contacts, clipping, CRC, retry, queued IRQs and partial-frame snapshots");

const enabled = [];
const input = new AppleMultitouch(() => {}, ready => enabled.push(ready), () => 123456);
input.loaded = true;
for(const [i, byte] of [0x1F, 1].entries()) input.exchange(byte, i === 0, 2);
input.absolute([80, 120, 320, 480]); input.click([true, false, false]);
input.absolute([160, 240, 320, 480]); input.click([false, false, false]);
assert.deepEqual(input.frames.map(frame => frame[25]), [3, 4, 7]);
assert.ok(input.frames.every(frame => frame[24] > 0), "the native input stack ignores path zero");
assert.deepEqual(input.frames[1].slice(28, 32), [0xF3, 8, 0x10, 0x0E]);
const count = input.frames.length;
input.absolute([NaN, 2, 320, 480]); input.absolute([1, 2, 0, 480]);
input.click([false, false, false]); assert.equal(input.frames.length, count);
input.touch_input({ touches: [[5000, 80, 120], [8000, 160, 240]], width: 320, height: 480 });
const ids = [...input.host_ids.values()];
assert.deepEqual(ids, [2, 3], "browser contacts avoid N1's discarded HID path zero");
input.touch_input({ touches: [[8000, 240, 360]], width: 320, height: 480 });
assert.equal(input.host_ids.get(8000), ids[1], "browser touch identities survive reorder and removal");
const host = input.get_state(); input.reset(); input.set_state(host);
assert.equal(enabled[enabled.length - 1], true);
input.touch_input({ touches: [], width: 320, height: 480 });
assert.equal(input.frames[input.frames.length - 1][25], 7);
const legacy = input.get_state();
legacy[12] = [[0, [160, 240]]];
legacy[19] = [[5000, 0]];
input.set_state(legacy);
input.touch_input({ touches: [[5000, 80, 120]], width: 320, height: 480 });
assert.deepEqual(input.frames.at(-1).slice(24, 26), [2, 3], "a legacy path zero starts a real touch after restore");
input.reset(); assert.equal(enabled[enabled.length - 1], false);
assert.equal(input.host_ids.size, 0); assert.equal(input.pointer[2], false);
console.log("PASS: scaled browser mouse and multi-touch input, stable IDs, restore readiness and reset release");
