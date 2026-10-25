// What an Android device's bootloader hands the kernel
// (docs/android-images-plan.md I2): the kernel of boot, the vendor ramdisk,
// init_boot's generic ramdisk and bootconfig (the vendor_boot's own and the
// device model's) as the initrd, and the kernel command line. The same for
// tools/a64_android.mjs and for v64's bootloader reading the disk.

import { concat } from "./bytes.js";
import { parse_boot_image, parse_vendor_boot_image } from "./bootimg.js";
import { parse_bootconfig, append_bootconfig } from "./bootconfig.js";
import { vbmeta_digest } from "./avb.js";
import { device_bootconfig } from "./devices.js";

/**
 * @param {function(string): !Uint8Array} read_partition a partition by
 *     its name without the slot (boot, vbmeta, vbmeta_system, ...), the
 *     device's slot's
 * @param {!Object} device devices.js's
 * @param {{memory_mb: number, selinux: (string|undefined), page_size: (number|undefined), gpu_mode: (string|undefined),
 *     vendor_ramdisk: (Uint8Array|undefined), extra_ramdisk: (Uint8Array|undefined)}} options
 *     vendor_ramdisk: in place of the vendor_boot's (Cuttlefish's debug
 *     one); extra_ramdisk: after it (the 16K modules)
 * @return {{kernel: !Uint8Array, initrd: !Uint8Array, cmdline: string, bootconfig: !Map<string, string>,
 *     vbmeta: {digest: string, size: number, chained: !Array<string>}, boot: !Object, vendor_boot: !Object}}
 */
export function android_boot(read_partition, device, options)
{
    const boot = parse_boot_image(read_partition("boot"));
    const init_boot = parse_boot_image(read_partition("init_boot"));
    const vendor_boot = parse_vendor_boot_image(read_partition("vendor_boot"));
    const vbmeta = vbmeta_digest(read_partition);
    const bootconfig = parse_bootconfig(vendor_boot.bootconfig);
    const launcher = device_bootconfig(device, { vbmeta, memory_mb: options.memory_mb, selinux: options.selinux, page_size: options.page_size,
        gpu_mode: options.gpu_mode });
    for(const [key, value] of launcher) bootconfig.set(key, value);
    const ramdisk = concat([options.vendor_ramdisk || vendor_boot.ramdisk, options.extra_ramdisk || new Uint8Array(0), init_boot.ramdisk]);
    const cmdline = [vendor_boot.cmdline, boot.cmdline, device.cmdline_tail].filter(Boolean).join(" ");
    return { kernel: boot.kernel, initrd: append_bootconfig(ramdisk, bootconfig), cmdline, bootconfig, vbmeta, boot, vendor_boot };
}
