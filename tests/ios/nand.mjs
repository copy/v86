// Inspect the published file independently of the builder's offset, page
// decoding and checksum helpers. No Apple firmware required.
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
    execFileSync(process.execPath, [builder, "bootstrap", file]);
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
