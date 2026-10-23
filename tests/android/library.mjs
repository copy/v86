#!/usr/bin/env node
// src/android/'s image library (docs/android-images-plan.md I1) on small
// synthetic images: each format read back as written, against node's own
// CRC-32 and SHA-256. tools/a64_android.mjs's byte-identical outputs check
// the library on Cuttlefish's real images.

import assert from "node:assert/strict";
import { crc32 as zlib_crc32, deflateRawSync as deflate_raw_sync } from "node:zlib";
import { createHash as create_hash } from "node:crypto";
import * as bytes from "../../src/android/bytes.js";
import { parse_boot_image, parse_vendor_boot_image } from "../../src/android/bootimg.js";
import { lz4_legacy_decompress, lz4_legacy_store } from "../../src/android/lz4.js";
import { cpio_files, cpio_newc } from "../../src/android/cpio.js";
import { parse_bootconfig, append_bootconfig } from "../../src/android/bootconfig.js";
import { is_sparse, sparse_size, unsparse, sparse_read, sparse_decoder } from "../../src/android/sparse.js";
import { vbmeta_struct, partition_vbmeta, vbmeta_digest, hashtree_descriptor, avb_hashtree, AVB_FLAG_VERIFICATION_DISABLED } from "../../src/android/avb.js";
import { lp_metadata, lp_checksum, lp_end, lp_parse, lp_serialize, lp_resize, lp_remove, lp_place, super_replace, super_footer_struct, super_partition } from "../../src/android/lp.js";
import { zip_entries, zip_stream, zip_read } from "../../src/android/zip.js";
import { erofs_root, erofs_data, erofs_entries, erofs_list, erofs_lookup, erofs_add_file, erofs_replace_files } from "../../src/android/erofs.js";
import { SECTOR, guid_bytes, guid_text, name_guid, gpt_layout, gpt_writes, gpt_partitions } from "../../src/android/gpt.js";
import { CF_ARM64_ONLY_PHONE, device_partitions, device_bootconfig } from "../../src/android/devices.js";
import { android_boot } from "../../src/android/boot.js";

const { u16, u32, u64, u32be, u64be, put16, put32, put64, put32be, put64be, latin1, bytes_of, concat, equals } = bytes;
const sha = (...parts) => { const h = create_hash("sha256"); for(const p of parts) h.update(p); return new Uint8Array(h.digest()); };
let seed = 12345;
const random = n => Uint8Array.from({ length: n }, () => (seed = seed * 1103515245 + 12345 >>> 0) >>> 24);
const reader = image => (offset, length) => image.subarray(offset, offset + length);
const run = async (name, f) => { await f(); console.log("ok " + name); };

await run("bytes", () =>
{
    const b = new Uint8Array(16);
    put64(b, 0, 2 ** 40 + 5); put64be(b, 8, 2 ** 45 + 7);
    assert.equal(u64(b, 0), 2 ** 40 + 5);
    assert.equal(u64be(b, 8), 2 ** 45 + 7);
    put32(b, 0, 0xFEDCBA98); put32be(b, 4, 0xFEDCBA98); put16(b, 8, 0xBEEF);
    assert.equal(u32(b, 0), 0xFEDCBA98);
    assert.equal(u32be(b, 4), 0xFEDCBA98);
    assert.equal(u16(b, 8), 0xBEEF);
    for(const n of [0, 1, 1000, 70000])
    {
        const data = random(n);
        assert.equal(bytes.crc32(data), zlib_crc32(data));
        assert.equal(bytes.crc32(data.subarray(n >> 1), bytes.crc32(data.subarray(0, n >> 1))), zlib_crc32(data));
        assert.deepEqual(bytes.sha256(data), sha(data));
        assert.equal(bytes.sha256_hex(data.subarray(0, n >> 1), data.subarray(n >> 1)), bytes.hex(sha(data)));
    }
    // CRC-32C's check value, with the inversion erofs leaves out
    assert.equal((bytes.crc32c(0xFFFFFFFF, bytes_of("123456789")) ^ 0xFFFFFFFF) >>> 0, 0xE3069283);
    const text = latin1(Uint8Array.from({ length: 100000 }, (_, i) => i & 0xFF));
    assert.equal(text.length, 100000);
    assert.equal(text.charCodeAt(99999), 99999 & 0xFF);
    assert.equal(bytes.c_string(bytes_of("abc\0def"), 0, 7), "abc");
    assert.equal(bytes.index_of(bytes_of("xxabcabd"), bytes_of("abd")), 5);
    assert.equal(bytes.index_of(bytes_of("xxabcab"), bytes_of("abd")), -1);
    assert.equal(bytes.compare(bytes_of("ab"), bytes_of("abc")), -1);
    assert.equal(bytes.compare(bytes_of("b"), bytes_of("abc")), 1);
    assert.deepEqual(bytes.utf16le("Az"), new Uint8Array([0x41, 0, 0x7A, 0]));
});

await run("lz4", () =>
{
    // a block with a match: "abc", then 9 bytes 3 back, then "x"
    const block = new Uint8Array([0x35, 0x61, 0x62, 0x63, 3, 0, 0x10, 0x78]);
    const frame = new Uint8Array(4 + 4 + block.length);
    put32(frame, 0, 0x184C2102);
    put32(frame, 4, block.length);
    frame.set(block, 8);
    assert.equal(latin1(lz4_legacy_decompress(frame)), "abcabcabcabcx");
    // (two frames one after another: the kernel's concatenated ramdisks)
    assert.equal(latin1(lz4_legacy_decompress(concat([frame, frame]))), "abcabcabcabcxabcabcabcabcx");
    for(const n of [0, 1, 14, 15, 16, 269, 270, 271, (8 << 20) + 3])
    {
        const data = random(n);
        assert.ok(equals(lz4_legacy_decompress(lz4_legacy_store(data)), data), "lz4 store " + n);
    }
});

await run("cpio", () =>
{
    const files = [["lib/modules/a.ko", random(5)], ["init", random(4096)], ["x", new Uint8Array(0)]];
    const back = cpio_files(cpio_newc(files));
    assert.deepEqual([...back.keys()], files.map(f => f[0]));
    for(const [name, data] of files) assert.ok(equals(back.get(name), data), name);
});

await run("bootconfig", () =>
{
    const map = parse_bootconfig("# comment\nandroidboot.a = 1\n androidboot.b=\"two words\"\n\nbad line\n");
    assert.deepEqual([...map], [["androidboot.a", "1"], ["androidboot.b", "two words"]]);
    for(const n of [0, 1, 2, 3])
    {
        const initrd = random(n);
        const out = append_bootconfig(initrd, map);
        assert.equal(out.length % 4, 0);
        assert.equal(latin1(out, out.length - 12), "#BOOTCONFIG\n");
        const size = u32(out, out.length - 20), checksum = u32(out, out.length - 16);
        const data = out.subarray(out.length - 20 - size, out.length - 20);
        assert.equal(data.reduce((s, x) => s + x, 0), checksum);
        assert.ok(equals(out.subarray(0, n), initrd));
        assert.equal(latin1(data).replace(/\0+$/, ""), "androidboot.a = \"1\"\nandroidboot.b = \"two words\"\n");
    }
});

/** a sparse image of chunks [type, blocks, data] and the raw image it stands for */
function make_sparse(chunks, block = 4096)
{
    const parts = [], raw = [];
    let total = 0;
    for(const [type, blocks, data] of chunks)
    {
        const header = new Uint8Array(12);
        put16(header, 0, type);
        put32(header, 4, blocks);
        put32(header, 8, 12 + data.length);
        parts.push(header, data);
        if(type === 0xCAC1) raw.push(data);
        else if(type === 0xCAC2) raw.push(Uint8Array.from({ length: blocks * block }, (_, i) => data[i % 4]));
        else if(type === 0xCAC3) raw.push(new Uint8Array(blocks * block));
        if(type !== 0xCAC4) total += blocks;
    }
    const header = new Uint8Array(28);
    put32(header, 0, 0xED26FF3A); put16(header, 4, 1); put16(header, 8, 28); put16(header, 10, 12);
    put32(header, 12, block); put32(header, 16, total); put32(header, 20, chunks.length);
    return { sparse: concat([header, ...parts]), raw: concat(raw) };
}

await run("sparse", () =>
{
    const { sparse, raw } = make_sparse([[0xCAC1, 2, random(8192)], [0xCAC2, 3, new Uint8Array([0x11, 0x22, 0x33, 0x44])],
        [0xCAC3, 2, new Uint8Array(0)], [0xCAC2, 1, new Uint8Array(4)], [0xCAC4, 0, random(4)], [0xCAC1, 1, random(4096)]]);
    const read = reader(sparse);
    assert.ok(is_sparse(read));
    assert.ok(!is_sparse(reader(raw)));
    assert.equal(sparse_size(read), raw.length);
    const out = new Uint8Array(raw.length).fill(0);
    const writes = [];
    assert.equal(unsparse(read, (at, data) => { writes.push([at, data.length]); out.set(data, at); }, 5000), raw.length);
    assert.ok(equals(out, raw));
    // (zero fills and "don't care" are not written; pieces of at most 5000 bytes)
    assert.ok(writes.every(([, n]) => n <= 5000));
    assert.equal(writes.reduce((s, [, n]) => s + n, 0), 3 * 4096 + 3 * 4096);
    for(const [offset, length] of [[0, 1], [4095, 2], [8000, 9000], [7 * 4096 - 3, 4096 + 6], [0, raw.length], [raw.length - 1, 1]])
    {
        assert.ok(equals(sparse_read(read, offset, length), raw.subarray(offset, offset + length)), `sparse_read ${offset} ${length}`);
    }
    // as a stream, in pieces of any size
    for(const piece of [1, 3, 7, 12, 4096, sparse.length])
    {
        const streamed = new Uint8Array(raw.length);
        const decoder = sparse_decoder((at, data) => streamed.set(data, at), 5000);
        for(let i = 0; i < sparse.length; i += piece)
        {
            decoder.push(sparse.subarray(i, i + piece));
            if(i >= 28) assert.equal(decoder.size(), raw.length);
        }
        assert.equal(decoder.end(), raw.length);
        assert.ok(equals(streamed, raw), "sparse_decoder " + piece);
    }
    const cut = sparse_decoder(() => {});
    cut.push(sparse.subarray(0, sparse.length - 1));
    assert.throws(() => cut.end(), /cut short/);
    assert.throws(() => sparse_decoder(() => {}).push(random(28)), /not a sparse image/);
    const after = sparse_decoder(() => {});
    assert.throws(() => after.push(concat([sparse, new Uint8Array(1)])), /after its last chunk/);
});

/** a vbmeta struct with descriptors (hashtree: { partition, size, salt },
 * chain: { partition }) and flags */
function make_vbmeta(descriptors, flags = 0)
{
    const parts = [];
    for(const d of descriptors)
    {
        let body;
        if(d.chain)
        {
            body = new Uint8Array(92 + Math.ceil(d.chain.length / 8) * 8);
            put64be(body, 0, 4);
            put32be(body, 20, d.chain.length);
            body.set(bytes_of(d.chain), 92);
        }
        else
        {
            const name = d.partition, salt = d.salt, length = 180 + name.length + salt.length + 32;
            body = new Uint8Array(Math.ceil(length / 8) * 8);
            put64be(body, 0, 1);
            put64be(body, 20, d.size);
            put32be(body, 44, 4096);
            put32be(body, 48, 4096);
            body.set(bytes_of("sha256"), 72);
            put32be(body, 104, name.length);
            put32be(body, 108, salt.length);
            put32be(body, 112, 32);
            body.set(bytes_of(name), 180);
            body.set(salt, 180 + name.length);
        }
        put64be(body, 8, body.length - 16);
        parts.push(body);
    }
    const aux = concat(parts);
    const header = new Uint8Array(256);
    header.set(bytes_of("AVB0"), 0);
    put64be(header, 20, aux.length);
    put64be(header, 96, 0);
    put64be(header, 104, aux.length);
    put32be(header, 120, flags);
    return concat([header, aux]);
}

/** an image with an AVB footer pointing at struct after its data */
function with_footer(data, struct)
{
    const out = new Uint8Array(data.length + struct.length + 64);
    out.set(data);
    out.set(struct, data.length);
    const f = out.length - 64;
    out.set(bytes_of("AVBf"), f);
    put64be(out, f + 12, data.length);
    put64be(out, f + 20, data.length);
    put64be(out, f + 28, struct.length);
    return out;
}

await run("avb", () =>
{
    const salt = random(32);
    const top = make_vbmeta([{ chain: "boot" }, { partition: "odm", size: 3 * 4096, salt }]);
    const parsed = vbmeta_struct(top);
    assert.deepEqual(parsed.descriptors, [{ tag: 4, partition: "boot" }, { tag: 1, partition: "odm" }]);
    const boot_struct = make_vbmeta([{ partition: "boot", size: 4096, salt }]);
    const boot = with_footer(random(5000), boot_struct);
    assert.ok(equals(partition_vbmeta(boot).struct, boot_struct));
    const partitions = { vbmeta: top, boot };
    const digest = vbmeta_digest(name => partitions[name]);
    assert.equal(digest.digest, bytes.hex(sha(top, boot_struct)));
    assert.equal(digest.size, top.length + boot_struct.length);
    assert.deepEqual(digest.chained, ["boot"]);
    // verification disabled: libavb loads vbmeta alone
    const off = make_vbmeta([{ chain: "boot" }], AVB_FLAG_VERIFICATION_DISABLED);
    assert.deepEqual(vbmeta_digest(name => ({ vbmeta: off })[name]), { digest: bytes.hex(sha(off)), size: off.length, chained: [] });
    const d = hashtree_descriptor(top, "odm");
    assert.equal(d.image_size, 3 * 4096);
    assert.equal(d.algorithm, "sha256");
    assert.ok(equals(d.salt, salt));
    assert.throws(() => hashtree_descriptor(top, "system"));
    // the tree: one block's image has none; three blocks' one level
    const one = random(4096);
    assert.deepEqual(avb_hashtree(one, salt), { root: sha(salt, one), tree: new Uint8Array(0) });
    const three = random(3 * 4096);
    const level = new Uint8Array(4096);
    for(let i = 0; i < 3; i++) level.set(sha(salt, three.subarray(i * 4096, (i + 1) * 4096)), 32 * i);
    const t = avb_hashtree(three, salt);
    assert.ok(equals(t.tree, level));
    assert.ok(equals(t.root, sha(salt, level)));
    // (a partial last block is hashed padded with zeros; 129 blocks need two levels)
    const big = random(129 * 4096 - 100);
    const t2 = avb_hashtree(big, salt);
    assert.equal(t2.tree.length, 3 * 4096);
});

/** super with liblp metadata (2 slots) for partitions [name, sectors at
 * sector] in group "g", alignment 1 MiB */
function make_super(partitions, size)
{
    const max = 65536, slots = 2;
    const header_size = 256;
    const table = (entries, entry_size) => ({ entries, entry_size });
    const p_table = table(partitions.map(([name], i) =>
    {
        const e = new Uint8Array(52);
        e.set(bytes_of(name));
        put32(e, 40, i); put32(e, 44, 1); put32(e, 48, 1);
        return e;
    }), 52);
    const x_table = table(partitions.map(([, sectors, sector]) =>
    {
        const e = new Uint8Array(24);
        put64(e, 0, sectors); put32(e, 8, 0); put64(e, 12, sector);
        return e;
    }), 24);
    const groups = table(["default", "g"].map(name => { const e = new Uint8Array(48); e.set(bytes_of(name)); return e; }), 48);
    const device = new Uint8Array(64);
    put64(device, 0, 2048); put32(device, 8, 1 << 20); put64(device, 16, size); device.set(bytes_of("super"), 24);
    const devices = table([device], 64);
    const tables = [p_table, x_table, groups, devices];
    const header = new Uint8Array(header_size);
    put32(header, 0, 0x414C5030); put16(header, 4, 10); put16(header, 6, 2); put32(header, 8, header_size);
    let offset = 0;
    tables.forEach((t, i) =>
    {
        put32(header, 80 + 12 * i, offset);
        put32(header, 84 + 12 * i, t.entries.length);
        put32(header, 88 + 12 * i, t.entry_size);
        offset += t.entries.length * t.entry_size;
    });
    put32(header, 44, offset);
    const metadata = concat([header, ...tables.flatMap(t => t.entries)]);
    lp_checksum(metadata);
    const image = new Uint8Array(size);
    const geometry = new Uint8Array(52);
    put32(geometry, 0, 0x616C4467); put32(geometry, 4, 52); put32(geometry, 40, max); put32(geometry, 44, slots); put32(geometry, 48, 4096);
    image.set(geometry, 4096);
    image.set(geometry, 8192);
    for(let i = 0; i < 2 * slots; i++) image.set(metadata, 4096 + 2 * 4096 + max * i);
    return image;
}

await run("lp", () =>
{
    const MiB = 2048;
    const image = make_super([["odm_a", 2 * MiB, 2 * MiB], ["system_a", 4 * MiB, 4 * MiB]], 16 << 20);
    const lp = lp_metadata(reader(image));
    assert.equal(lp.copies.length, 4);
    assert.equal(lp.alignment, 1 << 20);
    assert.equal(lp.size, 16 << 20);
    assert.deepEqual(lp.copies[0].partitions.map(p => [p.name, p.extents[0].sectors, p.extents[0].sector]), [["odm_a", 2 * MiB, 2 * MiB], ["system_a", 4 * MiB, 4 * MiB]]);
    assert.equal(lp_end(lp), 8 * MiB);
    // checksums as liblp's: sha256 of the tables, then of the header with its checksum zero
    const m = lp.copies[0].bytes;
    assert.ok(equals(m.subarray(48, 80), sha(m.subarray(256))));
    const h = new Uint8Array(m.subarray(0, 256));
    h.fill(0, 12, 44);
    assert.ok(equals(m.subarray(12, 44), sha(h)));
    // odm_a replaced: moved after system_a, its descriptor and checksums new
    const salt = random(8);
    const odm = random(3 * 4096);
    image.set(odm, 2 * MiB * SECTOR);
    const vbmeta = make_vbmeta([{ partition: "odm", size: odm.length, salt }]);
    assert.ok(equals(super_partition(reader(image), lp, vbmeta, "odm"), odm));
    const space = { sector: lp_end(lp) };
    const bigger = random(5 * 4096);
    const r = super_replace(lp, vbmeta, "odm", bigger, space);
    assert.deepEqual(r.record, { sector: 8 * MiB, sectors: MiB, image_blocks: 5, root_digest: bytes.hex(avb_hashtree(bigger, salt).root), footer: false });
    assert.equal(space.sector, 9 * MiB);
    assert.equal(r.data.offset, 8 * MiB * SECTOR);
    assert.ok(equals(r.data.bytes, concat([bigger, avb_hashtree(bigger, salt).tree])));
    const nd = hashtree_descriptor(r.vbmeta, "odm");
    assert.equal(nd.image_size, bigger.length);
    assert.ok(equals(r.vbmeta.subarray(nd.digest, nd.digest + 32), avb_hashtree(bigger, salt).root));
    assert.equal(hashtree_descriptor(vbmeta, "odm").image_size, odm.length, "the old vbmeta stays as it was");
    for(const copy of lp.copies) image.set(copy.bytes, copy.offset);
    const again = lp_metadata(reader(image));
    assert.deepEqual(again.copies.map(c => c.partitions[0].extents[0].sector), [8 * MiB, 8 * MiB, 8 * MiB, 8 * MiB]);
    assert.ok(equals(again.copies[3].bytes.subarray(48, 80), sha(again.copies[3].bytes.subarray(256))));
    // with an AVB footer: the struct after the tree, the footer at the extent's end
    const struct = make_vbmeta([{ partition: "odm", size: odm.length, salt }]);
    const f = super_replace(lp, r.vbmeta, "odm", bigger, space, struct);
    image.set(f.data.bytes, f.data.offset);
    for(const copy of lp.copies) image.set(copy.bytes, copy.offset);
    const own = super_footer_struct(reader(image), lp_metadata(reader(image)), "odm");
    assert.equal(hashtree_descriptor(own, "odm").image_size, bigger.length);
    assert.throws(() => super_replace(lp, r.vbmeta, "odm", random(9 << 20), space), /no room/);

    // the writer: tables as they were, then changed
    const fresh = make_super([["product_a", MiB, 2 * MiB], ["system_a", 2 * MiB, 3 * MiB], ["system_b", 0, 0]], 16 << 20);
    const lp2 = lp_metadata(reader(fresh));
    for(const copy of lp2.copies) assert.ok(equals(lp_serialize(lp_parse(copy.bytes)), copy.bytes));
    const model = lp_parse(lp2.copies[0].bytes);
    assert.deepEqual(model.partitions.map(p => [p.name, p.group, p.extents.length]), [["product_a", 1, 1], ["system_a", 1, 1], ["system_b", 1, 1]]);
    assert.deepEqual(model.groups.map(g => g.name), ["default", "g"]);
    assert.equal(model.block_devices[0].name, "super");
    const apply = writes => { for(const w of writes) fresh.set(w.bytes, w.offset); };
    apply(lp_remove(lp2, "product_a"));
    apply(lp_place(lp2, "system_a", 6 * MiB, 4 * MiB + 1));
    assert.throws(() => lp_place(lp2, "system_a", 6 * MiB + 1, 1), /unaligned/);
    assert.throws(() => lp_place(lp2, "vendor_a", 6 * MiB, 1), /no vendor_a/);
    assert.throws(() => lp_resize(lp2, 5 << 20), /leave out/);
    apply(lp_resize(lp2, (10 << 20) + 1));
    const lp3 = lp_metadata(reader(fresh));
    assert.equal(lp3.size, 11 << 20);
    assert.equal(lp_end(lp3), 10 * MiB + 1);
    for(const copy of lp3.copies)
    {
        assert.deepEqual(copy.partitions.map(p => [p.name, p.extents.map(e => [e.sectors, e.sector])]), [["system_a", [[4 * MiB + 1, 6 * MiB]]], ["system_b", [[0, 0]]]]);
        assert.ok(equals(copy.bytes.subarray(48, 80), sha(copy.bytes.subarray(256))));
    }
});

/** a 4 KiB erofs image: the root (with xattrs) holding "hello" (flat
 * plain) and "tail" (flat inline) */
function make_erofs()
{
    const B = 4096, image = new Uint8Array(4 * B);
    const sb = 1024;
    put32(image, sb, 0xE0F5E1E2); image[sb + 12] = 12; put16(image, sb + 14, 0);
    put64(image, sb + 16, 3); put32(image, sb + 36, 4); put32(image, sb + 40, 1);
    put32(image, sb + 8, 1);
    const inode = (nid, layout, mode, size, block, xattr_count) =>
    {
        const at = B + nid * 32;
        put16(image, at, layout << 1); put16(image, at + 2, xattr_count); put16(image, at + 4, mode);
        put16(image, at + 6, 1); put32(image, at + 8, size); put32(image, at + 16, block); put32(image, at + 20, nid + 1);
        return at;
    };
    const dir = new Uint8Array(B);
    const entries = [[0, 2, "."], [0, 2, ".."], [2, 1, "hello"], [4, 1, "tail"]];
    let name_at = entries.length * 12;
    entries.forEach(([nid, type, name], i) =>
    {
        put64(dir, i * 12, nid); put16(dir, i * 12 + 8, name_at); dir[i * 12 + 10] = type;
        dir.set(bytes_of(name), name_at);
        name_at += name.length;
    });
    image.set(dir, 2 * B);
    const root = inode(0, 0, 0o40755, name_at, 2, 1);
    put32(image, root + 32, 0x12345678);
    inode(2, 0, 0o100644, 5, 3, 0);
    image.set(bytes_of("world"), 3 * B);
    const tail = inode(4, 2, 0o100644, 3, 0, 0);
    image.set(bytes_of("end"), tail + 32);
    put32(image, sb + 4, bytes.crc32c(0xFFFFFFFF, image.subarray(sb, B)));
    return image;
}

await run("erofs", () =>
{
    const image = make_erofs();
    assert.deepEqual(erofs_list(image).map(e => [e.path, e.type]), [["hello", 1], ["tail", 1]]);
    assert.equal(latin1(erofs_data(image, erofs_lookup(image, "hello"))), "world");
    assert.equal(latin1(erofs_data(image, erofs_lookup(image, "tail"))), "end");
    assert.equal(erofs_lookup(image, "nothing"), null);
    const labels = { dir: "u:object_r:vendor_file:s0", file: "u:object_r:same_process_hal_file:s0" };
    const data = random(10000);
    const added = erofs_add_file(image, "lib64/hw/x.so", data, labels);
    assert.ok(equals(erofs_data(added, erofs_lookup(added, "lib64/hw/x.so")), data));
    assert.equal(latin1(erofs_data(added, erofs_lookup(added, "hello"))), "world");
    assert.deepEqual(erofs_list(added).map(e => e.path), ["hello", "lib64", "lib64/hw", "lib64/hw/x.so", "tail"]);
    const file = erofs_lookup(added, "lib64/hw/x.so");
    assert.ok(latin1(added, file.xattrs, file.xattrs + file.xattr_size).includes("selinux" + labels.file));
    assert.equal(u32(added, 1024 + 36) * 4096, added.length);
    assert.equal(u64(added, 1024 + 16), 6);
    const sum = new Uint8Array(added.subarray(1024, 4096));
    put32(sum, 4, 0);
    assert.equal(u32(added, 1024 + 4), bytes.crc32c(0xFFFFFFFF, sum));
    assert.ok(erofs_entries(added, erofs_root(added)).some(e => e.name === "lib64"));
    assert.throws(() => erofs_add_file(added, "lib64/y", data, labels), /exists/);
    const replaced = erofs_replace_files(added, [["hello", random(5000)], ["tail", bytes_of("new tail")], ["lib64/hw/x.so", bytes_of("so")]]);
    assert.equal(erofs_data(replaced, erofs_lookup(replaced, "hello")).length, 5000);
    assert.equal(latin1(erofs_data(replaced, erofs_lookup(replaced, "tail"))), "new tail");
    assert.equal(latin1(erofs_data(replaced, erofs_lookup(replaced, "lib64/hw/x.so"))), "so");
    assert.throws(() => erofs_replace_files(added, [["lib64", data]]), /not a regular file/);
});

await run("gpt", () =>
{
    const guid = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";
    assert.deepEqual([...guid_bytes(guid).subarray(0, 4)], [0xAF, 0x3D, 0xC6, 0x0F]);
    assert.equal(guid_text(guid_bytes(guid)), guid);
    assert.match(name_guid("super"), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/);
    const { partitions, disk_size } = gpt_layout([{ name: "misc", size: 4096 }, { name: "boot_a", size: (1 << 20) + 1 }, { name: "userdata", size: 3 << 20 }]);
    assert.deepEqual(partitions.map(p => [p.name, p.start, p.size]), [["misc", 1 << 20, 4096], ["boot_a", 2 << 20, (1 << 20) + 1], ["userdata", 4 << 20, 3 << 20]]);
    assert.equal(disk_size, 8 << 20);
    // (sizes as whole sectors on the disk)
    partitions[1].size = 2 << 20;
    const disk = new Uint8Array(disk_size);
    for(const w of gpt_writes(disk_size, partitions)) disk.set(w.bytes, w.offset);
    assert.equal(u16(disk, 510), 0xAA55);
    const back = gpt_partitions(reader(disk));
    assert.deepEqual(back.map(p => [p.name, p.start, p.size, p.type]), partitions.map(p => [p.name, p.start, p.size, guid]));
    assert.equal(back[0].guid, name_guid("misc"));
    // the primary header broken: the backup's
    disk[SECTOR + 20] ^= 1;
    assert.throws(() => gpt_partitions(reader(disk)), /no valid header/);
    assert.deepEqual(gpt_partitions(reader(disk), disk_size).map(p => p.name), ["misc", "boot_a", "userdata"]);
});

/** boot.img / init_boot.img (header version 4) */
function make_boot(kernel, ramdisk, cmdline)
{
    const page = 4096, align = n => Math.ceil(n / page) * page;
    const out = new Uint8Array(page + align(kernel.length) + align(ramdisk.length));
    out.set(bytes_of("ANDROID!"));
    put32(out, 8, kernel.length); put32(out, 12, ramdisk.length); put32(out, 16, 0x1234); put32(out, 20, 1584); put32(out, 40, 4);
    out.set(bytes_of(cmdline), 44);
    out.set(kernel, page);
    out.set(ramdisk, page + align(kernel.length));
    return out;
}

/** vendor_boot.img, header version 4, ramdisks [name, bytes] */
function make_vendor_boot(ramdisks, cmdline, bootconfig)
{
    const page = 2048, align = n => Math.ceil(n / page) * page;
    const ramdisk = concat(ramdisks.map(r => r[1]));
    const table = new Uint8Array(ramdisks.length * 108);
    let offset = 0;
    ramdisks.forEach(([name, data], i) =>
    {
        put32(table, i * 108, data.length); put32(table, i * 108 + 4, offset); put32(table, i * 108 + 8, i + 1);
        table.set(bytes_of(name), i * 108 + 12);
        offset += data.length;
    });
    const header = new Uint8Array(align(2128));
    header.set(bytes_of("VNDRBOOT")); put32(header, 8, 4); put32(header, 12, page); put32(header, 24, ramdisk.length);
    header.set(bytes_of(cmdline), 28);
    put32(header, 2096, 2128); put32(header, 2100, 0); put32(header, 2112, table.length); put32(header, 2116, ramdisks.length);
    put32(header, 2120, 108); put32(header, 2124, bootconfig.length);
    const pad = b => concat([b, new Uint8Array(align(b.length) - b.length)]);
    return concat([header, pad(ramdisk), pad(table), bytes_of(bootconfig)]);
}

await run("boot images", () =>
{
    const kernel = random(5000), ramdisk = random(300);
    const boot = parse_boot_image(make_boot(kernel, ramdisk, "a=b"));
    assert.equal(boot.version, 4);
    assert.ok(equals(boot.kernel, kernel));
    assert.ok(equals(boot.ramdisk, ramdisk));
    assert.equal(boot.cmdline, "a=b");
    assert.equal(boot.os_version, 0x1234);
    const r1 = random(3000), r2 = random(10);
    const vendor = parse_vendor_boot_image(make_vendor_boot([["first", r1], ["dlkm", r2]], "v=1", "androidboot.x=1\n"));
    assert.equal(vendor.cmdline, "v=1");
    assert.deepEqual(vendor.ramdisks.map(r => [r.type, r.name, r.bytes.length]), [[1, "first", 3000], [2, "dlkm", 10]]);
    assert.ok(equals(vendor.ramdisk, concat([r1, r2])));
    assert.equal(vendor.bootconfig, "androidboot.x=1\n");
    assert.throws(() => parse_boot_image(random(100)), /not a boot image/);
});

await run("device and bootloader", () =>
{
    const device = CF_ARM64_ONLY_PHONE;
    const names = device_partitions(device).map(p => p.name);
    assert.equal(names.length, 19);
    assert.deepEqual(names.slice(0, 3), ["misc", "boot_a", "boot_b"]);
    assert.deepEqual(names.slice(-4), ["super", "userdata", "metadata", "frp"]);
    const vbmeta = { size: 1, digest: "00" };
    const swiftshader = device_bootconfig(device, { vbmeta, memory_mb: 2048 });
    const venus = device_bootconfig(device, { vbmeta, memory_mb: 2048, gpu_mode: "venus", selinux: "permissive", page_size: 16384 });
    assert.equal(swiftshader.get("androidboot.hardware.vulkan"), "pastel");
    assert.equal(swiftshader.get("androidboot.ddr_size"), "2048MB");
    assert.equal(swiftshader.has("androidboot.selinux"), false);
    assert.equal(venus.get("androidboot.hardware.vulkan"), "virtio");
    assert.equal(venus.get("androidboot.selinux"), "permissive");
    assert.equal(venus.get("androidboot.fstab_suffix"), "cf.ext4.hctr2");
    // (Venus's new key last, the ones it changes where they were)
    assert.deepEqual([...venus.keys()].slice(-2), ["androidboot.opengles.version", "androidboot.hardware.hwcomposer.mode"]);
    assert.throws(() => device_bootconfig(device, { vbmeta, memory_mb: 1, gpu_mode: "gfxstream" }), /no GPU mode/);

    const kernel = random(8192), generic = random(100), vendor_ramdisk = random(200);
    const top = make_vbmeta([{ chain: "boot" }], AVB_FLAG_VERIFICATION_DISABLED);
    const partitions = { boot: make_boot(kernel, new Uint8Array(0), "b=2"), init_boot: make_boot(new Uint8Array(0), generic, ""),
        vendor_boot: make_vendor_boot([["r", vendor_ramdisk]], "v=1", "androidboot.vendor=yes\nandroidboot.hardware.vulkan=x\n"), vbmeta: top };
    const read = name => partitions[name];
    const m = android_boot(read, device, { memory_mb: 1536 });
    assert.ok(equals(m.kernel, kernel));
    assert.equal(m.cmdline, "v=1 b=2 " + device.cmdline_tail);
    assert.equal(m.vbmeta.digest, bytes.hex(sha(top)));
    assert.deepEqual([...m.bootconfig.keys()].slice(0, 3), ["androidboot.vendor", "androidboot.hardware.vulkan", "androidboot.slot_suffix"]);
    assert.equal(m.bootconfig.get("androidboot.hardware.vulkan"), "pastel");
    assert.ok(equals(m.initrd, append_bootconfig(concat([vendor_ramdisk, generic]), m.bootconfig)));
    const extra = random(7), debug = random(9);
    const m2 = android_boot(read, device, { memory_mb: 1536, vendor_ramdisk: debug, extra_ramdisk: extra, gpu_mode: "venus" });
    assert.ok(equals(m2.initrd.subarray(0, 9 + 7 + 100), concat([debug, extra, generic])));
    assert.equal(m2.bootconfig.get("androidboot.hardware.vulkan"), "virtio");
});

/** a zip of members [{ name, data, store }], with zip64's fields when zip64 */
function make_zip(members, zip64 = false, comment = "")
{
    const parts = [], central = [];
    let offset = 0;
    for(const { name, data, store } of members)
    {
        const compressed = store ? data : new Uint8Array(deflate_raw_sync(data));
        const crc = zlib_crc32(data), n = bytes_of(name), big = zip64 ? 0xFFFFFFFF : 0;
        const local = new Uint8Array(30 + n.length);
        put32(local, 0, 0x04034B50); put16(local, 4, 20); put16(local, 8, store ? 0 : 8); put32(local, 14, crc);
        put32(local, 18, big || compressed.length); put32(local, 22, big || data.length); put16(local, 26, n.length);
        local.set(n, 30);
        parts.push(local, compressed);
        const extra = new Uint8Array(zip64 ? 28 : 0);
        if(zip64) { put16(extra, 0, 1); put16(extra, 2, 24); put64(extra, 4, data.length); put64(extra, 12, compressed.length); put64(extra, 20, offset); }
        const c = new Uint8Array(46 + n.length + extra.length);
        put32(c, 0, 0x02014B50); put16(c, 4, 45); put16(c, 6, 45); put16(c, 10, store ? 0 : 8); put32(c, 16, crc);
        put32(c, 20, big || compressed.length); put32(c, 24, big || data.length);
        put16(c, 28, n.length); put16(c, 30, extra.length); put32(c, 42, big || offset);
        c.set(n, 46); c.set(extra, 46 + n.length);
        central.push(c);
        offset += local.length + compressed.length;
    }
    const cd = concat(central), tail = [];
    if(zip64)
    {
        const z = new Uint8Array(56);
        put32(z, 0, 0x06064B50); put64(z, 4, 44); put16(z, 12, 45); put16(z, 14, 45);
        put64(z, 24, members.length); put64(z, 32, members.length); put64(z, 40, cd.length); put64(z, 48, offset);
        const locator = new Uint8Array(20);
        put32(locator, 0, 0x07064B50); put64(locator, 8, offset + cd.length); put32(locator, 16, 1);
        tail.push(z, locator);
    }
    const e = new Uint8Array(22);
    put32(e, 0, 0x06054B50);
    put16(e, 8, zip64 ? 0xFFFF : members.length); put16(e, 10, zip64 ? 0xFFFF : members.length);
    put32(e, 12, zip64 ? 0xFFFFFFFF : cd.length); put32(e, 16, zip64 ? 0xFFFFFFFF : offset); put16(e, 20, comment.length);
    return concat([...parts, cd, ...tail, e, bytes_of(comment)]);
}

await run("zip", async () =>
{
    const pattern = Uint8Array.from({ length: 3 << 20 }, (_, i) => (i * 7) % 251);
    const members = [{ name: "boot.img", data: random(300000) }, { name: "stored.txt", data: bytes_of("hello"), store: true },
        { name: "pattern.img", data: pattern }, { name: "empty", data: new Uint8Array(0) }];
    for(const zip64 of [false, true])
    {
        const archive = make_zip(members, zip64, "a comment");
        const sync_read = reader(archive);
        // (reads as promises: a File's slices)
        const async_read = async (offset, length) => sync_read(offset, length);
        const entries = await zip_entries(async_read, archive.length);
        assert.deepEqual(entries.map(e => [e.name, e.method, e.size]), members.map(m => [m.name, m.store ? 0 : 8, m.data.length]));
        for(const [i, m] of members.entries())
        {
            assert.ok(equals(await zip_read(sync_read, entries[i]), m.data), m.name);
            const pieces = [];
            const n = await zip_stream(async_read, entries[i], async bytes => { pieces.push(bytes.slice()); }, { chunk: 1000 });
            assert.equal(n, m.data.length);
            assert.ok(equals(concat(pieces), m.data), m.name + " in pieces");
        }
        assert.ok(equals(await zip_read(sync_read, entries[2], 10), pattern.subarray(0, 10)));
    }
    const archive = make_zip(members);
    const entries = await zip_entries(reader(archive), archive.length);
    // a stored member's byte changed: its CRC-32
    const broken = new Uint8Array(archive);
    broken[entries[1].offset + 30 + "stored.txt".length] ^= 1;
    await assert.rejects(zip_read(reader(broken), entries[1]), /CRC-32 differs/);
    // a deflated member broken, a read failing, the sink failing: errors, not hangs
    const garbage = new Uint8Array(archive);
    garbage.fill(0xFF, entries[0].offset + 40, entries[0].offset + 40 + 64);
    await assert.rejects(zip_read(reader(garbage), entries[0]));
    let reads = 0;
    const failing = async (offset, length) => { if(++reads > 3) throw new Error("read failed"); return archive.subarray(offset, offset + length); };
    await assert.rejects(zip_stream(failing, entries[2], () => {}, { chunk: 4096 }), /read failed/);
    await assert.rejects(zip_stream(reader(archive), entries[2], () => { throw new Error("sink failed"); }, { chunk: 4096 }), /sink failed/);
    await assert.rejects(zip_entries(reader(random(1000)), 1000), /no end of central directory/);
    // a sparse member straight into the decoder
    const { sparse, raw } = make_sparse([[0xCAC1, 3, random(3 * 4096)], [0xCAC3, 5, new Uint8Array(0)], [0xCAC2, 2, new Uint8Array([1, 2, 3, 4])]]);
    const z = make_zip([{ name: "super.img", data: sparse }]);
    const [member] = await zip_entries(reader(z), z.length);
    const out = new Uint8Array(raw.length);
    const decoder = sparse_decoder((at, data) => out.set(data, at));
    await zip_stream(reader(z), member, bytes => decoder.push(bytes), { chunk: 777 });
    assert.equal(decoder.end(), raw.length);
    assert.ok(equals(out, raw));
});
