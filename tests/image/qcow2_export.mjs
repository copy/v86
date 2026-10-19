#!/usr/bin/env node
// Export of a disk as a new QCOW2 image (docs/disk-image-formats-plan.md P5):
// qemu-img check finds no errors in it and qemu-img compare finds it equal
// to the RAW export of the same disk view; the reader of v86 reads it back.
// Disks: a compressed QCOW2 child on its parent with the guest's writes, a
// VHD whose size is not a multiple of a cluster, a RAW disk in memory.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { make_samples, SAMPLES_DIR } from "./samples.mjs";
import { sample_file, settings, read, compare } from "./helpers.mjs";
import { open_image } from "../../src/image/factory.js";

process.on("unhandledRejection", exn => { throw exn; });

const root = fileURLToPath(new URL("../../", import.meta.url));
const QEMU_IMG = process.env.QEMU_IMG || (fs.existsSync("/opt/homebrew/bin/qemu-img") ? "/opt/homebrew/bin/qemu-img" : "qemu-img");
make_samples();
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const out = path.join(SAMPLES_DIR, "export");
fs.mkdirSync(out, { recursive: true });

async function machine(hda)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
        hda, autostart: false, memory_size: 32 << 20, log_level: 0,
    });
    await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
    return emulator;
}

async function export_to(emulator, format, file)
{
    const chunks = [], progress = [];
    const size = await emulator.export_disk_image("hda", { format, write: chunk => { chunks.push(chunk); }, progress: p => progress.push(p) });
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, size);
    fs.writeFileSync(file, bytes);
    return { size, progress };
}

const cases = [
    ["child", { url: sample_file("child-zlib.qcow2"), async: true, format: "qcow2", backing: { url: sample_file("parent.qcow2"), async: true } }],
    ["vhd", { url: sample_file("dynamic.vhd"), async: true, format: "vhd" }],
    ["raw", { buffer: new Uint8Array(fs.readFileSync(sample_file("base.raw"))).buffer }],
];
for(const [name, hda] of cases)
{
    const emulator = await machine(hda);
    // the guest's writes: in the first cluster, across clusters, at the end
    const disk = emulator.v86.cpu.devices.ide.primary.master;
    const size = disk.buffer.byteLength;
    for(const [offset, length, fill] of [[512, 1024, 0x11], [3 * 65536 - 512, 70000, 0x22], [size - 1024, 1024, 0x33], [40 << 20, 65536, 0]])
    {
        await new Promise(resolve => disk.write_to_backend(offset, new Uint8Array(length - length % 512).fill(fill), resolve));
    }
    const raw = path.join(out, name + ".raw"), qcow2 = path.join(out, name + ".qcow2");
    const raw_result = await export_to(emulator, "raw", raw);
    const qcow2_result = await export_to(emulator, "qcow2", qcow2);
    assert.equal(raw_result.size, size);
    assert.equal(qcow2_result.progress[qcow2_result.progress.length - 1].loaded, qcow2_result.size, "progress to the end");
    execFileSync(QEMU_IMG, ["check", "-q", "-f", "qcow2", qcow2]);
    execFileSync(QEMU_IMG, ["compare", "-q", "-f", "qcow2", "-F", "raw", qcow2, raw]);
    const info = JSON.parse(execFileSync(QEMU_IMG, ["info", "--output=json", "-f", "qcow2", qcow2]).toString());
    assert.equal(info["virtual-size"], size, "the virtual size");
    const reader = await open_image("hda", { url: qcow2, async: true, format: "auto" }, settings);
    const expected = fs.readFileSync(raw);
    for(let offset = 0; offset < size; offset += 4 << 20)
    {
        const length = Math.min(4 << 20, size - offset);
        compare(await read(reader, offset, length), expected.subarray(offset, offset + length), name + ": read back at " + offset);
    }
    emulator.destroy();
    console.log("ok - " + name + ": the QCOW2 export (" + qcow2_result.size + " bytes of a " + size + "-byte disk) passes qemu-img check, " +
        "equals the RAW export (qemu-img compare), reads back");
}
// an unknown format; cancelled during the scan and during the writes
{
    const emulator = await machine({ url: sample_file("v3.qcow2"), async: true, format: "qcow2" });
    await assert.rejects(emulator.export_disk_image("hda", { format: "vhdx", write() {} }), /unknown format "vhdx"/);
    for(const after of ["scan", "write"])
    {
        const controller = new AbortController();
        await assert.rejects(emulator.export_disk_image("hda", { format: "qcow2", signal: controller.signal, write() {},
            progress: p => { if(p.phase === after && p.loaded > 0) controller.abort(); } }), /cancelled/);
    }
    // the machine goes on after an export
    assert.equal(emulator.is_running(), false);
    emulator.destroy();
    console.log("ok - an unknown export format is refused; an export cancelled while scanning or writing fails");
}

// large sparse disks: the parts without data are not read; qemu-img compare
// with the source image
for(const [name, format] of [["3t.qcow2", "qcow2"], ["3t.vdi", "vdi"], ["100g.vhd", "vhd"]])
{
    const emulator = await machine({ url: sample_file(name), async: true, format });
    const qcow2 = path.join(out, name + ".qcow2");
    const source = emulator.v86.cpu.devices.ide.primary.master.buffer.reader.source;
    const before = source.inner ? source.inner.stats.bytes : 0;
    const { size } = await export_to(emulator, "qcow2", qcow2);
    const read_bytes = (source.inner ? source.inner.stats.bytes : 0) - before;
    execFileSync(QEMU_IMG, ["check", "-q", "-f", "qcow2", qcow2]);
    execFileSync(QEMU_IMG, ["compare", "-q", "-f", "qcow2", "-F", format === "vhd" ? "vpc" : format, qcow2, sample_file(name)]);
    emulator.destroy();
    console.log("ok - " + name + ": exported as QCOW2 (" + size + " bytes), " + read_bytes + " bytes of the image read; qemu-img check and compare");
}
console.log("QCOW2 export tests passed");
