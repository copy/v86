#!/usr/bin/env node
// The QCOW2 reader (docs/disk-image-formats-plan.md P1, P2) against the RAW
// that qemu-img converts the same image to: every sample read whole and in
// random ranges, through a local file read in ranges (as a URL in Node) and
// from memory; the features that are refused; damaged images, each with an
// error that names what is wrong.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { make_samples, SAMPLES_DIR, random_generator, expected_from_writes, TB3, zstd_decompress } from "./samples.mjs";
import { open_image, detect_format } from "../../src/image/factory.js";

process.on("unhandledRejection", exn => { throw exn; });

const manifest = make_samples();
console.log("samples by " + manifest.tool + " in " + SAMPLES_DIR);
const file = name => path.join(SAMPLES_DIR, name);

function read(reader, offset, length)
{
    return new Promise((resolve, reject) => reader.read(offset, length, (data, error) => error ? reject(error) : resolve(data)));
}

const settings = { zstd_decompress };

/** open a sample as a local file read in ranges (async: true) or from memory */
async function open(name, how, extra = {})
{
    const descriptor = how === "memory" ?
        { buffer: new Uint8Array(fs.readFileSync(file(name))).buffer, format: "qcow2", ...extra } :
        { url: file(name), async: true, format: "qcow2", ...extra };
    return open_image("hda", descriptor, settings);
}

/** open bytes from memory (a damaged copy) */
function open_bytes(bytes, format = "qcow2")
{
    return open_image("hda", { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), format }, settings);
}

async function rejects(promise, pattern, kind)
{
    try
    {
        await promise;
    }
    catch(error)
    {
        assert.match(error.message, pattern);
        if(kind) assert.equal(error.kind, kind, error.message);
        return error;
    }
    assert.fail("expected an error matching " + pattern);
}

function compare(actual, expected, what)
{
    if(Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.length), expected) !== 0)
    {
        let i = 0;
        while(actual[i] === expected[i]) i++;
        assert.fail(what + ": differs at byte " + i + " (" + actual[i] + " instead of " + expected[i] + ")");
    }
}

let checked_bytes = 0;

async function check_against_reference(name, how)
{
    const sample = manifest.samples[name];
    const reference = fs.readFileSync(file(sample.reference));
    const reader = await open(name, how);
    assert.equal(reader.virtual_size, reference.length, name + ": the virtual size");
    assert.equal(reader.format, "qcow2");

    // whole, 1 MiB at a time
    const step = 1 << 20;
    for(let offset = 0; offset < reference.length; offset += step)
    {
        compare(await read(reader, offset, step), reference.subarray(offset, offset + step), name + " at " + offset);
        checked_bytes += step;
    }

    // random ranges: first and last sectors, across clusters
    const next = random_generator(name.length * 77 + (how === "memory" ? 1 : 2));
    const ranges = [[0, 512], [reference.length - 512, 512], [reference.length - 3 * 65536 - 512, 3 * 65536]];
    for(let i = 0; i < 300; i++)
    {
        const length = (1 + next() % 512) * 512;
        const offset = Math.floor(next() / 2 ** 32 * (reference.length - length) / 512) * 512;
        ranges.push([offset, length]);
    }
    for(const [offset, length] of ranges)
    {
        compare(await read(reader, offset, length), reference.subarray(offset, offset + length), name + " range " + offset + "+" + length);
    }
    if(how === "memory")
    {
        // from memory, a read completes before read() returns (as SyncBuffer)
        let done = false;
        reader.read(0, 4096, () => { done = true; });
        assert.ok(done, name + ": a read from memory is synchronous");
    }
    return reader;
}

for(const name of ["v3.qcow2", "v2.qcow2", "v3-512.qcow2", "v3-2m.qcow2", "v2-4k.qcow2", "v3-zlib.qcow2", "v3-zstd.qcow2", "v2-zlib.qcow2"])
{
    for(const how of ["url", "memory"])
    {
        await check_against_reference(name, how);
    }
    console.log("ok - " + name + ": the RAW of qemu-img, whole and in ranges (local file, memory)");
}

// written with qemu-io: zero clusters, a discard, partial clusters, an
// internal snapshot (the active disk is read); one compressed cluster
{
    const name = "io.qcow2";
    const reference = fs.readFileSync(file("io.raw"));
    const reader = await open(name, "url");
    assert.equal(reader.snapshots, 1, "the internal snapshot is there");
    for(let offset = 0; offset < reference.length; offset += 65536)
    {
        compare(await read(reader, offset, 65536), reference.subarray(offset, offset + 65536), name + " at " + offset);
    }
    const compressed = await new Promise(resolve => reader.map(16842752, 65536, resolve));
    assert.equal(compressed[0].type, 3, "the cluster qemu-io wrote compressed is a compressed cluster");
    for(const [offset, length] of [[0, 65536], [131072, 131072]])
    {
        const extents = await new Promise(resolve => reader.map(offset, length, resolve));
        assert.deepEqual(extents.map(e => [e.type, e.length]), [[1, length]], "zero clusters (allocated and unmapped) at " + offset);
    }
    console.log("ok - io.qcow2: zero clusters, discard, partial clusters, a compressed write, an internal snapshot");
}

// 3 TiB: offsets beyond 4 GiB and 2^32 sectors
{
    const sample = manifest.samples["3t.qcow2"];
    const reader = await open("3t.qcow2", "url");
    assert.equal(reader.virtual_size, TB3);
    for(const [offset, length] of sample.writes)
    {
        for(const [start, size] of [[offset - 4096, length + 8192], [offset + 512, 1024], [offset + length - 512, 512]])
        {
            const from = Math.max(0, start), to = Math.min(TB3, start + size);
            compare(await read(reader, from, to - from), Buffer.from(expected_from_writes(sample, from, to - from)),
                "3 TiB at " + from);
        }
    }
    // across the sector 2^32 boundary, 512 bytes each side
    const boundary = 2 ** 32 * 512;
    compare(await read(reader, boundary - 512, 1024), Buffer.from(expected_from_writes(sample, boundary - 512, 1024)), "at 2^32 sectors");
    compare(await read(reader, 1024 ** 4, 65536), Buffer.alloc(65536), "unallocated: zeros");
    console.log("ok - 3 TiB qcow2: reads beyond 4 GiB and across 2^32 sectors");
}

// parents (P2): given as backing; the child's zero clusters hide the
// parent's data; a parent smaller than the child (RAW)
for(const [name, backing] of [["child.qcow2", { url: file("parent.qcow2"), async: true }],
    ["child-raw.qcow2", { url: file("base.raw"), async: true }], ["child.qcow2", { url: file("parent.qcow2"), async: true, format: "qcow2" }],
    ["child-of-zlib.qcow2", { url: file("v3-zlib.qcow2"), async: true }], ["child-zlib.qcow2", { url: file("parent.qcow2") }]])
{
    const reference = fs.readFileSync(file(manifest.samples[name].reference));
    const reader = await open(name, "url", { backing });
    assert.equal(reader.virtual_size, reference.length);
    assert.equal(reader.parent.format, name === "child-raw.qcow2" ? "raw" : "qcow2");
    for(let offset = 0; offset < reference.length; offset += 1 << 20)
    {
        compare(await read(reader, offset, 1 << 20), reference.subarray(offset, offset + (1 << 20)), name + " at " + offset);
    }
}
{
    const base = fs.readFileSync(file("base.raw"));
    assert.ok(base.subarray(0, 512).some(b => b), "the parent has data where the child has zero clusters");
}
await rejects(open("child.qcow2", "url"), /continues in a parent image.*give it as backing/, "config");
await rejects(open("v3.qcow2", "url", { backing: { url: file("base.raw") } }), /backing is given, but the image has no parent/, "config");
await rejects(open("child.qcow2", "url", { backing: { url: file("base.raw"), format: "raw" } }),
    /names its parent's format qcow2, backing is given as raw/, "config");
await rejects(open("child.qcow2", "url", { backing: { url: file("v3.qcow2"), format: "vhd" } }), /names its parent's format qcow2/, "config");
const circular = { url: file("child.qcow2"), async: true, format: "qcow2" };
circular.backing = circular;
await rejects(open_image("hda", circular, settings), /circular/, "config");
const child_bytes = fs.readFileSync(file("child.qcow2"));
let deep = { buffer: new Uint8Array(fs.readFileSync(file("parent.qcow2"))).buffer, format: "qcow2" };
for(let i = 0; i < 17; i++) deep = { buffer: new Uint8Array(child_bytes).buffer, format: "qcow2", backing: deep };
await rejects(open_image("hda", deep, settings), /more than 16 parent images/, "config");
{
    const a = await open("child.qcow2", "url", { backing: { url: file("parent.qcow2") } });
    const b = await open("child.qcow2", "url", { backing: { url: file("v3.qcow2") } });
    const c = await open("child.qcow2", "url", { backing: { url: file("v3-512.qcow2") } });
    assert.deepEqual(a.identity(), b.identity(), "the same parent (the same bytes) under another name");
    assert.notDeepEqual(a.identity()["parent"], c.identity()["parent"], "another parent of the same data");
}
console.log("ok - parents: QCOW2 and RAW, compressed parents and children; explicit only; missing, unexpected, of another format, circular, too deep: refused");

// features that are refused
await rejects(open("extl2.qcow2", "url"), /extended L2/, "unsupported");
await rejects(open("data-file.qcow2", "url"), /external data file/, "unsupported");
await rejects(open("luks.qcow2", "url"), /encrypt/, "unsupported");
console.log("ok - refused: extended L2 entries, an external data file, encryption");

// damaged headers and tables (a copy of v3.qcow2 in memory)
const v3 = fs.readFileSync(file("v3.qcow2"));
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
const patched = (patch) =>
{
    const bytes = new Uint8Array(v3);
    patch(bytes, view(bytes));
    return bytes;
};
const v3_l1_offset = Number(view(v3).getBigUint64(40));
const first_l2 = Number(view(v3).getBigUint64(v3_l1_offset) & 0x00FFFFFFFFFFFE00n);
const reference = fs.readFileSync(file("base.raw"));
{
    await rejects(open_bytes(patched((b, v) => v.setUint32(0, 0x12345678))), /not a qcow2 image/, "config");
    await rejects(open_bytes(patched((b, v) => v.setUint32(0, 0x12345678)), "auto"), /could not be determined/, "config");
    await rejects(open_bytes(patched((b, v) => v.setUint32(4, 4))), /version 4/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setUint32(20, 8))), /cluster_bits 8/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setUint32(20, 22))), /cluster_bits 22/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(24, 64n * 1024n * 1024n + 100n))), /multiple of 512/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(24, 1n << 60n))), /too large/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setUint32(32, 1))), /encrypted/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(72, 1n << 5n))), /unknown incompatible features 0x20/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(72, 1n))), /dirty/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(72, 2n))), /corrupt/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setUint32(36, 0))), /L1 table has 0 entries/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(40, BigInt(v3_l1_offset + 512)))), /not aligned/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(v3_l1_offset, v.getBigUint64(v3_l1_offset) | 1n))), /reserved bits/, "corrupt");
    await rejects(open_bytes(v3.subarray(0, v3_l1_offset + 4)), /L1 table .* past the end of the file/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setUint32(100, 100))), /header_length 100/, "corrupt");
    console.log("ok - damaged headers: each refused with what is wrong");

    // unknown compatible and autoclear features, an unknown header
    // extension: read as before
    const compatible = await open_bytes(patched((b, v) =>
    {
        v.setBigUint64(80, v.getBigUint64(80) | 1n << 7n);
        v.setBigUint64(88, v.getBigUint64(88) | 1n << 9n);
        // an unknown extension in front of the others
        const header_length = v.getUint32(100);
        const rest = b.slice(header_length, 4000);
        v.setUint32(header_length, 0x12345678);
        v.setUint32(header_length + 4, 5);
        b.set([1, 2, 3, 4, 5, 0, 0, 0], header_length + 8);
        b.set(rest.subarray(0, 4000 - header_length - 16), header_length + 16);
    }));
    compare(await read(compatible, 0, 1 << 20), reference.subarray(0, 1 << 20), "with unknown compatible features");
    console.log("ok - unknown compatible/autoclear features and header extensions are ignored");

    // tables: an L2 table past the end of the file, an L2 entry with
    // reserved bits, a data cluster not aligned, the zero flag in version 2
    const truncated = await open_bytes(v3.subarray(0, first_l2));
    await rejects(read(truncated, 0, 512), /L2 table at \d+ is past the end of the file/, "corrupt");
    const entry = (bytes, index) => first_l2 + index * 8;
    const reserved = await open_bytes(patched((b, v) => v.setBigUint64(entry(b, 0), v.getBigUint64(entry(b, 0)) | 2n)));
    await rejects(read(reserved, 0, 512), /guest offset 0 .*reserved bits/, "corrupt");
    compare(await read(reserved, 65536, 65536), reference.subarray(65536, 131072), "the other clusters still read");
    const unaligned = await open_bytes(patched((b, v) => v.setBigUint64(entry(b, 0), v.getBigUint64(entry(b, 0)) + 512n)));
    await rejects(read(unaligned, 0, 512), /not aligned/, "corrupt");
    const v2 = fs.readFileSync(file("v2.qcow2"));
    const v2_l2 = Number(view(v2).getBigUint64(Number(view(v2).getBigUint64(40))) & 0x00FFFFFFFFFFFE00n);
    const v2_zero = new Uint8Array(v2);
    view(v2_zero).setBigUint64(v2_l2, view(v2_zero).getBigUint64(v2_l2) | 1n);
    await rejects(read(await open_bytes(v2_zero), 0, 512), /zero flag in a version 2 image/, "corrupt");
    // a data cluster past the end of the file reads as zeros (as QEMU)
    const past_end = (Math.ceil(v3.length / 65536) + 4) * 65536;
    const past = await open_bytes(patched((b, v) => v.setBigUint64(entry(b, 1), BigInt(past_end) | 1n << 63n)));
    compare(await read(past, 65536, 65536), Buffer.alloc(65536), "a cluster past the end of the file");
    console.log("ok - damaged tables: the read fails with what is wrong; past the end of the file: zeros");
}

// damaged compressed clusters: the stream cut short, past the end of the
// file, the copied flag
{
    const zlib_image = fs.readFileSync(file("v3-zlib.qcow2"));
    const zv = view(zlib_image);
    const l1 = Number(zv.getBigUint64(40));
    const l2 = Number(zv.getBigUint64(l1) & 0x00FFFFFFFFFFFE00n);
    // the first compressed cluster (bit 62) of more than one sector
    const x = 62n - (16n - 8n);
    const sectors_mask = ((1n << (62n - x)) - 1n) << x;
    let index = 0;
    while(!(zv.getBigUint64(l2 + index * 8) & 1n << 62n) || !(zv.getBigUint64(l2 + index * 8) & sectors_mask)) index++;
    const at = l2 + index * 8;
    const entry = zv.getBigUint64(at);
    const offset = entry & ((1n << x) - 1n);
    const patch = value => { const b = new Uint8Array(zlib_image); view(b).setBigUint64(at, value); return b; };
    const guest = index * 65536;
    await rejects(read(await open_bytes(patch(entry & ~sectors_mask)), guest, 512), /compressed cluster at \d+ is invalid: inflate|has \d+ bytes, not a cluster/, "corrupt");
    await rejects(read(await open_bytes(patch(1n << 62n | BigInt(zlib_image.length + 4096))), guest, 512), /past the end of the file/, "corrupt");
    await rejects(read(await open_bytes(patch(entry | 1n << 63n)), guest, 512), /compressed cluster with the copied flag/, "corrupt");
    void offset;
    console.log("ok - damaged compressed clusters: cut short, past the end of the file, the copied flag");
}

// through the emulator: zstd clusters decoded by the core's Zstandard
// decoder (src/browser/starter.js), a damaged one an error, not a crash
{
    const { V86 } = await import("../../src/main.js");
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), "../../");
    const zstd_image = new Uint8Array(fs.readFileSync(file("v3-zstd.qcow2")));
    const zv = view(zstd_image);
    const l2 = Number(zv.getBigUint64(Number(zv.getBigUint64(40))) & 0x00FFFFFFFFFFFE00n);
    // a compressed cluster of more than one sector, its frame's magic
    // damaged (damage inside the data is not seen: QEMU's frames have no
    // checksum)
    let index = 0;
    while(!(zv.getBigUint64(l2 + index * 8) & 1n << 62n) || !(zv.getBigUint64(l2 + index * 8) >> 54n & 0xFFn)) index++;
    const host = Number(zv.getBigUint64(l2 + index * 8) & ((1n << 54n) - 1n));
    zstd_image.fill(0x55, host, host + 4);
    const emulator = new V86({
        bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" }, graphics_adapter: "bochs_vga",
        hda: { buffer: zstd_image.buffer, format: "auto" }, autostart: false, memory_size: 32 << 20, log_level: 0,
    });
    await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
    const disk = emulator.v86.cpu.devices.ide.primary.master.buffer;
    const get = (offset, length) => new Promise((resolve, reject) => disk.get(offset, length, (data, error) => error ? reject(error) : resolve(data)));
    const base = fs.readFileSync(file("base.raw"));
    let compared = 0;
    for(let offset = 0; offset < base.length; offset += 1 << 20)
    {
        if(offset <= index * 65536 && index * 65536 < offset + (1 << 20)) continue;
        compare(await get(offset, 1 << 20), base.subarray(offset, offset + (1 << 20)), "zstd through the core at " + offset);
        compared++;
    }
    const errors = console.error, traces = console.trace;
    console.error = console.trace = () => {};
    await rejects(get(index * 65536, 512), /compressed cluster at \d+ is invalid|not a Zstandard frame/, "corrupt");
    console.error = errors;
    console.trace = traces;
    const after = (Math.floor(index * 65536 / (1 << 20)) + 1) * (1 << 20);
    compare(await get(after, 1 << 20), base.subarray(after, after + (1 << 20)), "the disk after the damaged cluster");
    emulator.destroy();
    console.log("ok - zstd clusters through the core's decoder (" + compared + " MiB); a damaged cluster: an I/O error");
}

// the format from the signature (auto) and the ones not read
{
    const head = n => new Uint8Array(n);
    const text = (bytes, offset, s) => { for(let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i); return bytes; };
    assert.equal(detect_format(new Uint8Array(v3.subarray(0, 4096)), new Uint8Array(512)), "qcow2");
    assert.equal(detect_format(text(head(4096), 0, "QFI\xfb\0\0\0\x01"), head(512)), "qcow");
    assert.equal(detect_format(text(head(4096), 0, "QED\0"), head(512)), "qed");
    assert.equal(detect_format(head(4096), text(head(512), 0, "conectix")), "vhd");
    assert.equal(detect_format(text(head(4096), 0, "conectix"), head(512)), "vhd");
    const vdi = head(4096);
    new DataView(vdi.buffer).setUint32(0x40, 0xBEDA107F, true);
    assert.equal(detect_format(vdi, head(512)), "vdi");
    assert.equal(detect_format(text(head(4096), 0, "KDMV"), head(512)), "vmdk");
    assert.equal(detect_format(text(head(4096), 0, "# Disk DescriptorFile\n"), head(512)), "vmdk");
    assert.equal(detect_format(text(head(4096), 0, "vhdxfile"), head(512)), "vhdx");
    assert.equal(detect_format(text(head(0x9000), 0x8001, "CD001"), head(512)), "iso");
    assert.equal(detect_format(head(4096), head(512)), "");
    const raw = new Uint8Array(4096 * 4);
    await rejects(open_bytes(raw, "auto"), /could not be determined/, "config");
    await rejects(open_bytes(text(head(65536), 0, "QED\0"), "auto"), /qed is not supported/, "unsupported");
    const auto = await open_bytes(new Uint8Array(v3), "auto");
    assert.equal(auto.format, "qcow2");
    console.log("ok - auto: the format from its signature; RAW and unknown ones need a format");
}

// identity: the same image twice, the same disk in another image
{
    const a = await open("v3.qcow2", "url"), b = await open("v3.qcow2", "memory"), c = await open("v2.qcow2", "url");
    assert.deepEqual(a.identity(), b.identity(), "the same image from a file and from memory");
    assert.notEqual(a.identity()["metadata_sha256"], c.identity()["metadata_sha256"], "another image of the same disk");
    console.log("ok - identity: the image's metadata, not where it is read from");
}

console.log("qcow2 tests passed (" + (checked_bytes >> 20) + " MiB compared)");
