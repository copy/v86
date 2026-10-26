// @ts-check
// The settings dialog's panels of the drives (docs/vm-manager-plan.md "设置
// 对话框"): hard disks (their source, disk_option, disk_error, bus), USB
// disks, the CD/DVD drive, floppy drives, direct boot (kernel, initrd,
// multiboot).

import { h } from "../dom.js";
import { image_picker } from "../image_picker.js";
import { select_field, check_field, text_field } from "./system.js";

/** @typedef {import("../settings.js").PanelContext} PanelContext */

/**
 * The bus a hard disk is on
 * @param {string} machine
 */
function bus(machine)
{
    return machine === "q35" ? "AHCI (SATA)" : machine === "virt" || machine === "ranchu" ? "virtio-blk" : "IDE";
}

/**
 * Why a disk cannot be written back, or ""
 * @param {import("../../vm_config.js").Image | null} image
 */
function read_write_problem(image)
{
    if(!image) return "no image";
    if(image.kind === "file") return "a file chosen on this computer can only be read: use the disk service to write one back";
    if(image.kind === "empty") return "an empty disk in memory has nothing to write back to";
    if(image.kind === "url" && (image.use_parts || /\.zst$/.test(image.url))) return "an image in parts can only be read";
    return "";
}

/**
 * @param {PanelContext} ctx
 * @param {number} index
 */
export function disk_panel(ctx, index)
{
    const disk = ctx.config.disks[index];
    const problem = read_write_problem(disk.image);
    const where = disk.image && disk.image.kind === "url" ? (ctx.service && disk.image.url.startsWith(ctx.service.url) ? "the disk service's image" : "the image at its URL") :
        disk.image && disk.image.kind === "browser" ? "the browser disk" : "nowhere: the disk's source cannot be written";
    return [
        select_field("Drive", ["hda", "hdb"], disk.slot, value => ctx.edit(next => { next.disks[index].slot = value; }),
            v => v === "hda" ? "First hard disk (hda)" : "Second hard disk (hdb)"),
        h("p.note", null, "Bus: " + bus(ctx.config.machine.type)),
        image_picker({ label: "Source", role: "disk", image: disk.image, store: ctx.store, service: ctx.service, machine_name: ctx.config.name,
            on_change: (image, extra) => ctx.edit(next =>
            {
                next.disks[index].image = image;
                if(extra && extra.read_write) next.disks[index].disk_option = "read_write";
                if(read_write_problem(image)) next.disks[index].disk_option = "read_only";
            }) }),
        select_field("The guest's changes", ["read_only", "read_write"], disk.disk_option, value => ctx.set("disks." + index + ".disk_option", value),
            v => v === "read_only" ? "Kept in memory, the image unchanged (read only)" : "Written back to " + where + " (read write)",
            problem ? { disabled: true, title: problem } : {}),
        select_field("When a read or write fails", ["stop", "report"], disk.disk_error, value => ctx.set("disks." + index + ".disk_error", value),
            v => v === "stop" ? "Pause the machine and ask (retry or power off)" : "Report it to the guest"),
    ];
}

/**
 * A USB disk (usb.disks[index]): a disk image as a USB stick, its source as
 * a hard disk's
 * @param {PanelContext} ctx
 * @param {number} index
 */
export function usb_disk_panel(ctx, index)
{
    const usb = /** @type {{tablet: boolean, disks: import("../../vm_config.js").UsbDisk[]}} */ (ctx.config.usb);
    const disk = usb.disks[index];
    const path = "usb.disks." + index;
    const problem = read_write_problem(disk.image);
    return [
        h("p.note", null, "A disk image as a USB stick (mass storage, in a port of the USB controller): the guest mounts it as a removable disk. " +
            "While the machine runs, the Devices menu unplugs it or plugs in another."),
        image_picker({ label: "Source", role: "disk", image: disk.image, store: ctx.store, service: ctx.service, machine_name: ctx.config.name,
            on_change: (image, extra) => ctx.edit(next =>
            {
                const d = /** @type {any} */ (next.usb).disks[index];
                d.image = image;
                if(extra && extra.read_write) d.disk_option = "read_write";
                if(read_write_problem(image)) d.disk_option = "read_only";
            }) }),
        select_field("The guest's changes", ["read_only", "read_write"], disk.disk_option, value => ctx.set(path + ".disk_option", value),
            v => v === "read_only" ? "Kept in memory, the image unchanged (read only)" : "Written back to the image (read write)",
            problem ? { disabled: true, title: problem } : {}),
        check_field("Write protected (the guest can only read it)", disk.write_protected, value => ctx.set(path + ".write_protected", value)),
        select_field("When a read or write fails", ["stop", "report"], disk.disk_error, value => ctx.set(path + ".disk_error", value),
            v => v === "stop" ? "Pause the machine and ask (retry or power off)" : "Report it to the guest"),
    ];
}

/** @param {PanelContext} ctx */
export function cdrom_panel(ctx)
{
    const virt = ctx.config.machine.type === "virt" || ctx.config.machine.type === "ranchu";
    return [
        image_picker({ label: "Disc", role: "cdrom", optional: true, image: ctx.config.cdrom.image, store: ctx.store, service: ctx.service,
            on_change: image => ctx.set("cdrom.image", image) }),
        virt ? h("p.note", null, "On the " + ctx.config.machine.type + " machine the disc is a read-only virtio disk.") : null,
        select_field("When a read fails", ["stop", "report"], ctx.config.cdrom.disk_error, value => ctx.set("cdrom.disk_error", value),
            v => v === "stop" ? "Pause the machine and ask" : "Report it to the guest"),
    ];
}

/**
 * @param {PanelContext} ctx
 * @param {number} index
 */
export function floppy_panel(ctx, index)
{
    const floppy = ctx.config.floppies[index];
    const problem = floppy.image ? read_write_problem(floppy.image) : "no image";
    return [
        select_field("Drive", ["fda", "fdb"], floppy.slot, value => ctx.edit(next => { next.floppies[index].slot = value; }),
            v => v === "fda" ? "A:" : "B:"),
        image_picker({ label: "Floppy", role: "floppy", optional: true, image: floppy.image, store: ctx.store, service: ctx.service,
            on_change: (image, extra) => ctx.edit(next =>
            {
                next.floppies[index].image = image;
                if(extra && extra.read_write) next.floppies[index].disk_option = "read_write";
                if(!image || read_write_problem(image)) next.floppies[index].disk_option = "read_only";
            }) }),
        select_field("The guest's changes", ["read_only", "read_write"], floppy.disk_option, value => ctx.set("floppies." + index + ".disk_option", value),
            v => v === "read_only" ? "Kept in memory (read only)" : "Written back (read write)", problem ? { disabled: true, title: problem } : {}),
    ];
}

/** @param {PanelContext} ctx */
export function direct_boot_panel(ctx)
{
    const k = /** @type {NonNullable<import("../../vm_config.js").VMConfig["kernel"]>} */ (ctx.config.kernel);
    const virt = ctx.config.machine.type === "virt" || ctx.config.machine.type === "ranchu";
    const set = (name, value) => ctx.edit(next => { /** @type {any} */ (next.kernel)[name] = value; });
    return [
        image_picker({ label: virt ? "Kernel (Image, or a gzipped vmlinuz)" : "Kernel (bzImage)", role: "file", optional: true, image: k.bzimage, store: ctx.store,
            on_change: image => set("bzimage", image) }),
        image_picker({ label: "Initrd", role: "file", optional: true, image: k.initrd, store: ctx.store, on_change: image => set("initrd", image) }),
        text_field("Command line", k.cmdline || "", value => set("cmdline", value.trim() || null),
            { placeholder: virt ? "console=ttyAMA0 console=tty0 … (the default)" : "" }),
        virt ? null : image_picker({ label: "Multiboot kernel", role: "file", optional: true, image: k.multiboot, store: ctx.store,
            on_change: image => set("multiboot", image) }),
        check_field("The kernel and initrd from the shared folder (/boot)", k.from_filesystem, value => set("from_filesystem", value)),
    ];
}
