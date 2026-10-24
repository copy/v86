// gfxstream's Vulkan streams (docs/gfxstream-plan.md G2): the commands of
// a context's rings in the Vulkan opcode ranges, decoded with
// gfxstream_protocol.js (generated from the guest's encoder) and run on the
// Vulkan model Venus has (venus_vk.js: its handlers take objects with the C
// names). What gfxstream does differently is here: the host allocates the
// handles (gfxstream's boxed handles), the commands of a process run in the
// order of their sequence numbers whatever ring they come on, command
// buffers are recorded by the guest and flushed as one command
// (vkQueueFlushCommandsGOOGLE), and the VK_GOOGLE_gfxstream commands
// (asynchronous submits, creation with memory requirements, host syncs,
// blobs of host visible memory, sized template updates) map onto the
// model's.

import { COMMANDS, GfxReader, GfxWriter } from "./gfxstream_protocol.js";
import { dbg_log } from "../../log.js";
import { LOG_VIRTIO } from "../../const.js";

// the Vulkan opcodes (goldfish_vk_marshaling_guest.h: OP_vkFirst_old, OP_vkFirst)
export const VK_FIRST_OLD = 20000, VK_LAST_OLD = 29999, VK_FIRST = 200000000, VK_LAST = 299999999;

const VK_SUCCESS = 0, VK_ERROR_INITIALIZATION_FAILED = -3, VK_ERROR_MEMORY_MAP_FAILED = -5, VK_ERROR_FEATURE_NOT_PRESENT = -8;
// VkStructureType
const STYPE_WRITE_DESCRIPTOR_SET = 35;
const STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA = 1000384002;
const STYPE_IMPORT_COLOR_BUFFER_GOOGLE = 1000385000, STYPE_IMPORT_BUFFER_GOOGLE = 1000385001, STYPE_CREATE_BLOB_GOOGLE = 1000385002;
// VkDescriptorType: images (sampler, combined, sampled, storage, input attachment), texel buffers, buffers
const IMAGE_DESCRIPTORS = new Set([0, 1, 2, 3, 10]), TEXEL_DESCRIPTORS = new Set([4, 5]), BUFFER_DESCRIPTORS = new Set([6, 7, 8, 9]);
// execbuffer commands with a Vulkan object (gfxstream.js runs them as sync tasks)
const CREATE_EXPORT_SYNC_VK = 0xa000, CREATE_QSRI_EXPORT_VK = 0xa002;
/** a host sync's longest wait (gfxstream's host: 5 s) */
const HOST_SYNC_TIMEOUT = 5000;
// VkFormat's of the swapchain's gralloc usage (GRALLOC_USAGE_HW_RENDER | GRALLOC_USAGE_HW_TEXTURE)
const GRALLOC_USAGE_HW = 0x200 | 0x100;

/** the gfxstream commands that are a model's under another name */
const SAME_AS = {
    vkQueueSubmitAsyncGOOGLE: "vkQueueSubmit",
    vkQueueSubmitAsync2GOOGLE: "vkQueueSubmit2",
    vkQueueWaitIdleAsyncGOOGLE: "vkQueueWaitIdle",
    vkQueueBindSparseAsyncGOOGLE: "vkQueueBindSparse",
    vkBeginCommandBufferAsyncGOOGLE: "vkBeginCommandBuffer",
    vkEndCommandBufferAsyncGOOGLE: "vkEndCommandBuffer",
    vkResetCommandBufferAsyncGOOGLE: "vkResetCommandBuffer",
    vkFreeMemorySyncGOOGLE: "vkFreeMemory",
};

/**
 * @constructor
 * @param {!Object} gfxstream the transport (gfxstream.js)
 * @param {!Object} vk the Vulkan model (venus_vk.js)
 */
export function GfxstreamVulkan(gfxstream, vk)
{
    this.gfxstream = gfxstream;
    this.vk = vk;
    /** the host's handles: any context's unique (gfxstream's boxed handles are the host's) */
    this.next_handle = 0x1000;
    this.stats = { commands: 0, flushed: 0, unknown: {}, unimplemented: {}, failures: {}, errors: 0, last_error: "" };
    /** @type {?function(string, !Object)} a harness's hook: each command and its parameters */
    this.on_command = null;
}

/** its decoders for the transport: the two ranges of Vulkan's opcodes */
GfxstreamVulkan.prototype.decoders = function()
{
    const decode = (ctx, ring, opcode, payload, reply) => this.decode(ctx, ring, opcode, payload, reply);
    return [
        { name: "vulkan", first: VK_FIRST_OLD, last: VK_LAST_OLD, decode,
            sync_task: (ctx, op, words) => this.sync_task(ctx, op, words), destroy: ctx => this.destroy(ctx) },
        { name: "vulkan", first: VK_FIRST, last: VK_LAST, decode },
    ];
};

/**
 * The context's Vulkan state (the model's context: its objects): a process's
 * @param {!Object} ctx
 */
GfxstreamVulkan.prototype.state = function(ctx)
{
    let st = ctx.decoder_state.get("vulkan");
    if(!st)
    {
        st = {
            ctx_id: ctx.id,
            objects: new Map(),
            physical_device: 0,
            /** the last sequence number run (QUEUE_SUBMIT_WITH_COMMANDS: the process's commands in order) */
            seqno: 0,
            /** the guest's blob ids (VkCreateBlobGOOGLE) -> its memory */
            blobs: new Map(),
            /** device:family:index -> the queue's handle */
            queues: new Map(),
            /** descriptor update templates: their entries */
            templates: new Map(),
            /** the host syncs' sequence numbers, by queue or command buffer */
            order: new Map(),
            since: new Map(),
        };
        this.vk.create_context(st);
        ctx.decoder_state.set("vulkan", st);
    }
    return st;
};

GfxstreamVulkan.prototype.new_handle = function()
{
    return this.next_handle++;
};

GfxstreamVulkan.prototype.error = function(what)
{
    this.stats.errors++;
    this.stats.last_error = what;
    if(this.stats.errors <= 20) dbg_log("gfxstream vulkan: " + what, LOG_VIRTIO);
};

/**
 * A command of a ring's stream: its sequence number, then its parameters
 * @return {*} null, a wait, or the transport's AGAIN (a command of another
 *     ring comes first)
 */
GfxstreamVulkan.prototype.decode = function(ctx, ring, opcode, payload, reply)
{
    const st = this.state(ctx);
    if(payload.length < 4) { this.error("command " + opcode + " without its sequence number"); return null; }
    const seqno = (payload[0] | payload[1] << 8 | payload[2] << 16 | payload[3] << 24) >>> 0;
    const ahead = seqno - st.seqno >>> 0;
    if(ahead !== 1)
    {
        // (a number already run: the guest's mistake, run it anyway)
        if(ahead === 0 || ahead > 0x80000000) this.error("sequence number " + seqno + " after " + st.seqno);
        else return this.gfxstream.AGAIN;
    }
    const entry = COMMANDS[opcode];
    if(!entry)
    {
        this.stats.unknown[opcode] = (this.stats.unknown[opcode] || 0) + 1;
        st.seqno = seqno;
        return null;
    }
    const name = entry[0];
    let a;
    try
    {
        const r = new GfxReader(payload, 4);
        a = entry[1](r);
    }
    catch(e)
    {
        this.error(name + ": " + (e && e.message || e));
        st.seqno = seqno;
        return null;
    }
    this.stats.commands++;
    let wait = null;
    try
    {
        wait = this.run(st, name, entry, a);
    }
    catch(e)
    {
        this.error(name + ": " + (e && e.message || e));
    }
    if(wait === this.gfxstream.AGAIN) return wait;
    if(this.on_command) this.on_command(name, a);
    const finish = () => {
        st.seqno = seqno;
        if(typeof a.ret === "number" && a.ret < 0) this.stats.failures[name] = a.ret;
        if(!entry[2]) return;
        const w = new GfxWriter(64);
        try
        {
            entry[2](w, a);
            reply(w.result());
        }
        catch(e)
        {
            this.error(name + "'s reply: " + (e && e.message || e));
        }
    };
    if(!wait)
    {
        finish();
        return null;
    }
    return done => /** @type {function(function())} */ (wait)(() => { finish(); done(); });
};

/**
 * A command on the model: its output handles allocated, gfxstream's own
 * commands as the model's
 * @param {!Object} st
 * @param {string} name
 * @param {!Array} entry
 * @param {!Object} a
 * @return {*}
 */
GfxstreamVulkan.prototype.run = function(st, name, entry, a)
{
    switch(name)
    {
        case "vkEnumeratePhysicalDevices":
            // (one, the same each time)
            if(a.pPhysicalDevices) a.pPhysicalDevices = a.pPhysicalDevices.map(() => st.physical_device || (st.physical_device = this.new_handle()));
            return this.model(st, name, a);
        case "vkGetDeviceQueue":
        case "vkGetDeviceQueue2":
        {
            const info = name === "vkGetDeviceQueue" ? a : a.pQueueInfo;
            const key = a.device + ":" + info.queueFamilyIndex + ":" + info.queueIndex;
            if(st.queues.has(key)) { a.pQueue = st.queues.get(key); return null; }
            a.pQueue = this.new_handle();
            st.queues.set(key, a.pQueue);
            return this.model(st, name, a);
        }
        case "vkCreateImageWithRequirementsGOOGLE":
        case "vkCreateBufferWithRequirementsGOOGLE":
        {
            const image = name === "vkCreateImageWithRequirementsGOOGLE";
            if(image) a.pImage = this.new_handle(); else a.pBuffer = this.new_handle();
            this.model(st, image ? "vkCreateImage" : "vkCreateBuffer", a);
            if(a.ret !== VK_SUCCESS) return null;
            const q = image ? { device: a.device, image: a.pImage, pMemoryRequirements: {} } : { device: a.device, buffer: a.pBuffer, pMemoryRequirements: {} };
            this.model(st, image ? "vkGetImageMemoryRequirements" : "vkGetBufferMemoryRequirements", q);
            a.pMemoryRequirements = q.pMemoryRequirements;
            return null;
        }
        case "vkAllocateMemory":
        {
            a.pMemory = this.new_handle();
            // (gfxstream's imports are of virtio-gpu resources: the model's)
            let blob = null;
            const chain = [];
            for(let s = a.pAllocateInfo.pNext; s; s = s.pNext)
            {
                if(s.sType === STYPE_CREATE_BLOB_GOOGLE) blob = s;
                else if(s.sType === STYPE_IMPORT_COLOR_BUFFER_GOOGLE) chain.push({ sType: STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA, resourceId: s.colorBuffer });
                else if(s.sType === STYPE_IMPORT_BUFFER_GOOGLE) chain.push({ sType: STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA, resourceId: s.buffer });
                else chain.push(Object.assign({}, s));
            }
            for(let i = 0; i < chain.length; i++) chain[i].pNext = chain[i + 1] || null;
            a.pAllocateInfo = Object.assign({}, a.pAllocateInfo, { pNext: chain[0] || null });
            this.model(st, name, a);
            if(a.ret === VK_SUCCESS && blob) st.blobs.set(blob.blobId, a.pMemory);
            return null;
        }
        case "vkFreeMemory":
        case "vkFreeMemorySyncGOOGLE":
            for(const [blob_id, memory] of st.blobs) if(memory === a.memory) st.blobs.delete(blob_id);
            this.model(st, "vkFreeMemory", a);
            a.ret = VK_SUCCESS;
            return null;
        case "vkGetBlobGOOGLE":
        {
            // (the memory, mappable: RESOURCE_CREATE_BLOB of its blob id next)
            const memory = st.objects.get(a.memory);
            a.ret = memory && memory.host_visible ? VK_SUCCESS : VK_ERROR_MEMORY_MAP_FAILED;
            return null;
        }
        case "vkMapMemoryIntoAddressSpaceGOOGLE":
        case "vkGetMemoryHostAddressInfoGOOGLE":
            // (the goldfish address space: not with deferred mapping)
            a.ret = VK_ERROR_MEMORY_MAP_FAILED;
            return null;
        case "vkQueueHostSyncGOOGLE":
            return this.host_sync(st, "queue " + a.queue, a.needHostSync, a.sequenceNumber, true);
        case "vkQueueFlushCommandsGOOGLE":
            this.flush_commands(st, a.commandBuffer, a.pData);
            return null;
        case "vkCreateDescriptorUpdateTemplate":
        case "vkCreateDescriptorUpdateTemplateKHR":
            a.pDescriptorUpdateTemplate = this.new_handle();
            st.templates.set(a.pDescriptorUpdateTemplate, a.pCreateInfo);
            a.ret = VK_SUCCESS;
            return null;
        case "vkDestroyDescriptorUpdateTemplate":
        case "vkDestroyDescriptorUpdateTemplateKHR":
            st.templates.delete(a.descriptorUpdateTemplate);
            return null;
        case "vkUpdateDescriptorSetWithTemplateSizedGOOGLE":
        case "vkUpdateDescriptorSetWithTemplateSized2GOOGLE":
            return this.template_update(st, a);
        case "vkGetLinearImageLayoutGOOGLE":
        case "vkGetLinearImageLayout2GOOGLE":
            // (the model's linear images: rows of the texels, no padding)
            a.pOffset = 0;
            a.pRowPitchAlignment = 1;
            return null;
        case "vkGetSwapchainGrallocUsageANDROID":
            a.grallocUsage = GRALLOC_USAGE_HW;
            a.ret = VK_SUCCESS;
            return null;
        case "vkGetSwapchainGrallocUsage2ANDROID":
            a.grallocConsumerUsage = GRALLOC_USAGE_HW;
            a.grallocProducerUsage = GRALLOC_USAGE_HW;
            a.ret = VK_SUCCESS;
            return null;
        case "vkAcquireImageANDROID":
        {
            // (the guest waits for the buffer's fence; the host signals what it was given)
            const semaphore = st.objects.get(a.semaphore), fence = st.objects.get(a.fence);
            if(semaphore) { semaphore.signaled = true; if(semaphore.timeline) semaphore.value++; }
            if(fence) fence.signaled = true;
            this.vk.wake();
            a.ret = VK_SUCCESS;
            return null;
        }
        case "vkQueueSignalReleaseImageANDROID":
        case "vkQueueSignalReleaseImageANDROIDAsyncGOOGLE":
            // (the image's work is the queue's: CREATE_QSRI_EXPORT_VK waits for it)
            a.pNativeFenceFd = -1;
            a.ret = VK_SUCCESS;
            return null;
        case "vkGetSemaphoreGOOGLE":
        case "vkTraceAsyncGOOGLE":
            a.ret = VK_SUCCESS;
            return null;
    }
    for(const p of entry[4] || [])
    {
        if(Array.isArray(a[p])) a[p] = a[p].map(() => this.new_handle());
        else if(a[p] !== null) a[p] = this.new_handle();
    }
    return this.model(st, SAME_AS[name] || name, a);
};

/**
 * The model's command (its core name for an extension's alias)
 * @return {?function(function())}
 */
GfxstreamVulkan.prototype.model = function(st, name, a)
{
    if(!this.vk.handles(name))
    {
        const core = name.replace(/(KHR|EXT)$/, "");
        if(core !== name && this.vk.handles(core)) name = core;
        else if(!name.startsWith("vkCmd")) this.stats.unimplemented[name] = (this.stats.unimplemented[name] || 0) + 1;
    }
    return this.vk.handle(st, name, a);
};

/**
 * vkQueueHostSyncGOOGLE, vkCommandBufferHostSyncGOOGLE: an encoder's work
 * on a queue or a command buffer after another's (their sequence numbers);
 * waits for the one before it at most 5 s
 * @param {boolean} can_wait (a command buffer's, in a flush: not)
 */
GfxstreamVulkan.prototype.host_sync = function(st, key, need, sequence, can_wait)
{
    const last = st.order.get(key) || 0;
    if(need && (sequence - last >>> 0) !== 1 && can_wait)
    {
        const since = st.since.get(key);
        if(since === undefined) st.since.set(key, this.vk.now);
        if(since === undefined || this.vk.now - since < HOST_SYNC_TIMEOUT) return this.gfxstream.AGAIN;
    }
    st.since.delete(key);
    st.order.set(key, sequence);
    return null;
};

/**
 * vkQueueFlushCommandsGOOGLE: a command buffer's commands as the guest
 * recorded them (opcode, size, parameters; no sequence numbers, no handle)
 * @param {!Object} st
 * @param {number} cb the command buffer
 * @param {!Uint8Array} data
 */
GfxstreamVulkan.prototype.flush_commands = function(st, cb, data)
{
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 0;
    while(p + 8 <= data.length)
    {
        const opcode = view.getUint32(p, true), size = view.getUint32(p + 4, true);
        if(size < 8 || p + size > data.length)
        {
            this.error("a command buffer's command " + opcode + " of " + size + " bytes");
            return;
        }
        const entry = COMMANDS[opcode];
        if(!entry)
        {
            this.stats.unknown[opcode] = (this.stats.unknown[opcode] || 0) + 1;
            p += size;
            continue;
        }
        const name = entry[0];
        try
        {
            const a = entry[1](new GfxReader(data, p + 8, p + size));
            a.commandBuffer = cb;
            this.stats.flushed++;
            if(this.on_command) this.on_command(name, a);
            if(name === "vkCommandBufferHostSyncGOOGLE") this.host_sync(st, "cb " + cb, a.needHostSync, a.sequenceNumber, false);
            else this.model(st, SAME_AS[name] || name, a);
        }
        catch(e)
        {
            this.error(name + " (in a command buffer): " + (e && e.message || e));
        }
        p += size;
    }
};

/**
 * vkUpdateDescriptorSetWithTemplateSized(2)GOOGLE: the template's entries'
 * descriptors in their order (image infos, buffer infos, buffer views: the
 * host's linearized template), as descriptor writes
 */
GfxstreamVulkan.prototype.template_update = function(st, a)
{
    const info = st.templates.get(a.descriptorUpdateTemplate);
    if(!info) { this.error("an update of template " + a.descriptorUpdateTemplate); return null; }
    let images = 0, buffers = 0, views = 0;
    const writes = [];
    for(const entry of info.pDescriptorUpdateEntries || [])
    {
        const type = entry.descriptorType, n = entry.descriptorCount;
        const w = { sType: STYPE_WRITE_DESCRIPTOR_SET, pNext: null, dstSet: a.descriptorSet, dstBinding: entry.dstBinding,
            dstArrayElement: entry.dstArrayElement, descriptorCount: n, descriptorType: type, pImageInfo: null, pBufferInfo: null, pTexelBufferView: null };
        if(IMAGE_DESCRIPTORS.has(type)) { w.pImageInfo = (a.pImageInfos || []).slice(images, images + n); images += n; }
        else if(BUFFER_DESCRIPTORS.has(type)) { w.pBufferInfo = (a.pBufferInfos || []).slice(buffers, buffers + n); buffers += n; }
        else if(TEXEL_DESCRIPTORS.has(type)) { w.pTexelBufferView = (a.pBufferViews || []).slice(views, views + n); views += n; }
        else continue;
        writes.push(w);
    }
    return this.model(st, "vkUpdateDescriptorSets", { device: a.device, descriptorWriteCount: writes.length, pDescriptorWrites: writes,
        descriptorCopyCount: 0, pDescriptorCopies: null });
};

/**
 * The execbuffer commands on Vulkan objects: CREATE_EXPORT_SYNC_VK (a
 * fence's signal), CREATE_QSRI_EXPORT_VK (an image's release: its queue's
 * work); their fence on the context's timeline waits for it
 * @return {(?function(function())|undefined)} undefined: not one of these
 */
GfxstreamVulkan.prototype.sync_task = function(ctx, op, words)
{
    if(op !== CREATE_EXPORT_SYNC_VK && op !== CREATE_QSRI_EXPORT_VK) return undefined;
    const st = this.state(ctx);
    const vk = this.vk;
    let check;
    if(op === CREATE_EXPORT_SYNC_VK)
    {
        const id = words[2] + words[3] * 0x100000000;
        const fence = st.objects.get(id);
        if(!fence || fence.signaled) return null;
        check = () => fence.signaled || st.objects.get(id) !== fence;
    }
    else
    {
        // (the queues' work so far)
        const queues = [...st.objects.values()].filter(o => o.type === "queue");
        if(queues.every(q => !q.pending.length && !q.inflight)) return null;
        check = () => queues.every(q => !q.pending.length && !q.inflight);
    }
    return done => {
        if(check()) done();
        else vk.add_waiter(check, Infinity, () => done());
    };
};

/** CTX_DESTROY: the process's objects go */
GfxstreamVulkan.prototype.destroy = function(ctx)
{
    const st = ctx.decoder_state.get("vulkan");
    if(st) this.vk.destroy_context(st);
};

/**
 * RESOURCE_CREATE_BLOB of a blob id: a memory's (vkAllocateMemory's
 * VkCreateBlobGOOGLE, after vkGetBlobGOOGLE)
 * @return {boolean}
 */
GfxstreamVulkan.prototype.export_memory = function(ctx, blob)
{
    const st = this.state(ctx);
    const memory = st.objects.get(st.blobs.get(blob.blob_id));
    if(!memory || !this.vk.export_memory(st, memory, blob)) return false;
    blob.memory = memory;
    return true;
};
