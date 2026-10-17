#!/usr/bin/env node

// An IDE hard disk from a QCOW2 image (docs/disk-image-formats-plan.md P0,
// P1), driven through the ports; no guest code runs. The image is built in
// memory (tests/image/tiny_qcow2.mjs): 3 TiB, data around 2^32 sectors.
// - IDENTIFY reports the virtual size, not the file's; READ SECTORS EXT
//   across 2^32 sectors; writes stay in memory, the image is not changed;
// - a damaged L2 entry: the read ends with ERR/ABRT, the next one works; a
//   write past the memory budget too;
// - snapshots: restored onto the same image, refused before anything is
//   restored for another image;
// - from a file read in ranges: a snapshot waits for the read in flight, a
//   reset drops it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { createHash as create_hash } from "node:crypto";
import { build_qcow2 } from "../image/tiny_qcow2.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SECTORS = 6 * 2 ** 30; // 3 TiB
const BOUNDARY = 2 ** 32 * 512;
const pattern = new Uint8Array(4 * 65536).map((_, i) => i * 31 + (i >> 9) & 0xFF);
const first = new Uint8Array(65536).map((_, i) => i & 0xFF ^ 0x5A);
const image = build_qcow2({
    size: SECTORS * 512,
    data: [[0, first], [BOUNDARY - 2 * 65536, pattern]],
    zero: [65536],
    damaged: [BOUNDARY + 4 * 65536],
});
const image_sha256 = create_hash("sha256").update(image).digest("hex");
const expected = (offset, length) =>
{
    const result = new Uint8Array(length);
    for(const [start, bytes] of [[0, first], [BOUNDARY - 2 * 65536, pattern]])
    {
        const from = Math.max(start, offset), to = Math.min(start + bytes.length, offset + length);
        if(from < to) result.set(bytes.subarray(from - start, to - start), from - offset);
    }
    return result;
};

function config(hda)
{
    return {
        graphics_adapter: "bochs_vga",
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        hda,
        autostart: false,
        memory_size: 32 * 1024 * 1024,
        log_level: 0,
    };
}

const emulator = new V86(config({ buffer: image.buffer, format: "qcow2", overlay_limit: 64 * 1024 * 1024 }));
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const io = emulator.v86.cpu.io;

const DATA = 0x1F0, ERROR = 0x1F1, COUNT = 0x1F2, LBA_LOW = 0x1F3, LBA_MID = 0x1F4, LBA_HIGH = 0x1F5, DEVICE = 0x1F6, COMMAND = 0x1F7, CONTROL = 0x3F6;
const NIEN = 0x02, DRQ = 0x08, ERR = 0x01, BSY = 0x80, ABRT = 0x04;
io.port_write8(CONTROL, NIEN);

function read_words(count)
{
    assert.equal(io.port_read8(COMMAND) & (DRQ | ERR), DRQ, "data ready");
    return Array.from({ length: count }, () => io.port_read16(DATA));
}

function command_ext(lba, count, command)
{
    io.port_write8(DEVICE, 0x40);
    io.port_write8(COUNT, count >> 8);
    io.port_write8(LBA_LOW, Math.floor(lba / 2 ** 24) & 0xFF);
    io.port_write8(LBA_MID, Math.floor(lba / 2 ** 32) & 0xFF);
    io.port_write8(LBA_HIGH, Math.floor(lba / 2 ** 40) & 0xFF);
    io.port_write8(COUNT, count & 0xFF);
    io.port_write8(LBA_LOW, lba & 0xFF);
    io.port_write8(LBA_MID, lba >> 8 & 0xFF);
    io.port_write8(LBA_HIGH, lba >> 16 & 0xFF);
    io.port_write8(COMMAND, command);
}

async function until_ready()
{
    for(let i = 0; i < 1000 && io.port_read8(COMMAND) & BSY; i++) await new Promise(resolve => setTimeout(resolve, 1));
}

async function read_sectors(lba, count)
{
    command_ext(lba, count, 0x24);
    await until_ready();
    const bytes = new Uint8Array(count * 512);
    for(let s = 0; s < count; s++)
    {
        const words = read_words(256);
        words.forEach((w, i) => { bytes[s * 512 + i * 2] = w; bytes[s * 512 + i * 2 + 1] = w >> 8; });
    }
    return bytes;
}

async function write_sectors(lba, bytes)
{
    command_ext(lba, bytes.length / 512, 0x34);
    for(let i = 0; i < bytes.length; i += 2)
    {
        if(i % 512 === 0) assert.equal(io.port_read8(COMMAND) & (DRQ | ERR), DRQ, "ready for data");
        io.port_write16(DATA, bytes[i] | bytes[i + 1] << 8);
    }
    await until_ready();
}

// IDENTIFY: the virtual size
io.port_write8(DEVICE, 0xE0);
io.port_write8(COMMAND, 0xEC);
const identify = read_words(256);
assert.deepEqual(identify.slice(100, 104), [0x0000, 0x8000, 0x0001, 0x0000], "words 100-103: 3 TiB, the image's virtual size");
assert.ok(image.length < 1 << 20, "the file is small");
console.log("ok - IDENTIFY: the virtual size (3 TiB) of a file of " + image.length + " bytes");

// reads: the first sectors, a zero cluster, across 2^32 sectors
assert.deepEqual(await read_sectors(0, 2), expected(0, 1024), "the first sectors");
assert.deepEqual(await read_sectors(128, 1), new Uint8Array(512), "a zero cluster");
const lba = BOUNDARY / 512;
assert.deepEqual(await read_sectors(lba - 2, 4), expected(BOUNDARY - 1024, 2048), "across 2^32 sectors");
console.log("ok - READ SECTORS EXT: the image's data, across 2^32 sectors");

// writes stay in memory
const written = new Uint8Array(1024).map((_, i) => 255 - (i & 0xFF));
await write_sectors(lba + 1, written);
assert.equal(io.port_read8(COMMAND) & ERR, 0);
assert.deepEqual(await read_sectors(lba, 3), Uint8Array.from([...expected(BOUNDARY, 512), ...written]), "read back");
assert.equal(create_hash("sha256").update(image).digest("hex"), image_sha256, "the image is not changed");
console.log("ok - WRITE SECTORS EXT: read back, the image unchanged");

// a damaged L2 entry: ERR with ABRT; the next command works
command_ext(lba + 4 * 128, 1, 0x24);
await until_ready();
assert.equal(io.port_read8(COMMAND) & (ERR | DRQ | BSY), ERR, "the read failed");
assert.equal(io.port_read8(ERROR), ABRT, "ABRT");
assert.deepEqual(await read_sectors(0, 1), expected(0, 512), "the next read works");
console.log("ok - a damaged cluster: the read ends with ERR/ABRT, the disk goes on");

// past the memory budget: the write fails
const budget = emulator.v86.cpu.devices.ide.primary.master.buffer;
budget.overlay.limit = budget.overlay.size() + 512;
command_ext(1000, 2, 0x34);
for(let i = 0; i < 512; i++) io.port_write16(DATA, 0x1111);
await until_ready();
assert.equal(io.port_read8(COMMAND) & (ERR | DRQ), ERR, "the write (two sectors, more than the budget) failed");
assert.equal(io.port_read8(ERROR), ABRT);
budget.overlay.limit = Infinity;
console.log("ok - a write past the memory budget ends with ERR/ABRT");

// snapshots
const state = await emulator.save_state();
await write_sectors(lba + 1, new Uint8Array(1024));
await emulator.restore_state(state);
assert.deepEqual(await read_sectors(lba + 1, 2), written, "the snapshot's writes");
const other = new V86(config({ buffer: build_qcow2({ size: SECTORS * 512, data: [[0, first]] }).buffer, format: "qcow2" }));
await new Promise(resolve => other.add_listener("emulator-loaded", resolve));
const memory_before = other.v86.cpu.mem8.slice(0, 1 << 20);
await assert.rejects(other.restore_state(state), /another image/);
assert.deepEqual(other.v86.cpu.mem8.slice(0, 1 << 20), memory_before, "nothing was restored");
const raw = new V86(config({ buffer: new ArrayBuffer(16 << 20) }));
await new Promise(resolve => raw.add_listener("emulator-loaded", resolve));
await assert.rejects(raw.restore_state(state), /container format, this machine's is RAW/);
other.destroy();
raw.destroy();
console.log("ok - snapshots: restored onto the same image; another image or RAW refused before restoring");
emulator.destroy();

// a file read in ranges: in-flight reads, snapshots and resets
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-image-"));
const image_file = path.join(temp, "disk.qcow2");
fs.writeFileSync(image_file, image);
const lazy = new V86(config({ url: image_file, async: true, format: "auto" }));
let error;
lazy.add_listener("emulator-error", e => { error = e; });
await new Promise(resolve => lazy.add_listener("emulator-loaded", resolve));
assert.equal(error, undefined);
const cpu = lazy.v86.cpu;
const lazy_io = cpu.io;
lazy_io.port_write8(CONTROL, NIEN);
const drive = cpu.devices.ide.primary.master;
let completed = false;
drive.read_buffer(BOUNDARY - 65536, 4096, data => { completed = data; });
assert.equal(cpu["snapshot_io_pending"], 1, "a read in flight");
const saved = await lazy.save_state();
assert.ok(completed, "the snapshot waited for it");
assert.deepEqual(completed, expected(BOUNDARY - 65536, 4096));
assert.ok(saved.byteLength > 0);
completed = false;
drive.read_buffer(4 * 65536 + BOUNDARY, 512, () => { completed = true; }, () => { completed = true; });
cpu.reboot_internal("test");
await new Promise(resolve => setTimeout(resolve, 200));
assert.equal(completed, false, "a reset drops the read in flight");
assert.equal(cpu["snapshot_io_pending"], 0);
lazy.destroy();
fs.rmSync(temp, { recursive: true });
console.log("ok - from a file: a snapshot waits for the read in flight, a reset drops it");

// a disk that cannot be opened: emulator-error
const broken = new V86(config({ buffer: new Uint8Array(65536).buffer, format: "qcow2" }));
const failure = await new Promise(resolve => broken.add_listener("emulator-error", resolve));
assert.match(failure.message, /hda: not a qcow2 image/);
console.log("ok - a disk that is not of its format fails the start (emulator-error)");

console.log("IDE disk image tests passed");
