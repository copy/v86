// @ts-check
// The settings dialog's Android panel (docs/android-images-plan.md I4.2):
// v64's bootloader (the device model, the GPU mode, the vendor ramdisk and
// the debug one's file, SELinux), the display's size, and wiping the user data of the machine's
// browser disk (Android formats userdata and metadata again at its next boot).

import { h, confirm } from "../dom.js";
import { image_picker } from "../image_picker.js";
import { select_field } from "./system.js";
import { ANDROID_DEVICES, ANDROID_GPU_MODES, ANDROID_VENDOR_RAMDISKS, ANDROID_SELINUX, ANDROID_DISPLAYS } from "../../vm_config.js";
import { ANDROID_DEVICES as MODELS } from "../../../android/bootloader.js";
import { wipe_android_data } from "../../android_import.js";
import { disk_id } from "../../browser_disks.js";

/** @typedef {import("../settings.js").PanelContext} PanelContext */

const DEVICES = { cf_arm64_only_phone: "Cuttlefish arm64-only phone (aosp_cf_arm64_only_phone)",
    ranchu_25_armeabi_v7a: "Android Emulator image: Android 7.1 (API 25, armeabi-v7a)" };
const GPU = {
    swiftshader: "SwiftShader: the CPU draws (Android starts; its desktop needs a GPU)",
    venus: "Venus: the disk's own Venus driver (tools/a64_android.mjs puts it in odm), drawn by the graphics proxy",
    gfxstream: "gfxstream: the image's own drivers (official images), drawn by the graphics proxy",
};
const RAMDISKS = {
    release: "The device's own (release: adb asks on the screen)",
    debug: "Cuttlefish's debug ramdisk (adb without asking, root; only with a system of the same release)",
};

/** @param {PanelContext} ctx */
export function android_panel(ctx)
{
    const a = /** @type {import("../../vm_config.js").Android} */ (ctx.config.android);
    const set = (name, value) => ctx.edit(next => { /** @type {any} */ (next.android)[name] = value; });
    const disk = ctx.config.disks.find(d => d.slot === "hda");
    const browser_disk = disk && disk.image.kind === "browser" ? disk.image.path : "";
    // (an emulator image: the ranchu machine's; its disk's partitions are the emulator's disks)
    const emulator = MODELS[a.device] && MODELS[a.device].machine === "ranchu";
    const models = ANDROID_DEVICES.filter(id => MODELS[id].machine === ctx.config.machine.type && MODELS[id].cpu === ctx.config.cpu.type);
    const status = h("small.reason", { role: "status" });
    const wipe = /** @type {HTMLButtonElement} */ (h("button", { type: "button", disabled: !browser_disk || emulator,
        title: emulator ? "An emulator image's user data is its userdata.img: import the image again" :
            browser_disk ? "" : "Only a browser disk's user data can be wiped here" }, "Wipe user data…"));
    wipe.addEventListener("click", async () =>
    {
        if(!await confirm("Wipe user data?", "This machine's apps, settings and files are deleted; Android sets itself up again at its next boot.", "Wipe", true)) return;
        wipe.disabled = true;
        status.textContent = "Wiping…";
        try
        {
            const wiped = await wipe_android_data(disk_id(browser_disk));
            status.textContent = "Wiped: " + wiped.join(", ") + ". Android formats them at its next boot.";
        }
        catch(e)
        {
            status.textContent = "Not wiped: " + e.message;
        }
        wipe.disabled = false;
    });
    if(emulator)
    {
        return [
            h("p.note", null, "v64 boots the emulator image from the first hard disk: its kernel and ramdisk partitions, the emulator's command line; " +
                "its system, cache and userdata partitions are the machine's virtio disks. The guest draws (no host GPU)."),
            select_field("Device model", models, a.device, value => set("device", value), v => DEVICES[v] || v),
            h("div.field", null, wipe, " ", status),
        ];
    }
    return [
        h("p.note", null, "v64 boots Android from the first hard disk: the kernel, initrd and command line come from its boot partitions."),
        select_field("Device model", models, a.device, value => set("device", value), v => DEVICES[v] || v),
        // (a GPU mode other than SwiftShader is the display's Vulkan: chosen there)
        select_field("GPU", ANDROID_GPU_MODES.filter(v => v === "swiftshader" || v === ctx.config.display.vulkan || v === a.gpu_mode), a.gpu_mode,
            value => set("gpu_mode", value), v => GPU[v] || v,
            ctx.config.display.vulkan !== "none" ? {} : { disabled: a.gpu_mode === "swiftshader", title: "Venus and gfxstream need the display's Vulkan (Display: Vulkan)" }),
        select_field("Vendor ramdisk", ANDROID_VENDOR_RAMDISKS, a.vendor_ramdisk, value => set("vendor_ramdisk", value), v => RAMDISKS[v] || v),
        a.vendor_ramdisk === "debug" ? image_picker({ label: "Debug vendor ramdisk (vendor_ramdisk-debug.img, from the build's artifacts on ci.android.com)",
            role: "file", image: a.debug_ramdisk, store: ctx.store, on_change: image => set("debug_ramdisk", image) }) : null,
        select_field("SELinux", ANDROID_SELINUX, a.selinux, value => set("selinux", value),
            v => v === "enforcing" ? "Enforcing" : "Permissive (for debugging; a user build ignores it)"),
        // (the size Android takes at its boot: a phone's, or the window's, which a large window makes slow to draw)
        select_field("Display", ANDROID_DISPLAYS, a.display, value => set("display", value), v => v === "device" ?
            "The device's (" + (MODELS[a.device] && MODELS[a.device].display ? MODELS[a.device].display.width + " × " + MODELS[a.device].display.height : "its own") +
                "), zoomed to the window" : "The window's size, following it (a large window draws slowly)"),
        h("div.field", null, wipe, " ", status),
    ];
}
