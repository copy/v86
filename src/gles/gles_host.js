// The GLES host (docs/gles-proxy-plan.md): the services a transport
// connects the guest to. Android's goldfish pipe (src/virt/goldfish.js)
// opens "opengles", one connection per GL thread (a GLESStream whose
// commands go to renderControl or to the GLES decoders), and
// "GLProcessPipe", one per process: it answers the guest library's
// confirmation (a u32, 100) with the process's unique id, which the
// process's connections then report with rcSetPuid; its closing is the
// process's end, when renderControl drops what the process had.
//
// A service: write(bytes) the guest's, read(max) the bytes it may read
// now (null: none yet), available() whether there are any, close().
// `wake` tells the transport that a service has bytes for the guest which
// it did not have when last asked.
//
// E1: GLES calls are answered by src/gles/gles_defaults.js, nothing is
// drawn; summary() counts the calls. A snapshot keeps nothing: the
// pipe's channels close on restore (E5 keeps the connections).

import { GLESStream } from "./gles_stream.js";
import { RenderControl } from "./render_control.js";
import { GLESDefaults } from "./gles_defaults.js";

/**
 * @constructor
 * @param {{width: number, height: number, dpi: number}} display
 */
export function GLESHost(display)
{
    this.rc = new RenderControl(display);
    this.reset();
}

GLESHost.prototype.reset = function()
{
    this.rc.reset();
    this.defaults = new GLESDefaults(this.rc);
    this.next_connection = 1;
    this.next_puid = 1;
    /** @type {!Set<!GLESStream>} */
    this.streams = new Set();
    /** what the closed connections counted */
    this.closed_counts = new Map();
    this.closed_unknown = new Map();
    this.closed_malformed = new Map();
    this.connections = 0;
    this.processes = 0;
};

/**
 * A service of a name, or null for one the host does not have
 * @param {string} name
 * @param {function()} wake
 * @return {?Object} {write, read, available, close}
 */
GLESHost.prototype.service = function(name, wake)
{
    if(name === "opengles") return this.connect(wake);
    if(name === "GLProcessPipe") return this.process_pipe();
    return null;
};

/** @param {function()} wake @return {!Object} a connection's service */
GLESHost.prototype.connect = function(wake)
{
    const conn = { id: this.next_connection++, puid: null, context: 0, draw: 0, read: 0 };
    const stream = new GLESStream((command, args) => command.api === "rc" ? this.rc.call(conn, command, args) :
        this.defaults.call(conn, command, args), wake);
    this.streams.add(stream);
    this.connections++;
    return {
        write: bytes => stream.write(bytes),
        read: max => stream.read(max),
        available: () => stream.output_bytes > 0,
        close: () =>
        {
            stream.close();
            this.streams.delete(stream);
            add_counts(this.closed_counts, stream.counts);
            add_counts(this.closed_unknown, stream.unknown);
            add_counts(this.closed_malformed, stream.malformed);
            this.rc.disconnect(conn);
        },
    };
};

/** @return {!Object} a process pipe's service */
GLESHost.prototype.process_pipe = function()
{
    let puid = null, reply = null;
    this.processes++;
    return {
        write: bytes =>
        {
            // (the confirmation, once: the reply is the process's id, a u64)
            if(puid !== null || bytes.length < 4) return;
            puid = this.next_puid++;
            reply = new Uint8Array(8);
            new DataView(reply.buffer).setUint32(0, puid, true);
        },
        read: max =>
        {
            if(!reply) return null;
            const bytes = reply.subarray(0, max);
            reply = bytes.length < reply.length ? reply.subarray(bytes.length) : null;
            return bytes;
        },
        available: () => reply !== null,
        close: () => { if(puid !== null) this.rc.release("p" + puid); },
    };
};

/** @param {!Map} into @param {!Map} from */
function add_counts(into, from)
{
    for(const [key, n] of from) into.set(key, (into.get(key) || 0) + n);
}

/**
 * What the connections decoded: calls by name, opcodes of no range,
 * commands that did not decode, and renderControl's objects
 * @return {!Object}
 */
GLESHost.prototype.summary = function()
{
    const counts = new Map(this.closed_counts), unknown = new Map(this.closed_unknown), malformed = new Map(this.closed_malformed);
    let dropped_bytes = 0, broken = 0;
    for(const stream of this.streams)
    {
        add_counts(counts, stream.counts);
        add_counts(unknown, stream.unknown);
        add_counts(malformed, stream.malformed);
        dropped_bytes += stream.dropped_bytes;
        if(stream.broken) broken++;
    }
    const sorted = map => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));
    return {
        connections: this.connections, open_connections: this.streams.size, processes: this.processes,
        counts: sorted(counts), unknown: sorted(unknown), malformed: sorted(malformed), broken, dropped_bytes,
        render_control: this.rc.summary(),
    };
};
