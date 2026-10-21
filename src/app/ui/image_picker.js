// @ts-check
// Where an image comes from (docs/vm-manager-plan.md "虚拟机配置格式", the
// image's kinds; "磁盘的存放位置"): a URL, a file on this computer (its
// handle kept where the browser allows it), an empty disk in memory, an
// image of the disk service (listed, or created there), a browser disk (in
// the browser's private storage: chosen, made empty, or imported, U6).
// The settings dialog and the wizard use it.

import { h, ask_text, inform, format_size } from "./dom.js";
import { FLOPPY_SIZES } from "../vm_config.js";
import { list_images, create_image, image_url, new_image_name } from "../disk_service_client.js";
import { list_disks, create_disk, import_disk } from "../browser_disks.js";

/** @typedef {import("../vm_config.js").Image} Image */
/** @typedef {import("../disk_service_client.js").Service} Service */

/**
 * @typedef {Object} PickerOptions
 * @property {Image | null} image the image now
 * @property {"disk" | "cdrom" | "floppy" | "file"} role a hard disk's choices (empty disks, the service, browser
 *     disks), a CD's, a floppy's (empty floppies), or any other image's (a kernel, a BIOS: URL or file)
 * @property {boolean} [optional] "none" is a choice
 * @property {(image: Image | null, extra?: {read_write?: boolean}) => void} on_change extra.read_write: an image
 *     the service created, to be written back
 * @property {{put_handle: (handle: any) => Promise<string>, get_pref?: (name: string) => Promise<any>,
 *     put_pref?: (name: string, value: any) => Promise<void>}} store where a picked file's handle is kept (and the
 *     preferences: persistent storage asked for once)
 * @property {Service | null} [service] the disk service, if there is one
 * @property {string} [machine_name] for the name of a new image of the service
 * @property {string} label
 */

/**
 * A file the user picks, with its handle where the browser gives one (Chromium's showOpenFilePicker)
 * @param {{put_handle: (handle: any) => Promise<string>}} store
 * @return {Promise<Image | null>}
 */
async function pick_local_file(store)
{
    const picker = /** @type {any} */ (window).showOpenFilePicker;
    if(typeof picker === "function")
    {
        let handles;
        try
        {
            handles = await picker({ multiple: false });
        }
        catch(e)
        {
            if(e.name === "AbortError") return null;
            throw e;
        }
        const file = await handles[0].getFile();
        return { kind: "file", name: file.name, size: file.size, last_modified: file.lastModified, handle: await store.put_handle(handles[0]) };
    }
    // (other browsers keep no handle: the console asks for the file again)
    const file = await new Promise(resolve =>
    {
        const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", style: { display: "none" } }));
        input.addEventListener("change", () => { resolve(input.files?.[0]); input.remove(); });
        input.addEventListener("cancel", () => { resolve(undefined); input.remove(); });
        document.body.append(input);
        input.click();
    });
    return file ? { kind: "file", name: file.name, size: file.size, last_modified: file.lastModified } : null;
}

/**
 * The image's kind as the picker names it ("service" for a URL of the service)
 * @param {Image | null} image
 * @param {Service | null | undefined} service
 */
function picker_kind(image, service)
{
    if(!image) return "none";
    if(image.kind === "url" && service && image.url.startsWith(image_url(service, ""))) return "service";
    return image.kind;
}

/**
 * The picker's element
 * @param {PickerOptions} o
 * @return {HTMLElement}
 */
export function image_picker(o)
{
    const kinds = [];
    if(o.optional) kinds.push(["none", "None"]);
    kinds.push(["url", "An image on the web (URL)"], ["file", "A file on this computer"]);
    if(o.role === "disk") kinds.push(["empty", "A new empty disk in memory (lost at power off)"]);
    if(o.role === "floppy") kinds.push(["empty", "An empty floppy"]);
    if((o.role === "disk" || o.role === "cdrom" || o.role === "floppy") && o.service) kinds.push(["service", "An image of the disk service"]);
    if(o.role === "disk" || o.role === "floppy") kinds.push(["browser", "A browser disk (kept in this browser)"]);
    // (without "none" among the choices, an empty URL to begin with)
    /** @type {any} (its kind is the picker's) */
    const image = o.image || (o.optional ? null : { kind: "url", url: "", async: true });
    const kind = picker_kind(image, o.service);

    const select = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": o.label + ": source" },
        kinds.map(([value, text]) => h("option", { value, selected: value === kind }, text))));
    select.addEventListener("change", () =>
    {
        const value = select.value;
        if(value === "none") o.on_change(null);
        else if(value === "url") o.on_change({ kind: "url", url: "", async: true });
        else if(value === "empty") o.on_change({ kind: "empty", size: o.role === "floppy" ? 1474560 : 512 << 20 });
        else if(value === "file") pick_local_file(o.store).then(picked => { if(picked) o.on_change(picked); else select.value = kind; });
        else if(value === "service") o.on_change({ kind: "url", url: image_url(/** @type {Service} */ (o.service), ""), async: true });
        else if(value === "browser") o.on_change({ kind: "browser", path: "", size: 0 });
    });

    const detail = [];
    if(image && kind === "url")
    {
        const url = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: image.url, size: 50, placeholder: "https://…/disk.img",
            "aria-label": o.label + ": URL" }));
        url.addEventListener("change", () => o.on_change(Object.assign({}, image, { url: url.value.trim() })));
        const size = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "0", step: "512", value: image.size || "",
            placeholder: "optional", "aria-label": o.label + ": size in bytes" }));
        size.addEventListener("change", () =>
        {
            const next = Object.assign({}, image);
            if(+size.value > 0) next.size = +size.value;
            else delete next.size;
            o.on_change(next);
        });
        detail.push(h("label.field", null, h("span", null, "URL"), url), h("label.field", null, h("span", null, "Size in bytes"), size));
    }
    else if(image && kind === "file")
    {
        detail.push(h("p", null, image.name + ", " + format_size(image.size) + (image.handle ? "" : " (to be chosen again when the machine starts)"), " ",
            h("button", { type: "button", onclick: () => pick_local_file(o.store).then(picked => { if(picked) o.on_change(picked); }) }, "Choose another…")));
    }
    else if(image && kind === "empty" && o.role === "floppy")
    {
        const sizes = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": o.label + ": floppy size" },
            FLOPPY_SIZES.map(bytes => h("option", { value: bytes, selected: bytes === image.size }, format_size(bytes)))));
        sizes.addEventListener("change", () => o.on_change({ kind: "empty", size: +sizes.value }));
        detail.push(h("label.field", null, h("span", null, "Size"), sizes));
    }
    else if(image && kind === "empty")
    {
        const mb = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "1", max: "2000", value: Math.round(image.size / 1048576),
            "aria-label": o.label + ": size in MB" }));
        mb.addEventListener("change", () => o.on_change({ kind: "empty", size: Math.max(1, Math.min(2000, Math.round(+mb.value || 1))) * 1048576 }));
        detail.push(h("label.field", null, h("span", null, "Size in MB (at most 2000)"), mb));
    }
    else if(image && image.kind === "url" && kind === "service")
    {
        const service = /** @type {Service} */ (o.service);
        const list = h("div.service-images", null, "Listing the disk service's images…");
        detail.push(list);
        list_images(service).then(found =>
        {
            const current = decodeURIComponent(image.url.slice(image_url(service, "").length));
            const choose = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": o.label + ": the service's image" },
                h("option", { value: "", selected: !current }, "Choose an image…"),
                found.images.map(i => h("option", { value: i.name, selected: i.name === current },
                    i.name + " (" + format_size(i.size) + (i.writer ? ", in use" : "") + ")"))));
            choose.addEventListener("change", () =>
            {
                const chosen = found.images.find(i => i.name === choose.value);
                if(chosen) o.on_change({ kind: "url", url: image_url(service, chosen.name), size: chosen.size, async: true }, { read_write: true });
            });
            const create = h("button", {
                type: "button", disabled: !found.create, title: found.create ? "" : "The disk service does not create images (start it with --allow-create)",
                onclick: async () =>
                {
                    const name = await ask_text("New image", "Name (ending in .img)", new_image_name(o.machine_name || "disk", found.images));
                    if(!name) return;
                    const size = await ask_text("New image", "Size in MB", "8192");
                    if(!size || !(+size > 0)) return;
                    try
                    {
                        const made = await create_image(service, name.trim(), Math.round(+size) * 1048576);
                        o.on_change({ kind: "url", url: made.url, size: made.size, async: true }, { read_write: true });
                    }
                    catch(e)
                    {
                        await inform("The image was not created", e.message);
                    }
                },
            }, "Create a new image…");
            list.replaceChildren(h("label.field", null, h("span", null, "Image"), choose), create);
        }, e => list.replaceChildren(h("p.error", null, e.message)));
    }
    else if(image && kind === "browser")
    {
        detail.push(browser_disk_choice(o, image));
    }
    return h("div.image-picker", null, h("label.field", null, h("span", null, o.label), select), detail);
}

/**
 * The browser disks to choose from, and making or importing one
 * @param {PickerOptions} o
 * @param {any} image
 */
function browser_disk_choice(o, image)
{
    const element = h("div.service-images", null, "Listing the browser disks…");
    const prefs = o.store.get_pref && o.store.put_pref ? /** @type {any} */ (o.store) : undefined;
    const chosen = disk => o.on_change({ kind: "browser", path: disk.path, size: disk.size }, { read_write: true });
    const status = h("small.reason", { role: "status" });
    list_disks().then(disks =>
    {
        const choose = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": o.label + ": the browser disk" },
            h("option", { value: "", selected: !image.path }, "Choose a disk…"),
            disks.map(d => h("option", { value: d.path, selected: d.path === image.path }, d.label + " (" + format_size(d.size) + ")"))));
        choose.addEventListener("change", () => { const d = disks.find(x => x.path === choose.value); if(d) chosen(d); });
        const make = h("button", { type: "button", onclick: async () =>
        {
            const size = await ask_text("New browser disk", "Size in MB", o.role === "floppy" ? "1.44" : "1024");
            if(!size || !(+size > 0)) return;
            try
            {
                status.textContent = "Making the disk …";
                chosen(await create_disk(o.role === "floppy" ? 1474560 : Math.round(+size) * 1048576, o.machine_name || "disk", prefs));
            }
            catch(e) { status.textContent = ""; await inform("The disk was not made", e.message); }
        } }, "New empty disk…");
        const bring = h("button", { type: "button", onclick: async () =>
        {
            const from = await ask_text("Import into a browser disk", "The image's URL (empty: a file on this computer)", "");
            if(from === undefined) return;
            /** @type {string | File} */
            let source = from.trim();
            if(!source)
            {
                const file = await new Promise(resolve =>
                {
                    const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", style: { display: "none" } }));
                    input.addEventListener("change", () => { resolve(input.files?.[0]); input.remove(); });
                    input.addEventListener("cancel", () => { resolve(undefined); input.remove(); });
                    document.body.append(input);
                    input.click();
                });
                if(!file) return;
                source = file;
            }
            try
            {
                const label = typeof source === "string" ? source.split("/").pop() || "disk" : source.name;
                const disk = await import_disk(source, label, { prefs, progress: (done, total) =>
                {
                    status.textContent = "Copying " + format_size(done) + (total ? " of " + format_size(total) : "") + " …";
                } });
                status.textContent = "Copied, the copy checked (SHA-256)";
                chosen(disk);
            }
            catch(e) { status.textContent = ""; await inform("The image was not imported", e.message); }
        } }, "Import an image…");
        element.replaceChildren(h("label.field", null, h("span", null, "Disk"), choose), make, bring, status,
            h("small.reason", null, "An import is a copy: the original stays as it is."));
    }, e => element.replaceChildren(h("p.error", null, e.message)));
    return element;
}
