// A block device's backend (docs/arm64-virt-android16-plan.md P5.4): the
// image buffer (src/buffer.js) behind a disk controller, with what every
// controller needs from it: reads that a reset cancels, writes that a reset
// forgets, FLUSH after the writes issued before it are done, and each host
// operation counted as I/O a snapshot waits for (src/state_io.js). Writes go
// to the buffer, an in-memory overlay of the image: they last the session
// (or a write-back backend's image: docs/disk-persistence-plan.md).
//
// The functions work on an owner with the fields init_block_io sets (and
// `cpu`, `buffer`): BlockBackend (virtio-blk) and IDEInterface (src/ide.js,
// also AHCI's drives) share them.
//
// A backend can fail a request (src/image/, docs/disk-image-formats-plan.md
// P0; docs/disk-persistence-plan.md "错误处理"): a read calls back with
// fn(undefined, error), a write or flush with fn(error). The disk's
// disk_error policy (the buffer's, src/disk_options.js) decides:
// - "report": the failure goes to the caller's on_error, and the controller
//   ends the command with its error status (IDE ERR/ABRT, AHCI NCQ
//   ncq_failed, virtio-blk IOERR);
// - "stop" (the default): the request stays unfinished and is held on the
//   CPU (cpu.disk_holds), the machine stops (cpu.stop_machine, v86's
//   stop()); run() retries the held requests in their order
//   (release_disk_holds), or reports those that cannot be retried;
//   destroy() and a restored snapshot drop them, as a power loss would.
// Either way a "disk-error" event tells the host: the disk, the operation,
// offset, length, the reason, whether it can be retried, the policy. A
// cancelled read, or a request a reset overtook, calls neither callback.

import { begin_state_io, track_state_io } from "./state_io.js";
import { LOG_DISK } from "./const.js";
import { dbg_assert, dbg_log } from "./log.js";

/**
 * The fields of an owner's block I/O
 * @param {?} owner
 */
export function init_block_io(owner)
{
    owner.last_io_id = 0;
    /** @type {!Map<number, !AbortController>} reads in progress */
    owner.in_progress = new Map();
    /** @type {!Set<number>} reads cancelled before they completed */
    owner.cancelled = new Set();
    /** a reset moves on: what was started before it does not complete */
    owner.reset_epoch = 0;
    /** writes not finished yet (in flight, or held after an error) */
    owner.writes_in_flight = 0;
    /** the sequence number of the last write issued */
    owner.write_seq = 0;
    /** @type {!Set<number>} the sequence numbers of the writes not finished yet */
    owner.writes_pending = new Set();
    /** @type {!Array<{upto: number, flush: function()}>} FLUSH: each waits for the writes up to its number */
    owner.flush_waiters = [];
}

/**
 * Whether a request that failed with this error can be tried again: an
 * error says so (`retryable`), a disk image's error by its kind (I/O errors
 * only, src/image/source.js), anything else can
 * @param {!Error} error
 * @return {boolean}
 */
export function is_retryable(error)
{
    if(typeof error["retryable"] === "boolean") return error["retryable"];
    const kind = /** @type {?} */ (error).kind;
    if(typeof kind === "string") return kind === "io";
    return true;
}

/**
 * A request the backend failed, by the disk's policy
 * @param {?} owner
 * @param {string} operation "read", "write" or "flush"
 * @param {number} start
 * @param {number} length
 * @param {!Error} error
 * @param {function()} retry starts the request again
 * @param {function(!Error)} report ends it with the error
 * @param {function()} drop forgets it (held, then destroy() or a restore)
 */
function block_failed(owner, operation, start, length, error, retry, report, drop)
{
    const buffer = owner.buffer;
    const policy = buffer && buffer.disk_error === "report" ? "report" : "stop";
    const retryable = is_retryable(error);
    const name = buffer && buffer.disk_name || owner.name || "disk";
    const cpu = owner.cpu;
    dbg_log(name + ": " + operation + " of " + length + " bytes at " + start + " failed (" + policy + "): " + error.message, LOG_DISK);
    const hold = policy === "stop" && cpu;
    if(hold)
    {
        (cpu.disk_holds || (cpu.disk_holds = [])).push({ owner, operation, retry, report, drop, error, retryable });
    }
    if(cpu && cpu.bus)
    {
        cpu.bus.send("disk-error", {
            "disk": name, "operation": operation, "offset": start, "length": length,
            "reason": error.message, "retryable": retryable, "policy": policy,
        });
    }
    if(hold)
    {
        cpu.stop_machine && cpu.stop_machine();
    }
    else
    {
        report(error);
    }
}

/**
 * Read [start, start + length) of owner.buffer: `callback` gets the bytes (a
 * view the caller copies from), or `on_error` the backend's error, unless
 * the read was cancelled first
 * @param {?} owner
 * @param {number} start
 * @param {number} length
 * @param {function(!Uint8Array)} callback
 * @param {function(!Error)} on_error
 */
export function block_read(owner, start, length, callback, on_error)
{
    const id = owner.last_io_id++;
    const attempt = () =>
    {
        const abort = new AbortController();
        const complete = begin_state_io(owner.cpu);
        abort["snapshot_done"] = complete;
        owner.in_progress.set(id, abort);
        try
        {
            owner.buffer.get(start, length, (data, error) =>
            {
                complete();
                if(owner.cancelled.delete(id))
                {
                    dbg_assert(!owner.in_progress.has(id));
                    return;
                }
                const removed = owner.in_progress.delete(id);
                dbg_assert(removed);
                if(error || !data)
                {
                    block_failed(owner, "read", start, length, error || new Error("the disk image returned no data"),
                        attempt, on_error, () => {});
                    return;
                }
                callback(data);
            }, { signal: abort.signal });
        }
        catch(error)
        {
            complete();
            owner.in_progress.delete(id);
            throw error;
        }
    };
    attempt();
}

/**
 * Write `data` at `start`: `callback` when it is in the buffer, or
 * `on_error` when the backend failed it, unless a reset came first (the
 * write itself still lands). A durable write (the guest turned the write
 * cache off, or FUA: docs/disk-persistence-plan.md "向客户机报告写缓存")
 * completes once the buffer's flush after it is done.
 * @param {?} owner
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function()} callback
 * @param {function(!Error)} on_error
 * @param {boolean=} durable
 */
export function block_write(owner, start, data, callback, on_error, durable)
{
    const epoch = owner.reset_epoch;
    const seq = ++owner.write_seq;
    owner.writes_in_flight++;
    owner.writes_pending.add(seq);
    const finish = () =>
    {
        owner.writes_in_flight--;
        owner.writes_pending.delete(seq);
        run_flush_waiters(owner);
    };
    const buffer = owner.buffer;
    const flush = durable && buffer && typeof buffer.flush === "function";
    const attempt = () =>
    {
        track_state_io(owner.cpu, done => buffer.set(start, data, error =>
        {
            if(error || !flush) done(error);
            else track_state_io(owner.cpu, flushed => buffer.flush(flushed), done);
        }), error =>
        {
            if(error)
            {
                block_failed(owner, "write", start, data.length, error, attempt, error =>
                {
                    if(epoch === owner.reset_epoch) on_error(error);
                    finish();
                }, finish);
                return;
            }
            if(epoch === owner.reset_epoch) callback();
            finish();
        });
    };
    attempt();
}

/**
 * The lowest sequence number of the writes not finished yet
 * @param {?} owner
 * @return {number}
 */
function oldest_pending_write(owner)
{
    let oldest = Infinity;
    for(const seq of owner.writes_pending) if(seq < oldest) oldest = seq;
    return oldest;
}

/** @param {?} owner */
function run_flush_waiters(owner)
{
    if(!owner.flush_waiters.length) return;
    const oldest = oldest_pending_write(owner);
    const ready = owner.flush_waiters.filter(waiter => waiter.upto < oldest);
    if(!ready.length) return;
    owner.flush_waiters = owner.flush_waiters.filter(waiter => waiter.upto >= oldest);
    ready.forEach(waiter => waiter.flush());
}

/**
 * FLUSH: `callback` when the writes issued before are finished and the
 * buffer's own flush (if it has one) is done; `on_error` when the flush
 * failed. Writes issued after it do not hold it up.
 * @param {?} owner
 * @param {function()} callback
 * @param {function(!Error)} on_error
 */
export function block_when_writes_done(owner, callback, on_error)
{
    const epoch = owner.reset_epoch;
    const upto = owner.write_seq;
    const flush = () =>
    {
        const attempt = () =>
        {
            if(owner.buffer && typeof owner.buffer.flush === "function")
            {
                track_state_io(owner.cpu, done => owner.buffer.flush(done), finish);
            }
            else
            {
                finish(undefined);
            }
        };
        const finish = error =>
        {
            if(error)
            {
                block_failed(owner, "flush", 0, 0, error, attempt, error =>
                {
                    if(epoch === owner.reset_epoch) on_error(error);
                }, () => {});
                return;
            }
            if(epoch === owner.reset_epoch) callback();
        };
        attempt();
    };
    if(oldest_pending_write(owner) > upto)
    {
        flush();
    }
    else
    {
        owner.flush_waiters.push({ upto, flush });
    }
}

/**
 * Reads in progress are cancelled (their callbacks never run), and so are
 * the reads and flushes held after an error (a held write still lands when
 * run() retries it, unanswered after a reset)
 * @param {?} owner
 */
export function block_cancel_reads(owner)
{
    for(const [id, abort] of owner.in_progress)
    {
        owner.cancelled.add(id);
        abort.abort();
        abort["snapshot_done"]?.();
    }
    owner.in_progress.clear();
    const cpu = owner.cpu;
    if(cpu && cpu.disk_holds && cpu.disk_holds.length)
    {
        cpu.disk_holds = cpu.disk_holds.filter(hold => hold.owner !== owner || hold.operation === "write");
    }
}

/**
 * The drive is gone (a SATA drive pulled out): its held requests are
 * dropped
 * @param {?} owner
 */
export function block_drop_holds(owner)
{
    const cpu = owner.cpu;
    if(!cpu || !cpu.disk_holds) return;
    const mine = cpu.disk_holds.filter(hold => hold.owner === owner);
    cpu.disk_holds = cpu.disk_holds.filter(hold => hold.owner !== owner);
    mine.forEach(hold => hold.drop());
}

/**
 * run(): the requests held after an error, in their order, are retried, or
 * ended with their error when they cannot be retried
 * @param {?} cpu
 * @return {number} how many there were
 */
export function release_disk_holds(cpu)
{
    const holds = cpu.disk_holds;
    if(!holds || !holds.length) return 0;
    cpu.disk_holds = [];
    for(const hold of holds)
    {
        if(hold.retryable) hold.retry();
        else hold.report(hold.error);
    }
    return holds.length;
}

/**
 * destroy(), or a restored snapshot: the held requests are dropped (as by a
 * power loss)
 * @param {?} cpu
 */
export function drop_disk_holds(cpu)
{
    const holds = cpu.disk_holds;
    if(!holds || !holds.length) return;
    cpu.disk_holds = [];
    holds.forEach(hold => hold.drop());
}

/**
 * A snapshot is refused while requests are held after an error: the state
 * would wait for I/O that does not end
 * @param {?} cpu
 */
export function check_no_disk_holds(cpu)
{
    const holds = cpu.disk_holds;
    if(holds && holds.length)
    {
        const hold = holds[0];
        const name = hold.owner.buffer && hold.owner.buffer.disk_name || hold.owner.name || "disk";
        throw new Error("The state is not saved: the disk " + name + " has " + holds.length + " request(s) held after an I/O error (" +
            hold.error.message + "); run() retries them, destroy() drops them");
    }
}

/**
 * A backend of its own (virtio-blk)
 * @constructor
 * @param {!Object} cpu (snapshot_io_pending)
 * @param {!Object} buffer get(start, length, fn, options), set(start, data, fn), byteLength
 */
export function BlockBackend(cpu, buffer)
{
    this.cpu = cpu;
    this.buffer = buffer;
    this.byte_length = buffer.byteLength;
    init_block_io(this);
}

BlockBackend.prototype.read = function(start, length, callback, on_error) { block_read(this, start, length, callback, on_error); };
/**
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function()} callback
 * @param {function(!Error)} on_error
 * @param {boolean=} durable
 */
BlockBackend.prototype.write = function(start, data, callback, on_error, durable) { block_write(this, start, data, callback, on_error, durable); };
BlockBackend.prototype.when_writes_done = function(callback, on_error) { block_when_writes_done(this, callback, on_error); };
BlockBackend.prototype.cancel_reads = function() { block_cancel_reads(this); };

/** A reset of the controller: nothing started before it completes */
BlockBackend.prototype.reset = function()
{
    this.reset_epoch++;
    this.cancel_reads();
};
