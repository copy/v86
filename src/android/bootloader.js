// v64's Android bootloader (docs/android-images-plan.md I2): from the
// first disk's GPT, the slot's boot, init_boot, vendor_boot and vbmeta
// partitions (and those vbmeta chains), what the device's bootloader hands
// the kernel (boot.js): the kernel, the initrd with bootconfig, the command
// line. An emulator image's device (the ranchu machine's, I6): its kernel
// and ramdisk partitions as they are, the emulator's command line, and the
// partitions that are the emulator's disks. The disk is read through
// read(offset, length), a promise of the bytes (a disk buffer's get).

import { gpt_partitions } from "./gpt.js";
import { vbmeta_struct, AVB_FLAG_VERIFICATION_DISABLED } from "./avb.js";
import { android_boot } from "./boot.js";
import { CF_ARM64_ONLY_PHONE, RANCHU_DEVICES, ranchu_gpu_mode } from "./devices.js";
import { ranchu_cmdline } from "../virt/ranchu.js";
import { ramdisk_overlay } from "./ramdisk_overlay.js";

/** the device models by id (the VM config's android.device) */
export const ANDROID_DEVICES = Object.fromEntries([CF_ARM64_ONLY_PHONE, ...RANCHU_DEVICES].map(d => [d.id, d]));

/**
 * @param {function(number, number): !Promise<!Uint8Array>} read
 * @param {number} disk_size
 * @param {{device: (string|undefined), gpu_mode: (string|undefined), selinux: (string|undefined), memory_mb: number,
 *     vendor_ramdisk: (Uint8Array|undefined)}} options vendor_ramdisk: in
 *     place of the vendor_boot's (Cuttlefish's debug one)
 * @return {!Promise<{kernel: !Uint8Array, initrd: !Uint8Array, cmdline: string, bootconfig: ?Map<string, string>, vbmeta: ?Object,
 *     disks: (!Array<{name: string, start: number, size: number, readonly: boolean}>|undefined), ranchu_gpu: (string|undefined)}>}
 *     disks: (an emulator image's) the partitions that are the machine's virtio disks, in order;
 *     ranchu_gpu: (an emulator image's) its GPU mode's ranchu_gpu
 */
export async function android_bootloader(read, disk_size, options)
{
    const device = ANDROID_DEVICES[options.device || CF_ARM64_ONLY_PHONE.id];
    if(!device) throw new Error("android: no device model " + options.device);
    // the GPT: both ends of the disk read first (the primary's entries
    // follow it, the backup's precede it)
    const span = Math.min(disk_size, 1 << 16);
    const head = await read(0, span), tail = await read(disk_size - span, span);
    const partitions = gpt_partitions((offset, length) =>
    {
        if(offset + length <= head.length) return head.subarray(offset, offset + length);
        if(offset >= disk_size - span) return tail.subarray(offset - (disk_size - span), offset - (disk_size - span) + length);
        throw new Error("android: the GPT's entries are not at an end of the disk");
    }, disk_size);
    const by_name = new Map(partitions.map(p => [p.name, p]));
    if(device.machine === "ranchu")
    {
        const part = name =>
        {
            const p = by_name.get(name);
            if(!p) throw new Error(`android: the disk has no ${name} partition (${partitions.map(p => p.name).join(", ")})`);
            if(p.start + p.size > disk_size) throw new Error(`android: ${p.name} is beyond the disk`);
            return p;
        };
        const load = async name => { const p = part(name); return new Uint8Array(await read(p.start, p.size)); };
        const gpu = ranchu_gpu_mode(device, options.gpu_mode, options.gles_version);
        // (a partition is whole sectors: the kernel's and ramdisk's bytes run to their ends, which the kernel ignores)
        return { kernel: await load("kernel"), initrd: await ramdisk_overlay(await load("ramdisk"), device),
            cmdline: ranchu_cmdline({ arm32: device.cmdline.arm32, bootanim: device.cmdline.bootanim, gles: gpu.gles }),
            bootconfig: null, vbmeta: null,
            properties: Object.assign({}, device.properties, gpu.properties), clock_rate: device.clock_rate || null,
            ranchu_gpu: gpu.ranchu_gpu, gles_version: gpu.gles_version,
            disks: device.partitions.filter(p => p.disk).map(p => ({ name: p.name, start: part(p.name).start, size: part(p.name).size,
                readonly: p.disk === "read_only" })) };
    }
    const loaded = new Map();
    const load = async name =>
    {
        if(loaded.has(name)) return loaded.get(name);
        const p = by_name.get(name + device.slot) || by_name.get(name);
        if(!p) throw new Error(`android: the disk has no ${name}${device.slot} partition (${partitions.map(p => p.name).join(", ")})`);
        if(p.start + p.size > disk_size) throw new Error(`android: ${p.name} is beyond the disk`);
        // (a copy: the disk's buffer may hand out its cache)
        const bytes = new Uint8Array(await read(p.start, p.size));
        loaded.set(name, bytes);
        return bytes;
    };
    for(const name of ["vbmeta", "boot", "init_boot", "vendor_boot"]) await load(name);
    // (the partitions vbmeta chains, which libavb loads unless it disables verification)
    const top = vbmeta_struct(loaded.get("vbmeta"));
    if(!(top.flags & AVB_FLAG_VERIFICATION_DISABLED))
    {
        for(const d of top.descriptors) if(d.tag === 4) await load(/** @type {string} */ (d.partition));
    }
    return android_boot(name =>
    {
        if(!loaded.has(name)) throw new Error("android: " + name + " was not loaded");
        return loaded.get(name);
    }, device, options);
}
