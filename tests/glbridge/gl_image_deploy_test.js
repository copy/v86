"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
(async () => {
    const { hash_file, parse_patch, apply_patch_clone } = await import("../../tools/gl_guest_deploy.mjs"), directory = fs.mkdtempSync(path.join(os.tmpdir(), "gl-image-patch-"));
    try {
        const image = path.join(directory, "image.img"), before = Buffer.alloc(1024), raw = Buffer.alloc(24 + 16 + 512);fs.writeFileSync(image, before);
        raw.write("V86GLDP1");raw.writeUInt32LE(256, 8);raw.writeUInt32LE(2, 12);raw.writeBigUInt64LE(1024n, 16);raw.writeBigUInt64LE(1n, 24);raw.writeBigUInt64LE(3n, 32);raw.fill(0x7B, 40, 296);raw.fill(0x2A, 296);
        assert.deepEqual(parse_patch(raw, 1024).indices, [1, 3]);
        const corrupt = Buffer.from(raw);corrupt.writeBigUInt64LE(4n, 32);assert.throws(() => parse_patch(corrupt, 1024), /outside/);corrupt.writeBigUInt64LE(1n, 32);assert.throws(() => parse_patch(corrupt, 1024), /Duplicate/);assert.throws(() => parse_patch(raw.subarray(0, -1), 1024), /length/);assert.throws(() => parse_patch(raw, 2048), /header/);
        assert.throws(() => apply_patch_clone({ image, expected_hash: "wrong", raw }), /changed/);assert.deepEqual(fs.readFileSync(image), before);
        const result = apply_patch_clone({ image, expected_hash: hash_file(image), raw }), expected = Buffer.from(before);expected.fill(0x7B, 256, 512);expected.fill(0x2A, 768, 1024);
        assert.deepEqual(fs.readFileSync(image), expected);assert.deepEqual(fs.readFileSync(result.backup), before);assert.equal(result.blocks, 2);assert.equal(result.after, hash_file(image));assert.equal(result.ntfsFlags, null);assert.ok(!fs.readdirSync(directory).some(name => name.endsWith(".staging")));
        console.log("PASS image deployment: bounded/unique blocks, source digest, APFS clone, preserved backup and exact untouched bytes");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error);process.exitCode = 1; });
