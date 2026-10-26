// @ts-check
// The settings dialog's panels of the devices (docs/vm-manager-plan.md "设置
// 对话框"): network adapters, sound, display, serial ports, the shared
// folder, the virt machine's devices.

import { h } from "../dom.js";
import { select_field, check_field, number_field, text_field } from "./system.js";
import { VIRT_INPUTS } from "../../vm_model.js";
import { DISPLAY_VULKAN } from "../../vm_config.js";

/** @typedef {import("../settings.js").PanelContext} PanelContext */

const ADAPTER_LABELS = { bochs_vga: "Bochs VGA", vmware_svga: "VMware SVGA II", virtio_gpu: "virtio-gpu", none: "None (serial console only)" };
const VULKAN_LABELS = {
    none: "None",
    venus: "Venus (through the graphics proxy; Android's initrd-venus.img, Linux's Mesa)",
    gfxstream: "gfxstream (through the graphics proxy; Android's official images)",
};
/** The cards' names, also in the hardware list and the summary (describe.js) */
export const NIC_LABELS = { ne2k: "NE2000 (ne2k)", e1000: "Intel PRO/1000 MT (e1000)", virtio: "virtio-net", none: "None" };
const BACKEND_LABELS = { none: "Not connected", inbrowser: "A network in the browser", relay: "A relay (WebSocket)", wisp: "A wisp server", fetch: "fetch (HTTP only)" };
export const SOUND_LABELS = { sb16: "Sound Blaster 16", hd_audio: "HD Audio (Intel)", virtio: "virtio-snd", none: "None" };

/**
 * @param {PanelContext} ctx
 * @param {number} index
 */
export function network_panel(ctx, index)
{
    const n = ctx.config.network[index];
    const at = "network." + index + ".";
    return [
        select_field("Card", ctx.choices.net_devices, n.device, value => ctx.set(at + "device", value), v => NIC_LABELS[v] || v),
        n.device === "none" ? null : [
            select_field("Connected to", ["none", "inbrowser", "relay", "wisp", "fetch"], n.backend, value => ctx.set(at + "backend", value), v => BACKEND_LABELS[v]),
            n.backend === "relay" || n.backend === "wisp" || n.backend === "fetch" ?
                text_field(n.backend === "fetch" ? "CORS proxy (optional)" : n.backend === "wisp" ? "Wisp server" : "Relay", n.relay_url,
                    value => ctx.set(at + "relay_url", value.trim()), { placeholder: n.backend === "fetch" ? "https://…" : n.backend === "wisp" ? "wisps://…" : "wss://…" }) : null,
            n.device === "virtio" ? number_field("MTU", n.mtu, { min: 68, max: 65535 }, value => ctx.set(at + "mtu", value)) : null,
            check_field("Translate MAC addresses (some relays need it)", n.mac_address_translation, value => ctx.set(at + "mac_address_translation", value)),
        ],
        ctx.config.network.length > 1 ? h("p.note", null, "Card " + (index + 1) + " of " + ctx.config.network.length + ": one card reaches the network.") : null,
    ];
}

const USB_LABELS = { uhci: "UHCI (USB 1.1)", ehci: "EHCI (USB 2.0, with UHCI companions)", xhci: "xHCI (USB 3)" };

/** @param {PanelContext} ctx */
export function usb_panel(ctx)
{
    const u = /** @type {{controller: string, tablet: boolean}} */ (ctx.config.usb);
    // (Windows 7 and earlier: no xHCI driver of their own)
    const old_windows = ["windows3x", "windows9x", "windowsnt"].includes(ctx.config.guest) || ctx.config.template === "windows7";
    return [
        select_field("Controller", ctx.choices.usb_controllers, u.controller, value => ctx.set("usb.controller", value), v => USB_LABELS[v] || v),
        u.controller === "xhci" && old_windows ?
            h("p.note", null, "Windows 7 and earlier have no driver of their own for xHCI (Windows 8 and later have): EHCI works with them.") : null,
        check_field("Tablet (an absolute pointer: the guest's cursor follows the page's, no mouse lock)", u.tablet, value => ctx.set("usb.tablet", value)),
        h("p.note", null, "Lock the mouse (Input menu) for relative movement through the PS/2 mouse, as games need."),
    ];
}

/** @param {PanelContext} ctx */
export function sound_panel(ctx)
{
    return [
        select_field("Sound card", ctx.choices.sound_devices, ctx.config.sound.device, value => ctx.set("sound.device", value), v => SOUND_LABELS[v] || v),
        // (None: the guest has no sound card; Mute: it has one, the page plays nothing)
        check_field("Mute (the page plays nothing; the guest keeps its sound card)", ctx.config.sound.mute, value => ctx.set("sound.mute", value)),
    ];
}

/** @param {PanelContext} ctx */
export function display_panel(ctx)
{
    const d = ctx.config.display;
    const sizes = [1, 2, 4, 8, 16, 32, 64, 128, 256].filter(mb => mb <= ctx.choices.max_vram);
    return [
        select_field("Display adapter", ctx.choices.graphics_adapters, d.adapter, value => ctx.set("display.adapter", value), v => ADAPTER_LABELS[v] || v),
        d.vram_mb === null ? h("p.note", null, "Video memory: the saved state's") :
            select_field("Video memory", sizes, d.vram_mb, value => ctx.set("display.vram_mb", value), v => v + " MB"),
        check_field("Graphics proxy (WebGPU: Direct3D and OpenGL of the guest)", d.proxy, value => ctx.set("display.proxy", value)),
        select_field("Vulkan", DISPLAY_VULKAN, d.vulkan, value => ctx.set("display.vulkan", value), v => VULKAN_LABELS[v] || v,
            d.adapter === "virtio_gpu" ? {} : { disabled: true, title: "only virtio-gpu has Vulkan" }),
        select_field("Displays", [1, 2, 3, 4], d.displays, value => ctx.set("display.displays", value), String,
            d.adapter === "virtio_gpu" ? {} : { disabled: true, title: "only virtio-gpu has more than one display" }),
    ];
}

/** @param {PanelContext} ctx */
export function serial_panel(ctx)
{
    const virt = ctx.config.machine.type === "virt" || ctx.config.machine.type === "ranchu";
    const attach = virt ? ["none", "terminal"] : ["none", "terminal", "modem"];
    return [0, 1, 2, 3].map(port =>
    {
        const entry = ctx.config.serial.find(s => s.port === port);
        const value = entry ? entry.attach : "none";
        return select_field("UART" + port + (port === 0 ? " (COM1)" : " (COM" + (port + 1) + ")"), attach, value, next_value => ctx.edit(next =>
        {
            next.serial = next.serial.filter(s => s.port !== port);
            if(next_value === "modem") for(const s of next.serial) if(s.attach === "modem") s.attach = "none";
            if(next_value !== "none") next.serial.push({ port, attach: next_value });
            next.serial.sort((a, b) => a.port - b.port);
        }), v => ({ none: "Not connected", terminal: "The serial terminal", modem: "A modem (Hayes AT commands)" })[v]);
    });
}

/** @param {PanelContext} ctx */
export function shared_folder_panel(ctx)
{
    const fs = /** @type {{baseurl?: string, basefs?: {url: string}}} */ (ctx.config.filesystem);
    return [
        h("p.note", null, "A 9p file system: files sent in and out while the machine runs, or files served from a URL."),
        text_field("Files' base URL (optional)", fs.baseurl || "", value => ctx.edit(next =>
        {
            const f = /** @type {any} */ (next.filesystem);
            if(value.trim()) f.baseurl = value.trim(); else delete f.baseurl;
        })),
        text_field("Its description, fs.json (optional)", fs.basefs ? fs.basefs.url : "", value => ctx.edit(next =>
        {
            const f = /** @type {any} */ (next.filesystem);
            if(value.trim()) f.basefs = { url: value.trim() }; else delete f.basefs;
        })),
    ];
}

/** @param {PanelContext} ctx */
export function virt_panel(ctx)
{
    const v = ctx.config.virt;
    const automatic = v.input === null;
    return [
        select_field("virtio transport", ["mmio", "pci"], v.transport, value => ctx.edit(next =>
        {
            next.virt.transport = value;
            if(value !== "pci") next.virt.gpu_pci_slot = null;
        }), t => t === "mmio" ? "MMIO (the default)" : "PCI Express"),
        check_field("Input devices as the display has them (virtio-gpu: keyboard, tablet, touch screen)", automatic,
            value => ctx.edit(next => { next.virt.input = value ? null : VIRT_INPUTS.slice(); })),
        automatic ? null : VIRT_INPUTS.map(kind => check_field(kind, /** @type {string[]} */ (v.input).includes(kind), value => ctx.edit(next =>
        {
            const list = /** @type {string[]} */ (next.virt.input).filter(k => k !== kind);
            if(value) list.push(kind);
            next.virt.input = VIRT_INPUTS.filter(k => list.includes(k));
        }))),
        number_field("virtio console ports (0: none)", v.console_ports, { min: 0, max: 30 }, value => ctx.set("virt.console_ports", value)),
        check_field("vsock", v.vsock, value => ctx.set("virt.vsock", value)),
        v.transport === "pci" && ctx.config.display.adapter === "virtio_gpu" ?
            select_field("virtio-gpu's PCI slot", [null, 1, 2, 3, 4], v.gpu_pci_slot, value => ctx.set("virt.gpu_pci_slot", value), s => s === null ? "Any" : "00:0" + s + ".0") : null,
    ];
}
