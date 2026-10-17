#!/usr/bin/env node
// virtio-blk disks with logical sectors of 4096 bytes (docs/disk-image-formats-plan.md,
// the appendix's "4K 逻辑扇区") on the virt machine, the test the driver
// through the virtio-mmio registers and a queue in guest RAM (as
// tests/a64/virtio_blk_disk_image.mjs): a RAW disk with logical_sector_size
// 4096, a VHDX image with 4096-byte sectors (tests/image/tiny_vhdx.mjs) and a
// 512-byte disk.
// - BLK_SIZE offered, blk_size the disk's sector size; the capacity and the
//   requests' sector numbers in 512-byte units;
// - reads and writes of whole 4096-byte sectors; one that starts or ends
//   inside a sector ends with VIRTIO_BLK_S_IOERR (as QEMU's) and writes
//   nothing;
// - a snapshot is restored onto the same disks and refused, before anything
//   is restored, where a disk's sector size is another.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build_vhdx } from "../image/tiny_vhdx.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SIZE = 4 << 20, S = 4096;
const raw_bytes = new Uint8Array(SIZE).map((_, i) => i * 7 + (i >> 12) & 0xFF);
const vhdx_data = new Uint8Array(1 << 20).map((_, i) => i * 3 + 1 & 0xFF);
const vhdx = build_vhdx({ size: SIZE, logical_sector_size: 4096, data: [[0, vhdx_data]] });
const disks = () => [
    { buffer: raw_bytes.buffer, logical_sector_size: 4096, id: "raw4k" },
    { buffer: vhdx.image.slice().buffer, format: "vhdx", id: "vhdx4k" },
    { buffer: new ArrayBuffer(SIZE), id: "raw512" },
];

async function machine(virtio_disks)
{
    const emulator = new V86({
        cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm", virtio_disks,
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
}

const RAM = 0x40000000, DESC = RAM + 0x10000, AVAIL = RAM + 0x11000, USED = RAM + 0x12000, BUFFERS = RAM + 0x20000;
const QUEUE = 8;
const T_IN = 0, T_OUT = 1, S_OK = 0, S_IOERR = 1;

/** The driver of the disk in a virtio-mmio slot (the disks take the slots from 31 down) */
function driver(emulator, slot)
{
    const cpu = emulator.v86.cpu, transport = cpu.virtio_mmio[slot];
    const reg = (offset, value) => value === undefined ? transport.read(offset, 4) : transport.write(offset, 4, value);
    const u16 = (address, value) => cpu.write_blob_physical(new Uint8Array([value & 0xFF, value >> 8]), address);
    const u32 = (address, value) => cpu.write_blob_physical(new Uint8Array(new Uint32Array([value]).buffer), address);
    let avail = 0;
    reg(0x070, 0);
    reg(0x070, 1 | 2);
    reg(0x014, 0);
    const features = reg(0x010);
    reg(0x024, 1); reg(0x020, 1); // VIRTIO_F_VERSION_1
    reg(0x024, 0); reg(0x020, 1 << 6); // VIRTIO_BLK_F_BLK_SIZE
    reg(0x070, 1 | 2 | 8);
    assert.equal(reg(0x070) & 8, 8, "FEATURES_OK");
    reg(0x030, 0); reg(0x038, QUEUE);
    reg(0x080, DESC); reg(0x084, 0); reg(0x090, AVAIL); reg(0x094, 0); reg(0x0A0, USED); reg(0x0A4, 0);
    cpu.write_blob_physical(new Uint8Array(0x3000), DESC);
    reg(0x044, 1);
    reg(0x070, 1 | 2 | 8 | 4);
    return {
        features,
        capacity: reg(0x100) + reg(0x104) * 2 ** 32,
        blk_size: reg(0x114),
        /** One request, completed: its status and (a read's) data */
        async request(type, sector, data_length, data)
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
            descriptor(0, header, 16, NEXT, 1);
            descriptor(1, payload, data_length, NEXT | (type === T_IN ? WRITE : 0), 2);
            descriptor(2, status, 1, WRITE, 0);
            u16(AVAIL + 4 + 2 * (avail % QUEUE), 0);
            const expected = ++avail;
            u16(AVAIL + 2, expected);
            reg(0x050, 0);
            for(let i = 0; cpu.read16_physical(USED + 2) !== expected; i++)
            {
                assert.ok(i < 1000, "the request completes");
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            return { status: cpu.read8_physical(status), data: cpu.read_blob_physical(payload, data_length) };
        },
    };
}

const emulator = await machine(disks());
for(const [slot, name, contents] of [[31, "RAW", raw_bytes], [30, "VHDX", null]])
{
    const disk = driver(emulator, slot);
    const at = (offset, length) => contents ? contents.slice(offset, offset + length) :
        Uint8Array.from({ length }, (_, i) => offset + i < vhdx_data.length ? vhdx_data[offset + i] : 0);
    assert.ok(disk.features & 1 << 6, name + ": VIRTIO_BLK_F_BLK_SIZE");
    assert.equal(disk.blk_size, 4096, name + ": blk_size");
    assert.equal(disk.capacity, SIZE / 512, name + ": the capacity in 512-byte sectors");
    let r = await disk.request(T_IN, 8, 2 * S);
    assert.equal(r.status, S_OK);
    assert.deepEqual(r.data, at(S, 2 * S), name + ": sector 8 (512-byte units) is the second 4096-byte sector");
    for(const [sector, length] of [[1, S], [8, 512], [12, S], [8, S + 512]])
    {
        r = await disk.request(T_IN, sector, length);
        assert.equal(r.status, S_IOERR, name + ": a read of " + length + " bytes at sector " + sector + " is not of whole sectors");
    }
    const data = new Uint8Array(2 * S).map((_, i) => 255 - (i * 5 & 0xFF));
    r = await disk.request(T_OUT, 2 * 8, 2 * S, data);
    assert.equal(r.status, S_OK);
    r = await disk.request(T_OUT, 4 * 8 + 4, S, new Uint8Array(S).fill(0x11));
    assert.equal(r.status, S_IOERR, name + ": a write inside a sector");
    r = await disk.request(T_OUT, 6 * 8, 1024, new Uint8Array(1024).fill(0x22));
    assert.equal(r.status, S_IOERR, name + ": a write of part of a sector");
    r = await disk.request(T_IN, 0, 8 * S);
    const expected = at(0, 8 * S);
    expected.set(data, 2 * S);
    assert.deepEqual(r.data, expected, name + ": the write read back, the failed ones wrote nothing");
    if(contents) assert.deepEqual(raw_bytes.subarray(2 * S, 4 * S), data, name + ": in the image");
}
{
    const disk = driver(emulator, 29);
    assert.equal(disk.blk_size, 512, "the 512-byte disk: blk_size 512");
    const r = await disk.request(T_IN, 1, 512);
    assert.equal(r.status, S_OK, "the 512-byte disk: a read of one sector");
}
console.log("ok - virtio-blk: blk_size 4096 (RAW and VHDX), the capacity and sectors in 512-byte units, " +
    "reads and writes of whole sectors, IOERR for parts of one");

// snapshots: onto the same disks; refused where a disk's sector size is another
const state = await emulator.save_state();
await emulator.destroy();
{
    const same = await machine(disks());
    await same.restore_state(state);
    const r = await driver(same, 31).request(T_IN, 16, S);
    assert.equal(r.status, S_OK);
    await same.destroy();
    const other_disks = disks();
    delete other_disks[0].logical_sector_size;
    const other = await machine(other_disks);
    const marker = new Uint8Array([0xC0, 0xFF, 0xEE, 0x42]);
    other.v86.cpu.write_blob_physical(marker, RAM);
    await assert.rejects(other.restore_state(state), /4096-byte sectors, this one 512/, "a 512-byte disk refuses the snapshot");
    assert.deepEqual(other.v86.cpu.read_blob_physical(RAM, 4), marker, "nothing was restored");
    await other.destroy();
}
console.log("ok - snapshots: restored onto the same disks, refused before anything is restored onto a 512-byte one");
console.log("virtio_blk_sector_size: passed");
