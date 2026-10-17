// QCOW2 images, versions 2 and 3 (docs/disk-image-formats-plan.md P1, P2;
// the format: https://www.qemu.org/docs/master/interop/qcow2.html): the
// active disk through the L1 and L2 tables, with data, unallocated and zero
// clusters. Internal snapshots may be there; only the active disk is read.
// Refused: encryption, external data files, extended L2 entries, unknown
// incompatible features, dirty or corrupt images.

import { DiskImageError } from "./source.js";
import { ImageReader, EXTENT_DATA, EXTENT_ZERO, EXTENT_PARENT, EXTENT_COMPRESSED, push_extent,
    to_number, big } from "./disk_image.js";
import { sha256_hex } from "./sha256.js";

export const QCOW2_MAGIC = 0x514649FB; // "QFI\xfb"

const INCOMPAT_DIRTY = 1;
const INCOMPAT_CORRUPT = 2;
const INCOMPAT_DATA_FILE = 4;
const INCOMPAT_COMPRESSION = 8;
const INCOMPAT_EXTL2 = 16;
const INCOMPAT_KNOWN = 31;

const EXT_END = 0;
const EXT_BACKING_FORMAT = 0xE2792ACA;
const EXT_CRYPTO = 0x0537BE77;
const EXT_DATA_FILE = 0x44415441;

export const COMPRESSION_DEFLATE = 0;
export const COMPRESSION_ZSTD = 1;

const OFLAG_COPIED = big(1) << big(63);
const OFLAG_COMPRESSED = big(1) << big(62);
const OFLAG_ZERO = big(1);
const OFFSET_MASK = big("0x00FFFFFFFFFFFE00");
const L1E_RESERVED = big("0x7F000000000001FF");
const L2E_STD_RESERVED = big("0x3F000000000001FE");

// QEMU's limits (block/qcow2.h): QCOW_MAX_L1_SIZE, the largest cluster
const MAX_L1_BYTES = 32 * 1024 * 1024;
const MAX_CLUSTER_BITS = 21;
const MIN_CLUSTER_BITS = 9;

// L2 tables kept (bytes)
const L2_CACHE_SIZE = 8 * 1024 * 1024;

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
 * A big-endian 64-bit field
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @return {?} a bigint (the build's Closure Compiler checks no bitwise
 *     operators on bigint)
 */
function be64(bytes, offset)
{
    return big(u32(bytes, offset)) << big(32) | big(u32(bytes, offset + 4));
}

/**
 * @param {!Uint8Array} bytes
 * @return {string}
 */
function utf8(bytes)
{
    return new TextDecoder().decode(bytes);
}

export class QCOW2Reader extends ImageReader
{
    /**
     * @param {?} source
     * @param {string} name
     * @param {{zstd_decompress: ((function(number, !Uint8Array): !Uint8Array)|undefined)}=} options
     */
    constructor(source, name, options)
    {
        super(source, name);
        this.format = "qcow2";
        this.zstd_decompress = options && options.zstd_decompress;
        this.version = 0;
        this.cluster_bits = 0;
        this.cluster_size = 0;
        this.l2_entries = 0;
        this.l1_size = 0;
        /** @type {!Uint8Array} */
        this.l1 = new Uint8Array(0);
        this.compression_type = COMPRESSION_DEFLATE;
        this.backing_file = "";
        this.backing_format = "";
        this.snapshots = 0;
        /** @type {!Map<number, !Uint8Array>} L2 table offset -> table, the most recently used last */
        this.l2_cache = new Map();
        /** @type {!Map<number, !Array<function((Error|undefined))>>} */
        this.l2_loading = new Map();
        this.max_l2_tables = 16;
    }

    /**
     * @param {string} what
     * @param {string=} kind
     * @return {!DiskImageError}
     */
    error(what, kind)
    {
        return new DiskImageError(this.name + ": qcow2: " + what, kind || "corrupt");
    }

    /**
     * Read [offset, offset + length) of the file, which must be there
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

    /**
     * @param {function((Error|undefined))} callback
     */
    open(callback)
    {
        this.parse().then(() => callback(undefined), error => callback(/** @type {!Error} */ (error)));
    }

    async parse()
    {
        const file_size = this.source.byteLength;
        if(file_size < 72) throw this.error("the file (" + file_size + " bytes) is too small for a header");
        let header = await this.read_metadata(0, Math.min(file_size, 4096), "the header");
        if(u32(header, 0) !== QCOW2_MAGIC) throw this.error("no QCOW2 signature");
        const version = this.version = u32(header, 4);
        if(version !== 2 && version !== 3)
        {
            throw this.error("version " + version + " is not supported (only 2 and 3)", "unsupported");
        }
        const cluster_bits = u32(header, 20);
        if(cluster_bits < MIN_CLUSTER_BITS || cluster_bits > MAX_CLUSTER_BITS)
        {
            throw this.error("cluster_bits " + cluster_bits + " outside of " + MIN_CLUSTER_BITS + "-" + MAX_CLUSTER_BITS);
        }
        const cluster_size = this.cluster_size = 2 ** cluster_bits;
        this.cluster_bits = cluster_bits;
        this.l2_entries = cluster_size / 8;
        this.max_l2_tables = Math.max(4, L2_CACHE_SIZE / cluster_size);

        const size = to_number(be64(header, 24), this.name + ": qcow2: the virtual size");
        if(size % 512)
        {
            throw this.error("the virtual size " + size + " is not a multiple of 512 bytes", "unsupported");
        }
        this.virtual_size = size;

        const crypt_method = u32(header, 32);
        if(crypt_method)
        {
            throw this.error("the image is encrypted (method " + crypt_method + "): not supported", "unsupported");
        }

        let header_length = 72, incompatible = big(0), refcount_order = 4;
        if(version === 3)
        {
            if(file_size < 104) throw this.error("the file is too small for a version 3 header");
            incompatible = be64(header, 72);
            refcount_order = u32(header, 96);
            header_length = u32(header, 100);
            if(header_length < 104 || header_length % 8)
            {
                throw this.error("header_length " + header_length + " is invalid (at least 104, a multiple of 8)");
            }
        }
        if(header_length > cluster_size) throw this.error("the header is larger than a cluster");
        if(header_length > header.length || cluster_size > header.length && file_size > header.length)
        {
            // the header with its extensions fills the first cluster at most
            header = await this.read_metadata(0, Math.min(file_size, cluster_size), "the first cluster");
        }
        if(refcount_order > 6) throw this.error("refcount_order " + refcount_order + " is invalid");

        const unknown = incompatible & ~big(INCOMPAT_KNOWN);
        if(unknown)
        {
            throw this.error("unknown incompatible features 0x" + unknown.toString(16) + ": not supported", "unsupported");
        }
        const flags = Number(incompatible);
        if(flags & INCOMPAT_DIRTY)
        {
            throw this.error("the image is dirty (not closed cleanly): repair it first (qemu-img check -r all)", "unsupported");
        }
        if(flags & INCOMPAT_CORRUPT)
        {
            throw this.error("the image is marked corrupt: repair it first (qemu-img check -r all)", "unsupported");
        }
        if(flags & INCOMPAT_DATA_FILE)
        {
            throw this.error("the image has an external data file: not supported", "unsupported");
        }
        if(flags & INCOMPAT_EXTL2)
        {
            throw this.error("the image has extended L2 entries (subclusters): not supported", "unsupported");
        }
        this.compression_type = COMPRESSION_DEFLATE;
        if(flags & INCOMPAT_COMPRESSION)
        {
            if(header_length < 105) throw this.error("the compression type bit is set, the header has no compression type");
            this.compression_type = header[104];
            if(this.compression_type !== COMPRESSION_DEFLATE && this.compression_type !== COMPRESSION_ZSTD)
            {
                throw this.error("compression type " + this.compression_type + " is not supported", "unsupported");
            }
        }
        else if(header_length > 104 && header[104] !== 0)
        {
            throw this.error("a compression type is given without its incompatible feature bit");
        }

        const backing_offset = to_number(be64(header, 8), this.name + ": qcow2: backing_file_offset");
        const backing_size = u32(header, 16);
        if(backing_offset && (backing_offset > cluster_size || backing_size === 0 ||
            backing_size > Math.min(1023, cluster_size - backing_offset) || backing_offset + backing_size > header.length))
        {
            throw this.error("the backing file name (" + backing_size + " bytes at " + backing_offset + ") is invalid");
        }

        // header extensions: from the end of the header to the backing file
        // name or the end of the first cluster, as QEMU reads them
        // (qcow2_read_extensions); unknown ones are for features that do not
        // matter for reading the active disk
        const extensions_end = backing_offset || Math.min(cluster_size, header.length);
        let position = header_length;
        while(position < extensions_end)
        {
            if(position + 8 > extensions_end) throw this.error("a header extension runs past the extension area");
            const type = u32(header, position), length = u32(header, position + 4);
            const data_start = position + 8;
            if(length > extensions_end - data_start)
            {
                throw this.error("header extension 0x" + type.toString(16) + " (" + length + " bytes) is too large");
            }
            if(type === EXT_END)
            {
                position = data_start;
                break;
            }
            const data = header.subarray(data_start, data_start + length);
            if(type === EXT_BACKING_FORMAT)
            {
                this.backing_format = utf8(data);
            }
            else if(type === EXT_CRYPTO)
            {
                throw this.error("the image has an encryption header: not supported", "unsupported");
            }
            else if(type === EXT_DATA_FILE)
            {
                throw this.error("the image names an external data file: not supported", "unsupported");
            }
            position = data_start + (length + 7 & ~7);
        }
        let metadata_end = Math.min(position, header.length);
        if(backing_offset)
        {
            this.backing_file = utf8(header.subarray(backing_offset, backing_offset + backing_size));
            metadata_end = Math.max(metadata_end, backing_offset + backing_size);
            this.parent_link = { "backing_file": this.backing_file, "backing_format": this.backing_format };
        }

        this.snapshots = u32(header, 60);

        // the L1 table: enough entries for the disk, inside the file
        this.l1_size = u32(header, 36);
        const l1_offset = to_number(be64(header, 40), this.name + ": qcow2: l1_table_offset");
        const per_l1_entry = cluster_size * this.l2_entries;
        const needed = Math.ceil(size / per_l1_entry);
        if(this.l1_size < needed)
        {
            throw this.error("the L1 table has " + this.l1_size + " entries, the size needs " + needed);
        }
        if(this.l1_size * 8 > MAX_L1_BYTES)
        {
            throw this.error("the L1 table (" + this.l1_size + " entries) is too large", "unsupported");
        }
        if(l1_offset % cluster_size)
        {
            throw this.error("the L1 table at " + l1_offset + " is not aligned to a cluster");
        }
        this.l1 = this.l1_size ?
            (await this.read_metadata(l1_offset, this.l1_size * 8, "the L1 table")).slice() :
            new Uint8Array(0);
        for(let i = 0; i < needed; i++)
        {
            const entry = be64(this.l1, i * 8);
            if(entry & L1E_RESERVED)
            {
                throw this.error("L1 entry " + i + " has reserved bits set (0x" + entry.toString(16) + ")");
            }
            const l2_offset = entry & OFFSET_MASK;
            if(l2_offset && Number(l2_offset) % cluster_size)
            {
                throw this.error("L1 entry " + i + ": the L2 table at 0x" + l2_offset.toString(16) + " is not aligned to a cluster");
            }
        }

        // the identity: the header with its extensions and the backing file
        // name, the L1 table
        this.metadata_sha256 = sha256_hex(header.subarray(0, metadata_end), this.l1);
    }

    /**
     * The L2 table at `offset` (cached)
     * @param {number} offset
     * @param {function((Error|undefined))} callback
     */
    load_l2(offset, callback)
    {
        const waiting = this.l2_loading.get(offset);
        if(waiting)
        {
            waiting.push(callback);
            return;
        }
        const callbacks = [callback];
        this.l2_loading.set(offset, callbacks);
        const finish = error =>
        {
            this.l2_loading.delete(offset);
            for(const f of callbacks) f(error);
        };
        if(offset + this.cluster_size > this.source.byteLength)
        {
            finish(this.error("the L2 table at " + offset + " is past the end of the file (" + this.source.byteLength +
                " bytes): the file is truncated or corrupt"));
            return;
        }
        this.stats.table_reads++;
        this.source.read(offset, this.cluster_size, (data, error) =>
        {
            if(error)
            {
                finish(error);
                return;
            }
            this.l2_cache.set(offset, data.slice());
            while(this.l2_cache.size > this.max_l2_tables)
            {
                this.l2_cache.delete(this.l2_cache.keys().next().value);
            }
            finish(undefined);
        });
    }

    /**
     * @param {number} offset
     * @param {number} length
     * @param {function((Array<!Object>|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    map(offset, length, callback, signal)
    {
        const cluster_size = this.cluster_size;
        const first = Math.floor(offset / cluster_size), last = Math.floor((offset + length - 1) / cluster_size);
        const tables = this.l2_entries;
        // the L2 tables needed that are not cached
        const missing = new Set();
        for(let l1_index = Math.floor(first / tables); l1_index <= Math.floor(last / tables); l1_index++)
        {
            const l2_offset = Number(be64(this.l1, l1_index * 8) & OFFSET_MASK);
            if(l2_offset && !this.l2_cache.has(l2_offset)) missing.add(l2_offset);
        }
        if(missing.size === 0)
        {
            this.stats.table_hits++;
            this.build(offset, length, callback, signal);
            return;
        }
        let pending = missing.size, failed = false;
        for(const l2_offset of missing)
        {
            this.load_l2(l2_offset, error =>
            {
                if(failed) return;
                if(error)
                {
                    failed = true;
                    callback(undefined, error);
                    return;
                }
                if(--pending === 0) this.build(offset, length, callback, signal);
            });
        }
    }

    /**
     * The extents of [offset, offset + length) from the cached L2 tables
     * (one evicted meanwhile by other reads is loaded again)
     * @param {number} offset
     * @param {number} length
     * @param {function((Array<!Object>|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    build(offset, length, callback, signal)
    {
        const cluster_size = this.cluster_size, tables = this.l2_entries;
        const extents = [];
        const end = offset + length;
        for(let position = offset; position < end;)
        {
            const cluster = Math.floor(position / cluster_size);
            const in_cluster = position - cluster * cluster_size;
            const count = Math.min(cluster_size - in_cluster, end - position);
            const l1_index = Math.floor(cluster / tables);
            const l2_offset = Number(be64(this.l1, l1_index * 8) & OFFSET_MASK);
            if(!l2_offset)
            {
                push_extent(extents, EXTENT_PARENT, count);
                position += count;
                continue;
            }
            const table = this.l2_cache.get(l2_offset);
            if(!table)
            {
                this.map(position, end - position, (rest, error) =>
                {
                    if(error) callback(undefined, error);
                    else callback(extents.concat(rest));
                }, signal);
                return;
            }
            // the most recently used last
            this.l2_cache.delete(l2_offset);
            this.l2_cache.set(l2_offset, table);
            const l2_index = cluster % tables;
            const entry = be64(table, l2_index * 8);
            const where = () => "the L2 entry of guest offset " + cluster * cluster_size + " (table at " + l2_offset +
                ", entry " + l2_index + ", 0x" + entry.toString(16) + ")";

            if(entry & OFLAG_COMPRESSED)
            {
                // x = 62 - (cluster_bits - 8): the host offset below bit x,
                // the 512-byte sectors after the first above it
                const x = big(62 - (this.cluster_bits - 8));
                if(entry & OFLAG_COPIED)
                {
                    callback(undefined, this.error(where() + ": a compressed cluster with the copied flag"));
                    return;
                }
                const host = entry & ((big(1) << x) - big(1));
                if(host >> big(56))
                {
                    callback(undefined, this.error(where() + ": the compressed cluster's offset is beyond 2^56"));
                    return;
                }
                const sectors = Number((entry >> x) & ((big(1) << (big(62) - x)) - big(1))) + 1;
                const host_offset = Number(host);
                extents.push({ type: EXTENT_COMPRESSED, length: count, host_offset,
                    host_length: sectors * 512 - host_offset % 512, cluster_start: in_cluster });
            }
            else
            {
                if(entry & L2E_STD_RESERVED)
                {
                    callback(undefined, this.error(where() + ": reserved bits set"));
                    return;
                }
                const host = Number(entry & OFFSET_MASK);
                if(entry & OFLAG_ZERO)
                {
                    if(this.version < 3)
                    {
                        callback(undefined, this.error(where() + ": the zero flag in a version 2 image"));
                        return;
                    }
                    push_extent(extents, EXTENT_ZERO, count);
                }
                else if(!host)
                {
                    push_extent(extents, EXTENT_PARENT, count);
                }
                else
                {
                    if(host % cluster_size)
                    {
                        callback(undefined, this.error(where() + ": the data cluster is not aligned to a cluster"));
                        return;
                    }
                    push_extent(extents, EXTENT_DATA, count, host + in_cluster);
                }
            }
            position += count;
        }
        callback(extents);
    }

    /**
     * @param {!Uint8Array} bytes
     * @param {!Object} extent
     * @return {!Uint8Array}
     */
    decompress(bytes, extent)
    {
        throw this.error("the cluster at guest offset of host offset " + extent.host_offset +
            " is compressed: compressed clusters are not supported yet", "unsupported");
    }
}
