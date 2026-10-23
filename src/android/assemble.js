// Android image packages made into a disk (docs/android-images-plan.md I3):
// what a package is, the disk it gives (the device model's partitions, super
// shrunk to its partitions, userdata blank of the chosen size) and the disk
// written as the zip's members inflate, through write(offset, bytes) (an
// OPFS file's sync handle in a worker, a node file, a disk service's
// session). The images are written as they are: nothing in them changes but
// super's size in its metadata.

import { latin1, u16, u32 } from "./bytes.js";
import { zip_entries, zip_stream, zip_read } from "./zip.js";
import { sparse_decoder } from "./sparse.js";
import { lp_metadata, lp_end, lp_resize, lp_place } from "./lp.js";
import { gpt_layout, gpt_writes, SECTOR } from "./gpt.js";
import { vbmeta_struct, AVB_FLAG_VERIFICATION_DISABLED } from "./avb.js";
import { parse_vendor_boot_image } from "./bootimg.js";
import { lz4_legacy_decompress } from "./lz4.js";
import { cpio_files } from "./cpio.js";
import { CF_ARM64_ONLY_PHONE, device_partitions } from "./devices.js";

/** super's room after its partitions once shrunk */
export const SUPER_SLACK = 64 << 20;
/** the bytes of super inflated before its metadata is read: its geometry and
 * every copy (liblp: 4 KiB reserved, two geometries, the copies) are near its
 * start, in the sparse image's first chunks */
const SUPER_HEAD = 4 << 20;

/**
 * What a package is, from its members (zip_entries')
 * @param {!Array<!Object>} entries
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @return {!Promise<{kind: string, device: (string|undefined), text: string}|null>}
 *     kind: cuttlefish (a whole device), gsi (a system), emulator (the SDK's)
 */
export async function identify_package(entries, read)
{
    const names = new Set(entries.map(e => e.name));
    if(names.has("fastboot-info.txt") && names.has("super.img") && names.has("vendor_boot.img") && names.has("boot.img"))
    {
        const info = latin1(await zip_read(read, entries.find(e => e.name === "fastboot-info.txt")));
        if(!/^#\s*cuttlefish/m.test(info)) return null;
        // (the kernel's architecture: arm64's Image has "ARMd" at 56)
        const boot = await zip_read(read, entries.find(e => e.name === "boot.img"), 4096 + 64);
        const arm64 = latin1(boot, 4096 + 56, 4096 + 60) === "ARMd";
        return arm64 ? { kind: "cuttlefish", device: CF_ARM64_ONLY_PHONE.id, text: "a Cuttlefish arm64 device (its images zip)" } :
            { kind: "unsupported", device: undefined, text: "a Cuttlefish device, not arm64" };
    }
    if(names.has("system.img") && !names.has("vendor_boot.img") && !names.has("super.img"))
    {
        return { kind: "gsi", device: undefined, text: "a Generic System Image (a system for a device's vendor: docs/android-images-plan.md I5)" };
    }
    if([...names].some(n => /(^|\/)kernel-ranchu(-64)?$/.test(n)))
    {
        return { kind: "emulator", device: undefined, text: "an Android Emulator system image (the ranchu board: docs/android-images-plan.md I6)" };
    }
    return null;
}

/**
 * key=value lines as a Map
 * @param {string} text
 * @return {!Map<string, string>}
 */
function properties(text)
{
    const map = new Map();
    for(const line of text.split("\n"))
    {
        const m = /^([^#=\s][^=]*)=(.*)$/.exec(line.trim());
        if(m) map.set(m[1], m[2]);
    }
    return map;
}

/**
 * A version as sdk_full ("36.1") in numbers to compare
 * @param {string|undefined} text
 * @return {number}
 */
function sdk_full(text)
{
    const m = /^(\d+)(?:\.(\d+))?$/.exec(text || "");
    return m ? +m[1] * 1000 + +(m[2] || 0) : NaN;
}

/**
 * A Generic System Image's zip: its system.img (raw ext4 or erofs, or
 * sparse), vbmeta.img (which must disable verification) and build.prop's
 * version and ABIs (docs/android-images-plan.md I5)
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Array<!Object>} entries
 */
export async function gsi_package(read, entries)
{
    const member = name => entries.find(e => e.name === name) || (() => { throw new Error("the GSI has no " + name); })();
    const system = member("system.img"), vbmeta = await zip_read(read, member("vbmeta.img"));
    if(!(vbmeta_struct(vbmeta).flags & AVB_FLAG_VERIFICATION_DISABLED)) throw new Error("the GSI's vbmeta.img does not disable verification");
    const head = await zip_read(read, system, 1082);
    const sparse = u32(head, 0) === 0xED26FF3A;
    if(!sparse && u16(head, 1080) !== 0xEF53 && u32(head, 1024) !== 0xE0F5E1E2) throw new Error("the GSI's system.img is not ext4, erofs or a sparse image");
    let size = system.size;
    if(sparse)
    {
        const h = await zip_read(read, system, 28);
        size = u32(h, 12) * u32(h, 16);
    }
    if(size % SECTOR) throw new Error("the GSI's system.img is not whole sectors");
    const prop = entries.find(e => e.name === "build.prop");
    const props = prop ? properties(latin1(await zip_read(read, prop))) : new Map();
    return { system, sparse, size, vbmeta, props,
        sdk_full: props.get("ro.system.build.version.sdk_full") || props.get("ro.build.version.sdk_full") || "",
        release: props.get("ro.system.build.version.release") || props.get("ro.build.version.release") || "",
        fingerprint: props.get("ro.system.build.fingerprint") || props.get("ro.build.fingerprint") || "",
        abilist32: props.get("ro.system.product.cpu.abilist32") || props.get("ro.product.cpu.abilist32") || "" };
}

/**
 * The disk a Cuttlefish images zip gives: the device's partitions in order,
 * each image as it is, super shrunk (its metadata's block device size) and
 * userdata blank (formatted at first boot). With a GSI (gsi_package's, and
 * the reads of its zip): its system.img as system_a in free space in super
 * (the old system_a's data not written), its vbmeta.img as vbmeta_a and
 * vbmeta_b (nothing verified, as flashing a GSI needs); refused when it is
 * older than the device's vendor (I0.2: init's SELinux policy does not compile)
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Array<!Object>} entries
 * @param {{userdata_bytes: number, gsi: (Object|undefined), gsi_read: (Function|undefined)}} options
 * @return {!Promise<{device: !Object, partitions: !Array<{name: string, start: number, size: number, member: (Object|undefined), blank: (boolean|undefined)}>,
 *     disk_size: number, super_head: !Uint8Array, super_writes: !Array<{offset: number, bytes: !Uint8Array}>, super_size: number, data_bytes: number}>}
 *     data_bytes: what is written (no blank space), for progress
 */
export async function cuttlefish_disk(read, entries, options)
{
    const device = CF_ARM64_ONLY_PHONE;
    const member = name =>
    {
        const e = entries.find(e => e.name === name);
        if(!e) throw new Error(`the package has no ${name}`);
        return e;
    };
    // super's metadata, from the start of its sparse image as it inflates
    const head = new Uint8Array(SUPER_HEAD);
    const decoder = sparse_decoder((at, bytes) =>
    {
        if(at < SUPER_HEAD) head.set(bytes.subarray(0, Math.min(bytes.length, SUPER_HEAD - at)), at);
    });
    let pushed = 0;
    await zip_stream(read, member("super.img"), bytes => { decoder.push(bytes); pushed += bytes.length; }, { limit: SUPER_HEAD + (1 << 20) });
    if(decoder.size() < 0) throw new Error("super.img is not a sparse image");
    const lp = lp_metadata((offset, length) =>
    {
        if(offset + length > SUPER_HEAD) throw new Error("super's metadata is beyond its first " + SUPER_HEAD + " bytes");
        return head.subarray(offset, offset + length);
    });
    // (the vendor's version: vendor_boot's ramdisk's prop.default, "" when it has none)
    let vendor_sdk_full = "";
    try
    {
        const vendor_boot = parse_vendor_boot_image(await zip_read(read, member("vendor_boot.img")));
        const prop_default = cpio_files(lz4_legacy_decompress(vendor_boot.ramdisk)).get("prop.default");
        if(prop_default) vendor_sdk_full = properties(latin1(prop_default)).get("ro.vendor.build.version.sdk_full") || "";
    }
    catch(e)
    {
        vendor_sdk_full = "";
    }
    const gsi = options.gsi;
    let skip = null, gsi_at = 0;
    if(gsi)
    {
        // (checked when both say their version)
        if(sdk_full(gsi.sdk_full) < sdk_full(vendor_sdk_full))
        {
            throw new Error(`the GSI (Android ${gsi.release}, sdk_full ${gsi.sdk_full || "?"}) is older than the device's vendor (sdk_full ${vendor_sdk_full || "?"}): ` +
                "it does not boot (init's SELinux policy does not compile); choose a GSI of the same release or newer");
        }
        const old = lp.copies[0].partitions.find(p => p.name === "system_a");
        if(!old) throw new Error("super has no system_a");
        skip = old.extents.map(e => [e.sector * SECTOR, (e.sector + e.sectors) * SECTOR]);
        const align = lp.alignment / SECTOR, sector = Math.ceil(lp_end(lp) / align) * align;
        lp_place(lp, "system_a", sector, gsi.size / SECTOR);
        gsi_at = sector * SECTOR;
    }
    lp_resize(lp, lp_end(lp) * SECTOR + SUPER_SLACK);
    const super_writes = lp.copies.map(c => ({ offset: c.offset, bytes: c.bytes }));
    const list = device_partitions(device).map(({ name, base, blank }) =>
    {
        if(blank) return { name, size: blank, blank: true };
        if(base === "super") return { name, size: lp.size, member: member("super.img"), sparse: true, skip };
        if(base === "userdata") return { name, size: options.userdata_bytes, blank: true };
        if(base === "vbmeta" && gsi) return { name, size: gsi.vbmeta.length, bytes: gsi.vbmeta };
        const m = member(base + ".img");
        return { name, size: m.size, member: m };
    });
    const { partitions, disk_size } = gpt_layout(list);
    const data_bytes = partitions.reduce((n, p) => n + (p.member ? p.member.size : 0), 0) + (gsi ? gsi.system.size : 0);
    return { device, partitions, disk_size, super_head: head, super_writes, super_size: lp.size, data_bytes, vendor_sdk_full,
        gsi: gsi ? { read: options.gsi_read, system: gsi.system, sparse: gsi.sparse, at: gsi_at } : null };
}

/**
 * The disk written: the GPT, each partition's image (super's sparse image
 * as it inflates, its writes past its shrunk size left out: zeros), super's
 * new metadata. Blank space is not written (a new file reads as zeros).
 * progress(done, total) in data bytes
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Object} disk cuttlefish_disk's
 * @param {function(number, !Uint8Array): (Promise|undefined)} write
 * @param {function(number, number)=} progress
 */
export async function write_disk(read, disk, write, progress = () => {})
{
    for(const w of gpt_writes(disk.disk_size, disk.partitions)) await write(w.offset, w.bytes);
    let done = 0;
    for(const p of disk.partitions)
    {
        if(p.bytes) { await write(p.start, p.bytes); continue; }
        if(!p.member) continue;
        if(!p.sparse)
        {
            let at = p.start;
            await zip_stream(read, p.member, async bytes => { await write(at, bytes); at += bytes.length; done += bytes.length; progress(done, disk.data_bytes); });
            continue;
        }
        // (a sparse image: its writes collected as a piece inflates, then written)
        let pending = [];
        const keep = (at, bytes) =>
        {
            const n = Math.max(0, Math.min(bytes.length, p.size - at));
            if(n < bytes.length && bytes.subarray(n).some(b => b)) throw new Error(`${p.member.name}: data at ${at + n}, past its partition's ${p.size} bytes`);
            if(n) pending.push([p.start + at, bytes.slice(0, n)]);
        };
        const decoder = sparse_decoder((at, bytes) =>
        {
            // (the replaced system_a's data left out: a piece cut at its edges)
            let pieces = [[at, bytes]];
            for(const [from, to] of p.skip || [])
            {
                pieces = pieces.flatMap(([a, b]) => a >= to || a + b.length <= from ? [[a, b]] :
                    [[a, b.subarray(0, Math.max(0, from - a))], [to, b.subarray(Math.min(b.length, to - a))]].filter(([, x]) => x.length));
            }
            for(const [a, b] of pieces) keep(a, b);
        });
        await zip_stream(read, p.member, async bytes =>
        {
            decoder.push(bytes);
            for(const [offset, data] of pending) await write(offset, data);
            pending = [];
            done += bytes.length;
            progress(done, disk.data_bytes);
        });
        decoder.end();
        if(p.name !== "super") continue;
        for(const w of disk.super_writes) await write(p.start + w.offset, w.bytes);
        // the GSI's system.img at its extent, raw or sparse
        const g = disk.gsi;
        if(!g) continue;
        if(g.sparse)
        {
            let queue = [];
            const system = sparse_decoder((at, bytes) => { queue.push([p.start + g.at + at, bytes.slice()]); });
            await zip_stream(g.read, g.system, async bytes =>
            {
                system.push(bytes);
                for(const [offset, data] of queue) await write(offset, data);
                queue = [];
                done += bytes.length;
                progress(done, disk.data_bytes);
            });
            system.end();
        }
        else
        {
            let at = p.start + g.at;
            await zip_stream(g.read, g.system, async bytes => { await write(at, bytes); at += bytes.length; done += bytes.length; progress(done, disk.data_bytes); });
        }
    }
}

/**
 * A package's members from a file (a File, or bytes) by its size:
 * zip_entries over read
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {number} size
 */
export async function package_entries(read, size)
{
    const head = await read(0, 4);
    if(head.length < 4 || u32(head, 0) !== 0x04034B50) throw new Error("not a zip archive (an Android image package is a .zip)");
    return zip_entries(read, size);
}
