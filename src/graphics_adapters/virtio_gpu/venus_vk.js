// The Vulkan model of the Venus device (venus.js runs the transport): the
// guest driver's Vulkan objects, by the ids it gives them, and the commands
// on them. Queries are answered here, from venus_device_info.js; what
// draws and copies goes to the WebGPU executor (the renderer).

import * as INFO from "./venus_device_info.js";
import { GXWriter, VX, VX_MAGIC } from "../renderer_protocol.js";
import { RESOURCE_HANDLERS, lo, hi } from "./venus_vk_resources.js";
import { COMMAND_HANDLERS, translate, command_state } from "./venus_vk_commands.js";
import { PIPELINE_HANDLERS } from "./venus_vk_pipeline.js";
import { dbg_log } from "../../log.js";
import { LOG_VIRTIO } from "../../const.js";

import { VK_SUCCESS, VK_NOT_READY, VK_TIMEOUT, VK_INCOMPLETE, VK_ERROR_OUT_OF_HOST_MEMORY, VK_ERROR_OUT_OF_DEVICE_MEMORY,
    VK_ERROR_INITIALIZATION_FAILED, VK_ERROR_DEVICE_LOST, VK_ERROR_LAYER_NOT_PRESENT, VK_ERROR_EXTENSION_NOT_PRESENT,
    VK_ERROR_FEATURE_NOT_PRESENT, VK_ERROR_FORMAT_NOT_SUPPORTED, out_array } from "./venus_device_info.js";

const PAGE = 4096;
/** the VX commands that make renderer objects (what a snapshot makes again) */
const CREATIONS = new Set([VX.MEMORY_CREATE, VX.TEXTURE_CREATE, VX.VIEW_CREATE, VX.SAMPLER_CREATE, VX.SHADER_CREATE,
    VX.PIPELINE_CREATE, VX.QUERY_POOL_CREATE]);
const STYPE_DEVICE_QUEUE_TIMELINE_INFO_MESA = 1000384005;
// VkExternal{Semaphore,Fence}FeatureFlagBits
const EXTERNAL_EXPORTABLE = 1, EXTERNAL_IMPORTABLE = 2;

/**
 * @constructor
 * @param {!Object} options { host_visible_size, gpu: the VirtioGPU (its renderer channel and host visible memory) }
 */
export function VulkanModel(options)
{
    this.host_visible_size = options.host_visible_size || 0;
    this.gpu = options.gpu || null;
    this.stats = { unimplemented: {}, submissions: 0, batches: 0, readbacks: 0 };
    this.warned = new Set();
    /** @type {!Array<string>} the first warnings, for test harnesses */
    this.warnings = [];
    /** the VX batch being written: object creations, then a submission's commands */
    this.vx = new GXWriter(VX_MAGIC);
    /** @type {!Map<number, !Array>} the renderer's objects as made: rid -> [op, dwords, bytes], for snapshots */
    this.created = new Map();
    /** @type {!Map<number, !Array>} shaders destroyed while pipelines made of them may live (they are made again for those) */
    this.retired = new Map();
    /** @type {!Map<number, !Array<number>>} images that are virtio-gpu resources' GX surfaces: rid -> [rid, resource id] */
    this.imports = new Map();
    this.vx.listener = (op, dwords, bytes) => {
        if(CREATIONS.has(op)) this.created.set(dwords[0], [op, Array.from(dwords), bytes ? bytes.slice() : null]);
        else if(op === VX.TEXTURE_IMPORT) this.imports.set(dwords[0], Array.from(dwords));
        else if(op === VX.DESTROY)
        {
            this.imports.delete(dwords[0]);
            const entry = this.created.get(dwords[0]);
            if(entry && entry[0] === VX.SHADER_CREATE)
            {
                this.retired.set(dwords[0], entry);
                if(this.retired.size > 256) this.prune_retired();
            }
            this.created.delete(dwords[0]);
        }
    };
    this.next_rid = 1;
    this.host_allocated = 0;
    this.device_allocated = 0;
    /** @type {!Set<!Object>} queues with submissions */
    this.queues = new Set();
    /** @type {!Array<{check: function():boolean, deadline: number, then: function(boolean)}>} */
    this.waiters = [];
    /** the machine's time (ms), from the last timer */
    this.now = 0;
    /** @type {?function(string)} a harness's hook: uploads, submissions, readbacks */
    this.debug = null;
}

// ---------------------------------------------------------------------------
// Snapshots: the renderer's objects are made again from their creation
// commands, with the contents the GPU had (read back before the save)

/**
 * The contents of the renderer's memories and images, read back (the GPU
 * has done its work)
 * @return {!Promise}
 */
VulkanModel.prototype.save_contents = function()
{
    const saved = this.saved = new Map();
    const reads = [];
    const read = (op, words, then) => reads.push(new Promise(resolve => {
        const id = this.gpu.virgl.request(bytes => { then(bytes); resolve(undefined); });
        this.vx.command(op, [...words, id]);
    }));
    for(const [rid, entry] of this.created)
    {
        const op = entry[0], words = entry[1];
        if(op === VX.MEMORY_CREATE)
        {
            const size = words[1] + words[2] * 0x100000000;
            if(size) read(VX.MEMORY_READ, [rid, 0, 0, size], data => { if(data) saved.set(rid, data); });
        }
        // (an imported image's texels are its resource's: virgl saves them)
        else if(op === VX.TEXTURE_CREATE && !this.imports.has(/** @type {number} */ (rid)))
        {
            const [, format, type, , , depth, mips, layers, samples] = words;
            const entry = INFO.FORMATS[format];
            if(samples > 1 || !entry || !entry[0]) continue;
            const gpu_format = entry[0];
            // VkImageAspectFlagBits: color, depth, stencil
            const aspects = /^depth/.test(gpu_format) ? (/stencil/.test(gpu_format) ? [2, 4] : [2]) : gpu_format === "stencil8" ? [4] : [1];
            const images = [];
            saved.set(rid, images);
            for(let mip = 0; mip < mips; mip++)
            {
                const count = type === 2 ? Math.max(1, depth >> mip) : layers;
                for(let layer = 0; layer < count; layer++)
                {
                    for(const aspect of aspects)
                    {
                        read(VX.TEXTURE_READ, [rid, aspect, mip, layer], data => { if(data) images.push([aspect, mip, layer, data]); });
                    }
                }
            }
        }
    }
    this.send();
    return Promise.all(reads);
};

/** The shaders the live pipelines are made of, by rid */
VulkanModel.prototype.pipeline_shaders = function()
{
    const used = new Set();
    for(const [op, , bytes] of this.created.values())
    {
        if(op !== VX.PIPELINE_CREATE || !bytes) continue;
        let end = bytes.length;
        while(end && !bytes[end - 1]) end--;
        for(const stage of JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)))["stages"] || []) used.add(stage["shader"]);
    }
    return used;
};

/** Forget the destroyed shaders no live pipeline is made of */
VulkanModel.prototype.prune_retired = function()
{
    const used = this.pipeline_shaders();
    for(const rid of [...this.retired.keys()]) if(!used.has(rid)) this.retired.delete(rid);
};

/** @return {!Array} */
VulkanModel.prototype.get_state = function()
{
    this.prune_retired();
    // (the destroyed shaders of live pipelines first, destroyed again once the pipelines are made)
    const retired = [...this.retired.values()];
    const created = retired.concat([...this.created.values()]).map(([op, dwords, bytes]) => [op, dwords, bytes])
        .concat(retired.map(([, dwords]) => [VX.DESTROY, [dwords[0]], null]));
    const contents = this.saved ? [...this.saved] : [];
    this.saved = null;
    return [this.next_rid, this.host_allocated, this.device_allocated, created, contents, [...this.imports.values()]];
};

/**
 * The renderer's objects again (it was reset), then the contexts' objects
 * fixed up: nothing on its way any more
 * @param {!Array} state from get_state
 * @param {!Array<!Object>} contexts the Venus contexts, their objects restored
 */
VulkanModel.prototype.set_state = function(state, contexts)
{
    const [next_rid, host_allocated, device_allocated, created, contents, imports] = state;
    this.next_rid = next_rid;
    this.host_allocated = host_allocated;
    this.device_allocated = device_allocated;
    this.created.clear();
    this.retired.clear();
    this.imports.clear();
    this.queues.clear();
    this.waiters = [];
    if(!this.vx.empty()) this.vx.finish();
    for(const [op, dwords, bytes] of created) this.vx.command(op, dwords, bytes || undefined);
    const CHUNK = 16 << 20;
    for(const [rid, content] of contents)
    {
        if(ArrayBuffer.isView(content))
        {
            const bytes = /** @type {!Uint8Array} */ (content);
            for(let at = 0; at < bytes.length; at += CHUNK)
            {
                const piece = bytes.subarray(at, Math.min(bytes.length, at + CHUNK));
                this.vx.command(VX.MEMORY_WRITE, [rid, at, 0, piece.length], piece);
            }
        }
        else
        {
            for(const [aspect, mip, layer, bytes] of content) this.vx.command(VX.TEXTURE_WRITE, [rid, aspect, mip, layer, bytes.length], bytes);
        }
    }
    // (the resources' GX surfaces are back: virgl's state comes first)
    for(const dwords of imports || []) this.vx.command(VX.TEXTURE_IMPORT, dwords);
    for(const ctx of contexts)
    {
        for(const object of ctx.objects.values())
        {
            if(object.type === "memory")
            {
                object.pending = [];
                if(object.blob) object.blob.memory = object;
            }
            else if(object.type === "queue")
            {
                object.inflight = 0;
                if(object.pending && object.pending.length) this.queues.add(object);
            }
        }
    }
    this.send();
};

/** @return {number} a renderer object's id */
VulkanModel.prototype.new_rid = function()
{
    return this.next_rid++;
};

VulkanModel.prototype.warn_once = function(key, text)
{
    if(this.warned.has(key)) return;
    this.warned.add(key);
    if(this.warnings.length < 100) this.warnings.push(text);
    dbg_log("venus: " + text, LOG_VIRTIO);
};

VulkanModel.prototype.create_context = function(ctx)
{
    ctx.physical_device = 0;
};

VulkanModel.prototype.destroy_context = function(ctx)
{
    // (the renderer's objects of the context go too)
    for(const object of ctx.objects.values())
    {
        if(object.rid) this.vx.command(VX.DESTROY, [object.rid]);
        if(object.type === "queue") this.queues.delete(object);
        if(object.type === "memory")
        {
            if(object.host_visible) this.host_allocated -= object.size; else this.device_allocated -= object.size;
            if(object.blob) object.blob.memory = null;
        }
    }
    ctx.objects.clear();
    this.send();
};

/** whether a command has its handler (gfxstream: an alias's core command) */
VulkanModel.prototype.handles = function(name)
{
    return !!HANDLERS[name];
};

/**
 * A Vulkan command
 * @param {!Object} ctx
 * @param {string} name
 * @param {!Object} a its parameters (outputs and `ret` are set here)
 * @return {?function(function())} when its reply waits
 */
VulkanModel.prototype.handle = function(ctx, name, a)
{
    const handler = HANDLERS[name];
    if(handler) return handler(this, ctx, a) || null;
    if(name.startsWith("vkCmd"))
    {
        // recorded; the submission turns it into VX
        const cb = ctx.objects.get(a.commandBuffer);
        if(cb) cb.commands.push([name, a]);
        return null;
    }
    this.stats.unimplemented[name] = (this.stats.unimplemented[name] || 0) + 1;
    if(this.stats.unimplemented[name] === 1) dbg_log("venus: " + name + " is not implemented", LOG_VIRTIO);
    a.ret = VK_ERROR_FEATURE_NOT_PRESENT;
    return null;
};

// ---------------------------------------------------------------------------
// The renderer

/** Send the VX batch written so far */
VulkanModel.prototype.send = function()
{
    if(this.vx.empty() || !this.gpu || !this.gpu.virgl) return;
    this.stats.batches++;
    this.gpu.virgl.submit_stream(this.vx.finish(), "vx");
};

/**
 * Read a memory's bytes back from the GPU (in the batch, after what is before it)
 * @param {!Object} memory
 * @param {number} offset
 * @param {number} length
 * @param {function(Uint8Array)} answer
 */
VulkanModel.prototype.read = function(memory, offset, length, answer)
{
    const virgl = this.gpu.virgl;
    const id = virgl.request((bytes, status) => answer(bytes));
    this.stats.readbacks++;
    this.vx.command(VX.MEMORY_READ, [memory.rid, lo(offset), hi(offset), length, id]);
};

/**
 * Run `then` when everything sent so far has run
 * @param {function()} then
 */
VulkanModel.prototype.after = function(then)
{
    this.send();
    this.gpu.virgl.after_work(then);
};

// ---------------------------------------------------------------------------
// Host visible memory: the guest's mappings

/** the largest page a guest's kernel may round a blob to (Arm's 64 KiB granule) */
const GUEST_PAGE_MAX = 65536;

/** RESOURCE_CREATE_BLOB of a VkDeviceMemory: host visible memory only */
VulkanModel.prototype.export_memory = function(ctx, memory, blob)
{
    // (the guest's kernel makes blobs of whole pages: 4, 16 or 64 KiB)
    if(memory.type !== "memory" || !memory.host_visible || memory.blob || blob.blob_size > Math.ceil(memory.size / GUEST_PAGE_MAX) * GUEST_PAGE_MAX) return false;
    memory.blob = blob;
    return true;
};

/**
 * MAP_BLOB: the mapping gets the memory's contents (zeros when nothing wrote it)
 * @return {?function(function())}
 */
VulkanModel.prototype.map_memory = function(memory, blob)
{
    const gpu = this.gpu;
    gpu.take_hostmem_dirty();
    gpu.for_pages(blob.map_offset, blob.blob_size, page => { gpu.hostmem_pending[page >>> 5] &= ~(1 << (page & 31)); });
    if(memory.fresh !== false)
    {
        gpu.hostmem_bytes().fill(0, blob.map_offset, blob.map_offset + blob.blob_size);
        return null;
    }
    // (the GPU wrote it: what it has now)
    let finished = false, finish = null;
    gpu.hostmem_bytes().fill(0, blob.map_offset, blob.map_offset + blob.blob_size);
    this.read(memory, 0, Math.min(blob.blob_size, memory.size), data => {
        if(data && blob.memory === memory && blob.map_offset >= 0) gpu.hostmem_bytes().set(data, blob.map_offset);
        finished = true;
        if(finish) finish();
    });
    this.send();
    return done => { if(finished) done(); else finish = done; };
};

/** The blob goes away (its mapping's last writes were uploaded before) */
VulkanModel.prototype.unexport_memory = function(memory, blob)
{
    if(memory.blob === blob) memory.blob = null;
};

/**
 * Pages the guest wrote through a mapping (VirtioGPU.upload_hostmem):
 * except the bytes the GPU has written and the device has not read back
 * yet (they would be older than the GPU's)
 * @param {!Object} blob
 * @param {number} x where in the blob
 * @param {!Uint8Array} bytes
 */
VulkanModel.prototype.upload_blob = function(blob, x, bytes)
{
    const memory = blob.memory;
    // (past the memory: the rest of the blob's last page)
    if(!memory || x >= memory.size) return;
    if(x + bytes.length > memory.size) bytes = bytes.subarray(0, memory.size - x);
    memory.fresh = false;
    let runs = [[x, x + bytes.length]];
    for(const [start, end] of memory.pending || [])
    {
        runs = runs.flatMap(([a, b]) => end <= a || start >= b ? [[a, b]] : [[a, Math.min(b, start)], [Math.max(a, end), b]].filter(r => r[1] > r[0]));
    }
    for(const [a, b] of runs)
    {
        // (whole dwords: the GPU buffer's writes are of them)
        const from = a & ~3, to = Math.min(memory.size, b + 3 & ~3);
        if(this.debug) this.debug("upload memory " + memory.rid + " [" + from + ", " + to + ") " + Array.from(bytes.subarray(from - x, Math.min(to - x, from - x + 16))).join(","));
        this.vx.command(VX.MEMORY_WRITE, [memory.rid, lo(from), hi(from), to - from], bytes.subarray(from - x, to - x));
    }
};

/**
 * After a submission: the ranges the GPU wrote come back into their
 * mappings (the guest may have written other bytes of their pages)
 * @param {!Map<!Object, !Array<!Array<number>>>} written memory -> [start, end) ranges
 */
VulkanModel.prototype.read_back = function(written)
{
    const gpu = this.gpu;
    for(const [memory, ranges] of written)
    {
        memory.fresh = false;
        const blob = memory.blob;
        if(!memory.host_visible || !blob || blob.map_offset < 0)
        {
            if(this.debug && memory.host_visible) this.debug("readback skipped memory " + memory.rid + " " + JSON.stringify(ranges.slice(0, 4)) +
                (blob ? " (not mapped)" : " (no blob)"));
            continue;
        }
        // merged, in whole dwords, within the memory
        const sorted = ranges.map(([a, b]) => [a & ~3, Math.min(memory.size, b + 3 & ~3)]).filter(r => r[1] > r[0]).sort((p, q) => p[0] - q[0]);
        const merged = [];
        for(const r of sorted)
        {
            const last = merged[merged.length - 1];
            if(last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else merged.push(r.slice());
        }
        if(!memory.pending) memory.pending = [];
        const offset = blob.map_offset;
        for(const range of merged)
        {
            memory.pending.push(range);
            this.read(memory, range[0], range[1] - range[0], data => {
                if(this.debug) this.debug("readback memory " + memory.rid + " [" + range + ") " + (data ? Array.from(data.subarray(0, 16)).join(",") : "failed") +
                    " mapped at " + blob.map_offset + (memory.blob === blob ? "" : " (not the blob's any more)"));
                memory.pending.splice(memory.pending.indexOf(range), 1);
                if(data && memory.blob === blob && blob.map_offset === offset) gpu.hostmem_bytes().set(data, offset + range[0]);
            });
        }
    }
};

// ---------------------------------------------------------------------------
// Submissions and waits

/**
 * vkQueueSubmit(2): in the queue's order, when its timeline waits are met
 * @param {!Object} ctx
 * @param {number} queue_id
 * @param {!Array<{waits: !Array, command_buffers: !Array<number>, signals: !Array}>} submits
 * @param {number} fence_id
 */
VulkanModel.prototype.submit = function(ctx, queue_id, submits, fence_id)
{
    const queue = ctx.objects.get(queue_id);
    if(!queue) return;
    const fence = fence_id ? ctx.objects.get(fence_id) : null;
    if(fence) { fence.signaled = false; fence.pending++; }
    queue.pending.push({ ctx, submits, fence, generation: fence ? fence.generation : 0 });
    queue.ctx = ctx;
    this.queues.add(queue);
    this.pump();
};

/** Send the submissions whose waits are met */
VulkanModel.prototype.pump = function()
{
    for(const queue of this.queues)
    {
        while(queue.pending.length)
        {
            const entry = queue.pending[0];
            const ready = entry.submits.every(s => s.waits.every(([id, value]) => {
                const semaphore = entry.ctx.objects.get(id);
                return !semaphore || !semaphore.timeline || timeline_ready(semaphore, value);
            }));
            if(!ready) break;
            queue.pending.shift();
            this.run_submission(queue, entry);
        }
    }
};

function timeline_ready(semaphore, value)
{
    return semaphore.value >= value || semaphore.submitted >= value;
}

VulkanModel.prototype.run_submission = function(queue, entry)
{
    const ctx = entry.ctx;
    this.stats.submissions++;
    // the guest's writes through its mappings first
    this.gpu.upload_hostmem();
    const state = { written: new Map(), after: [], queries: new Map() };
    const signals = [];
    for(const submit of entry.submits)
    {
        for(const [id] of submit.waits)
        {
            const semaphore = ctx.objects.get(id);
            if(semaphore && !semaphore.timeline) semaphore.signaled = false;
        }
        // (a WebGPU command buffer for each: one WebGPU refuses drops only its own
        // commands, not the next one's, as Mesa's fence and semaphore feedback)
        for(const id of submit.command_buffers)
        {
            const cb = ctx.objects.get(id);
            state.cb = command_state();
            this.vx.command(VX.BEGIN, []);
            if(cb) translate(this, ctx, cb.commands, state);
            this.vx.command(VX.END, []);
        }
        for(const [id, value] of submit.signals)
        {
            const semaphore = ctx.objects.get(id);
            if(!semaphore) continue;
            if(semaphore.timeline) semaphore.submitted = Math.max(semaphore.submitted, value);
            signals.push([semaphore, value, semaphore.generation]);
        }
    }
    this.read_back(state.written);
    this.read_queries(state.queries);
    // (the resources Venus draws into: what the GPU has is newer than what
    // the device last copied, for the display and the guest's transfers)
    for(const [, resource_id] of this.imports.values())
    {
        const resource = this.gpu && this.gpu.resources ? this.gpu.resources.get(resource_id) : null;
        if(resource && resource.three_d) this.gpu.virgl.wrote(resource);
    }
    if(this.debug) this.debug("submission of " + entry.submits.map(s => s.command_buffers.join("+")).join(", ") + ": writes " +
        [...state.written].map(([m, r]) => m.rid + ":" + JSON.stringify(r)).join(" "));
    queue.inflight++;
    this.after(() => {
        queue.inflight--;
        for(const run of state.after) run();
        // (not the signals a sync file took: their objects' generation moved on)
        for(const [semaphore, value, generation] of signals)
        {
            if(semaphore.timeline) semaphore.value = Math.max(semaphore.value, value);
            else if(semaphore.generation === generation) semaphore.signaled = true;
        }
        if(entry.fence && entry.fence.generation === entry.generation && !--entry.fence.pending) entry.fence.signaled = true;
        this.wake();
    });
};

/**
 * The results of the queries a submission touched, into their pools (before
 * its fence: the answers come before the batch's completion)
 * @param {!Map} queries pool -> Set of queries
 */
VulkanModel.prototype.read_queries = function(queries)
{
    for(const [pool, set] of queries)
    {
        const list = [...set].sort((p, q) => p - q), first = list[0], count = list[list.length - 1] - first + 1;
        // (values a query: two for transform feedback's)
        const values = pool.values || 1, bytes = 8 * values;
        this.read(pool.memory, first * bytes, count * bytes, data => {
            const view = data && data.length >= count * bytes ? new DataView(data.buffer, data.byteOffset, data.length) : null;
            for(const q of list)
            {
                for(let k = 0; k < values && view; k++)
                {
                    const at = (q - first) * bytes + 8 * k;
                    pool.results[q * values + k] = view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;
                }
                pool.available[q] = 1;
            }
        });
    }
};

/** Milliseconds, for timestamps */
VulkanModel.prototype.clock = function()
{
    return typeof performance !== "undefined" ? performance.now() : Date.now();
};

/**
 * Whether the GPU has done all of a timeline's (a queue's) submissions
 * @param {!Object} ctx
 * @param {number} ring_idx
 */
VulkanModel.prototype.timeline_idle = function(ctx, ring_idx)
{
    for(const queue of this.queues)
    {
        if(queue.ring_idx === ring_idx && queue.ctx === ctx && (queue.pending.length || queue.inflight)) return false;
    }
    return true;
};

/**
 * A command waits until `check` holds or `timeout` (ns) passes
 * @param {function():boolean} check
 * @param {number} timeout
 * @param {function(boolean)} then
 */
VulkanModel.prototype.add_waiter = function(check, timeout, then)
{
    const deadline = timeout >= 2 ** 63 ? Infinity : this.now + timeout / 1e6;
    this.waiters.push({ check, deadline, then });
};

/** Something completed or was signaled: the waits it ends, the submissions it lets go */
VulkanModel.prototype.wake = function()
{
    const waiters = this.waiters;
    this.waiters = [];
    for(const w of waiters)
    {
        if(w.check()) w.then(true);
        else this.waiters.push(w);
    }
    this.pump();
};

/** The machine's time: waits time out */
VulkanModel.prototype.timer = function(now)
{
    this.now = now;
    if(!this.waiters.length) return;
    const waiters = this.waiters;
    this.waiters = [];
    for(const w of waiters)
    {
        if(w.check()) w.then(true);
        else if(now >= w.deadline) w.then(false);
        else this.waiters.push(w);
    }
};

// ---------------------------------------------------------------------------
// The handlers

/** @type {!Object<string, function(!VulkanModel, !Object, !Object): ?function(function())>} */
const HANDLERS = {
    // The device and its queues

    "vkCreateDevice": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        for(const name of info.ppEnabledExtensionNames || [])
        {
            if(!INFO.DEVICE_EXTENSIONS[name]) { a.ret = VK_ERROR_EXTENSION_NOT_PRESENT; return null; }
        }
        // the features asked for: VkPhysicalDeviceFeatures (or its Features2), the others false
        const supported = INFO.features();
        let asked = info.pEnabledFeatures;
        for(let s = info.pNext; s; s = s.pNext) if(s.sType === INFO.STYPE.PHYSICAL_DEVICE_FEATURES_2) asked = s.features;
        for(const name in asked || {})
        {
            if(asked[name] && !supported[name]) { a.ret = VK_ERROR_FEATURE_NOT_PRESENT; return null; }
        }
        ctx.objects.set(a.pDevice, { type: "device" });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyDevice": function(vk, ctx, a)
    {
        for(const [id, object] of ctx.objects)
        {
            if(object.type === "queue" && object.device === a.device) { vk.queues.delete(object); ctx.objects.delete(id); }
        }
        ctx.objects.delete(a.device);
        return null;
    },
    "vkGetDeviceQueue": function(vk, ctx, a)
    {
        ctx.objects.set(a.pQueue, { type: "queue", device: a.device, family: a.queueFamilyIndex, index: a.queueIndex,
            ring_idx: 0, pending: [], inflight: 0 });
        return null;
    },
    "vkGetDeviceQueue2": function(vk, ctx, a)
    {
        const info = a.pQueueInfo;
        let ring_idx = 0;
        for(let s = info.pNext; s; s = s.pNext) if(s.sType === STYPE_DEVICE_QUEUE_TIMELINE_INFO_MESA) ring_idx = s.ringIdx;
        ctx.objects.set(a.pQueue, { type: "queue", device: a.device, family: info.queueFamilyIndex, index: info.queueIndex,
            ring_idx, pending: [], inflight: 0 });
        return null;
    },
    "vkGetDeviceGroupPeerMemoryFeatures": function(vk, ctx, a)
    {
        // (one device: copy, generic src and dst)
        a.pPeerMemoryFeatures = 0xF;
        return null;
    },

    // The instance

    "vkEnumerateInstanceVersion": function(vk, ctx, a)
    {
        a.pApiVersion = INFO.VK_API_VERSION;
        a.ret = VK_SUCCESS;
    },
    "vkEnumerateInstanceExtensionProperties": function(vk, ctx, a)
    {
        if(a.pLayerName) { a.ret = VK_ERROR_LAYER_NOT_PRESENT; return; }
        out_array(a, "pPropertyCount", "pProperties", []);
    },
    "vkEnumerateInstanceLayerProperties": function(vk, ctx, a)
    {
        out_array(a, "pPropertyCount", "pProperties", []);
    },
    "vkCreateInstance": function(vk, ctx, a)
    {
        // (the driver enables no instance extension of the renderer's)
        if(a.pCreateInfo.enabledExtensionCount) { a.ret = VK_ERROR_EXTENSION_NOT_PRESENT; return; }
        ctx.objects.set(a.pInstance, { type: "instance" });
        a.ret = VK_SUCCESS;
    },
    "vkDestroyInstance": function(vk, ctx, a)
    {
        ctx.objects.delete(a.instance);
    },
    "vkEnumeratePhysicalDevices": function(vk, ctx, a)
    {
        // one; the driver names it (its id is in the array)
        if(!a.pPhysicalDevices)
        {
            a.pPhysicalDeviceCount = 1;
            a.ret = VK_SUCCESS;
            return;
        }
        a.pPhysicalDevices.length = Math.min(1, a.pPhysicalDevices.length);
        a.pPhysicalDeviceCount = a.pPhysicalDevices.length;
        a.ret = a.pPhysicalDevices.length ? VK_SUCCESS : VK_INCOMPLETE;
        if(a.pPhysicalDevices.length)
        {
            ctx.physical_device = a.pPhysicalDevices[0];
            ctx.objects.set(ctx.physical_device, { type: "physical_device" });
        }
    },
    "vkEnumeratePhysicalDeviceGroups": function(vk, ctx, a)
    {
        out_array(a, "pPhysicalDeviceGroupCount", "pPhysicalDeviceGroupProperties", [ctx.physical_device], (group, id) => {
            group.physicalDeviceCount = 1;
            group.physicalDevices = [id];
            group.subsetAllocation = 0;
        });
    },

    // The physical device

    "vkGetPhysicalDeviceProperties": function(vk, ctx, a)
    {
        a.pProperties = INFO.properties();
    },
    "vkGetPhysicalDeviceProperties2": function(vk, ctx, a)
    {
        INFO.properties2(a.pProperties);
    },
    "vkGetPhysicalDeviceFeatures": function(vk, ctx, a)
    {
        a.pFeatures = INFO.features();
    },
    "vkGetPhysicalDeviceFeatures2": function(vk, ctx, a)
    {
        INFO.features2(a.pFeatures);
    },
    "vkEnumerateDeviceExtensionProperties": function(vk, ctx, a)
    {
        if(a.pLayerName) { a.ret = VK_ERROR_LAYER_NOT_PRESENT; return; }
        const names = Object.keys(INFO.DEVICE_EXTENSIONS);
        out_array(a, "pPropertyCount", "pProperties", names, (out, name) => {
            out.extensionName = name;
            out.specVersion = INFO.DEVICE_EXTENSIONS[name];
        });
    },
    "vkEnumerateDeviceLayerProperties": function(vk, ctx, a)
    {
        out_array(a, "pPropertyCount", "pProperties", []);
    },
    "vkGetPhysicalDeviceQueueFamilyProperties": function(vk, ctx, a)
    {
        out_array(a, "pQueueFamilyPropertyCount", "pQueueFamilyProperties", INFO.QUEUE_FAMILIES, (out, family) => Object.assign(out, /** @type {!Object} */ (family)));
    },
    "vkGetPhysicalDeviceQueueFamilyProperties2": function(vk, ctx, a)
    {
        out_array(a, "pQueueFamilyPropertyCount", "pQueueFamilyProperties", INFO.QUEUE_FAMILIES, (out, family) => {
            out.queueFamilyProperties = family;
        });
    },
    "vkGetPhysicalDeviceMemoryProperties": function(vk, ctx, a)
    {
        a.pMemoryProperties = INFO.memory_properties(vk.host_visible_size);
    },
    "vkGetPhysicalDeviceMemoryProperties2": function(vk, ctx, a)
    {
        a.pMemoryProperties.memoryProperties = INFO.memory_properties(vk.host_visible_size);
    },
    "vkGetPhysicalDeviceFormatProperties": function(vk, ctx, a)
    {
        a.pFormatProperties = INFO.format_properties(a.format);
    },
    "vkGetPhysicalDeviceFormatProperties2": function(vk, ctx, a)
    {
        const props = INFO.format_properties(a.format);
        a.pFormatProperties.formatProperties = props;
        for(let s = a.pFormatProperties.pNext; s; s = s.pNext)
        {
            if(s.sType !== INFO.STYPE.DRM_FORMAT_MODIFIER_PROPERTIES_LIST && s.sType !== INFO.STYPE.DRM_FORMAT_MODIFIER_PROPERTIES_LIST_2) continue;
            // (the linear modifier, with optimal tiling's features)
            const modifiers = props.optimalTilingFeatures ? [{ drmFormatModifier: INFO.DRM_FORMAT_MOD_LINEAR, drmFormatModifierPlaneCount: 1,
                drmFormatModifierTilingFeatures: props.optimalTilingFeatures }] : [];
            if(s.pDrmFormatModifierProperties)
            {
                s.drmFormatModifierCount = Math.min(s.drmFormatModifierCount, modifiers.length);
                s.pDrmFormatModifierProperties = modifiers.slice(0, s.drmFormatModifierCount);
            }
            else s.drmFormatModifierCount = modifiers.length;
        }
    },
    "vkGetPhysicalDeviceImageFormatProperties": function(vk, ctx, a)
    {
        const props = INFO.image_format_properties(a.format, a.type, a.tiling, a.usage, a.flags);
        a.pImageFormatProperties = props || {};
        a.ret = props ? VK_SUCCESS : VK_ERROR_FORMAT_NOT_SUPPORTED;
    },
    "vkGetPhysicalDeviceImageFormatProperties2": function(vk, ctx, a)
    {
        const info = a.pImageFormatInfo;
        // (external memory: dma-bufs, imported as their virtio-gpu
        // resources, dedicated; with the linear modifier)
        let handle_type = 0, modifier = INFO.DRM_FORMAT_MOD_LINEAR;
        for(let s = info.pNext; s; s = s.pNext)
        {
            if(s.sType === INFO.STYPE.PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO) handle_type = s.handleType;
            else if(s.sType === INFO.STYPE.PHYSICAL_DEVICE_IMAGE_DRM_FORMAT_MODIFIER_INFO) modifier = Number(s.drmFormatModifier);
        }
        if(handle_type && handle_type !== INFO.MEMORY_HANDLE_DMA_BUF || modifier !== INFO.DRM_FORMAT_MOD_LINEAR)
        {
            a.ret = VK_ERROR_FORMAT_NOT_SUPPORTED;
            return;
        }
        const props = INFO.image_format_properties(info.format, info.type, info.tiling, info.usage, info.flags);
        a.pImageFormatProperties.imageFormatProperties = props || {};
        for(let s = a.pImageFormatProperties.pNext; s; s = s.pNext)
        {
            if(s.sType !== INFO.STYPE.EXTERNAL_IMAGE_FORMAT_PROPERTIES) continue;
            s.externalMemoryProperties = handle_type ? { externalMemoryFeatures: INFO.MEMORY_DEDICATED_ONLY | INFO.MEMORY_IMPORTABLE,
                exportFromImportedHandleTypes: 0, compatibleHandleTypes: INFO.MEMORY_HANDLE_DMA_BUF } :
                { externalMemoryFeatures: 0, exportFromImportedHandleTypes: 0, compatibleHandleTypes: 0 };
        }
        a.ret = props ? VK_SUCCESS : VK_ERROR_FORMAT_NOT_SUPPORTED;
    },
    "vkGetPhysicalDeviceSparseImageFormatProperties": function(vk, ctx, a)
    {
        out_array(a, "pPropertyCount", "pProperties", []);
    },
    "vkGetPhysicalDeviceSparseImageFormatProperties2": function(vk, ctx, a)
    {
        out_array(a, "pPropertyCount", "pProperties", []);
    },
    "vkGetPhysicalDeviceExternalBufferProperties": function(vk, ctx, a)
    {
        a.pExternalBufferProperties.externalMemoryProperties = { externalMemoryFeatures: 0, exportFromImportedHandleTypes: 0, compatibleHandleTypes: 0 };
    },
    // sync files of binary semaphores and of fences: exportable and importable
    "vkGetPhysicalDeviceExternalSemaphoreProperties": function(vk, ctx, a)
    {
        const info = a.pExternalSemaphoreInfo;
        let timeline = false;
        for(let s = info.pNext; s; s = s.pNext)
        {
            if(s.sType === INFO.STYPE.SEMAPHORE_TYPE_CREATE_INFO && s.semaphoreType === 1) timeline = true;
        }
        const types = info.handleType === INFO.SEMAPHORE_SYNC_FD && !timeline ? INFO.SEMAPHORE_SYNC_FD : 0;
        Object.assign(a.pExternalSemaphoreProperties, { exportFromImportedHandleTypes: types, compatibleHandleTypes: types,
            externalSemaphoreFeatures: types ? EXTERNAL_EXPORTABLE | EXTERNAL_IMPORTABLE : 0 });
    },
    "vkGetPhysicalDeviceExternalFenceProperties": function(vk, ctx, a)
    {
        const types = a.pExternalFenceInfo.handleType === INFO.FENCE_SYNC_FD ? INFO.FENCE_SYNC_FD : 0;
        Object.assign(a.pExternalFenceProperties, { exportFromImportedHandleTypes: types, compatibleHandleTypes: types,
            externalFenceFeatures: types ? EXTERNAL_EXPORTABLE | EXTERNAL_IMPORTABLE : 0 });
    },
    "vkGetPhysicalDeviceToolProperties": function(vk, ctx, a)
    {
        out_array(a, "pToolCount", "pToolProperties", []);
    },
};

Object.assign(HANDLERS, RESOURCE_HANDLERS, COMMAND_HANDLERS, PIPELINE_HANDLERS);
