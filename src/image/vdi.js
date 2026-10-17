// VDI images (VirtualBox), dynamic and fixed (docs/disk-image-formats-plan.md
// P3): the header of version 1.1, the block map, unallocated and discarded
// blocks (zeros). As QEMU's vdi driver: 512-byte sectors, blocks of 1 MiB,
// no extra block data. Differencing images (a parent or link UUID) are
// refused (no independent tool here makes them).

import { DiskImageError } from "./source.js";
import { ImageReader, EXTENT_DATA, EXTENT_ZERO, push_extent, read_u64, to_number } from "./disk_image.js";
import { sha256_hex } from "./sha256.js";

export const VDI_SIGNATURE = 0xBEDA107F;
const VERSION_1_1 = 0x00010001;
const TYPE_DYNAMIC = 1;
const TYPE_STATIC = 2;
const UNALLOCATED = 0xFFFFFFFF;
const DISCARDED = 0xFFFFFFFE;
const BLOCK_SIZE = 1024 * 1024;
const MAX_BLOCKS = 0x3FFFFFFF;

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @return {number}
 */
function u32le(bytes, offset)
{
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
}

export class VDIReader extends ImageReader
{
    /**
     * @param {?} source
     * @param {string} name
     */
    constructor(source, name)
    {
        super(source, name);
        this.format = "vdi";
        this.image_type = 0;
        this.offset_data = 0;
        this.blocks = 0;
        /** @type {!Uint8Array} */
        this.bmap = new Uint8Array(0);
    }

    /**
     * @param {string} what
     * @param {string=} kind
     * @return {!DiskImageError}
     */
    error(what, kind)
    {
        return new DiskImageError(this.name + ": vdi: " + what, kind || "corrupt");
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
        const header = (await this.read_metadata(0, 512, "the header")).slice();
        if(u32le(header, 0x40) !== VDI_SIGNATURE) throw this.error("no VDI signature");
        const version = u32le(header, 0x44);
        if(version !== VERSION_1_1)
        {
            throw this.error("version 0x" + version.toString(16) + " is not supported (only 1.1)", "unsupported");
        }
        // (the header after the pre-header of 0x48 bytes: 0x180 bytes in 1.1)
        const header_size = u32le(header, 0x48);
        if(header_size < 0x180 || 0x48 + header_size > 512) throw this.error("header size " + header_size + " is invalid");
        this.image_type = u32le(header, 0x4C);
        if(this.image_type !== TYPE_DYNAMIC && this.image_type !== TYPE_STATIC)
        {
            throw this.error("image type " + this.image_type + " is not supported (only dynamic and fixed)", "unsupported");
        }
        const offset_bmap = u32le(header, 0x154);
        this.offset_data = u32le(header, 0x158);
        const sector_size = u32le(header, 0x168);
        const size = to_number(read_u64(header, 0x170, true), this.name + ": vdi: the disk size");
        const block_size = u32le(header, 0x178);
        const block_extra = u32le(header, 0x17C);
        this.blocks = u32le(header, 0x180);
        if(sector_size !== 512) throw this.error("sector size " + sector_size + " is not supported", "unsupported");
        if(block_size !== BLOCK_SIZE) throw this.error("block size " + block_size + " is not supported (only 1 MiB)", "unsupported");
        if(block_extra !== 0) throw this.error("extra block data (" + block_extra + " bytes) is not supported", "unsupported");
        if(size % 512) throw this.error("the disk size " + size + " is not a multiple of 512 bytes", "unsupported");
        if(this.blocks > MAX_BLOCKS) throw this.error("too many blocks (" + this.blocks + ")");
        if(size > this.blocks * BLOCK_SIZE)
        {
            throw this.error("the disk size " + size + " is larger than its " + this.blocks + " blocks");
        }
        if(offset_bmap % 512 || this.offset_data % 512)
        {
            throw this.error("the block map (" + offset_bmap + ") or the data (" + this.offset_data + ") is not aligned to a sector");
        }
        const zero_uuid = offset => header.subarray(offset, offset + 16).every(b => b === 0);
        if(!zero_uuid(0x1A8) || !zero_uuid(0x1B8))
        {
            throw this.error("a differencing image (a link or parent UUID): not supported", "unsupported");
        }
        this.virtual_size = size;
        this.bmap = (await this.read_metadata(offset_bmap, this.blocks * 4, "the block map")).slice();
        this.metadata_sha256 = sha256_hex(header.subarray(0, 0x48 + header_size), this.bmap);
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
            const block = Math.floor(position / BLOCK_SIZE);
            const in_block = position - block * BLOCK_SIZE;
            const count = Math.min(BLOCK_SIZE - in_block, end - position);
            const entry = u32le(this.bmap, block * 4);
            if(entry === UNALLOCATED || entry === DISCARDED)
            {
                push_extent(extents, EXTENT_ZERO, count);
            }
            else if(entry >= this.blocks)
            {
                callback(undefined, this.error("the block map entry of guest offset " + block * BLOCK_SIZE + " (" + entry +
                    ") is beyond the image's " + this.blocks + " blocks"));
                return;
            }
            else
            {
                push_extent(extents, EXTENT_DATA, count, this.offset_data + entry * BLOCK_SIZE + in_block);
            }
            position += count;
        }
        callback(extents);
    }
}
