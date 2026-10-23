// Android boot images (system/tools/mkbootimg's boot_image.h): boot.img and
// init_boot.img (header version 3 or 4) and vendor_boot.img (version 4), as
// a bootloader reads them (docs/android-images-plan.md I1, I2).

import { u32, latin1, c_string } from "./bytes.js";

/**
 * boot.img and init_boot.img, header version 3 or 4: kernel and ramdisk
 * (pages of 4096)
 * @param {!Uint8Array} bytes
 * @return {{version: number, kernel: !Uint8Array, ramdisk: !Uint8Array, os_version: number, cmdline: string}}
 */
export function parse_boot_image(bytes)
{
    if(latin1(bytes, 0, 8) !== "ANDROID!") throw new Error("not a boot image");
    const version = u32(bytes, 40);
    if(version < 3) throw new Error("boot image header version " + version);
    const kernel_size = u32(bytes, 8), ramdisk_size = u32(bytes, 12);
    const page = 4096, align = x => Math.ceil(x / page) * page;
    const kernel = bytes.subarray(page, page + kernel_size);
    const ramdisk_offset = page + align(kernel_size);
    return { version, kernel, ramdisk: bytes.subarray(ramdisk_offset, ramdisk_offset + ramdisk_size),
        os_version: u32(bytes, 16), cmdline: c_string(bytes, 44, 1536) };
}

/**
 * vendor_boot.img, header version 4: vendor ramdisks, cmdline, bootconfig
 * @param {!Uint8Array} bytes
 * @return {{cmdline: string, ramdisks: !Array<{type: number, name: string, bytes: !Uint8Array}>, ramdisk: !Uint8Array, bootconfig: string}}
 */
export function parse_vendor_boot_image(bytes)
{
    if(latin1(bytes, 0, 8) !== "VNDRBOOT") throw new Error("not a vendor boot image");
    const version = u32(bytes, 8);
    if(version !== 4) throw new Error("vendor boot image header version " + version);
    const page = u32(bytes, 12), align = x => Math.ceil(x / page) * page;
    const header_size = u32(bytes, 2096), ramdisk_size = u32(bytes, 24), dtb_size = u32(bytes, 2100);
    const table_size = u32(bytes, 2112), table_entries = u32(bytes, 2116), entry_size = u32(bytes, 2120);
    const bootconfig_size = u32(bytes, 2124);
    const ramdisk_offset = align(header_size);
    const table_offset = ramdisk_offset + align(ramdisk_size) + align(dtb_size);
    const bootconfig_offset = table_offset + align(table_size);
    const ramdisks = [];
    for(let i = 0; i < table_entries; i++)
    {
        const entry = table_offset + i * entry_size;
        const size = u32(bytes, entry), offset = u32(bytes, entry + 4);
        ramdisks.push({ type: u32(bytes, entry + 8), name: c_string(bytes, entry + 12, 32),
            bytes: bytes.subarray(ramdisk_offset + offset, ramdisk_offset + offset + size) });
    }
    return { cmdline: c_string(bytes, 28, 2048), ramdisks, ramdisk: bytes.subarray(ramdisk_offset, ramdisk_offset + ramdisk_size),
        bootconfig: latin1(bytes, bootconfig_offset, bootconfig_offset + bootconfig_size) };
}
