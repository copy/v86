// @ts-check
// The new machine wizard (docs/vm-manager-plan.md "新建虚拟机向导", U3):
// 1 where the system comes from (a CD, a floppy, an installed hard disk, a
// kernel and initrd, an Android image package, or later), 2 the system (a preset of
// src/app/guest_presets.js: all the hardware), 3 the name, 4 the hard disk
// (a new empty one and where it goes: a browser disk, the disk service,
// memory), 5 the summary: finish, or customize the hardware in the settings
// dialog first. The browser disk and the disk service's image are made only
// when the wizard finishes. An Android image package (docs/android-images-plan.md
// I3) becomes a browser disk then, in a worker (src/app/android_import.js):
// its images as they are, booted by v64's bootloader with SwiftShader.

import { h, replace, format_size } from "./dom.js";
import { image_picker } from "./image_picker.js";
import { hardware_rows } from "./describe.js";
import { open_settings } from "./settings.js";
import { PRESETS, preset, preset_config } from "../guest_presets.js";
import { create_image, list_images, new_image_name } from "../disk_service_client.js";
import { create_disk } from "../browser_disks.js";
import { inspect_android_package, import_android_package, import_android_package_to_service, sort_android_files, hash_file, USERDATA_GIB,
    DEFAULT_USERDATA_GIB } from "../android_import.js";
import { ANDROID_CATALOG } from "../android_catalog.js";
import { MAX_ARRAY_BUFFER_SIZE_MB } from "../../browser/vm_options.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Image} Image */
/** @typedef {import("../disk_service_client.js").Service} Service */

const SOURCES = [
    ["cdrom", "A CD or DVD image (an installation or live CD)"],
    ["floppy", "A floppy image"],
    ["disk", "A hard disk image with the system installed"],
    ["direct", "A kernel and initrd (and the system's CD as a read-only disk)"],
    ["android", "An Android image package (.zip): Cuttlefish's images (aosp_cf_arm64_only_phone-img-<build>.zip from ci.android.com), and a GSI if wanted"],
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
            /** @type {{file: File | null, gsi: File | null, debug_ramdisk: File | null, info: import("../android_import.js").PackageInfo | null, error: string,
             *     userdata_gib: number, entry: string, checks: Object<string, string>, room?: number | null}} entry: the catalog's (I7), "" for another
             *     package; checks: each dropped part's against it (ok, checking…, or what differs); room: the site's storage left (null: unknown) */
            android: { file: null, gsi: null, debug_ramdisk: null, info: null, error: "", userdata_gib: DEFAULT_USERDATA_GIB,
                entry: ANDROID_CATALOG.entries[0].id, checks: {} },
            progress: "",
            /** @type {AbortController | null} the import going on (its Cancel) */
            importing: null,
        };
        const element = /** @type {HTMLDialogElement} */ (h("dialog.wizard-dialog", { "aria-label": "New virtual machine" }));
        const close = value => { element.close(); element.remove(); resolve(value); };
        element.addEventListener("cancel", e => { e.preventDefault(); if(state.importing) state.importing.abort(); else close(null); });
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
            else if(state.source === "android" && state.android.info)
            {
                // (its images as they are: SwiftShader, no Venus driver; the disk kept and written)
                if(config.android) config.android.gpu_mode = "swiftshader";
                config.display.vulkan = "none";
                config.display.proxy = false;
                const size = state.android.info.disk_size(state.android.userdata_gib);
                config.disks = [{ slot: "hda", image: state.location === "service" ? { kind: "url", url: made || "(created when finished)", size, async: true } :
                    { kind: "browser", path: made || "(made when finished)", size }, disk_option: "read_write", disk_error: "stop" }];
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
            const new_disk = state.source !== "disk" && state.source !== "android" && state.disk === "new";
            if(state.source === "android")
            {
                const file = /** @type {File} */ (state.android.file);
                try
                {
                    state.progress = "Importing " + file.name + "…";
                    render();
                    const started = Date.now();
                    const progress = (done, total) =>
                    {
                        const seconds = (Date.now() - started) / 1000;
                        const left = done ? seconds * (total - done) / done : 0;
                        state.progress = "Importing " + file.name + ": " + Math.floor(done / total * 100) + "% (" + format_size(done) + " of " + format_size(total) +
                            (done && done < total ? ", about " + Math.ceil(left) + " s left" : "") + ")";
                        const status = element.querySelector(".wizard-status");
                        if(status) status.textContent = state.progress;
                    };
                    state.importing = new AbortController();
                    render();
                    const imported = { userdata_gib: state.android.userdata_gib, gsi: state.android.gsi, progress, signal: state.importing.signal };
                    url = state.location === "service" ?
                        (await import_android_package_to_service(file, state.name || "android", /** @type {Service} */ (options.service), imported)).url :
                        (await import_android_package(file, state.name || "Android", Object.assign({ prefs: options.store }, imported))).path;
                    state.progress = "";
                    state.importing = null;
                }
                catch(e)
                {
                    state.progress = "";
                    state.importing = null;
                    state.error = e.message === "Cancelled" ? "The import was cancelled" : "The package was not imported: " + e.message;
                    render();
                    return;
                }
            }
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
            if(state.source === "android") pickers.push(android_picker());
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

        // (the files: chosen or dropped, the device's package and a GSI (in
        // one go or one after the other), then read: what they are, the disk)
        // (the dropped parts against the catalog's entry: size, then SHA-256 in
        // the importer's worker, each file hashed once)
        const hashes = new WeakMap();
        const check_parts = async () =>
        {
            const a = state.android;
            const entry = ANDROID_CATALOG.entries.find(e => e.id === a.entry);
            a.checks = {};
            if(!entry) return;
            for(const [role, file] of /** @type {Array<[string, File | null]>} */ ([["device", a.file], ["gsi", a.gsi], ["debug_ramdisk", a.debug_ramdisk]]))
            {
                if(!file) continue;
                const part = entry.parts.find(p => p.role === role);
                if(!part) { a.checks[role] = "not one of this entry's files"; continue; }
                if(file.size !== part.size) { a.checks[role] = "differs: " + format_size(file.size) + ", the catalog's " + part.name + " is " + format_size(part.size); continue; }
                if(!hashes.has(file))
                {
                    a.checks[role] = "checking…";
                    render();
                    hashes.set(file, await hash_file(file, (done, total) =>
                    {
                        const status = element.querySelector(".drop-zone [data-role=" + role + "]");
                        if(status) status.textContent = "checking " + Math.floor(done / total * 100) + "%";
                    }));
                }
                a.checks[role] = hashes.get(file) === part.sha256 ? "ok" : "differs: its SHA-256 is not the catalog's (another build, or a damaged download)";
            }
            render();
        };
        const take_files = async files =>
        {
            const a = state.android;
            Object.assign(a, { info: null, error: "" });
            render();
            try
            {
                const sorted = await sort_android_files(files);
                if(sorted.device) a.file = sorted.device;
                if(sorted.gsi) a.gsi = sorted.gsi;
                if(sorted.debug_ramdisk) a.debug_ramdisk = sorted.debug_ramdisk;
                if(!a.file) throw new Error(a.gsi ? "A GSI is a system for a device: add the device's package (a Cuttlefish images zip) too" :
                    "Add the device's package (a Cuttlefish images zip)");
                a.info = await inspect_android_package(a.file, a.gsi);
                choose_preset("android16");
            }
            catch(e)
            {
                a.error = e.message;
            }
            render();
            await check_parts();
        };
        /** the catalog (I7): its entries, the chosen one's files and where to download them */
        const catalog = () =>
        {
            const a = state.android;
            const entry = ANDROID_CATALOG.entries.find(e => e.id === a.entry);
            const ROLES = { device: "The device's images", gsi: "The GSI (the system)", debug_ramdisk: "The debug vendor ramdisk" };
            const radios = [...ANDROID_CATALOG.entries.map(e => [e.id, e.title]), ["", "Another package (not in the catalog: no checksums)"]].map(([id, title]) =>
                h("label.check", null, h("input", { type: "radio", name: "catalog", value: id, checked: a.entry === id,
                    onchange: () => { a.entry = id; check_parts(); render(); } }), " " + title));
            return h("fieldset", null, h("legend", null, "From the catalog"), radios, entry ? [
                h("p", null, h("small.reason", null, entry.notes + " Verified: " + entry.verified + ".")),
                h("table.hardware.catalog-parts", null, h("tbody", null, entry.parts.map(p => h("tr", null,
                    h("th", null, ROLES[p.role] + (p.optional ? " (optional: Settings, Android)" : "")),
                    h("td", null, h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.name), " ", format_size(p.size), " ",
                        h("a", { href: p.page, target: "_blank", rel: "noopener" }, "(its page)"), h("br"), h("small.reason", null, "SHA-256 " + p.sha256)),
                    h("td", { "data-role": p.role }, a.checks[p.role] || (p.optional ? "" : "needed"))))))] : null);
        };
        const android_picker = () =>
        {
            const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: ".zip,application/zip", multiple: true, "aria-label": "Android image package" }));
            input.addEventListener("change", () => { if(input.files && input.files.length) take_files(Array.from(input.files)); });
            const a = state.android;
            const gsi = a.info && a.info.gsi;
            const zone = h("div.drop-zone", { tabindex: "0" }, catalog(),
                h("p", null, "Drop the package here, or choose it: ", input),
                h("p", null, h("small.reason", null, "Download it from ci.android.com yourself (the build's Artifacts: aosp_cf_arm64_only_phone-img-<build>.zip); " +
                    "to run a Generic System Image on that device, drop the GSI's zip too (developer.android.com's GSI releases, " +
                    "of the device's Android version or newer). v64 reads them here, nothing is uploaded.")),
                a.file || a.gsi ? h("p", { role: "status" }, [a.file, a.gsi].filter(Boolean).map(f => f.name + " (" + format_size(f.size) + ")").join(" and ") + ": " +
                    (a.error ? "" : a.info ? a.info.text + (gsi ? ", running the GSI's Android " + gsi.release + " (" + gsi.fingerprint + ")" : "") +
                        "; its disk: " + format_size(a.info.disk_size(a.userdata_gib)) : "reading…")) : null,
                gsi && gsi.abilist32 ? h("p", null, h("small.reason", null, "The GSI lists 32-bit ABIs (" + gsi.abilist32 + "), but this device runs " +
                    "only the 64-bit zygote: Android starts, 32-bit apps do not run (they need AArch32 and a device with a 32-bit zygote: " +
                    "docs/aarch32-plan.md).")) : null,
                a.error ? h("p.error", null, a.error) : null,
                a.gsi ? h("button", { type: "button", onclick: () => { a.gsi = null; take_files([]); } }, "Without the GSI") : null);
            zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
            zone.addEventListener("dragleave", () => zone.classList.remove("over"));
            zone.addEventListener("drop", e =>
            {
                e.preventDefault();
                zone.classList.remove("over");
                const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
                if(files.length) take_files(files);
            });
            return zone;
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
            if(state.source === "android")
            {
                const info = /** @type {import("../android_import.js").PackageInfo} */ (state.android.info);
                // (a browser disk takes its whole size at once: the sizes past the site's room are not offered, I4.3)
                if(state.android.room === undefined)
                {
                    state.android.room = null;
                    navigator.storage?.estimate?.().then(e => { state.android.room = e.quota ? Math.max(0, e.quota - (e.usage || 0)) : null; render(); }).catch(() => {});
                }
                const room = state.location === "browser" ? state.android.room : null;
                const fits = gib => room === null || room === undefined || info.disk_size(gib) <= room;
                if(!fits(state.android.userdata_gib)) state.android.userdata_gib = USERDATA_GIB.filter(fits).pop() || USERDATA_GIB[0];
                const sizes = USERDATA_GIB.map(gib => h("label.check", { title: fits(gib) ? "" : "the disk would be " + format_size(info.disk_size(gib)) + ", the site has " +
                    format_size(/** @type {number} */ (room)) + " more" }, h("input", { type: "radio", name: "userdata", value: String(gib),
                    checked: state.android.userdata_gib === gib, disabled: !fits(gib), onchange: () => { state.android.userdata_gib = gib; render(); } }),
                " " + gib + " GiB" + (gib === DEFAULT_USERDATA_GIB ? " (the usual)" : "") + (fits(gib) ? "" : " (no room)")));
                if(state.location === "memory" || state.location === "service" && !options.service) state.location = "browser";
                const where = [["browser", "A browser disk: kept in this browser (until its site data is cleared)", false, ""],
                    ["service", "The disk service: an image file on " + (options.service ? options.service.url : "a disk service") + " (kept)", !options.service,
                        options.service ? "" : "No disk service: start one (make run starts one), or set it in Preferences"]].map(([value, text, disabled, title]) =>
                    h("label.check", { title }, h("input", { type: "radio", name: "location", value, checked: state.location === value, disabled,
                        onchange: () => { state.location = /** @type {string} */ (value); render(); } }), " " + text));
                return [
                    h("p", null, "A disk made from the package: its images as they are, super shrunk to its partitions (" + format_size(info.super_size) + "), " +
                        "userdata blank (Android formats it at first boot). " + format_size(info.disk_size(state.android.userdata_gib)) + " in all, about " +
                        format_size(info.data_bytes) + " of it written now."),
                    h("fieldset", null, h("legend", null, "Space for apps and data (userdata)"), sizes),
                    h("fieldset", null, h("legend", null, "Where it is kept"), where),
                    state.location === "browser" ? quota_note() : null,
                    h("p", null, h("small.reason", null, "The package boots with SwiftShader (the CPU draws): Android starts, its desktop needs the GPU support of " +
                        "docs/gfxstream-plan.md.")),
                ];
            }
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
                if(state.source === "android")
                {
                    const a = state.android;
                    if(!a.info) return a.file && !a.error ? "Reading the package…" : "Choose the package";
                    const entry = ANDROID_CATALOG.entries.find(e => e.id === a.entry);
                    if(entry)
                    {
                        const missing = entry.parts.filter(p => !p.optional && !{ device: a.file, gsi: a.gsi }[p.role]);
                        if(missing.length) return "Still needed: " + missing.map(p => p.name).join(", ");
                        const bad = Object.entries(a.checks).find(([, c]) => c !== "ok");
                        if(bad) return bad[1] === "checking…" ? "Checking the files…" : "A file is not the catalog's: " + bad[1];
                    }
                    return "";
                }
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
                    h("span.wizard-status", { role: "status", class: state.error ? "error" : "" }, state.error || state.progress || blocked),
                    // (while a package is imported: only its Cancel)
                    state.importing ? h("button", { type: "button", onclick: () => state.importing && state.importing.abort() }, "Cancel import") : [
                        h("button", { type: "button", onclick: () => close(null) }, "Cancel"),
                        h("button", { type: "button", disabled: state.step === 0, onclick: () => { state.step--; render(); } }, "Back"),
                        last ? [h("button", { type: "button", onclick: () => finish(true) }, "Customize hardware…"),
                            h("button.primary", { type: "button", onclick: () => finish(false) }, "Finish")] :
                            h("button.primary", { type: "button", disabled: !!blocked, onclick: () => { state.step++; render(); } }, "Next")])));
        }

        document.body.append(element);
        render();
        element.showModal();
    });
}
