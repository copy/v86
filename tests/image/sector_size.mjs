#!/usr/bin/env node
// Logical sectors of 4096 bytes in the image layer (docs/disk-image-formats-plan.md,
// the appendix's "4K 逻辑扇区"):
// - the VHDX builder (tests/image/tiny_vhdx.mjs) against qemu-img: its
//   512-byte images pass qemu-img check and convert to the data written,
//   also past a chunk's sector bitmap entry (qemu-img neither makes nor
//   opens VHDX images with 4096-byte logical sectors)
// - VHDX with 4096-byte logical sectors: qemu-img's dynamic.vhdx with its
//   logical sector size changed (the BAT is the same while the disk has
//   fewer blocks than a chunk) reads as base.raw; a built 100 GiB image with
//   blocks of 1 MiB (a chunk: 32 GiB) across its sector bitmap entries, ZERO
//   and NOT_PRESENT blocks
// - the descriptor's logical_sector_size: for RAW, QCOW2, VHD, VDI and VMDK
//   images (whose files have no sector size of their own), a VHDX's own must
//   agree, a parent that has one gives it to its child; 512 or 4096 only, a
//   size that is not a multiple of it, hard disks only

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { make_samples, SAMPLES_DIR, random_bytes, random_generator } from "./samples.mjs";
import { sample_file, read, open_sample, open_bytes, rejects, compare } from "./helpers.mjs";
import { build_vhdx } from "./tiny_vhdx.mjs";
import { check_image_options, create_disk_image, open_image } from "../../src/image/factory.js";
import { settings } from "./helpers.mjs";

process.on("unhandledRejection", exn => { throw exn; });

const QEMU_IMG = process.env.QEMU_IMG || (fs.existsSync("/opt/homebrew/bin/qemu-img") ? "/opt/homebrew/bin/qemu-img" : "qemu-img");
const manifest = make_samples();
const base = fs.readFileSync(sample_file("base.raw"));
const KiB = 1024, MiB = 1024 * 1024, GiB = 1024 * MiB;
const work = path.join(SAMPLES_DIR, "..", "disk-image-sector-size");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const qemu_img = (...args) => execFileSync(QEMU_IMG, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
/** a file read in ranges (an async URL in Node) */
const open_file = (file, format, extra = {}) => open_image("hda", { url: file, async: true, format, ...extra }, settings);

const next = random_generator(0x4096);
const chunk = (offset, length) => [offset, random_bytes(next, length)];
/** the bytes of `data` ([offset, bytes]) in [offset, offset + length) */
const expected = (data, offset, length) =>
{
    const result = new Uint8Array(length);
    for(const [start, bytes] of data)
    {
        const from = Math.max(start, offset), to = Math.min(start + bytes.length, offset + length);
        if(from < to) result.set(bytes.subarray(from - start, to - start), from - offset);
    }
    return result;
};

// the builder against qemu-img: 5 GiB of 1 MiB blocks with 512-byte
// sectors (a chunk of 4096 blocks, 4 GiB: the sector bitmap entry 4096)
{
    const data = [chunk(0, 8192), chunk(4 * GiB - 4096, 12288), chunk(5 * GiB - 65536, 65536)];
    const built = build_vhdx({ size: 5 * GiB, logical_sector_size: 512, data, zero: [3 * MiB] });
    assert.equal(built.chunk_ratio, 4096);
    const file = path.join(work, "built-512.vhdx");
    fs.writeFileSync(file, built.image);
    const check = qemu_img("check", "-f", "vhdx", file);
    assert.match(check, /No errors were found/, "qemu-img check: " + check);
    const info = JSON.parse(qemu_img("info", "--output=json", "-f", "vhdx", file));
    assert.equal(info["virtual-size"], 5 * GiB, "qemu-img: the virtual size");
    // (converted whole: a sparse file of 5 GiB)
    const raw = path.join(work, "built-512.raw");
    qemu_img("convert", "-f", "vhdx", "-O", "raw", file, raw);
    const fd = fs.openSync(raw, "r");
    const reader = await open_bytes(built.image, "vhdx");
    assert.equal(reader.logical_sector_size, 512);
    for(const [offset, length] of [[0, 65536], [4 * GiB - 65536, 131072], [5 * GiB - 131072, 131072], [3 * MiB, 65536]])
    {
        const part = new Uint8Array(length);
        assert.equal(fs.readSync(fd, part, 0, length, offset), length);
        compare(part, expected(data, offset, length), "qemu-img reads the built image at " + offset);
        compare(await read(reader, offset, length), expected(data, offset, length), "v86 reads the built image at " + offset);
    }
    fs.closeSync(fd);
    fs.rmSync(raw);
    console.log("ok - the VHDX builder: qemu-img check passes, qemu-img and v86 read what was written, across a sector bitmap entry");
}

// qemu-img's dynamic.vhdx with 4096-byte logical sectors
const image = fs.readFileSync(sample_file("dynamic.vhdx"));
const view = b => new DataView(b.buffer, b.byteOffset, b.length);
const metadata_offset = (() =>
{
    const v = view(image);
    for(let i = 0; i < v.getUint32(192 * KiB + 8, true); i++)
    {
        const entry = 192 * KiB + 16 + i * 32;
        if(v.getUint32(entry, true) === 0x8B7CA206) return Number(v.getBigUint64(entry + 16, true));
    }
    throw new Error("no metadata region");
})();
const item = (b, guid_first) =>
{
    const v = view(b);
    for(let i = 0; i < v.getUint16(metadata_offset + 10, true); i++)
    {
        const entry = metadata_offset + 32 + i * 32;
        if(v.getUint32(entry, true) === guid_first) return metadata_offset + v.getUint32(entry + 16, true);
    }
    throw new Error("no metadata item " + guid_first.toString(16));
};
const LOGICAL = 0x8141BF1D, PHYSICAL = 0xCDA348C7;
const image_4k = new Uint8Array(image);
view(image_4k).setUint32(item(image_4k, LOGICAL), 4096, true);
view(image_4k).setUint32(item(image_4k, PHYSICAL), 4096, true);
{
    for(const how of ["memory", "url"])
    {
        let reader;
        if(how === "memory") reader = await open_bytes(image_4k, "vhdx");
        else
        {
            fs.writeFileSync(path.join(work, "dynamic-4k.vhdx"), image_4k);
            reader = await open_file(path.join(work, "dynamic-4k.vhdx"), "auto");
        }
        assert.equal(reader.logical_sector_size, 4096, "the image's sector size");
        assert.equal(reader.virtual_size, base.length);
        for(let offset = 0; offset < base.length; offset += MiB)
        {
            compare(await read(reader, offset, MiB), base.subarray(offset, offset + MiB), "4K dynamic.vhdx at " + offset);
        }
        for(const [offset, length] of [[4096, 4096], [base.length - 4096, 4096], [12288, 3 * 65536]])
        {
            compare(await read(reader, offset, length), base.subarray(offset, offset + length), "4K dynamic.vhdx range " + offset);
        }
    }
    // a disk of 4096-byte sectors for the devices
    const disk = create_disk_image("hda", { buffer: image_4k.slice().buffer, format: "vhdx" }, settings);
    await disk.load();
    assert.equal(disk.logical_sector_size, 4096, "the device's sector size");
    assert.equal(disk.byteLength, base.length);
    // (QEMU does not open such an image: the reference is the unchanged one's)
    assert.throws(() => qemu_img("info", "-f", "vhdx", path.join(work, "dynamic-4k.vhdx")), /Operation not supported/,
        "qemu-img refuses a VHDX with 4096-byte logical sectors");
    console.log("ok - VHDX with 4096-byte logical sectors (qemu-img's dynamic.vhdx, its sector sizes changed): reads as base.raw " +
        "(qemu-img itself does not open it)");
}

// a built 100 GiB 4K image: blocks of 1 MiB, a chunk of 32768 blocks (32 GiB)
{
    const data = [chunk(0, 8192), chunk(32 * GiB - 8192, 16384), chunk(64 * GiB + 4096, 4096), chunk(100 * GiB - 4096, 4096)];
    const built = build_vhdx({ size: 100 * GiB, logical_sector_size: 4096, data, zero: [50 * GiB] });
    assert.equal(built.chunk_ratio, 32768);
    const reader = await open_bytes(built.image, "vhdx");
    assert.equal(reader.logical_sector_size, 4096);
    assert.equal(reader.virtual_size, 100 * GiB);
    assert.equal(reader.bat_index(32768), 32769, "the sector bitmap entry after the first chunk");
    for(const [offset, length] of [[0, 65536], [32 * GiB - 65536, 131072], [64 * GiB, 65536], [100 * GiB - 65536, 65536],
        [50 * GiB, MiB], [80 * GiB, MiB]])
    {
        compare(await read(reader, offset, length), expected(data, offset, length), "the built 4K image at " + offset);
    }
    // a block whose entry is the sector bitmap's: the payload entries around it are the disk's
    const shifted = new Uint8Array(built.image);
    view(shifted).setBigUint64(built.bat_offset + 32768 * 8, 6n | 1n << 20n, true);
    const shifted_reader = await open_bytes(shifted, "vhdx");
    compare(await read(shifted_reader, 32 * GiB - 8192, 16384), expected(data, 32 * GiB - 8192, 16384), "a sector bitmap entry is not a block's");
    console.log("ok - a built 100 GiB VHDX with 4096-byte sectors: across the sector bitmap entries, ZERO and NOT_PRESENT blocks");
}

// the descriptor's logical_sector_size
{
    const option = { logical_sector_size: 4096 };
    for(const [name, format] of [["v3.qcow2", "qcow2"], ["dynamic.vhd", "vhd"], ["dynamic.vdi", "vdi"], ["sparse.vmdk", "vmdk"]])
    {
        const reader = await open_sample(name, format, "url", option);
        assert.equal(reader.logical_sector_size, 4096, name);
        const plain = await open_sample(name, format, "url");
        assert.equal(plain.logical_sector_size, 512, name + " without the option");
        compare(await read(reader, 65536, 65536), await read(plain, 65536, 65536), name + ": the same data");
    }
    // RAW through the factory (as a parent is: format "raw")
    const raw = await open_bytes(base, "raw", option);
    assert.equal(raw.logical_sector_size, 4096);
    // a size that is not a multiple of 4096
    await rejects(open_bytes(base.subarray(0, base.length - 512), "raw", option), /size 67108352 is not a multiple of its 4096-byte sectors/, "config");
    assert.equal((await open_bytes(base.subarray(0, base.length - 512), "raw")).logical_sector_size, 512, "512: as before");
    // a VHDX's own must agree
    await rejects(open_bytes(image_4k, "vhdx", { logical_sector_size: 512 }),
        /logical sectors of 512 bytes \(logical_sector_size\), but the image's are 4096 bytes/, "config");
    await rejects(open_bytes(new Uint8Array(image), "vhdx", option),
        /logical sectors of 4096 bytes \(logical_sector_size\), but the image's are 512 bytes/, "config");
    assert.equal((await open_bytes(image_4k, "vhdx", option)).logical_sector_size, 4096, "the same: accepted");
    assert.equal((await open_bytes(new Uint8Array(image), "vhdx", { logical_sector_size: 512 })).logical_sector_size, 512);
    console.log("ok - logical_sector_size of the descriptor: for formats without their own, a VHDX's must agree");
}

// a parent with a sector size gives it to its child; the child's descriptor must agree
{
    const child = path.join(work, "child-of-4k.qcow2");
    qemu_img("create", "-q", "-f", "qcow2", "-u", "-o", "compat=1.1", "-b", "parent-4k.vhdx", "-F", "vhdx", child, String(base.length));
    const backing = { buffer: image_4k.slice().buffer, format: "vhdx" };
    const reader = await open_file(child, "qcow2", { backing });
    assert.equal(reader.logical_sector_size, 4096, "the child of a 4K parent");
    compare(await read(reader, 0, MiB), base.subarray(0, MiB), "the child reads the parent");
    await rejects(open_file(child, "qcow2", { backing, logical_sector_size: 512 }),
        /logical sectors of 512 bytes \(logical_sector_size\), but the parent image's are 4096 bytes/, "config");
    // a parent without a sector size of its own: the child's
    const plain_parent = await open_file(child, "qcow2", { backing: { buffer: new Uint8Array(image).buffer, format: "vhdx" } });
    assert.equal(plain_parent.logical_sector_size, 512, "a 512-byte VHDX parent");
    console.log("ok - a child image takes its parent's 4096-byte sectors; a descriptor's 512 then is an error");
}

// options: the values, hard disks only
{
    for(const value of [1024, 0, "4096", 520, 8192])
    {
        assert.throws(() => check_image_options("hda", { buffer: new ArrayBuffer(8192), logical_sector_size: value }, true),
            /logical_sector_size/, String(value));
    }
    assert.throws(() => check_image_options("cdrom", { buffer: new ArrayBuffer(8192), logical_sector_size: 4096 }, false),
        /logical_sector_size is for hard disks/);
    assert.throws(() => check_image_options("fda", { buffer: new ArrayBuffer(8192), logical_sector_size: 512 }, false),
        /logical_sector_size is for hard disks/);
    assert.equal(check_image_options("hda", { buffer: new ArrayBuffer(8192), logical_sector_size: 4096 }, true), undefined,
        "RAW: a buffer of src/buffer.js");
    console.log("ok - logical_sector_size: 512 or 4096, for hard disks");
}

fs.rmSync(work, { recursive: true, force: true });
console.log("sector size tests passed");
