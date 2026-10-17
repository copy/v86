// A hard disk from a disk image in a container format
// (docs/disk-image-formats-plan.md): the format's reader decodes the guest's
// sectors from the file (src/image/qcow2.js, ...), the guest's writes stay
// in memory (src/image/overlay.js), and the device sees the interface of the
// buffers of src/buffer.js (load, byteLength, get, set, get_and_cache,
// get_from_cache, get_state, set_state). byteLength is the disk's size as
// the guest sees it, not the file's.
//
// Callbacks: get's is fn(data) when it worked and fn(undefined, error) when
// not (the second argument: old buffers never pass one), set's is fn(error).

import { dbg_assert, dbg_log } from "../log.js";
import { LOG_DISK } from "../const.js";
import { DiskImageError } from "./source.js";
import { WriteOverlay, OVERLAY_BLOCK_SIZE } from "./overlay.js";

/** the data is in the file at host_offset (in extent.source, if it has one: a
 * file of several, VMDK) */
export const EXTENT_DATA = 0;
/** reads as zeros */
export const EXTENT_ZERO = 1;
/** not in this file: the parent's data, or zeros without a parent */
export const EXTENT_PARENT = 2;
/** in a compressed cluster at host_offset, host_length bytes */
export const EXTENT_COMPRESSED = 3;

/** a snapshot's disk state of a DiskImage: [DISK_IMAGE_STATE, version, identity, indices, chunks] */
export const DISK_IMAGE_STATE = "v86-disk-image";
const DISK_IMAGE_STATE_VERSION = 1;

// the most compressed clusters kept decompressed
const DECOMPRESSED_CACHE_SIZE = 8 * 1024 * 1024;

/**
 * A bigint, its type left open: the build's Closure Compiler (v20210601)
 * checks no bitwise operators on bigint
 * @param {number|string} value
 * @return {?}
 */
export function big(value)
{
    return BigInt(value);
}

/**
 * Read a big-endian or little-endian unsigned 64-bit field as a BigInt
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @param {boolean=} little_endian
 * @return {?} a bigint
 */
export function read_u64(bytes, offset, little_endian)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const high = view.getUint32(offset + (little_endian ? 4 : 0), little_endian);
    const low = view.getUint32(offset + (little_endian ? 0 : 4), little_endian);
    return big(high) << big(32) | big(low);
}

/**
 * A 64-bit field as a Number, checked to be a safe integer no larger than
 * `max`
 * @param {?} value a bigint
 * @param {string} what for the message
 * @param {number=} max
 * @return {number}
 */
export function to_number(value, what, max)
{
    if(value > big(max === undefined ? Number.MAX_SAFE_INTEGER : max))
    {
        throw new DiskImageError(what + " " + value + " is too large" +
            (max === undefined ? " (beyond 2^53)" : " (at most " + max + ")"), "unsupported");
    }
    return Number(value);
}

/**
 * The reader of an opened image file: the format's mapping from the guest's
 * offsets to its file (map), and the data read through it (read). A format
 * sets virtual_size, format and the metadata hashed for its identity in
 * open(), and may have a parent (another reader) for the parts it does not
 * have.
 */
export class ImageReader
{
    /**
     * @param {?} source an opened source (src/image/source.js)
     * @param {string} name for messages
     */
    constructor(source, name)
    {
        this.source = source;
        this.name = name;
        this.format = "";
        this.virtual_size = 0;
        /** @type {ImageReader} */
        this.parent = null;
        /** the metadata that identifies the image (hex SHA-256, set by open) */
        this.metadata_sha256 = "";
        /** what the image says about its parent (format specific), or null */
        this.parent_link = null;
        /** the descriptor's image_id: a version of the image its publisher gives */
        this.image_id = "";
        /** @type {!Map<number, !Uint8Array>} host offset -> decompressed cluster, the most recently used last */
        this.decompressed = new Map();
        this.decompressed_bytes = 0;
        /** @type {!Map<number, !Array<function((!Uint8Array|undefined), (Error|undefined)=)>>} */
        this.decompressing = new Map();
        /** reads of the format's tables (L2 tables, block maps, ...), decompressions */
        this.stats = { table_reads: 0, table_hits: 0, decompressed: 0, decompress_hits: 0 };
    }

    /**
     * @param {function((Error|undefined))} callback
     */
    open(callback)
    {
        dbg_assert(false);
    }

    /**
     * The extents of [offset, offset + length), in order and covering it
     * @param {number} offset
     * @param {number} length
     * @param {function((Array<!Object>|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    map(offset, length, callback, signal)
    {
        dbg_assert(false);
    }

    /**
     * Check a parent against what this image says about it (parent_link):
     * format-specific identity rules, errors for a parent that is not this
     * image's
     * @param {!ImageReader} parent
     */
    check_parent(parent)
    {
    }

    /**
     * Decompress a compressed cluster (formats with compression)
     * @param {!Uint8Array} bytes
     * @param {!Object} extent
     * @return {!Uint8Array}
     */
    decompress(bytes, extent)
    {
        throw new DiskImageError(this.name + ": compressed data is not supported", "unsupported");
    }

    /**
     * What identifies this image (and its parents) in a snapshot
     * @return {!Object}
     */
    identity()
    {
        return {
            "format": this.format,
            "size": this.virtual_size,
            "file_size": this.source.byteLength,
            "metadata_sha256": this.metadata_sha256,
            "image_id": this.image_id,
            "parent": this.parent ? this.parent.identity() : null,
        };
    }

    /**
     * [offset, offset + length) as the guest sees it: a new array
     * @param {number} offset
     * @param {number} length
     * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    read(offset, length, callback, signal)
    {
        dbg_assert(offset >= 0 && length >= 0 && offset + length <= this.virtual_size);
        this.map(offset, length, (extents, error) =>
        {
            if(error)
            {
                callback(undefined, error);
                return;
            }
            const result = new Uint8Array(length);
            let pending = 1;
            let failed = false;
            const fail = error =>
            {
                if(failed) return;
                failed = true;
                callback(undefined, error);
            };
            const done = () =>
            {
                if(--pending === 0 && !failed) callback(result);
            };
            let position = 0;
            for(const extent of /** @type {!Array<!Object>} */ (extents))
            {
                const at = position;
                position += extent.length;
                if(failed) break;
                switch(extent.type)
                {
                    case EXTENT_DATA:
                    {
                        // (past the end of the file reads as zeros, as in QEMU:
                        // a cluster's last part may never have been written)
                        const source = extent.source || this.source;
                        const available = Math.min(extent.length, source.byteLength - extent.host_offset);
                        if(available <= 0) break;
                        pending++;
                        source.read(extent.host_offset, available, (data, error) =>
                        {
                            if(error) fail(error);
                            else
                            {
                                result.set(/** @type {!Uint8Array} */ (data), at);
                                done();
                            }
                        }, signal);
                        break;
                    }
                    case EXTENT_PARENT:
                    {
                        const parent = this.parent;
                        // (past a smaller parent's end: zeros)
                        const available = parent ? Math.min(extent.length, parent.virtual_size - (offset + at)) : 0;
                        if(available <= 0) break;
                        pending++;
                        parent.read(offset + at, available, (data, error) =>
                        {
                            if(error) fail(error);
                            else
                            {
                                result.set(/** @type {!Uint8Array} */ (data), at);
                                done();
                            }
                        }, signal);
                        break;
                    }
                    case EXTENT_COMPRESSED:
                        pending++;
                        this.read_compressed(extent, (cluster, error) =>
                        {
                            if(error) fail(error);
                            else
                            {
                                result.set(/** @type {!Uint8Array} */ (cluster).subarray(extent.cluster_start, extent.cluster_start + extent.length), at);
                                done();
                            }
                        }, signal);
                        break;
                    case EXTENT_ZERO:
                        break;
                    default:
                        dbg_assert(false);
                }
            }
            dbg_assert(failed || position === length);
            done();
        }, signal);
    }

    /**
     * Whether [offset, offset + length) reads as zeros by the image's
     * metadata alone (zero and unallocated extents, a parent's likewise):
     * false where it may have data. An export skips such parts without
     * reading them.
     * @param {number} offset
     * @param {number} length
     * @param {function(boolean, (Error|undefined)=)} callback
     */
    is_zero(offset, length, callback)
    {
        this.map(offset, length, (extents, error) =>
        {
            if(error)
            {
                callback(false, error);
                return;
            }
            let pending = 1, zero = true;
            const done = () =>
            {
                if(--pending === 0) callback(zero);
            };
            let position = 0;
            for(const extent of /** @type {!Array<!Object>} */ (extents))
            {
                const at = position;
                position += extent.length;
                if(extent.type === EXTENT_ZERO) continue;
                if(extent.type === EXTENT_PARENT)
                {
                    const parent = this.parent;
                    const available = parent ? Math.min(extent.length, parent.virtual_size - (offset + at)) : 0;
                    if(available <= 0) continue;
                    pending++;
                    parent.is_zero(offset + at, available, parent_zero =>
                    {
                        zero = zero && parent_zero;
                        done();
                    });
                    continue;
                }
                zero = false;
                break;
            }
            done();
        });
    }

    /**
     * A compressed cluster, decompressed (kept for the next reads of it)
     * @param {!Object} extent
     * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
     * @param {AbortSignal=} signal
     */
    read_compressed(extent, callback, signal)
    {
        // (formats of several files key their clusters themselves)
        const key = extent.key === undefined ? extent.host_offset : extent.key;
        const source = extent.source || this.source;
        const cached = this.decompressed.get(key);
        if(cached)
        {
            this.stats.decompress_hits++;
            this.decompressed.delete(key);
            this.decompressed.set(key, cached);
            callback(cached);
            return;
        }
        const waiting = this.decompressing.get(key);
        if(waiting)
        {
            waiting.push(callback);
            return;
        }
        const callbacks = [callback];
        this.decompressing.set(key, callbacks);
        const length = Math.min(extent.host_length, source.byteLength - extent.host_offset);
        const finish = (cluster, error) =>
        {
            this.decompressing.delete(key);
            for(const f of callbacks) f(cluster, error);
        };
        if(length <= 0)
        {
            finish(undefined, new DiskImageError(this.name + ": a compressed cluster at " + extent.host_offset +
                " is past the end of the file (" + source.byteLength + " bytes)", "corrupt"));
            return;
        }
        // (not cancelled with one reader's signal: others may wait for it)
        source.read(extent.host_offset, length, (bytes, error) =>
        {
            if(error)
            {
                finish(undefined, error);
                return;
            }
            let cluster;
            try
            {
                cluster = this.decompress(bytes, extent);
            }
            catch(e)
            {
                finish(undefined, e instanceof DiskImageError ? e : new DiskImageError(this.name +
                    ": the compressed cluster at " + extent.host_offset + " is invalid: " + e.message, "corrupt"));
                return;
            }
            this.stats.decompressed++;
            this.decompressed.set(key, cluster);
            this.decompressed_bytes += cluster.length;
            while(this.decompressed_bytes > DECOMPRESSED_CACHE_SIZE && this.decompressed.size > 1)
            {
                const oldest = this.decompressed.keys().next().value;
                this.decompressed_bytes -= this.decompressed.get(oldest).length;
                this.decompressed.delete(oldest);
            }
            finish(cluster, undefined);
        });
    }
}

/**
 * Add an extent to a list, merged with the one before it where they continue
 * each other
 * @param {!Array<!Object>} extents
 * @param {number} type
 * @param {number} length
 * @param {number=} host_offset
 * @param {?=} source the file, if not the reader's
 */
export function push_extent(extents, type, length, host_offset, source)
{
    const last = extents[extents.length - 1];
    if(last && last.type === type && (type === EXTENT_ZERO || type === EXTENT_PARENT ||
        type === EXTENT_DATA && last.host_offset + last.length === host_offset && last.source === source))
    {
        last.length += length;
        return;
    }
    extents.push({ type, length, host_offset: host_offset || 0, source });
}

/**
 * The device's side of a disk image: what src/ide.js (and AHCI's drives)
 * use of a buffer
 * @constructor
 * @param {string} name hda, hdb, ...
 * @param {function():!Promise<!ImageReader>} open opens the image (src/image/factory.js)
 * @param {{overlay_limit: (number|undefined)}=} options
 */
export function DiskImage(name, open, options)
{
    this.name = name;
    this.open_reader = open;
    this.overlay_limit = options && options.overlay_limit;
    /** @type {ImageReader} */
    this.reader = null;
    /** @type {WriteOverlay} */
    this.overlay = null;
    /** the guest's size of the disk, known once loaded */
    this.byteLength = 0;
    /** @type {Promise<void>} */
    this.loading = null;
    /** blocks of the image read with get_and_cache (the first sector, for the geometry) */
    this.block_cache = new Map();
    /** errors reported so far (each told once in the console) */
    this.errors = new Set();
    this.onload = undefined;
    this.onerror = undefined;
    this.onprogress = undefined;
}

/**
 * Open the image: onload, or onerror and a rejected promise
 * @return {!Promise<void>}
 */
DiskImage.prototype.load = function()
{
    if(!this.loading)
    {
        this.loading = this.open_reader().then(reader =>
        {
            this.reader = reader;
            this.byteLength = reader.virtual_size;
            this.overlay = new WriteOverlay(reader.virtual_size, this.overlay_limit, this.name);
            dbg_log(this.name + ": " + reader.format + " image, " + reader.virtual_size + " bytes" +
                (reader.parent ? ", with a parent" : ""), LOG_DISK);
            this.onload && this.onload(Object.create(null));
        }, error =>
        {
            this.onerror && this.onerror(error);
            throw error;
        });
    }
    return this.loading;
};

/**
 * @param {Error} error
 */
DiskImage.prototype.report_error = function(error)
{
    if(this.errors.has(error.message)) return;
    if(this.errors.size < 100) this.errors.add(error.message);
    console.error(error.message.startsWith(this.name) ? error.message : "Disk " + this.name + ": " + error.message);
};

/**
 * @param {number} start
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} fn
 * @param {{signal: (AbortSignal|undefined)}=} options
 */
DiskImage.prototype.get = function(start, length, fn, options)
{
    dbg_assert(this.reader, "disk image not loaded");
    dbg_assert(start >= 0 && start + length <= this.byteLength);
    const signal = options && options.signal;
    if(this.overlay.covers(start, length))
    {
        const result = new Uint8Array(length);
        this.overlay.apply(start, result);
        fn(result);
        return;
    }
    this.reader.read(start, length, (data, error) =>
    {
        if(signal && signal.aborted) return;
        if(error)
        {
            this.report_error(error);
            fn(undefined, error);
            return;
        }
        // (the guest's writes win, also those after the read began)
        this.overlay.apply(start, /** @type {!Uint8Array} */ (data));
        fn(data);
    }, signal);
};

/**
 * @param {number} start
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} fn
 * @param {{signal: (AbortSignal|undefined)}=} options
 */
DiskImage.prototype.get_and_cache = function(start, length, fn, options)
{
    this.get(start, length, (data, error) =>
    {
        if(data && start % OVERLAY_BLOCK_SIZE === 0 && length % OVERLAY_BLOCK_SIZE === 0)
        {
            for(let i = 0; i < length / OVERLAY_BLOCK_SIZE; i++)
            {
                const index = start / OVERLAY_BLOCK_SIZE + i;
                // (blocks written are in the overlay)
                if(!this.overlay.block(index))
                {
                    this.block_cache.set(index, data.slice(i * OVERLAY_BLOCK_SIZE, (i + 1) * OVERLAY_BLOCK_SIZE));
                }
            }
        }
        fn(data, error);
    }, options);
};

/**
 * The data, if it was written or read with get_and_cache: synchronous
 * @param {number} start
 * @param {number} length
 * @return {!Uint8Array|undefined}
 */
DiskImage.prototype.get_from_cache = function(start, length)
{
    if(start % OVERLAY_BLOCK_SIZE || length % OVERLAY_BLOCK_SIZE) return undefined;
    const result = new Uint8Array(length);
    for(let i = 0; i < length / OVERLAY_BLOCK_SIZE; i++)
    {
        const index = start / OVERLAY_BLOCK_SIZE + i;
        const block = this.overlay.block(index) || this.block_cache.get(index);
        if(!block) return undefined;
        result.set(block, i * OVERLAY_BLOCK_SIZE);
    }
    return result;
};

/**
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function((Error|undefined)=)} fn
 */
DiskImage.prototype.set = function(start, data, fn)
{
    dbg_assert(this.reader, "disk image not loaded");
    const error = this.overlay.write(start, data);
    if(error) this.report_error(error);
    fn(error);
};

/**
 * (the whole disk in one buffer: not for disk images, see export)
 * @param {function((!ArrayBuffer|undefined))} fn
 */
DiskImage.prototype.get_buffer = function(fn)
{
    fn(undefined);
};

/**
 * The identity of the image a snapshot's changes belong to
 * @return {!Object}
 */
DiskImage.prototype.identity = function()
{
    return this.reader.identity();
};

DiskImage.prototype.get_state = function()
{
    const state = [];
    state[0] = DISK_IMAGE_STATE;
    state[1] = DISK_IMAGE_STATE_VERSION;
    state[2] = JSON.stringify(this.identity());
    const [indices, chunks] = this.overlay.get_state();
    state[3] = indices;
    state[4] = chunks;
    return state;
};

/**
 * Check a snapshot's state of this disk before anything is restored: it
 * must be of the same image (format, size, metadata, parents)
 * @param {*} state
 */
DiskImage.prototype.check_state = function(state)
{
    if(!Array.isArray(state) || state[0] !== DISK_IMAGE_STATE)
    {
        throw new DiskImageError(state ?
            "The snapshot's disk " + this.name + " is a RAW image (or the snapshot is from an older v86), this machine's " +
            "is a " + this.reader.format + " image: its changes cannot be applied to it" :
            "The snapshot has no disk " + this.name + ", this machine has a " + this.reader.format + " image", "config");
    }
    if(state[1] !== DISK_IMAGE_STATE_VERSION)
    {
        throw new DiskImageError("The snapshot's disk " + this.name + " has a state of version " + state[1] +
            ", this v86 reads version " + DISK_IMAGE_STATE_VERSION, "config");
    }
    let saved;
    try
    {
        saved = JSON.parse(state[2]);
    }
    catch(e)
    {
        throw new DiskImageError("The snapshot's disk " + this.name + " has an invalid identity", "config");
    }
    const mismatch = identity_mismatch(saved, this.identity(), "");
    if(mismatch)
    {
        throw new DiskImageError("The snapshot's disk " + this.name + " is of another image (" + mismatch +
            "): its changes are not applied to this one", "config");
    }
    this.overlay.check_state(state[3], state[4]);
};

/**
 * @param {*} state
 */
DiskImage.prototype.set_state = function(state)
{
    this.check_state(state);
    this.overlay.set_state(state[3], state[4]);
};

/**
 * The first difference of two identities, or ""
 * @param {*} saved
 * @param {!Object} current
 * @param {string} path
 * @return {string}
 */
function identity_mismatch(saved, current, path)
{
    if(!saved || typeof saved !== "object") return path + "identity missing";
    for(const key of ["format", "size", "file_size", "metadata_sha256", "image_id"])
    {
        if(current[key] === undefined) continue;
        if(saved[key] !== current[key])
        {
            return path + key + " " + JSON.stringify(saved[key]) + " in the snapshot, " + JSON.stringify(current[key]) + " here";
        }
    }
    if(!!saved["parent"] !== !!current["parent"])
    {
        return path + (saved["parent"] ? "the snapshot's image has a parent, this one none" : "this image has a parent, the snapshot's none");
    }
    return current["parent"] ? identity_mismatch(saved["parent"], current["parent"], path + "parent: ") : "";
}

/**
 * Whether a snapshot's state of a disk is a DiskImage's
 * @param {*} state
 * @return {boolean}
 */
export function is_disk_image_state(state)
{
    return Array.isArray(state) && state[0] === DISK_IMAGE_STATE;
}
