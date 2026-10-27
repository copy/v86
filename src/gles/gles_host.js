// The GLES host (docs/gles-proxy-plan.md): the services a transport
// connects the guest to. Android's goldfish pipe (src/virt/goldfish.js)
// opens "opengles", one connection per GL thread (a GLESStream whose
// commands go to renderControl or to the shadow state), and
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
// The page (E2): the shadow state (src/gles/gles_shadow.js) answers every
// query; what changes state goes into GLES batches (renderer_protocol.js's
// GLES records) for the renderer channel's stream "gles", in the guest's
// order across connections. A batch is sent at the guest's flush points: a
// frame (rcFlushWindowColorBuffer, rcFBPost), glFinish and glFlush (the
// encoder's glFinishRoundTrip), a sync wait, a read; and when it grows past
// FLUSH_BYTES. The calls that need only order are answered once their batch
// is sent; when more than MAX_IN_FLIGHT batches have not run, the frame's
// and glFinish's answers wait for the oldest (backpressure). Only reads
// (glReadPixels, rcReadColorBuffer) wait for the page's data. Without a
// renderer (or one lost), batches go nowhere and reads give zeros.
//
// A snapshot keeps nothing: the pipe's channels close on restore (E5 keeps
// the connections).

import { GLESStream } from "./gles_stream.js";
import { RenderControl } from "./render_control.js";
import { GLESShadow } from "./gles_shadow.js";
import { CONFIGS } from "./gles_caps.js";
import { GLES, GLES_MAGIC, GXWriter, READBACK_HEADER_BYTES, RESPONSE_OK } from "../graphics_adapters/renderer_protocol.js";

/** A batch this large is sent at once */
export const FLUSH_BYTES = 4 << 20;
/** Batches sent that the page may not have run before the frame's answer waits */
export const MAX_IN_FLIGHT = 2;

/**
 * @constructor
 * @param {{width: number, height: number, dpi: number}} display
 * @param {?{post: function(!Object, !Array=), listen: function(function(!Object))}} renderer the
 *     renderer channel (stream "gles"), or null
 * @param {function(!Uint8Array, number, number)=} present the screen's
 *     (the frames the page reads back when it shows them nowhere itself)
 */
export function GLESHost(display, renderer, present)
{
    /** the screen: a posted frame read back (RGBA rows from the top) */
    this.present = present || (() => {});
    this.rc = new RenderControl(display);
    this.rc.events = (kind, ...args) => this.on_event(kind, args);
    this.renderer = renderer;
    if(renderer) renderer.listen(message => this.receive(message));
    this.reset();
    if(renderer) renderer.post({ "type": "hello" });
}

GLESHost.prototype.reset = function()
{
    this.rc.reset();
    this.shadow = new GLESShadow(this.rc);
    this.writer = new GXWriter(GLES_MAGIC);
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
    this.submitted = 0;
    this.completed = 0;
    /** @type {!Array<{seq: number, run: function()}>} */
    this.completions = [];
    this.next_request = 1;
    /** @type {!Map<number, function(?Uint8Array)>} */
    this.requests = new Map();
    this.lost = !this.renderer;
    /** what went to the page, and what waited for it */
    this.stats = { batches: 0, bytes: 0, records: 0, refused: 0, reads: 0, throttled: 0, frames: 0 };
    /** @type {!Map<string, number>} refused calls by name and the error they left */
    this.refused = new Map();
    if(this.renderer) this.renderer.post({ "type": "reset" });
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
    const stream = new GLESStream((command, args, bytes) => command.api === "rc" ? this.rc_call(conn, command, args) :
        this.gl_call(conn, command, args, bytes), wake);
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
            this.record(GLES.CONNECTION_CLOSE, [conn.id]);
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

// ---- the calls

/** Whether a call only asks (or only names: glGen*): the shadow state answers it, nothing for the page */
function is_query(name)
{
    return /^gl(Get|Is|Gen|CheckFramebufferStatus|FinishRoundTrip)/.test(name);
}

/**
 * A GLES call: the shadow state answers; what it accepts and the page needs
 * is recorded. glReadPixels waits for the pixels, glFinish's answer (the
 * encoder's glFinishRoundTrip) for room among the batches in flight.
 */
GLESHost.prototype.gl_call = function(conn, command, args, bytes)
{
    const { ret, keep } = this.shadow.call(conn.context, command, args);
    if(command.name === "glReadPixels")
    {
        if(!keep) return ret;
        const [x, y, width, height, format, type, pixels] = args;
        const request = this.request(pixels);
        this.record(GLES.READ_PIXELS, [conn.id, request.id, x, y, width, height, format, type]);
        this.flush();
        return request.done;
    }
    if(keep) this.record(GLES.COMMAND, [conn.id, ret >>> 0, bytes.length], bytes);
    else if(!is_query(command.name))
    {
        // (which calls the rules refuse, and with what error: the guest's mistakes, or the shadow's)
        this.stats.refused++;
        const c = this.shadow.context(conn.context);
        const key = command.name + (c ? ":0x" + c.error.toString(16) : ":no context");
        this.refused.set(key, (this.refused.get(key) || 0) + 1);
    }
    switch(command.name)
    {
        case "glFinishRoundTrip":
            return this.throttle(ret);
        case "glFinish": case "glFlush":
            this.flush();
            break;
    }
    if(this.writer.size() > FLUSH_BYTES) this.flush();
    return ret;
};

/** renderControl's call, and what the page or the guest waits on */
GLESHost.prototype.rc_call = function(conn, command, args)
{
    if(command.name === "rcReadColorBuffer")
    {
        const [color_buffer, x, y, width, height, format, type, pixels] = args;
        if(!this.rc.color_buffers.has(color_buffer)) return undefined;
        const request = this.request(pixels);
        this.record(GLES.COLOR_BUFFER_READ, [color_buffer, x, y, width, height, format, type, request.id]);
        this.flush();
        return request.done;
    }
    const ret = this.rc.call(conn, command, args);
    switch(command.name)
    {
        case "rcFlushWindowColorBuffer":
        case "rcClientWaitSyncKHR":
            return this.throttle(ret);
        case "rcFlushWindowColorBufferAsync":
        case "rcFlushWindowColorBufferAsyncWithFrameNumber":
        case "rcFBPost":
        case "rcWaitSyncKHR":
            this.flush();
            break;
    }
    if(this.writer.size() > FLUSH_BYTES) this.flush();
    return ret;
};

/** renderControl's objects and frames: the shadow state follows, the page gets records */
GLESHost.prototype.on_event = function(kind, args)
{
    switch(kind)
    {
        case "context_create":
        {
            const [context, config, share, api] = args;
            this.shadow.create_context(context, api, share);
            this.record(GLES.CONTEXT_CREATE, [context, config, share, api]);
            break;
        }
        case "context_destroy":
            this.shadow.destroy_context(args[0]);
            this.record(GLES.CONTEXT_DESTROY, args);
            break;
        case "surface_create": this.record(GLES.SURFACE_CREATE, args); break;
        case "surface_destroy": this.record(GLES.SURFACE_DESTROY, args); break;
        case "surface_color_buffer": this.record(GLES.SURFACE_COLOR_BUFFER, args); break;
        case "make_current":
        {
            const [conn, context, draw, read] = args;
            const surface = this.rc.surfaces.get(draw);
            this.shadow.make_current(context, surface ? { width: surface.width, height: surface.height, config: CONFIGS[surface.config] } : null);
            this.record(GLES.MAKE_CURRENT, [conn.id, context, draw, read]);
            break;
        }
        case "color_buffer_create": this.record(GLES.COLOR_BUFFER_CREATE, args); break;
        case "color_buffer_destroy": this.record(GLES.COLOR_BUFFER_DESTROY, args); break;
        case "color_buffer_update":
        {
            const [color_buffer, x, y, width, height, format, type, pixels] = args;
            this.record(GLES.COLOR_BUFFER_UPDATE, [color_buffer, x, y, width, height, format, type, pixels.length], pixels);
            break;
        }
        case "bind":
        {
            const [conn, color_buffer, texture] = args;
            if(this.shadow.bind_color_buffer(conn.context, color_buffer, texture)) this.record(GLES.COLOR_BUFFER_BIND, [conn.id, color_buffer, +texture]);
            break;
        }
        case "image_create": this.record(GLES.IMAGE_CREATE, args); break;
        case "image_destroy": this.record(GLES.IMAGE_DESTROY, args); break;
        case "post": this.record(GLES.POST, args); break;
        case "flush_surface": this.record(GLES.FLUSH_SURFACE, args); break;
    }
};

// ---- batches

/**
 * @param {number} op
 * @param {!Array<number>} dwords
 * @param {Uint8Array=} bytes
 */
GLESHost.prototype.record = function(op, dwords, bytes)
{
    if(this.lost) return;
    this.writer.command(op, dwords.map(v => v >>> 0), bytes);
    this.stats.records++;
};

/** Send the batch being written */
GLESHost.prototype.flush = function()
{
    if(this.writer.empty()) return;
    const bytes = this.writer.finish();
    const seq = ++this.submitted;
    this.stats.batches++;
    this.stats.bytes += bytes.length;
    this.renderer.post({ "type": "submit", "seq": seq, "bytes": bytes, "stream": "gles" }, [bytes.buffer]);
};

/**
 * Send what was written; the answer, once no more than MAX_IN_FLIGHT
 * batches wait to run
 * @param {*} value
 * @return {*} the value, or a promise of it
 */
GLESHost.prototype.throttle = function(value)
{
    this.flush();
    if(this.submitted - this.completed <= MAX_IN_FLIGHT) return value;
    this.stats.throttled++;
    return new Promise(resolve => this.completions.push({ seq: this.submitted - MAX_IN_FLIGHT, run: () => resolve(value) }));
};

/**
 * A read the page answers: its id, and the promise of its answer (the
 * bytes into `out`, zeros if the page has none)
 * @param {!Object} out an OutBuffer
 * @return {{id: number, done: !Promise}}
 */
GLESHost.prototype.request = function(out)
{
    const id = this.next_request++;
    this.stats.reads++;
    if(this.lost) return { id, done: Promise.resolve(undefined) };
    const done = new Promise(resolve => this.requests.set(id, bytes =>
    {
        if(bytes) out.data.set(bytes.subarray(0, out.size));
        resolve(undefined);
    }));
    return { id, done };
};

/** @param {!Object} message from the renderer */
GLESHost.prototype.receive = function(message)
{
    switch(message["type"])
    {
        case "write":
        {
            const bytes = message["bytes"];
            if(bytes.length < READBACK_HEADER_BYTES) return;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const id = view.getUint32(0, true), count = view.getUint32(4, true), status = view.getUint32(12, true);
            const answer = this.requests.get(id);
            if(!answer) return;
            this.requests.delete(id);
            answer(status === RESPONSE_OK ? bytes.subarray(READBACK_HEADER_BYTES, READBACK_HEADER_BYTES + count) : null);
            break;
        }
        case "frame":
            this.stats.frames++;
            this.present(message["bytes"], message["width"], message["height"]);
            break;
        case "done":
            this.completed = Math.max(this.completed, message["seq"]);
            while(this.completions.length && this.completions[0].seq <= this.completed) this.completions.shift().run();
            break;
        case "lost":
            // (nothing waits for the page any more; nothing more goes to it)
            this.lost = true;
            console.warn("GLES: the renderer was lost: " + message["reason"]);
            this.completed = this.submitted;
            for(const answer of this.requests.values()) answer(null);
            this.requests.clear();
            while(this.completions.length) this.completions.shift().run();
            break;
    }
};

/** @param {!Map} into @param {!Map} from */
function add_counts(into, from)
{
    for(const [key, n] of from) into.set(key, (into.get(key) || 0) + n);
}

/**
 * What the connections decoded: calls by name, opcodes of no range,
 * commands that did not decode, renderControl's objects, the batches
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
        render_control: this.rc.summary(), batches: Object.assign({ submitted: this.submitted, completed: this.completed }, this.stats),
        shaders: this.shadow.stats, refused: sorted(this.refused),
    };
};
