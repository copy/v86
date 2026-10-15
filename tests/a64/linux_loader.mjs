#!/usr/bin/env node
// The virt machine's Linux loader (docs/arm64-virt-android16-plan.md P4.6):
// src/virt/loader.js unpacks Alpine's EFI zboot vmlinuz-virt with its own
// inflate (src/virt/inflate.js) to the Image the host's gunzip gives
// (tests/lib/alpine_image.mjs, the manifest's SHA-256), and places the
// kernel, the initrd and the device tree where the reference does.
import assert from "node:assert/strict";
import { createHash as create_hash } from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { root } from "./guest_runner.mjs";
import { unpack_kernel, image_placement } from "../../src/virt/loader.js";
import { gunzip } from "../../src/virt/inflate.js";

const directory = root + "build/a64-linux/";
const manifest = JSON.parse(fs.readFileSync(directory + "manifest.json", "utf8"));
const vmlinuz = fs.readFileSync(directory + "boot/vmlinuz-virt");
const sha256 = bytes => create_hash("sha256").update(bytes).digest("hex");
assert.equal(sha256(vmlinuz), manifest.vmlinuz_sha256, "vmlinuz-virt is the fixed one (tests/a64/linux_boot.mjs prepares it)");

let start = performance.now();
const image = unpack_kernel(new Uint8Array(vmlinuz.buffer, vmlinuz.byteOffset, vmlinuz.length));
const ms = (performance.now() - start).toFixed(0);
assert.equal(image.length, manifest.image_bytes, "Image size");
assert.equal(sha256(image), manifest.image_sha256, "Image SHA-256");
console.log(`PASS vmlinuz-virt unpacks to the Image (${image.length} bytes, ${ms} ms, SHA-256 ${manifest.image_sha256.slice(0, 8)}…)`);

const { offset, size } = image_placement(image);
assert.equal(offset, 0x200000, "the Image's text_offset is 0: it goes 2 MiB into RAM");
assert.ok(size >= image.length, "image_size covers the BSS");
console.log(`PASS the kernel at RAM + 0x${offset.toString(16)}, reaching 0x${size.toString(16)} bytes`);

// inflate against zlib on random data of every kind (stored, fixed and dynamic blocks)
for(const level of [0, 1, 6, 9])
{
    const data = Buffer.alloc(300000);
    for(let i = 0; i < data.length; i++) data[i] = level === 0 || i % 7 ? (i * 2654435761 >>> 24) & (i % 3 ? 0xFF : 0x0F) : 0x41;
    start = performance.now();
    assert.deepEqual(Buffer.from(gunzip(zlib.gzipSync(data, { level }))), data, "gunzip at level " + level);
    const fixed = zlib.deflateRawSync(data.subarray(0, 1000), { level, strategy: zlib.constants.Z_FIXED });
    assert.deepEqual(Buffer.from((await import("../../src/virt/inflate.js")).inflate(fixed).output), data.subarray(0, 1000));
}
console.log("PASS inflate agrees with zlib (stored, fixed and dynamic blocks)");
