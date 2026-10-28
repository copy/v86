// @ts-check
// The settings dialog (docs/vm-manager-plan.md "设置对话框", U3): the
// hardware list on the left, the chosen item's panel on the right, Add and
// Remove under the list. Every control offers only what the machine allows
// (src/app/vm_model.js) and a change says what else it changed; before
// saving, the whole configuration is checked (check_config) and each
// problem shows on its item's panel.

import { h, replace } from "./dom.js";
import { choices, change, fitted } from "../vm_model.js";
import { check_config } from "../vm_config.js";
import { describe_image } from "./describe.js";
import { general_panel, memory_panel, processor_panel, machine_panel, advanced_panel, CPU_LABELS, MACHINE_LABELS } from "./panels/system.js";
import { disk_panel, usb_disk_panel, cdrom_panel, floppy_panel, direct_boot_panel } from "./panels/storage.js";
import { network_panel, sound_panel, usb_panel, tpm_panel, display_panel, serial_panel, shared_folder_panel, virt_panel, NIC_LABELS, SOUND_LABELS } from "./panels/devices.js";
import { android_panel } from "./panels/android.js";
import { ANDROID_DEFAULTS } from "../vm_config.js";
import { RANCHU_DEVICES } from "../../android/devices.js";
import { USB_PORTS } from "../../machine_options.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Problem} Problem */

/**
 * @typedef {Object} PanelContext
 * @property {VMConfig} config the configuration being edited
 * @property {ReturnType<typeof choices>} choices what its controls may hold
 * @property {(path: string, value: any) => void} set a field changed (vm_model's change: what it implies too)
 * @property {(fn: (next: VMConfig) => void) => void} edit a change of several fields, then fitted to the machine
 * @property {{put_handle: (handle: any) => Promise<string>}} store where picked files' handles go
 * @property {import("../disk_service_client.js").Service | null} service the disk service, if there is one
 */

/**
 * @typedef {Object} Item
 * @property {string} id
 * @property {string} label
 * @property {string} summary
 * @property {(ctx: PanelContext) => any} panel
 * @property {((next: VMConfig) => void) | null} remove
 */

/**
 * The hardware list of a configuration
 * @param {VMConfig} c
 * @return {Item[]}
 */
export function hardware_items(c)
{
    const virt = c.machine.type === "virt";
    /** @type {Item[]} */
    const items = [
        { id: "general", label: "General", summary: c.name, panel: general_panel, remove: null },
        { id: "memory", label: "Memory", summary: c.memory.mb + " MB", panel: memory_panel, remove: null },
        { id: "processor", label: "Processor", summary: c.cpu.type + ", " + c.cpu.cores + (c.cpu.cores === 1 ? " core" : " cores"), panel: processor_panel, remove: null },
        { id: "machine", label: "Machine and firmware", summary: MACHINE_LABELS[c.machine.type] || c.machine.type, panel: machine_panel, remove: null },
    ];
    c.disks.forEach((disk, i) => items.push({
        id: "disk-" + i, label: "Hard disk (" + disk.slot + ")", summary: describe_image(disk.image), panel: ctx => disk_panel(ctx, i),
        remove: next => { next.disks.splice(i, 1); },
    }));
    items.push({ id: "cdrom", label: "CD/DVD", summary: describe_image(c.cdrom.image), panel: cdrom_panel, remove: null });
    c.floppies.forEach((floppy, i) => items.push({
        id: "floppy-" + i, label: "Floppy (" + floppy.slot + ")", summary: describe_image(floppy.image), panel: ctx => floppy_panel(ctx, i),
        remove: next => { next.floppies.splice(i, 1); },
    }));
    c.network.forEach((n, i) => items.push({
        id: "network-" + i, label: "Network adapter" + (c.network.length > 1 ? " " + (i + 1) : ""), summary: n.device === "none" ? "none" : (NIC_LABELS[n.device] || n.device) + ", " + n.backend,
        panel: ctx => network_panel(ctx, i), remove: c.network.length > 1 ? next => { next.network.splice(i, 1); } : null,
    }));
    items.push({ id: "sound", label: "Sound card", summary: (c.sound.device === "none" ? "none" : SOUND_LABELS[c.sound.device] || c.sound.device) +
        (c.sound.mute ? ", muted" : ""),
        panel: sound_panel, remove: null });
    if(c.usb) items.push({ id: "usb", label: "USB", summary: c.usb.controller.toUpperCase() + (c.usb.tablet ? ", tablet" : ""), panel: usb_panel,
        remove: next => { next.usb = null; } });
    (c.usb ? c.usb.disks : []).forEach((disk, i) => items.push({
        id: "usb-disk-" + i, label: "USB disk (" + disk.id + ")", summary: describe_image(disk.image), panel: ctx => usb_disk_panel(ctx, i),
        remove: next => { /** @type {any} */ (next.usb).disks.splice(i, 1); },
    }));
    if(c.tpm) items.push({ id: "tpm", label: "TPM", summary: "TPM 2.0 (CRB)", panel: tpm_panel, remove: next => { next.tpm = null; } });
    items.push({ id: "display", label: "Display", summary: c.display.adapter + (c.display.vram_mb ? ", " + c.display.vram_mb + " MB" : ""), panel: display_panel, remove: null });
    items.push({ id: "serial", label: "Serial ports", summary: c.serial.filter(s => s.attach !== "none").map(s => "UART" + s.port + " " + s.attach).join(", ") || "none",
        panel: serial_panel, remove: null });
    if(c.filesystem) items.push({ id: "filesystem", label: "Shared folder", summary: c.filesystem.baseurl || "in the browser", panel: shared_folder_panel,
        remove: next => { next.filesystem = null; } });
    if(c.kernel) items.push({ id: "kernel", label: "Direct boot", summary: c.kernel.bzimage ? describe_image(c.kernel.bzimage) : "kernel not chosen", panel: direct_boot_panel,
        remove: next => { next.kernel = null; } });
    if(c.android) items.push({ id: "android", label: "Android", summary: ({ venus: "Venus", gfxstream: "gfxstream", host: "host GPU", guest: "CPU" }[c.android.gpu_mode] ||
        (/^ranchu_/.test(c.android.device) ? "CPU" : "SwiftShader")) +
        (c.android.vendor_ramdisk === "debug" ? ", debug ramdisk" : ""), panel: android_panel, remove: next => { next.android = null; } });
    if(virt) items.push({ id: "virt", label: "virt devices", summary: c.virt.transport + (c.virt.vsock ? ", vsock" : ""), panel: virt_panel, remove: null });
    items.push({ id: "advanced", label: "Advanced", summary: c.advanced.cpu_worker ? "CPU in a Worker" : "CPU in the page", panel: advanced_panel, remove: null });
    return items;
}

/**
 * The item a problem belongs to
 * @param {string} path
 * @return {string}
 */
export function item_of(path)
{
    const [head, index] = path.split(".");
    // (a USB disk's: usb.disks.<i>)
    if(head === "usb" && index === "disks" && /^\d+$/.test(path.split(".")[2] || "")) return "usb-disk-" + path.split(".")[2];
    switch(head)
    {
        case "disks": return "disk-" + (index || 0);
        case "floppies": return "floppy-" + (index || 0);
        case "network": return "network-" + (index || 0);
        case "cpu": return "processor";
        case "memory": case "machine": case "cdrom": case "sound": case "usb": case "tpm": case "display": case "serial": case "filesystem": case "virt": case "advanced": return head;
        case "kernel": return "kernel";
        case "android": return "android";
        case "initial_state": return "advanced";
    }
    return "general";
}

/**
 * What can be added to a configuration
 * @param {VMConfig} c
 * @return {Array<[string, (next: VMConfig) => void]>}
 */
function additions(c)
{
    const virt = c.machine.type === "virt", arm = virt || c.machine.type === "ranchu";
    /** @type {Array<[string, (next: VMConfig) => void]>} */
    const list = [];
    if(c.disks.length < 2)
    {
        list.push(["Hard disk", next => { next.disks.push({ slot: next.disks.some(d => d.slot === "hda") ? "hdb" : "hda", image: { kind: "empty", size: 512 << 20 },
            disk_option: "read_only", disk_error: "stop" }); }]);
    }
    if(!arm && c.floppies.length < 2)
    {
        list.push(["Floppy drive", next => { next.floppies.push({ slot: next.floppies.some(f => f.slot === "fda") ? "fdb" : "fda", image: null, disk_option: "read_only" }); }]);
    }
    if(virt && c.network.length < 4)
    {
        list.push(["Network adapter", next => { next.network.push({ device: "virtio", backend: "none", relay_url: "", mtu: 1500, mac_address_translation: false }); }]);
    }
    if(!arm && !c.usb) list.push(["USB", next => { next.usb = { controller: "uhci", tablet: true, disks: [] }; }]);
    // (a TPM 2.0: with ACPI, which describes it)
    if(!arm && !c.tpm) list.push(["TPM", next => { next.tpm = { state: null }; next.machine.acpi = true; }]);
    // (a USB disk in a free port: with USB, or with it added for the disk)
    if(!arm && (!c.usb || c.usb.disks.length + (c.usb.tablet ? 1 : 0) < (USB_PORTS[c.usb.controller] || 0)))
    {
        list.push(["USB disk", next =>
        {
            if(!next.usb) next.usb = { controller: "uhci", tablet: false, disks: [] };
            const ids = next.usb.disks.map(d => d.id);
            let n = 0;
            while(ids.includes("usb" + n)) n++;
            next.usb.disks.push({ id: "usb" + n, image: { kind: "empty", size: 64 << 20 }, disk_option: "read_only", disk_error: "stop", write_protected: false });
        }]);
    }
    if(!c.filesystem) list.push(["Shared folder", next => { next.filesystem = {}; }]);
    if(!c.kernel) list.push(["Direct boot", next => { next.kernel = { bzimage: null, initrd: null, cmdline: null, multiboot: null, from_filesystem: false }; }]);
    // (Cuttlefish's on the arm64 virt machine, an emulator image's on ranchu)
    if(virt && c.cpu.type === "arm64" && !c.android) list.push(["Android boot", next => { next.android = Object.assign({}, ANDROID_DEFAULTS); }]);
    if(c.machine.type === "ranchu" && !c.android)
    {
        const model = RANCHU_DEVICES.find(d => d.cpu === c.cpu.type);
        if(model) list.push(["Android boot", next => { next.android = Object.assign({}, ANDROID_DEFAULTS, { device: model.id }); }]);
    }
    return list;
}

/**
 * Edit a configuration in the dialog; resolves with the saved configuration
 * (checked) or null when cancelled
 * @param {VMConfig} config
 * @param {{store: PanelContext["store"], service?: PanelContext["service"], title?: string, save_label?: string, item?: string}} options
 * @return {Promise<VMConfig | null>}
 */
export function open_settings(config, options)
{
    return new Promise(resolve =>
    {
        let working = fitted(config).config;
        let notes = fitted(config).notes;
        let selected = options.item || "general";
        /** @type {Problem[]} */
        let problems = [];
        const element = /** @type {HTMLDialogElement} */ (h("dialog.settings-dialog", { "aria-label": options.title || "Settings" }));
        const close = value =>
        {
            element.close();
            element.remove();
            resolve(value);
        };
        element.addEventListener("cancel", e => { e.preventDefault(); close(null); });

        /** @type {PanelContext} */
        const ctx = {
            get config() { return working; },
            get choices() { return choices(working); },
            set(path, value)
            {
                const result = change(working, path, value);
                working = result.config;
                notes = result.notes;
                problems = [];
                render();
            },
            edit(fn)
            {
                const next = JSON.parse(JSON.stringify(working));
                fn(next);
                const result = fitted(next);
                working = result.config;
                notes = result.notes;
                problems = [];
                render();
            },
            store: options.store,
            service: options.service || null,
        };

        const save = () =>
        {
            problems = check_config(working);
            if(problems.length)
            {
                selected = item_of(problems[0].path);
                render();
                return;
            }
            close(working);
        };

        function render()
        {
            const items = hardware_items(working);
            if(!items.some(item => item.id === selected)) selected = "general";
            const item = /** @type {Item} */ (items.find(i => i.id === selected));
            const with_problems = new Set(problems.map(p => item_of(p.path)));
            const list = h("ul.hardware-list", { role: "listbox", "aria-label": "Hardware" }, items.map(i => h("li", {
                role: "option",
                tabindex: "0",
                class: (i.id === selected ? "selected" : "") + (with_problems.has(i.id) ? " has-problem" : ""),
                "aria-selected": i.id === selected ? "true" : "false",
                dataset: { item: i.id },
                onclick: () => { selected = i.id; render(); },
                onkeydown: e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); selected = i.id; render(); } },
            }, h("span.item-label", null, i.label), h("span.item-summary", null, i.summary))));
            const add = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Add hardware" }, h("option", { value: "" }, "Add…"),
                additions(working).map(([label], index) => h("option", { value: String(index) }, label))));
            add.addEventListener("change", () =>
            {
                const chosen = additions(working)[+add.value];
                if(!chosen) return;
                const before = new Set(hardware_items(working).map(i => i.id));
                ctx.edit(chosen[1]);
                const added = hardware_items(working).find(i => !before.has(i.id));
                if(added) { selected = added.id; render(); }
            });
            const remove = h("button", { type: "button", disabled: !item.remove, onclick: () => { if(item.remove) ctx.edit(item.remove); } }, "Remove");
            const own_problems = problems.filter(p => item_of(p.path) === selected);
            replace(element,
                h("div.settings", null,
                    h("header.settings-header", null, h("h2", null, options.title || "Settings: " + working.name)),
                    h("aside.settings-list", null, list, h("div.settings-list-actions", null, add, remove)),
                    h("section.settings-panel", { "aria-label": item.label }, h("h3", null, item.label),
                        own_problems.length ? h("ul.problems", { role: "alert" }, own_problems.map(p => h("li", null, p.message))) : null,
                        item.panel(ctx)),
                    h("footer.settings-footer", null,
                        h("div.settings-notes", { role: "status" }, notes.length ? "Also changed: " + notes.join("; ") : problems.length ?
                            problems.length + (problems.length === 1 ? " problem" : " problems") + " to fix before saving" : ""),
                        h("button", { type: "button", onclick: () => close(null) }, "Cancel"),
                        h("button.primary", { type: "button", onclick: save }, options.save_label || "Save"))));
        }

        document.body.append(element);
        render();
        element.showModal();
    });
}

export { CPU_LABELS };
