// A disk written back to a disk service (docs/disk-persistence-plan.md
// "磁盘协议": a server, or the local disk service on 127.0.0.1; the
// reference implementation is tools/disk-service.mjs): disk_option
// "read_write" with the service's URL. All requests go to the image's URL:
// reads are Range GETs, the rest POSTs with X-V86-Disk-Op (open, renew,
// write, flush, mark, close). The service answers the open with
// X-V86-Disk-Protocol; anything else (a static server) cannot be written
// back, and the start fails saying so.
// - A write completes when the service has it in the image; writes of
//   overlapping ranges go one after the other; a write is retried (with its
//   session, epoch and sequence number: the service applies it once) after
//   network errors and 5xx answers, at most 4 times, each attempt 30 s at
//   most; the block layer's held retry (disk_error "stop") reuses them too.
// - The session's lease is renewed every third of it; a lost lease (another
//   writer took the image over) fails what follows, not to be retried.
// - Reads: a cache of 4 KiB blocks (16 MiB at most, the least recently used
//   go); a write updates the cached blocks before it completes, and a read
//   is cached only if no write to its blocks completed since it began.
// - flush: the service's fdatasync; the timed flush as for local files (1 s
//   after the last write, 5 s at most).
// - Snapshots: prepare_snapshot (flush, mark: the generation recorded),
//   then get_state gives the reference (identity: the URL and the
//   service's UUID of the image; generation; size).

import { WRITEBACK_STATE, WRITEBACK_STATE_VERSION, FLUSH_IDLE_MS, FLUSH_MAX_MS, disk_error, is_writeback_state } from "./disk_writeback.js";
import { dbg_log } from "./log.js";
import { LOG_DISK } from "./const.js";

const SECTOR_SIZE = 512;
const CACHE_BLOCK = 4096;
const CACHE_BLOCKS = 4096;
const ATTEMPTS = 4;
const ATTEMPT_MS = 30000;

/**
 * @constructor
 * @param {string} url
 * @param {{name: string, token: (string|undefined), size: (number|undefined)}} options
 */
export function DiskServiceDisk(url, options)
{
    this.url = url;
    this.name = options.name;
    this.token = options.token;
    this.expected_size = options.size;
    /** @type {number} */
    this.byteLength = 0;
    this.writeback = true;
    this.session = "";
    this.epoch = 0;
    this.lease_ms = 0;
    this.lease_lost = false;
    this.closed = false;
    /** @type {!Object} */
    this.identity = {};
    this.generation_known = "";
    /** the generation prepare_snapshot recorded, until the next write */
    this.marked = null;
    this.sequence = 0;
    /** @type {!WeakMap<!Uint8Array, number>} a failed write's sequence number, for its retry */
    this.retry_sequence = new WeakMap();
    /** @type {!Array<{start: number, end: number, done: !Promise<undefined>}>} writes in flight */
    this.writing = [];
    /** @type {!Map<number, !Uint8Array>} cached blocks, least recently used first */
    this.cache = new Map();
    /** @type {!Map<number, number>} the completion number of the last write to a block */
    this.block_written = new Map();
    this.writes_completed = 0;
    this.dirty_since = 0;
    this.flush_timer = 0;
    this.renew_timer = 0;
    this.flushes = 0;
    this.flush_requests = 0;
    this.writes = 0;
    this.requests = 0;
    this.onload = undefined;
    this.onprogress = undefined;
}

/**
 * The headers of a session's request
 * @param {string} op
 * @return {!Object<string, string>}
 */
DiskServiceDisk.prototype.headers = function(op)
{
    const headers = { "X-V86-Disk-Op": op };
    if(this.session)
    {
        headers["X-V86-Disk-Session"] = this.session;
        headers["X-V86-Disk-Epoch"] = String(this.epoch);
    }
    if(this.token) headers["Authorization"] = "Bearer " + this.token;
    return headers;
};

/**
 * One request, with its timeout; network errors and 5xx answers (but 507)
 * are tried again
 * @param {string} what
 * @param {!Object} init fetch's
 * @param {number=} attempts
 * @return {!Promise<!Response>}
 */
DiskServiceDisk.prototype.request = async function(what, init, attempts = ATTEMPTS)
{
    let last;
    for(let attempt = 0; attempt < attempts; attempt++)
    {
        if(attempt) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), ATTEMPT_MS);
        const signal = init.signal;
        const forward = () => abort.abort();
        signal && signal.addEventListener("abort", forward, { once: true });
        this.requests++;
        try
        {
            const response = await fetch(this.url, { ...init, signal: abort.signal, cache: "no-store" });
            if(response.status >= 500 && response.status !== 507 && attempt + 1 < attempts)
            {
                last = disk_error(this.name + ": the " + what + " got HTTP status " + response.status, "io", true);
                continue;
            }
            return response;
        }
        catch(e)
        {
            if(signal && signal.aborted) throw e;
            last = disk_error(this.name + ": the " + what + " at " + this.url + " failed (" +
                (abort.signal.aborted ? "no answer in " + ATTEMPT_MS / 1000 + " s" : e.message) + ")", "io", true);
        }
        finally
        {
            clearTimeout(timer);
            signal && signal.removeEventListener("abort", forward);
        }
    }
    throw last;
};

/**
 * A refusal of the service as an error (not to be retried)
 * @param {!Response} response
 * @param {string} what
 * @return {!Promise<!Error>}
 */
DiskServiceDisk.prototype.refusal = async function(response, what)
{
    let body = {};
    try { body = await response.json(); } catch(e) {}
    const code = body["code"] || "";
    if(code === "lease" || code === "epoch") this.lease_lost = true;
    const kind = code === "no_space" ? "no_space" : code === "lease" || code === "epoch" ? "lease" : "io";
    return disk_error(this.name + ": the " + what + " was refused (HTTP " + response.status + (body["error"] ? ": " + body["error"] : "") + ")" +
        (kind === "lease" ? "; another session writes the image now" : ""), kind, false);
};

DiskServiceDisk.prototype.load = async function()
{
    const keep = " Without disk_option (or with \"read_only\"), the guest's changes stay in memory.";
    let response;
    try
    {
        response = await this.request("open", { method: "POST", headers: this.headers("open") }, 1);
    }
    catch(e)
    {
        throw disk_error(this.name + ": the disk service at " + this.url + " cannot be reached, or does not let this page use it " +
            "(CORS: the service needs this page's origin, tools/disk-service.mjs --origin): " + e.message + "." + keep, "config", false);
    }
    if(!response.headers.get("X-V86-Disk-Protocol"))
    {
        throw disk_error(this.name + "'s URL can only be read, not written back (" + this.url + " is not a disk service: HTTP " +
            response.status + "). To keep the changes, use a disk service that supports writing (tools/disk-service.mjs), " +
            "or omit disk_option to keep the changes in memory.", "config", false);
    }
    if(!response.ok)
    {
        const error = await this.refusal(response, "open");
        /** @type {?} */ (error).kind = "config";
        throw error;
    }
    const answer = await response.json();
    const size = answer["size"];
    if(!Number.isSafeInteger(size) || size % SECTOR_SIZE || answer["sector_size"] !== SECTOR_SIZE)
    {
        await this.close_session();
        throw disk_error(this.name + ": the disk service's image has " + size + " bytes in sectors of " + answer["sector_size"] +
            ": not a whole number of 512-byte sectors", "config", false);
    }
    if(this.expected_size !== undefined && this.expected_size !== size)
    {
        await this.close_session();
        throw disk_error(this.name + ": the disk service's image has " + size + " bytes, the descriptor's size says " + this.expected_size, "config", false);
    }
    this.byteLength = size;
    this.session = answer["session"];
    this.epoch = answer["epoch"];
    this.lease_ms = answer["lease_ms"];
    this.generation_known = String(answer["generation"]);
    this.identity = { "url": this.url, "uuid": answer["identity"]["uuid"] };
    this.schedule_renew();
    this.onload && this.onload(Object.create(null));
};

/** (a start that fails after the open) */
DiskServiceDisk.prototype.close_session = async function()
{
    try { await this.request("close", { method: "POST", headers: this.headers("close") }, 1); } catch(e) {}
};

DiskServiceDisk.prototype.schedule_renew = function()
{
    clearTimeout(this.renew_timer);
    if(this.closed || this.lease_lost) return;
    this.renew_timer = setTimeout(async () =>
    {
        try
        {
            const response = await this.request("renew", { method: "POST", headers: this.headers("renew") });
            if(!response.ok) dbg_log((await this.refusal(response, "lease renewal")).message, LOG_DISK);
        }
        catch(e)
        {
            dbg_log(e.message, LOG_DISK);
        }
        this.schedule_renew();
    }, Math.max(1, this.lease_ms / 3));
    this.renew_timer && this.renew_timer.unref && this.renew_timer.unref();
};

/**
 * @param {number} start
 * @param {number} length
 * @return {!Uint8Array|undefined} the cached data, if all of it is
 */
DiskServiceDisk.prototype.get_from_cache = function(start, length)
{
    const first = Math.floor(start / CACHE_BLOCK), last = Math.floor((start + length - 1) / CACHE_BLOCK);
    for(let b = first; b <= last; b++) if(!this.cache.has(b)) return undefined;
    const data = new Uint8Array(length);
    for(let b = first; b <= last; b++)
    {
        const block = /** @type {!Uint8Array} */ (this.cache.get(b));
        // (least recently used first)
        this.cache.delete(b);
        this.cache.set(b, block);
        const from = Math.max(start, b * CACHE_BLOCK), to = Math.min(start + length, (b + 1) * CACHE_BLOCK);
        data.set(block.subarray(from - b * CACHE_BLOCK, to - b * CACHE_BLOCK), from - start);
    }
    return data;
};

/**
 * @param {number} start
 * @param {number} length
 * @param {function((!Uint8Array|undefined), !Error=)} fn
 * @param {{signal: (AbortSignal|undefined)}=} options
 */
DiskServiceDisk.prototype.get = function(start, length, fn, options)
{
    const cached = this.get_from_cache(start, length);
    if(cached)
    {
        fn(cached);
        return;
    }
    if(this.closed || this.lease_lost)
    {
        fn(undefined, disk_error(this.name + ": " + (this.closed ? "the disk is closed" : "the session's lease is lost"), "io", false));
        return;
    }
    // (whole cache blocks, inside the image)
    const from = Math.floor(start / CACHE_BLOCK) * CACHE_BLOCK;
    const to = Math.min(this.byteLength, Math.ceil((start + length) / CACHE_BLOCK) * CACHE_BLOCK);
    const began = this.writes_completed;
    const signal = options && options.signal;
    const headers = this.headers("read");
    delete headers["X-V86-Disk-Op"];
    headers["Range"] = "bytes=" + from + "-" + (to - 1);
    this.request("read", { method: "GET", headers, signal }).then(async response =>
    {
        const range = response.headers.get("Content-Range") || "";
        const data = new Uint8Array(await response.arrayBuffer());
        if(response.status !== 206 || range !== "bytes " + from + "-" + (to - 1) + "/" + this.byteLength || data.length !== to - from)
        {
            throw disk_error(this.name + ": the read of " + (to - from) + " bytes at " + from + " got HTTP " + response.status +
                ", Content-Range " + JSON.stringify(range) + ", " + data.length + " bytes", "io", response.status >= 500 || response.status === 206);
        }
        if(signal && signal.aborted) return;
        for(let b = from / CACHE_BLOCK; b * CACHE_BLOCK < to; b++)
        {
            // (a write that completed since the read began has newer data)
            if((this.block_written.get(b) || 0) > began) continue;
            if((b + 1) * CACHE_BLOCK > to) continue;
            this.cache.delete(b);
            this.cache.set(b, data.slice(b * CACHE_BLOCK - from, (b + 1) * CACHE_BLOCK - from));
            if(this.cache.size > CACHE_BLOCKS) this.cache.delete(this.cache.keys().next().value);
        }
        fn(data.subarray(start - from, start - from + length));
    }).catch(error =>
    {
        if(signal && signal.aborted) return;
        fn(undefined, /** @type {!Error} */ (error));
    });
};

DiskServiceDisk.prototype.get_and_cache = DiskServiceDisk.prototype.get;

/**
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function(!Error=)} fn
 */
DiskServiceDisk.prototype.set = function(start, data, fn)
{
    if(this.closed || this.lease_lost)
    {
        fn(disk_error(this.name + ": " + (this.closed ? "the disk is closed" : "the session's lease is lost: another session writes the image now"), "lease", false));
        return;
    }
    const end = start + data.length;
    // (a retry has the sequence number of the write it repeats)
    const sequence = this.retry_sequence.get(data) || ++this.sequence;
    const before = this.writing.filter(w => w.start < end && start < w.end).map(w => w.done);
    let finished;
    const entry = { start, end, done: new Promise(resolve => { finished = resolve; }) };
    this.writing.push(entry);
    const complete = error =>
    {
        this.writing.splice(this.writing.indexOf(entry), 1);
        finished();
        if(error)
        {
            if(error["retryable"]) this.retry_sequence.set(data, sequence);
            fn(error);
            return;
        }
        this.retry_sequence.delete(data);
        // (the cache first, then the completion)
        const completion = ++this.writes_completed;
        for(let b = Math.floor(start / CACHE_BLOCK); b * CACHE_BLOCK < end; b++)
        {
            this.block_written.set(b, completion);
            const block = this.cache.get(b);
            if(!block) continue;
            const from = Math.max(start, b * CACHE_BLOCK), to = Math.min(end, (b + 1) * CACHE_BLOCK);
            block.set(data.subarray(from - start, to - start), from - b * CACHE_BLOCK);
        }
        this.marked = null;
        this.writes++;
        this.schedule_flush();
        fn(undefined);
    };
    Promise.all(before).then(async () =>
    {
        const headers = this.headers("write");
        headers["X-V86-Disk-Sequence"] = String(sequence);
        headers["X-V86-Disk-Offset"] = String(start);
        headers["Content-Type"] = "application/octet-stream";
        const response = await this.request("write", { method: "POST", headers, body: data });
        if(!response.ok) throw await this.refusal(response, "write of " + data.length + " bytes at " + start);
        this.generation_known = String((await response.json())["generation"]);
    }).then(() => complete(undefined), error => complete(error));
};

DiskServiceDisk.prototype.schedule_flush = function()
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
    this.flush_timer && this.flush_timer.unref && this.flush_timer.unref();
};

/**
 * One of the service's operations without data (flush, mark, close)
 * @param {string} op
 * @param {function(!Error=)} fn
 */
DiskServiceDisk.prototype.operation = function(op, fn)
{
    this.request(op, { method: "POST", headers: this.headers(op) }).then(async response =>
    {
        if(!response.ok) throw await this.refusal(response, op);
        this.generation_known = String((await response.json())["generation"]);
    }).then(() => fn(undefined), error => fn(/** @type {!Error} */ (error)));
};

/**
 * The writes completed before are durable
 * @param {function(!Error=)} fn
 */
DiskServiceDisk.prototype.flush = function(fn)
{
    this.flush_requests++;
    if(this.closed || !this.dirty_since)
    {
        fn(undefined);
        return;
    }
    if(this.lease_lost)
    {
        fn(disk_error(this.name + ": the session's lease is lost", "lease", false));
        return;
    }
    clearTimeout(this.flush_timer);
    this.flush_timer = 0;
    // (writes completed while the flush is on its way are not covered by it)
    const writes = this.writes;
    this.operation("flush", error =>
    {
        if(!error)
        {
            this.flushes++;
            if(this.writes === writes) this.dirty_since = 0;
        }
        fn(error);
    });
};

/**
 * Before a snapshot (the machine stopped, its disk I/O done): flush, and
 * the generation the snapshot records
 * @param {function(!Error=)} fn
 */
DiskServiceDisk.prototype.prepare_snapshot = function(fn)
{
    const writes = this.writes;
    this.operation("mark", error =>
    {
        if(!error)
        {
            this.marked = this.generation_known;
            if(this.writes === writes) this.dirty_since = 0;
        }
        fn(error);
    });
};

/** @return {string} */
DiskServiceDisk.prototype.generation = function()
{
    return this.generation_known;
};

/** (synchronous: what prepare_snapshot recorded) */
DiskServiceDisk.prototype.mark = function()
{
    if(this.marked === null)
    {
        throw new Error(this.name + ": a snapshot of a disk written back to a disk service needs it flushed first (V86.save_state does it)");
    }
    return this.marked;
};

DiskServiceDisk.prototype.get_state = function()
{
    return [WRITEBACK_STATE, WRITEBACK_STATE_VERSION, JSON.stringify(this.identity), this.mark(), this.byteLength];
};

/**
 * @param {*} state
 */
DiskServiceDisk.prototype.check_state = function(state)
{
    const name = this.name;
    if(!is_writeback_state(state))
    {
        throw new Error(state ?
            "The snapshot's disk " + name + " has its changes in memory (disk_option \"read_only\", or an older v86): " +
            "they are not written into " + this.url + ", which this machine writes back" :
            "The snapshot has no disk " + name + ", this machine writes back " + this.url);
    }
    if(state[1] !== WRITEBACK_STATE_VERSION)
    {
        throw new Error("The snapshot's disk " + name + " has a reference of version " + state[1] + ", this v86 reads version " + WRITEBACK_STATE_VERSION);
    }
    if(state[2] !== JSON.stringify(this.identity) || state[3] !== this.generation_known || state[4] !== this.byteLength)
    {
        throw new Error("The snapshot's disk " + name + " is " + state[2] + " in generation " + state[3] + "; this machine's is " +
            JSON.stringify(this.identity) + " in generation " + this.generation_known +
            " (an image written to after the snapshot was saved cannot go back to it)");
    }
};

DiskServiceDisk.prototype.set_state = function(state)
{
    this.check_state(state);
    this.cache.clear();
};

/** (no whole image in memory: export reads the service) */
DiskServiceDisk.prototype.get_buffer = function(fn)
{
    fn(undefined);
};

/**
 * Flush and close the session (destroy(), the drive pulled out)
 * @param {function(!Error=)} fn
 */
DiskServiceDisk.prototype.close = function(fn)
{
    if(this.closed)
    {
        fn(undefined);
        return;
    }
    clearTimeout(this.flush_timer);
    clearTimeout(this.renew_timer);
    Promise.all(this.writing.map(w => w.done)).then(() =>
    {
        this.closed = true;
        if(this.lease_lost) { fn(undefined); return; }
        this.operation("close", fn);
    });
};

/** (a start that failed later: the session is given up) */
DiskServiceDisk.prototype.close_now = function()
{
    if(this.closed) return;
    this.closed = true;
    clearTimeout(this.flush_timer);
    clearTimeout(this.renew_timer);
    if(this.session) this.close_session();
};

/** The page goes away (pagehide): close the session, as far as the browser still sends it */
DiskServiceDisk.prototype.close_keepalive = function()
{
    if(this.closed || this.lease_lost || !this.session) return;
    this.closed = true;
    clearTimeout(this.flush_timer);
    clearTimeout(this.renew_timer);
    try { fetch(this.url, { method: "POST", headers: this.headers("close"), keepalive: true }).catch(() => {}); }
    catch(e) {}
};
