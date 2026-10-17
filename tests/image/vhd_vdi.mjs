#!/usr/bin/env node
// VHD and VDI (docs/disk-image-formats-plan.md P3) against qemu-img: fixed
// and dynamic images read whole and in ranges as qemu-img reads them (the
// VHD's size from its CHS geometry or exact, as QEMU decides), large sparse
// ones beyond 4 GiB and across 2^32 sectors; damaged footers, headers and
// tables, each with what is wrong; differencing images refused.

import assert from "node:assert/strict";
import fs from "node:fs";
import { make_samples } from "./samples.mjs";
import { sample_file, read, open_sample, open_bytes, rejects, compare, check_against_reference, check_writes } from "./helpers.mjs";

process.on("unhandledRejection", exn => { throw exn; });

const manifest = make_samples();
let compared = 0;

// VHD
for(const name of ["dynamic.vhd", "dynamic-force.vhd", "fixed.vhd", "fixed-force.vhd"])
{
    compared += await check_against_reference(manifest, name, "vhd");
    const auto = await open_sample(name, "auto", "url");
    assert.equal(auto.format, "vhd", name + ": auto");
    assert.equal(auto.virtual_size, manifest.samples[name].size, name + ": the size qemu-img reports");
}
assert.equal((await open_sample("dynamic.vhd", "vpc", "url")).format, "vhd", "vpc: QEMU's name");
assert.notEqual((await open_sample("dynamic.vhd", "vhd", "url")).virtual_size, 64 << 20, "the CHS geometry (creator qemu)");
assert.equal((await open_sample("dynamic-force.vhd", "vhd", "url")).virtual_size, 64 << 20, "the current size (creator qem2)");
console.log("ok - VHD: dynamic and fixed, the size from the geometry or exact, as qemu-img reads them; auto, vpc");
await check_writes(manifest, "100g.vhd", "vhd");
console.log("ok - VHD: 100 GiB dynamic, beyond 4 GiB and at the end");

const be32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const set_be32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; };
const checksum = (b, start, length, at) =>
{
    let sum = 0;
    for(let i = start; i < start + length; i++) if(i < start + at || i >= start + at + 4) sum += b[i];
    set_be32(b, start + at, ~sum >>> 0);
};
{
    const dynamic = fs.readFileSync(sample_file("dynamic-force.vhd"));
    const header = Number(new DataView(dynamic.buffer, dynamic.byteOffset).getBigUint64(16));
    const patched = (patch, fix_footer = true, fix_header = true) =>
    {
        const b = new Uint8Array(dynamic);
        patch(b);
        if(fix_footer) checksum(b, 0, 512, 64);
        if(fix_header) checksum(b, header, 1024, 36);
        return b;
    };
    await rejects(open_bytes(patched(b => { b[100] ^= 1; }, false), "vhd"), /footer's checksum is wrong/, "corrupt");
    await rejects(open_bytes(patched(b => { b[header + 600] ^= 1; }, true, false), "vhd"), /dynamic disk header's checksum is wrong/, "corrupt");
    await rejects(open_bytes(patched(b => { b[header] = 0x41; }), "vhd"), /no dynamic disk header/, "corrupt");
    await rejects(open_bytes(patched(b => set_be32(b, 60, 4)), "vhd"), /differencing disks are not supported/, "unsupported");
    await rejects(open_bytes(patched(b => set_be32(b, 60, 5)), "vhd"), /disk type 5 is not supported/, "unsupported");
    await rejects(open_bytes(patched(b => set_be32(b, 12, 0x00020000)), "vhd"), /version 0x20000 is not supported/, "unsupported");
    await rejects(open_bytes(patched(b => set_be32(b, header + 32, 3 << 20)), "vhd"), /block size 3145728 is not a power of two/, "corrupt");
    await rejects(open_bytes(patched(b => set_be32(b, header + 28, 8)), "vhd"), /BAT .* is too small/, "corrupt");
    const bat = Number(new DataView(dynamic.buffer, dynamic.byteOffset).getBigUint64(header + 16));
    await rejects(open_bytes(dynamic.subarray(0, bat + 16), "vhd"), /the BAT .* past the end of the file/, "corrupt");
    // an unallocated block reads as zeros; a block past the end of the file too
    const unallocated = await open_bytes(patched(b => set_be32(b, bat, 0xFFFFFFFF)), "vhd");
    compare(await read(unallocated, 0, 65536), new Uint8Array(65536), "an unallocated block");
    console.log("ok - VHD: damaged footers, headers and BAT: refused with what is wrong; differencing disks refused");

    const fixed = fs.readFileSync(sample_file("fixed-force.vhd"));
    const short = new Uint8Array(fixed.length - 1024 * 1024);
    short.set(fixed.subarray(0, short.length - 512));
    short.set(fixed.subarray(fixed.length - 512), short.length - 512);
    await rejects(open_bytes(short, "vhd"), /does not fit before the footer/, "corrupt");
    await rejects(open_bytes(fixed.subarray(0, fixed.length - 1024), "vhd"), /not a vhd image/, "config");
    console.log("ok - VHD: a truncated fixed disk is refused");
}

// VDI
for(const name of ["dynamic.vdi", "static.vdi"])
{
    compared += await check_against_reference(manifest, name, "vdi");
    assert.equal((await open_sample(name, "auto", "url")).format, "vdi", name + ": auto");
}
const a = await open_sample("dynamic.vdi", "vdi", "url"), b = await open_sample("static.vdi", "vdi", "url");
assert.notEqual(a.identity()["metadata_sha256"], b.identity()["metadata_sha256"], "dynamic and fixed: other images");
console.log("ok - VDI: dynamic and fixed, as qemu-img reads them; auto");
await check_writes(manifest, "3t.vdi", "vdi");
const vdi_3t = await open_sample("3t.vdi", "vdi", "url");
const boundary = 2 ** 32 * 512;
const { expected_from_writes } = await import("./samples.mjs");
compare(await read(vdi_3t, boundary - 512, 1024), expected_from_writes(manifest.samples["3t.vdi"], boundary - 512, 1024), "across 2^32 sectors");
console.log("ok - VDI: 3 TiB dynamic, beyond 4 GiB and across 2^32 sectors");
{
    const dynamic = fs.readFileSync(sample_file("dynamic.vdi"));
    const le32 = (bytes, o, v) => new DataView(bytes.buffer, bytes.byteOffset).setUint32(o, v, true);
    const patched = patch => { const bytes = new Uint8Array(dynamic); patch(bytes); return bytes; };
    const bmap = new DataView(dynamic.buffer, dynamic.byteOffset).getUint32(0x154, true);
    await rejects(open_bytes(patched(x => le32(x, 0x40, 0)), "vdi"), /not a vdi image/, "config");
    await rejects(open_bytes(patched(x => le32(x, 0x40, 0)), "auto"), /could not be determined/, "config");
    await rejects(open_bytes(patched(x => le32(x, 0x44, 0x00010000)), "vdi"), /version 0x10000 is not supported/, "unsupported");
    await rejects(open_bytes(patched(x => le32(x, 0x4C, 4)), "vdi"), /image type 4 is not supported/, "unsupported");
    await rejects(open_bytes(patched(x => le32(x, 0x4C, 3)), "vdi"), /image type 3 is not supported/, "unsupported");
    await rejects(open_bytes(patched(x => le32(x, 0x178, 2 << 20)), "vdi"), /block size 2097152 is not supported/, "unsupported");
    await rejects(open_bytes(patched(x => le32(x, 0x17C, 512)), "vdi"), /extra block data/, "unsupported");
    await rejects(open_bytes(patched(x => { x[0x1B8] = 1; }), "vdi"), /differencing image/, "unsupported");
    await rejects(open_bytes(patched(x => le32(x, 0x180, 10)), "vdi"), /larger than its 10 blocks/, "corrupt");
    await rejects(open_bytes(patched(x => le32(x, 0x158, 0x1001)), "vdi"), /not aligned to a sector/, "corrupt");
    await rejects(open_bytes(dynamic.subarray(0, bmap + 8), "vdi"), /block map .* past the end of the file/, "corrupt");
    const beyond = await open_bytes(patched(x => le32(x, bmap, 1000)), "vdi");
    await rejects(read(beyond, 0, 512), /beyond the image's 64 blocks/, "corrupt");
    const discarded = await open_bytes(patched(x => { le32(x, bmap, 0xFFFFFFFE); le32(x, bmap + 4, 0xFFFFFFFF); }), "vdi");
    compare(await read(discarded, 0, 2 << 20), new Uint8Array(2 << 20), "discarded and unallocated blocks");
    console.log("ok - VDI: damaged headers and block maps: refused with what is wrong; differencing images refused");
}
console.log("VHD and VDI tests passed (" + (compared >> 20) + " MiB compared)");
