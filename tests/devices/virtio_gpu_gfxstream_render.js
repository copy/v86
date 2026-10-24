#!/usr/bin/env node

// gfxstream on a real renderer (headless Chrome's WebGPU,
// tests/x64/gpu_remote_renderer.mjs): Android's gralloc buffers as Vulkan
// sees them (docs/gfxstream-plan.md G3), the steps of
// tests/a64/android/vkahb.c played by hand: a virtio-gpu resource
// (RESOURCE_CREATE_3D, as minigbm makes an AHB), an image of it
// (VkImportColorBufferGOOGLE in vkAllocateMemory), cleared on the GPU, then
// read back with TRANSFER_FROM_HOST_3D as gralloc's lock does.

import assert from "assert/strict";
process.on("unhandledRejection", exn => { throw exn; });

const { gfxstream_machine, OK } = await import("./gfxstream_guest_driver.js");
const { create_remote_renderer } = await import("../x64/gpu_remote_renderer.mjs");

const remote = await create_remote_renderer();
const driver = await gfxstream_machine(remote.renderer);
const { emulator, gpu, command, control, submit_3d, settle, make_ring, call, encode_cb, read_bytes } = driver;
const vulkan = gpu.gfxstream.vulkan;
const errors = () => assert.equal(vulkan.stats.errors, 0, vulkan.stats.last_error);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

assert.equal(command(0x0200, 0, 3), OK, "CTX_CREATE, capset 3 (gfxstream Vulkan)");
driver.ring = make_ring(10, 0x100000);

const STYPE = { INSTANCE_CREATE_INFO: 1, DEVICE_QUEUE_CREATE_INFO: 2, DEVICE_CREATE_INFO: 3, SUBMIT_INFO: 4, MEMORY_ALLOCATE_INFO: 5,
    FENCE_CREATE_INFO: 8, IMAGE_CREATE_INFO: 14, COMMAND_POOL_CREATE_INFO: 39, COMMAND_BUFFER_ALLOCATE_INFO: 40, COMMAND_BUFFER_BEGIN_INFO: 42,
    IMAGE_MEMORY_BARRIER: 45, EXTERNAL_MEMORY_IMAGE_CREATE_INFO: 1000072001, MEMORY_DEDICATED_ALLOCATE_INFO: 1000127001,
    IMPORT_COLOR_BUFFER_GOOGLE: 1000385000 };
const instance = call("vkCreateInstance", { pCreateInfo: { sType: STYPE.INSTANCE_CREATE_INFO, pNext: null, flags: 0, pApplicationInfo: null,
    enabledLayerCount: 0, ppEnabledLayerNames: [], enabledExtensionCount: 0, ppEnabledExtensionNames: [] }, pAllocator: null, pInstance: 0 }).pInstance;
const physical = call("vkEnumeratePhysicalDevices", { instance, pPhysicalDeviceCount: 1, pPhysicalDevices: [0] }).pPhysicalDevices[0];
const device = call("vkCreateDevice", { physicalDevice: physical, pAllocator: null, pDevice: 0,
    pCreateInfo: { sType: STYPE.DEVICE_CREATE_INFO, pNext: null, flags: 0, queueCreateInfoCount: 1,
        pQueueCreateInfos: [{ sType: STYPE.DEVICE_QUEUE_CREATE_INFO, pNext: null, flags: 0, queueFamilyIndex: 0, queueCount: 1, pQueuePriorities: Float32Array.of(1) }],
        enabledLayerCount: 0, ppEnabledLayerNames: [], enabledExtensionCount: 0, ppEnabledExtensionNames: [], pEnabledFeatures: null } }).pDevice;
const queue = call("vkGetDeviceQueue", { device, queueFamilyIndex: 0, queueIndex: 0, pQueue: 0 }).pQueue;
errors();

// The AHB: a resource as minigbm makes it (R8G8B8A8, render target and
// sampler view), its backing in guest memory
const RES = 40, W = 64, H = 64, BACKING = 0x800000;
assert.equal(command(0x0204, RES, 2, 67, 2 | 8, W, H, 1, 1, 0, 0, 0, 0), OK, "RESOURCE_CREATE_3D");
assert.equal(command(0x0106, RES, 1, BACKING, 0, W * H * 4, 0), OK, "RESOURCE_ATTACH_BACKING");

// An image of it, as vkahb makes it and the guest's driver imports it
let a = call("vkCreateImage", { device, pAllocator: null, pImage: 0, pCreateInfo: { sType: STYPE.IMAGE_CREATE_INFO,
    pNext: { sType: STYPE.EXTERNAL_MEMORY_IMAGE_CREATE_INFO, pNext: null, handleTypes: 0x400 },
    flags: 0, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0,
    usage: 0x2 | 0x4 | 0x10, sharingMode: 0, queueFamilyIndexCount: 0, pQueueFamilyIndices: null, initialLayout: 0 } });
assert.equal(a.ret, 0, "vkCreateImage");
const image = a.pImage;
a = call("vkAllocateMemory", { device, pAllocator: null, pMemory: 0, pAllocateInfo: { sType: STYPE.MEMORY_ALLOCATE_INFO,
    pNext: { sType: STYPE.MEMORY_DEDICATED_ALLOCATE_INFO, image, buffer: 0,
        pNext: { sType: STYPE.IMPORT_COLOR_BUFFER_GOOGLE, pNext: null, colorBuffer: RES } },
    allocationSize: W * H * 4, memoryTypeIndex: 0 } });
assert.equal(a.ret, 0, "vkAllocateMemory importing the resource");
const memory = a.pMemory;
assert.equal(call("vkBindImageMemory", { device, image, memory, memoryOffset: 0 }).ret, 0, "vkBindImageMemory");
assert.ok([...vulkan.vk.imports.values()].some(([, resource]) => resource === RES), "the image is the resource's surface");
errors();

const pool = call("vkCreateCommandPool", { device, pAllocator: null, pCommandPool: 0,
    pCreateInfo: { sType: STYPE.COMMAND_POOL_CREATE_INFO, pNext: null, flags: 2, queueFamilyIndex: 0 } }).pCommandPool;
const cb = call("vkAllocateCommandBuffers", { device, pAllocateInfo: { sType: STYPE.COMMAND_BUFFER_ALLOCATE_INFO, pNext: null, commandPool: pool,
    level: 0, commandBufferCount: 1 }, pCommandBuffers: [0] }).pCommandBuffers[0];
const range = { aspectMask: 1, baseMipLevel: 0, levelCount: 1, baseArrayLayer: 0, layerCount: 1 };
let next_fence = 5;

/**
 * The image cleared on the GPU (as vkahb does: to the transfer layout, the
 * clear, released to gralloc's), then the resource read back as gralloc's
 * lock does (TRANSFER_FROM_HOST_3D into the backing)
 */
async function clear_and_read(image, res, colour, what)
{
    const barrier = (old_layout, new_layout, src, dst) => ({ srcStageMask: 1, dstStageMask: 0x1000, dependencyFlags: 0,
        memoryBarrierCount: 0, pMemoryBarriers: null, bufferMemoryBarrierCount: 0, pBufferMemoryBarriers: null, imageMemoryBarrierCount: 1,
        pImageMemoryBarriers: [{ sType: STYPE.IMAGE_MEMORY_BARRIER, pNext: null, srcAccessMask: src, dstAccessMask: dst, oldLayout: old_layout,
            newLayout: new_layout, srcQueueFamilyIndex: 0xFFFFFFFF, dstQueueFamilyIndex: 0xFFFFFFFF, image, subresourceRange: range }] });
    const recorded = [
        encode_cb("vkBeginCommandBufferAsyncGOOGLE", { pBeginInfo: { sType: STYPE.COMMAND_BUFFER_BEGIN_INFO, pNext: null, flags: 1, pInheritanceInfo: null } }),
        encode_cb("vkCmdPipelineBarrier", barrier(0, 7, 0, 0x1000)),
        encode_cb("vkCmdClearColorImage", { image, imageLayout: 7, pColor: { float32: Float32Array.from(colour) }, rangeCount: 1, pRanges: [range] }),
        encode_cb("vkCmdPipelineBarrier", barrier(7, 1, 0x1000, 0)),
        encode_cb("vkEndCommandBufferAsyncGOOGLE", {}),
    ];
    const data = new Uint8Array(recorded.reduce((n, c) => n + c.length, 0));
    recorded.reduce((at, c) => { data.set(c, at); return at + c.length; }, 0);
    call("vkQueueFlushCommandsGOOGLE", { queue, commandBuffer: cb, dataSize: data.length, pData: data });
    const fence = call("vkCreateFence", { device, pAllocator: null, pFence: 0, pCreateInfo: { sType: STYPE.FENCE_CREATE_INFO, pNext: null, flags: 0 } }).pFence;
    call("vkQueueSubmitAsyncGOOGLE", { queue, submitCount: 1, fence,
        pSubmits: [{ sType: STYPE.SUBMIT_INFO, pNext: null, waitSemaphoreCount: 0, pWaitSemaphores: null, pWaitDstStageMask: null,
            commandBufferCount: 1, pCommandBuffers: [cb], signalSemaphoreCount: 0, pSignalSemaphores: null }] });
    submit_3d([0xa000, device, 0, fence, 0], false, { id: next_fence++, ring: 1 });
    await settle(what + ": CREATE_EXPORT_SYNC_VK of the clear's fence");
    assert.equal(call("vkGetFenceStatus", { device, fence }).ret, 0, what + ": the fence signaled");
    call("vkDestroyFence", { device, fence, pAllocator: null });
    errors();
    control(0x0206, [0, 0, 0, W, H, 1, 0, 0, res, 0, W * 4, 0], false);
    await settle(what + ": TRANSFER_FROM_HOST_3D");
    const pixels = read_bytes(BACKING, W * H * 4);
    const expected = colour.map(c => Math.round(c * 255));
    let wrong = 0;
    for(let i = 0; i < W * H; i++) if(expected.some((v, k) => Math.abs(pixels[i * 4 + k] - v) > 1)) wrong++;
    assert.equal(wrong, 0, `${what}: pixels of the clear colour ${expected}: pixel 0 is ${[...pixels.subarray(0, 4)]}`);
}
await clear_and_read(image, RES, [0.25, 0.5, 0.75, 1], "the AHB");
console.log("PASS: an AHB's image cleared on the GPU, read back through its resource");

// A swapchain image: Android's libvulkan binds it to its gralloc buffer with
// VkNativeBufferANDROID in vkBindImageMemory2's chain and no memory
const SWAPCHAIN_RES = 41;
assert.equal(command(0x0204, SWAPCHAIN_RES, 2, 67, 2 | 8, W, H, 1, 1, 0, 0, 0, 0), OK, "RESOURCE_CREATE_3D, a window's buffer");
assert.equal(command(0x0106, SWAPCHAIN_RES, 1, BACKING, 0, W * H * 4, 0), OK, "RESOURCE_ATTACH_BACKING");
a = call("vkCreateImage", { device, pAllocator: null, pImage: 0, pCreateInfo: { sType: STYPE.IMAGE_CREATE_INFO, pNext: null,
    flags: 0, imageType: 1, format: 37, extent: { width: W, height: H, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1, tiling: 0,
    usage: 0x2 | 0x10, sharingMode: 0, queueFamilyIndexCount: 0, pQueueFamilyIndices: null, initialLayout: 0 } });
assert.equal(a.ret, 0, "vkCreateImage");
const swapchain_image = a.pImage;
a = call("vkBindImageMemory2", { device, bindInfoCount: 1, pBindInfos: [{ sType: 1000157001, image: swapchain_image, memory: 0, memoryOffset: 0,
    pNext: { sType: 1000010000, pNext: null, handle: SWAPCHAIN_RES, stride: W, format: 1, usage: 0, usage2: { consumer: 0, producer: 0 } } }] });
assert.equal(a.ret, 0, "vkBindImageMemory2 with VkNativeBufferANDROID");
await clear_and_read(swapchain_image, SWAPCHAIN_RES, [1, 0.5, 0, 1], "the swapchain image");
console.log("PASS: a swapchain image cleared on the GPU, read back through its gralloc buffer");

emulator.destroy();
remote.close();
await wait(10);
