// VHDX images (docs/disk-image-formats-plan.md P5; the format: [MS-VHDX]):
// the two headers (the current one: valid, the higher sequence number), the
// region tables, the metadata (block size, virtual size, sector sizes) and
// the BAT, every structure with its CRC-32C. Refused: a log to replay (its
// replay changes what the file holds, [MS-VHDX] 2.3.3: an image with a log is
// not read without it), a parent (differencing disks), logical sectors of
// 4096 bytes (the devices have 512), unknown required regions or metadata.

import { DiskImageError } from "./source.js";
import { ImageReader, EXTENT_DATA, EXTENT_ZERO, push_extent, read_u64, to_number, big } from "./disk_image.js";
import { sha256_hex } from "./sha256.js";

const KiB = 1024, MiB = 1024 * 1024;

const GUID_BAT = "2dc27766-f623-4200-9d64-115e9bfd4a08";
const GUID_METADATA = "8b7ca206-4790-4b9a-b8fe-575f050f886e";
const GUID_FILE_PARAMETERS = "caa16737-fa36-4d43-b3b6-33f0aa44e76b";
const GUID_VIRTUAL_DISK_SIZE = "2fa54224-cd1b-4876-b211-5dbed83bf4b8";
const GUID_VIRTUAL_DISK_ID = "beca12ab-b2e6-4523-93ef-c309e000c746";
const GUID_LOGICAL_SECTOR_SIZE = "8141bf1d-a96f-4709-ba47-f233a8faab5f";
const GUID_PHYSICAL_SECTOR_SIZE = "cda348c7-445d-4471-9cc9-e9885251c556";
const GUID_PAGE83 = GUID_VIRTUAL_DISK_ID;
const GUID_PARENT_LOCATOR = "a8d35f2d-b30b-454d-abf7-d3d84834ab0c";
const KNOWN_METADATA = [GUID_FILE_PARAMETERS, GUID_VIRTUAL_DISK_SIZE, GUID_PAGE83, GUID_LOGICAL_SECTOR_SIZE,
    GUID_PHYSICAL_SECTOR_SIZE, GUID_PARENT_LOCATOR];

// payload block states
const PAYLOAD_NOT_PRESENT = 0;
const PAYLOAD_UNDEFINED = 1;
const PAYLOAD_ZERO = 2;
const PAYLOAD_UNMAPPED = 3;
const PAYLOAD_UNMAPPED_V095 = 5;
const PAYLOAD_FULLY_PRESENT = 6;
const PAYLOAD_PARTIALLY_PRESENT = 7;

const MAX_BAT_BYTES = 256 * MiB;

let crc32c_table;

/**
 * CRC-32C (Castagnoli), as [MS-VHDX] checksums are
 * @param {!Uint8Array} bytes
 * @param {number=} skip the offset of a 4-byte checksum field read as zeros
 * @return {number}
 */
export function crc32c(bytes, skip = -1)
{
    if(!crc32c_table)
    {
        crc32c_table = new Int32Array(256);
        for(let n = 0; n < 256; n++)
        {
            let c = n;
            for(let k = 0; k < 8; k++) c = c & 1 ? 0x82F63B78 ^ c >>> 1 : c >>> 1;
            crc32c_table[n] = c;
        }
    }
    let crc = -1;
    for(let i = 0; i < bytes.length; i++)
    {
        const byte = skip >= 0 && i >= skip && i < skip + 4 ? 0 : bytes[i];
        crc = crc32c_table[(crc ^ byte) & 0xFF] ^ crc >>> 8;
    }
    return ~crc >>> 0;
}

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @return {number}
 */
function u32le(bytes, offset)
{
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
}

/**
 * A GUID as text ([MS-DTYP]: the first three fields little-endian)
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @return {string}
 */
function guid(bytes, offset)
{
    const hex = i => bytes[offset + i].toString(16).padStart(2, "0");
    return [3, 2, 1, 0].map(hex).join("") + "-" + [5, 4].map(hex).join("") + "-" + [7, 6].map(hex).join("") + "-" +
        [8, 9].map(hex).join("") + "-" + [10, 11, 12, 13, 14, 15].map(hex).join("");
}

export class VHDXReader extends ImageReader
{
    /**
     * @param {?} source
     * @param {string} name
     */
    constructor(source, name)
    {
        super(source, name);
        this.format = "vhdx";
        this.block_size = 0;
        this.chunk_ratio = 0;
        this.logical_sector_size = 0;
        /** @type {!Uint8Array} */
        this.bat = new Uint8Array(0);
        this.bat_entries = 0;
    }

    /**
     * @param {string} what
     * @param {string=} kind
     * @return {!DiskImageError}
     */
    error(what, kind)
    {
        return new DiskImageError(this.name + ": vhdx: " + what, kind || "corrupt");
    }

    /**
     * @param {number} offset
     * @param {number} length
     * @param {string} what
     * @return {!Promise<!Uint8Array>}
     */
    read_metadata(offset, length, what)
    {
        return new Promise((resolve, reject) =>
        {
            if(offset + length > this.source.byteLength)
            {
                reject(this.error(what + " (" + length + " bytes at " + offset + ") is past the end of the file (" +
                    this.source.byteLength + " bytes): the file is truncated or corrupt"));
                return;
            }
            this.source.read(offset, length, (data, error) => error ? reject(error) : resolve(data));
        });
    }

    /** @param {function((Error|undefined))} callback */
    open(callback)
    {
        this.parse().then(() => callback(undefined), error => callback(/** @type {!Error} */ (error)));
    }

    async parse()
    {
        const identifier = await this.read_metadata(0, 8, "the file type identifier");
        if(String.fromCharCode(...identifier) !== "vhdxfile") throw this.error("no file type identifier (vhdxfile)");

        // the headers: the valid one with the higher sequence number
        let header = null, sequence = big(-1);
        for(const offset of [64 * KiB, 128 * KiB])
        {
            const bytes = (await this.read_metadata(offset, 4 * KiB, "the header at " + offset)).slice();
            if(String.fromCharCode(...bytes.subarray(0, 4)) !== "head" || crc32c(bytes, 4) !== u32le(bytes, 4)) continue;
            const n = read_u64(bytes, 8, true);
            if(n > sequence)
            {
                header = bytes;
                sequence = n;
            }
        }
        if(!header) throw this.error("neither header is valid (signature, CRC-32C)");
        const version = header[66] | header[67] << 8;
        if(version !== 1) throw this.error("version " + version + " is not supported", "unsupported");
        const log_guid = header.subarray(48, 64);
        if(log_guid.some(b => b !== 0))
        {
            throw this.error("the image has a log to replay (the log GUID is set): v86 does not replay logs; open and " +
                "close it once with a tool that does (e.g. qemu-img check -r all, Hyper-V)", "unsupported");
        }

        // the region tables: the first valid one
        let regions = null;
        for(const offset of [192 * KiB, 256 * KiB])
        {
            const bytes = await this.read_metadata(offset, 64 * KiB, "the region table at " + offset);
            if(String.fromCharCode(...bytes.subarray(0, 4)) === "regi" && crc32c(bytes, 4) === u32le(bytes, 4))
            {
                regions = bytes.slice();
                break;
            }
        }
        if(!regions) throw this.error("neither region table is valid (signature, CRC-32C)");
        const region_count = u32le(regions, 8);
        if(region_count > 2047) throw this.error(region_count + " regions is too many");
        let bat_region = null, metadata_region = null;
        for(let i = 0; i < region_count; i++)
        {
            const entry = 16 + i * 32;
            const id = guid(regions, entry);
            const region = {
                offset: to_number(read_u64(regions, entry + 16, true), this.name + ": vhdx: a region's offset"),
                length: u32le(regions, entry + 24),
            };
            if(region.offset % MiB || region.length % MiB) throw this.error("region " + id + " is not aligned to 1 MiB");
            if(id === GUID_BAT) bat_region = region;
            else if(id === GUID_METADATA) metadata_region = region;
            else if(u32le(regions, entry + 28) & 1) throw this.error("an unknown required region " + id, "unsupported");
        }
        if(!bat_region || !metadata_region) throw this.error("the BAT or the metadata region is missing");

        // the metadata
        const metadata = (await this.read_metadata(metadata_region.offset, metadata_region.length, "the metadata region")).slice();
        if(String.fromCharCode(...metadata.subarray(0, 8)) !== "metadata") throw this.error("no metadata table");
        const item_count = metadata[10] | metadata[11] << 8;
        if(item_count > 2047) throw this.error(item_count + " metadata items is too many");
        const items = new Map();
        for(let i = 0; i < item_count; i++)
        {
            const entry = 32 + i * 32;
            const id = guid(metadata, entry);
            const offset = u32le(metadata, entry + 16), length = u32le(metadata, entry + 20), flags = u32le(metadata, entry + 24);
            if(length && (offset < 64 * KiB || offset + length > metadata.length))
            {
                throw this.error("metadata item " + id + " (" + length + " bytes at " + offset + ") is outside the region");
            }
            if(!KNOWN_METADATA.includes(id) && flags & 4) throw this.error("an unknown required metadata item " + id, "unsupported");
            items.set(id, metadata.subarray(offset, offset + length));
        }
        const item = (id, length) =>
        {
            const data = items.get(id);
            if(!data || data.length < length) throw this.error("the metadata item " + id + " is missing");
            return data;
        };
        const parameters = item(GUID_FILE_PARAMETERS, 8);
        this.block_size = u32le(parameters, 0);
        const has_parent = !!(u32le(parameters, 4) & 2);
        if(this.block_size < MiB || this.block_size > 256 * MiB || this.block_size & this.block_size - 1)
        {
            throw this.error("the block size " + this.block_size + " is invalid (a power of two from 1 to 256 MiB)");
        }
        if(has_parent || items.has(GUID_PARENT_LOCATOR))
        {
            throw this.error("a differencing disk (with a parent): not supported", "unsupported");
        }
        const size = to_number(read_u64(item(GUID_VIRTUAL_DISK_SIZE, 8), 0, true), this.name + ": vhdx: the virtual size");
        this.logical_sector_size = u32le(item(GUID_LOGICAL_SECTOR_SIZE, 4), 0);
        const physical_sector_size = u32le(item(GUID_PHYSICAL_SECTOR_SIZE, 4), 0);
        if(this.logical_sector_size !== 512 && this.logical_sector_size !== 4096 ||
            physical_sector_size !== 512 && physical_sector_size !== 4096)
        {
            throw this.error("sector sizes " + this.logical_sector_size + "/" + physical_sector_size + " are invalid");
        }
        if(this.logical_sector_size !== 512)
        {
            throw this.error("logical sectors of " + this.logical_sector_size + " bytes: the disk devices have 512-byte sectors", "unsupported");
        }
        if(size % this.logical_sector_size) throw this.error("the virtual size " + size + " is not a multiple of the sector size");
        this.virtual_size = size;

        // the BAT: a sector bitmap entry after each chunk of payload blocks
        this.chunk_ratio = 2 ** 23 * this.logical_sector_size / this.block_size;
        const payload_blocks = Math.ceil(size / this.block_size);
        this.bat_entries = payload_blocks + Math.floor((payload_blocks - 1) / this.chunk_ratio);
        if(this.bat_entries * 8 > bat_region.length) throw this.error("the BAT region is too small for the disk");
        if(this.bat_entries * 8 > MAX_BAT_BYTES) throw this.error("the BAT is too large", "unsupported");
        this.bat = (await this.read_metadata(bat_region.offset, this.bat_entries * 8, "the BAT")).slice();
        for(let block = 0; block < payload_blocks; block++)
        {
            const state = this.bat[this.bat_index(block) * 8] & 7;
            if(state === 4 || state === PAYLOAD_PARTIALLY_PRESENT)
            {
                throw this.error("the BAT entry of block " + block + " has the state " + state + " (not of a disk without a parent)");
            }
        }
        this.metadata_sha256 = sha256_hex(header, regions, metadata, this.bat);
    }

    /**
     * @param {number} block a payload block
     * @return {number} its BAT entry
     */
    bat_index(block)
    {
        return block + Math.floor(block / this.chunk_ratio);
    }

    /**
     * @param {number} offset
     * @param {number} length
     * @param {function((Array<!Object>|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    map(offset, length, callback, signal)
    {
        const extents = [];
        const end = offset + length;
        for(let position = offset; position < end;)
        {
            const block = Math.floor(position / this.block_size);
            const in_block = position - block * this.block_size;
            const count = Math.min(this.block_size - in_block, end - position);
            const index = this.bat_index(block) * 8;
            const state = this.bat[index] & 7;
            if(state === PAYLOAD_FULLY_PRESENT)
            {
                // FileOffsetMB: bits 20-63
                const file_offset = Number(read_u64(this.bat, index, true) >> big(20)) * MiB;
                push_extent(extents, EXTENT_DATA, count, file_offset + in_block);
            }
            else if(state === PAYLOAD_NOT_PRESENT || state === PAYLOAD_UNDEFINED || state === PAYLOAD_ZERO ||
                state === PAYLOAD_UNMAPPED || state === PAYLOAD_UNMAPPED_V095)
            {
                push_extent(extents, EXTENT_ZERO, count);
            }
            else
            {
                callback(undefined, this.error("the BAT entry of block " + block + " has the state " + state));
                return;
            }
            position += count;
        }
        callback(extents);
    }
}
