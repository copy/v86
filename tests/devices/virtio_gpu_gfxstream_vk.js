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
// it in the process's sequence.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { GUEST_COMMANDS, GfxReader, GfxWriter } = await import("./gfxstream_guest_protocol.js");
const VX = (await import("../../src/graphics_adapters/renderer_protocol.js")).VX;

// a renderer whose memories are arrays (VX: the commands this test needs)
let to_device = null;
const vx_memory = new Map(), vx_log = [];
const renderer = {
    "post": message => {
        if(message["type"] !== "submit") return;
        if(message["stream"] === "vx")
        {
            const words = new Uint32Array(message["bytes"].buffer, message["bytes"].byteOffset, message["bytes"].byteLength >> 2);
            for(let at = 4; at < words[2];)
            {
                const op = words[at], n = words[at + 1], b = words.subarray(at + 2, at + 2 + n);
                const bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
                at += 2 + n;
                vx_log.push(op);
                if(op === VX.MEMORY_CREATE) vx_memory.set(b[0], new Uint8Array(b[1]));
                else if(op === VX.DESTROY) vx_memory.delete(b[0]);
                else if(op === VX.MEMORY_WRITE) vx_memory.get(b[0]).set(bytes.subarray(16, 16 + b[3]), b[1]);
                else if(op === VX.COPY_BUFFER) vx_memory.get(b[3]).set(vx_memory.get(b[0]).slice(b[1], b[1] + b[6]), b[4]);
            }
        }
        to_device({ "type": "done", "seq": message["seq"] });
    },
    "listen": handler => { to_device = handler; },
};

const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const emulator = new V86({
    graphics_adapter: "virtio_gpu",
    graphics_adapter_test: { level: "gfxstream", renderer },
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321,
    autostart: true,
    memory_size: 64 << 20,
    vram_size: 16 << 20,
    net_device: { type: "none" },
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
await emulator.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await emulator.stop();

const cpu = emulator.v86.cpu, io = cpu.io;
const gpu = cpu.devices.graphics_adapter.device["virtio_gpu"];
const BDF = 0x12 << 3;
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const pci_read8 = reg => pci_read(reg & ~3) >>> 8 * (reg & 3) & 0xFF;
const hostmem = (pci_read(0x20) & ~0xF) >>> 0;
let common = 0, notify = 0;
const bar2 = (pci_read(0x18) & ~0xF) >>> 0;
for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
{
    if(pci_read8(at) !== 0x09) continue;
    const type = pci_read8(at + 3);
    if(type === 1) common = bar2 + pci_read(at + 8);
    if(type === 2) notify = bar2 + pci_read(at + 8);
}
const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
const write_bytes = (address, bytes) => bytes.forEach((b, i) => cpu.write8(address + i, b));
const read_bytes = (address, length) => Uint8Array.from({ length }, (_, i) => cpu.read8(address + i));
const w8 = (offset, value) => cpu.write8(common + offset, value);
const w16 = (offset, value) => { cpu.write8(common + offset, value & 0xFF); cpu.write8(common + offset + 1, value >> 8); };
const QUEUES = [{ size: 0, desc: 0x100000, avail: 0x101000, used: 0x102000, avail_idx: 0 },
    { size: 0, desc: 0x110000, avail: 0x111000, used: 0x112000, avail_idx: 0 }];
w8(20, 0);
w8(20, 3);
write32(common, 0);
const features0 = read32(common + 4);
write32(common + 8, 0); write32(common + 12, features0);
write32(common + 8, 1); write32(common + 12, 1);
w8(20, 11);
QUEUES.forEach((q, i) => {
    w16(22, i);
    q.size = cpu.read8(common + 24) | cpu.read8(common + 25) << 8;
    write32(common + 32, q.desc); write32(common + 36, 0);
    write32(common + 40, q.avail); write32(common + 44, 0);
    write32(common + 48, q.used); write32(common + 52, 0);
    for(let j = 0; j < 0x3000; j += 4) write32(q.desc + j, 0);
    w16(28, 1);
});
w8(20, 15);

const REQUEST = 0x200000, REPLY = 0x280000, SLOT = 0x1000;
let next_slot = 0;
const used_idx = () => read32(QUEUES[0].used) >>> 16;
function send(bytes, wait = true)
{
    const q = QUEUES[0];
    const slot = next_slot++ % 16;
    const head = slot * 2;
    write_bytes(REQUEST + slot * SLOT, bytes);
    write32(q.desc + head * 16, REQUEST + slot * SLOT); write32(q.desc + head * 16 + 4, 0);
    write32(q.desc + head * 16 + 8, bytes.length);
    cpu.write8(q.desc + head * 16 + 12, 1); cpu.write8(q.desc + head * 16 + 14, head + 1);
    write32(q.desc + (head + 1) * 16, REPLY + slot * SLOT); write32(q.desc + (head + 1) * 16 + 4, 0);
    write32(q.desc + (head + 1) * 16 + 8, 256);
    cpu.write8(q.desc + (head + 1) * 16 + 12, 2);
    write32(q.avail + 4 + (q.avail_idx % q.size) * 2, head);
    q.avail_idx = q.avail_idx + 1 & 0xFFFF;
    cpu.write8(q.avail + 2, q.avail_idx & 0xFF);
    cpu.write8(q.avail + 3, q.avail_idx >> 8);
    const before = used_idx();
    cpu.write8(notify, 0);
    cpu.write8(notify + 1, 0);
    if(wait) assert.equal(used_idx(), before + 1 & 0xFFFF, "answered at once");
    return slot;
}
const answer = slot => read32(REPLY + slot * SLOT);
const CTX = 1;
const control = (type, values, wait, fence = null) => {
    const out = new Uint32Array(6 + values.length);
    out[0] = type;
    if(fence)
    {
        out[1] = 1 | (fence.ring !== undefined ? 2 : 0);
        out[2] = fence.id;
        out[5] = fence.ring || 0;
    }
    out[4] = CTX;
    out.set(values, 6);
    return send(new Uint8Array(out.buffer), wait);
};
const command = (type, ...values) => answer(control(type, values));
const OK = 0x1100, OK_MAP_INFO = 0x1106;
const submit_3d = (words, wait, fence) => control(0x0207, [words.length * 4, 0, ...words], wait, fence);
const HOST3D = 2, MAPPABLE = 1;
const RING_SIZE = 12288, BUFFER_SIZE = 1 << 20;

// The context, its rings
assert.equal(command(0x0200, 0, 3), OK, "CTX_CREATE, capset 3 (gfxstream Vulkan)");
/** a ring of the context: its blob, CONTEXT_CREATE, mapped; the stream and the replies on it */
function make_ring(res, at)
{
    assert.equal(command(0x010C, res, HOST3D, MAPPABLE, 0, 0, 0, RING_SIZE + BUFFER_SIZE, 0), OK);
    assert.equal(answer(submit_3d([0x1001, res])), OK, "CONTEXT_CREATE");
    assert.equal(command(0x0208, res, 0, at, 0), OK_MAP_INFO);
    const ring = { res, base: hostmem + at, buffer: hostmem + at + RING_SIZE, write_offset: 0, write_pos: 0, reply_pos: 0, flags: false };
    return ring;
}
function push(ring, bytes)
{
    if(!ring.flags) { bytes = Uint8Array.of(0, 0, 0, 0, ...bytes); ring.flags = true; }
    write_bytes(ring.buffer + ring.write_offset, bytes);
    write32(ring.base + 128 + (ring.write_pos & 2047), ring.write_offset);
    write32(ring.base + 128 + (ring.write_pos & 2047) + 4, bytes.length);
    ring.write_pos = ring.write_pos + 8 >>> 0;
    write32(ring.base + 8, ring.write_pos);
    ring.write_offset = (ring.write_offset + Math.ceil(bytes.length / 4096) * 4096) % BUFFER_SIZE;
}
const ping = ring => assert.equal(answer(submit_3d([0x1002, ring.res])), OK, "PING");
/** what the device wrote back since the last read */
function replies(ring)
{
    const pos = read32(ring.base + 8192 + 8);
    const bytes = read_bytes(ring.buffer + (ring.reply_pos & BUFFER_SIZE - 1), pos - ring.reply_pos >>> 0);
    ring.reply_pos = pos;
    return bytes;
}
let seqno = 0;
/** a command as the guest encodes it: opcode, size, sequence number, parameters */
function encode(name, a, number = ++seqno)
{
    const [opcode, write] = GUEST_COMMANDS[name];
    const w = new GfxWriter(64);
    w.u32(opcode); w.u32(0); w.u32(number);
    write(w, a);
    const out = w.result().slice();
    new DataView(out.buffer).setUint32(4, out.length, true);
    return out;
}
/** a command buffer's command: opcode, size, parameters (no handle) */
function encode_cb(name, a)
{
    const [opcode, write] = GUEST_COMMANDS[name];
    const w = new GfxWriter(64);
    w.u32(opcode); w.u32(0);
    write(w, a);
    const out = w.result().slice();
    new DataView(out.buffer).setUint32(4, out.length, true);
    return out;
}
const ring1 = make_ring(10, 0x100000);
/** a command and its reply (decoded as the guest decodes it, into a) */
function call(name, a, ring = ring1)
{
    push(ring, encode(name, a));
    ping(ring);
    const read = GUEST_COMMANDS[name][2];
    if(!read) return a;
    const bytes = replies(ring);
    const r = new GfxReader(bytes);
    read(r, a);
    assert.equal(r.p, bytes.length, name + ": the reply read whole");
    return a;
}
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
errors();
console.log("PASS: a command buffer flushed, submitted without a reply, its fence exported");

// Two rings of the process: a command holds until the one before it in sequence
const ring2 = make_ring(11, 0x200000);
const first = ++seqno, second = ++seqno;
push(ring2, encode("vkGetFenceStatus", { device, fence }, second));
ping(ring2);
assert.equal(replies(ring2).length, 0, "ring 2's command (number " + second + ") waits for number " + first);
push(ring1, encode("vkDestroyFence", { device, fence, pAllocator: null }, first));
ping(ring1);
const r = new GfxReader(replies(ring2));
assert.equal(GUEST_COMMANDS.vkGetFenceStatus[2](r, {}).ret, 0, "then it runs: vkGetFenceStatus of a destroyed fence");
errors();
console.log("PASS: two rings in the process's sequence");

assert.equal(command(0x0201), OK, "CTX_DESTROY");
assert.ok(!gpu.gfxstream.contexts.has(CTX));
console.log("PASS: CTX_DESTROY");
emulator.destroy();
