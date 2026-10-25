// graphics_adapter: "virtio_gpu" -- virtio-gpu as virtio-vga (1AF4:1050).
// Built into build/v86-virtio-gpu.js; from the source tree,
// src/graphics_adapter.js imports this file directly.

import { GraphicsMachine, register_graphics_adapter } from "../machine.js";
import { VirtioGPU, host_visible_size } from "./virtio_gpu_device.js";

register_graphics_adapter({
    "name": "virtio_gpu",
    // The VGA BIOS's PCI ROM header must name the device (SeaBIOS checks it)
    "pci_vendor": 0x1AF4,
    "pci_device": 0x1050,
    // the device memory a pinned level's host visible memory needs (0: the
    // machine's own amount; the ARM core reserves it after RAM)
    "device_memory_size": options => host_visible_size((options["test"] || {})["level"] || ""),
    "create": (handle, options) =>
    {
        const test = options["test"] || {};
        const device = new VirtioGPU(new GraphicsMachine(handle), {
            vram_size: options["vram_size"],
            // without it, the highest level there is
            level: test["level"],
            // how many displays the guest gets (tests; 1 otherwise)
            scanouts: test["scanouts"],
            // the channel to GX (the page's; tests bring their own): 3D
            renderer: options["renderer"] || test["renderer"],
        });
        return {
            // (none on a machine without VGA)
            "vga": device.has_vga ? device.vga : null,
            "virtio_gpu": device,
            "get_state": () => device.get_state(),
            "set_state": state => device.set_state(state),
            "reset": () => device.reset(),
            // what the GPU has of the guest's 3D (a snapshot reads it back first)
            "has_host_state": () => !!device.virgl,
            "prepare_save": () => device.prepare_save(),
        };
    },
});
