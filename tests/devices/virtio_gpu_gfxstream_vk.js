#!/usr/bin/env node

// gfxstream's Vulkan streams on the virtio-gpu device (docs/gfxstream-plan.md
// G2): a test that plays the guest's driver with the guest's encoder
// (tests/devices/gfxstream_guest_protocol.js) on an ASG ring: an instance,
// its physical device, a device and its queue (the host's handles), memory
// whose blob the guest maps (VkCreateBlobGOOGLE, vkGetBlobGOOGLE, then
// RESOURCE_CREATE_BLOB of the blob id), buffers made with their memory
// requirements, a command buffer flushed as one command
// (vkQueueFlushCommandsGOOGLE) and submitted without a reply
// (vkQueueSubmitAsyncGOOGLE), a fence exported (CREATE_EXPORT_SYNC_VK on a
// ring's timeline), and a second ring's command held until the one before
// it in the process's sequence, across a snapshot.

import assert from "assert/strict";
process.on("unhandledRejection", exn => { throw exn; });

const { gfxstream_machine, GUEST_COMMANDS, GfxReader, OK, OK_MAP_INFO, HOST3D, MAPPABLE, CTX } = await import("./gfxstream_guest_driver.js");
const VX = (await import("../../src/graphics_adapters/renderer_protocol.js")).VX;

// a renderer whose memories are arrays (VX: the commands this test needs;
// a snapshot's readbacks: memories', the rest answered "not done")
let to_device = null;
const vx_memory = new Map(), vx_log = [];
const respond = (id, data) => {
    const answer = new Uint8Array(16 + (data ? data.length : 0));
    const v = new DataView(answer.buffer);
    v.setUint32(0, id, true); v.setUint32(4, data ? data.length : 0, true); v.setUint32(12, data ? 1 : 0, true);
    if(data) answer.set(data, 16);
    to_device({ "type": "write", "offset": 16 * 1024, "bytes": answer });
};
const GX_SURFACE_READBACK = 4;
const renderer = {
    "post": message => {
        if(message["type"] !== "submit") return;
        const words = new Uint32Array(message["bytes"].buffer, message["bytes"].byteOffset, message["bytes"].byteLength >> 2);
        for(let at = 4; at < words[2];)
        {
            const op = words[at], n = words[at + 1], b = words.subarray(at + 2, at + 2 + n);
            const bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            at += 2 + n;
            if(message["stream"] !== "vx")
            {
                if(message["stream"] === "gx" && op === GX_SURFACE_READBACK) respond(b[9], null);
                continue;
            }
            vx_log.push(op);
            if(op === VX.MEMORY_CREATE) vx_memory.set(b[0], new Uint8Array(b[1]));
            else if(op === VX.DESTROY) vx_memory.delete(b[0]);
            else if(op === VX.MEMORY_WRITE) vx_memory.get(b[0]).set(bytes.subarray(16, 16 + b[3]), b[1]);
            else if(op === VX.COPY_BUFFER) vx_memory.get(b[3]).set(vx_memory.get(b[0]).slice(b[1], b[1] + b[6]), b[4]);
            else if(op === VX.MEMORY_READ) respond(b[4], vx_memory.get(b[0]).slice(b[1], b[1] + b[3]));
            else if(op === VX.TEXTURE_READ) respond(b[4], null);
        }
        to_device({ "type": "done", "seq": message["seq"] });
    },
    "listen": handler => { to_device = handler; },
};

const driver = await gfxstream_machine(renderer);
const { emulator, gpu, hostmem, write_bytes, command, submit_3d, used_idx, make_ring, push, ping, replies, encode, encode_cb, call } = driver;

// The context, its rings
assert.equal(command(0x0200, 0, 3), OK, "CTX_CREATE, capset 3 (gfxstream Vulkan)");
const ring1 = driver.ring = make_ring(10, 0x100000);
const vulkan = gpu.gfxstream.vulkan;
const errors = () => assert.equal(vulkan.stats.errors, 0, vulkan.stats.last_error);

// An instance and its physical device: the host's handles
const STYPE = { INSTANCE_CREATE_INFO: 1, DEVICE_QUEUE_CREATE_INFO: 2, DEVICE_CREATE_INFO: 3, SUBMIT_INFO: 4, MEMORY_ALLOCATE_INFO: 5,
    FENCE_CREATE_INFO: 8, BUFFER_CREATE_INFO: 12, COMMAND_POOL_CREATE_INFO: 39, COMMAND_BUFFER_ALLOCATE_INFO: 40, COMMAND_BUFFER_BEGIN_INFO: 42,
    PHYSICAL_DEVICE_PROPERTIES_2: 1000059001, CREATE_BLOB_GOOGLE: 1000385002 };
let a = call("vkCreateInstance", { pCreateInfo: { sType: STYPE.INSTANCE_CREATE_INFO, pNext: null, flags: 0, pApplicationInfo: null,
    enabledLayerCount: 0, ppEnabledLayerNames: [], enabledExtensionCount: 0, ppEnabledExtensionNames: [] }, pAllocator: null, pInstance: 0 });
assert.equal(a.ret, 0, "vkCreateInstance");
const instance = a.pInstance;
assert.ok(instance > 0, "the instance: the host's handle " + instance);
a = call("vkEnumeratePhysicalDevices", { instance, pPhysicalDeviceCount: 0, pPhysicalDevices: null });
assert.deepEqual([a.ret, a.pPhysicalDeviceCount], [0, 1], "one physical device");
a = call("vkEnumeratePhysicalDevices", { instance, pPhysicalDeviceCount: 1, pPhysicalDevices: [0] });
const physical = a.pPhysicalDevices[0];
assert.equal(call("vkEnumeratePhysicalDevices", { instance, pPhysicalDeviceCount: 1, pPhysicalDevices: [0] }).pPhysicalDevices[0], physical,
    "the same each time");
// the device's extensions, as the guest asks: the count, then them all
a = call("vkEnumerateDeviceExtensionProperties", { physicalDevice: physical, pLayerName: null, pPropertyCount: 0, pProperties: null });
assert.equal(a.ret, 0);
const extension_count = a.pPropertyCount;
a = call("vkEnumerateDeviceExtensionProperties", { physicalDevice: physical, pLayerName: null, pPropertyCount: extension_count,
    pProperties: Array.from({ length: extension_count }, () => ({})) });
assert.deepEqual([a.ret, a.pPropertyCount], [0, extension_count], "all of them: VK_SUCCESS");
assert.ok(a.pProperties.some(p => p.extensionName === "VK_KHR_external_memory_fd"), "the host's external memory (the guest offers AHBs then)");
a = call("vkGetPhysicalDeviceProperties2", { physicalDevice: physical, pProperties: { sType: STYPE.PHYSICAL_DEVICE_PROPERTIES_2, pNext: null, properties: {} } });
assert.equal(a.pProperties.properties.deviceName, "v86 WebGPU");
a = call("vkGetPhysicalDeviceMemoryProperties", { physicalDevice: physical, pMemoryProperties: {} });
const types = a.pMemoryProperties.memoryTypes.slice(0, a.pMemoryProperties.memoryTypeCount);
const HOST_VISIBLE = 2;
const host_type = types.findIndex(t => t.propertyFlags & HOST_VISIBLE), local_type = types.findIndex(t => !(t.propertyFlags & HOST_VISIBLE));
assert.ok(host_type >= 0 && local_type >= 0, "host visible and device local memory");
errors();
console.log("PASS: an instance and its physical device");

// A device and its queue
a = call("vkCreateDevice", { physicalDevice: physical, pAllocator: null, pDevice: 0,
    pCreateInfo: { sType: STYPE.DEVICE_CREATE_INFO, pNext: null, flags: 0, queueCreateInfoCount: 1,
        pQueueCreateInfos: [{ sType: STYPE.DEVICE_QUEUE_CREATE_INFO, pNext: null, flags: 0, queueFamilyIndex: 0, queueCount: 1, pQueuePriorities: Float32Array.of(1) }],
        enabledLayerCount: 0, ppEnabledLayerNames: [], enabledExtensionCount: 0, ppEnabledExtensionNames: [], pEnabledFeatures: null } });
assert.equal(a.ret, 0, "vkCreateDevice");
const device = a.pDevice;
const queue = call("vkGetDeviceQueue", { device, queueFamilyIndex: 0, queueIndex: 0, pQueue: 0 }).pQueue;
assert.equal(call("vkGetDeviceQueue", { device, queueFamilyIndex: 0, queueIndex: 0, pQueue: 0 }).pQueue, queue, "the same queue each time");
errors();
console.log("PASS: a device and its queue");

// Buffers with their requirements, memory the guest maps as a blob
const buffer_info = { sType: STYPE.BUFFER_CREATE_INFO, pNext: null, flags: 0, size: 4096, usage: 3, sharingMode: 0, queueFamilyIndexCount: 0, pQueueFamilyIndices: null };
a = call("vkCreateBufferWithRequirementsGOOGLE", { device, pCreateInfo: buffer_info, pAllocator: null, pBuffer: 0, pMemoryRequirements: {} });
assert.equal(a.ret, 0);
const src = a.pBuffer;
assert.ok(a.pMemoryRequirements.size >= 4096 && a.pMemoryRequirements.memoryTypeBits & 1 << host_type, "its requirements");
const dst = call("vkCreateBufferWithRequirementsGOOGLE", { device, pCreateInfo: buffer_info, pAllocator: null, pBuffer: 0, pMemoryRequirements: {} }).pBuffer;
const BLOB_ID = 7;
a = call("vkAllocateMemory", { device, pAllocator: null, pMemory: 0, pAllocateInfo: { sType: STYPE.MEMORY_ALLOCATE_INFO,
    pNext: { sType: STYPE.CREATE_BLOB_GOOGLE, pNext: null, blobMem: HOST3D, blobFlags: 0, blobId: BLOB_ID }, allocationSize: 4096, memoryTypeIndex: host_type } });
assert.equal(a.ret, 0, "host visible memory with a blob id");
const host_memory = a.pMemory;
const local_memory = call("vkAllocateMemory", { device, pAllocator: null, pMemory: 0,
    pAllocateInfo: { sType: STYPE.MEMORY_ALLOCATE_INFO, pNext: null, allocationSize: 4096, memoryTypeIndex: local_type } }).pMemory;
assert.equal(call("vkBindBufferMemory", { device, buffer: src, memory: host_memory, memoryOffset: 0 }).ret, 0);
assert.equal(call("vkBindBufferMemory", { device, buffer: dst, memory: local_memory, memoryOffset: 0 }).ret, 0);
assert.equal(call("vkGetBlobGOOGLE", { device, memory: host_memory }).ret, 0, "vkGetBlobGOOGLE");
const MEMORY_RES = 30, MEMORY_AT = 0x400000;
assert.equal(command(0x010C, MEMORY_RES, HOST3D, MAPPABLE, 0, BLOB_ID, 0, 4096, 0), OK, "RESOURCE_CREATE_BLOB of the blob id");
assert.equal(command(0x0208, MEMORY_RES, 0, MEMORY_AT, 0), OK_MAP_INFO, "MAP_BLOB");
const pattern = Uint8Array.from({ length: 256 }, (_, i) => i * 7 & 0xFF);
write_bytes(hostmem + MEMORY_AT, pattern);
errors();
console.log("PASS: buffers with their requirements, memory mapped as its blob");

// A command buffer, flushed as one command and submitted without a reply
const pool = call("vkCreateCommandPool", { device, pAllocator: null, pCommandPool: 0,
    pCreateInfo: { sType: STYPE.COMMAND_POOL_CREATE_INFO, pNext: null, flags: 2, queueFamilyIndex: 0 } }).pCommandPool;
a = call("vkAllocateCommandBuffers", { device, pAllocateInfo: { sType: STYPE.COMMAND_BUFFER_ALLOCATE_INFO, pNext: null, commandPool: pool, level: 0, commandBufferCount: 1 },
    pCommandBuffers: [0] });
assert.equal(a.ret, 0);
const cb = a.pCommandBuffers[0];
const recorded = [
    encode_cb("vkBeginCommandBufferAsyncGOOGLE", { pBeginInfo: { sType: STYPE.COMMAND_BUFFER_BEGIN_INFO, pNext: null, flags: 1, pInheritanceInfo: null } }),
    encode_cb("vkCmdCopyBuffer", { srcBuffer: src, dstBuffer: dst, regionCount: 1, pRegions: [{ srcOffset: 0, dstOffset: 16, size: 256 }] }),
    encode_cb("vkEndCommandBufferAsyncGOOGLE", {}),
];
const data = new Uint8Array(recorded.reduce((n, c) => n + c.length, 0));
recorded.reduce((at, c) => { data.set(c, at); return at + c.length; }, 0);
call("vkQueueFlushCommandsGOOGLE", { queue, commandBuffer: cb, dataSize: data.length, pData: data });
assert.equal(vulkan.stats.flushed, 3, "the command buffer's three commands");
const fence = call("vkCreateFence", { device, pAllocator: null, pFence: 0, pCreateInfo: { sType: STYPE.FENCE_CREATE_INFO, pNext: null, flags: 0 } }).pFence;
const batches = vx_log.length;
call("vkQueueSubmitAsyncGOOGLE", { queue, submitCount: 1, fence,
    pSubmits: [{ sType: STYPE.SUBMIT_INFO, pNext: null, waitSemaphoreCount: 0, pWaitSemaphores: null, pWaitDstStageMask: null,
        commandBufferCount: 1, pCommandBuffers: [cb], signalSemaphoreCount: 0, pSignalSemaphores: null }] });
// the fence's sync file: answered once the GPU is done
const before = used_idx();
submit_3d([0xa000, device, 0, fence, 0], false, { id: 5, ring: 1 });
for(let i = 0; i < 100 && used_idx() === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(used_idx(), before + 1 & 0xFFFF, "CREATE_EXPORT_SYNC_VK's fence answered");
assert.ok(vx_log.slice(batches).includes(VX.COPY_BUFFER), "the copy went to the GPU");
const copied = [...vx_memory.values()].find(m => m.length >= 272 && m[16] === pattern[0] && m[17] === pattern[1] && m[271] === pattern[255]);
assert.ok(copied, "the guest's bytes, written through the blob, copied on the GPU");
a = call("vkWaitForFences", { device, fenceCount: 1, pFences: [fence], waitAll: 1, timeout: 0 });
assert.equal(a.ret, 0, "vkWaitForFences: signaled");
// a swapchain image of a gralloc buffer: Android's libvulkan binds it with
// VkNativeBufferANDROID in vkBindImageMemory2's chain and no memory; the
// image becomes the resource's surface (VX.TEXTURE_IMPORT)
const GRALLOC_RES = 40;
assert.equal(command(0x0204, GRALLOC_RES, 2, 67, 2 | 8, 64, 64, 1, 1, 0, 0, 0, 0), OK, "RESOURCE_CREATE_3D, a gralloc buffer");
a = call("vkCreateImage", { device, pAllocator: null, pImage: 0, pCreateInfo: { sType: 14, pNext: null, flags: 0, imageType: 1, format: 37,
    extent: { width: 64, height: 64, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0, usage: 0x10, sharingMode: 0,
    queueFamilyIndexCount: 0, pQueueFamilyIndices: null, initialLayout: 0 } });
assert.equal(a.ret, 0, "vkCreateImage");
const swapchain_image = a.pImage;
a = call("vkBindImageMemory2", { device, bindInfoCount: 1, pBindInfos: [{ sType: 1000157001, image: swapchain_image, memory: 0, memoryOffset: 0,
    pNext: { sType: 1000010000, pNext: null, handle: GRALLOC_RES, stride: 64, format: 1, usage: 0, usage2: { consumer: 0, producer: 0 } } }] });
assert.equal(a.ret, 0, "vkBindImageMemory2 with VkNativeBufferANDROID");
assert.ok([...vulkan.vk.imports.values()].some(([, resource]) => resource === GRALLOC_RES), "the swapchain image is the gralloc buffer's surface (VX.TEXTURE_IMPORT)");
errors();
console.log("PASS: a swapchain image bound to its gralloc buffer");

// vkQueueSignalReleaseImageANDROID's sync file (CREATE_QSRI_EXPORT_VK on ring
// 0): answered once the queues are idle, here at once
const before_qsri = used_idx();
submit_3d([0xa002, 0x1234, 0], false, { id: 6, ring: 0 });
for(let i = 0; i < 100 && used_idx() === before_qsri; i++) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(used_idx(), before_qsri + 1 & 0xFFFF, "CREATE_QSRI_EXPORT_VK's fence answered");
errors();
console.log("PASS: a command buffer flushed, submitted without a reply, its fence exported");

// Two rings of the process: a command holds until the one before it in sequence
const ring2 = make_ring(11, 0x200000);
const first = ++driver.seqno, second = ++driver.seqno;
push(ring2, encode("vkGetFenceStatus", { device, fence }, second));
ping(ring2);
assert.equal(replies(ring2).length, 0, "ring 2's command (number " + second + ") waits for number " + first);
// (G6: a snapshot meanwhile, restored: the command still waits on its ring,
// the process's objects and sequence go on)
const objects = gpu.gfxstream.contexts.get(CTX).decoder_state.get("vulkan").objects.size;
const state = await emulator.save_state();
await emulator.restore_state(state);
const restored = gpu.gfxstream.contexts.get(CTX);
assert.ok(restored.rings.get(ring2.res).input_length > 0, "ring 2's command kept, not decoded");
assert.equal(restored.decoder_state.get("vulkan").objects.size, objects, "the process's objects");
push(ring1, encode("vkDestroyFence", { device, fence, pAllocator: null }, first));
ping(ring1);
const r = new GfxReader(replies(ring2));
assert.equal(GUEST_COMMANDS.vkGetFenceStatus[2](r, {}).ret, 0, "then it runs: vkGetFenceStatus of a destroyed fence");
assert.equal(call("vkGetDeviceQueue", { device, queueFamilyIndex: 0, queueIndex: 0, pQueue: 0 }).pQueue, queue, "the queue's handle, as before");
errors();
console.log("PASS: two rings in the process's sequence, across a snapshot");

assert.equal(command(0x0201), OK, "CTX_DESTROY");
assert.ok(!gpu.gfxstream.contexts.has(CTX));
console.log("PASS: CTX_DESTROY");
emulator.destroy();
