#!/usr/bin/env node
// VHDX (docs/disk-image-formats-plan.md P5) against qemu-img: dynamic and
// fixed images, block sizes of 1, 32 and 256 MiB, ZERO and NOT_PRESENT
// blocks, 3 TiB across 2^32 sectors; the headers (the current one: valid,
// the higher sequence number), region tables and metadata with their
// CRC-32C; 4096-byte logical sectors (more in tests/image/sector_size.mjs);
// refused: a log to replay, a parent, unknown required regions and metadata,
// block states of differencing disks.

import assert from "node:assert/strict";
import fs from "node:fs";
import { make_samples } from "./samples.mjs";
import { sample_file, read, open_sample, open_bytes, rejects, compare, check_against_reference, check_writes } from "./helpers.mjs";
import { crc32c } from "../../src/image/vhdx.js";

process.on("unhandledRejection", exn => { throw exn; });

const manifest = make_samples();
let compared = 0;
for(const name of ["dynamic.vhdx", "fixed.vhdx", "1m.vhdx", "256m.vhdx", "io.vhdx"])
{
    compared += await check_against_reference(manifest, name, "vhdx");
    const reader = await open_sample(name, "auto", "url");
    assert.equal(reader.format, "vhdx", name + ": auto");
    console.log("ok - " + name + " (blocks of " + (reader.block_size >> 20) + " MiB): as qemu-img reads it, whole and in ranges");
}
await check_writes(manifest, "3t.vhdx", "vhdx");
{
    const { expected_from_writes } = await import("./samples.mjs");
    const reader = await open_sample("3t.vhdx", "vhdx", "url");
    const boundary = 2 ** 32 * 512;
    compare(await read(reader, boundary - 512, 1024), expected_from_writes(manifest.samples["3t.vhdx"], boundary - 512, 1024), "across 2^32 sectors");
}
console.log("ok - VHDX: 3 TiB, beyond 4 GiB and across 2^32 sectors");

// CRC-32C: the check value of "123456789"
assert.equal(crc32c(new TextEncoder().encode("123456789")), 0xE3069283);

const image = fs.readFileSync(sample_file("dynamic.vhdx"));
const KiB = 1024;
const view = b => new DataView(b.buffer, b.byteOffset, b.length);
const fix_header = (b, offset) => view(b).setUint32(offset + 4, crc32c(b.subarray(offset, offset + 4 * KiB), 4), true);
const fix_regions = (b, offset) => view(b).setUint32(offset + 4, crc32c(b.subarray(offset, offset + 64 * KiB), 4), true);
const patched = patch => { const b = new Uint8Array(image); patch(b, view(b)); return b; };
const current_header = () =>
{
    const s1 = view(image).getBigUint64(64 * KiB + 8, true), s2 = view(image).getBigUint64(128 * KiB + 8, true);
    return s1 > s2 ? 64 * KiB : 128 * KiB;
};
const other_header = () => current_header() === 64 * KiB ? 128 * KiB : 64 * KiB;
{
    // headers: the valid one with the higher sequence number
    const broken_current = await open_bytes(patched(b => { b[current_header() + 100] ^= 1; }), "vhdx");
    compare(await read(broken_current, 0, 1 << 20), fs.readFileSync(sample_file("base.raw")).subarray(0, 1 << 20), "the other header");
    await rejects(open_bytes(patched(b => { b[64 * KiB + 100] ^= 1; b[128 * KiB + 100] ^= 1; }), "vhdx"), /neither header is valid/, "corrupt");
    // a log to replay
    await rejects(open_bytes(patched(b => { b[current_header() + 48] = 1; fix_header(b, current_header()); }), "vhdx"),
        /a log to replay/, "unsupported");
    await rejects(open_bytes(patched((b, v) => { v.setUint16(current_header() + 66, 2, true); fix_header(b, current_header()); }), "vhdx"),
        /version 2 is not supported/, "unsupported");
    // region tables
    await rejects(open_bytes(patched(b => { b[192 * KiB + 100] ^= 1; b[256 * KiB + 100] ^= 1; }), "vhdx"), /neither region table is valid/, "corrupt");
    const second_table = await open_bytes(patched(b => { b[192 * KiB + 100] ^= 1; }), "vhdx");
    assert.equal(second_table.virtual_size, 64 << 20, "the second region table");
    const regions = patched((b, v) =>
    {
        // a third region: unknown and required
        for(const at of [192 * KiB, 256 * KiB])
        {
            const count = v.getUint32(at + 8, true);
            const entry = at + 16 + count * 32;
            b.fill(0x77, entry, entry + 16);
            v.setBigUint64(entry + 16, 1n << 30n, true);
            v.setUint32(entry + 24, 1 << 20, true);
            v.setUint32(entry + 28, 1, true);
            v.setUint32(at + 8, count + 1, true);
            fix_regions(b, at);
        }
    });
    await rejects(open_bytes(regions, "vhdx"), /an unknown required region/, "unsupported");
    // metadata: the table follows the region table's metadata entry
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
            if(v.getUint32(entry, true) === guid_first) return { entry, data: metadata_offset + v.getUint32(entry + 16, true) };
        }
        throw new Error("no metadata item " + guid_first.toString(16));
    };
    const sectors_4k = await open_bytes(patched((b, v) => v.setUint32(item(b, 0x8141BF1D).data, 4096, true)), "vhdx");
    assert.equal(sectors_4k.logical_sector_size, 4096, "4096-byte logical sectors: the disk's");
    compare(await read(sectors_4k, 0, 1 << 20), fs.readFileSync(sample_file("base.raw")).subarray(0, 1 << 20), "4096-byte logical sectors");
    await rejects(open_bytes(patched((b, v) => v.setUint32(item(b, 0x8141BF1D).data, 1000, true)), "vhdx"), /sector sizes 1000\/\d+ are invalid/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setUint32(item(b, 0xCAA16737).data + 4, 2, true)), "vhdx"), /differencing disk/, "unsupported");
    await rejects(open_bytes(patched((b, v) => v.setUint32(item(b, 0xCAA16737).data, 3 << 20, true)), "vhdx"), /block size 3145728 is invalid/, "corrupt");
    await rejects(open_bytes(patched((b, v) => v.setBigUint64(item(b, 0x2FA54224).data, (64n << 20n) + 100n, true)), "vhdx"),
        /not a multiple of the sector size/, "corrupt");
    await rejects(open_bytes(patched((b, v) =>
    {
        const { entry } = item(b, 0x8141BF1D);
        v.setUint32(entry, 0x12345678, true);
        v.setUint32(entry + 24, v.getUint32(entry + 24, true) | 4, true);
    }), "vhdx"), /an unknown required metadata item|missing/, "");
    // the BAT: a state of differencing disks
    const bat_offset = (() =>
    {
        const v = view(image);
        for(let i = 0; i < v.getUint32(192 * KiB + 8, true); i++)
        {
            const entry = 192 * KiB + 16 + i * 32;
            if(v.getUint32(entry, true) === 0x2DC27766) return Number(v.getBigUint64(entry + 16, true));
        }
        throw new Error("no BAT");
    })();
    await rejects(open_bytes(patched(b => { b[bat_offset] = b[bat_offset] & ~7 | 7; }), "vhdx"), /state 7/, "corrupt");
    await rejects(open_bytes(patched(b => { b[bat_offset] = b[bat_offset] & ~7 | 4; }), "vhdx"), /state 4/, "corrupt");
    const not_present = await open_bytes(patched(b => { b[bat_offset] = b[bat_offset] & ~7; }), "vhdx");
    compare(await read(not_present, 0, 65536), new Uint8Array(65536), "a block not present");
    await rejects(open_bytes(image.subarray(0, bat_offset + 4), "vhdx"), /past the end of the file/, "corrupt");
    void other_header;
    console.log("ok - VHDX: headers (the current one, CRC-32C), region tables, metadata, BAT states: refused with what is wrong; " +
        "a log to replay and a parent refused, 4096-byte sectors read");
}
console.log("VHDX tests passed (" + (compared >> 20) + " MiB compared)");
