import { GraphicsMachine, register_graphics_adapter } from "../machine.js";
import { NVDevice } from "./nv_device.js";

register_graphics_adapter({
    "name": "geforce_6800",
    "pci_vendor": 0x10DE,
    "pci_device": 0x0045,
    "vga_bios": "bios/vgabios-geforce6800.bin",
    "create": (handle, options) =>
    {
        const device = new NVDevice(new GraphicsMachine(handle), { vram_size: options["vram_size"] });
        return {
            "vga": device.vga,
            "nv": device,
            "get_state": () => device.get_state(),
            "set_state": state => device.set_state(state),
            "reset": () => device.reset(),
            "nvlog": enabled => { device.trace.enabled = !!enabled; },
            "nvtrace": () => device.trace.report(),
        };
    },
});
