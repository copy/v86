// Venus: Vulkan for the guest's Mesa venus driver, over virtio-gpu (capset 4,
// level "venus"). This is the transport: the capset, Venus contexts, the
// shared memory the driver allocates (HOST3D blobs of blob id 0, in the host
// visible memory, BAR4), the command rings in it, reply streams and the
// MESA transport commands. The Vulkan commands themselves go to the Vulkan
// model (venus_vk.js). See docs/gpu-devices.md, "Venus (Vulkan)".
//
// The driver writes commands into a ring and moves its tail; this device
// reads them on its timer (every time the machine's timers run) and when the
// driver submits anything, moves the head past each command it has done, and
// writes replies into the reply stream the driver set. A command whose answer
// waits for the GPU stops its ring (or its submission) until it is answered.
// Rings never go idle: the driver need not notify, and the status keeps the
// ALIVE bit, which the driver's watchdog clears while it waits.

import { COMMANDS, EXTENSIONS, VenusReader, VenusWriter, VK_XML_VERSION, WIRE_FORMAT_VERSION } from "./venus_protocol.js";
import { dbg_log } from "../../log.js";
import { encode_objects, decode_objects } from "./venus_state.js";
import { LOG_VIRTIO } from "../../const.js";

export const CAPSET_VENUS = 4;
/** virgl_renderer_capset_venus: 5 dwords, the extension mask (32), 3 dwords */
export const CAPSET_VENUS_SIZE = 40 * 4;

const COMMAND_GENERATE_REPLY = 1;

const RING_STATUS_FATAL = 2;
const RING_STATUS_ALIVE = 4;

/** what may be written into a ring's buffer between two reads (the driver's limit is the buffer) */
const MAX_DIRECT = 1 << 20;

/** the start of the key of a ring restored from a snapshot whose ring ids were numbers (ring_key) */
const ROUNDED = "~";

/**
 * The capset: the protocol of venus_protocol.js (Mesa 26.1.6's), every
 * extension of it (the extension mask's bit 0 clear says so); what the
 * device supports is what it enumerates
 * @return {!Uint8Array}
 */
export function venus_capset()
{
    const words = new Uint32Array(CAPSET_VENUS_SIZE / 4);
    words[0] = WIRE_FORMAT_VERSION;
    words[1] = VK_XML_VERSION;
    words[2] = EXTENSIONS["VK_EXT_command_serialization"][1];
    words[3] = EXTENSIONS["VK_MESA_venus_protocol"][1];
    // supports_blob_id_0: shared memory is HOST3D, blob id 0
    words[4] = 1;
    // allow_vk_wait_syncs, supports_multiple_timelines; not use_guest_vram
    words[37] = 1;
    words[38] = 1;
    words[39] = 0;
    return new Uint8Array(words.buffer);
}

/**
 * A blob of a Venus context: shared memory (blob id 0) or the export of
 * a VkDeviceMemory (blob id: the memory's object id)
 * @constructor
 */
export function VenusBlob(id, ctx_id, blob_id, flags, size)
{
    this.id = id;
    this.venus = true;
    this.ctx_id = ctx_id;
    this.blob_id = blob_id;
    this.blob_flags = flags;
    this.blob_size = size;
    /** where it is mapped in the host visible memory, -1 when it is not */
    this.map_offset = -1;
    /** @type {Object} the VkDeviceMemory it exports */
    this.memory = null;
    this.backing = null;
}

/**
 * A command ring in shared memory
 * @constructor
 * @param {string} id its key in its context's rings (ring_key)
 */
function Ring(id, blob, info)
{
    this.id = id;
    this.blob = blob;
    this.head_offset = info.headOffset;
    this.tail_offset = info.tailOffset;
    this.status_offset = info.statusOffset;
    this.buffer_offset = info.bufferOffset;
    this.buffer_size = info.bufferSize;
    this.extra_offset = info.extraOffset;
    this.extra_size = info.extraSize;
    /** where this device has read to (the driver's seqnos are these positions) */
    this.head = 0;
    /** @type {Run} the commands in progress, when one waits */
    this.run = null;
    this.fatal = false;
}

/**
 * Commands being run: a ring's (between its head and tail) or a
 * submission's; stopped at a command that waits
 * @constructor
 * @param {!VenusReader} reader
 * @param {function(number)} on_command after each command, its length
 * @param {function()} on_end
 */
function Run(reader, on_command, on_end)
{
    this.reader = reader;
    this.on_command = on_command;
    this.on_end = on_end;
    this.waiting = false;
    /** the command it waits in (for debugging) */
    this.waiting_on = "";
    /** where that command starts */
    this.at = 0;
}

/**
 * A Venus context: the guest process's driver instance
 * @constructor
 * @param {!Venus} venus
 * @param {number} id
 */
function VenusContext(venus, id)
{
    this.venus = venus;
    this.id = id;
    /** @type {!Map<string, !Ring>} by ring_key */
    this.rings = new Map();
    /** @type {?{blob: !VenusBlob, offset: number, size: number, position: number}} the reply stream */
    this.reply = null;
    /** the last vkSubmitVirtqueueSeqnoMESA, by ring */
    this.virtqueue_seqnos = new Map();
    /** @type {!Array<!Run>} submissions (SUBMIT_3D) waiting for the one before them */
    this.submissions = [];
    /** @type {!Array<function()>} commands waiting for a virtqueue or ring seqno */
    this.seqno_waits = [];
    /** a wake of the seqno waits is due (Venus.run_ring) */
    this.wake_pending = false;
    /** the Vulkan objects of this context, by the ids the driver gave them */
    this.objects = new Map();
    this.destroyed = false;
}

/**
 * @constructor
 * @param {!Object} gpu the VirtioGPU
 * @param {!Object} vk the Vulkan model: handle(ctx, name, args) -> wait or null
 */
export function Venus(gpu, vk)
{
    this.gpu = gpu;
    this.vk = vk;
    /** @type {!Map<number, !VenusContext>} */
    this.contexts = new Map();
    // failures: the commands that answered an error, with the last one (VkResult)
    // last_error: what made the last command fail (decoding, a handler), and in which command
    this.stats = { commands: 0, replies: 0, rings: 0, waits: 0, errors: 0, unknown: {}, failures: {}, last_error: "" };
    /** the command being run, for errors */
    this.current = "";
    /** @type {?function(string, !Object)} a harness's hook: each command as decoded */
    this.on_command = null;
    this.last_alive = 0;
}

/** its capsets, [id, version, size], and their contents (the device's kinds of context) */
Venus.prototype.capsets = [[CAPSET_VENUS, 0, CAPSET_VENUS_SIZE]];
/** @param {number} id @return {!Uint8Array} */
Venus.prototype.capset = function(id)
{
    return venus_capset();
};

/** the bytes [x, x + data.length) of a mapped blob, as the guest wrote them */
Venus.prototype.upload_blob = function(blob, x, data)
{
    this.vk.upload_blob(blob, x, data);
};

Venus.prototype.reset = function()
{
    for(const ctx of this.contexts.values())
    {
        ctx.destroyed = true;
        this.vk.destroy_context(ctx);
    }
    this.contexts.clear();
};

// ---------------------------------------------------------------------------
// Snapshots: the contexts (rings, reply streams, the model's objects); the
// commands that waited are read again from where their rings stopped

/** @return {!Array} */
Venus.prototype.get_state = function()
{
    const contexts = [];
    for(const ctx of this.contexts.values())
    {
        const rings = [...ctx.rings.values()].map(r => [r.id, r.blob.id, r.head_offset, r.tail_offset, r.status_offset, r.buffer_offset,
            r.buffer_size, r.extra_offset, r.extra_size, r.head, r.fatal]);
        const reply = ctx.reply ? [ctx.reply.blob.id, ctx.reply.offset, ctx.reply.size, ctx.reply.position] : null;
        const objects = encode_objects(ctx.objects, o => o instanceof VenusContext ? ["ctx", o.id] : o instanceof VenusBlob ? ["blob", o.id] : null);
        contexts.push([ctx.id, rings, reply, [...ctx.virtqueue_seqnos], objects, ctx.physical_device]);
    }
    return [contexts, this.vk.get_state()];
};

/**
 * @param {!Array} state from get_state
 * @param {function(number): VenusBlob} blob_of the restored blob of a resource id
 */
Venus.prototype.set_state = function(state, blob_of)
{
    // (the renderer was reset: its objects are gone already; the old
    // contexts' commands that wait never go on, nor write their replies)
    for(const ctx of this.contexts.values()) ctx.destroyed = true;
    this.contexts.clear();
    const [contexts, vk_state] = state;
    for(const [id, rings, reply, seqnos, objects, physical_device] of contexts)
    {
        const ctx = new VenusContext(this, id);
        this.contexts.set(id, ctx);
        ctx.physical_device = physical_device;
        ctx.objects = decode_objects(objects, ([kind, x]) => kind === "ctx" ? this.contexts.get(x) || null : kind === "blob" ? blob_of(x) : null);
        for(const [saved_id, blob_id, head_offset, tail_offset, status_offset, buffer_offset, buffer_size, extra_offset, extra_size, head, fatal] of rings)
        {
            const blob = blob_of(blob_id);
            if(!blob) continue;
            // (a snapshot of before the ids were exact: its id is a number
            // the driver's pointer rounded to, under which ring_key finds it)
            const ring_id = typeof saved_id === "number" ? ROUNDED + saved_id : saved_id;
            const ring = new Ring(ring_id, blob, { headOffset: head_offset, tailOffset: tail_offset, statusOffset: status_offset,
                bufferOffset: buffer_offset, bufferSize: buffer_size, extraOffset: extra_offset, extraSize: extra_size });
            ring.head = head;
            ring.fatal = fatal;
            ctx.rings.set(ring_id, ring);
        }
        const reply_blob = reply && blob_of(reply[0]);
        if(reply_blob) ctx.reply = { blob: reply_blob, offset: reply[1], size: reply[2], position: reply[3] };
        ctx.virtqueue_seqnos = new Map(seqnos);
    }
    this.vk.set_state(vk_state, [...this.contexts.values()]);
};

/**
 * Before a save: the rings run (the machine is stopped: nothing else runs
 * them) until `idle` says the device's requests are done, for a while at most
 * @param {function(): boolean} idle
 * @return {!Promise}
 */
Venus.prototype.settle = function(idle)
{
    const deadline = Date.now() + 5000;
    return new Promise(resolve => {
        const step = () => {
            for(const ctx of this.contexts.values()) this.run_rings(ctx);
            this.vk.wake();
            if(idle() || Date.now() > deadline) resolve(undefined);
            else setTimeout(step, 5);
        };
        step();
    });
};

/** @param {number} id */
Venus.prototype.create_context = function(id)
{
    const old = this.contexts.get(id);
    if(old) this.destroy_context(id);
    const ctx = new VenusContext(this, id);
    this.contexts.set(id, ctx);
    this.vk.create_context(ctx);
};

/** @param {number} id */
Venus.prototype.destroy_context = function(id)
{
    const ctx = this.contexts.get(id);
    if(!ctx) return;
    ctx.destroyed = true;
    this.vk.destroy_context(ctx);
    this.contexts.delete(id);
};

/** @return {!Uint8Array} the host visible memory */
Venus.prototype.bytes = function()
{
    return this.gpu.hostmem_bytes();
};

/**
 * RESOURCE_CREATE_BLOB of a Venus context
 * @return {VenusBlob} null when it cannot be made
 */
Venus.prototype.create_blob = function(id, ctx_id, flags, blob_id, size)
{
    const ctx = this.contexts.get(ctx_id);
    if(!ctx || !size) return null;
    const blob = new VenusBlob(id, ctx_id, blob_id, flags, size);
    if(blob_id !== 0)
    {
        // a VkDeviceMemory's export
        const memory = ctx.objects.get(blob_id);
        if(!memory || !this.vk.export_memory(ctx, memory, blob))
        {
            if(this.vk.debug) this.vk.debug("blob " + id + " of object " + blob_id + " (" + (memory ? memory.type + " of " + memory.size +
                (memory.blob ? ", exported as " + memory.blob.id : "") : "none") + "), " + size + " bytes: refused");
            return null;
        }
        blob.memory = memory;
    }
    return blob;
};

/**
 * The blob was mapped at `offset`; shared memory needs nothing, memory gets
 * its contents
 * @param {!VenusBlob} blob
 * @return {?function(function())} when the contents come later
 */
Venus.prototype.mapped = function(blob)
{
    return blob.memory ? this.vk.map_memory(blob.memory, blob) : null;
};

/** @param {!VenusBlob} blob */
Venus.prototype.unref_blob = function(blob)
{
    if(blob.memory) this.vk.unexport_memory(blob.memory, blob);
    const ctx = this.contexts.get(blob.ctx_id);
    if(!ctx) return;
    for(const ring of [...ctx.rings.values()]) if(ring.blob === blob) ctx.rings.delete(ring.id);
    if(ctx.reply && ctx.reply.blob === blob) ctx.reply = null;
};

/**
 * SUBMIT_3D of a Venus context: commands, run in order after the context's
 * earlier submissions
 * @param {number} ctx_id
 * @param {!Uint8Array} bytes
 * @param {number=} ring_idx a fence on this timeline (a queue's): answered after the queue's work
 * @return {?function(function())} the answer waits until it calls back
 */
Venus.prototype.submit = function(ctx_id, bytes, ring_idx)
{
    const ctx = this.contexts.get(ctx_id);
    if(!ctx) return null;
    // (the driver sends commands it waits for through its rings first)
    this.run_rings(ctx);
    let finished = false, finish = null;
    const run = new Run(new VenusReader(bytes), () => {}, () => {
        const done = () => {
            finished = true;
            ctx.submissions.shift();
            if(finish) finish();
            if(ctx.submissions.length) this.resume(ctx, ctx.submissions[0]);
        };
        if(ring_idx && !this.vk.timeline_idle(ctx, ring_idx)) this.vk.add_waiter(() => this.vk.timeline_idle(ctx, ring_idx), Infinity, done);
        else done();
    });
    ctx.submissions.push(run);
    if(ctx.submissions.length === 1) this.resume(ctx, run);
    if(finished) return null;
    const wait = done => { if(finished) done(); else finish = done; };
    // (for a snapshot: save_submission)
    wait.submission = { ctx_id, run, ring_idx: ring_idx || 0 };
    return wait;
};

/**
 * A submission whose answer waits, for a snapshot: its commands from the one
 * it waits in (those before it are done), or all of them when it has not
 * started (it waits for the one before it)
 * @param {{ctx_id: number, run: !Run, ring_idx: number}} submission
 * @return {!Array}
 */
Venus.prototype.save_submission = function(submission)
{
    const { ctx_id, run, ring_idx } = submission;
    const r = run.reader;
    return [ctx_id, r.bytes.slice(run.waiting ? run.at : r.p, r.end), ring_idx];
};

/**
 * A snapshot's submission, submitted again (after the contexts are restored)
 * @param {!Array} saved from save_submission
 * @return {?function(function())} as submit
 */
Venus.prototype.resubmit = function(saved)
{
    const [ctx_id, bytes, ring_idx] = saved;
    return this.submit(ctx_id, Uint8Array.from(bytes), ring_idx);
};

/**
 * Run commands until they end or one waits
 * @param {!VenusContext} ctx
 * @param {!Run} run
 */
Venus.prototype.resume = function(ctx, run)
{
    const r = run.reader;
    run.waiting = false;
    if(ctx.destroyed) return;
    while(r.p < r.end)
    {
        if(ctx.destroyed) return;
        const start = r.p;
        let wait;
        try
        {
            wait = this.command(ctx, r);
        }
        catch(e)
        {
            this.stats.errors++;
            this.stats.last_error = (this.current || "decoding") + ": " + String(e && e.message || e).slice(0, 200);
            dbg_log("venus: " + this.stats.last_error, LOG_VIRTIO);
            this.fatal(ctx, run);
            return;
        }
        if(wait)
        {
            this.stats.waits++;
            run.waiting = true;
            run.waiting_on = this.current;
            run.at = start;
            wait(() => {
                // (a context of before a restore or a reset: its ring's head is not this machine's)
                if(ctx.destroyed) return;
                run.on_command(r.p - start);
                this.resume(ctx, run);
            });
            return;
        }
        run.on_command(r.p - start);
    }
    run.on_end();
};

/**
 * A ring's commands cannot go on: its status says so, and the driver aborts
 * @param {!VenusContext} ctx
 * @param {!Run} run
 */
Venus.prototype.fatal = function(ctx, run)
{
    for(const ring of ctx.rings.values())
    {
        if(ring.run !== run) continue;
        ring.fatal = true;
        this.set_status(ring, RING_STATUS_FATAL);
    }
    // (a submission: what follows it still runs)
    if(ctx.submissions[0] === run) run.on_end();
};

/**
 * One command
 * @param {!VenusContext} ctx
 * @param {!VenusReader} r
 * @return {?function(function())} the command's reply waits
 */
Venus.prototype.command = function(ctx, r)
{
    const type = r.u32(), flags = r.u32();
    const entry = COMMANDS[type];
    this.current = "";
    if(!entry) throw new Error("unknown command " + type);
    const name = entry[0];
    this.current = name;
    const args = entry[1](r);
    this.stats.commands++;
    if(this.on_command) this.on_command(name, args);
    const transport = TRANSPORT[name];
    const wait = transport ? transport(this, ctx, args) : this.vk.handle(ctx, name, args);
    if(!(flags & COMMAND_GENERATE_REPLY)) return wait;
    if(!entry[2]) throw new Error(name + " has no reply");
    if(!wait)
    {
        this.note_result(name, args);
        this.write_reply(ctx, entry[2], args);
        return null;
    }
    // the reply goes to the stream set for it (a ring sets one before each
    // command with a reply; another ring's may be set while this one waits)
    const stream = ctx.reply;
    return done => wait(() => {
        if(ctx.destroyed) return;
        try
        {
            this.note_result(name, args);
            this.write_reply(ctx, entry[2], args, stream);
        }
        catch(e)
        {
            this.stats.errors++;
            dbg_log("venus: " + name + ": " + (e && e.message || e), LOG_VIRTIO);
        }
        done();
    });
};

/** an error a command answers, in the stats (VK_NOT_READY and VK_TIMEOUT are no errors) */
Venus.prototype.note_result = function(name, args)
{
    if(typeof args.ret === "number" && args.ret < 0) this.stats.failures[name] = args.ret;
};

/**
 * @param {!VenusContext} ctx
 * @param {function(!VenusWriter, !Object)} encode
 * @param {!Object} args
 * @param {?{blob: !VenusBlob, offset: number, size: number, position: number}=} stream the context's when not given
 */
Venus.prototype.write_reply = function(ctx, encode, args, stream)
{
    if(stream === undefined) stream = ctx.reply;
    if(!stream || stream.blob.map_offset < 0) throw new Error("a reply without a reply stream");
    const w = new VenusWriter(256);
    encode(w, args);
    const out = w.result();
    if(stream.position + out.length > stream.size) throw new Error("the reply does not fit its stream");
    this.bytes().set(out, stream.blob.map_offset + stream.offset + stream.position);
    stream.position += out.length;
    this.stats.replies++;
};

/**
 * @param {!VenusContext} ctx
 * @param {number} id
 * @return {!VenusBlob}
 */
Venus.prototype.shared_memory = function(ctx, id)
{
    const r = this.gpu.resources.get(id);
    if(!r || !r.venus || r.map_offset < 0) throw new Error("resource " + id + " is not mapped shared memory");
    return r;
};

// ---------------------------------------------------------------------------
// Rings

/** Run every context's rings; set their ALIVE bits now and then */
Venus.prototype.timer = function(now)
{
    this.vk.timer(now);
    const alive = now - this.last_alive >= 500 || now < this.last_alive;
    if(alive) this.last_alive = now;
    for(const ctx of this.contexts.values())
    {
        this.run_rings(ctx);
        if(alive) for(const ring of ctx.rings.values()) this.set_status(ring, RING_STATUS_ALIVE);
    }
};

/** @param {!VenusContext} ctx */
Venus.prototype.run_rings = function(ctx)
{
    for(const ring of ctx.rings.values()) this.run_ring(ctx, ring);
};

/**
 * @param {!VenusContext} ctx
 * @param {!Ring} ring
 */
Venus.prototype.run_ring = function(ctx, ring)
{
    if(ring.run || ring.fatal || ring.blob.map_offset < 0) return;
    const bytes = this.bytes();
    const base = ring.blob.map_offset;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tail = view.getUint32(base + ring.tail_offset, true);
    const size = (tail - ring.head) >>> 0;
    if(!size) return;
    if(size > ring.buffer_size || size > MAX_DIRECT || size & 3)
    {
        ring.fatal = true;
        this.set_status(ring, RING_STATUS_FATAL);
        return;
    }
    // the commands, in one piece (the buffer wraps)
    const commands = new Uint8Array(size);
    const at = ring.head & ring.buffer_size - 1, buffer = base + ring.buffer_offset;
    const first = Math.min(size, ring.buffer_size - at);
    commands.set(bytes.subarray(buffer + at, buffer + at + first));
    if(first < size) commands.set(bytes.subarray(buffer, buffer + size - first), first);
    this.stats.rings++;
    ring.run = new Run(new VenusReader(commands), length => {
        ring.head = ring.head + length >>> 0;
        if(ring.blob.map_offset >= 0)
        {
            const now = this.bytes();
            new DataView(now.buffer, now.byteOffset, now.byteLength).setUint32(ring.blob.map_offset + ring.head_offset, ring.head, true);
        }
        // (rings waiting for this one's head: not only when its run ends,
        // which can wait on them; after this turn, so that no ring runs
        // between another's reply stream and its command)
        if(ctx.seqno_waits.length && !ctx.wake_pending)
        {
            ctx.wake_pending = true;
            Promise.resolve().then(() => { ctx.wake_pending = false; this.wake_seqno_waits(ctx); });
        }
    }, () => {
        ring.run = null;
        this.wake_seqno_waits(ctx);
        // (more may have come meanwhile)
        if(!ring.fatal && !ctx.destroyed) this.run_ring(ctx, ring);
    });
    this.resume(ctx, ring.run);
};

/**
 * @param {!Ring} ring
 * @param {number} bits
 */
Venus.prototype.set_status = function(ring, bits)
{
    if(ring.blob.map_offset < 0) return;
    const bytes = this.bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = ring.blob.map_offset + ring.status_offset;
    view.setUint32(at, view.getUint32(at, true) | bits, true);
};

/** @param {!VenusContext} ctx */
Venus.prototype.wake_seqno_waits = function(ctx)
{
    const waits = ctx.seqno_waits;
    ctx.seqno_waits = [];
    for(const check of waits) check();
};

/**
 * Whether ring position a is at or past b (positions wrap at 2**32; the
 * driver's seqnos are positions)
 */
function seqno_passed(a, b)
{
    return (a - b | 0) >= 0;
}

/**
 * The key of the ring the driver names `id` (VenusReader.ring_id: its
 * pointer's 16 hex digits). Until 2026-10-19 the ids were numbers, which
 * round the driver's pointers to multiples of 2048 (Android's heap pointers
 * have a tag in the top byte), so that two threads' rings could get one id
 * and the second replaced the first, whose thread then waited for good; a
 * snapshot of then has its rings under the rounded number (set_state)
 * @param {!VenusContext} ctx
 * @param {string} id
 * @return {string}
 */
function ring_key(ctx, id)
{
    if(ctx.rings.has(id)) return id;
    const rounded = ROUNDED + Number(BigInt("0x" + id));
    return ctx.rings.has(rounded) ? rounded : id;
}

// ---------------------------------------------------------------------------
// The transport commands

/** @type {!Object<string, function(!Venus, !VenusContext, !Object): ?function(function())>} */
const TRANSPORT = {
    "vkCreateRingMESA": function(venus, ctx, a)
    {
        const info = a.pCreateInfo;
        const blob = venus.shared_memory(ctx, info.resourceId);
        const end = info.offset + info.size;
        if(info.bufferSize & info.bufferSize - 1 || end > blob.blob_size ||
            info.bufferOffset + info.bufferSize > info.size || info.extraOffset + info.extraSize > info.size)
        {
            throw new Error("vkCreateRingMESA: bad layout");
        }
        // (offsets within the resource: the ring may start inside it)
        const ring = new Ring(a.ring, blob, {
            headOffset: info.offset + info.headOffset, tailOffset: info.offset + info.tailOffset,
            statusOffset: info.offset + info.statusOffset, bufferOffset: info.offset + info.bufferOffset,
            bufferSize: info.bufferSize, extraOffset: info.offset + info.extraOffset, extraSize: info.extraSize,
        });
        ctx.rings.set(a.ring, ring);
        venus.set_status(ring, RING_STATUS_ALIVE);
        return null;
    },
    "vkDestroyRingMESA": function(venus, ctx, a)
    {
        ctx.rings.delete(ring_key(ctx, a.ring));
        return null;
    },
    "vkNotifyRingMESA": function(venus, ctx, a)
    {
        const ring = ctx.rings.get(ring_key(ctx, a.ring));
        if(ring) venus.run_ring(ctx, ring);
        return null;
    },
    "vkWriteRingExtraMESA": function(venus, ctx, a)
    {
        const ring = ctx.rings.get(ring_key(ctx, a.ring));
        if(!ring || a.offset + 4 > ring.extra_size) throw new Error("vkWriteRingExtraMESA: bad ring or offset");
        const bytes = venus.bytes();
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            .setUint32(ring.blob.map_offset + ring.extra_offset + a.offset, a.value, true);
        return null;
    },
    "vkSetReplyCommandStreamMESA": function(venus, ctx, a)
    {
        const stream = a.pStream;
        const blob = venus.shared_memory(ctx, stream.resourceId);
        if(stream.offset + stream.size > blob.blob_size) throw new Error("vkSetReplyCommandStreamMESA: past the resource");
        ctx.reply = { blob, offset: stream.offset, size: stream.size, position: 0 };
        return null;
    },
    "vkSeekReplyCommandStreamMESA": function(venus, ctx, a)
    {
        if(!ctx.reply || a.position > ctx.reply.size) throw new Error("vkSeekReplyCommandStreamMESA: no stream or past it");
        ctx.reply.position = a.position;
        return null;
    },
    "vkExecuteCommandStreamsMESA": function(venus, ctx, a)
    {
        // (run here, inline: a stream that waits makes the whole command wait)
        const streams = a.pStreams || [];
        let index = 0, finished = false, finish = null;
        const end = () => { finished = true; if(finish) finish(); };
        // the streams from `index` on; true when one waits (the rest runs after it)
        const next = () => {
            while(index < streams.length)
            {
                const i = index++, stream = streams[i];
                if(a.pReplyPositions) TRANSPORT["vkSeekReplyCommandStreamMESA"](venus, ctx, { position: a.pReplyPositions[i] });
                const blob = venus.shared_memory(ctx, stream.resourceId);
                if(stream.offset + stream.size > blob.blob_size) throw new Error("vkExecuteCommandStreamsMESA: past the resource");
                const start = blob.map_offset + stream.offset;
                const r = new VenusReader(venus.bytes().slice(start, start + stream.size));
                if(venus.run_inline(ctx, r, () => { if(!next()) end(); })) return true;
            }
            return false;
        };
        if(!next()) return null;
        return done => { if(finished) done(); else finish = done; };
    },
    "vkSubmitVirtqueueSeqnoMESA": function(venus, ctx, a)
    {
        ctx.virtqueue_seqnos.set(a.ring, a.seqno);
        venus.wake_seqno_waits(ctx);
        return null;
    },
    "vkWaitVirtqueueSeqnoMESA": function(venus, ctx, a)
    {
        // (the driver's roundtrip: the seqno arrives with a submission)
        const reached = () => [...ctx.virtqueue_seqnos.values()].some(seqno => seqno >= a.seqno);
        if(reached()) return null;
        return done => {
            const check = () => { if(reached()) done(); else ctx.seqno_waits.push(check); };
            check();
        };
    },
    "vkWaitRingSeqnoMESA": function(venus, ctx, a)
    {
        const key = ring_key(ctx, a.ring), ring = ctx.rings.get(key);
        if(!ring) return null;
        venus.run_ring(ctx, ring);
        const reached = () => !ctx.rings.has(key) || seqno_passed(ring.head, a.seqno);
        if(reached()) return null;
        return done => {
            const check = () => { if(reached()) done(); else ctx.seqno_waits.push(check); };
            check();
        };
    },
};

/**
 * Commands run inside another (vkExecuteCommandStreamsMESA)
 * @param {!VenusContext} ctx
 * @param {!VenusReader} r
 * @param {function()} then when a waiting command is done and the rest has run
 * @return {boolean} whether a command waits (then is called later)
 */
Venus.prototype.run_inline = function(ctx, r, then)
{
    while(r.p < r.end)
    {
        const wait = this.command(ctx, r);
        if(wait)
        {
            wait(() => {
                if(!this.run_inline(ctx, r, then)) then();
            });
            return true;
        }
    }
    return false;
};
