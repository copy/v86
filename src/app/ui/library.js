// @ts-check
// The library (docs/vm-manager-plan.md "虚拟机库"): the virtual machines of
// this browser on the left, the chosen one's summary on the right. U2: new
// (the default configuration), import, rename, export, delete, power on in a
// new tab; U3 brings the wizard and the settings dialog.

import { h, replace, ask_text, confirm, inform, download, pick_file, format_size } from "./dom.js";
import { VMStore, export_config, export_file_name, import_config, files_to_choose } from "../vm_store.js";
import { new_config } from "../vm_config.js";

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
        ["Machine", (MACHINES[c.machine.type] || c.machine.type) + (c.machine.acpi ? ", ACPI" : "")],
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
    if(c.initial_state) rows.push(["Starts from a state", describe_image(c.initial_state)]);
    rows.push(["Display", (ADAPTERS[c.display.adapter] || c.display.adapter) + (c.display.vram_mb ? ", " + c.display.vram_mb + " MB" : "") +
        (c.display.displays > 1 ? ", " + c.display.displays + " displays" : "")]);
    for(const network of c.network)
    {
        rows.push(["Network", network.device === "none" ? "none" : network.device + ", " + (BACKENDS[network.backend] || network.backend) +
            (network.relay_url ? " " + network.relay_url : "")]);
    }
    rows.push(["Sound", c.sound.device === "sb16" ? "Sound Blaster 16" : "none"]);
    for(const serial of c.serial) if(serial.attach !== "none") rows.push(["UART" + serial.port, serial.attach]);
    if(c.filesystem) rows.push(["Shared folder", c.filesystem.baseurl || "in the browser"]);
    return rows;
}

/**
 * A name not taken yet: "New virtual machine", "New virtual machine 2", ...
 * @param {string} base
 * @param {VMConfig[]} configs
 */
function unused_name(base, configs)
{
    const names = new Set(configs.map(c => c.name));
    for(let i = 1; ; i++)
    {
        const name = i === 1 ? base : base + " " + i;
        if(!names.has(name)) return name;
    }
}

/**
 * Open the library in `root`
 * @param {HTMLElement} root
 */
export async function open_library(root)
{
    document.title = "Virtual machines - v86";
    const store = await VMStore.open();
    let configs = await store.list();
    /** @type {string | undefined} */
    let selected = configs[0]?.id;

    const reload = async id =>
    {
        configs = await store.list();
        selected = id && configs.some(c => c.id === id) ? id : configs[0]?.id;
        render();
    };

    const create = async () =>
    {
        const config = await store.put(new_config({ name: unused_name("New virtual machine", configs) }));
        await reload(config.id);
    };

    const import_file = async () =>
    {
        const file = await pick_file(".json,.v86vm.json,application/json");
        if(!file) return;
        let config;
        try
        {
            config = await store.put(import_config(await file.text(), new Set(configs.map(c => c.id))));
        }
        catch(e)
        {
            await inform("Import failed", h("pre.problems", null, e.message));
            return;
        }
        await reload(config.id);
        if(files_to_choose(config).length)
        {
            await inform("Imported " + config.name, "Its files on your computer are not part of the export: the console asks for them when it starts.");
        }
    };

    function render()
    {
        const list = h("ul.vm-list", { role: "listbox", "aria-label": "Virtual machines" }, configs.map(c => h("li", {
            role: "option",
            "aria-selected": c.id === selected ? "true" : "false",
            class: c.id === selected ? "selected" : "",
            dataset: { id: c.id },
            tabindex: "0",
            onclick: () => { selected = c.id; render(); },
            onkeydown: e => { if(e.key === "Enter" || e.key === " ") { selected = c.id; render(); } },
        }, h("span.vm-name", null, c.name), h("span.vm-state", null, "Powered off"))));
        const sidebar = h("aside.library-list", null,
            h("div.library-actions", null,
                h("button.primary#new_vm", { onclick: create }, "New virtual machine"),
                h("button#import_vm", { onclick: import_file }, "Import…")),
            configs.length ? list : h("p.empty", null, "No virtual machines yet. Make a new one, or import a .v86vm.json file."));
        const config = configs.find(c => c.id === selected);
        replace(root, h("div.library", null, sidebar, h("main.library-summary", null, config ? summary(config) : intro())));
    }

    function intro()
    {
        return h("div.intro", null,
            h("h1", null, "v86"),
            h("p", null, "Make a virtual machine, give it a disk and an installation CD or floppy, and start it. Its settings stay in this browser."),
            h("p.note", null, "The library lives in this browser's storage for this site: clearing the site's data deletes it. Export your machines now and then."));
    }

    /**
     * @param {VMConfig} config
     */
    function summary(config)
    {
        const power_on = () => window.open(location.pathname + "?vm=" + encodeURIComponent(config.id), "_blank");
        const rename = async () =>
        {
            const name = await ask_text("Rename", "Name", config.name);
            if(name === undefined || !name.trim() || name === config.name) return;
            await store.put(Object.assign({}, config, { name: name.trim() }));
            await reload(config.id);
        };
        const remove = async () =>
        {
            if(!await confirm("Delete " + config.name + "?", "Its settings are deleted from this browser. Images on web sites or on your computer stay where they are.",
                "Delete", true)) return;
            await store.delete(config.id);
            await reload(undefined);
        };
        return h("div.summary", null,
            h("h1", null, config.name),
            config.notes ? h("p.notes", null, config.notes) : null,
            h("div.summary-actions", null,
                h("button.primary#power_on", { onclick: power_on }, "Power on"),
                h("button#edit_vm", { disabled: true, title: "The settings dialog comes in a later version" }, "Edit settings"),
                h("button#rename_vm", { onclick: rename }, "Rename…"),
                h("button#export_vm", { onclick: () => download([export_config(config)], export_file_name(config), "application/json") }, "Export"),
                h("button.danger#delete_vm", { onclick: remove }, "Delete…")),
            h("table.hardware", null, h("tbody", null, hardware_rows(config).map(([name, value]) => h("tr", null, h("th", null, name), h("td", null, value))))),
            h("p.note", null, "Changed " + new Date(config.modified).toLocaleString()));
    }

    render();
}
