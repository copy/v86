// A block device's backend (docs/arm64-virt-android16-plan.md P5.4): the
// image buffer (src/buffer.js) behind a disk controller, with what every
// controller needs from it: reads that a reset cancels, writes that a reset
// forgets, FLUSH after every write in flight is done, and each host
// operation counted as I/O a snapshot waits for (src/state_io.js). Writes go
// to the buffer, an in-memory overlay of the image: they last the session.
//
// The functions work on an owner with the fields init_block_io sets (and
// `cpu`, `buffer`): BlockBackend (virtio-blk) and IDEInterface (src/ide.js,
// also AHCI's drives) share them.

import { begin_state_io, track_state_io } from "./state_io.js";
import { dbg_assert } from "./log.js";

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
    owner.writes_in_flight = 0;
    /** @type {!Array<function()>} */
    owner.write_waiters = [];
}

/**
 * Read [start, start + length) of owner.buffer: `callback` gets the bytes (a
 * view the caller copies from), unless the read was cancelled first
 * @param {?} owner
 * @param {number} start
 * @param {number} length
 * @param {function(!Uint8Array)} callback
 */
export function block_read(owner, start, length, callback)
{
    const id = owner.last_io_id++;
    const abort = new AbortController();
    const complete = begin_state_io(owner.cpu);
    abort["snapshot_done"] = complete;
    owner.in_progress.set(id, abort);
    try
    {
        owner.buffer.get(start, length, data =>
        {
            complete();
            if(owner.cancelled.delete(id))
            {
                dbg_assert(!owner.in_progress.has(id));
                return;
            }
            const removed = owner.in_progress.delete(id);
            dbg_assert(removed);
            callback(data);
        }, { signal: abort.signal });
    }
    catch(error)
    {
        complete();
        owner.in_progress.delete(id);
        throw error;
    }
}

/**
 * Write `data` at `start`: `callback` when it is in the buffer, unless a
 * reset came first (the write itself still lands)
 * @param {?} owner
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function()} callback
 */
export function block_write(owner, start, data, callback)
{
    const epoch = owner.reset_epoch;
    owner.writes_in_flight++;
    track_state_io(owner.cpu, done => owner.buffer.set(start, data, done), () =>
    {
        owner.writes_in_flight--;
        if(epoch === owner.reset_epoch)
        {
            callback();
        }
        if(owner.writes_in_flight === 0)
        {
            const waiting = owner.write_waiters;
            owner.write_waiters = [];
            waiting.forEach(f => f());
        }
    });
}

/**
 * `callback` when no write is in flight any more and the buffer's own flush
 * (if it has one) is done: FLUSH
 * @param {?} owner
 * @param {function()} callback
 */
export function block_when_writes_done(owner, callback)
{
    const epoch = owner.reset_epoch;
    const flush = () =>
    {
        const finish = () => { if(epoch === owner.reset_epoch) callback(); };
        if(owner.buffer && typeof owner.buffer.flush === "function")
        {
            track_state_io(owner.cpu, done => owner.buffer.flush(done), finish);
        }
        else
        {
            finish();
        }
    };
    if(owner.writes_in_flight === 0)
    {
        flush();
    }
    else
    {
        owner.write_waiters.push(flush);
    }
}

/**
 * Reads in progress are cancelled (their callbacks never run)
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

BlockBackend.prototype.read = function(start, length, callback) { block_read(this, start, length, callback); };
BlockBackend.prototype.write = function(start, data, callback) { block_write(this, start, data, callback); };
BlockBackend.prototype.when_writes_done = function(callback) { block_when_writes_done(this, callback); };
BlockBackend.prototype.cancel_reads = function() { block_cancel_reads(this); };

/** A reset of the controller: nothing started before it completes */
BlockBackend.prototype.reset = function()
{
    this.reset_epoch++;
    this.cancel_reads();
};
