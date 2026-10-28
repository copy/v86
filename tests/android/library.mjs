#!/usr/bin/env node
// src/android/'s image library (docs/android-images-plan.md I1) on small
// synthetic images: each format read back as written, against node's own
// CRC-32 and SHA-256. tools/a64_android.mjs's byte-identical outputs check
// the library on Cuttlefish's real images.

import assert from "node:assert/strict";
import { crc32 as zlib_crc32 } from "node:zlib";
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
import { random, reader, make_sparse, make_vbmeta, with_footer, make_super, make_erofs, make_zip, make_boot, make_vendor_boot,
    make_cuttlefish_package, make_gsi_package, make_emulator_package } from "./fixtures.mjs";
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
    assert.throws(() => device_bootconfig(device, { vbmeta, memory_mb: 1, gpu_mode: "virgl" }), /no GPU mode/);
    // gfxstream_guest_angle's keys, as Cuttlefish's launcher writes them, but
    // composed on the client (as Venus's) and OpenGL ES 3.0
    const gfxstream = device_bootconfig(device, { vbmeta, memory_mb: 2048, gpu_mode: "gfxstream" });
    assert.deepEqual(["cpuvulkan.version", "hardware.vulkan", "hardware.gltransport", "hardware.egl", "opengles.version", "hardware.hwcomposer",
        "hardware.hwcomposer.mode"].map(k => gfxstream.get("androidboot." + k)), ["0", "ranchu", "virtio-gpu-asg", "angle", "196608", "ranchu", "client"]);

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

await run("assemble a Cuttlefish package", async () =>
{
    const { identify_package, cuttlefish_disk, write_disk, package_entries, SUPER_SLACK } = await import("../../src/android/assemble.js");
    const { zip, images, super_raw, MiB } = make_cuttlefish_package();
    const read = reader(zip);
    const entries = await package_entries(read, zip.length);
    assert.deepEqual(await identify_package(entries, read), { kind: "cuttlefish", device: "cf_arm64_only_phone", text: "a Cuttlefish arm64 device (its images zip)" });
    assert.equal((await identify_package([{ name: "system.img" }, { name: "vbmeta.img" }, { name: "build.prop" }], read)).kind, "gsi");
    assert.equal(await identify_package([{ name: "readme.txt" }], read), null);
    const disk = await cuttlefish_disk(read, entries, { userdata_bytes: 3 << 20 });
    assert.equal(disk.super_size, Math.ceil((3 * MiB * SECTOR + SUPER_SLACK) / (1 << 20)) * (1 << 20));
    const out = new Uint8Array(disk.disk_size);
    const progress = [];
    await write_disk(read, disk, async (offset, bytes) => { out.set(bytes, offset); }, (done, total) => progress.push([done, total]));
    assert.deepEqual(progress.at(-1), [disk.data_bytes, disk.data_bytes]);
    const parts = new Map(gpt_partitions(reader(out), out.length).map(p => [p.name, p]));
    assert.deepEqual([...parts.keys()], device_partitions(CF_ARM64_ONLY_PHONE).map(p => p.name));
    for(const [name, data] of Object.entries(images))
    {
        // (the partition: the image, in whole sectors)
        const p = parts.get(name.replace(".img", "") + "_a");
        assert.equal(p.size, Math.ceil(data.length / SECTOR) * SECTOR, name);
        assert.ok(equals(out.subarray(p.start, p.start + data.length), data), name);
    }
    const sp = parts.get("super");
    assert.equal(sp.size, disk.super_size);
    const lp = lp_metadata(reader(out.subarray(sp.start, sp.start + sp.size)));
    assert.equal(lp.size, disk.super_size);
    assert.deepEqual(lp.copies[0].partitions.map(p => [p.name, p.extents[0].sector]), [["system_a", MiB], ["vendor_a", 2 * MiB]]);
    assert.ok(equals(out.subarray(sp.start + MiB * SECTOR, sp.start + 2 * MiB * SECTOR), super_raw.subarray(MiB * SECTOR, 2 * MiB * SECTOR)));
    assert.equal(parts.get("userdata").size, 3 << 20);
    assert.ok(out.subarray(parts.get("userdata").start, parts.get("userdata").start + (3 << 20)).every(b => b === 0));
});

await run("assemble a Cuttlefish package with a GSI", async () =>
{
    const { cuttlefish_disk, write_disk, package_entries, gsi_package, identify_package } = await import("../../src/android/assemble.js");
    const { zip, images, super_raw, MiB } = make_cuttlefish_package();
    const read = reader(zip);
    const entries = await package_entries(read, zip.length);
    for(const sparse of [false, true])
    {
        const g = make_gsi_package("36.1", sparse);
        const gread = reader(g.zip);
        const gentries = await package_entries(gread, g.zip.length);
        assert.equal((await identify_package(gentries, gread)).kind, "gsi");
        const gsi = await gsi_package(gread, gentries);
        assert.deepEqual([gsi.sdk_full, gsi.release, gsi.abilist32, gsi.size, gsi.sparse], ["36.1", "16", "armeabi-v7a", 1 << 20, sparse]);
        const disk = await cuttlefish_disk(read, entries, { userdata_bytes: 1 << 20, gsi, gsi_read: gread });
        assert.equal(disk.vendor_sdk_full, "36.1");
        const out = new Uint8Array(disk.disk_size);
        await write_disk(read, disk, (offset, bytes) => { out.set(bytes, offset); });
        const parts = new Map(gpt_partitions(reader(out), out.length).map(p => [p.name, p]));
        // (vbmeta: the GSI's; the other images the device's)
        const vb = parts.get("vbmeta_a");
        assert.ok(equals(out.subarray(vb.start, vb.start + 256), make_vbmeta([], 2)));
        assert.ok(equals(out.subarray(parts.get("boot_a").start, parts.get("boot_a").start + images["boot.img"].length), images["boot.img"]));
        const sp = parts.get("super");
        const lp = lp_metadata(reader(out.subarray(sp.start, sp.start + sp.size)));
        const system = lp.copies[0].partitions.find(p => p.name === "system_a").extents[0];
        assert.equal(system.sector, 3 * MiB);
        assert.equal(system.sectors, (1 << 20) / SECTOR);
        assert.ok(lp.copies.every(c => c.partitions.find(p => p.name === "system_a").extents[0].sector === 3 * MiB));
        assert.ok(equals(out.subarray(sp.start + system.sector * SECTOR, sp.start + system.sector * SECTOR + (1 << 20)), g.system), "the GSI's system");
        // (the old system_a's data not written; vendor_a's as it was)
        assert.ok(out.subarray(sp.start + MiB * SECTOR, sp.start + 2 * MiB * SECTOR).every(b => b === 0));
        assert.ok(equals(out.subarray(sp.start + 2 * MiB * SECTOR, sp.start + 3 * MiB * SECTOR), super_raw.subarray(2 * MiB * SECTOR, 3 * MiB * SECTOR)));
        assert.equal(lp.size, Math.ceil(((3 * MiB + 2048) * SECTOR + (64 << 20)) / (1 << 20)) * (1 << 20));
    }
    // a GSI older than the vendor: refused
    const old = make_gsi_package("36.0");
    const oread = reader(old.zip);
    const oentries = await package_entries(oread, old.zip.length);
    await assert.rejects(cuttlefish_disk(read, entries, { userdata_bytes: 1 << 20, gsi: await gsi_package(oread, oentries), gsi_read: oread }), /older than the device's vendor/);
});

await run("assemble an emulator image, its partitions as disks", async () =>
{
    const { emulator_disk, write_disk, package_entries, identify_package } = await import("../../src/android/assemble.js");
    const { android_bootloader } = await import("../../src/android/bootloader.js");
    const { PartitionBuffer } = await import("../../src/android/partition_buffer.js");
    for(const sparse of [false, true])
    {
        const e = make_emulator_package(25, "armeabi-v7a", sparse);
        const read = reader(e.zip);
        const entries = await package_entries(read, e.zip.length);
        const kind = await identify_package(entries, read);
        assert.equal(kind.kind, "emulator");
        const disk = await emulator_disk(read, entries);
        assert.equal(disk.device.id, "ranchu_25_armeabi_v7a");
        assert.deepEqual([disk.api, disk.abi, disk.tag, disk.release], [25, "armeabi-v7a", "google_apis", "7.1.1"]);
        assert.deepEqual(disk.partitions.map(p => p.name), ["kernel", "ramdisk", "system", "cache", "userdata"]);
        const out = new Uint8Array(disk.disk_size);
        await write_disk(read, disk, (offset, bytes) => { out.set(bytes, offset); });
        const parts = new Map(gpt_partitions(reader(out), out.length).map(p => [p.name, p]));
        const at = (name, length) => out.subarray(parts.get(name).start, parts.get(name).start + length);
        assert.ok(equals(at("system", 1 << 20), e.system), "system.img" + (sparse ? " (sparse)" : ""));
        assert.ok(equals(at("userdata", 1 << 19), e.userdata));
        // (an empty ext4 for cache: its superblock)
        assert.equal(u16(at("cache", 2048), 1080), 0xEF53);
        assert.equal(parts.get("cache").size, 64 << 20);
        // the bootloader: the kernel and ramdisk, the emulator's command line, the disks in fstab's order
        const boot = await android_bootloader(async (offset, length) => out.slice(offset, offset + length), out.length,
            { device: "ranchu_25_armeabi_v7a", memory_mb: 1024 });
        assert.ok(equals(boot.kernel.subarray(0, 5000), e.kernel) && boot.kernel.subarray(5000).every(b => b === 0));
        // (the image's ramdisk, then the device model's init additions: src/android/ramdisk_overlay.js)
        assert.ok(equals(boot.initrd.subarray(0, e.ramdisk.length), e.ramdisk));
        const added = cpio_files(boot.initrd.subarray(Math.ceil(e.ramdisk.length / 4) * 4));
        assert.deepEqual([...added.keys()], ["init.ranchu.rc"]);
        assert.match(latin1(added.get("init.ranchu.rc")),
            /^on boot\n {4}setprop ro.fixture 1\n\n# v64 .*\nservice v64_anr \/system\/bin\/sh \/system\/bin\/settings put secure anr_show_background 1\n[^]*on property:sys.boot_completed=1\n {4}start v64_anr\n/);
        assert.equal(boot.clock_rate, 0.1);
        assert.deepEqual(boot.properties, { "ro.config.low_ram": "true", "dalvik.vm.stack-trace-file": "" });
        assert.match(boot.cmdline, /^qemu=1 androidboot.hardware=ranchu console=ttyAMA0 .* qemu\.gles=0 .* android.bootanim=0$/);
        assert.equal(boot.ranchu_gpu, "guest", "no gpu_mode: the guest renders");
        assert.equal(boot.bootconfig, null);
        // the GPU mode "host" (docs/gles-proxy-plan.md): the GLES host, qemu.gles=1, the default GLES version's property
        // (3.1, docs/gles3-plan.md), or the one given
        const host = await android_bootloader(async (offset, length) => out.slice(offset, offset + length), out.length,
            { device: "ranchu_25_armeabi_v7a", gpu_mode: "host", memory_mb: 1024 });
        assert.equal(host.ranchu_gpu, "host");
        assert.match(host.cmdline, / qemu\.gles=1 /);
        assert.deepEqual(host.properties, { "ro.config.low_ram": "true", "dalvik.vm.stack-trace-file": "", "ro.opengles.version": "196609" });
        assert.equal(host.gles_version, "3.1");
        const host32 = await android_bootloader(async (offset, length) => out.slice(offset, offset + length), out.length,
            { device: "ranchu_25_armeabi_v7a", gpu_mode: "host", memory_mb: 1024, gles_version: "3.2" });
        assert.equal(host32.properties["ro.opengles.version"], "196610");
        // (the VM config's default, "swiftshader", is the guest's own rendering here too; Cuttlefish's modes are not ranchu's)
        assert.equal((await android_bootloader(async (offset, length) => out.slice(offset, offset + length), out.length,
            { device: "ranchu_25_armeabi_v7a", gpu_mode: "swiftshader", memory_mb: 1024 })).ranchu_gpu, "guest");
        await assert.rejects(android_bootloader(async (offset, length) => out.slice(offset, offset + length), out.length,
            { device: "ranchu_25_armeabi_v7a", gpu_mode: "venus", memory_mb: 1024 }), /no GPU mode venus \(guest, host\)/);
        assert.deepEqual(boot.disks.map(d => [d.name, d.start, d.size, d.readonly]),
            ["system", "cache", "userdata"].map(name => [name, parts.get(name).start, parts.get(name).size, name === "system"]));
        // a partition as a disk: reads and writes moved by its start; the disk's state once
        const backing = { get: (start, length, done) => done(out.slice(start, start + length)), set: (start, data, done) => { out.set(data, start); done(); },
            get_state: () => ["state"], set_state: () => {}, disk_name: "virtio_disk0" };
        const userdata = new PartitionBuffer(backing, boot.disks[2], true), cache = new PartitionBuffer(backing, boot.disks[1], false);
        assert.equal(userdata.byteLength, parts.get("userdata").size);
        assert.equal(userdata.disk_name, "virtio_disk0:userdata");
        const got = await new Promise(resolve => userdata.get(1080, 2, resolve));
        assert.deepEqual([...got], [0x53, 0xEF]);
        await new Promise(resolve => cache.set(0, new Uint8Array([1, 2, 3]), resolve));
        assert.deepEqual([...at("cache", 3)], [1, 2, 3]);
        assert.deepEqual(userdata.get_state(), [backing]);
        assert.deepEqual(cache.get_state(), []);
    }
    // an image v64 has no device model for: refused, saying which it boots
    const other = make_emulator_package(30, "x86_64");
    const oread = reader(other.zip);
    await assert.rejects(emulator_disk(oread, await package_entries(oread, other.zip.length)), /API 30 for x86_64: v64 boots API 25 armeabi-v7a/);
});
