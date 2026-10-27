#!/usr/bin/env node
// The iOS firmware tools on samples the test makes itself, with made-up
// keys (docs/iphone4-plan.md "测试": no Apple files): AES, SHA-1, HMAC,
// IMG3, LZSS, the root filesystem's chunk encryption, UDIF, HFS+/HFSX
// (B-tree descent, extents overflow, hard links, decmpfs), Apple's device
// tree, Mach-O, XML plists.

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { AES, SHA1, HMAC_SHA1, from_hex, to_hex } from "../../src/ios/crypto.js";
import { img3_build, img3_payload, img3_parse } from "../../src/ios/img3.js";
import { lzss_decompress, complzss_decompress, adler32 } from "../../src/ios/lzss.js";
import { VFDecrypt, vfdecrypt_stream, encrcdsa_header } from "../../src/ios/vfdecrypt.js";
import { udif_trailer, udif_partitions, udif_partition_stream, CHUNK } from "../../src/ios/udif.js";
import { plist_parse } from "../../src/ios/plist.js";
import { HFSPlus } from "../../src/ios/hfsplus.js";
import { keys_parse, check_payload } from "../../src/ios/ipsw.js";
import { dt_parse, dt_serialize, dt_find, dt_property, dt_strings, dt_cells, dt_set } from "../../src/apple/devicetree.js";
import { macho_parse, macho_symbols, macho_offset } from "../../src/apple/macho.js";

let seed = 12345;
const random_bytes = n => Uint8Array.from({ length: n }, () => (seed = seed * 1103515245 + 12345 >>> 0) >>> 24);
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
const be32 = (b, at, v) => { b[at] = v >>> 24; b[at + 1] = v >>> 16; b[at + 2] = v >>> 8; b[at + 3] = v; };
const be16 = (b, at, v) => { b[at] = v >>> 8; b[at + 1] = v; };
const be64 = (b, at, v) => { be32(b, at, Math.floor(v / 0x100000000)); be32(b, at + 4, v >>> 0); };
const tests = [];
const test = (name, f) => tests.push([name, f]);

test("AES: FIPS 197 appendix C, CBC both ways", () =>
{
    const pt = "00112233445566778899aabbccddeeff";
    for(const [key, ct] of [["000102030405060708090a0b0c0d0e0f", "69c4e0d86a7b0430d8cdb78070b4c55a"],
        ["000102030405060708090a0b0c0d0e0f1011121314151617", "dda97ca4864cdfe06eaf70a0ec0d7191"],
        ["000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "8ea2b7ca516745bfeafc49904b496089"]])
    {
        const aes = new AES(from_hex(key)), b = from_hex(pt);
        aes.block(b, 0, false);
        assert.equal(to_hex(b), ct);
        aes.block(b, 0, true);
        assert.equal(to_hex(b), pt);
    }
    const aes = new AES(random_bytes(32)), iv = random_bytes(16), data = random_bytes(4096);
    const c = new Uint8Array(data);
    const next = aes.cbc(c, iv, false);
    assert.deepEqual(next, c.subarray(c.length - 16));
    aes.cbc(c, iv, true);
    assert.deepEqual(c, data);
    assert.throws(() => aes.cbc(new Uint8Array(15), iv, true), /whole blocks/);
});

test("SHA-1 and HMAC-SHA1: FIPS 180 and RFC 2202 vectors", () =>
{
    assert.equal(new SHA1().update(ascii("abc")).hex(), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert.equal(new SHA1().update(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).hex(),
        "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
    const million = new SHA1();
    for(let i = 0; i < 1000; i++) million.update(new Uint8Array(1000).fill(0x61));
    assert.equal(million.hex(), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    assert.equal(to_hex(new HMAC_SHA1(new Uint8Array(20).fill(0x0b)).mac(ascii("Hi There"))), "b617318655057264e28bc0b6fb378c8ef146be00");
    assert.equal(to_hex(new HMAC_SHA1(new Uint8Array(80).fill(0xaa)).mac(ascii("Test Using Larger Than Block-Size Key - Hash Key First"))),
        "aa4ae5e15272d00e95705637ce8a3b55ed402112");
    const h = new HMAC_SHA1(ascii("key"));
    assert.equal(to_hex(h.mac(ascii("The quick brown fox jumps over the lazy dog"))), "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
    assert.equal(to_hex(h.mac(ascii("The quick brown fox jumps over the lazy dog"))), "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
});

test("IMG3: encrypted DATA padded past its length, KBAG's key size, unencrypted images", () =>
{
    const key = random_bytes(32), iv = random_bytes(16), payload = random_bytes(1000);
    const room = new Uint8Array(1008);
    room.set(payload);
    new AES(key).cbc(room, iv, false);
    const kbag = new Uint8Array(8 + 16 + 32);
    new DataView(kbag.buffer).setUint32(0, 1, true);
    new DataView(kbag.buffer).setUint32(4, 256, true);
    const file = img3_build("krnl", [{ magic: "TYPE", data: ascii("lnrk") }, { magic: "DATA", data: payload, room },
        { magic: "KBAG", data: kbag }]);
    const image = img3_parse(file);
    assert.equal(image.type, "krnl");
    assert.deepEqual(image.tags.map(t => t.magic), ["TYPE", "DATA", "KBAG"]);
    const out = img3_payload(file, { iv: to_hex(iv), key: to_hex(key) });
    assert.equal(out.encrypted, true);
    assert.deepEqual(out.data, payload);
    assert.throws(() => img3_payload(file, { iv: to_hex(iv), key: to_hex(key.subarray(0, 16)) }), /AES-256/);
    assert.throws(() => img3_payload(file), /no key/);
    const plain = img3_build("logo", [{ magic: "DATA", data: ascii("iBootIm\0rest") }]);
    assert.deepEqual(img3_payload(plain).data, ascii("iBootIm\0rest"));
    assert.equal(check_payload("logo", img3_payload(plain).data), "iBootIm image");
    assert.throws(() => img3_parse(ascii("not an image at all")), /Img3/);
});

/** A greedy LZSS encoder in lzss.c's format (the decoder's other half, for the test) */
function lzss_compress(src)
{
    const N = 4096, F = 18, ring = new Uint8Array(N).fill(0x20, 0, N - F);
    const out = [];
    let r = N - F, i = 0;
    while(i < src.length)
    {
        const flag_at = out.length;
        out.push(0);
        for(let bit = 0; bit < 8 && i < src.length; bit++)
        {
            let best = 0, best_pos = 0;
            for(let p = 0; p < N && best < F; p++)
            {
                let n = 0;
                // (a match may run into the bytes it writes, as the decoder copies through the ring)
                while(n < F && i + n < src.length && (p + n - r & N - 1) !== 0 && ring[p + n & N - 1] === src[i + n]) n++;
                if(n > best) { best = n; best_pos = p; }
            }
            if(best >= 3)
            {
                out.push(best_pos & 0xFF, (best_pos >> 4 & 0xF0) | best - 3);
                for(let k = 0; k < best; k++) { ring[r] = src[i++]; r = r + 1 & N - 1; }
            }
            else
            {
                out[flag_at] |= 1 << bit;
                out.push(src[i]);
                ring[r] = src[i++];
                r = r + 1 & N - 1;
            }
        }
    }
    return Uint8Array.from(out);
}

test("LZSS: complzss header, the ring's spaces, matches, Adler-32", () =>
{
    const text = ascii("    leading spaces come from the ring; " + "abcabcabcabc".repeat(20) + " the end");
    const data = new Uint8Array(text.length + 300);
    data.set(text);
    data.set(random_bytes(300), text.length);
    const packed = lzss_compress(data);
    assert.ok(packed.length < data.length);
    assert.deepEqual(lzss_decompress(packed, data.length), data);
    const file = new Uint8Array(0x180 + packed.length);
    file.set(ascii("complzss"));
    be32(file, 8, adler32(data));
    be32(file, 12, data.length);
    be32(file, 16, packed.length);
    file.set(packed, 0x180);
    assert.deepEqual(complzss_decompress(file), data);
    assert.equal(adler32(ascii("Wikipedia")), 0x11E60398);
    file[0x180 + 5] ^= 1;
    assert.throws(() => complzss_decompress(file), /Adler-32|bytes decompressed/);
});

/** An encrcdsa v2 file of plain, chunks of 512 bytes, at offset 0x200 */
function encrcdsa(plain, key)
{
    const block = 512, offset = 0x200, chunks = Math.ceil(plain.length / block);
    const file = new Uint8Array(offset + chunks * block);
    file.set(ascii("encrcdsa"));
    be32(file, 8, 2);
    be32(file, 52, block);
    be64(file, 56, plain.length);
    be64(file, 64, offset);
    const cipher = new VFDecrypt(key, block);
    for(let n = 0; n < chunks; n++)
    {
        const chunk = new Uint8Array(block);
        chunk.set(plain.subarray(n * block, (n + 1) * block));
        cipher.encrypt(chunk, n);
        file.set(chunk, offset + n * block);
    }
    return file;
}

test("root filesystem: encrcdsa chunks with HMAC-SHA1 IVs, streamed in odd pieces", async () =>
{
    const key = to_hex(random_bytes(36)), plain = random_bytes(512 * 5 + 100);
    const file = encrcdsa(plain, key);
    assert.deepEqual(encrcdsa_header(file), { block_size: 512, data_size: plain.length, data_offset: 0x200 });
    const parts = [];
    const stream = vfdecrypt_stream(key, (bytes, offset) => { parts.push([offset, bytes]); });
    for(let at = 0; at < file.length; at += 77) await stream.write(file.subarray(at, at + 77));
    await stream.end();
    const out = new Uint8Array(plain.length);
    for(const [offset, bytes] of parts) out.set(bytes, offset);
    assert.deepEqual(out, plain);
    // (only the chunks wanted are decrypted)
    const wanted = [];
    const some = vfdecrypt_stream(key, (bytes, offset) => { wanted.push(offset); }, { want: offset => offset >= 2048 });
    await some.write(file);
    await some.end();
    assert.deepEqual(wanted, [2048, 2560]);
    const short = vfdecrypt_stream(key, () => {});
    await short.write(file.subarray(0, file.length - 512));
    await assert.rejects(short.end(), /cut short/);
    assert.throws(() => new VFDecrypt(key.slice(0, 64), 512), /36/);
});

/** A UDIF image of one partition: a raw chunk, a zero chunk, a zlib chunk */
function udif(partition)
{
    const raw = partition.subarray(0, 1024), zeros = partition.subarray(1024, 2048), packed = zlib.deflateSync(partition.subarray(2048));
    assert.ok(zeros.every(x => !x));
    const data = new Uint8Array(raw.length + packed.length);
    data.set(raw);
    data.set(packed, raw.length);
    const chunk_list = [[CHUNK.RAW, 0, 2, 0, raw.length], [CHUNK.ZERO, 2, 2, raw.length, 0],
        [CHUNK.ZLIB, 4, (partition.length - 2048) / 512, raw.length, packed.length], [CHUNK.END, partition.length / 512, 0, 0, 0]];
    const mish = new Uint8Array(0xCC + 40 * chunk_list.length);
    mish.set(ascii("mish"));
    be32(mish, 4, 1);
    be64(mish, 0x10, partition.length / 512);
    be32(mish, 0xC8, chunk_list.length);
    chunk_list.forEach(([type, sector, sectors, offset, length], i) =>
    {
        const at = 0xCC + 40 * i;
        be32(mish, at, type);
        be64(mish, at + 8, sector);
        be64(mish, at + 16, sectors);
        be64(mish, at + 24, offset);
        be64(mish, at + 32, length);
    });
    const xml = ascii(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>resource-fork</key><dict><key>blkx</key><array><dict>
<key>Attributes</key><string>0x0050</string><key>Data</key><data>
${Buffer.from(mish).toString("base64").replace(/.{1,52}/g, "\t$&\n")}</data><key>ID</key><string>3</string>
<key>Name</key><string>disk image (Apple_HFSX : 3)</string></dict></array></dict></dict></plist>`);
    const koly = new Uint8Array(512);
    koly.set(ascii("koly"));
    be64(koly, 0x20, data.length);
    be64(koly, 0xD8, data.length);
    be64(koly, 0xE0, xml.length);
    be64(koly, 0x1EC, partition.length / 512);
    const image = new Uint8Array(data.length + xml.length + 512);
    image.set(data);
    image.set(xml, data.length);
    image.set(koly, data.length + xml.length);
    return image;
}

test("UDIF: trailer, blkx plist, raw/zero/zlib chunks streamed out", async () =>
{
    const partition = new Uint8Array(512 * 12);
    partition.set(random_bytes(1024));
    partition.set(ascii("compressible ".repeat(300)), 2048);
    const image = udif(partition);
    const trailer = udif_trailer(image.subarray(image.length - 512));
    const [p] = udif_partitions(image.subarray(trailer.xml_offset, trailer.xml_offset + trailer.xml_length));
    assert.equal(p.name, "disk image (Apple_HFSX : 3)");
    assert.equal(p.sectors, 12);
    const out = new Uint8Array(partition.length);
    const offsets = [];
    const stream = udif_partition_stream(p, (offset, bytes) => { offsets.push(offset); out.set(bytes, offset); });
    for(let at = 0; at < image.length; at += 100) await stream.write(image.subarray(at, at + 100));
    await stream.end();
    assert.deepEqual(out, partition);
    assert.deepEqual(offsets, [0, 2048]);
    const short = udif_partition_stream(p, () => {});
    await short.write(image.subarray(0, 900));
    await assert.rejects(short.end(), /missing/);
});

test("plist: dicts, arrays, ID/IDREF, hexadecimal and 64-bit integers, data, entities", () =>
{
    const v = plist_parse(`<?xml version="1.0"?><!-- c --><plist version="1.0"><dict>
        <key>a &amp; b</key><string ID="1">x &lt;y&gt; &#65;</string>
        <key>again</key><string IDREF="1"/>
        <key>n</key><integer size="32">0x10</integer><key>big</key><integer>0xFFFFFFFFFFFFFFFF</integer>
        <key>neg</key><integer>-5</integer><key>r</key><real>1.5</real>
        <key>t</key><true/><key>f</key><false/><key>d</key><data>aGVs
        bG8=</data><key>list</key><array><dict/><array></array><string></string></array>
        <key>empty</key><array/></dict></plist>`);
    assert.equal(v["a & b"], "x <y> A");
    assert.equal(v.again, "x <y> A");
    assert.equal(v.n, 16);
    assert.equal(v.big, 0xFFFFFFFFFFFFFFFFn);
    assert.equal(v.neg, -5);
    assert.equal(v.r, 1.5);
    assert.equal(v.t, true);
    assert.equal(v.f, false);
    assert.deepEqual(v.d, ascii("hello"));
    assert.deepEqual(v.list, [{}, [], ""]);
    assert.deepEqual(v.empty, []);
    assert.throws(() => plist_parse("<plist><dict><key>x</key><string IDREF=\"9\"/></dict></plist>"), /IDREF/);
});

/**
 * A small HFSX volume (4096-byte blocks and nodes): /a.txt, /dir/b.txt,
 * /frag.bin in ten one-block extents (two in the extents overflow tree),
 * /c.txt compressed (decmpfs type 3, zlib), /link a hard link to iNode20
 */
function hfsx(contents)
{
    const B = 4096;
    const image = new Uint8Array(B * 40);
    const unistr = name => { const b = new Uint8Array(2 + 2 * name.length); be16(b, 0, name.length); for(let i = 0; i < name.length; i++) be16(b, 2 + 2 * i, name.charCodeAt(i)); return b; };
    const catalog_key = (parent, name) => { const n = unistr(name), k = new Uint8Array(6 + n.length); be16(k, 0, 4 + n.length); be32(k, 2, parent); k.set(n, 6); return k; };
    const folder = (id, valence) => { const r = new Uint8Array(88); be16(r, 0, 1); be32(r, 4, valence); be32(r, 8, id); be16(r, 42, 0o40755); return r; };
    const file = (id, size, extents, flags = 0, type = "", creator = "", special = 0) =>
    {
        const r = new Uint8Array(248);
        be16(r, 0, 2);
        be32(r, 8, id);
        r[41] = flags;
        be16(r, 42, 0o100644);
        be32(r, 44, special);
        r.set(ascii(type.padEnd(4, "\0")), 48);
        r.set(ascii(creator.padEnd(4, "\0")), 52);
        be64(r, 88, size);
        be32(r, 100, extents.reduce((n, e) => n + e[1], 0));
        extents.slice(0, 8).forEach(([start, count], i) => { be32(r, 104 + 8 * i, start); be32(r, 108 + 8 * i, count); });
        return r;
    };
    const thread = (type, parent, name) => { const n = unistr(name), r = new Uint8Array(8 + n.length); be16(r, 0, type); be32(r, 4, parent); r.set(n, 8); return r; };
    // (block layout: 0 header, 1-2 catalog, 3 extents, 4 attributes, 5.. data)
    const data_at = { "a.txt": 5, "b.txt": 6, link: 0, inode: 7 };
    const frag = Array.from({ length: 10 }, (_, i) => [8 + i * 2, 1]);
    const records = [
        [catalog_key(1, "Volume"), folder(2, 6)],
        [catalog_key(2, ""), thread(3, 1, "Volume")],
        [catalog_key(2, "\0\0\0\0HFS+ Private Data"), folder(18, 1)],
        [catalog_key(2, "a.txt"), file(16, contents.a.length, [[data_at["a.txt"], 1]])],
        [catalog_key(2, "c.txt"), file(21, 0, [], 0x20)],
        [catalog_key(2, "dir"), folder(17, 1)],
        [catalog_key(2, "frag.bin"), file(22, 10 * B, frag)],
        [catalog_key(2, "link"), file(23, 0, [], 0, "hlnk", "hfs+", 20)],
        [catalog_key(16, ""), thread(4, 2, "a.txt")],
        [catalog_key(17, ""), thread(3, 2, "dir")],
        [catalog_key(17, "b.txt"), file(19, contents.b.length, [[data_at["b.txt"], 1]])],
        [catalog_key(18, ""), thread(3, 2, "\0\0\0\0HFS+ Private Data")],
        [catalog_key(18, "iNode20"), file(20, contents.inode.length, [[data_at.inode, 1]])],
    ];
    const node = (kind, height, recs, next = 0) =>
    {
        const n = new Uint8Array(B);
        be32(n, 0, next);
        n[8] = kind & 0xFF;
        n[9] = height;
        be16(n, 10, recs.length);
        let at = 14;
        recs.forEach((r, i) => { be16(n, B - 2 * (i + 1), at); n.set(r, at); at += r.length; });
        be16(n, B - 2 * (recs.length + 1), at);
        return n;
    };
    const header = (root, first, depth, key_compare) =>
    {
        const h = new Uint8Array(106);
        be16(h, 0, depth);
        be32(h, 2, root);
        be32(h, 10, first);
        be16(h, 18, B);
        h[37] = key_compare;
        return node(1, 0, [h, new Uint8Array(128), new Uint8Array(256)]);
    };
    const join = (k, d) => { const r = new Uint8Array(k.length + d.length); r.set(k); r.set(d, k.length); return r; };
    image.set(header(1, 1, 1, 0xBC), B * 1);
    image.set(node(-1, 1, records.map(([k, d]) => join(k, d))), B * 2);
    // (the extents overflow tree: frag.bin's extents 8 and 9, from block 8 on)
    const ext_key = new Uint8Array(12);
    be16(ext_key, 0, 10);
    be32(ext_key, 4, 22);
    be32(ext_key, 8, 8);
    const ext_rec = new Uint8Array(64);
    frag.slice(8).forEach(([start, count], i) => { be32(ext_rec, 8 * i, start); be32(ext_rec, 8 * i + 4, count); });
    image.set(header(1, 1, 1, 0), B * 3);
    image.set(node(-1, 1, [join(ext_key, ext_rec)]), B * 28);
    // (the attributes tree: c.txt's decmpfs header, zlib inline)
    const packed = zlib.deflateSync(contents.c);
    const decmpfs = new Uint8Array(16 + packed.length);
    decmpfs.set(ascii("fpmc"));
    decmpfs[4] = 3;
    new DataView(decmpfs.buffer).setUint32(8, contents.c.length, true);
    decmpfs.set(packed, 16);
    const name = "com.apple.decmpfs", attr_key = new Uint8Array(14 + 2 * name.length);
    be16(attr_key, 0, attr_key.length - 2);
    be32(attr_key, 4, 21);
    be16(attr_key, 12, name.length);
    for(let i = 0; i < name.length; i++) be16(attr_key, 14 + 2 * i, name.charCodeAt(i));
    const attr_rec = new Uint8Array(16 + decmpfs.length + (decmpfs.length & 1));
    be32(attr_rec, 0, 0x10);
    be32(attr_rec, 12, decmpfs.length);
    attr_rec.set(decmpfs, 16);
    image.set(header(1, 1, 1, 0), B * 4);
    image.set(node(-1, 1, [join(attr_key, attr_rec)]), B * 29);
    image.set(contents.a, B * data_at["a.txt"]);
    image.set(contents.b, B * data_at["b.txt"]);
    image.set(contents.inode, B * data_at.inode);
    frag.forEach(([start], i) => image.fill(0x30 + i, B * start, B * (start + 1)));
    // (the volume header; the B-trees' forks: catalog nodes 0-1 in blocks 1-2, the others' header then leaf)
    const vh = image.subarray(1024, 1536);
    vh.set(ascii("HX"));
    be16(vh, 2, 5);
    be32(vh, 0x28, B);
    be32(vh, 0x2C, 40);
    const fork_at = (at, size, extents) => { be64(vh, at, size); extents.forEach(([s, c], i) => { be32(vh, at + 16 + 8 * i, s); be32(vh, at + 20 + 8 * i, c); }); };
    fork_at(0x110, 2 * B, [[1, 2]]);
    fork_at(0xC0, 2 * B, [[3, 1], [28, 1]]);
    fork_at(0x160, 2 * B, [[4, 1], [29, 1]]);
    return image;
}

test("HFS+: descent by parent ID, lookup, extents overflow, hard links, decmpfs", async () =>
{
    const contents = { a: ascii("contents of a\n"), b: ascii("b in a directory\n"), c: ascii("compressed! ".repeat(100)), inode: ascii("the linked file\n") };
    const image = hfsx(contents);
    const volume = await new HFSPlus((offset, length) => image.subarray(offset, offset + length)).open();
    assert.equal(volume.case_sensitive, true);
    const root = await volume.list(2);
    assert.deepEqual(root.map(e => e.name), ["\0\0\0\0HFS+ Private Data", "a.txt", "c.txt", "dir", "frag.bin", "link"]);
    assert.deepEqual(await volume.contents(await volume.lookup("/a.txt")), contents.a);
    assert.deepEqual(await volume.contents(await volume.lookup("/dir/b.txt")), contents.b);
    assert.equal(await volume.lookup("/A.TXT"), null);
    const frag = await volume.contents(await volume.lookup("/frag.bin"));
    assert.equal(frag.length, 10 * 4096);
    for(let i = 0; i < 10; i++) assert.equal(frag[i * 4096 + 5], 0x30 + i, `extent ${i}`);
    const c = await volume.lookup("/c.txt");
    assert.equal(c.compressed, true);
    assert.deepEqual(await volume.contents(c), contents.c);
    const link = await volume.lookup("/link");
    assert.equal(link.type, "hardlink");
    assert.deepEqual(await volume.contents(link), contents.inode);
    const seen = [];
    await volume.walk_tree("/dir", p => { seen.push(p); });
    assert.deepEqual(seen, ["/dir/b.txt"]);
});

test("device tree: parse, serialize, placeholders, paths", () =>
{
    const p = (name, value, placeholder = false) => ({ name, value, placeholder });
    const tree = { properties: [p("name", ascii("device-tree\0")), p("compatible", ascii("N90AP\0iPhone3,1\0AppleARM\0"))], children: [
        { properties: [p("name", ascii("chosen\0")), p("random-seed", new Uint8Array(2), true)], children: [] },
        { properties: [p("name", ascii("arm-io\0")), p("reg", Uint8Array.of(0, 0, 0xc0, 0xbf, 0, 0x10, 0, 0))], children: [
            { properties: [p("name", ascii("uart0\0")), p("interrupts", Uint8Array.of(0x16, 0, 0, 0))], children: [] }] }] };
    const bytes = dt_serialize(tree);
    const back = dt_parse(bytes);
    assert.deepEqual(dt_serialize(back), bytes);
    assert.deepEqual(dt_strings(dt_property(back, "compatible").value), ["N90AP", "iPhone3,1", "AppleARM"]);
    assert.equal(dt_property(dt_find(back, "/chosen"), "random-seed").placeholder, true);
    assert.deepEqual(dt_cells(dt_property(dt_find(back, "/arm-io"), "reg").value), [0xbfc00000, 0x1000]);
    assert.deepEqual(dt_cells(dt_property(dt_find(back, "/arm-io/uart0"), "interrupts").value), [0x16]);
    assert.equal(dt_find(back, "/arm-io/uart9"), null);
    dt_set(dt_find(back, "/chosen"), "random-seed", Uint8Array.of(1, 2, 3, 4, 5));
    const again = dt_parse(dt_serialize(back));
    assert.equal(dt_property(dt_find(again, "/chosen"), "random-seed").placeholder, false);
    assert.equal(dt_property(dt_find(again, "/chosen"), "random-seed").value.length, 5);
});

test("Mach-O: segments, sections, the entry point, UUID, symbols", () =>
{
    const b = new Uint8Array(0x1000), v = new DataView(b.buffer);
    const name = (at, s) => b.set(ascii(s), at);
    v.setUint32(0, 0xFEEDFACE, true);
    v.setUint32(4, 12, true);
    v.setUint32(8, 9, true);
    v.setUint32(12, 2, true);
    v.setUint32(16, 4, true);
    let at = 28;
    // LC_SEGMENT __TEXT with __text
    v.setUint32(at, 1, true); v.setUint32(at + 4, 56 + 68, true); name(at + 8, "__TEXT");
    v.setUint32(at + 24, 0x80001000, true); v.setUint32(at + 28, 0x1000, true); v.setUint32(at + 32, 0, true); v.setUint32(at + 36, 0x1000, true);
    v.setUint32(at + 48, 1, true);
    name(at + 56, "__text"); name(at + 72, "__TEXT"); v.setUint32(at + 88, 0x80001800, true); v.setUint32(at + 92, 0x100, true); v.setUint32(at + 96, 0x800, true);
    at += 56 + 68;
    // LC_UNIXTHREAD: ARM_THREAD_STATE, pc 0x80001801
    v.setUint32(at, 5, true); v.setUint32(at + 4, 16 + 17 * 4, true); v.setUint32(at + 8, 1, true); v.setUint32(at + 12, 17, true);
    v.setUint32(at + 16 + 15 * 4, 0x80001801, true);
    at += 16 + 17 * 4;
    // LC_UUID
    v.setUint32(at, 0x1B, true); v.setUint32(at + 4, 24, true); b.fill(0xAB, at + 8, at + 24);
    at += 24;
    // LC_SYMTAB: two symbols
    v.setUint32(at, 2, true); v.setUint32(at + 4, 24, true); v.setUint32(at + 8, 0xC00, true); v.setUint32(at + 12, 2, true);
    v.setUint32(at + 16, 0xD00, true); v.setUint32(at + 20, 32, true);
    name(0xD01, "_start\0_main\0");
    v.setUint32(0xC00, 1, true); b[0xC04] = 0x0F; b[0xC05] = 1; v.setUint32(0xC08, 0x80001800, true);
    v.setUint32(0xC0C, 8, true); b[0xC10] = 0x0F; b[0xC11] = 1; v.setUint32(0xC14, 0x80001820, true);
    const m = macho_parse(b);
    assert.equal(m.cputype, 12);
    assert.equal(m.entry, 0x80001801);
    assert.equal(m.uuid, "ab".repeat(16));
    assert.equal(m.segments[0].name, "__TEXT");
    assert.deepEqual(m.segments[0].sections.map(s => [s.name, s.addr, s.size, s.offset]), [["__text", 0x80001800, 0x100, 0x800]]);
    assert.deepEqual(macho_symbols(b, m).map(s => [s.name, s.value]), [["_start", 0x80001800], ["_main", 0x80001820]]);
    assert.equal(macho_offset(m, 0x80001804), 0x804);
    assert.equal(macho_offset(m, 0x90000000), -1);
});

test("key files: format, hex lengths, the root filesystem's 36-byte key", () =>
{
    const good = { format: "v86-ios-keys", version: 1, device: "iPhone3,1", build: "10B329", images: {
        Kernelcache: { file: "kernelcache.release.n90", iv: "00".repeat(16), key: "11".repeat(32) },
        RootFileSystem: { file: "048-2748-005.dmg", key: "22".repeat(36) } } };
    assert.equal(keys_parse(JSON.stringify(good)).device, "iPhone3,1");
    assert.throws(() => keys_parse({ ...good, format: "other" }), /v86-ios-keys/);
    assert.throws(() => keys_parse({ ...good, images: { RootFileSystem: { file: "x", key: "22".repeat(32) } } }), /36 bytes/);
    assert.throws(() => keys_parse({ ...good, images: { Kernelcache: { file: "x", iv: "00", key: "11".repeat(32) } } }), /IV/);
});

let failed = 0;
for(const [name, f] of tests)
{
    try
    {
        await f();
        console.log("ok   " + name);
    }
    catch(e)
    {
        failed++;
        console.log("FAIL " + name);
        console.log(e);
    }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
