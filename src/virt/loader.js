// Loading Linux (or a bare-metal program) on the virt machine
// (docs/arm64-virt-android16-plan.md P4.6): an arm64 Image (the boot
// protocol of Documentation/arch/arm64/booting.rst) goes where QEMU puts it,
// RAM + text_offset (0x80000 when image_size is 0, 2 MiB added below 4
// KiB), and the core starts at its first byte with x0 the device tree's
// address. EFI zboot images (gzip) are unpacked first (P4.6).

import { VIRT_RAM_BASE } from "./platform.js";

const IMAGE_MAGIC = 0x644D5241; // "ARM\x64" at 56
const DEFAULT_TEXT_OFFSET = 0x80000;

/**
 * Where an arm64 Image goes in RAM (its offset from RAM's base)
 * @param {!Uint8Array} image
 * @return {number}
 */
export function image_load_offset(image)
{
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if(image.length < 64 || view.getUint32(56, true) !== IMAGE_MAGIC)
    {
        if(image.length >= 2 && image[0] === 0x4D && image[1] === 0x5A && view.getUint32(4, true) === 0x676D697A)
        {
            throw new Error("kernel: an EFI zboot image; unpack it to its Image first (docs/arm64-virt-android16-plan.md P4.6)");
        }
        // (a raw binary: where QEMU loads one that is not an Image)
        return DEFAULT_TEXT_OFFSET;
    }
    const text_offset = view.getUint32(8, true) + view.getUint32(12, true) * 0x100000000;
    const image_size = view.getUint32(16, true) + view.getUint32(20, true) * 0x100000000;
    let offset = image_size ? text_offset : DEFAULT_TEXT_OFFSET;
    if(offset < 4096) offset += 2 * 1024 * 1024;
    return offset;
}

/**
 * Load `kernel` into the CPU's RAM; the core boots it
 * @param {Object} cpu the arm64 CPU (src/arm/cpu.js)
 * @param {!ArrayBuffer} kernel
 * @return {number} the entry point (a physical address)
 */
export function load_kernel(cpu, kernel)
{
    const image = new Uint8Array(kernel);
    const offset = image_load_offset(image);
    if(offset + image.length > cpu.memory_size[0])
    {
        throw new Error("kernel: " + image.length + " bytes at RAM + 0x" + offset.toString(16) + " do not fit in RAM");
    }
    const entry = VIRT_RAM_BASE + offset;
    cpu.write_blob_physical(image, entry);
    return entry;
}
