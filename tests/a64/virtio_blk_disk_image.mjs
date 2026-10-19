#!/usr/bin/env node
// virtio-blk on a disk image in a container format (docs/disk-image-formats-plan.md,
// the merge of disk-formats with arm64): a QCOW2 image built in memory
// (tests/image/tiny_qcow2.mjs) behind the virt machine's virtio-blk, the
// test the driver through the virtio-mmio registers and a queue in guest
// RAM (as tests/a64/device_io_reset.mjs):
// - reads of data and unallocated clusters, and of the guest's writes;
// - a read of a damaged cluster (the image fails it) ends with
//   VIRTIO_BLK_S_IOERR, and the next read is fine;
// - a write beyond the overlay's memory budget ends with VIRTIO_BLK_S_IOERR
//   and leaves the disk as it was; FLUSH is fine;
// - a snapshot restores the guest's writes, and is refused, before anything
//   is restored, onto another image or onto a RAW disk;
// - export_disk_image and disk_image_info know the disk as virtio_disk0
//   (hda when given as hda); the export of the damaged image fails.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build_qcow2 } from "../image/tiny_qcow2.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { SyncBuffer } = await import("../../src/buffer.js");

const SIZE = 4 << 20, CLUSTER = 1 << 16;
const first = new Uint8Array(CLUSTER).map((_, i) => i * 13 + 5 & 0xFF);
const image = build_qcow2({ size: SIZE, data: [[0, first]], damaged: [CLUSTER] });
// (the same size, other data: another image)
const other_image = build_qcow2({ size: SIZE, data: [[0, new Uint8Array(CLUSTER).fill(1)], [2 * CLUSTER, new Uint8Array(CLUSTER).fill(2)]] });
const BUDGET = 16 * 256;

async function machine(options)
{
    const emulator = new V86({
        cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm", ...options,
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
}
const qcow2_disk = (bytes, id) => ({ buffer: bytes.slice().buffer, format: "qcow2", overlay_limit: BUDGET, id, disk_error: "report" });

const emulator = await machine({ virtio_disks: [qcow2_disk(image, "qcow2disk")] });
const cpu = emulator.v86.cpu;
const slot = 31, transport = cpu.virtio_mmio[slot];
const reg = (offset, value) => value === undefined ? transport.read(offset, 4) : transport.write(offset, 4, value);
assert.equal(reg(0x008), 2, "the disk is virtio-blk, in the last slot");
assert.equal(reg(0x100) + reg(0x104) * 2 ** 32, SIZE / 512, "the capacity is the image's virtual size");

const RAM = 0x40000000, DESC = RAM + 0x10000, AVAIL = RAM + 0x11000, USED = RAM + 0x12000, BUFFERS = RAM + 0x20000;
const QUEUE = 8;
const u16 = (address, value) => cpu.write_blob_physical(new Uint8Array([value & 0xFF, value >> 8]), address);
const u32 = (address, value) => cpu.write_blob_physical(new Uint8Array(new Uint32Array([value]).buffer), address);
const used_idx = () => cpu.read16_physical(USED + 2);
let avail = 0;
function driver_init()
{
    avail = 0;
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
const T_IN = 0, T_OUT = 1, T_FLUSH = 4, S_OK = 0, S_IOERR = 1;
/** One request, completed: its status and (a read's) data */
async function request(type, sector, data_length, data)
{
    const header = BUFFERS, payload = BUFFERS + 0x100, status = BUFFERS + 0x40000;
    const head = new Uint8Array(16), view = new DataView(head.buffer);
    view.setUint32(0, type, true); view.setUint32(8, sector, true);
    cpu.write_blob_physical(head, header);
    cpu.write_blob_physical(data || new Uint8Array(data_length).fill(0xEE), payload);
    cpu.write_blob_physical(new Uint8Array([0xFF]), status);
    const descriptor = (i, address, length, flags, next) => {
        u32(DESC + 16 * i, address); u32(DESC + 16 * i + 4, 0); u32(DESC + 16 * i + 8, length);
        u16(DESC + 16 * i + 12, flags); u16(DESC + 16 * i + 14, next);
    };
    const WRITE = 2, NEXT = 1;
    descriptor(0, header, 16, NEXT, data_length ? 1 : 2);
    if(data_length) descriptor(1, payload, data_length, NEXT | (type === T_IN ? WRITE : 0), 2);
    descriptor(2, status, 1, WRITE, 0);
    u16(AVAIL + 4 + 2 * (avail % QUEUE), 0);
    const expected = ++avail;
    u16(AVAIL + 2, expected);
    reg(0x050, 0);
    for(let i = 0; used_idx() !== expected; i++)
    {
        assert.ok(i < 1000, "the request completes");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(cpu["snapshot_io_pending"], 0, "nothing is left in flight");
    return { status: cpu.read8_physical(status), data: data_length ? cpu.read_blob_physical(payload, data_length) : undefined };
}

driver_init();
let r = await request(T_IN, 0, 4096);
assert.equal(r.status, S_OK);
assert.deepEqual(r.data, first.subarray(0, 4096), "a data cluster's bytes");
r = await request(T_IN, 2 * CLUSTER / 512, 4096);
assert.equal(r.status, S_OK);
assert.deepEqual(r.data, new Uint8Array(4096), "an unallocated cluster reads as zeroes");
console.log("ok - virtio-blk reads a QCOW2 image's virtual disk");

r = await request(T_IN, CLUSTER / 512, 512);
assert.equal(r.status, S_IOERR, "a read of a damaged cluster: VIRTIO_BLK_S_IOERR");
r = await request(T_IN, CLUSTER / 512 - 1, 1024);
assert.equal(r.status, S_IOERR, "also a read that ends in it");
r = await request(T_IN, 8, 512);
assert.equal(r.status, S_OK, "the next read is fine");
assert.deepEqual(r.data, first.subarray(8 * 512, 9 * 512));
console.log("ok - a read the disk image fails ends with VIRTIO_BLK_S_IOERR");

const written = new Uint8Array(1024).fill(0x5A);
r = await request(T_OUT, 4, 1024, written);
assert.equal(r.status, S_OK, "a write within the budget");
r = await request(T_OUT, 64, BUDGET, new Uint8Array(BUDGET).fill(0x77));
assert.equal(r.status, S_IOERR, "a write beyond the overlay's budget: VIRTIO_BLK_S_IOERR");
r = await request(T_FLUSH, 0, 0);
assert.equal(r.status, S_OK, "FLUSH");
r = await request(T_IN, 0, 4096);
const expected = first.slice(0, 4096);
expected.set(written, 4 * 512);
assert.deepEqual(r.data, expected, "the write within the budget is read back");
r = await request(T_IN, 64, BUDGET);
assert.deepEqual(r.data, first.subarray(64 * 512, 64 * 512 + BUDGET), "the failed write changed nothing");
console.log("ok - a write beyond the budget ends with VIRTIO_BLK_S_IOERR, FLUSH is fine");

// snapshots: the guest's writes come back, onto the same image only
const state = await emulator.save_state();
r = await request(T_OUT, 4, 512, new Uint8Array(512).fill(0x11));
assert.equal(r.status, S_OK);
await emulator.restore_state(state);
driver_init();
r = await request(T_IN, 0, 4096);
assert.deepEqual(r.data, expected, "the snapshot's disk: the later write is gone");
console.log("ok - a snapshot restores the disk image's changes");

const marker = new Uint8Array([0xC0, 0xFF, 0xEE, 0x42]);
for(const [what, options, pattern] of [
    ["another image", { virtio_disks: [qcow2_disk(other_image)] }, /another image/],
    ["a RAW disk", { virtio_disks: [{ buffer: new SyncBuffer(new ArrayBuffer(SIZE)) }] }, /container format/],
])
{
    const target = await machine(options);
    target.v86.cpu.write_blob_physical(marker, RAM);
    await assert.rejects(target.restore_state(state), pattern, "the snapshot onto " + what);
    assert.deepEqual(target.v86.cpu.read_blob_physical(RAM, 4), marker, "nothing was restored (" + what + ")");
    await target.destroy();
}
console.log("ok - the snapshot is refused onto another image and onto a RAW disk, before anything is restored");

// export, by the disk's name
const info = await emulator.disk_image_info("virtio_disk0");
assert.equal(info.format, "qcow2");
assert.equal(info.size, SIZE);
assert.equal(info.file_size, image.length);
assert.ok(info.written >= 1024, "the guest's writes are counted");
await assert.rejects(emulator.export_disk_image("virtio_disk0", { write: () => {} }), /reserved bits set/,
    "the export of the image with the damaged cluster fails");
await assert.rejects(emulator.export_disk_image("virtio_disk1", { write: () => {} }), /No disk virtio_disk1/);
await emulator.destroy();

// (hda on virt: the first virtio-blk disk, by the name hda)
const clean = build_qcow2({ size: SIZE, data: [[0, first]] });
const as_hda = await machine({ hda: qcow2_disk(clean) });
assert.equal((await as_hda.disk_image_info("hda")).format, "qcow2");
const chunks = [];
const total = await as_hda.export_disk_image("hda", { write: chunk => { chunks.push(chunk.slice()); } });
assert.equal(total, SIZE);
const exported = new Uint8Array(SIZE);
let at = 0;
for(const chunk of chunks) { exported.set(chunk, at); at += chunk.length; }
assert.equal(at, SIZE);
const raw = new Uint8Array(SIZE);
raw.set(first);
assert.deepEqual(exported, raw, "the export is the virtual disk");
await as_hda.destroy();
console.log("ok - export_disk_image and disk_image_info know the virtio disks");
console.log("virtio_blk_disk_image: passed");
