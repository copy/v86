#!/usr/bin/env node
// src/virt/inflate.js against Node's zlib: stored, fixed and dynamic blocks,
// gzip; the output limit of QCOW2 and VMDK compressed clusters
// (docs/disk-image-formats-plan.md P2); damaged streams fail instead of
// giving wrong data.

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { inflate, gunzip } from "../../src/virt/inflate.js";
import { random_generator, random_bytes } from "./samples.mjs";

const next = random_generator(7);
const inputs = {
    "random (stored blocks)": random_bytes(next, 200000),
    "text (dynamic blocks)": new TextEncoder().encode("v86 disk images ".repeat(5000) + "QCOW2 VMDK VHD VDI VHDX".repeat(300)),
    "zeros": new Uint8Array(65536),
    "short (fixed block)": Uint8Array.of(1, 2, 3, 4, 5),
    "mixed": Uint8Array.from({ length: 150000 }, (_, i) => i % 1000 < 500 ? (next() & 0xFF) : i & 7),
};
for(const [name, data] of Object.entries(inputs))
{
    for(const level of [0, 1, 6, 9])
    {
        const compressed = zlib.deflateRawSync(data, { level });
        const { output, end } = inflate(compressed, 0, data.length);
        assert.deepEqual(output, data, name + " level " + level);
        assert.equal(end, compressed.length, name + ": the end of the stream");
        // a limit: the first bytes, decoding stops there
        const half = Math.floor(data.length / 2);
        assert.deepEqual(inflate(compressed, 0, half, half).output, data.subarray(0, half), name + " limited");
        // trailing bytes after the stream (a cluster's last sector)
        const padded = new Uint8Array(compressed.length + 300);
        padded.set(compressed);
        padded.fill(0xA5, compressed.length);
        assert.deepEqual(inflate(padded, 0, data.length, data.length).output, data, name + " with garbage after it");
    }
}
assert.deepEqual(gunzip(new Uint8Array(zlib.gzipSync(inputs["mixed"]))), inputs["mixed"], "gunzip");
console.log("ok - inflate: the data of zlib's raw deflate at levels 0-9, limited, with trailing bytes; gunzip");

// damaged streams
const text = zlib.deflateRawSync(inputs["text (dynamic blocks)"]);
assert.throws(() => inflate(text.subarray(0, text.length >> 1)), /ends early/, "cut short");
const stored = new Uint8Array(zlib.deflateRawSync(inputs["random (stored blocks)"], { level: 0 }));
stored[3] ^= 0xFF;
assert.throws(() => inflate(stored), /length check/, "a stored block's NLEN");
const reserved = Uint8Array.of(0x07, 0, 0); // BFINAL, BTYPE 3
assert.throws(() => inflate(reserved), /reserved block type/);
// a fixed block whose first code is a match (no data before it)
const far = Uint8Array.of(0x03, 0x01, 0x00);
assert.throws(() => inflate(far), /distance before the start|ends early|invalid/);
let failures = 0, wrong = 0;
const data = inputs["mixed"];
const good = zlib.deflateRawSync(data);
for(let i = 0; i < 300; i++)
{
    const broken = new Uint8Array(good);
    broken[10 + next() % (broken.length - 20)] ^= 1 << (next() & 7);
    try
    {
        const { output } = inflate(broken, 0, data.length, data.length);
        if(output.length === data.length && Buffer.compare(Buffer.from(output), Buffer.from(data)) !== 0) wrong++;
    }
    catch(e)
    {
        failures++;
    }
}
console.log("ok - damaged streams: cut short, NLEN, reserved block, distances; of 300 single bit flips " + failures +
    " fail, " + wrong + " decode to other data of the full length (deflate has no checksum: QCOW2 clusters cannot tell)");
console.log("inflate tests passed");
