// Loading Linux (or a bare-metal program) on the virt machine
// (docs/arm64-virt-android16-plan.md P4.6): an arm64 Image (the boot
// protocol of Documentation/arch/arm64/booting.rst), or an EFI zboot image
// holding one gzipped (Alpine's vmlinuz-virt), goes where the reference
// QEMU 9.2 puts it (hw/arm/boot.c): RAM + text_offset (0x80000 when
// image_size is 0, 2 MiB more below 4 KiB); the initrd at RAM + min(RAM / 2,
// 128 MiB), or above the kernel; the device tree after the initrd, 2 MiB
// aligned (some kernels map its 2 MiB block early). The core starts at the
// kernel's first byte with x0 the device tree's address. A kernel built for
// 16 or 64 KiB pages needs those granules (profiles v1.1 and v2, the
// default; v1 declares the 4 KiB granule only). A 32-bit kernel (cpu_type
// "arm32": a zImage, or a raw binary) goes where QEMU puts one, RAM +
// 0x10000, the device tree after the initrd 4 KiB aligned; the core starts
// in SVC mode with r0 0, r1 ~0 and r2 the device tree.

import { VIRT_RAM_BASE } from "./platform.js";
import { gunzip } from "./inflate.js";
import { flatten, virt_tree } from "./dtb.js";
import { ranchu_dtb } from "./ranchu.js";

const IMAGE_MAGIC = 0x644D5241; // "ARM\x64" at 56
const ZBOOT_MAGIC = 0x676D697A; // "zimg" at 4
const DEFAULT_TEXT_OFFSET = 0x80000;
/** a 32-bit kernel's place (QEMU's hw/arm/boot.c KERNEL_LOAD_ADDR) */
const ARM32_KERNEL_OFFSET = 0x10000;
const MiB = 1024 * 1024;

/**
 * The Image inside a kernel file: the file itself, or an EFI zboot image's gzipped payload
 * @param {!Uint8Array} kernel
 * @return {!Uint8Array}
 */
export function unpack_kernel(kernel)
{
    const view = new DataView(kernel.buffer, kernel.byteOffset, kernel.byteLength);
    if(kernel.length >= 64 && kernel[0] === 0x4D && kernel[1] === 0x5A && view.getUint32(4, true) === ZBOOT_MAGIC)
    {
        const offset = view.getUint32(8, true), size = view.getUint32(12, true);
        const type = new TextDecoder().decode(kernel.subarray(0x18, 0x38)).replace(/\0.*$/s, "");
        if(type !== "gzip") throw new Error("kernel: EFI zboot with " + type + " compression; only gzip is supported");
        return gunzip(kernel.subarray(offset, offset + size));
    }
    return kernel;
}

/**
 * Where an arm64 Image goes in RAM (its offset from RAM's base), and how far it reaches
 * @param {!Uint8Array} image
 * @return {{offset: number, size: number}}
 */
export function image_placement(image, granules = 1)
{
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if(image.length < 64 || view.getUint32(56, true) !== IMAGE_MAGIC)
    {
        // (a raw binary: where QEMU loads one that is not an Image)
        return { offset: DEFAULT_TEXT_OFFSET, size: image.length };
    }
    // (flags bits 2:1, the kernel's page size: unspecified, 4, 16 or 64 KiB:
    // the profile's granules, `granules` bit 1 16 KiB, bit 2 64 KiB; v1 has the 4 KiB one only)
    const page_size = view.getUint32(24, true) >> 1 & 3;
    if(page_size > 1 && !(granules & (page_size === 2 ? 2 : 4)))
    {
        throw new Error("kernel: built for " + (page_size === 2 ? 16 : 64) + " KiB pages; the CPU profile does not have that granule " +
            "(a64_profile: \"v1.1\" and \"v2\" have 16 and 64 KiB)");
    }
    const text_offset = view.getUint32(8, true) + view.getUint32(12, true) * 0x100000000;
    const image_size = view.getUint32(16, true) + view.getUint32(20, true) * 0x100000000;
    let offset = image_size ? text_offset : DEFAULT_TEXT_OFFSET;
    if(offset < 4096) offset += 2 * MiB;
    return { offset, size: Math.max(image.length, image_size) };
}

/**
 * Load a kernel, an initrd and the device tree into the CPU's RAM
 * @param {Object} cpu the arm64 CPU (src/arm/cpu.js)
 * @param {!Object} boot kernel (an ArrayBuffer), initrd and dtb (ArrayBuffers or undefined), cmdline, cores
 * @return {{entry: number, x0: number}}
 */
export function load_linux(cpu, boot)
{
    const ram_size = cpu.memory_size[0];
    const ram_end = VIRT_RAM_BASE + ram_size;
    const arm32 = cpu.cpu_type === "arm32";
    const image = arm32 ? new Uint8Array(boot.kernel) : unpack_kernel(new Uint8Array(boot.kernel));
    const { offset, size } = arm32 ? { offset: ARM32_KERNEL_OFFSET, size: image.length } :
        image_placement(image, cpu.wm.exports["a64_granules"] ? cpu.wm.exports["a64_granules"]() : 1);
    if(offset + image.length > ram_size)
    {
        throw new Error("kernel: " + image.length + " bytes at RAM + 0x" + offset.toString(16) + " do not fit in RAM");
    }
    const entry = VIRT_RAM_BASE + offset;
    cpu.write_blob_physical(image, entry);

    const page_align = a => Math.ceil(a / 4096) * 4096;
    const initrd_start = page_align(Math.max(VIRT_RAM_BASE + Math.min(ram_size / 2, 128 * MiB), entry + size));
    let initrd;
    if(boot.initrd)
    {
        const bytes = new Uint8Array(boot.initrd);
        if(initrd_start + bytes.length > ram_end) throw new Error("initrd: " + bytes.length + " bytes do not fit in RAM after the kernel");
        cpu.write_blob_physical(bytes, initrd_start);
        initrd = { start: initrd_start, end: initrd_start + bytes.length };
    }
    const dtb_align = arm32 ? 4096 : 2 * MiB;
    const dtb_start = Math.ceil((initrd_start + (initrd ? initrd.end - initrd.start : 0)) / dtb_align) * dtb_align;
    let dtb;
    if(boot.dtb)
    {
        dtb = new Uint8Array(boot.dtb);
    }
    else
    {
        const rng_seed = new Uint8Array(32);
        globalThis.crypto?.getRandomValues?.(rng_seed);
        dtb = cpu.machine_type === "ranchu" ?
            ranchu_dtb({ cores: boot.cores, memory_size: ram_size, bootargs: boot.cmdline || undefined, initrd, arm32,
                framebuffer: cpu.ranchu_framebuffer || undefined }) :
            flatten(virt_tree({
                cores: boot.cores, memory_size: ram_size, bootargs: boot.cmdline || undefined, initrd, rng_seed, arm32,
                extended: cpu.extended_pages ? { base: cpu.extended_base, size: cpu.extended_pages * 4096 } : undefined,
            }));
    }
    if(dtb_start + dtb.length > ram_end) throw new Error("dtb: not enough RAM after the kernel and initrd");
    cpu.write_blob_physical(dtb, dtb_start);
    return { entry, x0: dtb_start };
}
