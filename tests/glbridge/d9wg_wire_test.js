"use strict";
const assert = require("node:assert/strict");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
const W = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_wire.js");
const headerBytes = P.STRUCTS.BatchHeader.size;
const packet = () => P.encodeBatch([
    { opcode: P.OP.CREATE_DEVICE, payload: { device_handle: 7, width: 64, height: 64 } },
    { opcode: P.OP.CLEAR, payload: { device_handle: 7, clear_flags: 1, color: 0xff000000 } },
], { session_id_low: 0x12345678, session_id_high: 0x9abcdef0, flags: P.C.D9WG_BATCH_FLAG_PRESENT });
const validate = bytes => { const frame = W.readHeader(bytes);W.checkStream(frame.view, frame.end, frame.commandCount);return frame; };
const bytes = packet(), original = bytes.slice(), valid = validate(bytes);
assert.equal(valid.sessionKey, "9abcdef012345678");assert.equal(valid.present, true);assert.equal(valid.commandCount, 2);
assert.deepEqual(bytes, original);
// Views inside larger input and transport carrier tails must keep working.
const carrier = new Uint8Array(bytes.length + 19);carrier.set(bytes, 7);
assert.equal(validate(carrier.subarray(7)).end, bytes.length);
for (let minor = P.MIN_MINOR; minor <= P.VERSION_MINOR; minor++) {
    const old = bytes.slice();new DataView(old.buffer).setUint16(P.F.BatchHeader.version_minor, minor, true);validate(old);
}
const corrupt = (field, value, regex) => {
    const copy = bytes.slice();new DataView(copy.buffer).setUint32(P.F.BatchHeader[field], value, true);
    assert.throws(() => validate(copy), error => error instanceof W.D9WGStreamError && regex.test(error.message));
};
assert.throws(() => validate(bytes.subarray(0, 8)), /shorter than its header/);
corrupt("magic", 0, /wrong magic/);corrupt("command_bytes", bytes.length, /overruns/);corrupt("command_count", 3, /command_count/);
const wrongVersion = bytes.slice();new DataView(wrongVersion.buffer).setUint16(P.F.BatchHeader.version_minor, P.MIN_MINOR - 1, true);
assert.throws(() => validate(wrongVersion), W.D9WGStreamError);
const badSize = bytes.slice();new DataView(badSize.buffer).setUint32(headerBytes + P.F.CommandHeader.size, 0, true);
assert.throws(() => validate(badSize), /command size/);
const overrun = bytes.slice();new DataView(overrun.buffer).setUint32(headerBytes + P.F.CommandHeader.size, bytes.length, true);
assert.throws(() => validate(overrun), /command size/);
const sequence = bytes.slice(), view = new DataView(sequence.buffer), second = headerBytes + view.getUint32(headerBytes + P.F.CommandHeader.size, true);
view.setUint32(headerBytes + P.F.CommandHeader.sequence, 0xffffffff, true);view.setUint32(second + P.F.CommandHeader.sequence, 0, true);
validate(sequence);view.setUint32(second + P.F.CommandHeader.sequence, 2, true);
assert.throws(() => validate(sequence), /numbering expects 0/);
const future = P.encodeBatch([{ opcode: 0x7fff, payload: new Uint8Array(4) }]);validate(future);
for (const [name, opcode] of Object.entries(P.OP)) if (P.COMMANDS[name])
    assert.equal(W.MIN_PAYLOAD[opcode], P.minBytes(P.commandStruct(opcode)));
console.log("D9WG wire: pure framing, carrier views, minors, sequence wrap, corruption and unknown dispatch checked");
