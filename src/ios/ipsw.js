// An iPhone's IPSW (docs/iphone4-plan.md S0): a zip of the restore
// firmware. The user brings it and the keys (The Apple Wiki's key page, as
// the key file below); this decrypts and checks each image and takes out
// what the s5l8930 machine boots: the kernelcache (a Mach-O), the device
// tree, the restore ramdisk (HFS+) and the root filesystem's system
// partition (HFSX). The archive is read through read(offset, length), which
// returns bytes or a promise of them (a file in node, a File's slices).
//
// The key file (never in the repository: docs/iphone4-plan.md "法律与分发"):
//   { "format": "v86-ios-keys", "version": 1, "device": "iPhone3,1", "build": "10B329", ...,
//     "images": { "<the key page's item>": { "file": "<name in the IPSW>", "iv": "<hex>", "key": "<hex>" } } }
// RootFileSystem has a 36-byte key and no IV.

import { zip_entries, zip_stream, zip_read } from "../android/zip.js";
import { latin1, u32be } from "../android/bytes.js";
import { plist_parse } from "./plist.js";
import { img3_payload } from "./img3.js";
import { complzss_decompress } from "./lzss.js";
import { vfdecrypt_stream } from "./vfdecrypt.js";
import { udif_trailer, udif_partitions, udif_partition_stream, inflate_zlib, CHUNK } from "./udif.js";
import { SHA1 } from "./crypto.js";
import { dt_parse, dt_property, dt_strings, dt_walk } from "../apple/devicetree.js";
import { macho_parse, CPU_TYPE_ARM } from "../apple/macho.js";

export const KEY_FORMAT = "v86-ios-keys";

/**
 * A key file, checked
 * @param {string|Object} source
 * @return {Object}
 */
export function keys_parse(source)
{
    const keys = typeof source === "string" ? JSON.parse(source) : source;
    if(keys?.format !== KEY_FORMAT || keys.version !== 1) throw new Error(`keys: not a ${KEY_FORMAT} version 1 file`);
    if(typeof keys.images !== "object" || !keys.images) throw new Error("keys: no images");
    for(const [name, image] of Object.entries(keys.images))
    {
        if(typeof image.file !== "string") throw new Error(`keys: ${name} has no file`);
        if(name === "RootFileSystem")
        {
            if(!/^[0-9a-fA-F]{72}$/.test(image.key || "")) throw new Error("keys: RootFileSystem's key is not 36 bytes of hexadecimal");
        }
        else if(!/^[0-9a-fA-F]{32}$/.test(image.iv || "") || !/^([0-9a-fA-F]{32}|[0-9a-fA-F]{48}|[0-9a-fA-F]{64})$/.test(image.key || ""))
        {
            throw new Error(`keys: ${name} needs a 16-byte IV and a 16-, 24- or 32-byte key in hexadecimal`);
        }
    }
    return keys;
}

/**
 * The archive's members and what its plists say
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {number} size
 * @return {!Promise<Object>}
 */
export async function ipsw_open(read, size)
{
    const entries = await zip_entries(read, size);
    const by_name = new Map(entries.map(e => [e.name, e]));
    const plist = async name => by_name.has(name) ? plist_parse(await zip_read(read, by_name.get(name))) : null;
    const manifest = await plist("BuildManifest.plist");
    const restore = await plist("Restore.plist");
    if(!manifest && !restore) throw new Error("IPSW: neither BuildManifest.plist nor Restore.plist: not an IPSW");
    // (the erase install's identity names the files)
    const identity = manifest?.BuildIdentities?.find(i => /Erase/.test(i.Info?.Variant || "")) ?? manifest?.BuildIdentities?.[0];
    const path_of = key => identity?.Manifest?.[key]?.Info?.Path ?? null;
    return {
        read, size, entries,
        version: manifest?.ProductVersion ?? restore?.ProductVersion,
        build: manifest?.ProductBuildVersion ?? restore?.ProductBuildVersion,
        product_types: manifest?.SupportedProductTypes ?? (restore?.SupportedProductTypes || [restore?.ProductType]).filter(Boolean),
        boards: (restore?.DeviceMap || []).map(d => d.BoardConfig).filter(Boolean),
        kernelcache: path_of("KernelCache"),
        devicetree: path_of("DeviceTree"),
        restore_ramdisk: path_of("RestoreRamDisk"),
        system_image: path_of("OS"),
        /** @param {string} file @return {?Object} the member whose name ends in file */
        member(file)
        {
            return entries.find(e => e.name === file || e.name.endsWith("/" + file)) || null;
        },
    };
}

/**
 * The archive's SHA-1, in hexadecimal
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {number} size
 * @param {function(number)=} progress bytes done
 * @return {!Promise<string>}
 */
export async function ipsw_sha1(read, size, progress)
{
    const hash = new SHA1();
    for(let at = 0; at < size;)
    {
        const n = Math.min(8 << 20, size - at);
        hash.update(await read(at, n));
        at += n;
        if(progress) progress(at);
    }
    return hash.hex();
}

/** @param {!Uint8Array} b @param {string} text @return {number} */
function find_text(b, text)
{
    const first = text.charCodeAt(0);
    outer: for(let at = b.indexOf(first); at >= 0 && at + text.length <= b.length; at = b.indexOf(first, at + 1))
    {
        for(let i = 1; i < text.length; i++) if(b[at + i] !== text.charCodeAt(i)) continue outer;
        return at;
    }
    return -1;
}

/** @param {!Uint8Array} b @param {number} at @return {string} printable text from at */
function text_at(b, at)
{
    let end = at;
    while(end < b.length && b[end] >= 0x20 && b[end] < 0x7F) end++;
    return latin1(b, at, end);
}

/**
 * What a decrypted image's payload is, checked by its type: a summary, or
 * an exception when it is not what it should be (a wrong key)
 * @param {string} type the IMG3 type
 * @param {!Uint8Array} plain
 * @return {string}
 */
export function check_payload(type, plain)
{
    if(type === "krnl")
    {
        const kernel = complzss_decompress(plain);
        const m = macho_parse(kernel);
        if(m.cputype !== CPU_TYPE_ARM || m.is64) throw new Error("kernelcache: not a 32-bit ARM Mach-O");
        const at = find_text(kernel, "Darwin Kernel Version");
        return `ARM Mach-O, ${kernel.length} bytes; ` + (at >= 0 ? text_at(kernel, at) : "no version string");
    }
    if(type === "dtre")
    {
        const root = dt_parse(plain);
        let nodes = 0;
        dt_walk(root, () => { nodes++; });
        const compatible = dt_property(root, "compatible");
        return `${nodes} nodes, compatible ${compatible ? dt_strings(compatible.value).join(", ") : "?"}`;
    }
    if(type === "rdsk")
    {
        const signature = latin1(plain, 0x400, 0x402);
        if(signature !== "H+" && signature !== "HX") throw new Error("ramdisk: no HFS+ volume header at 0x400");
        return `HFS+ volume of ${u32be(plain, 0x428) * u32be(plain, 0x42C) >> 20} MiB`;
    }
    if(type === "ibot" || type === "ibss" || type === "ibec" || type === "illb")
    {
        const at = find_text(plain, "iBoot-");
        if(at < 0) throw new Error(`${type}: no iBoot version string`);
        return text_at(plain, at);
    }
    if(latin1(plain, 0, 8) !== "iBootIm\0") throw new Error(`${type}: no iBootIm header`);
    return "iBootIm image";
}

/**
 * A key file's image, decrypted out of the archive
 * @param {Object} ipsw ipsw_open's
 * @param {Object} image the key file's entry
 * @return {!Promise<{type: string, data: !Uint8Array, encrypted: boolean}>}
 */
export async function ipsw_image(ipsw, image)
{
    const entry = ipsw.member(image.file);
    if(!entry) throw new Error(`IPSW: no ${image.file}`);
    return img3_payload(await zip_read(ipsw.read, entry), image);
}

/**
 * The root filesystem's decrypted data, streamed: the head (first `head`
 * bytes) and the tail (last `tail` bytes) only
 * @param {Object} ipsw
 * @param {Object} image the key file's RootFileSystem
 * @param {number} head
 * @param {number} tail
 * @param {function(number)=} progress compressed bytes done
 * @return {!Promise<{head: !Uint8Array, tail: !Uint8Array, data_size: number}>}
 */
async function rootfs_ends(ipsw, image, head, tail, progress)
{
    const entry = ipsw.member(image.file);
    if(!entry) throw new Error(`IPSW: no ${image.file}`);
    let data_size = 0, head_bytes = null, tail_bytes = null, tail_from = 0;
    const stream = vfdecrypt_stream(image.key, (bytes, offset) =>
    {
        if(!data_size)
        {
            data_size = stream.header().data_size;
            head_bytes = new Uint8Array(Math.min(head, data_size));
            tail_from = Math.max(0, data_size - tail);
            tail_bytes = new Uint8Array(data_size - tail_from);
        }
        if(offset < head_bytes.length) head_bytes.set(bytes.subarray(0, head_bytes.length - offset), offset);
        if(offset + bytes.length > tail_from)
        {
            const skip = Math.max(0, tail_from - offset);
            tail_bytes.set(bytes.subarray(skip), offset + skip - tail_from);
        }
    }, { want: (offset, length) =>
    {
        const size = stream.header().data_size;
        return offset < head || offset + length > size - tail;
    } });
    let done = 0;
    await zip_stream(ipsw.read, entry, async bytes =>
    {
        await stream.write(bytes);
        done += bytes.length;
        if(progress) progress(done);
    });
    await stream.end();
    return { head: head_bytes, tail: tail_bytes, data_size };
}

/**
 * The root filesystem's DMG checked: its trailer, partitions and the
 * system partition's volume header
 * @param {Object} ipsw
 * @param {Object} image
 * @param {function(number)=} progress
 * @return {!Promise<{summary: string, partitions: !Array<Object>, system: Object, trailer: Object}>}
 */
export async function check_rootfs(ipsw, image, progress)
{
    const { head, tail, data_size } = await rootfs_ends(ipsw, image, 4 << 20, 8 << 20, progress);
    const tail_start = data_size - tail.length;
    const trailer = udif_trailer(tail.subarray(tail.length - 512));
    if(trailer.xml_offset < tail_start) throw new Error("root filesystem: the DMG's plist is outside the last 8 MiB");
    const partitions = udif_partitions(tail.subarray(trailer.xml_offset - tail_start, trailer.xml_offset - tail_start + trailer.xml_length));
    const system = partitions.find(p => /Apple_HFS/.test(p.name));
    if(!system) throw new Error("root filesystem: no Apple_HFS partition");
    const first = system.chunks.find(c => c.sector === 0 && (c.type === CHUNK.ZLIB || c.type === CHUNK.RAW));
    const start = trailer.data_fork_offset + system.data_offset + (first ? first.offset : 0);
    if(!first || start + first.length > head.length) throw new Error("root filesystem: the system partition's first chunk is not in the first 4 MiB");
    const raw = head.subarray(start, start + first.length);
    const sector0 = first.type === CHUNK.ZLIB ? await inflate_zlib(raw) : raw;
    const summary = check_payload("rdsk", sector0).replace("HFS+ volume", "system partition: HFS+ volume");
    return {
        summary: `DMG of ${trailer.sectors * 512 >> 20} MiB, ${partitions.length} partitions; ${system.name}; ${summary}`,
        partitions, system, trailer,
    };
}

/**
 * Every image of the key file checked, in order: report(name, ok, text)
 * @param {Object} ipsw
 * @param {Object} keys keys_parse's
 * @param {function(string, boolean, string)} report
 * @param {function(string, number)=} progress
 * @return {!Promise<number>} the failures
 */
export async function ipsw_check(ipsw, keys, report, progress)
{
    let failures = 0;
    for(const [name, image] of Object.entries(keys.images))
    {
        try
        {
            let text;
            if(name === "RootFileSystem")
            {
                text = (await check_rootfs(ipsw, image, progress && (n => progress(name, n)))).summary;
            }
            else
            {
                const payload = await ipsw_image(ipsw, image);
                text = `[${payload.type}] ` + check_payload(payload.type, payload.data);
            }
            report(name, true, text);
        }
        catch(e)
        {
            failures++;
            report(name, false, e.message);
        }
    }
    return failures;
}

/**
 * The root filesystem's system partition, written out: out(offset, bytes)
 * in order (awaited); the zero-filled stretches are left out
 * @param {Object} ipsw
 * @param {Object} image the key file's RootFileSystem
 * @param {function(number, !Uint8Array): (Promise|undefined)} out
 * @param {function(string, number)=} progress
 * @return {!Promise<{size: number, name: string}>} the partition's
 */
export async function extract_system_partition(ipsw, image, out, progress)
{
    const { system, trailer } = await check_rootfs(ipsw, image, progress && (n => progress("check", n)));
    const entry = ipsw.member(image.file);
    const partition = udif_partition_stream(system, out, trailer.data_fork_offset);
    const stream = vfdecrypt_stream(image.key, bytes => partition.write(bytes));
    let done = 0;
    await zip_stream(ipsw.read, entry, async bytes =>
    {
        await stream.write(bytes);
        done += bytes.length;
        if(progress) progress("extract", done);
    });
    await stream.end();
    await partition.end();
    return { size: system.sectors * 512, name: system.name };
}
