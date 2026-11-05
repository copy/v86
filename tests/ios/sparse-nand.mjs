import assert from "node:assert/strict";
import { NAND_BYTES, NAND_SLOT } from "../../src/apple/nand_geometry.js";
import { open_sparse_nand } from "../../src/ios/sparse_nand.js";

let file = new Uint8Array(0);
const access = {
    getSize: () => file.length,
    truncate(length) {
        const next = new Uint8Array(length);
        next.set(file.subarray(0, length));
        file = next;
    },
    read(bytes, { at }) {
        const part = file.subarray(at, at + bytes.length);
        bytes.set(part);
        return part.length;
    },
    write(bytes, { at }) { file.set(bytes, at); return bytes.length; },
};
const disk = open_sparse_nand(access, true), blank = new Uint8Array(NAND_SLOT);
const tail = NAND_BYTES - NAND_SLOT, split = 16 * NAND_SLOT - 512;
const headerSize = file.length;
disk.write(tail, blank);
assert.equal(file.length, headerSize, "erased ranges require no host allocation");
const bytes = new Uint8Array(1024).fill(0x5C);
disk.write(split, bytes); // spans two chunks
disk.write(tail, new Uint8Array(NAND_SLOT).fill(0x69));
assert.ok(file.length < 1024 ** 2, "multi-gigabyte gaps stay sparse on disk");
const reopened = open_sparse_nand(access);
assert.equal(reopened.size, NAND_BYTES);
assert.deepEqual(reopened.read(split, 1024), bytes);
assert.equal(reopened.read(tail, 1)[0], 0x69);
assert.deepEqual(reopened.read(tail - 2 * NAND_SLOT, NAND_SLOT), blank);
assert.deepEqual(reopened.read(0, NAND_SLOT), blank);
reopened.write(tail, blank);
assert.deepEqual(open_sparse_nand(access).read(tail, NAND_SLOT), blank, "erase persists across reopening");
assert.throws(() => disk.read(NAND_BYTES, 1), /Outside/);
console.log("PASS: sparse iPhone NAND persists data across chunks and chips without allocating logical gaps");
