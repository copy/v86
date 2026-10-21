// @ts-check
// The console (docs/vm-manager-plan.md "控制台"): one virtual machine in this
// tab, started from the library (?vm=<id>) or from an old page's address
// (?profile=<id> and its query arguments, as the old page starts it). U2: the
// start and the power buttons; U4 brings the menus, the status bar and the drawers.

import { h, replace, confirm } from "./dom.js";
import { VMStore } from "../vm_store.js";
import { config_to_options } from "../vm_config.js";
import { get_profiles, user_profile_base, user_profile } from "../../browser/profiles.js";
import { DEFAULT_FORM, DEFAULT_GRAPHICS_ADAPTER, settings_to_options } from "../../browser/vm_options.js";
import { bool_arg, image_host, start_settings } from "../../browser/query_compat.js";
import { DEBUG_PAGE, ON_LOCALHOST, page_env, load_graphics_proxy, create_emulator } from "../emulator_bridge.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Image} Image */

/** The old page's profiles that start themselves after a key press (main.js's hack) */
const PRESS_A_KEY = ["dsl", "helenos", "android", "android4", "redox", "beos", "9legacy"];

/**
 * @param {string} text
 */
function set_title(text)
{
    document.title = text + " - v86" + (DEBUG_PAGE ? " - debug" : "");
}

/**
 * The console's frame: a toolbar, the screen, a status line
 */
function console_layout()
{
    const screen_container = h("div#screen_container", null,
        h("div#screen"),
        h("canvas#vga"),
        h("div", { style: { position: "absolute", top: "0", zIndex: "10" } }, h("textarea.phone_keyboard", { "aria-label": "Keyboard" })));
    const status = h("div.console-status", { role: "status" });
    const toolbar = h("div.console-toolbar");
    const notice = h("div.console-notice");
    const root = h("div.console", null, toolbar, notice, h("div.console-screen", null, screen_container), status);
    return { root, screen_container, status, toolbar, notice };
}

/**
 * The start of an old page's address: its profile (one of src/browser/profiles.js,
 * a user image's, or custom with an image) and the settings the old page makes of it
 * @param {URLSearchParams} query_args
 * @return {Promise<{error: string} | {profile: any, start: ReturnType<typeof start_settings>, graphics_proxy: boolean}>}
 */
async function address_start(query_args)
{
    const id = query_args.get("profile");
    const host = image_host(query_args, ON_LOCALHOST);
    let profile = get_profiles(host, ON_LOCALHOST).find(p => p.id === id) || null;
    if(!profile)
    {
        const base = user_profile_base(id);
        if(base)
        {
            const response = await fetch(base + "/profile.json").catch(() => null);
            if(!response || !response.ok) return { error: "Profile not found: " + id };
            profile = user_profile(base, await response.json());
        }
        else if(!(id === "custom" && ["hda.url", "cdrom.url", "fda.url"].some(name => query_args.has(name))))
        {
            return { error: id === "custom" ? "The address names no image (hda.url, cdrom.url or fda.url)." : "There is no system " + JSON.stringify(id) + "." };
        }
    }
    // (the old page's form as it is before anyone changes it; on debug.html at localhost, its relay)
    const form = DEBUG_PAGE && ON_LOCALHOST ? Object.assign({}, DEFAULT_FORM, { relay_url: "ws://localhost:8080/" }) : DEFAULT_FORM;
    const graphics_proxy = query_args.has("graphics_proxy") && bool_arg(query_args.get("graphics_proxy"));
    const start = start_settings(profile, query_args, form, { location_args: query_args, origin: location.origin, debug: DEBUG_PAGE, graphics_proxy });
    return { profile, start, graphics_proxy };
}

/**
 * The files a configuration names, picked again or read through their kept
 * handles (the browser asks for permission on a click)
 * @param {VMConfig} config
 * @param {VMStore} store
 * @param {HTMLElement} notice where to ask
 * @return {Promise<Map<Image, File>>}
 */
async function resolve_files(config, store, notice)
{
    /** @type {Map<Image, File>} */
    const files = new Map();
    const images = [config.machine.bios, config.machine.vga_bios, ...config.disks.map(d => d.image), config.cdrom.image,
        ...config.floppies.map(f => f.image), config.kernel?.bzimage, config.kernel?.initrd, config.kernel?.multiboot, config.initial_state];
    for(const image of images)
    {
        if(!image || image.kind !== "file") continue;
        const handle = image.handle ? await store.get_handle(image.handle) : undefined;
        if(handle)
        {
            const access = /** @type {any} */ (handle);
            if(await access.queryPermission?.({ mode: "read" }) !== "granted")
            {
                await new Promise(resolve => replace(notice, h("p", null, "The virtual machine reads " + image.name + " on this computer. ",
                    h("button.primary", { onclick: async () => { if(await access.requestPermission({ mode: "read" }) === "granted") resolve(undefined); } },
                        "Allow access to " + image.name))));
            }
            files.set(image, await handle.getFile());
            continue;
        }
        // (no handle: this browser does not keep them, or the configuration was imported)
        const file = await new Promise(resolve =>
        {
            const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", onchange: () => resolve(input.files?.[0]) }));
            replace(notice, h("p", null, "Choose " + image.name + " (" + image.size + " bytes) on this computer: ", input));
        });
        if(file.size !== image.size)
        {
            throw new Error(file.name + " has " + file.size + " bytes, the virtual machine's " + image.name + " had " + image.size);
        }
        if((file.name !== image.name || file.lastModified !== image.last_modified) &&
            !await confirm("Another file?", file.name + " is not the file the virtual machine was made with (" + image.name +
                ", changed " + new Date(image.last_modified).toLocaleString() + "). Use it anyway?", "Use it"))
        {
            throw new Error("No file for " + image.name);
        }
        files.set(image, file);
    }
    replace(notice);
    return files;
}

/**
 * Open the console in `root`
 * @param {HTMLElement} root
 * @param {{vm?: string, query_args?: URLSearchParams}} target
 */
export async function open_console(root, target)
{
    const layout = console_layout();
    replace(root, layout.root);
    const status = text => { layout.status.textContent = text; };
    const fail = text =>
    {
        replace(layout.notice, h("p.error", null, text, " ", h("a", { href: location.pathname }, "Back to the library")));
        status("");
    };

    /** @type {any} */
    let options, profile = null, config = null;
    const on_proxy_error = text => status(text);
    try
    {
        if(target.vm)
        {
            const store = await VMStore.open();
            config = await store.get(target.vm);
            if(!config)
            {
                fail("There is no such virtual machine in this browser's library.");
                return;
            }
            set_title(config.name);
            const files = await resolve_files(config, store, layout.notice);
            if(config.display.proxy) await load_graphics_proxy();
            options = config_to_options(config, Object.assign(page_env(layout.screen_container, config.display.proxy, on_proxy_error),
                { file: image => files.get(image) }));
        }
        else
        {
            const query_args = /** @type {URLSearchParams} */ (target.query_args);
            const result = await address_start(query_args);
            if("error" in result)
            {
                fail(result.error);
                return;
            }
            profile = result.profile;
            if(profile) set_title(profile.name);
            if(result.graphics_proxy)
            {
                status("Loading graphics proxy...");
                await load_graphics_proxy();
            }
            options = settings_to_options(result.start.settings,
                Object.assign({ cpu_worker: result.start.cpu_worker }, page_env(layout.screen_container, result.graphics_proxy, on_proxy_error)));
        }
    }
    catch(e)
    {
        fail(e.message);
        return;
    }

    const emulator = create_emulator(options);
    if(!emulator) return;
    /** @type {any} */ (window).v86_console = { emulator, config, profile };
    const query_args = target.query_args;

    emulator.add_listener("download-progress", e =>
    {
        const name = String(e.file_name).split("?", 1)[0].split("/").pop();
        status(e.total ? "Downloading " + name + " " + Math.floor(e.loaded / e.total * 100) + "%" : "Downloading " + name + " ...");
    });
    emulator.add_listener("download-error", e => fail("Loading " + e.file_name + " failed. Check your connection and reload the page to try again."));
    emulator.add_listener("emulator-error", error => fail("Emulator failed: " + error.message));
    emulator.add_listener("emulator-ready", () =>
    {
        status("Running");
        if(profile && PRESS_A_KEY.includes(profile.id))
        {
            setTimeout(() => emulator.keyboard_send_text(profile.id === "9legacy" ? "1\n" : "\n"), 3000);
        }
        if(query_args?.has("c")) setTimeout(() => emulator.keyboard_send_text(query_args.get("c") + "\n"), 25);
        if(query_args?.has("s")) setTimeout(() => emulator.serial0_send(query_args.get("s") + "\n"), 25);
    });
    emulator.add_listener("emulator-stopped", () => status("Paused"));
    emulator.add_listener("emulator-started", () => status("Running"));

    // virtio_gpu: the guest's display follows the window
    if((options.graphics_adapter || DEFAULT_GRAPHICS_ADAPTER) === "virtio_gpu")
    {
        let timer = 0;
        const displays = options.graphics_adapter_test?.scanouts || 1;
        const report = () =>
        {
            clearTimeout(timer);
            timer = window.setTimeout(() =>
            {
                for(let i = 0; i < displays; i++) emulator.set_display_size(Math.floor(window.innerWidth / displays), window.innerHeight, i);
            }, 250);
        };
        window.addEventListener("resize", report);
        emulator.add_listener("emulator-ready", report);
    }

    const library = h("a.button", { href: location.pathname }, "Library");
    const power_off = h("button", {
        onclick: async () =>
        {
            if(!await confirm("Power off?", "The virtual machine stops as if its power were cut. Changes in memory are lost.", "Power off", true)) return;
            await emulator.destroy();
            replace(layout.toolbar, library);
            replace(layout.notice, h("p", null, "Powered off. ", h("a", { href: location.href }, "Power on again"), " or go back to the ",
                h("a", { href: location.pathname }, "library"), "."));
            status("Powered off");
        },
    }, "Power off");
    const reset = h("button", { onclick: () => emulator.restart(), disabled: !!options.initial_state, title: options.initial_state ? "Started from a saved state" : "" }, "Reset");
    const ctrl_alt_del = h("button", { onclick: () => emulator.keyboard_send_scancodes([0x1D, 0x38, 0x53, 0xD3, 0xB8, 0x9D]) }, "Ctrl+Alt+Del");
    replace(layout.toolbar, library, power_off, reset, ctrl_alt_del,
        h("span.console-name", null, config ? config.name : profile ? profile.name : "Custom"));
    status("Starting ...");
}
