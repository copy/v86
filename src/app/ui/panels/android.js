// @ts-check
// The settings dialog's Android panel (docs/android-images-plan.md I4.2):
// v64's bootloader (the device model, the GPU mode, the vendor ramdisk and
// the debug one's file, SELinux) and wiping the user data of the machine's
// browser disk (Android formats userdata and metadata again at its next boot).

import { h, confirm } from "../dom.js";
import { image_picker } from "../image_picker.js";
import { select_field } from "./system.js";
import { ANDROID_DEVICES, ANDROID_GPU_MODES, ANDROID_VENDOR_RAMDISKS, ANDROID_SELINUX } from "../../vm_config.js";
import { wipe_android_data } from "../../android_import.js";
import { disk_id } from "../../browser_disks.js";

/** @typedef {import("../settings.js").PanelContext} PanelContext */

const DEVICES = { cf_arm64_only_phone: "Cuttlefish arm64-only phone (aosp_cf_arm64_only_phone)" };
const GPU = {
    swiftshader: "SwiftShader: the CPU draws (Android starts; its desktop needs gfxstream, docs/gfxstream-plan.md)",
    venus: "Venus: the disk's own Venus driver (tools/a64_android.mjs puts it in odm), drawn by the graphics proxy",
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
    const status = h("small.reason", { role: "status" });
    const wipe = /** @type {HTMLButtonElement} */ (h("button", { type: "button", disabled: !browser_disk,
        title: browser_disk ? "" : "Only a browser disk's user data can be wiped here" }, "Wipe user data…"));
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
    return [
        h("p.note", null, "v64 boots Android from the first hard disk: the kernel, initrd and command line come from its boot partitions."),
        select_field("Device model", ANDROID_DEVICES, a.device, value => set("device", value), v => DEVICES[v] || v),
        select_field("GPU", ANDROID_GPU_MODES, a.gpu_mode, value => set("gpu_mode", value), v => GPU[v] || v,
            ctx.config.display.vulkan ? {} : { disabled: a.gpu_mode === "swiftshader", title: "Venus needs Vulkan (Display: Vulkan)" }),
        select_field("Vendor ramdisk", ANDROID_VENDOR_RAMDISKS, a.vendor_ramdisk, value => set("vendor_ramdisk", value), v => RAMDISKS[v] || v),
        a.vendor_ramdisk === "debug" ? image_picker({ label: "Debug vendor ramdisk (vendor_ramdisk-debug.img, from the build's artifacts on ci.android.com)",
            role: "file", image: a.debug_ramdisk, store: ctx.store, on_change: image => set("debug_ramdisk", image) }) : null,
        select_field("SELinux", ANDROID_SELINUX, a.selinux, value => set("selinux", value),
            v => v === "enforcing" ? "Enforcing" : "Permissive (for debugging; a user build ignores it)"),
        h("div.field", null, wipe, " ", status),
    ];
}
