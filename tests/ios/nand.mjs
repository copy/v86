// Inspect the published file independently of the builder's offset, page
// decoding and checksum helpers. No Apple firmware required.
import { AppleNAND, NAND_BYTES, NAND_DATA, NAND_PAGE, NAND_SLOT } from "../../src/apple/nand.js";
import { crc32 } from "node:zlib";
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
        const table = read(0, 0);
        assert.equal(table.toString("ascii", 0, 4), "ndrG");
        assert.equal(table.toString("ascii", 0x420, 0x424), "mrvn");
        assert.equal(table.readUInt32LE(0x42C), 2, "NVRAM exposes block geometry");
        const legacy = Buffer.alloc(3 * stride);
        table.writeUInt32LE(0, 0x42C);
        for(let row = 0; row < 3; row++) legacy.set(table.map(b => b ^ 255), row * stride);
        const oldMedium = new AppleNAND({}, {
            byteLength: NAND_BYTES,
            get(at, length, done) { done(legacy.subarray(at, at + length)); },
            set() { assert.fail("reading an old partition table must not rewrite the disk"); },
        });
        for(let row = 0; row < 3; row++)
        {
            const page = await new Promise((ok, fail) => oldMedium.read(0, 0, row, ok, fail));
            assert.equal(new DataView(page.buffer).getUint32(0x42C, true), row < 2 ? 2 : 0);
        }
        assert.equal(legacy.readUInt32LE(0x42C), 0xFFFFFFFF);
        const unit = read(0, 144).subarray(0, 1024);
        const magic = Buffer.from(unit.subarray(0, 16)).map((b, i) => b ^ unit[16 + i]);
        assert.equal(magic.toString("ascii", 0, 4), "ecaF");
        assert.equal(magic.readUInt32LE(4), 1);
        assert.equal(unit.readUInt32LE(60), crc32(unit.subarray(64), crc32(unit.subarray(32, 60), crc32(magic))));
        assert.equal(unit.readUInt32LE(68), 0x42414731);
        assert.equal(unit.readUInt16LE(126), 40);
        assert.equal(unit.readUInt32LE(128), 0x446B6579);
        assert.equal(unit.readUInt32LE(176), 0x444F4E45);
        assert.deepEqual(read(0, 528).subarray(0, 1024), unit);
        const last = (blocks - 1) * 128;
        assert.equal(read(0, last + 1).toString("ascii", 0, 14), "NANDDRIVERSIGN");
        const unique = read(0, last + 2);
        assert.equal(unique.toString("ascii", 0, 16), "DEVICEUNIQUEINFO");
        const cfg = unique.subarray(56, 56 + unique.readUInt32LE(52));
        assert.equal(cfg.readUInt32LE(), 0x53436667);
        assert.equal(cfg.readUInt32LE(4), cfg.length);
        assert.equal(cfg.readUInt32LE(8), cfg.length);
        assert.equal(cfg.readUInt32LE(20), (cfg.length - 24) / 20);
        assert.equal(cfg.readUInt32LE(24), 0x53724E6D);
        assert.equal(cfg.toString("ascii", 28, 40), "V86N90SIM001");
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
let writes = 0;
const disk = { byteLength: NAND_BYTES,
    get(at, length, done) { done(block.subarray(at, at + length)); },
    set(at, bytes, done) { writes++; block.set(bytes, at); done(); } };
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
assert.equal(medium.bytes_written, 3 * NAND_DATA, "only guest page programs count as writes");
assert.equal(medium.bytes_read, 3 * NAND_DATA, "internal reads for programs and erase are excluded");
console.log("PASS: NAND programs clear bits, block erase restores them and preserves the next block");
const afterErase = writes;
await new Promise((ok, fail) => medium.erase(0, 0, 127, ok, fail));
assert.equal(writes, afterErase, "erased blocks need no redundant overlay allocation");
assert.ok((await read(127)).every(b => b === 255));
const shortMedium = new AppleNAND({}, {
    byteLength: NAND_BYTES,
    get(at, length, done) { done(new Uint8Array(length - 1)); },
    set() { assert.fail("a short block read must not erase anything"); },
});
await assert.rejects(new Promise((ok, fail) => shortMedium.erase(0, 0, 0, ok, fail)), /short NAND block/);
console.log("PASS: repeated erase preserves sparse blocks and rejects incomplete reads");

// Failed speculative neighbours must not trigger the disk's stop policy
// when the requested page itself can be read.
let reads = 0;
const rangeDisk = {
    byteLength: NAND_BYTES, disk_error: "stop",
    get(at, length, done) { reads++; done(block.subarray(at, at + length)); },
};
const rangeCPU = {}, rangeMedium = new AppleNAND(rangeCPU, rangeDisk);
const rangeRead = row => new Promise((ok, fail) => rangeMedium.read(0, 0, row, ok, fail));
await rangeRead(1);
await rangeRead(2);
assert.equal(reads, 1, "adjacent pages share one host read");
assert.equal(rangeMedium.bytes_read, 2 * NAND_DATA, "count guest pages even when one host prefetch serves both");
rangeMedium.reset();
rangeDisk.get = (at, length, done) => {
    reads++;
    if(length > NAND_SLOT) done(undefined, new Error("unavailable neighbour"));
    else done(block.subarray(at, at + length));
};
assert.deepEqual(await rangeRead(2), await read(2));
assert.equal(reads, 3);
assert.ok(!rangeCPU.disk_holds?.length);
console.log("PASS: bounded NAND read-ahead, reset and exact-page fallback before disk error policy");

// A read which started before a program can complete afterwards. Its
// private result must not displace the newly programmed range.
const delayed = [], raw = new Uint8Array(16 * NAND_SLOT);
const racingMedium = new AppleNAND({}, {
    byteLength: NAND_BYTES,
    get(at, n, done) {
        const bytes = raw.slice(at, at + n);
        if(n > NAND_SLOT) delayed.push(() => done(bytes)); else done(bytes);
    },
    set(at, bytes, done) { raw.set(bytes, at); done(); },
});
const racingRead = () => new Promise((ok, fail) => racingMedium.read(0, 0, 0, ok, fail));
const oldPage = racingRead();
await new Promise((ok, fail) => racingMedium.program(0, 0, 0, page, ok, fail));
const newPage = racingRead();
delayed.pop()();
delayed.pop()();
assert.equal((await oldPage)[0], 0xFF);
assert.equal((await newPage)[0], page[0]);
assert.equal((await racingRead())[0], page[0]);
console.log("PASS: late pre-program read cannot replace the new NAND range");

// Native verify can reach the chip before an asynchronous host program
// has read the old slot or committed the overlay. The verify and the next
// program must observe the issued order even if the disk has a cached range.
const queuedCPU = {}, writesPending = [];
const queuedMedium = new AppleNAND(queuedCPU, {
    byteLength: NAND_BYTES,
    get(at, n, done) { done(raw.slice(at, at + n)); },
    set(at, bytes, done) { writesPending.push(() => { raw.set(bytes, at); done(); }); },
});
const qread = () => new Promise((ok, fail) => queuedMedium.read(0, 0, 0, ok, fail));
const qwrite = value => {
    const bytes = new Uint8Array(NAND_PAGE).fill(255);
    bytes[0] = value;
    return new Promise((ok, fail) => queuedMedium.program(0, 0, 0, bytes, ok, fail));
};
const first = qwrite(0x0F), verify = qread(), second = qwrite(0xF0);
assert.ok(queuedCPU.snapshot_io_pending >= 3, "a snapshot must wait for the queued verify and second program");
assert.equal(writesPending.length, 1);
writesPending.shift()();
assert.equal((await verify)[0], page[0] & 0x0F);
await first;
assert.equal(writesPending.length, 1);
writesPending.shift()();
await second;
assert.equal((await qread())[0], 0);
assert.equal(queuedCPU.snapshot_io_pending, 0);
console.log("PASS: verify reads and subsequent programs cannot pass a pending program on their chip");
