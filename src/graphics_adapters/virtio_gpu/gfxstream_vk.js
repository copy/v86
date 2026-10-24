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
import { DEVICE_EXTENSIONS } from "./venus_device_info.js";
import { encode_objects, decode_objects } from "./venus_state.js";
import { dbg_log } from "../../log.js";
import { LOG_VIRTIO } from "../../const.js";

// the Vulkan opcodes (goldfish_vk_marshaling_guest.h: OP_vkFirst_old, OP_vkFirst)
export const VK_FIRST_OLD = 20000, VK_LAST_OLD = 29999, VK_FIRST = 200000000, VK_LAST = 299999999;

const VK_SUCCESS = 0, VK_ERROR_INITIALIZATION_FAILED = -3, VK_ERROR_MEMORY_MAP_FAILED = -5, VK_ERROR_FEATURE_NOT_PRESENT = -8;
// VkStructureType
const STYPE_WRITE_DESCRIPTOR_SET = 35;
const STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA = 1000384002;
const STYPE_IMPORT_COLOR_BUFFER_GOOGLE = 1000385000, STYPE_IMPORT_BUFFER_GOOGLE = 1000385001, STYPE_CREATE_BLOB_GOOGLE = 1000385002;
const STYPE_MEMORY_ALLOCATE_INFO = 5, STYPE_NATIVE_BUFFER_ANDROID = 1000010000;
const STYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO = 1000071000, STYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES = 1000071001;
// VkExternalMemoryHandleTypeFlagBits: dma-bufs (the model's imports), Android hardware buffers (the guest's)
const HANDLE_DMA_BUF = 0x200, HANDLE_AHB = 0x400;
// VkExternalMemoryFeatureFlagBits: dedicated only, exportable, importable
const EXTERNAL_MEMORY_FEATURES_AHB = 1 | 2 | 4;
/** the model's device local memory type (venus_device_info.js MEMORY_DEVICE_LOCAL): imports are of it */
const MEMORY_DEVICE_LOCAL = 0;
// VkDescriptorType: images (sampler, combined, sampled, storage, input attachment), texel buffers, buffers
const IMAGE_DESCRIPTORS = new Set([0, 1, 2, 3, 10]), TEXEL_DESCRIPTORS = new Set([4, 5]), BUFFER_DESCRIPTORS = new Set([6, 7, 8, 9]);
// execbuffer commands with a Vulkan object (gfxstream.js runs them as sync tasks)
const CREATE_EXPORT_SYNC_VK = 0xa000, CREATE_QSRI_EXPORT_VK = 0xa002;
/** a host sync's longest wait (gfxstream's host: 5 s) */
const HOST_SYNC_TIMEOUT = 5000;
// VkFormat's of the swapchain's gralloc usage (GRALLOC_USAGE_HW_RENDER | GRALLOC_USAGE_HW_TEXTURE)
const GRALLOC_USAGE_HW = 0x200 | 0x100;

/**
 * Device extensions the host says it has though the model does not: the
 * guest takes VK_KHR_external_memory_fd for the host's external memory, and
 * offers VK_ANDROID_external_memory_android_hardware_buffer then (its own:
 * color buffer imports, the model's resource imports); it does not enable it
 * on the host
 */
const HOST_EXTENSIONS = [["VK_KHR_external_memory_fd", 1]];

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
    this.stats = { commands: 0, flushed: 0, unknown: {}, unimplemented: {}, failures: {}, errors: 0, last_error: "",
        /** @type {!Array<{name: string, payload: !Uint8Array}>} the first commands that did not decode (a harness keeps them) */
        undecoded: [] };
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
            /** images of gralloc buffers (VkNativeBufferANDROID) -> the memory imported for them */
            native_images: new Map(),
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
        if(this.stats.undecoded.length < 4) this.stats.undecoded.push({ name, payload: payload.slice() });
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
        case "vkEnumerateDeviceExtensionProperties":
        {
            // (the guest's array before the model answers into it)
            const asked = a.pProperties ? a.pProperties.length : 0;
            const wait = this.model(st, name, a);
            if(a.ret < 0 || a.pLayerName) return wait;
            const extra = HOST_EXTENSIONS.filter(([n]) => !DEVICE_EXTENSIONS[n]);
            const total = Object.keys(DEVICE_EXTENSIONS).length + extra.length;
            if(!a.pProperties) { a.pPropertyCount = total; a.ret = VK_SUCCESS; return wait; }
            const all = Object.entries(DEVICE_EXTENSIONS).concat(extra).map(([extensionName, specVersion]) => ({ extensionName, specVersion }));
            a.pProperties = all.slice(0, asked);
            a.pPropertyCount = a.pProperties.length;
            a.ret = asked < total ? 5 /* VK_INCOMPLETE */ : VK_SUCCESS;
            return wait;
        }
        case "vkCreateDevice":
        {
            // (what the guest emulates, or gfxstream's host does: not the model's)
            const info = a.pCreateInfo;
            const names = info.ppEnabledExtensionNames || [];
            const kept = names.filter(n => DEVICE_EXTENSIONS[n]);
            if(kept.length !== names.length)
            {
                for(const n of names) if(!DEVICE_EXTENSIONS[n]) this.stats.unimplemented["(extension) " + n] = 1;
                a.pCreateInfo = Object.assign({}, info, { enabledExtensionCount: kept.length, ppEnabledExtensionNames: kept });
            }
            a.pDevice = this.new_handle();
            const wait = this.model(st, name, a);
            a.pCreateInfo = info;
            return wait;
        }
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
        case "vkCreateImage":
            a.pImage = this.new_handle();
            this.create_image(st, a);
            return null;
        case "vkBindImageMemory2":
        case "vkBindImageMemory2KHR":
        {
            // (a swapchain image: Android's libvulkan binds it to its gralloc
            // buffer with VkNativeBufferANDROID in the bind's chain, no memory)
            const binds = [];
            for(const bind of a.pBindInfos || [])
            {
                let native = null;
                for(let c = bind.pNext; c; c = c.pNext) if(c.sType === STYPE_NATIVE_BUFFER_ANDROID) native = c;
                if(!native) { binds.push(bind); continue; }
                const ret = this.bind_native(st, a.device, bind.image, native.handle);
                if(ret !== VK_SUCCESS) { a.ret = ret; return null; }
            }
            if(!binds.length) { a.ret = VK_SUCCESS; return null; }
            const rest = Object.assign({}, a, { bindInfoCount: binds.length, pBindInfos: binds });
            const wait = this.model(st, "vkBindImageMemory2", rest);
            a.ret = rest.ret;
            return wait;
        }
        case "vkDestroyImage":
        {
            const memory = st.native_images.get(a.image);
            this.model(st, name, a);
            if(memory) { st.native_images.delete(a.image); this.model(st, "vkFreeMemory", { device: a.device, memory, pAllocator: null }); }
            return null;
        }
        case "vkCreateImageWithRequirementsGOOGLE":
        case "vkCreateBufferWithRequirementsGOOGLE":
        {
            const image = name === "vkCreateImageWithRequirementsGOOGLE";
            if(image) { a.pImage = this.new_handle(); this.create_image(st, a); }
            else { a.pBuffer = this.new_handle(); this.model(st, "vkCreateBuffer", a); }
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
        case "vkGetPhysicalDeviceImageFormatProperties2":
        case "vkGetPhysicalDeviceImageFormatProperties2KHR":
        {
            // Android hardware buffers: gralloc's, virtio-gpu resources the
            // model imports as it imports dma-bufs (the guest keeps only AHB's
            // bits of what the host says)
            let ahb = false;
            const chain = [];
            for(let s = a.pImageFormatInfo.pNext; s; s = s.pNext)
            {
                const copy = Object.assign({}, s);
                if(s.sType === STYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO && s.handleType === HANDLE_AHB) { copy.handleType = HANDLE_DMA_BUF; ahb = true; }
                chain.push(copy);
            }
            if(!ahb) return this.model(st, "vkGetPhysicalDeviceImageFormatProperties2", a);
            for(let i = 0; i < chain.length; i++) chain[i].pNext = chain[i + 1] || null;
            const info = a.pImageFormatInfo;
            a.pImageFormatInfo = Object.assign({}, info, { pNext: chain[0] || null });
            this.model(st, "vkGetPhysicalDeviceImageFormatProperties2", a);
            a.pImageFormatInfo = info;
            for(let s = a.pImageFormatProperties.pNext; s; s = s.pNext)
            {
                if(s.sType !== STYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES || a.ret !== VK_SUCCESS) continue;
                s.externalMemoryProperties = { externalMemoryFeatures: EXTERNAL_MEMORY_FEATURES_AHB,
                    exportFromImportedHandleTypes: HANDLE_AHB, compatibleHandleTypes: HANDLE_AHB };
            }
            return null;
        }
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
 * vkCreateImage: an image of a gralloc buffer (VkNativeBufferANDROID: the
 * guest put its virtio-gpu resource's id in the handle) is the model's
 * image bound to the resource, imported as memory
 * @param {!Object} st
 * @param {!Object} a vkCreateImage's parameters, pImage allocated
 */
GfxstreamVulkan.prototype.create_image = function(st, a)
{
    let native = null;
    const chain = [];
    for(let s = a.pCreateInfo.pNext; s; s = s.pNext)
    {
        if(s.sType === STYPE_NATIVE_BUFFER_ANDROID) native = s;
        else chain.push(Object.assign({}, s));
    }
    if(!native)
    {
        this.model(st, "vkCreateImage", a);
        return;
    }
    for(let i = 0; i < chain.length; i++) chain[i].pNext = chain[i + 1] || null;
    a.pCreateInfo = Object.assign({}, a.pCreateInfo, { pNext: chain[0] || null });
    this.model(st, "vkCreateImage", a);
    if(a.ret !== VK_SUCCESS) return;
    a.ret = this.bind_native(st, a.device, a.pImage, native.handle);
    if(a.ret !== VK_SUCCESS) this.model(st, "vkDestroyImage", { device: a.device, image: a.pImage, pAllocator: null });
};

/**
 * An image of a gralloc buffer (VkNativeBufferANDROID, its handle the
 * virtio-gpu resource): memory imported from the resource, bound to it,
 * freed with the image
 * @return {number} the VkResult
 */
GfxstreamVulkan.prototype.bind_native = function(st, device, image, resource_id)
{
    if(st.native_images.has(image)) return VK_SUCCESS;
    const q = { device, image, pMemoryRequirements: {} };
    this.model(st, "vkGetImageMemoryRequirements", q);
    const memory = this.new_handle();
    const alloc = { device, pAllocator: null, pMemory: memory, pAllocateInfo: { sType: STYPE_MEMORY_ALLOCATE_INFO,
        pNext: { sType: STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA, pNext: null, resourceId: resource_id },
        allocationSize: q.pMemoryRequirements.size || 1, memoryTypeIndex: MEMORY_DEVICE_LOCAL } };
    this.model(st, "vkAllocateMemory", alloc);
    if(alloc.ret !== VK_SUCCESS)
    {
        this.error("the gralloc buffer of resource " + resource_id + ": not importable (" + alloc.ret + ")");
        return alloc.ret;
    }
    const bind = { device, image, memory, memoryOffset: 0 };
    this.model(st, "vkBindImageMemory", bind);
    st.native_images.set(image, memory);
    return bind.ret === undefined ? VK_SUCCESS : bind.ret;
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

// Snapshots (G6): a context's objects and tables as Venus's are saved
// (venus_state.js); the model makes the renderer's objects again

/** the key of a context's own tables among its objects in a snapshot (handles start at 0x1000) */
const TABLES = -1;

/** @return {!Array} */
GfxstreamVulkan.prototype.get_state = function()
{
    return [this.next_handle, this.vk.get_state()];
};

/**
 * @param {!Array} state from get_state
 * @param {!Array<!Object>} contexts the contexts' Vulkan states, restored (restore_context)
 */
GfxstreamVulkan.prototype.set_state = function(state, contexts)
{
    const [next_handle, model] = state;
    this.next_handle = next_handle;
    this.vk.set_state(model, contexts);
};

/**
 * A context's Vulkan state for a snapshot: its objects, its tables
 * @param {!Object} ctx
 * @param {function(!Object): Array} outside [kind, id] of an object owned elsewhere (a blob)
 * @return {?string}
 */
GfxstreamVulkan.prototype.save_context = function(ctx, outside)
{
    const st = ctx.decoder_state.get("vulkan");
    if(!st) return null;
    const objects = new Map(st.objects);
    objects.set(TABLES, { physical_device: st.physical_device, seqno: st.seqno, blobs: st.blobs, queues: st.queues,
        templates: st.templates, order: st.order, native_images: st.native_images });
    return encode_objects(objects, o => o === st ? ["ctx", ctx.id] : outside(o));
};

/**
 * @param {!Object} ctx the restored context
 * @param {string} json from save_context
 * @param {function(number): Object} blob_of the restored blob of a resource id
 * @return {!Object} its Vulkan state
 */
GfxstreamVulkan.prototype.restore_context = function(ctx, json, blob_of)
{
    const st = this.state(ctx);
    const objects = decode_objects(json, ([kind, x]) => kind === "ctx" ? st : kind === "blob" ? blob_of(x) : null);
    const tables = objects.get(TABLES);
    objects.delete(TABLES);
    st.objects = objects;
    st.physical_device = tables.physical_device;
    st.seqno = tables.seqno;
    for(const key of ["blobs", "queues", "templates", "order", "native_images"]) st[key] = tables[key];
    st.since = new Map();
    return st;
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
