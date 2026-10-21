// @ts-check
// The library (docs/vm-manager-plan.md "虚拟机库"): the virtual machines of
// this browser on the left, the chosen one's summary on the right: new (the
// wizard), import, edit settings (the settings dialog), rename, export,
// delete (with its own browser disks), power on in a new tab, resume; the
// preferences (the disk service); the browser disks (U6).

import { h, replace, ask_text, confirm, inform, download, pick_file, dialog, format_size } from "./dom.js";
import { hardware_rows } from "./describe.js";
import { open_wizard } from "./wizard.js";
import { open_settings } from "./settings.js";
import { VMStore, export_config, export_file_name, import_config, files_to_choose, config_images } from "../vm_store.js";
import { list_disks, create_disk, import_disk, export_disk, delete_disk, disk_id } from "../browser_disks.js";
import { preset } from "../guest_presets.js";
import { probe, LOCAL_SERVICE } from "../disk_service_client.js";
import { delete_state, running_machines, storage_space } from "../vm_state.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Image} Image */

/**
 * The browser disks a configuration uses
 * @param {VMConfig} config
 * @return {string[]} their paths
 */
function browser_disk_paths(config)
{
    return config_images(config).filter(image => image.kind === "browser").map(image => /** @type {any} */ (image).path);
}

/**
 * The browser disks dialog: each disk's size and machines, export, delete,
 * import, a new one; their total
 * @param {VMStore} store
 * @param {VMConfig[]} configs
 */
async function browser_disks_dialog(store, configs)
{
    for(;;)
    {
        const disks = await list_disks();
        const users = path => configs.filter(c => browser_disk_paths(c).includes(path)).map(c => c.name);
        /** @type {null | (() => any)} */
        let action = null;
        const act = fn => () => { action = fn; /** @type {HTMLElement | null} */ (document.querySelector("dialog[open] .dialog-buttons button"))?.click(); };
        const total = disks.reduce((n, d) => n + d.size, 0);
        await dialog({
            title: "Browser disks",
            body: [
                h("p.note", null, "Disks kept in this browser's private storage for this site: " + disks.length + ", " + format_size(total) +
                    ". Clearing the site's data deletes them: export the ones you want to keep."),
                disks.length ? h("table.hardware.browser-disks", null, h("tbody", null, disks.map(d => h("tr", { dataset: { disk: d.id } },
                    h("th", null, d.label), h("td", null, format_size(d.size)), h("td", null, users(d.path).join(", ") || "not used"),
                    h("td", null,
                        h("button", { type: "button", onclick: act(() => export_disk(d.id, d.label.replace(/[^\w.-]+/g, "_") + ".img", download)) }, "Export"), " ",
                        h("button.danger", { type: "button", onclick: act(async () =>
                        {
                            const used = users(d.path);
                            if(!await confirm("Delete " + d.label + "?", used.length ? "It is the disk of " + used.join(", ") + ": they will not start without it." :
                                "Its data is gone for good.", "Delete", true)) return;
                            await delete_disk(d.id);
                        }) }, "Delete")))))) : h("p.empty", null, "No browser disks."),
                h("div.summary-actions", null,
                    h("button", { type: "button", id: "browser_disk_new", onclick: act(async () =>
                    {
                        const size = await ask_text("New browser disk", "Size in MB", "1024");
                        if(size && +size > 0) await create_disk(Math.round(+size) * 1048576, "disk", store);
                    }) }, "New empty disk…"),
                    h("button", { type: "button", id: "browser_disk_import", onclick: act(async () =>
                    {
                        const file = await pick_file("");
                        if(file) await import_disk(file, file.name, { prefs: store });
                    }) }, "Import a file…")),
            ],
            buttons: [{ label: "Close", value: true, primary: true }],
        });
        if(!action) return;
        try { await action(); }
        catch(e) { await inform("Browser disks", e.message); }
    }
}

/** The page is served from this computer (the local disk service is looked for there) */
const PAGE_ON_THIS_COMPUTER = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/**
 * The disk service the manager uses: the preference's, or on a page served
 * from this computer the local one of make run when it answers
 * @param {VMStore} store
 * @return {Promise<import("../disk_service_client.js").Service | null>}
 */
export async function current_service(store)
{
    const pref = await store.get_pref("disk_service");
    if(pref && pref.url) return (await probe(pref)).ok ? pref : null;
    if(pref && pref.off) return null;
    if(!PAGE_ON_THIS_COMPUTER) return null;
    const local = { url: LOCAL_SERVICE };
    return (await probe(local)).ok ? local : null;
}

/**
 * The preferences dialog: the disk service's URL and token
 * @param {VMStore} store
 */
async function preferences(store)
{
    const pref = await store.get_pref("disk_service") || {};
    const url = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: pref.url || "", size: 40, placeholder: PAGE_ON_THIS_COMPUTER ? LOCAL_SERVICE + " (looked for by default)" : "https://…/",
        "aria-label": "Disk service URL" }));
    const token = /** @type {HTMLInputElement} */ (h("input", { type: "password", value: pref.token || "", size: 40, autocomplete: "off", "aria-label": "Token" }));
    const off = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: !!pref.off }));
    const result = h("p.note", { role: "status" });
    const test = h("button", { type: "button", onclick: async () =>
    {
        result.textContent = "Asking …";
        /** @type {any} */
        const found = await probe({ url: url.value.trim() || LOCAL_SERVICE, token: token.value || undefined });
        result.textContent = found.ok ? "A disk service: " + found.list.images.length + " images" + (found.list.create ? ", creates new ones" : ", does not create images") :
            found.reason;
    } }, "Test");
    const answer = await dialog({
        title: "Preferences",
        body: [
            h("p", null, "A disk service keeps hard disks in image files and writes the guests' changes back (tools/disk-service.mjs; make run starts one)."),
            h("label.field", null, h("span", null, "Disk service URL"), url),
            h("label.field", null, h("span", null, "Token (if it needs one)"), token),
            h("label.check", null, off, " Use no disk service"),
            h("div", null, test, result),
        ],
        buttons: [{ label: "Cancel", value: false }, { label: "Save", value: true, primary: true }],
    });
    if(!answer) return;
    await store.put_pref("disk_service", off.checked ? { off: true } : url.value.trim() ? { url: url.value.trim(), token: token.value || undefined } : undefined);
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
    let service = await current_service(store);
    /** @type {Set<string>} the machines running in a tab now */
    let running = await running_machines();
    let space = await storage_space().catch(() => null);
    /** @type {string | undefined} */
    let selected = configs[0]?.id;

    const reload = async id =>
    {
        configs = await store.list();
        running = await running_machines();
        space = await storage_space().catch(() => null);
        selected = id && configs.some(c => c.id === id) ? id : configs[0]?.id;
        render();
    };

    const create = async () =>
    {
        const config = await open_wizard({ store, service, names: configs.map(c => c.name) });
        if(!config) return;
        await reload((await store.put(config)).id);
    };

    const edit = async config =>
    {
        const edited = await open_settings(config, { store, service });
        if(!edited) return;
        await reload((await store.put(edited)).id);
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
        }, h("span.vm-name", null, c.name), h("span.vm-state", null, running.has(c.id) ? "Running in another tab" :
            c.suspended ? "Suspended" : "Powered off"))));
        const sidebar = h("aside.library-list", null,
            h("div.library-actions", null,
                h("button.primary#new_vm", { onclick: create }, "New virtual machine…"),
                h("button#import_vm", { onclick: import_file }, "Import…"),
                h("button#preferences", { onclick: async () => { await preferences(store); service = await current_service(store); render(); } }, "Preferences…"),
                h("button#browser_disks", { onclick: async () => { await browser_disks_dialog(store, configs); await reload(selected); } }, "Browser disks…")),
            h("p.note#service_status", null, service ? "Disk service: " + service.url : "No disk service"),
            configs.length ? list : h("p.empty", null, "No virtual machines yet. Make a new one, or import a .v86vm.json file."),
            space && space.quota ? h("p.note#storage_status", null, "Browser storage: " + format_size(space.usage) + " used of " + format_size(space.quota) +
                (space.persisted ? " (kept)" : "")) : null);
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
            if(running.has(config.id))
            {
                await inform("It runs", config.name + " runs in another tab: power it off there first.");
                return;
            }
            // (its own browser disks go with it; those other machines use stay)
            const own = browser_disk_paths(config).filter(path => !configs.some(c => c.id !== config.id && browser_disk_paths(c).includes(path)));
            if(!await confirm("Delete " + config.name + "?", "Its settings" + (config.suspended ? ", its suspended state" : "") +
                (own.length ? " and its browser disk" + (own.length > 1 ? "s" : "") : "") + " are deleted from this browser. " +
                "Images on web sites, on your computer or on a disk service stay where they are.", "Delete", true)) return;
            try
            {
                for(const path of own) await delete_disk(disk_id(path));
            }
            catch(e)
            {
                await inform("Not deleted", e.message);
                return;
            }
            await delete_state(config.id);
            await store.delete(config.id);
            await reload(undefined);
        };
        const discard = async () =>
        {
            if(!await confirm("Discard the suspended state?", "The next power on starts " + config.name + " afresh: what it had in its memory is lost.",
                "Discard", true)) return;
            await delete_state(config.id);
            await store.put(Object.assign({}, config, { suspended: null }));
            await reload(config.id);
        };
        const p = config.template ? preset(config.template) : undefined;
        return h("div.summary", null,
            h("h1", null, config.name),
            config.notes ? h("p.notes", null, config.notes) : null,
            p && !p.verified ? h("p.error", null, "Its system's settings are not verified: " + p.basis) : null,
            config.suspended ? h("p.note#suspended_note", null, "Suspended " + new Date(config.suspended.time).toLocaleString() + " (" +
                format_size(config.suspended.size) + " in this browser's storage)") : null,
            running.has(config.id) ? h("p.note", null, "Running in another tab.") : null,
            h("div.summary-actions", null,
                h("button.primary#power_on", { onclick: power_on }, config.suspended ? "Resume" : "Power on"),
                config.suspended ? h("button#discard_state", { onclick: discard }, "Discard the suspended state…") : null,
                h("button#edit_vm", { onclick: () => edit(config) }, "Edit settings…"),
                h("button#rename_vm", { onclick: rename }, "Rename…"),
                h("button#export_vm", { onclick: () => download([export_config(config)], export_file_name(config), "application/json") }, "Export"),
                h("button.danger#delete_vm", { onclick: remove }, "Delete…")),
            h("table.hardware", null, h("tbody", null, hardware_rows(config).map(([name, value]) => h("tr", null, h("th", null, name), h("td", null, value))))),
            p && (p.checklist.length || p.issues.length) ? h("details.checklist", null, h("summary", null, "After the installation, known problems"),
                p.checklist.length ? h("ul", null, p.checklist.map(c => h("li", null, h("label.check", null, h("input", { type: "checkbox" }), " " + c)))) : null,
                p.issues.length ? h("ul", null, p.issues.map(c => h("li", null, c))) : null) : null,
            h("p.note", null, "Changed " + new Date(config.modified).toLocaleString()));
    }

    // (another tab powered a machine on or off, or suspended it)
    window.addEventListener("focus", () => reload(selected));
    document.addEventListener("visibilitychange", () => { if(!document.hidden) reload(selected); });
    render();
}
