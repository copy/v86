// @ts-check
// A configuration for people (docs/vm-manager-plan.md): where an image is,
// and the hardware table of the library's summary and the settings list.

import { format_size } from "./dom.js";
import { NIC_LABELS, SOUND_LABELS } from "./panels/devices.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Image} Image */

const MACHINES = { i440fx: "i440FX (IDE)", q35: "Q35 (AHCI, PCI Express)", virt: "virt (arm64)" };
const ADAPTERS = { bochs_vga: "Bochs VGA", vmware_svga: "VMware SVGA II", virtio_gpu: "virtio-gpu", none: "None (serial console only)" };
const BACKENDS = { none: "no network", inbrowser: "in the browser", relay: "relay", wisp: "wisp", fetch: "fetch" };

/**
 * Where an image is, for people
 * @param {Image | null} image
 * @return {string}
 */
export function describe_image(image)
{
    if(!image) return "none";
    switch(image.kind)
    {
        case "url": return image.url + (image.size ? " (" + format_size(image.size) + ")" : "");
        case "file": return "file on this computer: " + image.name + " (" + format_size(image.size) + ")" + (image.handle ? "" : ", to be chosen again");
        case "empty": return "empty disk in memory, " + format_size(image.size) + " (lost at power off)";
        case "browser": return "browser disk, " + format_size(image.size);
    }
    return "?";
}

/**
 * The hardware of a configuration, a row each (the settings dialog's list in U3)
 * @param {VMConfig} c
 * @return {Array<[string, string]>}
 */
export function hardware_rows(c)
{
    /** @type {Array<[string, string]>} */
    const rows = [
        ["Memory", c.memory.mb + " MB"],
        ["Processor", c.cpu.type + ", " + c.cpu.cores + (c.cpu.cores === 1 ? " core" : " cores") + (c.cpu.cores > 1 && c.cpu.parallel ? " in parallel" : "") +
            (c.cpu.jit ? "" : ", no JIT")],
        ["Machine", (MACHINES[c.machine.type] || c.machine.type) + (c.machine.acpi ? ", ACPI" : "") + (c.machine.firmware === "uefi" ? ", UEFI" : "") +
            (c.machine.firmware === "uefi" && c.machine.secure_boot ? ", Secure Boot" : "")],
    ];
    for(const disk of c.disks)
    {
        rows.push(["Hard disk (" + disk.slot + ")", describe_image(disk.image) + (disk.disk_option === "read_write" ? ", read write" : ", read only")]);
    }
    if(c.cdrom.image) rows.push(["CD/DVD", describe_image(c.cdrom.image)]);
    for(const floppy of c.floppies) if(floppy.image) rows.push(["Floppy (" + floppy.slot + ")", describe_image(floppy.image)]);
    if(c.kernel)
    {
        rows.push(["Direct boot", [c.kernel.bzimage && "kernel " + describe_image(c.kernel.bzimage), c.kernel.initrd && "initrd " + describe_image(c.kernel.initrd),
            c.kernel.multiboot && "multiboot " + describe_image(c.kernel.multiboot), c.kernel.cmdline && "command line " + c.kernel.cmdline,
            c.kernel.from_filesystem && "kernel and initrd from the shared folder"].filter(Boolean).join("; ")]);
    }
    if(c.android)
    {
        // (docs/android-images-plan.md I2: the kernel and initrd from the disk's boot partitions)
        // (an emulator image's: its GLES drawn by the host's GPU, or the guest draws)
        rows.push(["Android boot", "from the first disk (" + c.android.device + "), " + (/^ranchu_/.test(c.android.device) ?
            "the emulator's disks, " + (c.android.gpu_mode === "host" ? "the host's GPU draws GLES " + c.android.gles_version : "the guest draws") :
            { venus: "Venus", gfxstream: "gfxstream" }[c.android.gpu_mode] || "SwiftShader") +
            (c.android.vendor_ramdisk === "debug" ? ", debug vendor ramdisk " + (c.android.debug_ramdisk ? describe_image(c.android.debug_ramdisk) : "(not chosen)") : "") +
            (c.android.selinux === "permissive" ? ", SELinux permissive" : "")]);
    }
    if(c.initial_state) rows.push(["Starts from a state", describe_image(c.initial_state)]);
    rows.push(["Display", (ADAPTERS[c.display.adapter] || c.display.adapter) + (c.display.vram_mb ? ", " + c.display.vram_mb + " MB" : "") +
        (c.display.displays > 1 ? ", " + c.display.displays + " displays" : "") + ({ venus: ", Vulkan (Venus)", gfxstream: ", Vulkan (gfxstream)" }[c.display.vulkan] || "")]);
    for(const network of c.network)
    {
        rows.push(["Network", network.device === "none" ? "none" : (NIC_LABELS[network.device] || network.device) + ", " + (BACKENDS[network.backend] || network.backend) +
            (network.relay_url ? " " + network.relay_url : "")]);
    }
    rows.push(["Sound", (c.sound.device === "none" ? "none" : SOUND_LABELS[c.sound.device] || c.sound.device) + (c.sound.mute ? ", muted" : "")]);
    if(c.usb) rows.push(["USB", c.usb.controller.toUpperCase() + (c.usb.tablet ? ", tablet" : "")]);
    if(c.tpm) rows.push(["TPM", "TPM 2.0 (CRB)"]);
    for(const disk of c.usb ? c.usb.disks : [])
    {
        rows.push(["USB disk (" + disk.id + ")", describe_image(disk.image) + (disk.disk_option === "read_write" ? ", read write" : ", read only") +
            (disk.write_protected ? ", write protected" : "")]);
    }
    for(const serial of c.serial) if(serial.attach !== "none") rows.push(["UART" + serial.port, serial.attach]);
    if(c.filesystem) rows.push(["Shared folder", c.filesystem.baseurl || "in the browser"]);
    return rows;
}
