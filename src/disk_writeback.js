// Write-back disks (docs/disk-persistence-plan.md): disk_option "read_write"
// writes the guest's changes into the image itself. This file has what a
// write-back backend needs beyond the buffers of src/buffer.js (the backend
// contract: load, byteLength, get, set, flush, close, mark, generation,
// get_state, set_state, check_state) and the rules for snapshots of disks
// written back:
// - a backend has an identity (the image) and a generation (its version,
//   which every write moves on); a snapshot of the disk is only a reference
//   (identity, generation, size), without data: the data is in the image;
// - saving flushes first and marks the generation; the first write after
//   that moves the generation on before it writes;
// - restoring: a read_write disk takes only a reference of the same
//   identity and generation; a read_only disk takes such a reference too
//   (its changes in memory are then dropped) when it can tell its image's
//   identity and generation (a local file in Node read in ranges, or a
//   disk service's image read in ranges: its ETag); a snapshot with
//   changes in memory never goes into an image written back.
// The reference backend: NodeFileDisk, a local file in Node (the descriptor's
// url), read and written synchronously (fs.readSync, fs.writeSync,
// fs.fdatasyncSync). Completion means the write is in the file (the host's
// page cache: a crash of the browser or process keeps it); durability needs
// a flush, which the guest asks for or the backend does by itself: 1 s
// after the last write, at the latest 5 s after the first one not yet
// flushed, and on stop(), destroy() and when the drive is pulled out.

import { is_disk_image_state } from "./image/disk_image.js";
import { dbg_log } from "./log.js";
import { LOG_DISK } from "./const.js";

/** a snapshot's reference of a disk written back */
export const WRITEBACK_STATE = "v86-writeback";
export const WRITEBACK_STATE_VERSION = 1;

/** the timed flush: after the last write, at the latest after the first */
export const FLUSH_IDLE_MS = 1000;
export const FLUSH_MAX_MS = 5000;

const SECTOR_SIZE = 512;

/** @type {?} node:fs, once loaded (ensure_node_fs) */
let node_fs = null;

/**
 * Load node:fs for the synchronous file operations (Node only)
 * @return {!Promise<?>}
 */
export async function ensure_node_fs()
{
    if(!node_fs)
    {
        /* global require */
    // (Electron renderers with nodeIntegration: require; string concat
        // for closure compiler, as src/lib.js)
        node_fs = typeof require !== "undefined" ? require("fs") : await import("node:" + "fs");
    }
    return node_fs;
}

/**
 * @param {string} message
 * @param {string} kind
 * @param {boolean} retryable
 * @return {!Error}
 */
export function disk_error(message, kind, retryable)
{
    const error = new Error(message);
    /** @type {?} */ (error).kind = kind;
    error["retryable"] = retryable;
    return error;
}

/**
 * Whether a snapshot's state of a disk is a reference of a disk written back
 * @param {*} state
 * @return {boolean}
 */
export function is_writeback_state(state)
{
    return Array.isArray(state) && state[0] === WRITEBACK_STATE;
}

/**
 * The identity and generation of a local file (Node; node:fs loaded): its
 * real path, device and inode; (inode, size, mtime in nanoseconds)
 * @param {string} path
 * @return {{identity: !Object, generation: string, size: number}}
 */
export function node_file_reference(path)
{
    const fs = node_fs;
    const stat = fs["statSync"](path, { "bigint": true });
    return {
        identity: { "path": fs["realpathSync"](path), "dev": String(stat["dev"]), "ino": String(stat["ino"]) },
        generation: String(stat["ino"]) + ":" + String(stat["size"]) + ":" + String(stat["mtimeNs"]),
        size: Number(stat["size"]),
    };
}

/**
 * @param {*} a
 * @param {*} b
 * @return {boolean}
 */
function same_identity(a, b)
{
    return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The reference a disk's buffer can give of its image, if any: a write-back
 * backend's, or a read_only local file's in Node (read in ranges: its
 * changes are in memory, apart from the file)
 * @param {?} buffer
 * @return {?{identity: !Object, generation: string}}
 */
function reference_of(buffer)
{
    if(buffer.writeback) return null;
    if(typeof buffer.filename !== "string" || !(buffer.written_blocks instanceof Map) || buffer.basename) return null;
    if(node_fs)
    {
        try { return node_file_reference(buffer.filename); }
        catch(e) { return null; }
    }
    // (read over HTTP from a disk service: the ETag of its responses,
    // "<the image's UUID>:<generation>", tools/disk-service.mjs)
    const version = buffer.versions instanceof Map ? buffer.versions.get(buffer.filename) : undefined;
    const match = version && version.etag && /^"([0-9a-f-]{36}):(\d+)"$/.exec(version.etag);
    if(!match) return null;
    let url = buffer.filename;
    try { url = new URL(buffer.filename, globalThis.location ? globalThis.location.href : undefined).href; } catch(e) {}
    return { identity: { "url": url, "uuid": match[1] }, generation: match[2] };
}

/**
 * Check a snapshot's state of a disk before anything is restored (the
 * table of docs/disk-persistence-plan.md "快照")
 * @param {string} name
 * @param {?} buffer
 * @param {*} saved the snapshot's state of the buffer
 */
export function check_disk_state(name, buffer, saved)
{
    if(typeof buffer.check_state === "function")
    {
        buffer.check_state(saved);
        return;
    }
    if(is_disk_image_state(saved))
    {
        throw new Error("The snapshot's disk " + name + " is a disk image in a container format, " +
            "this machine's is RAW: its changes cannot be applied to it");
    }
    if(is_writeback_state(saved))
    {
        const reference = reference_of(buffer);
        const identity = JSON.parse(saved[2]);
        if(!reference)
        {
            throw new Error("The snapshot's disk " + name + " was written back (disk_option \"read_write\", " + identity["path"] +
                "); this machine's cannot tell whether its image is that one in that version: give it as a local file read in ranges " +
                "(async: true) or with disk_option \"read_write\"");
        }
        if(!same_identity(identity, reference.identity) || saved[3] !== reference.generation)
        {
            throw new Error("The snapshot's disk " + name + " is " + JSON.stringify(identity) + " in generation " + saved[3] +
                "; this machine's is " + JSON.stringify(reference.identity) + " in generation " + reference.generation);
        }
    }
}

/**
 * Restore a disk's buffer from a snapshot's state (checked before)
 * @param {?} buffer
 * @param {*} saved
 */
export function restore_disk_state(buffer, saved)
{
    if(is_writeback_state(saved) && !buffer.writeback)
    {
        // (a read_only disk of the same image in the same generation: no
        // changes in memory)
        buffer.written_blocks = new Map();
        buffer.write_chunks = [];
        buffer.block_cache && buffer.block_cache.clear();
        return;
    }
    buffer.set_state(saved);
}

/**
 * After the disks loaded: a disk written back and another disk of the
 * machine are not the same file under two names (a symbolic link, a
 * relative path: the descriptors' urls differ, the files' device and inode
 * do not)
 * @param {!Array<!Array<*>>} disks [name, buffer, descriptor]
 * @return {!Promise<undefined>}
 */
export async function check_loaded_disks(disks)
{
    const path_of = (buffer, file) => file && typeof file.url === "string" ? file.url : buffer && typeof buffer.filename === "string" ? buffer.filename : "";
    // (in Node, node:fs for the references of local files: a read_only
    // disk restoring a snapshot of a disk written back, check_disk_state)
    if(typeof process !== "undefined" && process.versions && process.versions.node && typeof XMLHttpRequest === "undefined" &&
        disks.some(([, buffer, file]) => path_of(buffer, file)))
    {
        await ensure_node_fs();
    }
    const written = disks.filter(([, buffer]) => buffer && buffer.writeback && buffer.identity && buffer.identity["ino"]);
    if(!written.length) return;
    for(const [name, buffer, file] of disks)
    {
        if(!buffer || written.some(([, other]) => other === buffer)) continue;
        const path = path_of(buffer, file);
        if(!path) continue;
        let reference;
        try { reference = node_file_reference(path); }
        catch(e) { continue; }
        const same = written.find(([, other]) => other.identity["dev"] === reference.identity["dev"] && other.identity["ino"] === reference.identity["ino"]);
        if(same)
        {
            throw disk_error(same[0] + " and " + name + " are the same file (" + reference.identity["path"] + "), and " + same[0] +
                " has disk_option \"read_write\": an image written back has one disk", "config", false);
        }
    }
}

/** @type {!Set<string>} the local files written back by a machine of this process */
const open_files = new Set();

/**
 * A local file in Node, written back
 * @constructor
 * @param {string} path the descriptor's url
 * @param {{name: string, size: (number|undefined)}} options
 */
export function NodeFileDisk(path, options)
{
    this.path = path;
    this.name = options.name;
    this.expected_size = options.size;
    /** @type {number} */
    this.byteLength = 0;
    /** a backend of the contract (src/block_backend.js, src/ide.js: the write cache) */
    this.writeback = true;
    this.fd = -1;
    this.closed = false;
    /** @type {!Object} */
    this.identity = {};
    /** the generation the last snapshot recorded, until the next write */
    this.marked = null;
    /** writes not flushed yet: since when */
    this.dirty_since = 0;
    this.flush_timer = 0;
    /** the flushes asked for (by the guest, the timer, stop()) and those done (fdatasync) */
    this.flush_requests = 0;
    this.flushes = 0;
    this.writes = 0;
    this.onload = undefined;
    this.onprogress = undefined;
}

NodeFileDisk.prototype.load = async function()
{
    const fs = await ensure_node_fs();
    const fail = message => { throw disk_error(this.name + ": " + message, "config", false); };
    try
    {
        this.fd = fs["openSync"](this.path, "r+");
    }
    catch(e)
    {
        fail("the file " + this.path + " cannot be opened for writing (" + e.message + "); without disk_option " +
            "(or with \"read_only\") the guest's changes stay in memory");
    }
    const reference = node_file_reference(this.path);
    if(reference.size % SECTOR_SIZE)
    {
        this.close_now();
        fail(this.path + " has " + reference.size + " bytes, not a whole number of " + SECTOR_SIZE + "-byte sectors");
    }
    if(this.expected_size !== undefined && this.expected_size !== reference.size)
    {
        this.close_now();
        fail(this.path + " has " + reference.size + " bytes, the descriptor's size says " + this.expected_size);
    }
    const key = reference.identity["dev"] + ":" + reference.identity["ino"];
    if(open_files.has(key))
    {
        this.close_now();
        fail(this.path + " is written back by another disk of this process already: an image written back has one writer");
    }
    open_files.add(key);
    this.key = key;
    this.identity = reference.identity;
    this.byteLength = reference.size;
    this.onload && this.onload(Object.create(null));
};

/**
 * @param {*} e
 * @param {string} what
 * @return {!Error}
 */
NodeFileDisk.prototype.io_error = function(e, what)
{
    // (no space, a read-only file system, a file closed: trying again does not help)
    const code = e && e.code;
    const retryable = !["ENOSPC", "EDQUOT", "EROFS", "EBADF", "EACCES", "EPERM", "EFBIG"].includes(code);
    return disk_error(this.name + ": the " + what + " of " + this.path + " failed (" + (e && e.message || e) + ")", "io", retryable);
};

/**
 * @param {number} start
 * @param {number} length
 * @return {!Uint8Array}
 */
NodeFileDisk.prototype.read_now = function(start, length)
{
    if(this.closed) throw disk_error(this.name + ": the disk is closed", "io", false);
    const data = new Uint8Array(length);
    for(let done = 0; done < length;)
    {
        const n = node_fs["readSync"](this.fd, data, done, length - done, start + done);
        if(!n) break;
        done += n;
    }
    return data;
};

/**
 * @param {number} start
 * @param {number} length
 * @param {function((!Uint8Array|undefined), !Error=)} fn
 */
NodeFileDisk.prototype.get = function(start, length, fn)
{
    let data;
    try { data = this.read_now(start, length); }
    catch(e) { fn(undefined, e["retryable"] === undefined ? this.io_error(e, "read") : e); return; }
    fn(data);
};

NodeFileDisk.prototype.get_and_cache = NodeFileDisk.prototype.get;

/**
 * (synchronous anyway)
 * @param {number} start
 * @param {number} length
 * @return {!Uint8Array|undefined}
 */
NodeFileDisk.prototype.get_from_cache = function(start, length)
{
    try { return this.read_now(start, length); }
    catch(e) { return undefined; }
};

/**
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function(!Error=)} fn
 */
NodeFileDisk.prototype.set = function(start, data, fn)
{
    if(this.closed)
    {
        fn(disk_error(this.name + ": the disk is closed", "io", false));
        return;
    }
    try
    {
        const marked = this.marked;
        if(marked !== null)
        {
            // the first write after a snapshot: the generation moves on
            // before the data changes
            this.move_generation(marked);
        }
        for(let done = 0; done < data.length;)
        {
            done += node_fs["writeSync"](this.fd, data, done, data.length - done, start + done);
        }
        if(marked !== null)
        {
            // (a file system with coarse timestamps may give the write the
            // marked time again)
            if(this.generation() === marked) this.move_generation(marked);
            this.marked = null;
        }
    }
    catch(e)
    {
        fn(this.io_error(e, "write"));
        return;
    }
    this.writes++;
    this.schedule_flush();
    fn(undefined);
};

/**
 * The file's generation is the snapshot's: give it another
 * @param {?} marked
 */
NodeFileDisk.prototype.move_generation = function(marked)
{
    const fs = node_fs;
    const stat = fs["fstatSync"](this.fd);
    // (seconds as a double, as futimes takes them: 1 ms after the marked
    // time, or now if that is later)
    const next = Number(marked.split(":")[2]) / 1e9 + 0.001;
    fs["futimesSync"](this.fd, stat["atimeMs"] / 1000, Math.max(Date.now() / 1000, next));
};

/** @return {string} the file's generation now */
NodeFileDisk.prototype.generation = function()
{
    const stat = node_fs["fstatSync"](this.fd, { "bigint": true });
    return String(stat["ino"]) + ":" + String(stat["size"]) + ":" + String(stat["mtimeNs"]);
};

/** The timed flush (FLUSH_IDLE_MS after the last write, FLUSH_MAX_MS at most) */
NodeFileDisk.prototype.schedule_flush = function()
{
    const now = Date.now();
    if(!this.dirty_since) this.dirty_since = now;
    clearTimeout(this.flush_timer);
    const wait = Math.max(0, Math.min(FLUSH_IDLE_MS, this.dirty_since + FLUSH_MAX_MS - now));
    this.flush_timer = setTimeout(() =>
    {
        this.flush_timer = 0;
        this.flush(error => { if(error) dbg_log(error.message, LOG_DISK); });
    }, wait);
    // (in Node the timer does not keep the process alive)
    this.flush_timer && this.flush_timer.unref && this.flush_timer.unref();
};

/**
 * The writes completed before are durable
 * @param {function(!Error=)} fn
 */
NodeFileDisk.prototype.flush = function(fn)
{
    this.flush_requests++;
    if(this.closed || !this.dirty_since)
    {
        fn(undefined);
        return;
    }
    clearTimeout(this.flush_timer);
    this.flush_timer = 0;
    try
    {
        node_fs["fdatasyncSync"](this.fd);
    }
    catch(e)
    {
        // (after a failed fsync the kernel may have dropped the data: not retried)
        const error = this.io_error(e, "flush");
        error["retryable"] = false;
        fn(error);
        return;
    }
    this.dirty_since = 0;
    this.flushes++;
    fn(undefined);
};

/**
 * Flush and close (destroy(), the drive pulled out); the disk is not used
 * afterwards
 * @param {function(!Error=)} fn
 */
NodeFileDisk.prototype.close = function(fn)
{
    if(this.closed)
    {
        fn(undefined);
        return;
    }
    this.flush(error =>
    {
        this.close_now();
        fn(error);
    });
};

NodeFileDisk.prototype.close_now = function()
{
    clearTimeout(this.flush_timer);
    this.flush_timer = 0;
    if(this.fd >= 0)
    {
        try { node_fs["closeSync"](this.fd); } catch(e) {}
        this.fd = -1;
    }
    if(this.key) open_files.delete(this.key);
    this.closed = true;
};

/**
 * Flush and record the generation, for a snapshot
 * @return {string}
 */
NodeFileDisk.prototype.mark = function()
{
    let failed;
    this.flush(error => { failed = error; });
    if(failed) throw failed;
    this.marked = this.generation();
    return this.marked;
};

/** (no whole image in memory: export reads the file) */
NodeFileDisk.prototype.get_buffer = function(fn)
{
    fn(undefined);
};

/**
 * A snapshot's reference: identity, generation, size; no data
 * @return {!Array<*>}
 */
NodeFileDisk.prototype.get_state = function()
{
    const generation = this.mark();
    return [WRITEBACK_STATE, WRITEBACK_STATE_VERSION, JSON.stringify(this.identity), generation, this.byteLength];
};

/**
 * @param {*} state
 */
NodeFileDisk.prototype.check_state = function(state)
{
    const name = this.name;
    if(!is_writeback_state(state))
    {
        throw new Error(state ?
            "The snapshot's disk " + name + " has its changes in memory (disk_option \"read_only\", or an older v86): " +
            "they are not written into " + this.path + ", which this machine writes back" :
            "The snapshot has no disk " + name + ", this machine writes back " + this.path);
    }
    if(state[1] !== WRITEBACK_STATE_VERSION)
    {
        throw new Error("The snapshot's disk " + name + " has a reference of version " + state[1] + ", this v86 reads version " + WRITEBACK_STATE_VERSION);
    }
    const identity = JSON.parse(state[2]);
    const generation = this.generation();
    if(!same_identity(identity, this.identity) || state[3] !== generation || state[4] !== this.byteLength)
    {
        throw new Error("The snapshot's disk " + name + " is " + JSON.stringify(identity) + " in generation " + state[3] +
            "; this machine's is " + JSON.stringify(this.identity) + " in generation " + generation +
            " (an image written to after the snapshot was saved cannot go back to it)");
    }
};

NodeFileDisk.prototype.set_state = function(state)
{
    this.check_state(state);
};

/**
 * The disks written back whose backend prepares a snapshot asynchronously
 * (a disk service: flush, then the generation recorded)
 * @param {?} cpu
 * @return {!Array<?>}
 */
export function disks_to_prepare(cpu)
{
    return disk_buffers(cpu).map(([, buffer]) => buffer).filter(buffer => buffer.writeback && typeof buffer.prepare_snapshot === "function");
}

/**
 * [name, buffer] of a machine's disks: its hard disks and CD drives
 * (cpu.disk_devices), its floppy drives' disks; each buffer once
 * @param {?} cpu
 * @return {!Array<!Array<*>>}
 */
export function disk_buffers(cpu)
{
    const seen = new Set(), disks = [];
    const add = (name, buffer) => { if(buffer && !seen.has(buffer)) { seen.add(buffer); disks.push([name, buffer]); } };
    for(const [name, device] of typeof cpu.disk_devices === "function" ? cpu.disk_devices() : []) add(name, device && device.buffer);
    const fdc = cpu.devices && cpu.devices.fdc;
    if(fdc && fdc.drives) fdc.drives.forEach((drive, i) => add(i ? "fdb" : "fda", drive.buffer));
    return disks;
}

/**
 * @param {!Array<?>} disks
 * @return {!Promise<undefined>}
 */
export async function prepare_disks(disks)
{
    for(const disk of disks)
    {
        await new Promise((resolve, reject) => disk.prepare_snapshot(error => error ? reject(error) : resolve()));
    }
}
