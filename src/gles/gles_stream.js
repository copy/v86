// One connection to the GLES host (docs/gles-proxy-plan.md "协议与生成器",
// E1): the guest's bytes as they come (a pipe's writes, split anywhere),
// a u32 of client flags first (gfxstream's host/RenderThread.cpp reads it
// and drops it), then commands, each an opcode and a total size (u32 each,
// the 8 bytes included) and its parameters. A whole command goes to the
// decoder of its opcode's range (renderControl's, GLESv1's, GLESv2's:
// src/gles/gles_protocol.js), whose reply joins the bytes the guest reads.
//
// A decoder may answer later (a promise: data the page has to give back,
// E2): the stream decodes nothing after that command until the answer is
// there, so the replies keep the commands' order. An opcode of no range
// is counted and skipped (its size is in its header); so is a command whose
// parameters do not fill it (a layout the guest's encoder disagrees with).
// A size below 8 or above MAX_COMMAND breaks the stream: nothing after it
// can be found, the rest of the connection is dropped and counted.

import { command_of_opcode, decode_arguments, encode_reply, has_reply } from "./gles_wire.js";

/** The largest command: a 4096 by 4096 RGBA texture, with room */
export const MAX_COMMAND = 80 << 20;

/**
 * @constructor
 * @param {function(!Object, !Array<*>, !Uint8Array): *} decode the
 *     decoders: a command ({api, opcode, name, ...}: gles_wire.js), its
 *     arguments (out pointers to fill) and its bytes to the return value, or
 *     a promise of it
 * @param {function()=} readable called when a reply that waited is there
 */
export function GLESStream(decode, readable)
{
    this.decode = decode;
    this.readable = readable || (() => {});
    /** the client flags (null until the guest wrote them) */
    this.flags = null;
    this.header = new Uint8Array(8);
    this.header_fill = 0;
    /** @type {?Uint8Array} the command being put together */
    this.command = null;
    this.command_fill = 0;
    /** @type {!Array<!Uint8Array>} what the guest wrote while a reply waited */
    this.backlog = [];
    this.waiting = false;
    /** @type {!Array<!Uint8Array>} the replies the guest has not read */
    this.output = [];
    this.output_bytes = 0;
    this.broken = false;
    this.closed = false;
    /** @type {!Map<string, number>} commands decoded, by name */
    this.counts = new Map();
    /** @type {!Map<number, number>} opcodes of no range, and how often */
    this.unknown = new Map();
    /** @type {!Map<string, number>} commands whose parameters did not fill them */
    this.malformed = new Map();
    /** @type {!Map<string, number>} commands whose decoder failed (answered with zeros) */
    this.failed = new Map();
    this.dropped_bytes = 0;
}

/** @param {!Uint8Array} bytes the guest's (copied where kept) */
GLESStream.prototype.write = function(bytes)
{
    if(this.closed) return;
    if(this.broken)
    {
        this.dropped_bytes += bytes.length;
        return;
    }
    if(this.waiting)
    {
        this.backlog.push(bytes.slice());
        return;
    }
    let at = 0;
    while(at < bytes.length && !this.waiting && !this.broken)
    {
        if(!this.command)
        {
            // the flags word, then a command's header
            const want = this.flags === null ? 4 : 8;
            const n = Math.min(want - this.header_fill, bytes.length - at);
            this.header.set(bytes.subarray(at, at + n), this.header_fill);
            this.header_fill += n;
            at += n;
            if(this.header_fill < want) break;
            this.header_fill = 0;
            const view = new DataView(this.header.buffer);
            if(this.flags === null)
            {
                this.flags = view.getUint32(0, true);
                continue;
            }
            const size = view.getUint32(4, true);
            if(size < 8 || size > MAX_COMMAND)
            {
                this.broken = true;
                this.dropped_bytes += bytes.length - at;
                console.warn(`GLES stream: a command of ${size} bytes (opcode ${view.getUint32(0, true)}): the rest of the connection is dropped`);
                break;
            }
            this.command = new Uint8Array(size);
            this.command.set(this.header);
            this.command_fill = 8;
        }
        const n = Math.min(this.command.length - this.command_fill, bytes.length - at);
        this.command.set(bytes.subarray(at, at + n), this.command_fill);
        this.command_fill += n;
        at += n;
        if(this.command_fill === this.command.length)
        {
            const command = this.command;
            this.command = null;
            this.dispatch(command);
        }
    }
    if(at < bytes.length && this.waiting) this.backlog.push(bytes.slice(at));
};

/** @param {!Uint8Array} bytes a whole command */
GLESStream.prototype.dispatch = function(bytes)
{
    const opcode = bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
    const command = command_of_opcode(opcode >>> 0);
    if(!command)
    {
        this.unknown.set(opcode >>> 0, (this.unknown.get(opcode >>> 0) || 0) + 1);
        return;
    }
    this.counts.set(command.name, (this.counts.get(command.name) || 0) + 1);
    let args;
    try
    {
        args = decode_arguments(command, bytes);
    }
    catch(e)
    {
        if(!this.malformed.has(command.name)) console.warn("GLES stream: " + e.message);
        this.malformed.set(command.name, (this.malformed.get(command.name) || 0) + 1);
        return;
    }
    // (a fault of a decoder: the call is answered with zeros, counted, the stream goes on)
    let ret;
    try
    {
        ret = this.decode(command, args, bytes);
    }
    catch(e)
    {
        if(!this.failed.has(command.name)) console.warn("GLES stream: " + command.name + " failed: " + (e && e.stack || e));
        this.failed.set(command.name, (this.failed.get(command.name) || 0) + 1);
        ret = 0;
    }
    if(ret && typeof ret.then === "function")
    {
        this.waiting = true;
        ret.then(value =>
        {
            if(this.closed) return;
            this.reply(command, args, value);
            this.waiting = false;
            const backlog = this.backlog;
            this.backlog = [];
            for(const chunk of backlog) this.write(chunk);
            this.readable();
        });
        return;
    }
    this.reply(command, args, ret);
};

GLESStream.prototype.reply = function(command, args, ret)
{
    if(!has_reply(command)) return;
    const reply = encode_reply(command, args, ret);
    if(!reply) return;
    this.output.push(reply);
    this.output_bytes += reply.length;
};

/**
 * The replies' bytes the guest reads next, at most `max`
 * @param {number} max
 * @return {?Uint8Array} null when there are none
 */
GLESStream.prototype.read = function(max)
{
    if(!this.output_bytes || max <= 0) return null;
    const first = this.output[0];
    if(first.length <= max && (this.output.length === 1 || first.length === max))
    {
        this.output.shift();
        this.output_bytes -= first.length;
        return first;
    }
    const n = Math.min(max, this.output_bytes);
    const bytes = new Uint8Array(n);
    let at = 0;
    while(at < n)
    {
        const chunk = this.output[0];
        const take = Math.min(chunk.length, n - at);
        bytes.set(chunk.subarray(0, take), at);
        at += take;
        if(take === chunk.length) this.output.shift();
        else this.output[0] = chunk.subarray(take);
    }
    this.output_bytes -= n;
    return bytes;
};

/** The guest closed the connection: what waited is dropped */
GLESStream.prototype.close = function()
{
    this.closed = true;
    this.backlog = [];
    this.output = [];
    this.output_bytes = 0;
};

/**
 * What a snapshot keeps (gles_snapshot.js's packing): the bytes of a
 * header or command not whole yet, the replies not read; nothing may wait
 * (the GLES host's prepare_save answered every call first)
 * @return {!Object}
 */
GLESStream.prototype.get_state = function()
{
    const output = new Uint8Array(this.output_bytes);
    let at = 0;
    for(const chunk of this.output) { output.set(chunk, at); at += chunk.length; }
    return {
        flags: this.flags, header: this.header.slice(), header_fill: this.header_fill,
        command: this.command && this.command.slice(0, this.command_fill), command_size: this.command ? this.command.length : 0,
        output, broken: this.broken, dropped_bytes: this.dropped_bytes,
        counts: this.counts, unknown: this.unknown, malformed: this.malformed, failed: this.failed, waiting: this.waiting || this.backlog.length > 0,
    };
};

/** @param {!Object} state get_state's */
GLESStream.prototype.set_state = function(state)
{
    this.flags = state.flags;
    this.header.set(state.header);
    this.header_fill = state.header_fill;
    this.command = null;
    this.command_fill = 0;
    if(state.command_size)
    {
        this.command = new Uint8Array(state.command_size);
        this.command.set(state.command);
        this.command_fill = state.command.length;
    }
    this.output = state.output.length ? [state.output] : [];
    this.output_bytes = state.output.length;
    this.broken = state.broken;
    this.dropped_bytes = state.dropped_bytes;
    this.counts = state.counts;
    this.unknown = state.unknown;
    this.malformed = state.malformed;
    this.failed = state.failed || new Map();
    // (a call that waited when the snapshot was taken has no answer: the
    // connection cannot go on, as one whose commands could not be found)
    if(state.waiting)
    {
        this.broken = true;
        console.warn("GLES stream: the snapshot was taken while a call waited for the page: the connection is dropped");
    }
};
