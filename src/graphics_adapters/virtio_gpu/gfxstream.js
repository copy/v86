// virtio-gpu's gfxstream contexts (docs/gfxstream-plan.md G1, the protocol
// in docs/gfxstream-protocol.md): the capsets of gfxstream's Vulkan and
// composer; a context (a guest process) has an ASG ring per stream (a
// thread's connection), each in a HOST3D blob that CONTEXT_CREATE names and
// PING runs; on a ring, the stream (the client's flags, then commands of an
// opcode and a size, each to the decoder of its range: renderControl's,
// Vulkan's) and the replies back through it; the sync commands as tasks on
// the context's timeline, and the process pipe (pipe resources:
// GLProcessPipe) that renderControl's guest opens first.

import { GfxstreamVulkan } from "./gfxstream_vk.js";

const VULKAN_CAPSET_WORDS = 27, SMALL_CAPSET_WORDS = 4;
export const CAPSET_GFXSTREAM_VULKAN = 3;
export const CAPSET_GFXSTREAM_COMPOSER = 9;

// the host's ring parameters (gfxstream's host/VirtioGpuFrontend.cpp fillCaps)
const RING_SIZE = 12288;
const BUFFER_SIZE = 1 << 20;
const PAGE = 4096;
/** the guest's write step (asg_ring_config.flush_interval; the emulator's writeStepSize) */
const FLUSH_INTERVAL = 4096;

// execbuffer commands (virtgpu_gfxstream_protocol.h): opcode -> size
const CONTEXT_CREATE = 0x1001, CONTEXT_PING = 0x1002, CONTEXT_PING_WITH_RESPONSE = 0x1003;
const CREATE_EXPORT_SYNC = 0x9000, CREATE_IMPORT_SYNC = 0x9001;
const CREATE_EXPORT_SYNC_VK = 0xa000, CREATE_IMPORT_SYNC_VK = 0xa001, CREATE_QSRI_EXPORT_VK = 0xa002;
const RESOURCE_CREATE_3D = 0xa003, ACQUIRE_SYNC = 0xa004, PLACEHOLDER_COMMAND_VK = 0xf002;
const COMMAND_SIZE = {
    [CONTEXT_CREATE]: 8, [CONTEXT_PING]: 8, [CONTEXT_PING_WITH_RESPONSE]: 8,
    [CREATE_EXPORT_SYNC]: 12, [CREATE_IMPORT_SYNC]: 12,
    [CREATE_EXPORT_SYNC_VK]: 20, [CREATE_IMPORT_SYNC_VK]: 20, [CREATE_QSRI_EXPORT_VK]: 12,
    [RESOURCE_CREATE_3D]: 56, [ACQUIRE_SYNC]: 16, [PLACEHOLDER_COMMAND_VK]: 12,
};

// the ring storage (asg_ring_storage): three pages of ring_buffer
const TO_HOST = 0, TO_HOST_LARGE = PAGE, FROM_HOST_LARGE = 2 * PAGE;
// ring_buffer's fields
const WRITE_POS = 8, READ_POS = 64, RING_BUF = 128, RING_BUF_SIZE = 2048, STATE = 2176, CONFIG = 2180;
// asg_ring_config's, from CONFIG of the to-host page
const BUFFER_SIZE_FIELD = 0, FLUSH_INTERVAL_FIELD = 4, HOST_CONSUMED_POS = 8, GUEST_WRITE_POS = 12, TRANSFER_MODE = 16,
    TRANSFER_SIZE = 20, IN_ERROR = 24;
// asg_host_state
const HOST_NEED_NOTIFY = 0, HOST_CAN_CONSUME = 1, HOST_RENDERING = 4;

/** a resource of the process pipe (PIPE_BUFFER with VIRGL_BIND_CUSTOM) */
const PIPE_BUFFER = 0;
const BIND_CUSTOM = 1 << 17;

/**
 * A HOST3D blob of a gfxstream context: shared memory (blob id 0: an ASG
 * ring, or memory the guest maps)
 * @constructor
 */
export function GfxstreamBlob(id, ctx_id, blob_id, flags, size)
{
    this.id = id;
    this.ctx_id = ctx_id;
    this.blob_id = blob_id;
    this.blob_flags = flags;
    this.blob_size = size;
    /** where it is mapped in the host visible memory, -1 when it is not */
    this.map_offset = -1;
    this.memory = null;
}

/** a decoder's answer: the command is not decoded yet (decode it again later) */
export const AGAIN = {};

/**
 * An ASG ring: a stream of the context's (gfxstream's render thread), in
 * the blob that holds its storage and buffer
 * @constructor
 * @param {!GfxstreamBlob} blob
 */
function Ring(blob)
{
    this.blob = blob;
    /** its config written (the blob mapped once) */
    this.ready = false;
    /** @type {!Array<!Uint8Array>} what came in the stream and was not decoded yet */
    this.input = [];
    this.input_length = 0;
    /** the client's flags (4 bytes before the commands) read */
    this.flags_read = false;
    /** a decoder waits (the GPU's work): decoding resumes when it is done */
    this.waiting = false;
    /** a command waits for another ring's (its sequence number): decoded again when one is */
    this.blocked = false;
    /** per decoder, its state for this stream */
    this.decoder_state = new Map();
}

/**
 * A gfxstream context: the guest process's
 * @constructor
 * @param {number} id
 * @param {number} capset
 */
function GfxstreamContext(id, capset)
{
    this.id = id;
    this.capset = capset;
    /** @type {!Map<number, !Ring>} its streams' rings, by the blob's resource id */
    this.rings = new Map();
    this.destroyed = false;
    /** RESOURCE_CREATE_3D's templates by blob id (G3: color buffers) */
    this.pending_blobs = new Map();
    /** ACQUIRE_SYNC's sync id */
    this.sync = 0;
    /** per decoder, its state for this context (the process's: Vulkan objects, sequence numbers) */
    this.decoder_state = new Map();
}

/**
 * A pipe resource: a goldfish pipe over virtio-gpu transfers (the guest's
 * VirtioGpuPipeStream): its first bytes name the service
 * @constructor
 */
function Pipe()
{
    this.service = null;
    this.name = [];
    /** @type {!Array<number>} bytes the service has for the guest */
    this.output = [];
    this.confirmed = false;
}

/**
 * @constructor
 * @param {!Object} gpu the VirtioGPU
 * @param {Object=} vk the Vulkan model (venus_vk.js) its Vulkan streams run on
 */
export function Gfxstream(gpu, vk)
{
    this.gpu = gpu;
    this.vk = vk || null;
    /** @type {!Map<number, !GfxstreamContext>} */
    this.contexts = new Map();
    /**
     * the decoders of the stream's commands, each of its opcodes
     * [first, last]: decode(ctx, ring, opcode, payload, reply) answers null
     * (done), a wait(done) when the command waits (the GPU's work), or
     * AGAIN: not decoded yet (another ring's command comes first), decoded
     * again when a ring of the context has decoded one
     * @type {!Array<{name: string, first: number, last: number, decode: function(!Object, !Object, number, !Uint8Array, function(!Uint8Array)): *}>}
     */
    this.decoders = [];
    /** a decoder's answer: not decoded yet (exported for decoders outside the module) */
    this.AGAIN = AGAIN;
    /** Vulkan's streams (G2) */
    this.vulkan = vk ? new GfxstreamVulkan(this, vk) : null;
    if(this.vulkan) this.decoders.push(...this.vulkan.decoders());
    /** the process pipe's ids (GLProcessPipe) */
    this.next_puid = 1;
    this.stats = { pings: 0, transfers: 0, bytes: 0, commands: 0, replies: 0, unknown: {}, errors: 0, last_error: "" };
}

/** its capsets, [id, version, size] (the device's kinds of context) */
Gfxstream.prototype.capsets = [[CAPSET_GFXSTREAM_VULKAN, 0, VULKAN_CAPSET_WORDS * 4], [CAPSET_GFXSTREAM_COMPOSER, 0, SMALL_CAPSET_WORDS * 4]];

/**
 * A capset's contents, as gfxstream's host fills them
 * @param {number} id
 * @return {!Uint8Array}
 */
Gfxstream.prototype.capset = function(id)
{
    const words = new Uint32Array(id === CAPSET_GFXSTREAM_VULKAN ? VULKAN_CAPSET_WORDS : SMALL_CAPSET_WORDS);
    // protocolVersion, ringSize, bufferSize
    words[0] = 1;
    words[1] = RING_SIZE;
    words[2] = BUFFER_SIZE;
    if(id !== CAPSET_GFXSTREAM_VULKAN)
    {
        // blobAlignment
        words[3] = PAGE;
        return new Uint8Array(words.buffer);
    }
    // colorBufferMemoryIndex, deferredMapping, blobAlignment, noRenderControlEnc,
    // alwaysBlob, externalSync, virglSupportedFormats[16], batched descriptor
    // set updates, hasTraceAsyncCommand (G2: the color buffers' memory type,
    // the formats)
    words[3] = 0;
    words[4] = 1;
    words[5] = PAGE;
    words[6] = 1;
    words[26] = 1;
    return new Uint8Array(words.buffer);
};

Gfxstream.prototype.reset = function()
{
    for(const ctx of this.contexts.values()) ctx.destroyed = true;
    this.contexts.clear();
};

/**
 * @param {number} id
 * @param {number} capset
 */
Gfxstream.prototype.create_context = function(id, capset)
{
    this.destroy_context(id);
    this.contexts.set(id, new GfxstreamContext(id, capset));
};

/** @param {number} id */
Gfxstream.prototype.destroy_context = function(id)
{
    const ctx = this.contexts.get(id);
    if(!ctx) return;
    ctx.destroyed = true;
    for(const decoder of this.decoders) if(decoder.destroy) decoder.destroy(ctx);
    this.contexts.delete(id);
};

/**
 * RESOURCE_CREATE_BLOB of a gfxstream context: shared memory (blob id 0)
 * @return {GfxstreamBlob}
 */
Gfxstream.prototype.create_blob = function(id, ctx_id, flags, blob_id, size)
{
    const ctx = this.contexts.get(ctx_id);
    if(!ctx || !size) return null;
    const blob = new GfxstreamBlob(id, ctx_id, blob_id, flags, size);
    // (a blob id: a Vulkan memory's export; G3: a color buffer's)
    if(blob_id !== 0 && !(this.vulkan && this.vulkan.export_memory(ctx, blob))) return null;
    return blob;
};

/**
 * The blob was mapped: a ring waiting for its storage gets its config
 * @param {!GfxstreamBlob} blob
 * @return {?function(function())}
 */
Gfxstream.prototype.mapped = function(blob)
{
    // (a memory's: its contents, maybe from the GPU)
    if(blob.memory) return this.vk.map_memory(blob.memory, blob);
    const ctx = this.contexts.get(blob.ctx_id);
    const ring = ctx && ctx.rings.get(blob.id);
    if(ring && !ring.ready) this.init_ring(ctx, ring);
    return null;
};

/** the guest's writes: a memory's go to the GPU (shared memory's are read where they are) */
Gfxstream.prototype.upload_blob = function(blob, x, data)
{
    if(blob.memory) this.vk.upload_blob(blob, x, data);
};

/** @param {!GfxstreamBlob} blob */
Gfxstream.prototype.unref_blob = function(blob)
{
    if(blob.memory) this.vk.unexport_memory(blob.memory, blob);
    const ctx = this.contexts.get(blob.ctx_id);
    if(ctx) ctx.rings.delete(blob.id);
};

/** @return {!DataView} the host visible memory */
Gfxstream.prototype.view = function()
{
    const bytes = this.gpu.hostmem_bytes();
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

/**
 * The ring's config, as the host sets it before the guest reads it
 * @param {!GfxstreamContext} ctx
 * @param {!Ring} ring
 */
Gfxstream.prototype.init_ring = function(ctx, ring)
{
    if(ring.blob.map_offset < 0) return;
    const view = this.view(), base = ring.blob.map_offset;
    if(ring.blob.blob_size < RING_SIZE + BUFFER_SIZE)
    {
        this.error(ctx, "the ring's blob is " + ring.blob.blob_size + " bytes");
        return;
    }
    const config = base + TO_HOST + CONFIG;
    view.setUint32(config + BUFFER_SIZE_FIELD, BUFFER_SIZE, true);
    view.setUint32(config + FLUSH_INTERVAL_FIELD, FLUSH_INTERVAL, true);
    view.setUint32(config + HOST_CONSUMED_POS, 0, true);
    view.setUint32(config + TRANSFER_MODE, 1, true);
    view.setUint32(config + IN_ERROR, 0, true);
    view.setUint32(base + TO_HOST + STATE, HOST_NEED_NOTIFY, true);
    ring.ready = true;
};

/**
 * SUBMIT_3D of a gfxstream context: its commands (virtgpu_gfxstream_protocol.h)
 * @param {number} ctx_id
 * @param {!Uint8Array} bytes
 * @param {number=} ring_idx
 * @return {?function(function())} the answer waits until it calls back
 */
Gfxstream.prototype.submit = function(ctx_id, bytes, ring_idx)
{
    const ctx = this.contexts.get(ctx_id);
    if(!ctx) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /** @type {!Array<function(function())>} the tasks the answer waits for (the GPU's) */
    const tasks = [];
    for(let at = 0; at + 4 <= bytes.length;)
    {
        const op = view.getUint32(at, true), size = COMMAND_SIZE[op];
        if(!size || at + size > bytes.length)
        {
            this.error(ctx, "execbuffer command 0x" + op.toString(16) + " of " + (bytes.length - at) + " bytes");
            break;
        }
        const u32 = i => view.getUint32(at + 4 + 4 * i, true);
        switch(op)
        {
            case CONTEXT_CREATE:
            {
                const blob = this.gpu.resources.get(u32(0));
                if(!blob || !(blob instanceof GfxstreamBlob) || blob.ctx_id !== ctx_id)
                {
                    this.error(ctx, "CONTEXT_CREATE: resource " + u32(0) + " is not this context's blob");
                    break;
                }
                const ring = new Ring(blob);
                ctx.rings.set(blob.id, ring);
                if(blob.map_offset >= 0) this.init_ring(ctx, ring);
                break;
            }
            case CONTEXT_PING:
            case CONTEXT_PING_WITH_RESPONSE:
            {
                this.stats.pings++;
                const ring = ctx.rings.get(u32(0));
                if(ring) this.run(ctx, ring);
                else this.error(ctx, "PING of resource " + u32(0) + ", no ring of this context's");
                break;
            }
            case CREATE_EXPORT_SYNC:
            case CREATE_IMPORT_SYNC:
            case CREATE_EXPORT_SYNC_VK:
            case CREATE_IMPORT_SYNC_VK:
            case CREATE_QSRI_EXPORT_VK:
            {
                // a task on the context's timeline: done when the GPU's work
                // it names is (G2: the Vulkan fence's, the image's)
                const task = this.sync_task(ctx, op, [u32(0), u32(1), u32(2), u32(3)]);
                if(task) tasks.push(task);
                break;
            }
            case RESOURCE_CREATE_3D:
                ctx.pending_blobs.set(view.getUint32(at + 48, true) + view.getUint32(at + 52, true) * 0x100000000,
                    [u32(0), u32(1), u32(2), u32(3), u32(4), u32(5), u32(6), u32(7), u32(8), u32(9)]);
                break;
            case ACQUIRE_SYNC:
                ctx.sync = view.getUint32(at + 8, true) + view.getUint32(at + 12, true) * 0x100000000;
                break;
            case PLACEHOLDER_COMMAND_VK:
                break;
        }
        at += size;
    }
    if(!tasks.length) return null;
    // (the fence waits for them all: the timeline's tasks before it)
    return done => {
        let left = tasks.length;
        for(const task of tasks) task(() => { if(--left === 0) done(); });
    };
};

/**
 * A sync command's task: a decoder (Vulkan's) that knows the fence or
 * image says when its work is done; none: done at once
 * @param {!GfxstreamContext} ctx
 * @param {number} op
 * @param {!Array<number>} words
 * @return {?function(function())}
 */
Gfxstream.prototype.sync_task = function(ctx, op, words)
{
    for(const decoder of this.decoders)
    {
        if(decoder.sync_task)
        {
            const task = decoder.sync_task(ctx, op, words);
            if(task !== undefined) return task;
        }
    }
    return null;
};

/** The machine's timers: the rings whose decoding waited, again */
Gfxstream.prototype.timer = function(now)
{
    if(this.vk) this.vk.timer(now);
    for(const ctx of this.contexts.values())
    {
        for(const ring of ctx.rings.values()) if(!ring.waiting && ring.input_length) this.decode(ctx, ring);
    }
};

/**
 * PING: what the guest wrote on the ring, into its stream, then decoded
 * @param {!GfxstreamContext} ctx
 * @param {!Ring} asg
 */
Gfxstream.prototype.run = function(ctx, asg)
{
    if(!asg.ready || asg.blob.map_offset < 0) return;
    const view = this.view(), bytes = this.gpu.hostmem_bytes(), base = asg.blob.map_offset, buffer = base + RING_SIZE;
    const config = base + TO_HOST + CONFIG;
    view.setUint32(base + TO_HOST + STATE, HOST_CAN_CONSUME, true);
    // type 1: { offset, size } of the buffer, on the to-host ring
    const ring = base + TO_HOST;
    let read = view.getUint32(ring + READ_POS, true);
    const write = view.getUint32(ring + WRITE_POS, true);
    while((write - read >>> 0) >= 8)
    {
        const entry = ring + RING_BUF + (read & RING_BUF_SIZE - 1);
        const offset = view.getUint32(entry, true), size = view.getUint32(entry + 4, true);
        if(offset + size > BUFFER_SIZE)
        {
            this.error(ctx, "a transfer of [" + offset + ", +" + size + ") past the buffer");
            this.fail_ring(asg);
            break;
        }
        this.take(asg, bytes.slice(buffer + offset, buffer + offset + size));
        read = read + 8 >>> 0;
        view.setUint32(ring + READ_POS, read, true);
        view.setUint32(config + HOST_CONSUMED_POS, view.getUint32(config + HOST_CONSUMED_POS, true) + size >>> 0, true);
    }
    // type 3: a large transfer through its ring's view of the buffer
    const large = base + TO_HOST_LARGE;
    let large_read = view.getUint32(large + READ_POS, true);
    const large_write = view.getUint32(large + WRITE_POS, true);
    const available = large_write - large_read >>> 0;
    if(available && available <= BUFFER_SIZE)
    {
        const at = large_read & BUFFER_SIZE - 1, first = Math.min(available, BUFFER_SIZE - at);
        const data = new Uint8Array(available);
        data.set(bytes.subarray(buffer + at, buffer + at + first));
        if(first < available) data.set(bytes.subarray(buffer, buffer + available - first), first);
        this.take(asg, data);
        large_read = large_read + available >>> 0;
        view.setUint32(large + READ_POS, large_read, true);
    }
    this.decode(ctx, asg);
    this.set_state(asg);
};

/** The host's state on a ring: rendering while a command waits, else waiting for a ping */
Gfxstream.prototype.set_state = function(ring)
{
    if(ring.blob.map_offset >= 0) this.view().setUint32(ring.blob.map_offset + TO_HOST + STATE, ring.waiting ? HOST_RENDERING : HOST_NEED_NOTIFY, true);
};

/**
 * Bytes of a ring's stream
 * @param {!Ring} ring
 * @param {!Uint8Array} data
 */
Gfxstream.prototype.take = function(ring, data)
{
    if(!data.length) return;
    ring.input.push(data);
    ring.input_length += data.length;
    this.stats.transfers++;
    this.stats.bytes += data.length;
};

/**
 * A ring's commands decoded, each whole one in order; a command that waits
 * stops this ring's decoding until it is done, one that comes later (AGAIN)
 * until another ring of the context has decoded a command
 * @param {!GfxstreamContext} ctx
 * @param {!Ring} ring
 */
Gfxstream.prototype.decode = function(ctx, ring)
{
    if(ring.waiting || ctx.destroyed) return;
    ring.blocked = false;
    if(ring.input.length > 1)
    {
        const all = new Uint8Array(ring.input_length);
        let at = 0;
        for(const part of ring.input) { all.set(part, at); at += part.length; }
        ring.input = [all];
    }
    let data = ring.input[0] || new Uint8Array(0), p = 0;
    if(!ring.flags_read)
    {
        // the client's flags, not used any more (gfxstream's RenderThread)
        if(data.length < 4) return;
        ring.flags_read = true;
        p = 4;
    }
    let decoded = false;
    while(data.length - p >= 8)
    {
        const view = new DataView(data.buffer, data.byteOffset + p, data.length - p);
        const opcode = view.getUint32(0, true), size = view.getUint32(4, true);
        if(size < 8)
        {
            this.error(ctx, "command " + opcode + " of " + size + " bytes");
            this.fail_ring(ring);
            p = data.length;
            break;
        }
        if(data.length - p < size) break;
        const payload = data.subarray(p + 8, p + size);
        const decoder = this.decoders.find(d => opcode >= d.first && opcode <= d.last);
        if(!decoder)
        {
            p += size;
            this.stats.commands++;
            this.stats.unknown[opcode] = (this.stats.unknown[opcode] || 0) + 1;
            continue;
        }
        let wait = null;
        try
        {
            wait = decoder.decode(ctx, ring, opcode, payload, reply => this.reply(ctx, ring, reply));
        }
        catch(e)
        {
            this.error(ctx, decoder.name + " " + opcode + ": " + (e && e.message || e));
        }
        if(wait === AGAIN)
        {
            // (later: another ring's command first)
            ring.blocked = true;
            break;
        }
        p += size;
        this.stats.commands++;
        decoded = true;
        if(wait)
        {
            ring.waiting = true;
            ring.input = [data.subarray(p)];
            ring.input_length = data.length - p;
            /** @type {function(function())} */ (wait)(() => {
                ring.waiting = false;
                if(ctx.destroyed) return;
                this.decode(ctx, ring);
                this.set_state(ring);
                // (rings whose commands came after it)
                this.wake_blocked(ctx, ring);
            });
            this.wake_blocked(ctx, ring);
            return;
        }
    }
    data = data.subarray(p);
    ring.input = data.length ? [data] : [];
    ring.input_length = data.length;
    if(decoded) this.wake_blocked(ctx, ring);
};

/**
 * A ring decoded a command: the context's rings whose command waited for
 * another's, decoded again
 * @param {!GfxstreamContext} ctx
 * @param {!Ring} by
 */
Gfxstream.prototype.wake_blocked = function(ctx, by)
{
    for(const ring of ctx.rings.values())
    {
        if(ring !== by && ring.blocked && !ring.waiting)
        {
            this.decode(ctx, ring);
            this.set_state(ring);
        }
    }
};

/**
 * A reply into the from-host ring's view of the buffer
 * @param {!GfxstreamContext} ctx
 * @param {!Ring} asg
 * @param {!Uint8Array} reply
 */
Gfxstream.prototype.reply = function(ctx, asg, reply)
{
    if(asg.blob.map_offset < 0 || !reply.length) return;
    const view = this.view(), bytes = this.gpu.hostmem_bytes(), base = asg.blob.map_offset, buffer = base + RING_SIZE;
    const ring = base + FROM_HOST_LARGE;
    const write = view.getUint32(ring + WRITE_POS, true), read = view.getUint32(ring + READ_POS, true);
    if((write - read >>> 0) + reply.length > BUFFER_SIZE)
    {
        this.error(ctx, "a reply of " + reply.length + " bytes with the guest's unread");
        return;
    }
    const at = write & BUFFER_SIZE - 1, first = Math.min(reply.length, BUFFER_SIZE - at);
    bytes.set(reply.subarray(0, first), buffer + at);
    if(first < reply.length) bytes.set(reply.subarray(first), buffer);
    view.setUint32(ring + WRITE_POS, write + reply.length >>> 0, true);
    this.stats.replies++;
};

/** The ring in error: the guest's reads and writes fail (in_error) */
Gfxstream.prototype.fail_ring = function(ring)
{
    if(ring.blob.map_offset >= 0) this.view().setUint32(ring.blob.map_offset + TO_HOST + CONFIG + IN_ERROR, 1, true);
};

/**
 * @param {!GfxstreamContext} ctx
 * @param {string} message
 */
Gfxstream.prototype.error = function(ctx, message)
{
    this.stats.errors++;
    this.stats.last_error = "context " + ctx.id + ": " + message;
};

// The process pipe (pipe resources)

/**
 * Whether RESOURCE_CREATE_3D's arguments are a pipe's (the guest's
 * VirtioGpuPipeStream: a PIPE_BUFFER bound VIRGL_BIND_CUSTOM)
 * @param {number} target
 * @param {number} bind
 * @return {boolean}
 */
Gfxstream.prototype.is_pipe = function(target, bind)
{
    return target === PIPE_BUFFER && !!(bind & BIND_CUSTOM);
};

/** @return {!Pipe} a new pipe */
Gfxstream.prototype.create_pipe = function()
{
    return new Pipe();
};

/**
 * TRANSFER_TO_HOST_3D of a pipe: the guest's writes (its service's name first)
 * @param {!Object} pipe a Pipe
 * @param {!Uint8Array} data
 */
Gfxstream.prototype.pipe_write = function(pipe, data)
{
    let p = 0;
    if(pipe.service === null)
    {
        for(; p < data.length && pipe.service === null; p++)
        {
            if(data[p] === 0) pipe.service = String.fromCharCode(...pipe.name);
            else pipe.name.push(data[p]);
        }
    }
    if(pipe.service === "pipe:GLProcessPipe" && !pipe.confirmed && data.length - p >= 4)
    {
        // a confirmation (100), answered with the process's unique id
        pipe.confirmed = true;
        const puid = this.next_puid++;
        for(let i = 0; i < 8; i++) pipe.output.push(i < 4 ? puid >>> 8 * i & 0xFF : 0);
    }
};

/**
 * TRANSFER_FROM_HOST_3D of a pipe: what the service has, at most length bytes
 * @param {!Object} pipe a Pipe
 * @param {number} length
 * @return {!Uint8Array}
 */
Gfxstream.prototype.pipe_read = function(pipe, length)
{
    return Uint8Array.from(pipe.output.splice(0, length));
};
