"use strict";
const assert = require("node:assert/strict"), { encode, decode } = require("./gl_game_trace_codec.js");
(async () => {
    const frames = [[new Uint8Array([1, 2, 3]), new Uint8Array([4])], [], [new Uint8Array([5, 6])]], bytes = new Uint8Array(await encode(frames).arrayBuffer());
    assert.deepEqual(decode(bytes), frames);assert.equal(new DataView(bytes.buffer).getUint32(8, true), 3);
    for (const cut of [0, 8, 11, 13, bytes.length - 1]) assert.throws(() => decode(bytes.subarray(0, cut)));
    const badCount = bytes.slice();new DataView(badCount.buffer).setUint32(8, 0xffffffff, true);assert.throws(() => decode(badCount));
    const badSize = bytes.slice();new DataView(badSize.buffer).setUint32(16, 0xffffffff, true);assert.throws(() => decode(badSize));
    assert.throws(() => decode(new Uint8Array([...bytes, 0])));assert.throws(() => encode([]));assert.throws(() => encode([[new Uint8Array()]]));
    console.log("GL game traces retain frame boundaries and reject malformed or truncated recordings (passed)");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
