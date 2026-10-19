// VHD images, fixed and dynamic (docs/disk-image-formats-plan.md P3; the
// format: Microsoft's Virtual Hard Disk Image Format Specification). The
// footer (and for dynamic disks the header) must have a valid checksum; the
// size the guest sees follows QEMU's vpc driver (the CHS geometry for images
// of Virtual PC and QEMU, the footer's current size for Hyper-V and others).
// Differencing disks are refused (no independent tool here makes them).

import { DiskImageError } from "./source.js";
import { ImageReader, EXTENT_DATA, EXTENT_ZERO, push_extent, read_u64, to_number } from "./disk_image.js";
import { sha256_hex } from "./sha256.js";

const TYPE_FIXED = 2;
const TYPE_DYNAMIC = 3;
const TYPE_DIFFERENCING = 4;

// QEMU: the largest geometry (65535 cylinders, 16 heads, 255 sectors) means
// "use the current size"; at most 2040 GiB
const MAX_GEOMETRY = 65535 * 16 * 255;
const MAX_SECTORS = 0xFF000000;

const UNALLOCATED = 0xFFFFFFFF;

// BAT entries kept: all of them (4 bytes each, at most 2040 GiB / 512 bytes)
const MAX_BAT_BYTES = 64 * 1024 * 1024;

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @return {number}
 */
function u32(bytes, offset)
{
    return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}

/**
 * The checksum of a footer or header: the one's complement of the sum of its
 * bytes, the checksum's own as zeros
 * @param {!Uint8Array} bytes
 * @param {number} checksum_offset
 * @return {number}
 */
function vhd_checksum(bytes, checksum_offset)
{
    let sum = 0;
    for(let i = 0; i < bytes.length; i++)
    {
        if(i >= checksum_offset && i < checksum_offset + 4) continue;
        sum += bytes[i];
    }
    return ~sum >>> 0;
}

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 * @return {string}
 */
function ascii(bytes, offset, length)
{
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export class VHDReader extends ImageReader
{
    /**
     * @param {?} source
     * @param {string} name
     */
    constructor(source, name)
    {
        super(source, name);
        this.format = "vhd";
        this.disk_type = 0;
        this.creator = "";
        this.block_size = 0;
        this.bitmap_size = 0;
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
        return new DiskImageError(this.name + ": vhd: " + what, kind || "corrupt");
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
            if(offset < 0 || offset + length > this.source.byteLength)
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
        const file_size = this.source.byteLength;
        if(file_size < 512) throw this.error("the file is too small for a footer");
        // a dynamic disk has a copy of the footer at the start (QEMU reads that
        // one), a fixed disk only the one at the end
        let footer = (await this.read_metadata(0, 512, "the footer's copy")).slice();
        if(ascii(footer, 0, 8) !== "conectix" || u32(footer, 60) === TYPE_FIXED)
        {
            footer = (await this.read_metadata(file_size - 512, 512, "the footer")).slice();
            if(ascii(footer, 0, 8) !== "conectix")
            {
                // (images of old tools: a footer of 511 bytes)
                const short = await this.read_metadata(file_size - 511, 511, "the footer");
                if(ascii(short, 0, 8) !== "conectix") throw this.error("no footer (\"conectix\")");
                footer = new Uint8Array(512);
                footer.set(short);
            }
        }
        const checksum = u32(footer, 64);
        if(vhd_checksum(footer, 64) !== checksum)
        {
            throw this.error("the footer's checksum is wrong (0x" + checksum.toString(16) + ", computed 0x" +
                vhd_checksum(footer, 64).toString(16) + ")");
        }
        const version = u32(footer, 12);
        if(version >>> 16 !== 1)
        {
            throw this.error("file format version 0x" + version.toString(16) + " is not supported", "unsupported");
        }
        this.disk_type = u32(footer, 60);
        this.creator = ascii(footer, 28, 4);
        const current_size = to_number(read_u64(footer, 48), this.name + ": vhd: the current size");

        // the guest's size, as QEMU's vpc driver
        const geometry_sectors = (footer[56] << 8 | footer[57]) * footer[58] * footer[59];
        const use_geometry = this.creator === "vpc " || this.creator === "qemu";
        let sectors = use_geometry && geometry_sectors !== MAX_GEOMETRY ? geometry_sectors : Math.floor(current_size / 512);
        if(sectors > MAX_SECTORS) throw this.error("the disk (" + sectors + " sectors) is larger than VHD allows (2040 GiB)", "unsupported");
        this.virtual_size = sectors * 512;

        const parts = [footer];
        if(this.disk_type === TYPE_FIXED)
        {
            // the data, then the footer
            if(this.virtual_size > file_size - 512 + (file_size % 512 === 511 ? 1 : 0))
            {
                throw this.error("the data (" + this.virtual_size + " bytes) does not fit before the footer: the file (" +
                    file_size + " bytes) is truncated");
            }
        }
        else if(this.disk_type === TYPE_DYNAMIC || this.disk_type === TYPE_DIFFERENCING)
        {
            if(this.disk_type === TYPE_DIFFERENCING)
            {
                throw this.error("differencing disks are not supported", "unsupported");
            }
            const header_offset = to_number(read_u64(footer, 16), this.name + ": vhd: the header's offset");
            const header = (await this.read_metadata(header_offset, 1024, "the dynamic disk header")).slice();
            if(ascii(header, 0, 8) !== "cxsparse") throw this.error("no dynamic disk header (\"cxsparse\") at " + header_offset);
            if(vhd_checksum(header, 36) !== u32(header, 36))
            {
                throw this.error("the dynamic disk header's checksum is wrong");
            }
            const header_version = u32(header, 24);
            if(header_version >>> 16 !== 1)
            {
                throw this.error("dynamic header version 0x" + header_version.toString(16) + " is not supported", "unsupported");
            }
            const bat_offset = to_number(read_u64(header, 16), this.name + ": vhd: the BAT's offset");
            this.bat_entries = u32(header, 28);
            this.block_size = u32(header, 32);
            if(this.block_size < 512 || this.block_size & this.block_size - 1)
            {
                throw this.error("the block size " + this.block_size + " is not a power of two of at least 512");
            }
            if(this.bat_entries * this.block_size < this.virtual_size)
            {
                throw this.error("the BAT (" + this.bat_entries + " blocks of " + this.block_size + " bytes) is too small for the disk");
            }
            if(this.bat_entries * 4 > MAX_BAT_BYTES) throw this.error("the BAT is too large", "unsupported");
            this.bitmap_size = Math.ceil(this.block_size / 512 / 8 / 512) * 512;
            this.bat = (await this.read_metadata(bat_offset, this.bat_entries * 4, "the BAT")).slice();
            parts.push(header, this.bat);
        }
        else
        {
            throw this.error("disk type " + this.disk_type + " is not supported", "unsupported");
        }
        this.metadata_sha256 = sha256_hex(...parts);
    }

    /**
     * @param {number} offset
     * @param {number} length
     * @param {function((Array<!Object>|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    map(offset, length, callback, signal)
    {
        if(this.disk_type === TYPE_FIXED)
        {
            callback([{ type: EXTENT_DATA, length, host_offset: offset }]);
            return;
        }
        const extents = [];
        const end = offset + length;
        for(let position = offset; position < end;)
        {
            const block = Math.floor(position / this.block_size);
            const in_block = position - block * this.block_size;
            const count = Math.min(this.block_size - in_block, end - position);
            const entry = u32(this.bat, block * 4);
            if(entry === UNALLOCATED)
            {
                push_extent(extents, EXTENT_ZERO, count);
            }
            else
            {
                // (as QEMU: an allocated block is read whole, its sector
                // bitmap only matters for differencing disks)
                push_extent(extents, EXTENT_DATA, count, entry * 512 + this.bitmap_size + in_block);
            }
            position += count;
        }
        callback(extents);
    }
}
