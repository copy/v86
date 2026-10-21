// Browser disks (docs/vm-manager-plan.md "浏览器磁盘（OPFS）", U6): an image
// in the browser's private file system (OPFS), named by its url
// "opfs:v86/disks/<id>.img". With disk_option "read_write" OpfsDisk writes
// the guest's changes into it, as NodeFileDisk (src/disk_writeback.js) does
// into a local file, through a FileSystemSyncAccessHandle: read, write,
// flush synchronously, in the CPU Worker only (the handles exist in
// dedicated workers). The rules of src/disk_writeback.js hold: a write is
// complete when it is in the file, durable after a flush (the guest's, the
// timer's: 1 s after the last write, at most 5 s after the first not yet
// flushed; stop(), destroy(), pulling the drive out); a snapshot holds a
// reference (identity, generation, size), no data.
// OPFS files have no inode: the identity is a UUID and the generation a
// counter, kept in v86/disks/<id>.json beside the image; the generation
// moves on when the image's size differs from the record, at the first
// write of each session and at the first write after a snapshot, so a
// snapshot never fits an image written after it. The sync access handle is
// exclusive: a disk open in another tab cannot be opened here.
// With disk_option "read_only" the image is read as a File (opfs_file) and
// the changes stay in memory, as for a file the user picked.

import { disk_error, WRITEBACK_STATE, WRITEBACK_STATE_VERSION, FLUSH_IDLE_MS, FLUSH_MAX_MS, is_writeback_state } from "./disk_writeback.js";
import { dbg_log } from "./log.js";
import { LOG_DISK } from "./const.js";

const SECTOR_SIZE = 512;
export const OPFS_SCHEME = "opfs:";

/**
 * Whether a url names a browser disk
 * @param {*} url
 * @return {boolean}
 */
export function is_opfs_url(url)
{
    return typeof url === "string" && url.startsWith(OPFS_SCHEME);
}

/**
 * The directory and file name of a browser disk's url
 * @param {string} url
 * @return {{directory: !Array<string>, name: string}}
 */
function opfs_path(url)
{
    const parts = url.slice(OPFS_SCHEME.length).split("/").filter(Boolean);
    if(!parts.length || parts.some(part => part === "." || part === ".."))
    {
        throw disk_error("The browser disk's url " + url + " names no file (opfs:<directory>/<file>)", "config", false);
    }
    return { directory: parts.slice(0, -1), name: parts[parts.length - 1] };
}

/**
 * A browser disk's directory (not made: a disk that does not exist is an error)
 * @param {string} url
 * @param {string} label the disk's name, for messages
 * @return {!Promise<{dir: ?, name: string}>}
 */
async function opfs_entry(url, label)
{
    const storage = globalThis.navigator && globalThis.navigator["storage"];
    if(!storage || typeof storage["getDirectory"] !== "function")
    {
        throw disk_error(label + ": a browser disk (" + url + ") is in a browser's private storage (OPFS), which is not here", "config", false);
    }
    const path = opfs_path(url);
    let dir = await storage["getDirectory"]();
    try
    {
        for(const part of path.directory) dir = await dir["getDirectoryHandle"](part);
    }
    catch(e)
    {
        throw disk_error(label + ": the browser disk " + url + " does not exist", "config", false);
    }
    return { dir, name: path.name };
}

/**
 * A browser disk's image as a File (read only: the changes stay in memory)
 * @param {string} url
 * @param {string} label
 * @return {!Promise<!File>}
 */
export async function opfs_file(url, label)
{
    const { dir, name } = await opfs_entry(url, label);
    try
    {
        return await (await dir["getFileHandle"](name))["getFile"]();
    }
    catch(e)
    {
        throw disk_error(label + ": the browser disk " + url + " does not exist (" + (e && e.message || e) + ")", "config", false);
    }
}

/**
 * A browser disk, written back
 * @constructor
 * @param {string} url "opfs:v86/disks/<id>.img"
 * @param {{name: string, size: (number|undefined)}} options
 */
export function OpfsDisk(url, options)
{
    this.url = url;
    this.name = options.name;
    this.expected_size = options.size;
    /** @type {number} */
    this.byteLength = 0;
    /** a backend of the contract (src/block_backend.js, src/ide.js: the write cache) */
    this.writeback = true;
    /** @type {?} the image's FileSystemSyncAccessHandle */
    this.access = null;
    /** @type {?} the record's (<id>.json) */
    this.record_access = null;
    /** @type {!Object} the record: uuid, generation, size (and the VM manager's fields) */
    this.record = {};
    this.closed = false;
    /** @type {!Object} */
    this.identity = {};
    /** the generation moves on before the next write (the session's first, the first after a snapshot) */
    this.move_before_write = true;
    this.dirty_since = 0;
    this.flush_timer = 0;
    this.flush_requests = 0;
    this.flushes = 0;
    this.writes = 0;
    this.onload = undefined;
    this.onprogress = undefined;
}

OpfsDisk.prototype.load = async function()
{
    /**
     * @param {string} message
     * @param {string=} kind
     */
    const fail = (message, kind) => { throw disk_error(this.name + ": " + message, kind || "config", false); };
    const { dir, name } = await opfs_entry(this.url, this.name);
    let file;
    try
    {
        file = await dir["getFileHandle"](name);
    }
    catch(e)
    {
        fail("the browser disk " + this.url + " does not exist");
    }
    if(typeof file["createSyncAccessHandle"] !== "function")
    {
        fail("a browser disk written back (disk_option \"read_write\") needs the CPU Worker (cpu_worker): the browser's " +
            "synchronous access to its files is there only");
    }
    try
    {
        this.access = await file["createSyncAccessHandle"]();
    }
    catch(e)
    {
        if(e && e.name === "NoModificationAllowedError")
        {
            fail("the browser disk " + this.url + " is used by another tab (or another disk of this machine)", "in_use");
        }
        fail("the browser disk " + this.url + " cannot be opened (" + (e && e.message || e) + ")");
    }
    const size = this.access["getSize"]();
    if(size % SECTOR_SIZE)
    {
        this.close_now();
        fail(this.url + " has " + size + " bytes, not a whole number of " + SECTOR_SIZE + "-byte sectors");
    }
    if(this.expected_size !== undefined && this.expected_size !== size)
    {
        this.close_now();
        fail(this.url + " has " + size + " bytes, the descriptor's size says " + this.expected_size);
    }
    // the record: identity and generation (made for a disk without one)
    const record_name = name.replace(/\.img$/, "") + ".json";
    try
    {
        this.record_access = await (await dir["getFileHandle"](record_name, { "create": true }))["createSyncAccessHandle"]();
    }
    catch(e)
    {
        this.close_now();
        fail("the record of the browser disk " + this.url + " cannot be opened (" + (e && e.message || e) + ")", e && e.name === "NoModificationAllowedError" ? "in_use" : "config");
    }
    /** @type {!Object} */
    let record = {};
    try
    {
        const bytes = new Uint8Array(this.record_access["getSize"]());
        this.record_access["read"](bytes, { "at": 0 });
        const parsed = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
        record = parsed && typeof parsed === "object" ? /** @type {!Object} */ (parsed) : {};
    }
    catch(e)
    {
        record = {};
    }
    if(typeof record["uuid"] !== "string" || !record["uuid"]) record["uuid"] = globalThis.crypto["randomUUID"]();
    if(!Number.isSafeInteger(record["generation"])) record["generation"] = 1;
    // (changed since the record: another generation)
    if(record["size"] !== size) record["generation"]++;
    record["size"] = size;
    this.record = record;
    this.save_record();
    this.identity = { "opfs": this.url, "uuid": record["uuid"] };
    this.byteLength = size;
    this.onload && this.onload(Object.create(null));
};

/** The record into its file, flushed */
OpfsDisk.prototype.save_record = function()
{
    const bytes = new TextEncoder().encode(JSON.stringify(this.record));
    this.record_access["truncate"](0);
    this.record_access["write"](bytes, { "at": 0 });
    this.record_access["flush"]();
};

/**
 * @param {*} e
 * @param {string} what
 * @return {!Error}
 */
OpfsDisk.prototype.io_error = function(e, what)
{
    // (the browser's quota: no space; trying again does not help)
    const quota = e && e.name === "QuotaExceededError";
    return disk_error(this.name + ": the " + what + " of the browser disk " + this.url + " failed (" + (e && e.message || e) + ")" +
        (quota ? ": the browser's storage for this site is full" : ""), quota ? "no_space" : "io", !quota && !(e && e.name === "InvalidStateError"));
};

/**
 * @param {number} start
 * @param {number} length
 * @return {!Uint8Array}
 */
OpfsDisk.prototype.read_now = function(start, length)
{
    if(this.closed) throw disk_error(this.name + ": the disk is closed", "io", false);
    const data = new Uint8Array(length);
    this.access["read"](data, { "at": start });
    return data;
};

/**
 * @param {number} start
 * @param {number} length
 * @param {function((!Uint8Array|undefined), !Error=)} fn
 */
OpfsDisk.prototype.get = function(start, length, fn)
{
    let data;
    try { data = this.read_now(start, length); }
    catch(e) { fn(undefined, e["retryable"] === undefined ? this.io_error(e, "read") : e); return; }
    fn(data);
};

OpfsDisk.prototype.get_and_cache = OpfsDisk.prototype.get;

/**
 * (synchronous anyway)
 * @param {number} start
 * @param {number} length
 * @return {!Uint8Array|undefined}
 */
OpfsDisk.prototype.get_from_cache = function(start, length)
{
    try { return this.read_now(start, length); }
    catch(e) { return undefined; }
};

/**
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function(!Error=)} fn
 */
OpfsDisk.prototype.set = function(start, data, fn)
{
    if(this.closed)
    {
        fn(disk_error(this.name + ": the disk is closed", "io", false));
        return;
    }
    try
    {
        if(this.move_before_write)
        {
            // the session's first write, the first after a snapshot: the
            // generation moves on before the data changes
            this.record["generation"]++;
            this.save_record();
            this.move_before_write = false;
        }
        for(let done = 0; done < data.length;)
        {
            const n = this.access["write"](data.subarray(done), { "at": start + done });
            if(!n) throw new Error("nothing written");
            done += n;
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

/** @return {string} the image's generation now */
OpfsDisk.prototype.generation = function()
{
    return String(this.record["generation"]);
};

/** The timed flush (FLUSH_IDLE_MS after the last write, FLUSH_MAX_MS at most) */
OpfsDisk.prototype.schedule_flush = function()
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
};

/**
 * The writes completed before are durable
 * @param {function(!Error=)} fn
 */
OpfsDisk.prototype.flush = function(fn)
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
        this.access["flush"]();
    }
    catch(e)
    {
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
 * Flush and close (destroy(), the drive pulled out): the handles go, another tab may open the disk
 * @param {function(!Error=)} fn
 */
OpfsDisk.prototype.close = function(fn)
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

OpfsDisk.prototype.close_now = function()
{
    clearTimeout(this.flush_timer);
    this.flush_timer = 0;
    for(const access of [this.access, this.record_access])
    {
        if(access) try { access["close"](); } catch(e) {}
    }
    this.access = null;
    this.record_access = null;
    this.closed = true;
};

/**
 * Flush and record the generation, for a snapshot: the next write moves it on
 * @return {string}
 */
OpfsDisk.prototype.mark = function()
{
    let failed;
    this.flush(error => { failed = error; });
    if(failed) throw failed;
    this.move_before_write = true;
    return this.generation();
};

/** (no whole image in memory: export reads the file) */
OpfsDisk.prototype.get_buffer = function(fn)
{
    fn(undefined);
};

/**
 * A snapshot's reference: identity, generation, size; no data
 * @return {!Array<*>}
 */
OpfsDisk.prototype.get_state = function()
{
    const generation = this.mark();
    return [WRITEBACK_STATE, WRITEBACK_STATE_VERSION, JSON.stringify(this.identity), generation, this.byteLength];
};

/**
 * @param {*} state
 */
OpfsDisk.prototype.check_state = function(state)
{
    const name = this.name;
    if(!is_writeback_state(state))
    {
        throw new Error(state ?
            "The snapshot's disk " + name + " has its changes in memory (disk_option \"read_only\", or an older v86): " +
            "they are not written into the browser disk " + this.url :
            "The snapshot has no disk " + name + ", this machine writes back the browser disk " + this.url);
    }
    if(state[1] !== WRITEBACK_STATE_VERSION)
    {
        throw new Error("The snapshot's disk " + name + " has a reference of version " + state[1] + ", this v86 reads version " + WRITEBACK_STATE_VERSION);
    }
    const identity = JSON.parse(state[2]);
    const generation = this.generation();
    if(JSON.stringify(identity) !== JSON.stringify(this.identity) || state[3] !== generation || state[4] !== this.byteLength)
    {
        throw new Error("The snapshot's disk " + name + " is " + JSON.stringify(identity) + " in generation " + state[3] +
            "; this machine's is " + JSON.stringify(this.identity) + " in generation " + generation +
            " (a disk written to after the snapshot was saved cannot go back to it)");
    }
};

OpfsDisk.prototype.set_state = function(state)
{
    this.check_state(state);
    // (restored: the first write after it moves the generation on)
    this.move_before_write = true;
};
