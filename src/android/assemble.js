// Android image packages made into a disk (docs/android-images-plan.md I3):
// what a package is, the disk it gives (the device model's partitions, super
// shrunk to its partitions, userdata blank of the chosen size) and the disk
// written as the zip's members inflate, through write(offset, bytes) (an
// OPFS file's sync handle in a worker, a node file, a disk service's
// session). The images are written as they are: nothing in them changes but
// super's size in its metadata.

import { latin1, u32 } from "./bytes.js";
import { zip_entries, zip_stream, zip_read } from "./zip.js";
import { sparse_decoder } from "./sparse.js";
import { lp_metadata, lp_end, lp_resize } from "./lp.js";
import { gpt_layout, gpt_writes, SECTOR } from "./gpt.js";
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
 * The disk a Cuttlefish images zip gives: the device's partitions in order,
 * each image as it is, super shrunk (its metadata's block device size) and
 * userdata blank (formatted at first boot)
 * @param {function(number, number): (!Uint8Array|!Promise<!Uint8Array>)} read
 * @param {!Array<!Object>} entries
 * @param {{userdata_bytes: number}} options
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
    const super_writes = lp_resize(lp, lp_end(lp) * SECTOR + SUPER_SLACK);
    const list = device_partitions(device).map(({ name, base, blank }) =>
    {
        if(blank) return { name, size: blank, blank: true };
        if(base === "super") return { name, size: lp.size, member: member("super.img"), sparse: true };
        if(base === "userdata") return { name, size: options.userdata_bytes, blank: true };
        const m = member(base + ".img");
        return { name, size: m.size, member: m };
    });
    const { partitions, disk_size } = gpt_layout(list);
    const data_bytes = partitions.reduce((n, p) => n + (p.member ? p.member.size : 0), 0);
    return { device, partitions, disk_size, super_head: head, super_writes, super_size: lp.size, data_bytes };
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
        if(!p.member) continue;
        if(!p.sparse)
        {
            let at = p.start;
            await zip_stream(read, p.member, async bytes => { await write(at, bytes); at += bytes.length; done += bytes.length; progress(done, disk.data_bytes); });
            continue;
        }
        // (a sparse image: its writes collected as a piece inflates, then written)
        let pending = [];
        const decoder = sparse_decoder((at, bytes) =>
        {
            const n = Math.max(0, Math.min(bytes.length, p.size - at));
            if(n < bytes.length && bytes.subarray(n).some(b => b)) throw new Error(`${p.member.name}: data at ${at + n}, past its partition's ${p.size} bytes`);
            if(n) pending.push([p.start + at, bytes.slice(0, n)]);
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
        if(p.name === "super") for(const w of disk.super_writes) await write(p.start + w.offset, w.bytes);
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
