// Inspect the published file independently of the builder's offset, page
// decoding and checksum helpers. No Apple firmware required.
import { AppleNAND, NAND_BYTES, NAND_PAGE, NAND_SLOT } from "../../src/apple/nand.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v86-nand-"));
const file = path.join(dir, "flash.img");
const builder = fileURLToPath(new URL("../../tools/ios/nand_build.mjs", import.meta.url));
try
{
    execFileSync(process.execPath, [builder, "format", file]);
    const blocks = 4152, rows = blocks * 128, stride = 8704;
    assert.equal(fs.statSync(file).size, 4 * rows * stride);
    const fd = fs.openSync(file, "r");
    try
    {
        function read(chip, row)
        {
            const bytes = Buffer.alloc(stride);
            assert.equal(fs.readSync(fd, bytes, 0, stride, (chip * rows + row) * stride), stride);
            return bytes.map(b => b ^ 255);
        }
        assert.deepEqual(read(0, 0), read(0, 1));
        assert.equal(read(0, 0).toString("ascii", 0, 4), "ndrG");
        const last = (blocks - 1) * 128;
        assert.equal(read(0, last + 1).toString("ascii", 0, 14), "NANDDRIVERSIGN");
        const control = 3997 * 128;
        const checkpoint = read(0, control);
        assert.equal(checkpoint.toString("ascii", 0, 4), "CX01");
        assert.equal(checkpoint.readUInt32LE(8), 0x1F1468);
        assert.equal(checkpoint.readUInt16LE(0x5C), 1000);
        assert.ok(read(3, control).subarray(0, 8192).every(b => b === 0));
        assert.ok(read(0, control + 1).subarray(0, 8192).every(b => b === 255));
        assert.equal(read(2, control + 1)[3997], 0x10);
        assert.ok(read(3, control + 2).every(b => b === 255), "journal starts erased");
        for(let chip = 0; chip < 4; chip++)
        {
            assert.equal(read(chip, last).toString("ascii", 0, 13), "DEVICEINFOBBT");
            const first = 15 * 128, page = read(chip, first);
            assert.equal(page.readUInt32LE(8), 2);
            assert.equal(page.readUInt16LE(0x68E), 15);
            assert.equal(page.readUInt32LE(0x7F4), 2);
            let sum = 0, xor = 0;
            for(let at = 0; at < 0x7F8; at += 4)
            {
                sum += page.readUInt32LE(at);
                xor ^= page.readUInt32LE(at);
            }
            assert.equal(page.readUInt32LE(0x7F8), (sum + 0xAABBCCDD) >>> 0);
            assert.equal(page.readUInt32LE(0x7FC), (xor ^ 0xAABBCCDD) >>> 0);
            const lastCopy = read(chip, first + 7);
            assert.deepEqual(page.subarray(0, 8192), lastCopy.subarray(0, 8192));
            assert.equal(page.toString("hex", 8192, 8204), "ed5c44725044b717b1fe070a");
            assert.equal(lastCopy.toString("hex", 8192, 8204), "9cf19af3ebdfbb2908e710fc");
            assert.ok(read(chip, first + 8).every(b => b === 255));
        }
    }
    finally { fs.closeSync(fd); }
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("PASS: raw N90 layout, factory pages, VSVFL checksums, spare whitening and erased rows");

// A single sparse block and the adjacent guard slot exercise the real disk
// backend, including reprogramming without erase and preserving neighbours.
const block = new Uint8Array(129 * NAND_SLOT);
const disk = { byteLength: NAND_BYTES,
    get(at, length, done) { done(block.subarray(at, at + length)); },
    set(at, bytes, done) { block.set(bytes, at); done(); } };
const medium = new AppleNAND({}, disk);
const write = (row, data) => new Promise((ok, fail) => medium.program(0, 0, row, data, ok, fail));
const read = row => new Promise((ok, fail) => medium.read(0, 0, row, ok, fail));
const page = new Uint8Array(NAND_PAGE).fill(255);
page[0] = 0xAC;
page[8192] = 0x0F;
await write(127, page);
await write(128, page);
page[0] = 0x5A;
page[8192] = 0xF0;
await write(127, page);
const result = await read(127);
assert.equal(result[0], 0x08);
assert.equal(result[8192], 0);
await new Promise((ok, fail) => medium.erase(0, 0, 127, ok, fail));
assert.ok((await read(127)).every(b => b === 255));
assert.equal((await read(128))[0], 0xAC);
console.log("PASS: NAND programs clear bits, block erase restores them and preserves the next block");
