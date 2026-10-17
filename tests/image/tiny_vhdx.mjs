// A small VHDX image built in memory ([MS-VHDX] 2.2), for the tests of
// logical sectors of 4096 bytes, which qemu-img does not make: the file type
// identifier, two headers and two region tables with their CRC-32C, an empty
// log, the metadata (block size, virtual size, disk ID, logical and physical
// sector sizes) and the BAT, whose sector bitmap entries follow every
// chunk_ratio = 2^23 * logical sector size / block size payload blocks.
// Blocks with data are FULLY_PRESENT (the rest of such a block is zeros),
// blocks listed in `zero` are ZERO, the others NOT_PRESENT. tests/image/
// sector_size.mjs checks the builder's 512-byte images against qemu-img.

import { crc32c } from "../../src/image/vhdx.js";

const KiB = 1024, MiB = 1024 * 1024;

/**
 * A GUID's 16 bytes ([MS-DTYP]: the first three fields little-endian)
 * @param {string} text
 * @return {!Uint8Array}
 */
function guid_bytes(text)
{
    const hex = text.replace(/-/g, "");
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.substr(i * 2, 2), 16));
    return Uint8Array.from([3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15].map(i => bytes[i]));
}

const GUID_BAT = "2dc27766-f623-4200-9d64-115e9bfd4a08";
const GUID_METADATA = "8b7ca206-4790-4b9a-b8fe-575f050f886e";
const GUID_FILE_PARAMETERS = "caa16737-fa36-4d43-b3b6-33f0aa44e76b";
const GUID_VIRTUAL_DISK_SIZE = "2fa54224-cd1b-4876-b211-5dbed83bf4b8";
const GUID_VIRTUAL_DISK_ID = "beca12ab-b2e6-4523-93ef-c309e000c746";
const GUID_LOGICAL_SECTOR_SIZE = "8141bf1d-a96f-4709-ba47-f233a8faab5f";
const GUID_PHYSICAL_SECTOR_SIZE = "cda348c7-445d-4471-9cc9-e9885251c556";

const PAYLOAD_NOT_PRESENT = 0, PAYLOAD_ZERO = 2, PAYLOAD_FULLY_PRESENT = 6;

/**
 * @param {{size: number, block_size?: number, logical_sector_size?: number, physical_sector_size?: number,
 *          data?: Array<[number, Uint8Array]>, zero?: Array<number>}} options
 *   data: [guest offset, bytes]; zero: guest offsets of ZERO blocks
 * @return {{image: !Uint8Array, chunk_ratio: number, bat_offset: number, bat_index: function(number):number}}
 */
export function build_vhdx({ size, block_size = MiB, logical_sector_size = 4096, physical_sector_size = logical_sector_size,
    data = [], zero = [] })
{
    const chunk_ratio = 2 ** 23 * logical_sector_size / block_size;
    const payload_blocks = Math.ceil(size / block_size);
    const bat_entries = payload_blocks + Math.floor((payload_blocks - 1) / chunk_ratio);
    const bat_index = block => block + Math.floor(block / chunk_ratio);
    const LOG = 1 * MiB, METADATA = 2 * MiB, BAT = 3 * MiB;
    const bat_length = Math.ceil(bat_entries * 8 / MiB) * MiB;
    let next = BAT + bat_length;

    // the blocks with data, in the order of their first byte
    const blocks = new Map();
    for(const [offset, bytes] of data)
    {
        for(let at = offset; at < offset + bytes.length;)
        {
            const block = Math.floor(at / block_size);
            if(!blocks.has(block))
            {
                blocks.set(block, { file_offset: next, bytes: new Uint8Array(block_size) });
                next += block_size;
            }
            const in_block = at - block * block_size;
            const count = Math.min(block_size - in_block, offset + bytes.length - at);
            blocks.get(block).bytes.set(bytes.subarray(at - offset, at - offset + count), in_block);
            at += count;
        }
    }

    const image = new Uint8Array(next);
    const view = new DataView(image.buffer);
    image.set(new TextEncoder().encode("vhdxfile"), 0);
    // the creator (UTF-16)
    [..."v86 tests"].forEach((c, i) => view.setUint16(8 + 2 * i, c.charCodeAt(0), true));

    for(const [at, sequence] of [[64 * KiB, 1n], [128 * KiB, 2n]])
    {
        image.set(new TextEncoder().encode("head"), at);
        view.setBigUint64(at + 8, sequence, true);
        image.set(guid_bytes("11111111-2222-3333-4444-555555555555"), at + 16);
        image.set(guid_bytes("66666666-7777-8888-9999-aaaaaaaaaaaa"), at + 32);
        // (the log GUID stays zero: no log to replay)
        view.setUint16(at + 64, 0, true);
        view.setUint16(at + 66, 1, true);
        view.setUint32(at + 68, MiB, true);
        view.setBigUint64(at + 72, BigInt(LOG), true);
        view.setUint32(at + 4, crc32c(image.subarray(at, at + 4 * KiB), 4), true);
    }

    for(const at of [192 * KiB, 256 * KiB])
    {
        image.set(new TextEncoder().encode("regi"), at);
        view.setUint32(at + 8, 2, true);
        const regions = [[GUID_BAT, BAT, bat_length], [GUID_METADATA, METADATA, MiB]];
        regions.forEach(([id, offset, length], i) =>
        {
            const entry = at + 16 + i * 32;
            image.set(guid_bytes(id), entry);
            view.setBigUint64(entry + 16, BigInt(offset), true);
            view.setUint32(entry + 24, length, true);
            view.setUint32(entry + 28, 1, true);
        });
        view.setUint32(at + 4, crc32c(image.subarray(at, at + 64 * KiB), 4), true);
    }

    image.set(new TextEncoder().encode("metadata"), METADATA);
    const REQUIRED = 4, VIRTUAL_DISK = 2;
    const items = [
        [GUID_FILE_PARAMETERS, REQUIRED, bytes => { new DataView(bytes.buffer).setUint32(0, block_size, true); }, 8],
        [GUID_VIRTUAL_DISK_SIZE, REQUIRED | VIRTUAL_DISK, bytes => { new DataView(bytes.buffer).setBigUint64(0, BigInt(size), true); }, 8],
        [GUID_VIRTUAL_DISK_ID, REQUIRED | VIRTUAL_DISK, bytes => { bytes.set(guid_bytes("0123abcd-4567-89ef-0123-456789abcdef")); }, 16],
        [GUID_LOGICAL_SECTOR_SIZE, REQUIRED | VIRTUAL_DISK, bytes => { new DataView(bytes.buffer).setUint32(0, logical_sector_size, true); }, 4],
        [GUID_PHYSICAL_SECTOR_SIZE, REQUIRED | VIRTUAL_DISK, bytes => { new DataView(bytes.buffer).setUint32(0, physical_sector_size, true); }, 4],
    ];
    view.setUint16(METADATA + 10, items.length, true);
    let item_offset = 64 * KiB;
    items.forEach(([id, flags, fill, length], i) =>
    {
        const entry = METADATA + 32 + i * 32;
        image.set(guid_bytes(id), entry);
        view.setUint32(entry + 16, item_offset, true);
        view.setUint32(entry + 20, length, true);
        view.setUint32(entry + 24, flags, true);
        const bytes = new Uint8Array(length);
        fill(bytes);
        image.set(bytes, METADATA + item_offset);
        item_offset += 64;
    });

    const set_entry = (block, state, file_offset) =>
        view.setBigUint64(BAT + bat_index(block) * 8, BigInt(file_offset / MiB) << 20n | BigInt(state), true);
    for(let block = 0; block < payload_blocks; block++) set_entry(block, PAYLOAD_NOT_PRESENT, 0);
    for(const offset of zero) set_entry(Math.floor(offset / block_size), PAYLOAD_ZERO, 0);
    for(const [block, { file_offset, bytes }] of blocks)
    {
        set_entry(block, PAYLOAD_FULLY_PRESENT, file_offset);
        image.set(bytes, file_offset);
    }
    return { image, chunk_ratio, bat_offset: BAT, bat_index };
}
