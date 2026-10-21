// @ts-check
// The new machine wizard (docs/vm-manager-plan.md "新建虚拟机向导", U3):
// 1 where the system comes from (a CD, a floppy, an installed hard disk, a
// kernel and initrd, or later), 2 the system (a preset of
// src/app/guest_presets.js: all the hardware), 3 the name, 4 the hard disk
// (a new empty one and where it goes: a browser disk, the disk service,
// memory), 5 the summary: finish, or customize the hardware in the settings
// dialog first. The browser disk and the disk service's image are made only
// when the wizard finishes.

import { h, replace, format_size } from "./dom.js";
import { image_picker } from "./image_picker.js";
import { hardware_rows } from "./describe.js";
import { open_settings } from "./settings.js";
import { PRESETS, preset, preset_config } from "../guest_presets.js";
import { create_image, list_images, new_image_name } from "../disk_service_client.js";
import { create_disk } from "../browser_disks.js";
import { MAX_ARRAY_BUFFER_SIZE_MB } from "../../browser/vm_options.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Image} Image */
/** @typedef {import("../disk_service_client.js").Service} Service */

const SOURCES = [
    ["cdrom", "A CD or DVD image (an installation or live CD)"],
    ["floppy", "A floppy image"],
    ["disk", "A hard disk image with the system installed"],
    ["direct", "A kernel and initrd (and the system's CD as a read-only disk)"],
    ["later", "Install the system later"],
];

/**
 * The wizard; resolves with the new configuration (stored by the caller) or null when cancelled
 * @param {{store: {put_handle: (handle: any) => Promise<string>, get_pref?: any, put_pref?: any}, service: Service | null, names: string[]}} options
 *     names: the library's
 * @return {Promise<VMConfig | null>}
 */
export function open_wizard(options)
{
    return new Promise(resolve =>
    {
        const state = {
            step: 0,
            source: "cdrom",
            /** @type {Image | null} */
            image: null,
            /** @type {{bzimage: Image | null, initrd: Image | null, cmdline: string}} */
            direct: { bzimage: null, initrd: null, cmdline: "" },
            preset: "other",
            name: "",
            notes: "",
            disk: "new",
            disk_mb: 512,
            location: "browser",
            read_write: false,
            error: "",
        };
        const element = /** @type {HTMLDialogElement} */ (h("dialog.wizard-dialog", { "aria-label": "New virtual machine" }));
        const close = value => { element.close(); element.remove(); resolve(value); };
        element.addEventListener("cancel", e => { e.preventDefault(); close(null); });
        const steps = ["Source", "System", "Name", "Hard disk", "Summary"];

        const unique = name =>
        {
            for(let i = 1; ; i++)
            {
                const candidate = i === 1 ? name : name + " " + i;
                if(!options.names.includes(candidate)) return candidate;
            }
        };
        const choose_preset = id =>
        {
            const p = /** @type {import("../guest_presets.js").Preset} */ (preset(id));
            state.preset = id;
            state.disk_mb = p.disk_mb;
            state.location = p.disk_location === "service" && options.service ? "service" :
                p.disk_location === "memory" && p.disk_mb <= MAX_ARRAY_BUFFER_SIZE_MB ? "memory" : "browser";
            if(!state.name || PRESETS.some(q => unique(q.name) === state.name)) state.name = unique(p.name);
        };
        choose_preset("other");

        /**
         * The configuration of the choices (the new disk: the disk service's image's URL, or the browser disk's path, made when finished)
         * @param {string} [made]
         * @return {VMConfig}
         */
        const build = made =>
        {
            const p = /** @type {import("../guest_presets.js").Preset} */ (preset(state.preset));
            const config = preset_config(p, { name: state.name.trim() || p.name, notes: state.notes });
            if(state.source === "cdrom" && state.image) config.cdrom.image = state.image;
            if(state.source === "floppy" && state.image) config.floppies = [{ slot: "fda", image: state.image, disk_option: "read_only" }];
            if(state.source === "direct")
            {
                config.kernel = { bzimage: state.direct.bzimage, initrd: state.direct.initrd, cmdline: state.direct.cmdline.trim() || null,
                    multiboot: null, from_filesystem: false };
                if(state.image) config.cdrom.image = state.image;
            }
            if(state.source === "disk" && state.image)
            {
                config.disks = [{ slot: "hda", image: state.image, disk_option: state.read_write ? "read_write" : "read_only", disk_error: "stop" }];
            }
            else if(state.disk === "new")
            {
                const size = state.disk_mb * 1048576;
                config.disks = [{ slot: "hda", image: state.location === "service" ? { kind: "url", url: made || "(created when finished)", size, async: true } :
                    state.location === "browser" ? { kind: "browser", path: made || "(made when finished)", size } : { kind: "empty", size },
                disk_option: state.location === "memory" ? "read_only" : "read_write", disk_error: "stop" }];
            }
            return config;
        };

        const finish = async customize =>
        {
            state.error = "";
            let url;
            const new_disk = state.source !== "disk" && state.disk === "new";
            if(new_disk && state.location === "browser")
            {
                try
                {
                    url = (await create_disk(state.disk_mb * 1048576, state.name || "disk", /** @type {any} */ (options.store))).path;
                }
                catch(e)
                {
                    state.error = "The browser disk was not made: " + e.message;
                    render();
                    return;
                }
            }
            if(new_disk && state.location === "service")
            {
                const service = /** @type {Service} */ (options.service);
                try
                {
                    const name = new_image_name(state.name || "disk", (await list_images(service)).images);
                    url = (await create_image(service, name, state.disk_mb * 1048576)).url;
                }
                catch(e)
                {
                    state.error = "The disk service did not create the disk: " + e.message;
                    render();
                    return;
                }
            }
            let config = build(url);
            if(customize)
            {
                element.close();
                const edited = await open_settings(config, { store: options.store, service: options.service, title: "Customize: " + config.name, save_label: "Finish" });
                if(!edited)
                {
                    element.showModal();
                    return;
                }
                config = edited;
            }
            close(config);
        };

        const source_step = () =>
        {
            const radios = SOURCES.map(([value, text]) => h("label.check", null,
                h("input", { type: "radio", name: "source", value, checked: state.source === value, onchange: () => { state.source = value; state.image = null; render(); } }),
                " " + text));
            const pickers = [];
            if(state.source === "cdrom" || state.source === "floppy" || state.source === "disk")
            {
                pickers.push(image_picker({ label: state.source === "cdrom" ? "CD image" : state.source === "floppy" ? "Floppy image" : "Hard disk image",
                    role: state.source === "disk" ? "disk" : state.source, image: state.image, store: options.store, service: options.service,
                    machine_name: state.name, on_change: (image, extra) =>
                    {
                        state.image = image && image.kind === "empty" && state.source === "disk" ? null : image;
                        state.read_write = !!(extra && extra.read_write);
                        render();
                    } }));
            }
            if(state.source === "direct")
            {
                pickers.push(
                    image_picker({ label: "Kernel", role: "file", image: state.direct.bzimage, store: options.store, on_change: image => { state.direct.bzimage = image; render(); } }),
                    image_picker({ label: "Initrd", role: "file", optional: true, image: state.direct.initrd, store: options.store, on_change: image => { state.direct.initrd = image; render(); } }),
                    h("label.field", null, h("span", null, "Command line (optional)"), (() =>
                    {
                        const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: state.direct.cmdline, size: 50 }));
                        input.addEventListener("change", () => { state.direct.cmdline = input.value; });
                        return input;
                    })()),
                    image_picker({ label: "The system's CD (optional)", role: "cdrom", optional: true, image: state.image, store: options.store,
                        on_change: image => { state.image = image; render(); } }));
            }
            return [h("fieldset", null, h("legend", null, "Where does the system come from?"), radios), pickers];
        };

        const system_step = () =>
        {
            const p = /** @type {import("../guest_presets.js").Preset} */ (preset(state.preset));
            const list = h("ul.preset-list", { role: "listbox", "aria-label": "Systems" }, PRESETS.map(q => h("li", {
                role: "option", tabindex: "0", "aria-selected": q.id === state.preset ? "true" : "false", class: q.id === state.preset ? "selected" : "",
                dataset: { preset: q.id },
                onclick: () => { choose_preset(q.id); render(); },
                onkeydown: e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); choose_preset(q.id); render(); } },
            }, h("span", null, q.name), q.verified ? null : h("span.badge", null, "not verified"))));
            const fits = state.source === "later" || p.install.includes(/** @type {any} */ (state.source));
            return h("div.preset-pane", null, list, h("div.preset-detail", null,
                h("h3", null, p.name),
                h("p", null, p.verified ? "Verified: " + p.basis : h("strong", null, "Not verified: "), p.verified ? null : p.basis),
                h("p", null, "Installation: " + p.install_text),
                fits ? null : h("p.error", null, "This system is usually installed another way: " + p.install_text),
                h("table.hardware", null, h("tbody", null, hardware_rows(preset_config(p, { name: "x" })).filter(([name]) => !/^(Hard disk|CD|Floppy|UART)/.test(name))
                    .map(([name, value]) => h("tr", null, h("th", null, name), h("td", null, value))))),
                p.checklist.length ? [h("h4", null, "After the installation"), h("ul", null, p.checklist.map(c => h("li", null, c)))] : null,
                p.issues.length ? [h("h4", null, "Known problems"), h("ul", null, p.issues.map(c => h("li", null, c)))] : null));
        };

        const name_step = () =>
        {
            const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: state.name, size: 40, "aria-label": "Name" }));
            name.addEventListener("input", () => { state.name = name.value; });
            const notes = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 4, cols: 40, "aria-label": "Notes" }));
            notes.value = state.notes;
            notes.addEventListener("input", () => { state.notes = notes.value; });
            return [h("label.field", null, h("span", null, "Name"), name), h("label.field", null, h("span", null, "Notes"), notes)];
        };

        const disk_step = () =>
        {
            if(state.source === "disk")
            {
                return h("p", null, "The machine starts from the chosen hard disk image" + (state.read_write ? ", written back to the disk service." : ": its changes stay in memory."));
            }
            const choice = (value, text, disabled = false, title = "") => h("label.check", { title }, h("input", { type: "radio", name: "disk", value,
                checked: state.disk === value, disabled, onchange: () => { state.disk = value; render(); } }), " " + text);
            /** @type {Array<[string, string, boolean, string]>} */
            const locations = [
                ["browser", "A browser disk: kept in this browser (until its site data is cleared)", false, ""],
                ["service", "The disk service: an image file on " + (options.service ? options.service.url : "a disk service") + " (kept)", !options.service,
                    options.service ? "" : "No disk service: start one (make run starts one), or set it in Preferences"],
                ["memory", "Memory: lost at power off (at most " + MAX_ARRAY_BUFFER_SIZE_MB + " MB)", state.disk_mb > MAX_ARRAY_BUFFER_SIZE_MB, "too large for memory"],
            ];
            const size = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "1", value: state.disk_mb, "aria-label": "Disk size in MB" }));
            size.addEventListener("change", () =>
            {
                state.disk_mb = Math.max(1, Math.round(+size.value || 1));
                if(state.location === "memory" && state.disk_mb > MAX_ARRAY_BUFFER_SIZE_MB) state.location = "browser";
                render();
            });
            return [
                choice("new", "A new empty disk"),
                state.disk === "new" ? h("div.indent", null,
                    h("label.field", null, h("span", null, "Size in MB"), size, h("small.reason", null, format_size(state.disk_mb * 1048576))),
                    h("fieldset", null, h("legend", null, "Where it is kept"), locations.map(([value, text, disabled, title]) => h("label.check", { title },
                        h("input", { type: "radio", name: "location", value, checked: state.location === value, disabled,
                            onchange: () => { state.location = value; render(); } }), " " + text))),
                    state.location === "browser" ? quota_note() : null) : null,
                choice("none", "No hard disk"),
            ];
        };

        // (a browser disk counts its whole size against the site's storage at once: measured in Chrome, docs/vm-manager-plan.md U6)
        const quota_note = () =>
        {
            const note = h("small.reason", { role: "status" }, "A browser disk takes its whole size of the browser's storage for this site at once.");
            navigator.storage?.estimate?.().then(e =>
            {
                if(e.quota) note.textContent += " This site has " + format_size(Math.max(0, e.quota - (e.usage || 0))) + " more.";
            }).catch(() => {});
            return note;
        };

        const summary_step = () =>
        {
            const config = build();
            const p = /** @type {import("../guest_presets.js").Preset} */ (preset(state.preset));
            return [
                h("h3", null, config.name),
                p.verified ? null : h("p.error", null, "This system's settings are not verified: " + p.basis),
                h("table.hardware", null, h("tbody", null, hardware_rows(config).map(([name, value]) => h("tr", null, h("th", null, name), h("td", null, value))))),
                p.checklist.length ? [h("h4", null, "After the installation"), h("ul", null, p.checklist.map(c => h("li", null, c)))] : null,
            ];
        };

        const ready = () =>
        {
            if(state.step === 0)
            {
                if(state.source === "direct") return state.direct.bzimage ? "" : "Choose the kernel";
                if(state.source !== "later" && !state.image) return "Choose the image";
                if(state.image && state.image.kind === "url" && !state.image.url) return "Give the image's URL";
            }
            if(state.step === 2 && !state.name.trim()) return "Give the machine a name";
            if(state.step === 3 && state.disk === "new" && state.location === "memory" && state.disk_mb > MAX_ARRAY_BUFFER_SIZE_MB) return "Too large for memory";
            return "";
        };

        function render()
        {
            const body = [source_step, system_step, name_step, disk_step, summary_step][state.step]();
            const blocked = ready();
            const last = state.step === steps.length - 1;
            replace(element, h("div.wizard", null,
                h("header", null, h("h2", null, "New virtual machine"),
                    h("ol.wizard-steps", null, steps.map((s, i) => h("li", { class: i === state.step ? "current" : i < state.step ? "done" : "" }, s)))),
                h("section.wizard-body", { "aria-label": steps[state.step] }, body),
                h("footer.wizard-footer", null,
                    h("span.wizard-status", { role: "status", class: state.error ? "error" : "" }, state.error || blocked),
                    h("button", { type: "button", onclick: () => close(null) }, "Cancel"),
                    h("button", { type: "button", disabled: state.step === 0, onclick: () => { state.step--; render(); } }, "Back"),
                    last ? [h("button", { type: "button", onclick: () => finish(true) }, "Customize hardware…"),
                        h("button.primary", { type: "button", onclick: () => finish(false) }, "Finish")] :
                        h("button.primary", { type: "button", disabled: !!blocked, onclick: () => { state.step++; render(); } }, "Next"))));
        }

        document.body.append(element);
        render();
        element.showModal();
    });
}
