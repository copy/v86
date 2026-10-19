#!/usr/bin/env node

// virtio-gpu's Venus transport (level venus, src/graphics_adapters/virtio_gpu/
// venus.js), driven as Mesa's venus driver drives it: the capset, a context
// of capset 4, shared memory (HOST3D blobs of blob id 0) mapped into BAR4, a
// ring in it (vkCreateRingMESA), commands through the ring with their
// replies in a reply stream, the ring's head, ALIVE and FATAL status bits,
// indirect streams (vkExecuteCommandStreamsMESA), the seqno waits of
// SUBMIT_3D and of rings, and the instance and physical device queries that
// vulkaninfo makes. tests/devices/venus_guest_protocol.js (generated with
// the device's protocol, from Mesa's) encodes requests and decodes replies.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { GUEST, VenusReader, VenusWriter } = await import("./venus_guest_protocol.js");

// A renderer that keeps VX memory as bytes and runs its copies, fills,
// updates and reads; it answers at once (images and draws are not its)
const VX = (await import("../../src/graphics_adapters/renderer_protocol.js")).VX;
let to_device = null;
const vx_memory = new Map(), vx_log = [];
/** while held, batches wait for flush_renderer() (the GPU is slow) */
let held = null;
const flush_renderer = () => { const messages = held; held = null; for(const m of messages) renderer.post(m); };
const renderer = {
    "post": message => {
        if(message["type"] !== "submit") return;
        if(held) { held.push(message); return; }
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
                else if(op === VX.FILL_BUFFER) new DataView(vx_memory.get(b[0]).buffer).setUint32(b[1], b[5], true);
                else if(op === VX.MEMORY_READ)
                {
                    const data = vx_memory.get(b[0]).slice(b[1], b[1] + b[3]);
                    const answer = new Uint8Array(16 + data.length);
                    const v = new DataView(answer.buffer);
                    v.setUint32(0, b[4], true); v.setUint32(4, data.length, true); v.setUint32(12, 1, true);
                    answer.set(data, 16);
                    to_device({ "type": "write", "offset": 16 * 1024, "bytes": answer });
                }
            }
        }
        to_device({ "type": "done", "seq": message["seq"] });
    },
    "listen": handler => { to_device = handler; },
};

// hlt forever
const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const emulator = new V86({
    graphics_adapter: "virtio_gpu",
    graphics_adapter_test: { level: "venus", renderer },
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

// BAR4: 128 MiB at level venus
const HOSTMEM = 128 << 20;
const hostmem = (pci_read(0x20) & ~0xF) >>> 0;
assert.ok(hostmem && hostmem % HOSTMEM === 0, "BAR4 placed: " + hostmem.toString(16));

let common = 0, notify = 0;
const bar2 = (pci_read(0x18) & ~0xF) >>> 0;
for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
{
    if(pci_read8(at) !== 0x09) continue;
    const type = pci_read8(at + 3);
    if(type === 1) common = bar2 + pci_read(at + 8);
    if(type === 2) notify = bar2 + pci_read(at + 8);
}

// The transport
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
assert.equal(features0 & 0x19, 0x19, "VIRGL, RESOURCE_BLOB, CONTEXT_INIT");
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

// One request at a time, each in its own slot; `done(slot)` says whether it was answered
const REQUEST = 0x200000, REPLY = 0x280000, SLOT = 0x1000;
let next_slot = 0;
function send(bytes, wait = true)
{
    const q = QUEUES[0];
    const slot = next_slot++ % 16;
    const head = slot * 2;
    write_bytes(REQUEST + slot * SLOT, bytes);
    for(let i = 0; i < 256; i += 4) write32(REPLY + slot * SLOT + i, 0xDEADBEEF);
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
    const before = read32(q.used) >>> 16;
    cpu.write8(notify, 0);
    cpu.write8(notify + 1, 0);
    if(wait) assert.equal(read32(q.used) >>> 16, before + 1 & 0xFFFF, "answered at once");
    return slot;
}
const answer = slot => read32(REPLY + slot * SLOT);
const CTX = 1;
const control = (type, values, wait) => {
    const out = new Uint32Array(6 + values.length);
    out[0] = type;
    out[4] = CTX;
    out.set(values, 6);
    return send(new Uint8Array(out.buffer), wait);
};
const command = (type, ...values) => answer(control(type, values));
const OK = 0x1100, OK_CAPSET_INFO = 0x1102, OK_CAPSET = 0x1103, OK_MAP_INFO = 0x1106, ERR_INVALID_PARAMETER = 0x1205;

// ---------------------------------------------------------------------------
// The capset

let slot = control(0x0108, [2, 0]);
assert.equal(answer(slot), OK_CAPSET_INFO, "GET_CAPSET_INFO 2");
assert.deepEqual([read32(REPLY + slot * SLOT + 24), read32(REPLY + slot * SLOT + 28), read32(REPLY + slot * SLOT + 32)],
    [4, 0, 160], "capset 4 (Venus), version 0, 160 bytes");
slot = control(0x0109, [4, 0]);
assert.equal(answer(slot), OK_CAPSET, "GET_CAPSET 4");
const capset = Array.from({ length: 40 }, (_, i) => read32(REPLY + slot * SLOT + 24 + i * 4));
assert.equal(capset[0], 1, "wire format 1");
assert.equal(capset[1], (1 << 22 | 4 << 12 | 343) >>> 0, "vk.xml 1.4.343, Mesa 26.1.6's protocol");
assert.equal(capset[4], 1, "supports_blob_id_0");
assert.equal(capset[5] & 1, 0, "the extension mask's bit 0 clear: every extension of the protocol");
assert.deepEqual(capset.slice(37), [1, 1, 0], "allow_vk_wait_syncs, supports_multiple_timelines, not use_guest_vram");
console.log("PASS: the Venus capset");

// A context of capset 4 (CONTEXT_INIT)
assert.equal(command(0x0200, 0, 4), OK, "CTX_CREATE, capset 4");
assert.ok(gpu.venus.contexts.has(CTX));

// Shared memory: the ring's and the replies'
const RING_RES = 10, REPLY_RES = 11, STREAM_RES = 12;
const RING_SIZE = 0x21000, RING_AT = 0x100000, REPLY_AT = 0x200000, STREAM_AT = 0x300000;
const HOST3D = 2, MAPPABLE = 1;
const blob = (res, size, at) => {
    assert.equal(command(0x010C, res, HOST3D, MAPPABLE, 0, 0, 0, size, 0), OK, "RESOURCE_CREATE_BLOB, blob id 0");
    assert.equal(command(0x0208, res, 0, at, 0), OK_MAP_INFO, "MAP_BLOB");
};
blob(RING_RES, RING_SIZE, RING_AT);
blob(REPLY_RES, 0x10000, REPLY_AT);
blob(STREAM_RES, 0x10000, STREAM_AT);
assert.equal(command(0x010C, 13, HOST3D, MAPPABLE, 0, 0x1234, 0, 4096, 0), ERR_INVALID_PARAMETER, "blob id of no memory");

/** Encode commands */
const encode = (...commands) => {
    const w = new VenusWriter(64);
    for(const [name, a] of commands) GUEST[name][0](w, a);
    return w.result();
};
/** SUBMIT_3D of Venus commands */
const submit_3d = (bytes, wait) => {
    const words = new Uint32Array(Math.ceil(bytes.length / 4));
    new Uint8Array(words.buffer).set(bytes);
    return control(0x0207, [bytes.length, 0, ...words], wait);
};

// The ring (Mesa's layout: head, tail, status 64 bytes apart, then the buffer)
const RING_ID = 0x7f0012345678, HEAD = 0, TAIL = 64, STATUS = 128, BUFFER = 192, BUFFER_SIZE = 0x20000, EXTRA = BUFFER + BUFFER_SIZE;
const ring_base = hostmem + RING_AT;
assert.equal(answer(submit_3d(encode(["vkCreateRingMESA", { ring: RING_ID, pCreateInfo: {
    sType: 1000384000, pNext: { sType: 1000384006, maxReportingPeriodMicroseconds: 3000000 },
    resourceId: RING_RES, offset: 0, size: RING_SIZE, idleTimeout: 1000000,
    headOffset: HEAD, tailOffset: TAIL, statusOffset: STATUS, bufferOffset: BUFFER, bufferSize: BUFFER_SIZE,
    extraOffset: EXTRA, extraSize: 64 } }]))), OK, "vkCreateRingMESA");
assert.equal(read32(ring_base + STATUS) & 4, 4, "ALIVE");

let tail = 0;
/** Commands into the ring; the device reads them when the machine's timers run */
const ring_write = (bytes, run = true) => {
    for(let i = 0; i < bytes.length; i++) cpu.write8(ring_base + BUFFER + (tail + i & BUFFER_SIZE - 1), bytes[i]);
    tail = tail + bytes.length >>> 0;
    write32(ring_base + TAIL, tail);
    if(run) cpu.devices.display.timer(cpu.clock.now());
};
let reply_position = 0;
/** A command with a reply, as the driver sends it: the reply stream first */
const call = (name, a) => {
    const at = reply_position;
    ring_write(encode(["vkSetReplyCommandStreamMESA", { pStream: { resourceId: REPLY_RES, offset: at, size: 0x1000 } }],
        [name, { cmd_flags: 1, ...a }]));
    assert.equal(read32(ring_base + HEAD), tail, name + ": the head is at the tail");
    reply_position = (reply_position + 0x1000) % 0x10000;
    const bytes = read_bytes(hostmem + REPLY_AT + at, 0x1000);
    const reply = GUEST[name][1](new VenusReader(bytes));
    return reply;
};

let reply = call("vkEnumerateInstanceVersion", { pApiVersion: 0 });
assert.equal(reply.ret, 0);
assert.equal(reply.pApiVersion >>> 12, 1 << 10 | 1, "Vulkan 1.1");
console.log("PASS: a ring, a command and its reply");

// ---------------------------------------------------------------------------
// What vulkaninfo and the driver ask

const INSTANCE = 0x1000, PHYSICAL_DEVICE = 0x2000;
reply = call("vkCreateInstance", { pCreateInfo: { sType: 1, pApplicationInfo: { sType: 0, pApplicationName: "venus test",
    apiVersion: 1 << 22 | 1 << 12 }, enabledExtensionCount: 0 }, pInstance: INSTANCE });
assert.equal(reply.ret, 0, "vkCreateInstance");

reply = call("vkEnumeratePhysicalDevices", { instance: INSTANCE, pPhysicalDeviceCount: 0, pPhysicalDevices: null });
assert.deepEqual([reply.ret, reply.pPhysicalDeviceCount], [0, 1], "one physical device");
reply = call("vkEnumeratePhysicalDevices", { instance: INSTANCE, pPhysicalDeviceCount: 1, pPhysicalDevices: [PHYSICAL_DEVICE] });
assert.deepEqual([reply.ret, reply.pPhysicalDeviceCount, reply.pPhysicalDevices], [0, 1, [PHYSICAL_DEVICE]]);

reply = call("vkEnumeratePhysicalDeviceGroups", { instance: INSTANCE, pPhysicalDeviceGroupCount: 1,
    pPhysicalDeviceGroupProperties: [{ sType: 1000070000, physicalDevices: new Array(32).fill(0) }] });
assert.equal(reply.pPhysicalDeviceGroupProperties[0].physicalDeviceCount, 1);
assert.equal(reply.pPhysicalDeviceGroupProperties[0].physicalDevices[0], PHYSICAL_DEVICE, "the group names the driver's id");

reply = call("vkGetPhysicalDeviceProperties", { physicalDevice: PHYSICAL_DEVICE, pProperties: {} });
assert.equal(reply.pProperties.deviceName, "v86 WebGPU");
assert.equal(reply.pProperties.limits.maxImageDimension2D, 8192);
assert.equal(reply.pProperties.limits.maxBoundDescriptorSets, 4);

// (the driver's chains, for a renderer of Vulkan 1.1)
const props2 = { sType: 1000059001, pNext: { sType: 1000071004, pNext: { sType: 1000168000, pNext: { sType: 1000094000,
    pNext: { sType: 1000196000 } } } } };
reply = call("vkGetPhysicalDeviceProperties2", { physicalDevice: PHYSICAL_DEVICE, pProperties: props2 });
const chain = s => { const out = {}; for(; s; s = s.pNext) out[s.sType] = s; return out; };
const got = chain(reply.pProperties.pNext);
assert.equal(got[1000094000].subgroupSize, 1, "VkPhysicalDeviceSubgroupProperties");
assert.equal(got[1000168000].maxMemoryAllocationSize, 1 << 30, "VkPhysicalDeviceMaintenance3Properties");
assert.equal(got[1000196000].driverName, "v86 WebGPU", "VkPhysicalDeviceDriverProperties");
assert.equal(reply.pProperties.properties.apiVersion >>> 12, 1 << 10 | 1);

reply = call("vkGetPhysicalDeviceFeatures2", { physicalDevice: PHYSICAL_DEVICE, pFeatures: { sType: 1000059000,
    pNext: { sType: 1000083000, pNext: { sType: 1000053001 } } } });
assert.equal(reply.pFeatures.features.robustBufferAccess, 1);
assert.equal(reply.pFeatures.features.geometryShader, 0);
assert.equal(reply.pFeatures.pNext.sType, 1000083000, "the chain comes back in its order");

reply = call("vkGetPhysicalDeviceQueueFamilyProperties2", { physicalDevice: PHYSICAL_DEVICE, pQueueFamilyPropertyCount: 4,
    pQueueFamilyProperties: Array.from({ length: 4 }, () => ({ sType: 1000059005 })) });
assert.equal(reply.pQueueFamilyPropertyCount, 1);
assert.equal(reply.pQueueFamilyProperties[0].queueFamilyProperties.queueFlags, 7, "graphics, compute, transfer");

reply = call("vkGetPhysicalDeviceMemoryProperties2", { physicalDevice: PHYSICAL_DEVICE, pMemoryProperties: { sType: 1000059006 } });
const memory = reply.pMemoryProperties.memoryProperties;
assert.equal(memory.memoryTypeCount, 3);
assert.deepEqual(memory.memoryTypes.slice(0, 3).map(t => t.propertyFlags), [1, 6, 14]);

reply = call("vkGetPhysicalDeviceFormatProperties2", { physicalDevice: PHYSICAL_DEVICE, format: 37, pFormatProperties: { sType: 1000059002 } });
const rgba8 = reply.pFormatProperties.formatProperties;
assert.equal(rgba8.optimalTilingFeatures & 0x1181, 0x1181, "R8G8B8A8_UNORM: sampled, linear filter, color attachment, blend");
assert.equal(rgba8.bufferFeatures & 0x40, 0x40, "and a vertex format");

reply = call("vkGetPhysicalDeviceImageFormatProperties2", { physicalDevice: PHYSICAL_DEVICE,
    pImageFormatInfo: { sType: 1000059004, format: 37, type: 1, tiling: 0, usage: 0x14, flags: 0 },
    pImageFormatProperties: { sType: 1000059003 } });
assert.equal(reply.ret, 0);
assert.equal(reply.pImageFormatProperties.imageFormatProperties.maxExtent.width, 8192);
assert.equal(reply.pImageFormatProperties.imageFormatProperties.sampleCounts, 5, "1 and 4 samples");
reply = call("vkGetPhysicalDeviceImageFormatProperties2", { physicalDevice: PHYSICAL_DEVICE,
    pImageFormatInfo: { sType: 1000059004, format: 106, type: 1, tiling: 0, usage: 0x4, flags: 0 },
    pImageFormatProperties: { sType: 1000059003 } });
assert.equal(reply.ret, -11, "R32G32B32_SFLOAT images: VK_ERROR_FORMAT_NOT_SUPPORTED");

reply = call("vkEnumerateDeviceExtensionProperties", { physicalDevice: PHYSICAL_DEVICE, pLayerName: null, pPropertyCount: 0, pProperties: null });
const count = reply.pPropertyCount;
reply = call("vkEnumerateDeviceExtensionProperties", { physicalDevice: PHYSICAL_DEVICE, pLayerName: null, pPropertyCount: count,
    pProperties: new Array(count).fill(0).map(() => ({})) });
assert.ok(reply.pProperties.some(p => p.extensionName === "VK_KHR_driver_properties"));
console.log("PASS: the instance and physical device queries");

// A command the model does not do yet: an error, the ring goes on
reply = call("vkGetPhysicalDeviceCalibrateableTimeDomainsKHR", { physicalDevice: PHYSICAL_DEVICE, pTimeDomainCount: 0, pTimeDomains: null });
assert.equal(reply.ret, -8, "VK_ERROR_FEATURE_NOT_PRESENT");

// ---------------------------------------------------------------------------
// The transport's other commands

// Indirect: the commands in another shared memory, run by vkExecuteCommandStreamsMESA
const indirect = encode(["vkEnumerateInstanceVersion", { cmd_flags: 1 }]);
write_bytes(hostmem + STREAM_AT + 64, indirect);
ring_write(encode(["vkSetReplyCommandStreamMESA", { pStream: { resourceId: REPLY_RES, offset: 0x8000, size: 0x100 } }],
    ["vkExecuteCommandStreamsMESA", { streamCount: 1, pStreams: [{ resourceId: STREAM_RES, offset: 64, size: indirect.length }],
        pReplyPositions: [16], dependencyCount: 0, pDependencies: null, flags: 0 }]));
reply = GUEST["vkEnumerateInstanceVersion"][1](new VenusReader(read_bytes(hostmem + REPLY_AT + 0x8000 + 16, 64)));
assert.equal(reply.pApiVersion >>> 12, 1 << 10 | 1, "the indirect command's reply, where its position said");
console.log("PASS: vkExecuteCommandStreamsMESA");

// vkWriteRingExtraMESA (SUBMIT_3D)
assert.equal(answer(submit_3d(encode(["vkWriteRingExtraMESA", { ring: RING_ID, offset: 8, value: 0xCAFE }]))), OK);
assert.equal(read32(ring_base + EXTRA + 8), 0xCAFE, "vkWriteRingExtraMESA");

// vkWaitRingSeqnoMESA (SUBMIT_3D): the ring is read before the answer, without the timer
ring_write(encode(["vkEnumerateInstanceVersion", {}]), false);
assert.notEqual(read32(ring_base + HEAD), tail, "not read yet");
assert.equal(answer(submit_3d(encode(["vkWaitRingSeqnoMESA", { ring: RING_ID, seqno: tail }]))), OK);
assert.equal(read32(ring_base + HEAD), tail, "read for vkWaitRingSeqnoMESA");

// vkWaitVirtqueueSeqnoMESA in the ring waits for vkSubmitVirtqueueSeqnoMESA through SUBMIT_3D
const before = tail;
ring_write(encode(["vkWaitVirtqueueSeqnoMESA", { seqno: 5 }], ["vkEnumerateInstanceVersion", {}]));
assert.equal(read32(ring_base + HEAD), before, "the ring stops at the wait");
assert.equal(answer(submit_3d(encode(["vkSubmitVirtqueueSeqnoMESA", { ring: RING_ID, seqno: 5 }]))), OK);
assert.equal(read32(ring_base + HEAD), tail, "the ring went on");

// A SUBMIT_3D waiting for a ring that waits is answered after it, and the
// submissions after it run after it (virglrenderer's order)
ring_write(encode(["vkWaitVirtqueueSeqnoMESA", { seqno: 6 }]));
const waiting = submit_3d(encode(["vkWaitRingSeqnoMESA", { ring: RING_ID, seqno: tail }]), false);
assert.equal(answer(waiting), 0xDEADBEEF, "not answered while the ring waits");
const after = submit_3d(encode(["vkWriteRingExtraMESA", { ring: RING_ID, offset: 12, value: 7 }]), false);
assert.equal(read32(ring_base + EXTRA + 12), 0, "the submission after it waits too");
// (here the seqno comes from nowhere: the driver's would be in a submission before)
const venus_ctx = gpu.venus.contexts.get(CTX);
venus_ctx.virtqueue_seqnos.set(RING_ID, 6);
gpu.venus.wake_seqno_waits(venus_ctx);
assert.equal(read32(ring_base + HEAD), tail, "the ring went on");
assert.equal(answer(waiting), OK, "the waiting SUBMIT_3D was answered");
assert.equal(answer(after), OK, "and the one after it");
assert.equal(read32(ring_base + EXTRA + 12), 7);
console.log("PASS: seqno waits of rings and submissions");

// The ALIVE bit comes back after the driver's watchdog clears it
write32(ring_base + STATUS, read32(ring_base + STATUS) & ~4);
cpu.devices.display.timer(cpu.clock.now() + 1000);
assert.equal(read32(ring_base + STATUS) & 4, 4, "ALIVE again");

// A command the protocol does not know: the ring is FATAL
ring_write(Uint8Array.from([0xFF, 0xFF, 0, 0, 0, 0, 0, 0]));
assert.equal(read32(ring_base + STATUS) & 2, 2, "FATAL");
console.log("PASS: ALIVE and FATAL");

// ---------------------------------------------------------------------------
// Memory and submissions: a timeline wait the host meets later; GPU writes
// into memory the guest maps, while the guest writes other bytes of the
// same page

// (a new ring: the old one is FATAL)
const RING2 = RING_ID + 1;
tail = 0;
for(let i = 0; i < 256; i += 4) write32(ring_base + i, 0);
assert.equal(answer(submit_3d(encode(["vkCreateRingMESA", { ring: RING2, pCreateInfo: {
    sType: 1000384000, resourceId: RING_RES, offset: 0, size: RING_SIZE, idleTimeout: 1000000,
    headOffset: HEAD, tailOffset: TAIL, statusOffset: STATUS, bufferOffset: BUFFER, bufferSize: BUFFER_SIZE,
    extraOffset: EXTRA, extraSize: 64 } }]))), OK);
const DEVICE = 0x3000, QUEUE = 0x3001, BUF = 0x3002, MEM = 0x3003, SEM = 0x3004, POOL = 0x3005, CB = 0x3006;
reply = call("vkCreateDevice", { physicalDevice: PHYSICAL_DEVICE, pCreateInfo: { sType: 3, queueCreateInfoCount: 1,
    pQueueCreateInfos: [{ sType: 2, queueFamilyIndex: 0, queueCount: 1, pQueuePriorities: [1] }] }, pDevice: DEVICE });
assert.equal(reply.ret, 0, "vkCreateDevice");
ring_write(encode(["vkGetDeviceQueue2", { device: DEVICE, pQueueInfo: { sType: 1000145003, pNext: { sType: 1000384005, ringIdx: 1 },
    queueFamilyIndex: 0, queueIndex: 0 }, pQueue: QUEUE }],
    ["vkCreateBuffer", { device: DEVICE, pCreateInfo: { sType: 12, size: 4096, usage: 3 }, pBuffer: BUF }],
    ["vkAllocateMemory", { device: DEVICE, pAllocateInfo: { sType: 5, allocationSize: 4096, memoryTypeIndex: 1 }, pMemory: MEM }],
    ["vkBindBufferMemory", { device: DEVICE, buffer: BUF, memory: MEM, memoryOffset: 0 }],
    ["vkCreateSemaphore", { device: DEVICE, pCreateInfo: { sType: 9, pNext: { sType: 1000207002, semaphoreType: 1, initialValue: 0 } }, pSemaphore: SEM }],
    ["vkCreateCommandPool", { device: DEVICE, pCreateInfo: { sType: 39, queueFamilyIndex: 0 }, pCommandPool: POOL }],
    ["vkAllocateCommandBuffers", { device: DEVICE, pAllocateInfo: { sType: 40, commandPool: POOL, level: 0, commandBufferCount: 1 }, pCommandBuffers: [CB] }],
    ["vkBeginCommandBuffer", { commandBuffer: CB, pBeginInfo: { sType: 42 } }],
    ["vkCmdCopyBuffer", { commandBuffer: CB, srcBuffer: BUF, dstBuffer: BUF, regionCount: 1, pRegions: [{ srcOffset: 0, dstOffset: 64, size: 8 }] }],
    ["vkEndCommandBuffer", { commandBuffer: CB }]));
// the memory's blob, mapped
const MEM_RES = 20, MEM_AT = 0x400000, mem_base = hostmem + MEM_AT;
assert.equal(command(0x010C, MEM_RES, HOST3D, MAPPABLE, 0, MEM, 0, 4096, 0), OK, "RESOURCE_CREATE_BLOB of the memory");
assert.equal(command(0x0208, MEM_RES, 0, MEM_AT, 0), OK_MAP_INFO, "MAP_BLOB of the memory");
assert.deepEqual(Array.from(read_bytes(mem_base, 8)), [0, 0, 0, 0, 0, 0, 0, 0], "new memory reads as zeros");
write32(mem_base, 2);
// the submission waits for 1, signals 2
ring_write(encode(["vkQueueSubmit", { queue: QUEUE, submitCount: 1, pSubmits: [{ sType: 4,
    pNext: { sType: 1000207003, waitSemaphoreValueCount: 1, pWaitSemaphoreValues: [1], signalSemaphoreValueCount: 1, pSignalSemaphoreValues: [2] },
    waitSemaphoreCount: 1, pWaitSemaphores: [SEM], pWaitDstStageMask: [1], commandBufferCount: 1, pCommandBuffers: [CB],
    signalSemaphoreCount: 1, pSignalSemaphores: [SEM] }], fence: 0 }]));
assert.ok(!vx_log.includes(VX.BEGIN), "the submission waits for the semaphore");
reply = call("vkGetSemaphoreCounterValue", { device: DEVICE, semaphore: SEM, pValue: 0 });
assert.equal(reply.pValue, 0);
// the guest writes another byte of the page; the host signals 1; while the
// GPU runs the submission, the guest writes yet another byte of the page
cpu.write8(mem_base + 512, 0xAB);
held = [];
ring_write(encode(["vkSignalSemaphore", { device: DEVICE, pSignalInfo: { sType: 1000207005, semaphore: SEM, value: 1 } }]));
cpu.write8(mem_base + 520, 0xCD);
flush_renderer();
assert.ok(vx_log.includes(VX.BEGIN), "the submission ran");
assert.equal(read32(mem_base + 64), 2, "the GPU's copy, in the mapping");
assert.equal(cpu.read8(mem_base + 512), 0xAB, "the guest's byte, still there");
assert.equal(cpu.read8(mem_base + 520), 0xCD, "and the one it wrote while the GPU ran");
reply = call("vkGetSemaphoreCounterValue", { device: DEVICE, semaphore: SEM, pValue: 0 });
assert.equal(reply.pValue, 2, "the submission signaled 2");
console.log("PASS: a timeline wait the host meets; the GPU's and the guest's writes to one page");

// Sync files (Venus's WSI needs them): what the device says of them; a
// fence's or semaphore's pending signal that went into a sync file does not
// land on it any more; a sync file the driver waited for signals a semaphore
reply = call("vkGetPhysicalDeviceExternalSemaphoreProperties", { physicalDevice: PHYSICAL_DEVICE,
    pExternalSemaphoreInfo: { sType: 1000076000, handleType: 0x10 }, pExternalSemaphoreProperties: { sType: 1000076001 } });
assert.equal(reply.pExternalSemaphoreProperties.externalSemaphoreFeatures, 3, "binary semaphores: sync files export and import");
reply = call("vkGetPhysicalDeviceExternalSemaphoreProperties", { physicalDevice: PHYSICAL_DEVICE,
    pExternalSemaphoreInfo: { sType: 1000076000, pNext: { sType: 1000207002, semaphoreType: 1, initialValue: 0 }, handleType: 0x10 },
    pExternalSemaphoreProperties: { sType: 1000076001 } });
assert.equal(reply.pExternalSemaphoreProperties.externalSemaphoreFeatures, 0, "timeline semaphores: none");
reply = call("vkGetPhysicalDeviceExternalFenceProperties", { physicalDevice: PHYSICAL_DEVICE,
    pExternalFenceInfo: { sType: 1000112000, handleType: 8 }, pExternalFenceProperties: { sType: 1000112001 } });
assert.equal(reply.pExternalFenceProperties.externalFenceFeatures, 3, "fences: sync files export and import");
const FENCE = 0x3007, BSEM = 0x3008;
const submit_signaling = () => ["vkQueueSubmit", { queue: QUEUE, submitCount: 1, pSubmits: [{ sType: 4, waitSemaphoreCount: 0, pWaitSemaphores: null,
    pWaitDstStageMask: null, commandBufferCount: 1, pCommandBuffers: [CB], signalSemaphoreCount: 1, pSignalSemaphores: [BSEM] }], fence: FENCE }];
ring_write(encode(["vkCreateFence", { device: DEVICE, pCreateInfo: { sType: 8, flags: 0 }, pFence: FENCE }],
    ["vkCreateSemaphore", { device: DEVICE, pCreateInfo: { sType: 9 }, pSemaphore: BSEM }]));
const binary = () => gpu.venus.contexts.get(CTX).objects.get(BSEM).signaled;
held = [];
ring_write(encode(submit_signaling(), ["vkResetFenceResourceMESA", { device: DEVICE, fence: FENCE }],
    ["vkWaitSemaphoreResourceMESA", { device: DEVICE, semaphore: BSEM }]));
flush_renderer();
assert.equal(call("vkGetFenceStatus", { device: DEVICE, fence: FENCE }).ret, 1, "VK_NOT_READY: the fence's signal went to the sync file");
assert.equal(binary(), false, "and the semaphore's");
held = [];
ring_write(encode(submit_signaling()));
flush_renderer();
assert.equal(call("vkGetFenceStatus", { device: DEVICE, fence: FENCE }).ret, 0, "a submission's fence signals as before");
assert.equal(binary(), true);
ring_write(encode(["vkWaitSemaphoreResourceMESA", { device: DEVICE, semaphore: BSEM }]));
assert.equal(binary(), false, "a sync file took the signal");
ring_write(encode(["vkImportSemaphoreResourceMESA", { device: DEVICE, pImportSemaphoreResourceInfo: { sType: 1000384004, semaphore: BSEM, resourceId: 0 } }]));
assert.equal(binary(), true, "a sync file the driver waited for signals it");
console.log("PASS: sync files of fences and semaphores");

// A snapshot, saved and restored: the context, its ring, reply stream and
// objects, the renderer's memory with what the GPU wrote, the mapping
const mem_rid = gpu.venus.contexts.get(CTX).objects.get(MEM).rid;
assert.equal(read32(mem_base + 64), 2);
const state = await emulator.save_state();
vx_memory.clear();
vx_log.length = 0;
await emulator.restore_state(state);
assert.ok(vx_log.includes(VX.MEMORY_CREATE), "the renderer's memory made again");
assert.equal(new DataView(vx_memory.get(mem_rid).buffer).getUint32(64, true), 2, "with what the GPU had written");
assert.equal(read32(mem_base + 64), 2, "the mapping");
assert.equal(call("vkGetSemaphoreCounterValue", { device: DEVICE, semaphore: SEM, pValue: 0 }).pValue, 2, "the ring and the semaphore go on");
assert.equal(call("vkGetFenceStatus", { device: DEVICE, fence: FENCE }).ret, 0, "the fence");
write32(mem_base, 7);
ring_write(encode(["vkQueueSubmit", { queue: QUEUE, submitCount: 1, pSubmits: [{ sType: 4, waitSemaphoreCount: 0, pWaitSemaphores: null,
    pWaitDstStageMask: null, commandBufferCount: 1, pCommandBuffers: [CB], signalSemaphoreCount: 0, pSignalSemaphores: null }], fence: 0 }]));
assert.equal(call("vkGetSemaphoreCounterValue", { device: DEVICE, semaphore: SEM, pValue: 0 }).pValue, 2);
assert.equal(read32(mem_base + 64), 7, "the command buffer, recorded before the snapshot, runs after it");
console.log("PASS: snapshots");

// gralloc's buffers (Android: docs/arm64-virt-android16-plan.md P11.4): the
// modifier and foreign queue extensions without the dma-buf ones (Mesa's
// venus on Linux would take swapchain images for dma-bufs), one modifier
// (linear), dma-buf images importable all the same, a virgl resource imported as
// memory (VkImportMemoryResourceInfoMESA) and an image bound to it, which
// becomes the resource's GX surface (VX.TEXTURE_IMPORT); after a submission
// the GPU's copy of the resource is the newer one; the import is in the
// state a snapshot keeps
reply = call("vkEnumerateDeviceExtensionProperties", { physicalDevice: PHYSICAL_DEVICE, pLayerName: null, pPropertyCount: 0, pProperties: null });
reply = call("vkEnumerateDeviceExtensionProperties", { physicalDevice: PHYSICAL_DEVICE, pLayerName: null, pPropertyCount: reply.pPropertyCount,
    pProperties: new Array(reply.pPropertyCount).fill(0).map(() => ({})) });
for(const name of ["VK_EXT_image_drm_format_modifier", "VK_EXT_queue_family_foreign"])
{
    assert.ok(reply.pProperties.some(p => p.extensionName === name), name);
}
for(const name of ["VK_EXT_external_memory_dma_buf", "VK_KHR_external_memory_fd"])
{
    assert.ok(!reply.pProperties.some(p => p.extensionName === name), "not " + name);
}
const modifier_list = (count, properties) => call("vkGetPhysicalDeviceFormatProperties2", { physicalDevice: PHYSICAL_DEVICE, format: 37,
    pFormatProperties: { sType: 1000059002, pNext: { sType: 1000158000, drmFormatModifierCount: count, pDrmFormatModifierProperties: properties } } })
    .pFormatProperties.pNext;
assert.equal(modifier_list(0, null).drmFormatModifierCount, 1, "R8G8B8A8_UNORM: one modifier");
const linear = modifier_list(1, [{}]).pDrmFormatModifierProperties[0];
assert.equal(Number(linear.drmFormatModifier), 0, "DRM_FORMAT_MOD_LINEAR");
assert.equal(linear.drmFormatModifierPlaneCount, 1);
assert.equal(linear.drmFormatModifierTilingFeatures & 0x1181, 0x1181, "with optimal tiling's features");
const external_image = (handle_type, modifier) => call("vkGetPhysicalDeviceImageFormatProperties2", { physicalDevice: PHYSICAL_DEVICE,
    pImageFormatInfo: { sType: 1000059004, pNext: { sType: 1000071000, handleType: handle_type, pNext: { sType: 1000158002, drmFormatModifier: modifier,
        sharingMode: 0, queueFamilyIndexCount: 0, pQueueFamilyIndices: null } }, format: 37, type: 1, tiling: 1000158000, usage: 0x16, flags: 0 },
    pImageFormatProperties: { sType: 1000059003, pNext: { sType: 1000071001 } } });
reply = external_image(0x200, 0);
assert.equal(reply.ret, 0, "a dma-buf image with the linear modifier");
assert.equal(reply.pImageFormatProperties.pNext.externalMemoryProperties.externalMemoryFeatures, 5, "dedicated, importable");
assert.equal(reply.pImageFormatProperties.pNext.externalMemoryProperties.compatibleHandleTypes, 0x200);
assert.equal(external_image(0x1, 0).ret, -11, "opaque fds: no");
assert.equal(external_image(0x200, 1).ret, -11, "another modifier: no");
// (a virgl resource, as minigbm makes one: RESOURCE_CREATE_3D, a 2D texture of R8G8B8A8_UNORM)
const AHB_RES = 30, AHB_IMAGE = 0x3010, AHB_MEM = 0x3011, CB2 = 0x3012;
assert.equal(command(0x0204, AHB_RES, 2, 67, 2, 64, 32, 1, 1, 0, 0, 0, 0), OK, "RESOURCE_CREATE_3D");
const resource_properties = id => call("vkGetMemoryResourcePropertiesMESA", { device: DEVICE, resourceId: id,
    pMemoryResourceProperties: { pNext: { sType: 1000384003 } } });
reply = resource_properties(AHB_RES);
assert.equal(reply.ret, 0);
assert.equal(reply.pMemoryResourceProperties.memoryTypeBits, 1, "device local");
assert.equal(Number(reply.pMemoryResourceProperties.pNext.allocationSize), 64 * 32 * 4);
assert.equal(resource_properties(99).ret, -1000072003, "an unknown resource: VK_ERROR_INVALID_EXTERNAL_HANDLE");
ring_write(encode(["vkCreateImage", { device: DEVICE, pCreateInfo: { sType: 14,
        pNext: { sType: 1000072001, handleTypes: 0x200, pNext: { sType: 1000158004, drmFormatModifier: 0, drmFormatModifierPlaneCount: 1,
            pPlaneLayouts: [{ offset: 0, size: 8192, rowPitch: 256, arrayPitch: 0, depthPitch: 0 }] } },
        flags: 0, imageType: 1, format: 37, extent: { width: 64, height: 32, depth: 1 }, mipLevels: 1, arrayLayers: 1, samples: 1,
        tiling: 1000158000, usage: 0x16, sharingMode: 0, queueFamilyIndexCount: 0, pQueueFamilyIndices: null, initialLayout: 0 }, pImage: AHB_IMAGE }],
    ["vkAllocateMemory", { device: DEVICE, pAllocateInfo: { sType: 5, pNext: { sType: 1000384002, resourceId: AHB_RES,
        pNext: { sType: 1000127001, image: AHB_IMAGE, buffer: 0 } }, allocationSize: 8192, memoryTypeIndex: 0 }, pMemory: AHB_MEM }],
    ["vkBindImageMemory", { device: DEVICE, image: AHB_IMAGE, memory: AHB_MEM, memoryOffset: 0 }],
    ["vkAllocateCommandBuffers", { device: DEVICE, pAllocateInfo: { sType: 40, commandPool: POOL, level: 0, commandBufferCount: 1 }, pCommandBuffers: [CB2] }],
    ["vkBeginCommandBuffer", { commandBuffer: CB2, pBeginInfo: { sType: 42 } }],
    ["vkEndCommandBuffer", { commandBuffer: CB2 }]));
const vk = gpu.venus.vk;
const import_entry = [...vk.imports.values()][0];
assert.equal(import_entry[1], AHB_RES);
assert.equal(Number(call("vkGetImageDrmFormatModifierPropertiesEXT", { device: DEVICE, image: AHB_IMAGE, pProperties: {} }).pProperties.drmFormatModifier), 0);
assert.equal(Number(call("vkGetImageSubresourceLayout", { device: DEVICE, image: AHB_IMAGE, pSubresource: { aspectMask: 1, mipLevel: 0, arrayLayer: 0 },
    pLayout: {} }).pLayout.rowPitch), 256, "the guest's layout");
const ahb = gpu.resources.get(AHB_RES);
ahb.host_newer = true;
ring_write(encode(["vkQueueSubmit", { queue: QUEUE, submitCount: 1, pSubmits: [{ sType: 4, waitSemaphoreCount: 0, pWaitSemaphores: null,
    pWaitDstStageMask: null, commandBufferCount: 1, pCommandBuffers: [CB2], signalSemaphoreCount: 0, pSignalSemaphores: null }], fence: 0 }]));
assert.equal(ahb.host_newer, false, "after a submission the GPU's copy is the newer one");
// (the VX commands go with the submission's batch: the image made, then made the resource's surface)
assert.ok(vx_log.lastIndexOf(VX.TEXTURE_IMPORT) > vx_log.lastIndexOf(VX.TEXTURE_CREATE), "the image is the resource's GX surface");
assert.deepEqual(vk.get_state()[5], [import_entry], "a snapshot keeps the import");
console.log("PASS: gralloc's buffers: dma-buf images, resources imported as memory");

// Ring ids are the driver's pointers to its rings, exact: two threads' rings
// 0x1c0 apart on Android's tagged heap are two rings (as numbers both were
// 0xb4000076e5a3c000: the second ring replaced the first, whose thread
// waited for its replies for good). A snapshot of then has its ids as those
// numbers, and the driver's exact ids still find its rings.
{
    const rings = gpu.venus.contexts.get(CTX).rings;
    const RINGS_RES = 40;
    blob(RINGS_RES, RING_SIZE, 0x400000);
    const create = ring => answer(submit_3d(encode(["vkCreateRingMESA", { ring, pCreateInfo: {
        sType: 1000384000, resourceId: RINGS_RES, offset: 0, size: RING_SIZE, idleTimeout: 1000000,
        headOffset: HEAD, tailOffset: TAIL, statusOffset: STATUS, bufferOffset: BUFFER, bufferSize: BUFFER_SIZE,
        extraOffset: EXTRA, extraSize: 64 } }])));
    const count = rings.size;
    const [A, B] = ["b4000076e5a3c180", "b4000076e5a3c340"];
    assert.equal(create(A), OK);
    assert.equal(create(B), OK);
    assert.equal(rings.size, count + 2, "two rings");
    assert.equal(answer(submit_3d(encode(["vkDestroyRingMESA", { ring: B }]))), OK);
    assert.ok(rings.has(A) && !rings.has(B), "one destroyed, the other there");

    // (the Venus state of a snapshot of before: the ids as numbers)
    const venus_state = gpu.venus.get_state();
    for(const context of venus_state[0]) for(const r of context[1]) r[0] = Number(BigInt("0x" + r[0]));
    gpu.venus.set_state(venus_state, id => { const r = gpu.resources.get(id); return r && r.venus ? r : null; });
    const restored = gpu.venus.contexts.get(CTX).rings;
    assert.equal(restored.size, count + 1);
    assert.equal(answer(submit_3d(encode(["vkWriteRingExtraMESA", { ring: A, offset: 16, value: 0x5A5A }]))), OK, "a ring of the old snapshot by its exact id");
    assert.equal(answer(submit_3d(encode(["vkWriteRingExtraMESA", { ring: RING2, offset: 20, value: 0xA5A5 }]))), OK);
    assert.equal(read32(ring_base + EXTRA + 20), 0xA5A5, "and the test's own ring");
    assert.equal(answer(submit_3d(encode(["vkDestroyRingMESA", { ring: A }]))), OK);
    assert.equal(restored.size, count, "destroyed by its exact id");
}
console.log("PASS: ring ids, exact; a snapshot's rounded ids");

// Destroying the context
assert.equal(command(0x0201), OK, "CTX_DESTROY");
assert.ok(!gpu.venus.contexts.has(CTX));
assert.equal(command(0x0102, RING_RES, 0), OK, "RESOURCE_UNREF");
console.log("PASS: CTX_DESTROY");

emulator.destroy();
