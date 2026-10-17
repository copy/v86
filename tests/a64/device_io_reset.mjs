#!/usr/bin/env node
// virtio-blk I/O in flight on the virt machine (docs/arm64-virt-android16-plan.md
// P5.9; as tests/devices/device_io_reset.mjs for the PC's disks). The disk is
// an in-memory image whose reads and writes complete 100 ms later; the test
// is the driver, through the virtio-mmio registers and a queue in guest RAM:
// - a reset (PSCI SYSTEM_RESET's path) while a read is in flight: its reply
//   never reaches the used ring, it is no longer pending for snapshots;
// - a reset while a write is in flight: the write lands in the image, its
//   reply does not reach the reset device;
// - a snapshot while a read is in flight: it waits for the read, whose reply
//   is in the snapshot's used ring;
// - a snapshot of another device layout (other disks, other slots) is refused.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { SyncBuffer } = await import("../../src/buffer.js");

const SIZE = 1 << 20, LATENCY = 100;
const image = new Uint8Array(SIZE).map((_, i) => i * 7 & 0xFF);
let writes_landed = 0;
const base = new SyncBuffer(image.buffer);
const disk = Object.create(base);
disk.get = (start, length, callback) => setTimeout(() => base.get(start, length, callback), LATENCY);
disk.set = (start, data, callback) => setTimeout(() => base.set(start, data, () => { writes_landed++; callback(); }), LATENCY);

async function machine(disks)
{
    const emulator = new V86({
        cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm", virtio_disks: disks,
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
}
const emulator = await machine([{ buffer: disk, id: "slow" }]);
const cpu = emulator.v86.cpu;
// (no kernel: a machine reset restarts the boot core at RAM's start)
Object.assign(cpu, { booted: true, boot_entry: 0x40000000, boot_x0: 0 });
const slot = 31, transport = cpu.virtio_mmio[slot];
const reg = (offset, value) => value === undefined ? transport.read(offset, 4) : transport.write(offset, 4, value);
assert.equal(reg(0x008), 2, "the disk is virtio-blk, in the last slot");

// the queue in RAM: descriptors, the driver's ring, the device's ring
const RAM = 0x40000000, DESC = RAM + 0x10000, AVAIL = RAM + 0x11000, USED = RAM + 0x12000, BUFFERS = RAM + 0x20000;
const QUEUE = 8;
const u16 = (address, value) => cpu.write_blob_physical(new Uint8Array([value & 0xFF, value >> 8]), address);
const u32 = (address, value) => cpu.write_blob_physical(new Uint8Array(new Uint32Array([value]).buffer), address);
const used_idx = () => cpu.read16_physical(USED + 2);
function driver_init()
{
    reg(0x070, 0);
    reg(0x070, 1 | 2);
    reg(0x024, 1); reg(0x020, 1); // VIRTIO_F_VERSION_1
    reg(0x024, 0); reg(0x020, 0);
    reg(0x070, 1 | 2 | 8);
    assert.equal(reg(0x070) & 8, 8, "FEATURES_OK");
    reg(0x030, 0); reg(0x038, QUEUE);
    reg(0x080, DESC); reg(0x084, 0); reg(0x090, AVAIL); reg(0x094, 0); reg(0x0A0, USED); reg(0x0A4, 0);
    cpu.write_blob_physical(new Uint8Array(0x3000), DESC);
    reg(0x044, 1);
    reg(0x070, 1 | 2 | 8 | 4);
}
let avail = 0;
/** One request: header, data (written by the device for a read), status */
function request(type, sector, data_length, data)
{
    const header = BUFFERS, payload = BUFFERS + 0x100, status = BUFFERS + 0x2000;
    const head = new Uint8Array(16), view = new DataView(head.buffer);
    view.setUint32(0, type, true); view.setUint32(8, sector, true);
    cpu.write_blob_physical(head, header);
    if(data) cpu.write_blob_physical(data, payload);
    cpu.write_blob_physical(new Uint8Array([0xFF]), status);
    const descriptor = (i, address, length, flags, next) => {
        u32(DESC + 16 * i, address); u32(DESC + 16 * i + 4, 0); u32(DESC + 16 * i + 8, length);
        u16(DESC + 16 * i + 12, flags); u16(DESC + 16 * i + 14, next);
    };
    const WRITE = 2, NEXT = 1;
    descriptor(0, header, 16, NEXT, 1);
    descriptor(1, payload, data_length, NEXT | (type === 0 ? WRITE : 0), 2);
    descriptor(2, status, 1, WRITE, 0);
    u16(AVAIL + 4 + 2 * (avail % QUEUE), 0);
    u16(AVAIL + 2, ++avail);
    reg(0x050, 0);
    return { status: () => cpu.read8_physical(status), payload: length => cpu.read_blob_physical(payload, length) };
}

// a read in flight, then a reset of the machine
driver_init();
let r = request(0, 0, 512);
assert.equal(cpu["snapshot_io_pending"], 1, "the read is in flight");
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.equal(used_idx(), 0, "the read's reply did not reach the used ring after the reset");
assert.equal(cpu["snapshot_io_pending"], 0, "and the read is no longer pending");
assert.equal(reg(0x070), 0, "the device is reset");
console.log("ok - a virtio-blk read in flight across a reset is dropped");

// a write in flight, then a reset
avail = 0;
driver_init();
const pattern = new Uint8Array(512).fill(0x5A);
r = request(1, 8, 512, pattern);
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.equal(writes_landed, 1, "the write landed in the image");
assert.deepEqual(image.subarray(8 * 512, 9 * 512), pattern, "with its data");
assert.equal(used_idx(), 0, "its reply did not reach the reset device");
console.log("ok - a virtio-blk write in flight across a reset lands, unanswered");

// a snapshot while a read is in flight waits for it
avail = 0;
driver_init();
r = request(0, 1, 512);
const state = await emulator.save_state();
assert.equal(used_idx(), 1, "the read completed before the snapshot was taken");
assert.equal(r.status(), 0, "VIRTIO_BLK_S_OK");
assert.deepEqual(r.payload(512), image.subarray(512, 1024), "the sector's bytes");
cpu.write_blob_physical(new Uint8Array(0x100), USED);
await emulator.restore_state(state);
assert.equal(used_idx(), 1, "the restored used ring has the reply");
console.log("ok - a snapshot waits for a virtio-blk read in flight");

// another layout's snapshot is refused
const other = await machine([{ buffer: new SyncBuffer(new ArrayBuffer(SIZE)) }, { buffer: new SyncBuffer(new ArrayBuffer(SIZE)) }]);
await assert.rejects(other.restore_state(state), /virtio devices/, "a snapshot of other virtio devices");
console.log("ok - a snapshot of another virtio layout is refused");
await other.destroy();
await emulator.destroy();
console.log("device_io_reset (virt): passed");
