import assert from "node:assert/strict";
import { NAND_DATA, NAND_SLOT, NAND_BLOCK_PAGES, nand_offset } from "../../src/apple/nand_geometry.js";
import { read_nand_boot, write_nand_boot } from "../../src/ios/nand_boot.js";

// The boot input spans the chip boundary and shares a page with the tree.
const kernel = Uint8Array.from({ length: 7 * NAND_BLOCK_PAGES * NAND_DATA + 137 }, (_, i) => i ^ i >>> 8 ^ i >>> 16);
const tree = Uint8Array.of(1, 5, 9, 13), logo = Uint8Array.of(2, 4, 6), library = Uint8Array.of(8, 16);
const slots = new Map();
write_nand_boot((bus, ce, row, bytes) => {
    const slot = new Uint8Array(NAND_SLOT);
    slot.set(bytes.map(byte => ~byte));
    slots.set(nand_offset(bus, ce, row), slot);
}, kernel, tree, logo, library);
const read = (at, n) => {
    const bytes = new Uint8Array(n);
    for(let i = 0; i < n; i += NAND_SLOT)
    {
        assert.ok(slots.has(at + i), "the boot loader must read only its programmed pages");
        bytes.set(slots.get(at + i), i);
    }
    return bytes;
};
const files = await read_nand_boot(read);
for(const [name, bytes] of Object.entries({ kernel, tree, logo, library }))
    assert.deepEqual(new Uint8Array(files[name]), bytes);
slots.get(nand_offset(0, 1, 7 * NAND_BLOCK_PAGES))[33] ^= 1;
await assert.rejects(read_nand_boot(read), /Corrupt iPhone NAND boot file/);
console.log("PASS: boot archive spans chips, preserves all four files and rejects corruption");
