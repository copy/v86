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
// A snapshot (E5) keeps renderControl's objects, the shadow state and
// each connection (its context and surfaces, the bytes of a command not
// whole yet, the replies not read: the pipe's channel keeps its service's
// state, src/virt/goldfish.js); prepare_save first answers every call that
// waits for the page, then fetches the page's state (the executor's
// objects and the GPU's contents, read back: "gles_save"). A restore resets
// the page and gives it that state back ("gles_restore"), on whatever
// renderer the machine has now. No graphics journal is replayed.

import { pack_program } from "./glsl_program.js";
import { GLESStream } from "./gles_stream.js";
import { RenderControl } from "./render_control.js";
import { CONFIGS } from "./gles_caps.js";
import { GLESShadow, SHADOW_CLASSES } from "./gles_shadow.js";
import { pack, shadow_skip, unpack } from "./gles_snapshot.js";
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
export function GLESHost(display, renderer, present, options)
{
    /** glslang (the plugin's prepare) and the highest version announced (docs/gles3-plan.md) */
    this.options = options || {};
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
    this.rc.max_version = { "3.0": 30, "3.1": 31, "3.2": 32 }[this.options.max_version] || 20;
    this.shadow = new GLESShadow(this.rc);
    this.shadow.glslang = this.options.glslang || null;
    // (buffers' bytes on the CPU side: glMapBufferRange's answers, docs/gles3-plan.md)
    this.shadow.keep_bytes = true;
    this.writer = new GXWriter(GLES_MAGIC);
    this.next_connection = 1;
    this.next_puid = 1;
    /** @type {!Set<!GLESStream>} */
    this.streams = new Set();
    /** what the closed connections counted */
    this.closed_counts = new Map();
    this.closed_unknown = new Map();
    this.closed_malformed = new Map();
    this.closed_failed = new Map();
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
    /** @type {!Map<number, function(*)>} the page's states asked for (prepare_save) */
    this.saves = new Map();
    this.page_state = null;
    /** what went to the page, and what waited for it */
    this.stats = { batches: 0, bytes: 0, records: 0, refused: 0, reads: 0, throttled: 0, frames: 0, cpu_ms: 0 };
    /** @type {!Map<string, number>} refused calls by name and the error they left */
    this.refused = new Map();
    if(this.renderer) this.renderer.post({ "type": "reset" });
};

/**
 * A service of a name, or null for one the host does not have
 * @param {string} name
 * @param {function()} wake
 * @param {*=} saved the service's state in a snapshot (its get_state's)
 * @return {?Object} {write, read, available, close, get_state}
 */
GLESHost.prototype.service = function(name, wake, saved)
{
    if(name === "opengles") return this.connect(wake, saved);
    if(name === "GLProcessPipe") return this.process_pipe(saved);
    return null;
};

/** @param {function()} wake @param {*=} saved @return {!Object} a connection's service */
GLESHost.prototype.connect = function(wake, saved)
{
    const state = saved ? unpack(saved) : null;
    const conn = state ? state.conn : { id: this.next_connection++, puid: null, context: 0, draw: 0, read: 0 };
    const stream = new GLESStream((command, args, bytes) =>
    {
        // (the host's own time on the machine's thread: E5's measure)
        const start = performance.now();
        const ret = command.api === "rc" ? this.rc_call(conn, command, args) : this.gl_call(conn, command, args, bytes);
        this.stats.cpu_ms += performance.now() - start;
        return ret;
    }, wake);
    if(state) stream.set_state(state.stream);
    else this.connections++;
    this.streams.add(stream);
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
            add_counts(this.closed_failed, stream.failed);
            this.rc.disconnect(conn);
            this.record(GLES.CONNECTION_CLOSE, [conn.id]);
        },
        get_state: () => pack({ conn, stream: stream.get_state() }),
    };
};

/** @param {*=} saved @return {!Object} a process pipe's service */
GLESHost.prototype.process_pipe = function(saved)
{
    let puid = null, reply = null;
    if(saved) [puid, reply] = saved;
    else this.processes++;
    return {
        get_state: () => [puid, reply && reply.slice()],
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
    // (glMapBufferRangeAEMU's answer is the bytes: the page never sees it, the unmap brings what was written)
    return /^gl(Get|Is|Gen|CheckFramebufferStatus|FinishRoundTrip|MapBufferRangeAEMU)/.test(name);
}

/**
 * A GLES call: the shadow state answers; what it accepts and the page needs
 * is recorded. glReadPixels waits for the pixels, glFinish's answer (the
 * encoder's glFinishRoundTrip) for room among the batches in flight.
 */
GLESHost.prototype.gl_call = function(conn, command, args, bytes)
{
    const { ret, keep } = this.shadow.call(conn.context, command, args);
    if(command.name === "glReadPixels" || command.name === "glReadnPixelsEXT")
    {
        if(!keep) return ret;
        // (EXT_robustness's: its buffer's size before the pixels)
        const [x, y, width, height, format, type, pixels] = command.name === "glReadPixels" ? args : [...args.slice(0, 6), args[7]];
        const request = this.request(pixels);
        this.record(GLES.READ_PIXELS, [conn.id, request.id, x, y, width, height, format, type]);
        this.flush();
        return request.done;
    }
    // (a map of a buffer the page wrote: its bytes from the page, into the guest's and the CPU side's copy)
    if(command.name === "glMapBufferRangeAEMU" && this.shadow.stale_map)
    {
        const stale = this.shadow.stale_map;
        this.shadow.stale_map = null;
        const mapped = args[4];
        if(!mapped || !mapped.size) return ret;
        const request = this.request(mapped);
        this.record(GLES.BUFFER_READ, [conn.id, request.id, stale.name, stale.offset, stale.length]);
        this.flush();
        return request.done.then(() => { stale.bytes.set(mapped.data.subarray(0, Math.min(stale.length, mapped.size)), stale.offset); });
    }
    // (an occlusion query's result: the page's)
    if(command.name === "glGetQueryObjectuiv" && this.shadow.query_read)
    {
        const { name, query } = this.shadow.query_read;
        this.shadow.query_read = null;
        const params = args[2];
        if(!params || params.size < 4) return ret;
        const request = this.request(params);
        this.record(GLES.QUERY_READ, [conn.id, request.id, name]);
        this.flush();
        return request.done.then(() => { query.result = new DataView(params.data.buffer, params.data.byteOffset).getUint32(0, true) ? 1 : 0; query.answered = true; });
    }
    // (a link through glslang: its result first, which the page links with)
    if(keep && (command.name === "glLinkProgram" || command.name === "glCreateShaderProgramvAEMU") && this.shadow.last_link)
    {
        const packed = pack_program(this.shadow.last_link);
        this.record(GLES.PROGRAM_LINK, [conn.id, (command.name === "glLinkProgram" ? args[0] : ret) >>> 0, packed.length], packed);
        this.shadow.last_link = null;
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
            const [context, config, share, requested] = args;
            // (a GLES 2.0 context of a host with glslang: GLSL ES 1.00 through it, drawn as GLES 3.x's: api 20, Context's glslang)
            const api = requested === 2 && this.shadow.glslang ? 20 : requested;
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
        case "gles_saved":
        {
            const answer = this.saves.get(message["id"]);
            this.saves.delete(message["id"]);
            if(answer) answer(message["state"] || null);
            break;
        }
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
            for(const answer of this.saves.values()) answer(null);
            this.saves.clear();
            while(this.completions.length) this.completions.shift().run();
            break;
    }
};

// ---- snapshots

/**
 * Before a save (the machine stopped): every call that waits for the page
 * answered (the batches run, the reads back, what the streams held after
 * them decoded), then the page's state fetched
 * @return {!Promise<undefined>}
 */
GLESHost.prototype.prepare_save = async function()
{
    for(;;)
    {
        this.flush();
        const busy = this.requests.size > 0 || this.completed < this.submitted || [...this.streams].some(s => s.waiting || s.backlog.length);
        if(!busy) break;
        if(this.completed < this.submitted) await new Promise(resolve => this.completions.push({ seq: this.submitted, run: resolve }));
        // (the answers' promises, and the streams' commands after them)
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    this.page_state = null;
    if(this.lost) return;
    const id = this.next_request++;
    // (a page that does not answer within a minute: the snapshot goes without its contents)
    this.page_state = await new Promise(resolve =>
    {
        const timer = setTimeout(() =>
        {
            this.saves.delete(id);
            console.warn("GLES: the page did not give its state for the snapshot; its textures and color buffers are not kept");
            resolve(null);
        }, 60000);
        this.saves.set(id, state => { clearTimeout(timer); resolve(state); });
        this.renderer.post({ "type": "gles_save", "id": id });
    });
};

/** @return {!Array<*>} a snapshot's: the version, the host's state packed, the page's (prepare_save's, or null) */
GLESHost.prototype.get_state = function()
{
    const rc = this.rc;
    const state = pack({
        rc: { next_handle: rc.next_handle, contexts: rc.contexts, surfaces: rc.surfaces, color_buffers: rc.color_buffers, images: rc.images,
            syncs: rc.syncs, displays: rc.displays, buffers: rc.buffers, posted: rc.posted, posts: rc.posts, swap_interval: rc.swap_interval,
            update_bytes: rc.update_bytes },
        shadow: this.shadow.get_state(),
        next_connection: this.next_connection, next_puid: this.next_puid, connections: this.connections, processes: this.processes,
        closed_counts: this.closed_counts, closed_unknown: this.closed_unknown, closed_malformed: this.closed_malformed,
        closed_failed: this.closed_failed, stats: this.stats, refused: this.refused,
    }, { classes: SHADOW_CLASSES, skip: shadow_skip });
    const page = this.page_state;
    this.page_state = null;
    return [1, state, page];
};

/**
 * A snapshot's state (the connections came back with the pipe's channels,
 * src/virt/goldfish.js, before this): the page reset and given its state
 * @param {!Array<*>} state get_state's; [] from a snapshot of E1 (nothing kept)
 */
GLESHost.prototype.set_state = function(state)
{
    const streams = this.streams;
    this.reset();
    if(!state || state[0] !== 1) return;
    this.streams = streams;
    const saved = unpack(state[1], SHADOW_CLASSES);
    Object.assign(this.rc, saved.rc);
    this.shadow.set_state(saved.shadow);
    for(const key of ["next_connection", "next_puid", "connections", "processes", "closed_counts", "closed_unknown", "closed_malformed",
        "closed_failed", "stats", "refused"])
    {
        if(saved[key] !== undefined) this[key] = saved[key];
    }
    if(state[2] && !this.lost) this.renderer.post({ "type": "gles_restore", "state": state[2] });
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
    const failed = new Map(this.closed_failed);
    for(const stream of this.streams)
    {
        add_counts(failed, stream.failed);
        add_counts(counts, stream.counts);
        add_counts(unknown, stream.unknown);
        add_counts(malformed, stream.malformed);
        dropped_bytes += stream.dropped_bytes;
        if(stream.broken) broken++;
    }
    const sorted = map => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));
    return {
        connections: this.connections, open_connections: this.streams.size, processes: this.processes,
        counts: sorted(counts), unknown: sorted(unknown), malformed: sorted(malformed), failed: sorted(failed), broken, dropped_bytes,
        render_control: this.rc.summary(), batches: Object.assign({ submitted: this.submitted, completed: this.completed }, this.stats),
        shaders: this.shadow.stats, refused: sorted(this.refused),
    };
};
