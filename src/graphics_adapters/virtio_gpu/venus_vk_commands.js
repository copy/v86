// The Venus device's command buffers, queues and synchronization
// (venus_vk.js runs them). Command buffers record the commands as decoded;
// a submission turns them into one VX batch (BEGIN, the commands, END), sent
// when its timeline waits are met. When the renderer has run it, what it
// wrote into mapped memory is back in the guest's mappings, then its
// semaphores and fence signal. One renderer queue runs everything in order,
// so binary semaphores need no wait.

import { VX } from "../renderer_protocol.js";
import { VK_SUCCESS, VK_NOT_READY, VK_TIMEOUT, VK_EVENT_SET, VK_EVENT_RESET, VK_ERROR_FEATURE_NOT_PRESENT,
    REMAINING, QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM } from "./venus_device_info.js";
import { lo, hi, range_size } from "./venus_vk_resources.js";

const STYPE_SEMAPHORE_TYPE_CREATE_INFO = 1000207002;
const STYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO = 1000207003;
const SEMAPHORE_TYPE_TIMELINE = 1;
const SEMAPHORE_WAIT_ANY = 1;
const FENCE_CREATE_SIGNALED = 1;
const QUERY_RESULT_64 = 1, QUERY_RESULT_WAIT = 2, QUERY_RESULT_WITH_AVAILABILITY = 4;
const QUERY_TYPE_OCCLUSION = 0;

/**
 * The occlusion query pool a render pass uses (WebGPU's passes name theirs
 * when they begin): the first one begun before the pass ends
 * @return {Object} the pool or null
 */
function occlusion_pool(ctx, commands, from)
{
    for(let i = from; i < commands.length; i++)
    {
        const [name, a] = commands[i];
        if(name === "vkCmdEndRenderPass" || name === "vkCmdEndRenderPass2" || name === "vkCmdEndRendering") break;
        if(name === "vkCmdBeginQuery" || name === "vkCmdBeginQueryIndexedEXT")
        {
            const pool = ctx.objects.get(a.queryPool);
            if(pool && pool.query_type === QUERY_TYPE_OCCLUSION) return pool;
        }
        if(name === "vkCmdExecuteCommands")
        {
            for(const id of a.pCommandBuffers || [])
            {
                const secondary = ctx.objects.get(id), pool = secondary && occlusion_pool(ctx, secondary.commands, 0);
                if(pool) return pool;
            }
        }
    }
    return null;
}

/** a timeline value's wait can go to the renderer: it is signaled, or a signal of it went first */
function timeline_ready(semaphore, value)
{
    return semaphore.value >= value || semaphore.submitted >= value;
}

/**
 * Wait until `check` holds or `timeout` (ns, of the machine's time) passes
 * @param {!Object} vk the model
 * @param {function():boolean} check
 * @param {number} timeout
 * @param {function(boolean)} then called with whether it holds
 * @return {?function(function())}
 */
function wait_until(vk, check, timeout, then)
{
    if(check()) { then(true); return null; }
    if(!timeout) { then(false); return null; }
    return done => vk.add_waiter(check, timeout, ok => { then(ok); done(); });
}

/** @type {!Object<string, function(!Object, !Object, !Object): ?function(function())>} */
export const COMMAND_HANDLERS = {
    // Command pools and buffers

    "vkCreateCommandPool": function(vk, ctx, a)
    {
        ctx.objects.set(a.pCommandPool, { type: "command_pool", buffers: new Set() });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyCommandPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.commandPool);
        if(pool) for(const id of pool.buffers) ctx.objects.delete(id);
        ctx.objects.delete(a.commandPool);
        return null;
    },
    "vkResetCommandPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.commandPool);
        if(pool) for(const id of pool.buffers) { const cb = ctx.objects.get(id); if(cb) cb.commands = []; }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkTrimCommandPool": function(vk, ctx, a) { return null; },
    "vkAllocateCommandBuffers": function(vk, ctx, a)
    {
        const info = a.pAllocateInfo;
        const pool = ctx.objects.get(info.commandPool);
        for(const id of a.pCommandBuffers || [])
        {
            ctx.objects.set(id, { type: "command_buffer", pool: info.commandPool, level: info.level, commands: [] });
            if(pool) pool.buffers.add(id);
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkFreeCommandBuffers": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.commandPool);
        for(const id of a.pCommandBuffers || [])
        {
            ctx.objects.delete(id);
            if(pool) pool.buffers.delete(id);
        }
        return null;
    },
    "vkBeginCommandBuffer": function(vk, ctx, a)
    {
        const cb = ctx.objects.get(a.commandBuffer);
        if(cb) { cb.commands = []; cb.begin = a.pBeginInfo; }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkEndCommandBuffer": function(vk, ctx, a) { a.ret = VK_SUCCESS; return null; },
    "vkResetCommandBuffer": function(vk, ctx, a)
    {
        const cb = ctx.objects.get(a.commandBuffer);
        if(cb) cb.commands = [];
        a.ret = VK_SUCCESS;
        return null;
    },

    // Queues

    "vkQueueSubmit": function(vk, ctx, a)
    {
        const submits = (a.pSubmits || []).map(s => {
            let wait_values = null, signal_values = null;
            for(let n = s.pNext; n; n = n.pNext)
            {
                if(n.sType === STYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO) { wait_values = n.pWaitSemaphoreValues; signal_values = n.pSignalSemaphoreValues; }
            }
            return {
                waits: (s.pWaitSemaphores || []).map((id, i) => [id, wait_values ? wait_values[i] : 0]),
                command_buffers: s.pCommandBuffers || [],
                signals: (s.pSignalSemaphores || []).map((id, i) => [id, signal_values ? signal_values[i] : 0]),
            };
        });
        vk.submit(ctx, a.queue, submits, a.fence);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkQueueSubmit2": function(vk, ctx, a)
    {
        const submits = (a.pSubmits || []).map(s => ({
            waits: (s.pWaitSemaphoreInfos || []).map(w => [w.semaphore, w.value]),
            command_buffers: (s.pCommandBufferInfos || []).map(c => c.commandBuffer),
            signals: (s.pSignalSemaphoreInfos || []).map(w => [w.semaphore, w.value]),
        }));
        vk.submit(ctx, a.queue, submits, a.fence);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkQueueBindSparse": function(vk, ctx, a)
    {
        a.ret = VK_ERROR_FEATURE_NOT_PRESENT;
        return null;
    },
    "vkQueueWaitIdle": function(vk, ctx, a)
    {
        const queue = ctx.objects.get(a.queue);
        return wait_until(vk, () => !queue || !queue.pending.length && !queue.inflight, Infinity, () => { a.ret = VK_SUCCESS; });
    },
    "vkDeviceWaitIdle": function(vk, ctx, a)
    {
        const queues = [...ctx.objects.values()].filter(o => o.type === "queue" && o.device === a.device);
        return wait_until(vk, () => queues.every(q => !q.pending.length && !q.inflight), Infinity, () => { a.ret = VK_SUCCESS; });
    },

    // Fences

    "vkCreateFence": function(vk, ctx, a)
    {
        ctx.objects.set(a.pFence, { type: "fence", signaled: !!(a.pCreateInfo.flags & FENCE_CREATE_SIGNALED), pending: 0, generation: 0 });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyFence": function(vk, ctx, a) { ctx.objects.delete(a.fence); return null; },
    "vkResetFences": function(vk, ctx, a)
    {
        for(const id of a.pFences || []) { const fence = ctx.objects.get(id); if(fence) fence.signaled = false; }
        a.ret = VK_SUCCESS;
        return null;
    },
    // vkGetFenceFdKHR: the driver made the sync file (its signal pending or
    // done); the fence is unsignaled, as an export of a sync file leaves it,
    // and its pending signal is the sync file's now
    "vkResetFenceResourceMESA": function(vk, ctx, a)
    {
        const fence = ctx.objects.get(a.fence);
        if(fence) { fence.signaled = false; fence.pending = 0; fence.generation++; }
        return null;
    },
    "vkGetFenceStatus": function(vk, ctx, a)
    {
        const fence = ctx.objects.get(a.fence);
        a.ret = !fence || fence.signaled ? VK_SUCCESS : VK_NOT_READY;
        return null;
    },
    "vkWaitForFences": function(vk, ctx, a)
    {
        const fences = (a.pFences || []).map(id => ctx.objects.get(id)).filter(f => f);
        const check = () => a.waitAll ? fences.every(f => f.signaled) : fences.some(f => f.signaled);
        return wait_until(vk, check, a.timeout, ok => { a.ret = ok ? VK_SUCCESS : VK_TIMEOUT; });
    },

    // Semaphores

    "vkCreateSemaphore": function(vk, ctx, a)
    {
        let timeline = false, value = 0;
        for(let s = a.pCreateInfo.pNext; s; s = s.pNext)
        {
            if(s.sType === STYPE_SEMAPHORE_TYPE_CREATE_INFO) { timeline = s.semaphoreType === SEMAPHORE_TYPE_TIMELINE; value = s.initialValue; }
        }
        ctx.objects.set(a.pSemaphore, { type: "semaphore", timeline, value, submitted: value, signaled: false, generation: 0 });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroySemaphore": function(vk, ctx, a) { ctx.objects.delete(a.semaphore); return null; },
    "vkGetSemaphoreCounterValue": function(vk, ctx, a)
    {
        const semaphore = ctx.objects.get(a.semaphore);
        a.pValue = semaphore ? semaphore.value : 0;
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkSignalSemaphore": function(vk, ctx, a)
    {
        const semaphore = ctx.objects.get(a.pSignalInfo.semaphore);
        if(semaphore)
        {
            semaphore.value = Math.max(semaphore.value, a.pSignalInfo.value);
            semaphore.submitted = Math.max(semaphore.submitted, semaphore.value);
            vk.wake();
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkWaitSemaphores": function(vk, ctx, a)
    {
        const info = a.pWaitInfo;
        const pairs = (info.pSemaphores || []).map((id, i) => [ctx.objects.get(id), info.pValues[i]]).filter(p => p[0]);
        const reached = ([semaphore, value]) => semaphore.value >= value;
        const check = () => info.flags & SEMAPHORE_WAIT_ANY ? pairs.some(reached) : pairs.every(reached);
        return wait_until(vk, check, a.timeout, ok => { a.ret = ok ? VK_SUCCESS : VK_TIMEOUT; });
    },
    // vkGetSemaphoreFdKHR: the sync file took the semaphore's payload (a
    // wait, as the export of a sync file is)
    "vkWaitSemaphoreResourceMESA": function(vk, ctx, a)
    {
        const semaphore = ctx.objects.get(a.semaphore);
        if(semaphore && !semaphore.timeline) { semaphore.signaled = false; semaphore.generation++; }
        return null;
    },
    // a sync file the driver waited for (resource 0): signaled
    "vkImportSemaphoreResourceMESA": function(vk, ctx, a)
    {
        const info = a.pImportSemaphoreResourceInfo, semaphore = info && ctx.objects.get(info.semaphore);
        if(semaphore && !semaphore.timeline) semaphore.signaled = true;
        return null;
    },

    // Events

    "vkCreateEvent": function(vk, ctx, a)
    {
        ctx.objects.set(a.pEvent, { type: "event", set: false });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyEvent": function(vk, ctx, a) { ctx.objects.delete(a.event); return null; },
    "vkGetEventStatus": function(vk, ctx, a)
    {
        const event = ctx.objects.get(a.event);
        a.ret = event && event.set ? VK_EVENT_SET : VK_EVENT_RESET;
        return null;
    },
    "vkSetEvent": function(vk, ctx, a)
    {
        const event = ctx.objects.get(a.event);
        if(event) event.set = true;
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkResetEvent": function(vk, ctx, a)
    {
        const event = ctx.objects.get(a.event);
        if(event) event.set = false;
        a.ret = VK_SUCCESS;
        return null;
    },

    // Queries

    // a pool's results (u64 each) are a VX memory: occlusion queries resolve
    // into it, timestamps are written into it; read back after a submission
    // that touches them, before its fence
    "vkCreateQueryPool": function(vk, ctx, a)
    {
        const info = a.pCreateInfo, count = info.queryCount;
        // (transform feedback's: two values a query, the primitives written and needed)
        const values = info.queryType === QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM ? 2 : 1;
        const pool = { type: "query_pool", query_type: info.queryType, count, values, rid: vk.new_rid(),
            memory: { rid: vk.new_rid(), size: count * 8 * values }, results: new Float64Array(count * values), available: new Uint8Array(count) };
        vk.vx.command(VX.MEMORY_CREATE, [pool.memory.rid, count * 8 * values, 0]);
        vk.vx.command(VX.QUERY_POOL_CREATE, [pool.rid, info.queryType, count]);
        ctx.objects.set(a.pQueryPool, pool);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyQueryPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.queryPool);
        if(pool && pool.type === "query_pool")
        {
            vk.vx.command(VX.DESTROY, [pool.rid]);
            vk.vx.command(VX.DESTROY, [pool.memory.rid]);
        }
        ctx.objects.delete(a.queryPool);
        return null;
    },
    "vkResetQueryPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.queryPool);
        if(pool) pool.available.fill(0, a.firstQuery, a.firstQuery + a.queryCount);
        return null;
    },
    "vkGetQueryPoolResults": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.queryPool);
        const answer = () => {
            const out = new Uint8Array(a.dataSize), view = new DataView(out.buffer);
            let all = true;
            for(let i = 0; i < a.queryCount; i++)
            {
                const q = a.firstQuery + i, at = i * a.stride, available = pool && pool.available[q];
                if(!available) all = false;
                const values = pool ? pool.values : 1, width = a.flags & QUERY_RESULT_64 ? 8 : 4;
                const write = (offset, v) => {
                    if(a.flags & QUERY_RESULT_64)
                    {
                        if(offset + 8 > out.length) return;
                        view.setUint32(offset, lo(v), true);
                        view.setUint32(offset + 4, hi(v), true);
                    }
                    else if(offset + 4 <= out.length) view.setUint32(offset, Math.min(v, 0xFFFFFFFF), true);
                };
                if(available) for(let k = 0; k < values; k++) write(at + k * width, pool.results[q * values + k]);
                if(a.flags & QUERY_RESULT_WITH_AVAILABILITY) write(at + values * width, available ? 1 : 0);
            }
            a.pData = out;
            a.ret = all ? VK_SUCCESS : VK_NOT_READY;
        };
        if(!(a.flags & QUERY_RESULT_WAIT) || !pool) { answer(); return null; }
        const available = () => pool.available.subarray(a.firstQuery, a.firstQuery + a.queryCount).every(x => x);
        return wait_until(vk, available, Infinity, () => answer());
    },
};

// ---------------------------------------------------------------------------
// Commands into VX

/**
 * A buffer's memory and where in it
 * @return {Array} [memory, offset] or null when it has none
 */
function at(ctx, id, offset)
{
    const buffer = ctx.objects.get(id);
    if(!buffer || !buffer.memory) return null;
    return [buffer.memory, buffer.offset + offset, buffer];
}

const f32_bits = v => new Uint32Array(new Float32Array([v]).buffer)[0];
// VkDescriptorType
const UNIFORM_BUFFER = 6, STORAGE_BUFFER = 7, UNIFORM_BUFFER_DYNAMIC = 8, STORAGE_BUFFER_DYNAMIC = 9;
const STORAGE_IMAGE = 3;

/** A command buffer's state as its commands are translated */
export function command_state()
{
    return {
        // the render pass: { pass, framebuffer, subpass, clears, used: Set of attachments }
        pass: null,
        // the bound descriptor sets, by bind point: group -> [set, dynamic offsets]
        sets: [new Map(), new Map()],
        // the transform feedback buffers: [memory, offset, size] by binding
        xfb: [],
    };
}

/**
 * BEGIN_PASS of a subpass: its attachments, their loads (the first use of
 * an attachment in the render pass loads as the render pass says, later
 * ones keep what is there) and clear values
 */
// VkRenderingFlagBits
const RENDERING_RESUMING = 4;
// VkAttachmentLoadOp, VkAttachmentStoreOp
const LOAD_OP_LOAD = 0, STORE_OP_STORE = 0;

/**
 * vkCmdBeginRendering: a render pass of the views it names (as begin_subpass's)
 * @param {!Object} vk
 * @param {!Object} ctx
 * @param {!Object} info VkRenderingInfo
 * @param {!Object} p the pass's state
 */
function begin_rendering(vk, ctx, info, p)
{
    // (Venus encodes each VkClearValue as a color: a depth clear is its bits)
    const bits = c => c && c.color ? Array.from(c.color.uint32 || c.color.int32 || [0, 0, 0, 0], x => x >>> 0) : [0, 0, 0, 0];
    const resuming = info.flags & RENDERING_RESUMING;
    let size = null;
    const view = id => {
        const v = id ? ctx.objects.get(id) : null;
        if(v && !size) size = v;
        return v;
    };
    const colors = (info.pColorAttachments || []).map(c => {
        const v = view(c.imageView);
        if(!v) return null;
        const resolve = c.resolveMode && c.resolveImageView ? (ctx.objects.get(c.resolveImageView) || { rid: 0 }).rid : 0;
        return { view: v.rid, load: resuming ? LOAD_OP_LOAD : c.loadOp, store: c.storeOp, clear: bits(c.clearValue), resolve, format: v.format };
    });
    let depth = null;
    const d = info.pDepthAttachment && view(info.pDepthAttachment.imageView) ? info.pDepthAttachment : null;
    const st = info.pStencilAttachment && view(info.pStencilAttachment.imageView) ? info.pStencilAttachment : null;
    if(d || st)
    {
        const v = ctx.objects.get((d || st).imageView);
        // (the depth and stencil resolved, sample zero, into the resolve views)
        const resolve_of = a => a && a.resolveMode && a.resolveImageView ? (ctx.objects.get(a.resolveImageView) || { rid: 0 }).rid : 0;
        const resolve = resolve_of(d) || resolve_of(st);
        depth = { view: v.rid, load: d && !resuming ? d.loadOp : LOAD_OP_LOAD, store: d ? d.storeOp : STORE_OP_STORE,
            stencil_load: st && !resuming ? st.loadOp : LOAD_OP_LOAD, stencil_store: st ? st.storeOp : STORE_OP_STORE,
            clear_depth: d ? new Float32Array(new Uint32Array([bits(d.clearValue)[0]]).buffer)[0] : 1,
            clear_stencil: st ? bits(st.clearValue)[1] : 0, format: v.format,
            resolve, resolve_depth: !!resolve_of(d), resolve_stencil: !!resolve_of(st) };
    }
    const area = info.renderArea;
    const width = size ? size.width : area.offset.x + area.extent.width, height = size ? size.height : area.offset.y + area.extent.height;
    const occlusion = p.occlusion ? p.occlusion.rid : 0;
    vk.vx.command(VX.BEGIN_PASS, [], new TextEncoder().encode(JSON.stringify({ colors, depth, width, height, occlusion })));
}

function begin_subpass(vk, ctx, p)
{
    const sub = p.pass.subpasses[p.subpass];
    if(!sub) return;
    const fb = p.framebuffer;
    const view = i => { const v = ctx.objects.get(fb.attachments[i]); return v ? v.rid : 0; };
    const clear = i => {
        const c = p.clears[i];
        const bits = c && c.color ? Array.from(c.color.uint32 || c.color.int32 || [0, 0, 0, 0], x => x >>> 0) : [0, 0, 0, 0];
        return bits;
    };
    const load = (i, op) => p.used.has(i) ? 0 : op;
    const colors = sub.colors.map((r, k) => {
        if(!r || r.attachment === REMAINING) return null;
        const a = p.pass.attachments[r.attachment];
        const resolve = sub.resolves && sub.resolves[k] && sub.resolves[k].attachment !== REMAINING ? view(sub.resolves[k].attachment) : 0;
        return { view: view(r.attachment), load: load(r.attachment, a.load), store: a.store, clear: clear(r.attachment), resolve, format: a.format };
    });
    let depth = null;
    if(sub.depth && sub.depth.attachment !== REMAINING)
    {
        const i = sub.depth.attachment, a = p.pass.attachments[i];
        const bits = clear(i);
        const r = sub.depth_resolve && sub.depth_resolve.attachment !== REMAINING ? sub.depth_resolve : null;
        depth = { view: view(i), load: load(i, a.load), store: a.store, stencil_load: load(i, a.stencil_load), stencil_store: a.stencil_store,
            clear_depth: new Float32Array(new Uint32Array([bits[0]]).buffer)[0], clear_stencil: bits[1], format: a.format,
            resolve: r ? view(r.attachment) : 0, resolve_depth: !!(r && r.depth), resolve_stencil: !!(r && r.stencil) };
    }
    for(const r of sub.colors.concat([sub.depth], sub.resolves || [])) if(r && r.attachment !== REMAINING) p.used.add(r.attachment);
    const occlusion = p.occlusion ? p.occlusion.rid : 0;
    vk.vx.command(VX.BEGIN_PASS, [], new TextEncoder().encode(JSON.stringify({ colors, depth, width: fb.width, height: fb.height, occlusion })));
}

/**
 * SET_BIND_GROUP of a descriptor set: its descriptors resolved to the
 * renderer's objects; dynamic offsets from `dynamic` in binding order.
 * Storage buffers the shaders may write are noted by `write`.
 */
function bind_set(vk, ctx, bind_point, group, set, dynamic, storage)
{
    const words = [];
    const keys = [...set.descriptors.keys()].sort((p, q) => p - q);
    let d_index = 0;
    for(const key of keys)
    {
        const d = set.descriptors.get(key);
        const binding = Math.floor(key / 1024), element = key % 1024;
        let rid = 0, sampler = 0, offset = 0, size = 0;
        if(d.type === UNIFORM_BUFFER || d.type === STORAGE_BUFFER || d.type === UNIFORM_BUFFER_DYNAMIC || d.type === STORAGE_BUFFER_DYNAMIC)
        {
            const buffer = ctx.objects.get(d.buffer);
            if(!buffer || !buffer.memory) continue;
            const extra = d.type === UNIFORM_BUFFER_DYNAMIC || d.type === STORAGE_BUFFER_DYNAMIC ? dynamic[d_index++] || 0 : 0;
            rid = buffer.memory.rid;
            offset = buffer.offset + d.offset + extra;
            size = range_size(buffer, d.offset, d.range);
            if(d.type === STORAGE_BUFFER || d.type === STORAGE_BUFFER_DYNAMIC) storage.push([buffer.memory, offset, size]);
        }
        else
        {
            const view = d.view ? ctx.objects.get(d.view) : null, s = d.sampler ? ctx.objects.get(d.sampler) : null;
            rid = view ? view.rid : 0;
            sampler = s ? s.rid : 0;
        }
        words.push(binding, element, d.type, rid, sampler, lo(offset), hi(offset), size >>> 0);
    }
    vk.vx.command(VX.SET_BIND_GROUP, [group | bind_point << 16, words.length / 8, ...words]);
}

/**
 * A submission's command buffers, written into the VX batch
 * @param {!Object} vk the model
 * @param {!Object} ctx
 * @param {!Array} commands [name, parameters] of a command buffer
 * @param {!Object} state { written: Set of memory the GPU writes, after: run on completion }
 */
export function translate(vk, ctx, commands, state)
{
    const vx = vk.vx;
    const image = id => ctx.objects.get(id);
    /** the GPU writes [offset, offset + size) of the memory */
    const write = (memory, offset, size) => {
        let ranges = state.written.get(memory);
        if(!ranges) state.written.set(memory, ranges = []);
        ranges.push([offset, offset + size]);
    };
    const cb = state.cb || (state.cb = command_state());
    /** before a draw or dispatch: the storage buffers of the bound sets are the GPU's to write */
    const storage_writes = bind_point => {
        for(const [, [set, dynamic]] of cb.sets[bind_point])
        {
            const storage = [];
            for(const d of set.descriptors.values())
            {
                if(d.type !== STORAGE_BUFFER && d.type !== STORAGE_BUFFER_DYNAMIC) continue;
                const buffer = ctx.objects.get(d.buffer);
                if(buffer && buffer.memory) write(buffer.memory, buffer.offset + d.offset, range_size(buffer, d.offset, d.range));
            }
        }
    };
    /** a query the submission touches: its result comes back before the fence */
    const touch = (pool, query) => {
        let set = state.queries.get(pool);
        if(!set) state.queries.set(pool, set = new Set());
        set.add(query);
    };
    for(let index = 0; index < commands.length; index++)
    {
        const [name, a] = commands[index];
        switch(name)
        {
            // Render passes
            case "vkCmdBeginRenderPass":
            case "vkCmdBeginRenderPass2":
            {
                const info = a.pRenderPassBegin;
                const pass = ctx.objects.get(info.renderPass), framebuffer = ctx.objects.get(info.framebuffer);
                if(!pass || !framebuffer) break;
                cb.pass = { pass, framebuffer, subpass: 0, clears: info.pClearValues || [], used: new Set(),
                    occlusion: occlusion_pool(ctx, commands, index + 1) };
                begin_subpass(vk, ctx, cb.pass);
                break;
            }
            case "vkCmdNextSubpass":
            case "vkCmdNextSubpass2":
                if(!cb.pass) break;
                vx.command(VX.END_PASS, []);
                cb.pass.subpass++;
                begin_subpass(vk, ctx, cb.pass);
                break;
            case "vkCmdEndRenderPass":
            case "vkCmdEndRenderPass2":
                if(!cb.pass) break;
                vx.command(VX.END_PASS, []);
                cb.pass = null;
                break;
            // Dynamic rendering (VK_KHR_dynamic_rendering)
            case "vkCmdBeginRendering":
            {
                const info = a.pRenderingInfo;
                if(!info) break;
                cb.pass = { dynamic: true, occlusion: occlusion_pool(ctx, commands, index + 1) };
                begin_rendering(vk, ctx, info, cb.pass);
                break;
            }
            case "vkCmdEndRendering":
                if(!cb.pass) break;
                vx.command(VX.END_PASS, []);
                cb.pass = null;
                break;
            case "vkCmdClearAttachments":
            {
                const attachments = (a.pAttachments || []).map(c => ({ aspect: c.aspectMask, index: c.colorAttachment,
                    clear: Array.from(c.clearValue.color.uint32 || c.clearValue.color.int32 || [0, 0, 0, 0], x => x >>> 0) }));
                const rects = (a.pRects || []).map(r => ({ x: r.rect.offset.x, y: r.rect.offset.y, width: r.rect.extent.width, height: r.rect.extent.height }));
                vx.command(VX.CLEAR_ATTACHMENTS, [], new TextEncoder().encode(JSON.stringify({ attachments, rects })));
                break;
            }

            // State
            case "vkCmdBindPipeline":
            {
                const pipeline = ctx.objects.get(a.pipeline);
                if(pipeline) vx.command(VX.BIND_PIPELINE, [pipeline.rid]);
                break;
            }
            case "vkCmdBindDescriptorSets":
            {
                const point = a.pipelineBindPoint === 1 ? 1 : 0;
                let dynamic = Array.from(a.pDynamicOffsets || []);
                (a.pDescriptorSets || []).forEach((id, k) => {
                    const set = ctx.objects.get(id);
                    if(!set) return;
                    const count = [...set.descriptors.values()].filter(d => d.type === UNIFORM_BUFFER_DYNAMIC || d.type === STORAGE_BUFFER_DYNAMIC).length;
                    const mine = dynamic.slice(0, count);
                    dynamic = dynamic.slice(count);
                    cb.sets[point].set(a.firstSet + k, [set, mine]);
                    bind_set(vk, ctx, point, a.firstSet + k, set, mine, []);
                });
                break;
            }
            case "vkCmdBindVertexBuffers":
                (a.pBuffers || []).forEach((id, i) => {
                    const place = at(ctx, id, a.pOffsets[i]);
                    if(!place) return;
                    const size = place[2].size - a.pOffsets[i];
                    vx.command(VX.SET_VERTEX_BUFFER, [a.firstBinding + i, place[0].rid, lo(place[1]), hi(place[1]), lo(size), hi(size)]);
                });
                break;
            case "vkCmdBindIndexBuffer":
            {
                const place = at(ctx, a.buffer, a.offset);
                if(!place) break;
                const size = place[2].size - a.offset;
                vx.command(VX.SET_INDEX_BUFFER, [place[0].rid, lo(place[1]), hi(place[1]), lo(size), hi(size), a.indexType]);
                break;
            }
            case "vkCmdPushConstants":
                if(a.pValues) vx.command(VX.SET_PUSH_CONSTANTS, [a.offset, a.size], a.pValues);
                break;
            case "vkCmdSetViewport":
            {
                const v = (a.pViewports || [])[0];
                if(v) vx.command(VX.SET_VIEWPORT, [v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth].map(f32_bits));
                break;
            }
            case "vkCmdSetScissor":
            {
                const r = (a.pScissors || [])[0];
                if(r) vx.command(VX.SET_SCISSOR, [r.offset.x >>> 0, r.offset.y >>> 0, r.extent.width, r.extent.height]);
                break;
            }
            case "vkCmdSetBlendConstants":
                vx.command(VX.SET_BLEND_CONSTANTS, Array.from(a.blendConstants, f32_bits));
                break;
            case "vkCmdSetStencilReference":
                vx.command(VX.SET_STENCIL_REFERENCE, [a.faceMask, a.reference]);
                break;
            case "vkCmdSetStencilCompareMask":
                vx.command(VX.SET_STENCIL_COMPARE_MASK, [a.faceMask, a.compareMask]);
                break;
            case "vkCmdSetStencilWriteMask":
                vx.command(VX.SET_STENCIL_WRITE_MASK, [a.faceMask, a.writeMask]);
                break;
            case "vkCmdSetDepthBias":
                vx.command(VX.SET_DEPTH_BIAS, [a.depthBiasConstantFactor, a.depthBiasClamp, a.depthBiasSlopeFactor].map(f32_bits));
                break;
            case "vkCmdSetLineWidth":
            case "vkCmdSetDepthBounds":
                vk.warn_once(name, name + " is kept from the pipeline (WebGPU's is static)");
                break;

            // Draws and dispatches
            case "vkCmdDraw":
                storage_writes(0);
                vx.command(VX.DRAW, [a.vertexCount, a.instanceCount, a.firstVertex, a.firstInstance]);
                break;
            case "vkCmdDrawIndexed":
                storage_writes(0);
                vx.command(VX.DRAW_INDEXED, [a.indexCount, a.instanceCount, a.firstIndex, a.vertexOffset >>> 0, a.firstInstance]);
                break;
            case "vkCmdDrawIndirect":
            case "vkCmdDrawIndexedIndirect":
            {
                const place = at(ctx, a.buffer, a.offset);
                if(!place) break;
                storage_writes(0);
                vx.command(VX.DRAW_INDIRECT, [place[0].rid, lo(place[1]), hi(place[1]), a.drawCount, a.stride, name === "vkCmdDrawIndexedIndirect" ? 1 : 0]);
                break;
            }
            case "vkCmdDispatch":
                storage_writes(1);
                vx.command(VX.DISPATCH, [a.groupCountX, a.groupCountY, a.groupCountZ]);
                break;
            case "vkCmdDispatchIndirect":
            {
                const place = at(ctx, a.buffer, a.offset);
                if(!place) break;
                storage_writes(1);
                vx.command(VX.DISPATCH_INDIRECT, [place[0].rid, lo(place[1]), hi(place[1])]);
                break;
            }

            case "vkCmdCopyBuffer":
            case "vkCmdCopyBuffer2":
            {
                const info = name === "vkCmdCopyBuffer2" ? a.pCopyBufferInfo : a;
                for(const region of info.pRegions || [])
                {
                    const src = at(ctx, info.srcBuffer, region.srcOffset), dst = at(ctx, info.dstBuffer, region.dstOffset);
                    if(!src || !dst || !region.size) continue;
                    vx.command(VX.COPY_BUFFER, [src[0].rid, lo(src[1]), hi(src[1]), dst[0].rid, lo(dst[1]), hi(dst[1]), lo(region.size), hi(region.size)]);
                    write(dst[0], dst[1], region.size);
                }
                break;
            }
            case "vkCmdFillBuffer":
            {
                const dst = at(ctx, a.dstBuffer, a.dstOffset);
                if(!dst) break;
                const size = range_size(dst[2], a.dstOffset, a.size) & ~3;
                if(size <= 0) break;
                vx.command(VX.FILL_BUFFER, [dst[0].rid, lo(dst[1]), hi(dst[1]), lo(size), hi(size), a.data]);
                write(dst[0], dst[1], size);
                break;
            }
            case "vkCmdUpdateBuffer":
            {
                const dst = at(ctx, a.dstBuffer, a.dstOffset);
                if(!dst || !a.pData) break;
                vx.command(VX.UPDATE_BUFFER, [dst[0].rid, lo(dst[1]), hi(dst[1]), a.dataSize], a.pData);
                write(dst[0], dst[1], a.dataSize);
                break;
            }
            case "vkCmdCopyBufferToImage":
            case "vkCmdCopyBufferToImage2":
            case "vkCmdCopyImageToBuffer":
            case "vkCmdCopyImageToBuffer2":
            {
                const to_image = name.startsWith("vkCmdCopyBufferToImage");
                const info = name.endsWith("2") ? (to_image ? a.pCopyBufferToImageInfo : a.pCopyImageToBufferInfo) : a;
                const buffer = to_image ? info.srcBuffer : info.dstBuffer;
                const img = image(to_image ? info.dstImage : info.srcImage);
                if(!img) break;
                for(const region of info.pRegions || [])
                {
                    const place = at(ctx, buffer, region.bufferOffset);
                    if(!place) continue;
                    const s = region.imageSubresource, o = region.imageOffset, e = region.imageExtent;
                    const layers = s.layerCount === REMAINING ? img.layers - s.baseArrayLayer : s.layerCount;
                    vx.command(VX.COPY_BUFFER_IMAGE, [to_image ? 1 : 0, place[0].rid, lo(place[1]), hi(place[1]),
                        region.bufferRowLength, region.bufferImageHeight, img.rid, s.aspectMask, s.mipLevel, s.baseArrayLayer, layers,
                        o.x, o.y, o.z, e.width, e.height, e.depth]);
                    if(!to_image)
                    {
                        // rows of the region (texels of the format's size; whole rows: a little more is no harm)
                        const texel = s.aspectMask === 4 ? 1 : s.aspectMask === 2 && img.format === 124 ? 2 : s.aspectMask === 2 ? 4 : img.texel_bytes;
                        const pitch = (region.bufferRowLength || e.width) * texel, rows = region.bufferImageHeight || e.height;
                        write(place[0], place[1], pitch * rows * Math.max(layers, e.depth));
                    }
                }
                break;
            }
            case "vkCmdCopyImage":
            case "vkCmdCopyImage2":
            {
                const info = name === "vkCmdCopyImage2" ? a.pCopyImageInfo : a;
                const src = image(info.srcImage), dst = image(info.dstImage);
                if(!src || !dst) break;
                for(const r of info.pRegions || [])
                {
                    const s = r.srcSubresource, d = r.dstSubresource;
                    const layers = s.layerCount === REMAINING ? src.layers - s.baseArrayLayer : s.layerCount;
                    vx.command(VX.COPY_IMAGE, [src.rid, s.aspectMask, s.mipLevel, s.baseArrayLayer, r.srcOffset.x, r.srcOffset.y, r.srcOffset.z,
                        dst.rid, d.aspectMask, d.mipLevel, d.baseArrayLayer, r.dstOffset.x, r.dstOffset.y, r.dstOffset.z,
                        r.extent.width, r.extent.height, r.extent.depth, layers]);
                }
                break;
            }
            case "vkCmdBlitImage":
            case "vkCmdBlitImage2":
            {
                const info = name === "vkCmdBlitImage2" ? a.pBlitImageInfo : a;
                const src = image(info.srcImage), dst = image(info.dstImage);
                if(!src || !dst) break;
                for(const r of info.pRegions || [])
                {
                    const s = r.srcSubresource, d = r.dstSubresource, so = r.srcOffsets, dof = r.dstOffsets;
                    const layers = s.layerCount === REMAINING ? src.layers - s.baseArrayLayer : s.layerCount;
                    vx.command(VX.BLIT_IMAGE, [src.rid, s.mipLevel, s.baseArrayLayer, so[0].x, so[0].y, so[0].z, so[1].x, so[1].y, so[1].z,
                        dst.rid, d.mipLevel, d.baseArrayLayer, dof[0].x, dof[0].y, dof[0].z, dof[1].x, dof[1].y, dof[1].z,
                        layers, info.filter === 1 ? 1 : 0]);
                }
                break;
            }
            case "vkCmdClearColorImage":
            case "vkCmdClearDepthStencilImage":
            {
                const img = image(a.image);
                if(!img) break;
                const color = name === "vkCmdClearColorImage";
                let values;
                if(color) values = Array.from(a.pColor.uint32 || a.pColor.int32 || [0, 0, 0, 0], v => v >>> 0);
                else
                {
                    const f = new Float32Array([a.pDepthStencil.depth]);
                    values = [new Uint32Array(f.buffer)[0], a.pDepthStencil.stencil, 0, 0];
                }
                for(const r of a.pRanges || [])
                {
                    const mips = r.levelCount === REMAINING ? img.mips - r.baseMipLevel : r.levelCount;
                    const layers = r.layerCount === REMAINING ? img.layers - r.baseArrayLayer : r.layerCount;
                    vx.command(VX.CLEAR_IMAGE, [img.rid, r.aspectMask, r.baseMipLevel, mips, r.baseArrayLayer, layers, ...values]);
                }
                break;
            }
            case "vkCmdResolveImage":
            case "vkCmdResolveImage2":
            {
                const info = name === "vkCmdResolveImage2" ? a.pResolveImageInfo : a;
                const src = image(info.srcImage), dst = image(info.dstImage);
                if(!src || !dst) break;
                for(const r of info.pRegions || [])
                {
                    const s = r.srcSubresource, d = r.dstSubresource;
                    vx.command(VX.RESOLVE_IMAGE, [src.rid, s.mipLevel, s.baseArrayLayer, r.srcOffset.x, r.srcOffset.y,
                        dst.rid, d.mipLevel, d.baseArrayLayer, r.dstOffset.x, r.dstOffset.y, r.extent.width, r.extent.height,
                        s.layerCount === REMAINING ? src.layers - s.baseArrayLayer : s.layerCount]);
                }
                break;
            }
            case "vkCmdExecuteCommands":
                for(const id of a.pCommandBuffers || [])
                {
                    const secondary = ctx.objects.get(id);
                    if(secondary) translate(vk, ctx, secondary.commands, state);
                }
                break;
            case "vkCmdSetEvent":
            case "vkCmdSetEvent2":
            case "vkCmdResetEvent":
            case "vkCmdResetEvent2":
            {
                const event = ctx.objects.get(a.event), set = name.startsWith("vkCmdSet");
                if(event) state.after.push(() => { event.set = set; });
                break;
            }
            case "vkCmdResetQueryPool":
            {
                const pool = ctx.objects.get(a.queryPool);
                if(pool) pool.available.fill(0, a.firstQuery, a.firstQuery + a.queryCount);
                break;
            }
            case "vkCmdBeginQuery":
            case "vkCmdBeginQueryIndexedEXT":
            {
                const pool = ctx.objects.get(a.queryPool);
                if(!pool) break;
                if(pool.query_type === QUERY_TYPE_OCCLUSION)
                {
                    if(cb.pass && cb.pass.occlusion === pool) vx.command(VX.BEGIN_QUERY, [pool.rid, a.query]);
                    else vk.warn_once("query-outside", "an occlusion query outside of a render pass is 0");
                }
                // (transform feedback's: VX counts the primitives of the draws that capture)
                else if(pool.query_type === QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM) vx.command(VX.BEGIN_QUERY, [pool.rid, a.query]);
                touch(pool, a.query);
                break;
            }
            case "vkCmdEndQuery":
            case "vkCmdEndQueryIndexedEXT":
            {
                const pool = ctx.objects.get(a.queryPool);
                if(pool && pool.query_type === QUERY_TYPE_OCCLUSION && cb.pass && cb.pass.occlusion === pool)
                    vx.command(VX.END_QUERY, [pool.rid, a.query, pool.memory.rid]);
                if(pool && pool.query_type === QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM) vx.command(VX.END_QUERY, [pool.rid, a.query, pool.memory.rid]);
                break;
            }
            // Transform feedback (VK_EXT_transform_feedback): the bytes a
            // capture writes are the GPU's (read back where mapped), and so
            // are the counters End writes
            case "vkCmdBindTransformFeedbackBuffersEXT":
            {
                for(let i = 0; i < a.bindingCount; i++)
                {
                    const offset = Number(a.pOffsets[i]), place = at(ctx, a.pBuffers[i], offset);
                    const buffer = ctx.objects.get(a.pBuffers[i]);
                    if(!place || !buffer) continue;
                    const size = range_size(buffer, offset, a.pSizes ? Number(a.pSizes[i]) : 2 ** 64);
                    cb.xfb[a.firstBinding + i] = [place[0], place[1], size];
                    vx.command(VX.XFB_BIND, [a.firstBinding + i, place[0].rid, lo(place[1]), hi(place[1]), lo(size), hi(size)]);
                }
                break;
            }
            case "vkCmdBeginTransformFeedbackEXT":
            case "vkCmdEndTransformFeedbackEXT":
            {
                const words = [a.firstCounterBuffer, a.counterBufferCount];
                for(let i = 0; i < a.counterBufferCount; i++)
                {
                    const id = a.pCounterBuffers && a.pCounterBuffers[i];
                    const offset = a.pCounterBufferOffsets ? Number(a.pCounterBufferOffsets[i]) : 0;
                    const place = id ? at(ctx, id, offset) : null;
                    words.push(place ? place[0].rid : 0, place ? lo(place[1]) : 0, place ? hi(place[1]) : 0);
                    if(place && name === "vkCmdEndTransformFeedbackEXT") write(place[0], place[1], 4);
                }
                if(name === "vkCmdEndTransformFeedbackEXT") for(const bound of cb.xfb) if(bound) write(bound[0], bound[1], bound[2]);
                vx.command(name === "vkCmdBeginTransformFeedbackEXT" ? VX.XFB_BEGIN : VX.XFB_END, words);
                break;
            }
            case "vkCmdWriteTimestamp":
            case "vkCmdWriteTimestamp2":
            {
                // (WebGPU has no timestamps in encoders: the time the batch is made, in ns)
                const pool = ctx.objects.get(a.queryPool);
                if(!pool) break;
                const ns = Math.floor(vk.clock() * 1e6), bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
                view.setUint32(0, lo(ns), true);
                view.setUint32(4, hi(ns), true);
                vx.command(VX.UPDATE_BUFFER, [pool.memory.rid, a.query * 8, 0, 8], bytes);
                touch(pool, a.query);
                break;
            }
            case "vkCmdCopyQueryPoolResults":
            {
                const pool = ctx.objects.get(a.queryPool), dst = at(ctx, a.dstBuffer, a.dstOffset);
                if(!pool || !dst || !a.queryCount) break;
                vx.command(VX.COPY_QUERY_RESULTS, [pool.memory.rid, a.firstQuery, a.queryCount, dst[0].rid, lo(dst[1]), hi(dst[1]), a.stride, a.flags,
                    pool.values]);
                const size = (a.flags & QUERY_RESULT_64 ? 8 : 4) * (pool.values + (a.flags & QUERY_RESULT_WITH_AVAILABILITY ? 1 : 0));
                write(dst[0], dst[1], a.stride * (a.queryCount - 1) + size);
                break;
            }
            // (one queue, in order: barriers and event waits are kept already)
            case "vkCmdPipelineBarrier":
            case "vkCmdPipelineBarrier2":
            case "vkCmdWaitEvents":
            case "vkCmdWaitEvents2":
                break;
            default:
                vk.warn_once(name, name + " is not done yet");
        }
    }
}
