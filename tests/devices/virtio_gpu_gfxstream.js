#!/usr/bin/env node

// virtio-gpu's gfxstream transport (level gfxstream, src/graphics_adapters/
// virtio_gpu/gfxstream.js; docs/gfxstream-protocol.md), driven as the
// guest's gfxstream transport (mesa's AddressSpaceStream, gfxstream's
// VirtioGpuPipeStream) drives it: the capsets, a context of capset 3, its
// ASG ring in a HOST3D blob (CONTEXT_CREATE, then mapped: the host's config),
// the stream's commands through type 1 and large transfers with PING, the
// replies through the from-host ring, a decoder that waits (the host's
// state), the sync commands' tasks and the fences of each ring answered on
// their own, and the process pipe (GLProcessPipe) of a pipe resource.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// a renderer that answers at once
const renderer = {
    "post": message => { if(message["type"] === "submit") to_device({ "type": "done", "seq": message["seq"] }); },
    "listen": handler => { to_device = handler; },
};
let to_device = null;

// hlt forever
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
assert.ok(hostmem, "BAR4 placed");

let common = 0, notify = 0, device_config = 0;
const bar2 = (pci_read(0x18) & ~0xF) >>> 0;
for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
{
    if(pci_read8(at) !== 0x09) continue;
    const type = pci_read8(at + 3);
    if(type === 1) common = bar2 + pci_read(at + 8);
    if(type === 2) notify = bar2 + pci_read(at + 8);
    if(type === 4) device_config = bar2 + pci_read(at + 8);
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

// One request at a time, each in its own slot; answered(slot) whether it was
const REQUEST = 0x200000, REPLY = 0x280000, SLOT = 0x1000;
let next_slot = 0;
const used_idx = () => read32(QUEUES[0].used) >>> 16;
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
    const before = used_idx();
    cpu.write8(notify, 0);
    cpu.write8(notify + 1, 0);
    if(wait) assert.equal(used_idx(), before + 1 & 0xFFFF, "answered at once");
    return slot;
}
const answer = slot => read32(REPLY + slot * SLOT);
const CTX = 1;
/** a control request: its type, a fence (on a ring) if given, its fields */
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
const OK = 0x1100, OK_CAPSET_INFO = 0x1102, OK_CAPSET = 0x1103, OK_MAP_INFO = 0x1106;

// ---------------------------------------------------------------------------
// The capsets: gfxstream's alone

assert.equal(read32(device_config + 12), 2, "num_capsets: 2");
let slot = control(0x0108, [0, 0]);
assert.equal(answer(slot), OK_CAPSET_INFO);
assert.deepEqual([24, 28, 32].map(o => read32(REPLY + slot * SLOT + o)), [3, 0, 108], "capset 3 (gfxstream Vulkan), 108 bytes");
slot = control(0x0108, [1, 0]);
assert.deepEqual([24, 28, 32].map(o => read32(REPLY + slot * SLOT + o)), [9, 0, 16], "capset 9 (gfxstream composer), 16 bytes");
slot = control(0x0109, [3, 0]);
assert.equal(answer(slot), OK_CAPSET);
const vulkan_capset = Array.from({ length: 27 }, (_, i) => read32(REPLY + slot * SLOT + 24 + i * 4));
assert.deepEqual(vulkan_capset.slice(0, 7), [1, 12288, 1 << 20, 0, 1, 4096, 1],
    "protocolVersion 1, ringSize 12288, bufferSize 1 MiB, deferredMapping, blobAlignment 4096, noRenderControlEnc");
assert.equal(vulkan_capset[26], 1, "hasTraceAsyncCommand");
console.log("PASS: the gfxstream capsets");

// A context of capset 3, its ring's blob (ring storage and buffer), CONTEXT_CREATE, mapped
assert.equal(command(0x0200, 0, 3), OK, "CTX_CREATE, capset 3");
assert.ok(gpu.gfxstream.contexts.has(CTX));
const RING_RES = 10, RING_AT = 0x100000, RING_SIZE = 12288, BUFFER_SIZE = 1 << 20;
const HOST3D = 2, MAPPABLE = 1;
assert.equal(command(0x010C, RING_RES, HOST3D, MAPPABLE, 0, 0, 0, RING_SIZE + BUFFER_SIZE, 0), OK, "RESOURCE_CREATE_BLOB, blob id 0");
const submit_3d = (words, wait, fence) => control(0x0207, [words.length * 4, 0, ...words], wait, fence);
assert.equal(answer(submit_3d([0x1001, RING_RES])), OK, "CONTEXT_CREATE");
assert.equal(command(0x0208, RING_RES, 0, RING_AT, 0), OK_MAP_INFO, "MAP_BLOB");
const ring = hostmem + RING_AT, buffer = ring + RING_SIZE, config = ring + 2180;
assert.deepEqual([0, 4, 8, 16, 24].map(o => read32(config + o)), [BUFFER_SIZE, 4096, 0, 1, 0],
    "the ring's config: buffer_size, flush_interval, host_consumed_pos, transfer_mode 1, in_error");
assert.equal(read32(ring + 2176), 0, "the host's state: NEED_NOTIFY");
console.log("PASS: a context's ASG ring");

// A decoder of 12340-12349 that answers what it got, and 12345's
const decoded = [];
let held = null;
let ready_12349 = false;
gpu.gfxstream.decoders.push({ name: "test", first: 12340, last: 12349, decode: (ctx, ring, opcode, payload, reply) => {
    if(opcode === 12349 && !ready_12349) return gpu.gfxstream.AGAIN;
    decoded.push([opcode, Array.from(payload)]);
    if(opcode === 12342) ready_12349 = true;
    if(opcode === 12345) reply(payload.slice());
    if(opcode === 12346) return done => { held = done; };
    return null;
} });
const packet = (opcode, ...bytes) => {
    const out = new Uint8Array(8 + bytes.length), v = new DataView(out.buffer);
    v.setUint32(0, opcode, true); v.setUint32(4, out.length, true);
    out.set(bytes, 8);
    return out;
};
let write_offset = 0, write_pos = 0;
/** bytes into the buffer, a type 1 transfer of them onto the to-host ring */
const type1 = bytes => {
    write_bytes(buffer + write_offset, bytes);
    write32(ring + 128 + (write_pos & 2047), write_offset);
    write32(ring + 128 + (write_pos & 2047) + 4, bytes.length);
    write_pos = write_pos + 8 >>> 0;
    write32(ring + 8, write_pos);
    write_offset = (write_offset + 4096) % BUFFER_SIZE;
};
const ping = () => assert.equal(answer(submit_3d([0x1002, RING_RES])), OK, "PING");

// the client's flags, then a command with its reply
type1(Uint8Array.of(0, 0, 0, 0, ...packet(12345, 7, 8, 9, 10)));
ping();
assert.deepEqual(decoded, [[12345, [7, 8, 9, 10]]], "the command decoded");
assert.equal(read32(ring + 64), 8, "to-host read_pos moved on");
assert.equal(read32(config + 8), 16, "host_consumed_pos");
assert.equal(read32(ring + 8192 + 8), 4, "from-host write_pos: the reply's 4 bytes");
assert.deepEqual(Array.from(read_bytes(buffer, 4)), [7, 8, 9, 10], "the reply in the buffer");
console.log("PASS: a command and its reply");

// an unknown command skipped; a command split across two transfers
type1(packet(55555, 1, 2, 3, 4));
const split = packet(12347, 5, 6, 7, 8, 9, 10, 11, 12);
type1(split.subarray(0, 6));
ping();
assert.equal(gpu.gfxstream.stats.unknown[55555], 1, "the unknown command counted");
assert.equal(decoded.length, 1, "half a command waits");
type1(split.subarray(6));
ping();
assert.deepEqual(decoded[1], [12347, [5, 6, 7, 8, 9, 10, 11, 12]], "the command, whole");
console.log("PASS: unknown and split commands");

// a large transfer (type 3): its ring's view of the buffer
const large = packet(12348, 42, 43, 44, 45);
const large_pos = read32(ring + 4096 + 8);
write_bytes(buffer + (large_pos & BUFFER_SIZE - 1), large);
write32(ring + 4096 + 8, large_pos + large.length);
ping();
assert.deepEqual(decoded[2], [12348, [42, 43, 44, 45]], "the large transfer's command");
assert.equal(read32(ring + 4096 + 64), large_pos + large.length, "its read_pos");
console.log("PASS: a large transfer");

// a command that waits: the ones after it wait too, the host is rendering
type1(Uint8Array.of(...packet(12346), ...packet(12341, 1)));
ping();
assert.equal(decoded.at(-1)[0], 12346, "the waiting command");
assert.equal(read32(ring + 2176), 4, "the host's state: RENDERING");
held();
assert.deepEqual(decoded.at(-1), [12341, [1]], "the next one once it is done");
assert.equal(read32(ring + 2176), 0, "NEED_NOTIFY again");
console.log("PASS: a command that waits");

// a second ring of the context (another thread's stream): its own stream
// and replies; a command that comes after another ring's (AGAIN) decoded
// once that ring has decoded one
const RING2_RES = 11, RING2_AT = 0x300000;
assert.equal(command(0x010C, RING2_RES, HOST3D, MAPPABLE, 0, 0, 0, RING_SIZE + BUFFER_SIZE, 0), OK, "the second ring's blob");
assert.equal(answer(submit_3d([0x1001, RING2_RES])), OK, "CONTEXT_CREATE of the second ring");
assert.equal(command(0x0208, RING2_RES, 0, RING2_AT, 0), OK_MAP_INFO);
assert.equal(gpu.gfxstream.contexts.get(CTX).rings.size, 2, "two rings");
const ring2 = hostmem + RING2_AT, buffer2 = ring2 + RING_SIZE;
assert.equal(read32(ring2 + 2180 + 16), 1, "its config");
type1(packet(12349, 9));
ping();
assert.notEqual(decoded.at(-1)[0], 12349, "12349 waits for ring 2's command");
write_bytes(buffer2, Uint8Array.of(0, 0, 0, 0, ...packet(12345, 3, 1, 4), ...packet(12342)));
write32(ring2 + 128, 0); write32(ring2 + 132, 23);
write32(ring2 + 8, 8);
assert.equal(answer(submit_3d([0x1002, RING2_RES])), OK, "PING of the second ring");
assert.deepEqual(decoded.slice(-3).map(d => d[0]), [12345, 12342, 12349], "ring 2's commands, then ring 1's");
assert.deepEqual(Array.from(read_bytes(buffer2, 3)), [3, 1, 4], "the reply in ring 2's buffer");
assert.equal(read32(ring2 + 8192 + 8), 3, "ring 2's from-host write_pos");
assert.equal(read32(ring + 64), write_pos, "ring 1's transfers consumed");
console.log("PASS: two rings of a context");

// fences on rings: a sync task of ring 1 holds its fence, not ring 2's
let task_done = null;
// (before Vulkan's, whose tasks these would be)
gpu.gfxstream.decoders.unshift({ name: "sync", first: 0, last: -1, sync_task: (ctx, op, words) => done => { task_done = done; } });
const before = used_idx();
submit_3d([0xa000, 1, 0, 2, 0], false, { id: 100, ring: 1 });
submit_3d([0xf002, 0, 0], false, { id: 101, ring: 2 });
assert.equal(used_idx(), before + 1 & 0xFFFF, "ring 2's fence answered, ring 1's waits");
task_done();
assert.equal(used_idx(), before + 2 & 0xFFFF, "ring 1's once its task is done");
console.log("PASS: the fences of each ring");

// the process pipe: a pipe resource's transfers
const PIPE_RES = 20, PIPE_AT = 0x400000;
assert.equal(command(0x0204, PIPE_RES, 0, 64, 1 << 17, 1 << 20, 1, 1, 1, 0, 0, 0, 0), OK, "RESOURCE_CREATE_3D, a pipe (PIPE_BUFFER, BIND_CUSTOM)");
assert.equal(command(0x0106, PIPE_RES, 1, PIPE_AT, 0, 1 << 20, 0), OK, "RESOURCE_ATTACH_BACKING");
const name = new TextEncoder().encode("pipe:GLProcessPipe\0");
write_bytes(PIPE_AT, name);
const transfer = (type, length) => command(type, 0, 0, 0, length, 1, 1, 0, 0, PIPE_RES, 0, 0, 0);
assert.equal(transfer(0x0205, name.length), OK, "TRANSFER_TO_HOST_3D: the service's name");
write32(PIPE_AT, 100);
assert.equal(transfer(0x0205, 4), OK, "TRANSFER_TO_HOST_3D: the confirmation");
write32(PIPE_AT, 0); write32(PIPE_AT + 4, 0);
assert.equal(transfer(0x0206, 8), OK, "TRANSFER_FROM_HOST_3D");
assert.ok(read32(PIPE_AT) > 0 && read32(PIPE_AT + 4) === 0, "the process's unique id: " + read32(PIPE_AT));
console.log("PASS: the process pipe");

assert.equal(command(0x0201), OK, "CTX_DESTROY");
assert.ok(!gpu.gfxstream.contexts.has(CTX));
assert.equal(gpu.gfxstream.stats.errors, 0, gpu.gfxstream.stats.last_error);
console.log("PASS: CTX_DESTROY");
emulator.destroy();
