#!/usr/bin/env node
// src/android/ on the real images, when they are here (each part skipped
// otherwise; docs/android-images-plan.md I1, I2): Cuttlefish's image zip
// and the GSI's zip read as zips, super's metadata written again as it was,
// and the bootloader's work from tools/a64_android.mjs's disk.img giving
// that tool's initrd.img, initrd-venus.img and command line.
//
//   node tests/android/real_images.mjs [--out build/a64-android/out]

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash as create_hash } from "node:crypto";
import { equals } from "../../src/android/bytes.js";
import { zip_entries, zip_stream, zip_read } from "../../src/android/zip.js";
import { sparse_read } from "../../src/android/sparse.js";
import { lp_metadata, lp_parse, lp_serialize } from "../../src/android/lp.js";
import { gpt_partitions } from "../../src/android/gpt.js";
import { vbmeta_struct } from "../../src/android/avb.js";
import { CF_ARM64_ONLY_PHONE } from "../../src/android/devices.js";
import { android_boot } from "../../src/android/boot.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const A = ROOT + "build/a64-android/";
const out_arg = process.argv.indexOf("--out");
const OUT = out_arg > 0 ? path.resolve(process.argv[out_arg + 1]) + "/" : A + "out/";

function file_reader(file)
{
    const fd = fs.openSync(file, "r");
    return (offset, length) =>
    {
        const b = Buffer.allocUnsafe(length);
        return b.subarray(0, fs.readSync(fd, b, 0, length, offset));
    };
}
const sha256 = bytes => create_hash("sha256").update(bytes).digest("hex");
let ran = 0;
async function part(name, files, f)
{
    const missing = files.filter(file => !fs.existsSync(file));
    if(missing.length) { console.log(`skip ${name} (no ${missing.map(m => path.relative(ROOT, m)).join(", ")})`); return; }
    const start = Date.now();
    await f();
    ran++;
    console.log(`ok ${name} (${((Date.now() - start) / 1000).toFixed(1)} s)`);
}

const CF_ZIP = A + "dl/aosp_cf_arm64_only_phone-img-15581820.zip";
await part("Cuttlefish image zip", [CF_ZIP, A + "img/boot.img", A + "img/vbmeta.img"], async () =>
{
    const read = file_reader(CF_ZIP);
    const entries = await zip_entries(read, fs.statSync(CF_ZIP).size);
    const names = entries.map(e => e.name).sort();
    for(const name of ["boot.img", "init_boot.img", "vendor_boot.img", "super.img", "userdata.img", "vbmeta.img", "vbmeta_system.img"])
    {
        assert.ok(names.includes(name), name);
    }
    for(const name of ["vbmeta.img", "boot.img"])
    {
        const data = await zip_read(read, entries.find(e => e.name === name));
        assert.ok(equals(data, fs.readFileSync(A + "img/" + name)), name);
    }
    // (super's sparse header, without inflating the rest)
    const head = await zip_read(read, entries.find(e => e.name === "super.img"), 28);
    assert.equal(head.length, 28);
    assert.equal(head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24, 0xED26FF3A | 0);
});

const GSI_ZIP = A + "dl/gsi/aosp_arm64-exp-BP2A.250605.031.A3-13578795-82277143.zip";
await part("GSI zip", [GSI_ZIP], async () =>
{
    const read = file_reader(GSI_ZIP);
    const entries = await zip_entries(read, fs.statSync(GSI_ZIP).size);
    const system = entries.find(e => e.name === "system.img");
    assert.ok(system, "system.img");
    const vbmeta = vbmeta_struct(await zip_read(read, entries.find(e => e.name === "vbmeta.img")));
    assert.equal(vbmeta.flags & 2, 2, "the GSI's vbmeta disables verification");
    // (system.img whole: its CRC-32 and size checked as it inflates)
    const hash = create_hash("sha256");
    assert.equal(await zip_stream(read, system, bytes => { hash.update(bytes); }), system.size);
    if(fs.existsSync(A + "dl/gsi/unpacked/system.img")) assert.equal(hash.digest("hex"), sha256(fs.readFileSync(A + "dl/gsi/unpacked/system.img")));
});

await part("super's metadata written again", [A + "img/super.img"], async () =>
{
    const read = file_reader(A + "img/super.img");
    const lp = lp_metadata((offset, length) => sparse_read(read, offset, length));
    for(const copy of lp.copies) assert.ok(equals(lp_serialize(lp_parse(copy.bytes)), copy.bytes));
});

await part("the bootloader's work from disk.img", [OUT + "disk.img", OUT + "manifest.json", OUT + "initrd.img", A + "dl/vendor_ramdisk-debug.img"], async () =>
{
    const manifest = JSON.parse(fs.readFileSync(OUT + "manifest.json", "utf8"));
    const read = file_reader(OUT + "disk.img");
    const partitions = gpt_partitions(read, fs.statSync(OUT + "disk.img").size);
    assert.deepEqual(partitions.map(p => [p.name, p.start]), manifest.disk.partitions.map(p => [p.name, p.start]));
    const by_name = new Map(partitions.map(p => [p.name, p]));
    // (each partition as the bootloader reads it: whole, the slot's)
    const read_partition = name =>
    {
        const p = by_name.get(name + CF_ARM64_ONLY_PHONE.slot) || by_name.get(name);
        if(!p) throw new Error("no partition " + name);
        return read(p.start, p.size);
    };
    const options = { memory_mb: 1536, page_size: manifest.kernel.page_size, vendor_ramdisk: fs.readFileSync(A + "dl/vendor_ramdisk-debug.img") };
    assert.equal(manifest.vendor_ramdisk, "vendor_ramdisk-debug.img");
    if(manifest.kernel.page_size !== 4096) { console.log("  (16K: its ramdisk and kernel are not on the disk; the 4K bootloader only)"); return; }
    const m = android_boot(read_partition, CF_ARM64_ONLY_PHONE, options);
    assert.equal(m.cmdline, manifest.cmdline);
    assert.deepEqual(m.vbmeta, manifest.vbmeta);
    assert.deepEqual(Object.fromEntries(m.bootconfig), manifest.bootconfig);
    assert.equal(sha256(m.kernel), manifest.results.Image);
    assert.equal(sha256(m.initrd), manifest.results["initrd.img"]);
    if(manifest.results["initrd-venus.img"])
    {
        assert.equal(sha256(android_boot(read_partition, CF_ARM64_ONLY_PHONE, { ...options, gpu_mode: "venus" }).initrd), manifest.results["initrd-venus.img"]);
    }
});

// v64's bootloader (I2.2): a V86 with android in place of kernel, initrd
// and cmdline loads what the tool made (TEST_RELEASE_BUILD=1: build/libv86.mjs)
await part("v64's bootloader (V86 android option)", [OUT + "disk.img", OUT + "manifest.json", A + "dl/vendor_ramdisk-debug.img", ROOT + "build/v86-arm64.wasm"], async () =>
{
    const manifest = JSON.parse(fs.readFileSync(OUT + "manifest.json", "utf8"));
    if(manifest.kernel.page_size !== 4096) { console.log("  (16K: not on the disk)"); return; }
    const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
    for(const gpu_mode of manifest.results["initrd-venus.img"] ? ["swiftshader", "venus"] : ["swiftshader"])
    {
        const emulator = new V86({
            cpu_type: "arm64", cpu_cores: 1, memory_size: 1536 * 1048576, log_level: 0, autostart: false,
            wasm_path: ROOT + "build/v86-arm64.wasm", virtio_transport: "pci", graphics_adapter: "none",
            virtio_disks: [{ url: OUT + "disk.img", async: true, size: fs.statSync(OUT + "disk.img").size }],
            android: { gpu_mode, vendor_ramdisk: { url: A + "dl/vendor_ramdisk-debug.img" } },
        });
        await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
        const files = emulator.v86.cpu.boot_files;
        assert.equal(files.cmdline, manifest.cmdline);
        assert.equal(sha256(new Uint8Array(files.kernel)), manifest.results.Image);
        assert.equal(sha256(new Uint8Array(files.initrd)), manifest.results[gpu_mode === "venus" ? "initrd-venus.img" : "initrd.img"], gpu_mode);
        await emulator.destroy();
    }
});

// the importer (I3.1): the Cuttlefish zip as a disk, the same as the tool's
// --release --no-venus --shrink-super --userdata-mb 4096 disk.img
const SMALL = A + "out-official-small/";
await part("the importer's disk (tools/a64_android.mjs's out-official-small)", [CF_ZIP, SMALL + "disk.img"], async () =>
{
    const { cuttlefish_disk, write_disk, package_entries } = await import("../../src/android/assemble.js");
    const read = file_reader(CF_ZIP);
    const disk = await cuttlefish_disk(read, await package_entries(read, fs.statSync(CF_ZIP).size), { userdata_bytes: 4096 * 1048576 });
    const file = A + "i1-imported.img";
    fs.rmSync(file, { force: true });
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, disk.disk_size);
    await write_disk(read, disk, (offset, bytes) => { fs.writeSync(fd, bytes, 0, bytes.length, offset); });
    fs.closeSync(fd);
    assert.equal(fs.statSync(file).size, fs.statSync(SMALL + "disk.img").size);
    const a = file_reader(file), b = file_reader(SMALL + "disk.img");
    for(let at = 0; at < disk.disk_size; at += 16 << 20) assert.ok(equals(a(at, 16 << 20), b(at, 16 << 20)), "the disks differ in [" + at + ", +16 MiB)");
    fs.rmSync(file);
});

console.log(`${ran} parts ran`);
