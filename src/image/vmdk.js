// VMDK images (docs/disk-image-formats-plan.md P4; the format: VMware's
// Virtual Disk Format 1.1 and QEMU's vmdk driver). What is read:
//
// | createType | extents | status |
// | --- | --- | --- |
// | monolithicSparse | one hosted sparse extent with the descriptor in it | supported |
// | streamOptimized | one sparse extent, compressed grains with markers | supported |
// | monolithicFlat, vmfs | a descriptor file and one flat extent | supported (files) |
// | twoGbMaxExtentSparse | a descriptor file and sparse extents | supported (files) |
// | twoGbMaxExtentFlat | a descriptor file and flat extents | supported (files) |
// | a sparse extent alone | its capacity, no descriptor | supported |
// | vmfsSparse, vmfsThin, seSparse, custom, fullDevice, partitionedDevice, ... | | refused |
//
// Extent types FLAT, VMFS, SPARSE and ZERO; RW and RDONLY. The files a
// descriptor names come from the descriptor's `files` (by name); none is
// loaded by its name alone. A child (parentCID) needs its parent as backing,
// a VMDK whose CID is the child's parentCID.

import { DiskImageError } from "./source.js";
import { ImageReader, EXTENT_DATA, EXTENT_ZERO, EXTENT_PARENT, EXTENT_COMPRESSED, push_extent, read_u64, to_number, big } from "./disk_image.js";
import { sha256_hex } from "./sha256.js";
import { inflate } from "../virt/inflate.js";

const SPARSE_MAGIC = 0x564D444B; // "KDMV" read little-endian
const FLAG_ZEROED_GRAIN = 1 << 2;
const FLAG_COMPRESSED = 1 << 16;
const FLAG_MARKERS = 1 << 17;
const GD_AT_END = big("0xFFFFFFFFFFFFFFFF");
const GTE_ZEROED = 1;
const MARKER_END_OF_STREAM = 0;
const MARKER_FOOTER = 3;
const NO_PARENT = "ffffffff";

const SUPPORTED_TYPES = ["monolithicSparse", "streamOptimized", "monolithicFlat", "vmfs", "twoGbMaxExtentSparse", "twoGbMaxExtentFlat"];

// grain tables kept (bytes)
const GT_CACHE_SIZE = 4 * 1024 * 1024;

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
 * Adler-32 (RFC 1950), the checksum after a zlib stream
 * @param {!Uint8Array} bytes
 * @return {number}
 */
function adler32(bytes)
{
    let a = 1, b = 0;
    for(let i = 0; i < bytes.length;)
    {
        // (5552 bytes keep the sums below 2^32)
        const end = Math.min(bytes.length, i + 5552);
        for(; i < end; i++)
        {
            a += bytes[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return (b << 16 | a) >>> 0;
}

/**
 * A descriptor's fields and extents
 * @param {string} text
 * @param {string} name for messages
 * @return {!Object}
 */
export function parse_descriptor(text, name)
{
    const fields = Object.create(null);
    const extents = [];
    for(const raw_line of text.split(/\r?\n/))
    {
        const line = raw_line.replace(/\0.*$/, "").trim();
        if(!line || line.startsWith("#")) continue;
        const extent = /^(RW|RDONLY|NOACCESS)\s+(\d+)\s+(FLAT|SPARSE|ZERO|VMFS|VMFSSPARSE|VMFSRDM|VMFSRAW)(?:\s+"([^"]*)"(?:\s+(\d+))?)?\s*$/.exec(line);
        if(extent)
        {
            extents.push({ access: extent[1], sectors: +extent[2], type: extent[3], file: extent[4] || "",
                offset: extent[5] === undefined ? 0 : +extent[5] });
            continue;
        }
        const field = /^([A-Za-z0-9_.]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
        if(field)
        {
            fields[field[1]] = field[2];
            continue;
        }
        if(/^(RW|RDONLY|NOACCESS)\s/.test(line))
        {
            throw new DiskImageError(name + ": vmdk: an extent line that is not understood: " + JSON.stringify(line), "unsupported");
        }
    }
    return {
        version: fields["version"],
        cid: (fields["CID"] || "").toLowerCase(),
        parent_cid: (fields["parentCID"] || NO_PARENT).toLowerCase(),
        create_type: fields["createType"] || "",
        parent_hint: fields["parentFileNameHint"] || "",
        extents,
    };
}

export class VMDKReader extends ImageReader
{
    /**
     * @param {?} source the descriptor file, or the sparse extent with its descriptor
     * @param {string} name
     * @param {{open_extent_source: (function(string):!Promise<?>|undefined)}=} options
     */
    constructor(source, name, options)
    {
        super(source, name);
        this.format = "vmdk";
        /** opens a file a descriptor names (src/image/factory.js: from `files`) */
        this.open_extent_source = options && options.open_extent_source;
        this.create_type = "";
        this.cid = "";
        this.parent_cid = NO_PARENT;
        /** @type {!Array<!Object>} the extents in order: start, length, type, source, ... */
        this.extents = [];
        /** @type {!Map<string, !Uint8Array>} grain tables by extent number and offset */
        this.gt_cache = new Map();
        this.gt_cache_bytes = 0;
        /** @type {!Map<string, !Array<function((Error|undefined))>>} */
        this.gt_loading = new Map();
    }

    /**
     * @param {string} what
     * @param {string=} kind
     * @return {!DiskImageError}
     */
    error(what, kind)
    {
        return new DiskImageError(this.name + ": vmdk: " + what, kind || "corrupt");
    }

    /**
     * @param {?} source
     * @param {number} offset
     * @param {number} length
     * @param {string} what
     * @return {!Promise<!Uint8Array>}
     */
    read_from(source, offset, length, what)
    {
        return new Promise((resolve, reject) =>
        {
            if(offset < 0 || offset + length > source.byteLength)
            {
                reject(this.error(what + " (" + length + " bytes at " + offset + ") is past the end of " + source.name +
                    " (" + source.byteLength + " bytes): the file is truncated or corrupt"));
                return;
            }
            source.read(offset, length, (data, error) => error ? reject(error) : resolve(data));
        });
    }

    /** @param {function((Error|undefined))} callback */
    open(callback)
    {
        this.parse().then(() => callback(undefined), error => callback(/** @type {!Error} */ (error)));
    }

    async parse()
    {
        const metadata = [];
        const head = await this.read_from(this.source, 0, Math.min(this.source.byteLength, 512), "the header");
        let descriptor;
        if(head.length >= 4 && u32le(head, 0) === SPARSE_MAGIC)
        {
            // a sparse extent, with its descriptor (monolithicSparse,
            // streamOptimized) or alone
            const sparse = await this.open_sparse(this.source, metadata);
            if(sparse.descriptor_text)
            {
                descriptor = parse_descriptor(sparse.descriptor_text, this.name);
                metadata.push(new TextEncoder().encode(sparse.descriptor_text));
                if(descriptor.extents.length !== 1 || descriptor.extents[0].type !== "SPARSE")
                {
                    throw this.error("the descriptor in a sparse file names " + descriptor.extents.length +
                        " extents (" + descriptor.extents.map(e => e.type).join(", ") + "), not its one sparse extent");
                }
                const extent = descriptor.extents[0];
                if(extent.sectors > sparse.capacity)
                {
                    throw this.error("the extent (" + extent.sectors + " sectors) is larger than its capacity (" + sparse.capacity + ")");
                }
                this.extents.push({ ...sparse, start: 0, length: extent.sectors * 512, readonly: extent.access !== "RW" });
            }
            else
            {
                descriptor = { cid: "", parent_cid: NO_PARENT, create_type: "monolithicSparse", parent_hint: "", extents: [] };
                this.extents.push({ ...sparse, start: 0, length: sparse.capacity * 512 });
            }
        }
        else
        {
            const text = new TextDecoder().decode(await this.read_from(this.source, 0, Math.min(this.source.byteLength, 1 << 20), "the descriptor"));
            if(!/^\s*#\s*Disk DescriptorFile/.test(text)) throw this.error("neither a descriptor nor a sparse extent");
            if(this.source.byteLength > 1 << 20) throw this.error("the descriptor file is larger than 1 MiB", "unsupported");
            descriptor = parse_descriptor(text, this.name);
            metadata.push(new TextEncoder().encode(text));
            let start = 0;
            for(const [index, extent] of descriptor.extents.entries())
            {
                const length = extent.sectors * 512;
                if(extent.access === "NOACCESS") throw this.error("extent " + index + " is NOACCESS: not supported", "unsupported");
                if(extent.type === "ZERO")
                {
                    this.extents.push({ type: "ZERO", start, length });
                }
                else if(extent.type === "FLAT" || extent.type === "VMFS")
                {
                    const source = await this.extent_source(extent.file);
                    const offset = extent.offset * 512;
                    if(offset + length > source.byteLength)
                    {
                        throw this.error("the flat extent " + extent.file + " (" + length + " bytes at " + offset +
                            ") is past the end of its file (" + source.byteLength + " bytes)");
                    }
                    this.extents.push({ type: "FLAT", start, length, source, offset });
                }
                else if(extent.type === "SPARSE")
                {
                    const source = await this.extent_source(extent.file);
                    const sparse = await this.open_sparse(source, metadata);
                    if(extent.sectors > sparse.capacity)
                    {
                        throw this.error("the sparse extent " + extent.file + " (" + extent.sectors +
                            " sectors) is larger than its capacity (" + sparse.capacity + ")");
                    }
                    this.extents.push({ ...sparse, start, length });
                }
                else
                {
                    throw this.error("extents of type " + extent.type + " are not supported", "unsupported");
                }
                start += length;
            }
        }
        if(descriptor.create_type && !SUPPORTED_TYPES.includes(descriptor.create_type))
        {
            throw this.error("createType " + descriptor.create_type + " is not supported (" + SUPPORTED_TYPES.join(", ") + ")", "unsupported");
        }
        this.create_type = descriptor.create_type;
        this.cid = descriptor.cid;
        this.parent_cid = descriptor.parent_cid;
        if(this.parent_cid !== NO_PARENT)
        {
            this.parent_link = { "parent_cid": this.parent_cid, "parent_file_name_hint": descriptor.parent_hint };
        }
        const size = this.extents.reduce((sum, e) => sum + e.length, 0);
        if(size === 0) throw this.error("no extents");
        if(!Number.isSafeInteger(size)) throw this.error("the disk is too large", "unsupported");
        this.virtual_size = size;
        this.extents.forEach((extent, index) => { extent.index = index; });
        this.metadata_sha256 = sha256_hex(...metadata);
    }

    /**
     * The source of a file a descriptor names
     * @param {string} file
     * @return {!Promise<?>}
     */
    async extent_source(file)
    {
        if(!this.open_extent_source)
        {
            throw this.error("the descriptor names the file " + JSON.stringify(file) + ": give it in files", "config");
        }
        return this.open_extent_source(file);
    }

    /**
     * A hosted sparse extent: header (or the footer of a stream), grain
     * directory, the descriptor in it
     * @param {?} source
     * @param {!Array<!Uint8Array>} metadata
     * @return {!Promise<!Object>}
     */
    async open_sparse(source, metadata)
    {
        let header = (await this.read_from(source, 0, 512, "the sparse header")).slice();
        const where = source.name || this.name;
        if(u32le(header, 0) !== SPARSE_MAGIC) throw this.error(where + ": no sparse header (KDMV)");
        const version = u32le(header, 4);
        if(version < 1 || version > 3) throw this.error(where + ": sparse version " + version + " is not supported", "unsupported");
        const descriptor_offset = to_number(read_u64(header, 28, true), "the descriptor offset") * 512;
        const descriptor_size = to_number(read_u64(header, 36, true), "the descriptor size") * 512;
        if(read_u64(header, 56, true) === GD_AT_END)
        {
            // a stream: the footer (after a marker, before the end-of-stream
            // marker) has the grain directory's place
            const length = source.byteLength;
            if(length < 1536) throw this.error(where + ": a stream without its footer");
            const end = await this.read_from(source, length - 1536, 1536, "the stream's footer");
            if(u32le(end, 12) !== MARKER_FOOTER || u32le(end, 8) !== 0 || u32le(end, 512) !== SPARSE_MAGIC ||
                u32le(end, 1024 + 12) !== MARKER_END_OF_STREAM || u32le(end, 1024 + 8) !== 0 || read_u64(end, 1024, true) !== big(0))
            {
                throw this.error(where + ": the stream's footer is invalid");
            }
            header = end.slice(512, 1024);
        }
        metadata.push(header);
        const flags = u32le(header, 8);
        const capacity = to_number(read_u64(header, 12, true), where + ": the capacity");
        const grain_sectors = to_number(read_u64(header, 20, true), where + ": the grain size");
        const gtes_per_gt = u32le(header, 44);
        const gd_offset = to_number(read_u64(header, 56, true), where + ": the grain directory's offset") * 512;
        const compress = header[77] | header[78] << 8;
        if(grain_sectors < 8 || grain_sectors & grain_sectors - 1 || grain_sectors > 0x200000)
        {
            throw this.error(where + ": the grain size " + grain_sectors + " sectors is invalid");
        }
        if(gtes_per_gt === 0 || gtes_per_gt > 512) throw this.error(where + ": " + gtes_per_gt + " entries per grain table is invalid");
        const compressed = !!(flags & FLAG_COMPRESSED);
        if(compressed && compress !== 1) throw this.error(where + ": compression algorithm " + compress + " is not supported", "unsupported");
        const grain_bytes = grain_sectors * 512;
        const gd_entries = Math.ceil(capacity / (grain_sectors * gtes_per_gt));
        if(gd_entries * 4 > 32 * 1024 * 1024) throw this.error(where + ": the grain directory is too large", "unsupported");
        const gd = (await this.read_from(source, gd_offset, gd_entries * 4, "the grain directory")).slice();
        metadata.push(gd);
        let descriptor_text = "";
        if(descriptor_offset && descriptor_size)
        {
            const bytes = await this.read_from(source, descriptor_offset, descriptor_size, "the embedded descriptor");
            const end = bytes.indexOf(0);
            descriptor_text = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
        }
        return {
            type: "SPARSE", source, capacity, grain_bytes, gtes_per_gt, gd, compressed,
            markers: !!(flags & FLAG_MARKERS), zeroed_grain: !!(flags & FLAG_ZEROED_GRAIN), descriptor_text,
        };
    }

    /**
     * A grain table of an extent (cached)
     * @param {!Object} extent
     * @param {number} offset
     * @param {function((Error|undefined))} callback
     */
    load_gt(extent, offset, callback)
    {
        const key = extent.index + ":" + offset;
        const waiting = this.gt_loading.get(key);
        if(waiting)
        {
            waiting.push(callback);
            return;
        }
        const callbacks = [callback];
        this.gt_loading.set(key, callbacks);
        const finish = error =>
        {
            this.gt_loading.delete(key);
            for(const f of callbacks) f(error);
        };
        const length = extent.gtes_per_gt * 4;
        if(offset + length > extent.source.byteLength)
        {
            finish(this.error("the grain table at " + offset + " is past the end of " + extent.source.name));
            return;
        }
        this.stats.table_reads++;
        extent.source.read(offset, length, (data, error) =>
        {
            if(error)
            {
                finish(error);
                return;
            }
            this.gt_cache.set(key, data.slice());
            this.gt_cache_bytes += length;
            while(this.gt_cache_bytes > GT_CACHE_SIZE && this.gt_cache.size > 1)
            {
                const oldest = this.gt_cache.keys().next().value;
                this.gt_cache_bytes -= this.gt_cache.get(oldest).length;
                this.gt_cache.delete(oldest);
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
        // the grain tables needed that are not cached
        const missing = [];
        this.walk(offset, length, (extent, in_extent, count) =>
        {
            if(extent.type !== "SPARSE") return;
            const grains_per_gt = extent.gtes_per_gt;
            const first = Math.floor(in_extent / extent.grain_bytes), last = Math.floor((in_extent + count - 1) / extent.grain_bytes);
            for(let gd_index = Math.floor(first / grains_per_gt); gd_index <= Math.floor(last / grains_per_gt); gd_index++)
            {
                const gt_offset = u32le(extent.gd, gd_index * 4) * 512;
                if(gt_offset && !this.gt_cache.has(extent.index + ":" + gt_offset)) missing.push([extent, gt_offset]);
            }
        });
        if(!missing.length)
        {
            this.stats.table_hits++;
            this.build(offset, length, callback, signal);
            return;
        }
        let pending = missing.length, failed = false;
        for(const [extent, gt_offset] of missing)
        {
            this.load_gt(extent, gt_offset, error =>
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
     * Call f(extent, offset in the extent, count) for the parts of
     * [offset, offset + length) in each extent
     */
    walk(offset, length, f)
    {
        const end = offset + length;
        for(const extent of this.extents)
        {
            const from = Math.max(offset, extent.start), to = Math.min(end, extent.start + extent.length);
            if(from < to) f(extent, from - extent.start, to - from);
        }
    }

    build(offset, length, callback, signal)
    {
        const extents = [];
        let failed;
        this.walk(offset, length, (extent, in_extent, count) =>
        {
            if(failed) return;
            if(extent.type === "ZERO")
            {
                push_extent(extents, EXTENT_ZERO, count);
                return;
            }
            if(extent.type === "FLAT")
            {
                push_extent(extents, EXTENT_DATA, count, extent.offset + in_extent, extent.source);
                return;
            }
            const end = in_extent + count;
            for(let position = in_extent; position < end;)
            {
                const grain = Math.floor(position / extent.grain_bytes);
                const in_grain = position - grain * extent.grain_bytes;
                const n = Math.min(extent.grain_bytes - in_grain, end - position);
                const gt_offset = u32le(extent.gd, Math.floor(grain / extent.gtes_per_gt) * 4) * 512;
                let entry = 0;
                if(gt_offset)
                {
                    const table = this.gt_cache.get(extent.index + ":" + gt_offset);
                    if(!table)
                    {
                        // evicted meanwhile: map the rest again
                        failed = true;
                        const rest_start = extent.start + position;
                        this.map(rest_start, offset + length - rest_start, (rest, error) =>
                        {
                            if(error) callback(undefined, error);
                            else callback(extents.concat(rest));
                        }, signal);
                        return;
                    }
                    entry = u32le(table, grain % extent.gtes_per_gt * 4);
                }
                if(entry === 0)
                {
                    push_extent(extents, EXTENT_PARENT, n);
                }
                else if(entry === GTE_ZEROED && extent.zeroed_grain)
                {
                    push_extent(extents, EXTENT_ZERO, n);
                }
                else if(extent.compressed)
                {
                    const host_offset = entry * 512;
                    extents.push({ type: EXTENT_COMPRESSED, length: n, host_offset, source: extent.source,
                        host_length: Math.min(extent.grain_bytes + 4096, extent.source.byteLength - host_offset),
                        cluster_start: in_grain, grain_bytes: extent.grain_bytes, markers: extent.markers,
                        key: extent.index * 2 ** 40 + entry });
                }
                else
                {
                    push_extent(extents, EXTENT_DATA, n, entry * 512 + in_grain, extent.source);
                }
                position += n;
            }
        });
        if(!failed) callback(extents);
    }

    /**
     * A compressed grain: after a marker (the grain's sector, the data's
     * length) with markers, zlib data (RFC 1950)
     * @param {!Uint8Array} bytes
     * @param {!Object} extent
     * @return {!Uint8Array}
     */
    decompress(bytes, extent)
    {
        let data = bytes;
        if(extent.markers)
        {
            if(bytes.length < 12) throw this.error("a grain marker at " + extent.host_offset + " is cut off");
            const size = u32le(bytes, 8);
            if(size === 0 || size > bytes.length - 12)
            {
                throw this.error("the grain marker at " + extent.host_offset + " has the size " + size);
            }
            data = bytes.subarray(12, 12 + size);
        }
        const cmf = data[0], flg = data[1];
        if((cmf & 0x0F) !== 8 || ((cmf << 8) + flg) % 31 || flg & 0x20)
        {
            throw this.error("the grain at " + extent.host_offset + " is not zlib data");
        }
        const { output, end } = inflate(data, 2, extent.grain_bytes, extent.grain_bytes);
        if(output.length < extent.cluster_start + extent.length)
        {
            throw this.error("the grain at " + extent.host_offset + " has " + output.length + " bytes, " +
                (extent.cluster_start + extent.length) + " are needed");
        }
        // the stream ends with the data's Adler-32 (as zlib's uncompress,
        // which QEMU uses, checks)
        const sum = end + 4 <= data.length ? (data[end] << 24 | data[end + 1] << 16 | data[end + 2] << 8 | data[end + 3]) >>> 0 : -1;
        if(sum !== adler32(output))
        {
            throw this.error("the grain at " + extent.host_offset + " has a wrong Adler-32 checksum");
        }
        return output;
    }

    /**
     * A parent: a VMDK whose CID is this one's parentCID
     * @param {!ImageReader} parent
     */
    check_parent(parent)
    {
        if(parent.format !== "vmdk")
        {
            throw this.error("the parent is " + parent.format + ": a VMDK's parent is a VMDK", "config");
        }
        if(/** @type {!VMDKReader} */ (parent).cid !== this.parent_cid)
        {
            throw this.error("the parent's CID is " + /** @type {!VMDKReader} */ (parent).cid + ", this image's parentCID " +
                this.parent_cid + ": not its parent", "config");
        }
    }
}
