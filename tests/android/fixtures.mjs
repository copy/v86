// Small synthetic Android images for src/android/'s tests
// (docs/android-images-plan.md I1, I3): sparse images, vbmeta structs, super
// with liblp metadata, erofs, zips, boot images, and a Cuttlefish-like images
// zip (tests/android/library.mjs; tests/android/make_package.mjs writes one
// for the wizard's browser test).

import { crc32 as zlib_crc32, deflateRawSync as deflate_raw_sync } from "node:zlib";
import { put16, put32, put64, put32be, put64be, bytes_of, concat, crc32c } from "../../src/android/bytes.js";
import { lp_checksum } from "../../src/android/lp.js";

const SECTOR = 512;
let seed = 12345;
/** random bytes, the same each run */
export const random = n => Uint8Array.from({ length: n }, () => (seed = seed * 1103515245 + 12345 >>> 0) >>> 24);
/** read(offset, length) over bytes */
export const reader = image => (offset, length) => image.subarray(offset, offset + length);

/** a sparse image of chunks [type, blocks, data] and the raw image it stands for */
export function make_sparse(chunks, block = 4096)
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

/** a vbmeta struct with descriptors (hashtree: { partition, size, salt },
 * chain: { partition }) and flags */
export function make_vbmeta(descriptors, flags = 0)
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
export function with_footer(data, struct)
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

/** super with liblp metadata (2 slots) for partitions [name, sectors at
 * sector] in group "g", alignment 1 MiB */
export function make_super(partitions, size)
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

/** a 4 KiB erofs image: the root (with xattrs) holding "hello" (flat
 * plain) and "tail" (flat inline) */
export function make_erofs()
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
    put32(image, sb + 4, crc32c(0xFFFFFFFF, image.subarray(sb, B)));
    return image;
}

/** a zip of members [{ name, data, store }], with zip64's fields when zip64 */
export function make_zip(members, zip64 = false, comment = "")
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

/** boot.img / init_boot.img (header version 4) */
export function make_boot(kernel, ramdisk, cmdline)
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
export function make_vendor_boot(ramdisks, cmdline, bootconfig)
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

/** A Cuttlefish-like images zip: fastboot-info.txt, boot images (an arm64
 * Image), four vbmeta, a sparse super of 16 MiB with system_a and vendor_a,
 * userdata; and its parts */
export function make_cuttlefish_package()
{
    const MiB = 2048;
    const super_raw = make_super([["system_a", MiB, MiB], ["vendor_a", MiB, 2 * MiB]], 16 << 20);
    super_raw.set(random(4096), MiB * SECTOR);
    super_raw.set(random(4096), 2 * MiB * SECTOR);
    const raw_blocks = 3 * MiB * SECTOR / 4096;
    const { sparse } = make_sparse([[0xCAC1, raw_blocks, super_raw.subarray(0, raw_blocks * 4096)], [0xCAC3, (16 << 20) / 4096 - raw_blocks, new Uint8Array(0)]]);
    const kernel = random(8192);
    kernel.set(bytes_of("ARMd"), 56);
    const images = {
        "boot.img": make_boot(kernel, new Uint8Array(0), ""), "init_boot.img": make_boot(new Uint8Array(0), random(50), ""),
        "vendor_boot.img": make_vendor_boot([["r", random(70)]], "", ""), "vbmeta.img": make_vbmeta([]),
        "vbmeta_system.img": make_vbmeta([]), "vbmeta_vendor_dlkm.img": make_vbmeta([]), "vbmeta_system_dlkm.img": make_vbmeta([]),
    };
    const members = [{ name: "fastboot-info.txt", data: bytes_of("# cuttlefish\nversion 1\n") }, { name: "android-info.txt", data: bytes_of("config=phone\n") },
        ...Object.entries(images).map(([name, data]) => ({ name, data })), { name: "super.img", data: sparse },
        { name: "userdata.img", data: make_sparse([[0xCAC3, 4, new Uint8Array(0)]]).sparse }];
    return { zip: make_zip(members), images, super_raw, MiB };
}
