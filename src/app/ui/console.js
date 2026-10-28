// @ts-check
// The console (docs/vm-manager-plan.md "控制台", U2 and U4): one virtual
// machine in this tab, started from the library (?vm=<id>) or from an old
// page's address (?profile=custom with its images and query arguments, as
// the old page starts it). The toolbar's menus (power, keys, removable devices, view,
// input, sound, tools), the status bar (time, speed, disk, network, display,
// mouse), the drawers (serial terminal, shared folder, details), the disk
// error dialog, and the warning before closing a page with disks written back.
// A library machine runs in one tab at a time (its lock), and suspends into
// a state file of the browser's private storage, resumed when it starts again (U5).

import { h, replace, confirm, inform, dialog, download, pick_file, ask_text, menu_button, format_size } from "./dom.js";
import { VMStore } from "../vm_store.js";
import { read_state, delete_state, write_state, storage_space, state_estimate, machine_digest, hold_machine } from "../vm_state.js";
import { config_to_options, android_display, uefi_vars_template, TPM_STATE_SIZE } from "../vm_config.js";
import { import_disk, create_disk } from "../browser_disks.js";
import { combination_scancodes, COMBINATIONS } from "../keys.js";
import { DEFAULT_FORM, DEFAULT_GRAPHICS_ADAPTER, settings_to_options } from "../../browser/vm_options.js";
import { bool_arg, start_settings } from "../../browser/query_compat.js";
import { DEBUG_PAGE, ON_LOCALHOST, page_env, load_graphics_proxy, create_emulator, query_append } from "../emulator_bridge.js";
import { NIC_LABELS, SOUND_LABELS } from "./panels/devices.js";
import { USB_PORTS } from "../../machine_options.js";

/** @typedef {import("../vm_config.js").VMConfig} VMConfig */
/** @typedef {import("../vm_config.js").Image} Image */

/** The old page's profiles that start themselves after a key press (main.js's hack) */
/** RAM and video memory from which states are saved as V7 streams (the old page's STREAMED_STATE_MEMORY) */
const STREAMED_STATE_MEMORY = 1024 * 1024 * 1024;

/** The screen's scales of the View menu */
const SCALES = [0.5, 1, 1.5, 2, 3];

/**
 * @param {string} text
 */
function set_title(text)
{
    document.title = text + " - v86" + (DEBUG_PAGE ? " - debug" : "");
}

/**
 * 75s, 3m 05s, 1h 02m 05s
 * @param {number} time seconds
 */
export function format_time(time)
{
    const two = n => String(n).padStart(2, "0");
    if(time < 60) return time + "s";
    if(time < 3600) return (time / 60 | 0) + "m " + two(time % 60) + "s";
    return (time / 3600 | 0) + "h " + two((time / 60 | 0) % 60) + "m " + two(time % 60) + "s";
}

/**
 * A packet as Wireshark imports it ("File, Import from Hex Dump": offsets and
 * bytes, 16 to a line; the old page's hex_dump)
 * @param {Uint8Array} data
 * @return {string}
 */
export function hex_dump(data)
{
    const hex = (n, length) => n.toString(16).toUpperCase().padStart(length, "0");
    const lines = [];
    for(let offset = 0; offset < data.length; offset += 16)
    {
        const row = Array.from(data.subarray(offset, offset + 16));
        lines.push(hex(offset, 5) + "   " + row.map(b => hex(b, 2) + " ").join("") + "   ".repeat(16 - row.length) + "  " +
            row.map(x => x >= 33 && x !== 34 && x !== 92 && x <= 126 ? String.fromCharCode(x) : ".").join(""));
    }
    return "\n" + lines.join("\n") + "\n";
}

/**
 * The console's frame: a toolbar, a notice line, the screen and a drawer, a status bar
 */
function console_layout()
{
    const phone_keyboard = /** @type {HTMLTextAreaElement} */ (h("textarea.phone_keyboard", { "aria-label": "Keyboard", autocorrect: "off",
        autocapitalize: "off", spellcheck: "false", tabindex: "0" }));
    const screen_container = h("div#screen_container", null,
        h("div#screen"),
        h("canvas#vga"),
        h("div", { style: { position: "absolute", top: "0", zIndex: "10" } }, phone_keyboard));
    const status = h("div.console-status", { role: "status" });
    const toolbar = h("div.console-toolbar", { role: "toolbar", "aria-label": "Console" });
    const notice = h("div.console-notice");
    const drawer = h("aside.console-drawer", { hidden: true });
    const root = h("div.console", null, toolbar, notice, h("div.console-main", null, h("div.console-screen", null, screen_container), drawer), status);
    return { root, screen_container, status, toolbar, notice, drawer, phone_keyboard };
}

/**
 * The start of an old page's address (?profile=custom with an image: hda.url,
 * cdrom.url or fda.url) and the settings the old page makes of it
 * @param {URLSearchParams} query_args
 * @return {Promise<{error: string} | {profile: any, start: ReturnType<typeof start_settings>, graphics_proxy: boolean}>}
 */
async function address_start(query_args)
{
    const id = query_args.get("profile");
    // (the old page's list of systems with images on its host is not part of this page)
    const profile = null;
    if(!(id === "custom" && ["hda.url", "cdrom.url", "fda.url"].some(name => query_args.has(name))))
    {
        return { error: id === "custom" ? "The address names no image (hda.url, cdrom.url or fda.url)." :
            "There is no system " + JSON.stringify(id) + ": an address names its images, ?profile=custom&hda.url=… (or cdrom.url, fda.url)." };
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
    const images = [config.machine.bios, config.machine.vga_bios, ...config.disks.map(d => d.image), ...(config.usb ? config.usb.disks.map(d => d.image) : []),
        config.cdrom.image,
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
 * Save a state as a file of the user's: in one buffer for smaller machines,
 * else a V7 stream written as it is made (straight into a file where the
 * browser lets the page write one)
 * @param {any} emulator
 * @param {any} options the machine's
 * @param {string} name
 */
async function save_state_to_file(emulator, options, name)
{
    let result = null;
    if(!options.extended_memory_size && options.memory_size + (options.vram_size || 0) < STREAMED_STATE_MEMORY)
    {
        try
        {
            result = await emulator.save_state();
        }
        catch(error)
        {
            if(!/RangeError|save_state_stream/.test(String(error && (error.stack || error.message)))) throw error;
        }
    }
    if(result)
    {
        download([result], name);
        return;
    }
    const save_picker = /** @type {any} */ (window).showSaveFilePicker;
    if(typeof save_picker === "function")
    {
        let handle;
        try { handle = await save_picker({ suggestedName: name }); }
        catch(e) { if(e.name === "AbortError") return; throw e; }
        const writable = await handle.createWritable();
        try
        {
            await emulator.save_state_stream(chunk => writable.write(chunk.slice()));
            await writable.close();
        }
        catch(e)
        {
            await writable.abort().catch(() => {});
            throw e;
        }
        return;
    }
    const parts = [];
    await emulator.save_state_stream(chunk => { parts.push(chunk.slice()); });
    download(parts, name);
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
    const set_status = text => { layout.status.dataset.state = text; render_status(); };
    let render_status = () => { layout.status.textContent = layout.status.dataset.state || ""; };
    const fail = text =>
    {
        replace(layout.notice, h("p.error", null, text, " ", h("a", { href: location.pathname }, "Back to the library")));
        set_status("");
    };

    /** @type {any} */
    let options, profile = null, config = null, store = null, lock = null, resume = null;
    const on_proxy_error = text => set_status(text);
    try
    {
        if(target.vm)
        {
            store = await VMStore.open();
            config = await store.get(target.vm);
            if(!config)
            {
                fail("There is no such virtual machine in this browser's library.");
                return;
            }
            set_title(config.name);
            // (one tab at a time: its lock, held until it powers off or the tab closes)
            lock = await hold_machine(config.id);
            if(!lock)
            {
                fail(config.name + " runs in another tab. Close it there first (a machine runs in one tab at a time).");
                return;
            }
            if(config.suspended)
            {
                resume = await resume_choice(config, store, layout.notice);
                if(resume === "cancel")
                {
                    lock.release();
                    location.href = location.pathname;
                    return;
                }
                if(resume !== "resume") config = await store.get(config.id);
            }
            const files = await resolve_files(config, store, layout.notice);
            // (a UEFI machine's variable store, docs/uefi.md: a browser disk
            // made from the template at its first power-on, written back;
            // with Secure Boot and Microsoft's keys, the template with them)
            if(config.machine.firmware === "uefi" && !config.machine.uefi_vars && config.advanced.cpu_worker)
            {
                set_status("Making the UEFI variable store...");
                try
                {
                    const disk = await import_disk(uefi_vars_template(config.machine), config.name + ": UEFI variables");
                    config.machine.uefi_vars = { kind: "browser", path: disk.path, size: disk.size };
                    await store.put(config);
                }
                catch(e)
                {
                    console.warn("The UEFI variable store could not be made (" + e.message + "): the variables stay in memory this time");
                }
            }
            // (a TPM's state, docs/tpm.md: a browser disk of zeros at the first
            // power-on, a new TPM; written back from then on)
            if(config.tpm && !config.tpm.state && config.advanced.cpu_worker)
            {
                set_status("Making the TPM's state store...");
                try
                {
                    const disk = await create_disk(TPM_STATE_SIZE, config.name + ": TPM");
                    config.tpm.state = { kind: "browser", path: disk.path, size: disk.size };
                    await store.put(config);
                }
                catch(e)
                {
                    console.warn("The TPM's state store could not be made (" + e.message + "): the TPM's state stays in memory this time");
                }
            }
            if(config.display.proxy) await load_graphics_proxy();
            // (an emulator image's GLES on the host's GPU, docs/gles-proxy-plan.md
            // E5: the WebGPU renderer's bundle; without WebGPU the guest's CPU
            // draws, this start only: a suspended machine resumes with its own)
            let android_gpu = null;
            if(config.android && config.android.gpu_mode === "host" && !config.display.proxy)
            {
                try
                {
                    await load_graphics_proxy();
                }
                catch(e)
                {
                    if(resume === "resume") throw e;
                    android_gpu = "guest";
                    set_status("The guest's CPU draws Android (" + e.message + ")");
                }
            }
            options = config_to_options(config, Object.assign(page_env(layout.screen_container, config.display.proxy, on_proxy_error),
                { file: image => files.get(image) }));
            if(android_gpu) options.android.gpu_mode = android_gpu;
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
                set_status("Loading graphics proxy...");
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

    if(resume === "resume") options.autostart = false;
    const emulator = create_emulator(options);
    if(!emulator) return;
    const name = config ? config.name : profile ? profile.name : "Custom";
    /** @type {any} */ (window).v86_console = { emulator, config, profile, options };
    console_ui(layout, emulator, { options, config, profile, query_args: target.query_args, name, fail, set_status, set_renderer: f => { render_status = f; },
        store, release: () => lock && lock.release() });
    if(resume === "resume")
    {
        // (the machine loaded, not started: its state, then it runs on; the state file is used up)
        emulator.add_listener("emulator-loaded", async () =>
        {
            set_status("Resuming ...");
            try
            {
                await emulator.restore_state_stream(await read_state(config.id));
                emulator.run();
                await delete_state(config.id);
                await store.put(Object.assign({}, config, { suspended: null }));
                replace(layout.notice);
            }
            catch(error)
            {
                replace(layout.notice, h("p.error", null, "The suspended state could not be resumed: " + error.message + " ",
                    h("button", { type: "button", onclick: async () => { await delete_state(config.id); await store.put(Object.assign({}, config, { suspended: null }));
                        location.reload(); } }, "Discard it and power on"), " ", h("a", { href: location.pathname }, "Back to the library")));
                set_status("Not resumed");
            }
        });
    }
}

/**
 * How a suspended machine starts: from its state ("resume"), afresh with the
 * state discarded ("discard"), or not ("cancel"); asked when its settings
 * changed after it was suspended, or its state is gone
 * @param {VMConfig} config
 * @param {VMStore} store
 * @param {HTMLElement} notice
 * @return {Promise<"resume" | "discard" | "cancel">}
 */
async function resume_choice(config, store, notice)
{
    const discard = async () =>
    {
        await delete_state(config.id);
        await store.put(Object.assign({}, config, { suspended: null }));
        return /** @type {"discard"} */ ("discard");
    };
    const file = await read_state(config.id);
    if(!file)
    {
        await discard();
        replace(notice, h("p", null, "The suspended state is gone (the browser's storage was cleared?): the machine starts afresh."));
        return "discard";
    }
    if(await machine_digest(config) === /** @type {any} */ (config.suspended).digest) return "resume";
    const answer = await new Promise(resolve => replace(notice, h("div.resume-choice", { role: "alert" },
        h("p", null, "The settings of " + config.name + " changed after it was suspended: its state may not fit them any more."),
        h("button.primary", { type: "button", id: "resume_anyway", onclick: () => resolve("resume") }, "Resume anyway"), " ",
        h("button", { type: "button", id: "resume_discard", onclick: () => resolve("discard") }, "Discard the state and power on"), " ",
        h("button", { type: "button", id: "resume_cancel", onclick: () => resolve("cancel") }, "Cancel"))));
    replace(notice);
    if(answer === "discard") return discard();
    return answer;
}

/**
 * What a console printed (the serial port, a virtio console), kept from power
 * on so that its drawer shows all of it when it opens: the last `limit`
 * bytes until then, everything after
 * @param {number} limit
 */
function console_output(limit)
{
    /** @type {Uint8Array[]} */
    let parts = [];
    let current = new Uint8Array(4096), used = 0, size = 0;
    /** @type {((bytes: Uint8Array) => void) | null} */
    let sink = null;
    const flush = () =>
    {
        if(!used) return;
        parts.push(current.subarray(0, used));
        size += used;
        current = new Uint8Array(4096);
        used = 0;
        while(size > limit && parts.length > 1) size -= /** @type {Uint8Array} */ (parts.shift()).length;
    };
    return {
        /** @param {Uint8Array} bytes */
        push(bytes)
        {
            if(sink) { sink(bytes); return; }
            for(let i = 0; i < bytes.length;)
            {
                const n = Math.min(bytes.length - i, current.length - used);
                current.set(bytes.subarray(i, i + n), used);
                used += n;
                i += n;
                if(used === current.length) flush();
            }
        },
        /** @param {(bytes: Uint8Array) => void} write what was kept, then what comes */
        attach(write)
        {
            flush();
            for(const part of parts) write(part);
            parts = [];
            size = 0;
            sink = write;
        },
    };
}

/**
 * The running console's controls
 * @param {ReturnType<typeof console_layout>} layout
 * @param {any} emulator
 * @param {{options: any, config: VMConfig | null, profile: any, query_args?: URLSearchParams, name: string,
 *     fail: (text: string) => void, set_status: (text: string) => void, set_renderer: (f: () => void) => void,
 *     store: VMStore | null, release: () => void}} ctx
 */
function console_ui(layout, emulator, ctx)
{
    const options = ctx.options;
    const tag = ctx.profile?.id || (ctx.config ? ctx.config.name.replace(/[^\w.-]+/g, "_") : "v86");
    const virt = options.cpu_type === "arm64";
    const written_back = [options.hda, options.hdb, options.fda, options.fdb, ...(options.virtio_disks || [])].some(d => d && d.disk_option === "read_write");
    let powered_off = false;
    let running = false;

    // ---- the status bar
    const stats = { started: 0, running_ms: 0, last_tick: 0, last_counter: 0, total: 0, ips: 0,
        disk_read: 0, disk_written: 0, disk_busy: false, net_in: 0, net_out: 0, fs_read: 0, fs_written: 0, fs_file: "",
        mode: "", resolution: "", guest_mouse: false, absolute_mouse: false, usb_tablet: false, pointer_locked: false, mouse_enabled: true };
    const status_parts = {
        state: h("span.status-state"), time: h("span"), speed: h("span"), disk: h("span"), network: h("span"), display: h("span"), mouse: h("span"),
    };
    replace(layout.status, Object.values(status_parts));
    const render = () =>
    {
        status_parts.state.textContent = layout.status.dataset.state || "";
        status_parts.time.textContent = stats.running_ms ? format_time(stats.running_ms / 1000 | 0) : "";
        status_parts.speed.textContent = stats.running_ms ? (stats.ips / 1000).toFixed(1) + " MIPS (average " + (stats.total / 1000 / stats.running_ms).toFixed(1) + ")" : "";
        status_parts.disk.textContent = stats.disk_read || stats.disk_written ? "Disk " + (stats.disk_busy ? "busy, " : "") +
            format_size(stats.disk_read) + " read, " + format_size(stats.disk_written) + " written" : "";
        status_parts.network.textContent = stats.net_in || stats.net_out ? "Network " + format_size(stats.net_in) + " in, " + format_size(stats.net_out) + " out" : "";
        status_parts.display.textContent = stats.mode ? stats.mode + " " + stats.resolution : "";
        status_parts.mouse.textContent = !stats.mouse_enabled ? "Mouse off" :
            stats.usb_tablet && !stats.pointer_locked ? "Mouse: USB tablet (absolute)" :
            stats.guest_mouse ? "Mouse: the guest's" + (stats.pointer_locked ? " (PS/2, locked)" : stats.absolute_mouse ? " (absolute)" : "") : "";
        if(details_open()) render_details();
    };
    ctx.set_renderer(render);
    const tick = () =>
    {
        const now = Date.now();
        let counter = emulator.get_instruction_counter();
        if(counter < stats.last_counter) stats.last_counter -= 0x100000000;
        const instructions = counter - stats.last_counter;
        stats.last_counter = counter;
        stats.total += instructions;
        const delta = now - stats.last_tick;
        if(delta)
        {
            stats.running_ms += delta;
            stats.last_tick = now;
            stats.ips = instructions / delta * 1000 / 1000;
        }
        render();
    };
    let interval = 0;
    emulator.add_listener("emulator-started", () =>
    {
        running = true;
        stats.last_tick = Date.now();
        clearInterval(interval);
        interval = window.setInterval(tick, 1000);
        ctx.set_status("Running");
    });
    emulator.add_listener("emulator-stopped", () =>
    {
        running = false;
        tick();
        clearInterval(interval);
        if(!powered_off) ctx.set_status("Paused");
    });
    emulator.add_listener("ide-read-start", () => { stats.disk_busy = true; });
    emulator.add_listener("ide-read-end", args => { stats.disk_busy = false; stats.disk_read += args[1]; });
    emulator.add_listener("ide-write-end", args => { stats.disk_written += args[1]; });
    emulator.add_listener("eth-receive-end", args => { stats.net_in += args[0]; });
    emulator.add_listener("eth-transmit-end", args => { stats.net_out += args[0]; });
    emulator.add_listener("9p-read-start", args => { stats.fs_file = args[0]; show_files_tab(); });
    emulator.add_listener("9p-read-end", args => { stats.fs_read += args[1]; });
    emulator.add_listener("9p-write-end", args => { stats.fs_written += args[1]; stats.fs_file = args[0]; });
    emulator.add_listener("mouse-enable", enabled => { stats.guest_mouse = enabled; render(); });
    emulator.add_listener("vmware-absolute-mouse", enabled => { stats.absolute_mouse = enabled; });
    // (the ARM machines' virtio tablet and touch screens: [active, the guest's cursor])
    emulator.add_listener("absolute-pointer", state => { stats.absolute_mouse = state[0]; render(); });
    // (the USB tablet: the pointer absolute while the guest uses it; locked, the PS/2 mouse's)
    emulator.add_listener("usb-tablet-active", active => { stats.usb_tablet = active; render(); });
    document.addEventListener("pointerlockchange", () => { stats.pointer_locked = !!document.pointerLockElement; render(); });
    emulator.add_listener("screen-set-size", args =>
    {
        const [width, height, bpp] = args;
        stats.mode = bpp ? "Graphics" : "Text";
        stats.resolution = width + "×" + height + (bpp ? "×" + bpp : "");
        render();
        if(zoom_to_fit) fit();
    });

    // ---- start and errors
    emulator.add_listener("download-progress", e =>
    {
        const file = String(e.file_name).split("?", 1)[0].split("/").pop();
        ctx.set_status(e.total ? "Downloading " + file + " " + Math.floor(e.loaded / e.total * 100) + "%" : "Downloading " + file + " ...");
    });
    emulator.add_listener("download-error", e => ctx.fail("Loading " + e.file_name + " failed. Check your connection and reload the page to try again."));
    emulator.add_listener("emulator-error", error => ctx.fail("Emulator failed: " + error.message));
    emulator.add_listener("emulator-ready", () =>
    {
        ctx.set_status("Running");
        if(ctx.query_args?.has("c")) setTimeout(() => emulator.keyboard_send_text(ctx.query_args.get("c") + "\n"), 25);
        if(ctx.query_args?.has("s")) setTimeout(() => emulator.serial0_send(ctx.query_args.get("s") + "\n"), 25);
        if(ctx.query_args?.has("theatre") && bool_arg(ctx.query_args.get("theatre"))) set_theatre(true);
        if(ctx.profile?.mouse_disabled_default || ctx.config?.advanced.mouse_disabled) set_mouse(false);
    });

    // virtio_gpu: the guest's display follows the window; Android's is its
    // device model's (a phone's, unless its settings say the window's), the
    // screen zoomed to the window: a display of a large window's size made
    // Android draw every frame of its boot at 2325x1690
    const fixed_display = ctx.config ? android_display(ctx.config) : null;
    if(fixed_display)
    {
        emulator.add_listener("emulator-ready", () =>
        {
            emulator.set_display_size(fixed_display.width, fixed_display.height);
            set_zoom_to_fit(true);
        });
    }
    else if((options.graphics_adapter || DEFAULT_GRAPHICS_ADAPTER) === "virtio_gpu")
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

    // ---- power
    const power_off = async (ask = true) =>
    {
        if(ask && !await confirm("Power off?", "The virtual machine stops as if its power were cut. What is only in its memory is lost." +
            (written_back ? " Its disks written back keep what they completed." : ""), "Power off", true)) return;
        powered_off = true;
        clearInterval(interval);
        await emulator.destroy();
        ctx.release();
        replace(layout.toolbar, h("a.button", { href: location.pathname }, "Library"), h("span.console-name", null, ctx.name));
        replace(layout.notice, h("p", null, "Powered off. ", h("a", { href: location.href }, "Power on again"), " or go back to the ",
            h("a", { href: location.pathname }, "library"), "."));
        ctx.set_status("Powered off");
    };
    const save_and_power_off = async () =>
    {
        try
        {
            const parts = [];
            await emulator.save_state_stream(chunk => { parts.push(chunk.slice()); });
            download(parts, tag + "-state.bin");
            await power_off(false);
            replace(layout.notice, h("p", null, "Saved the state (" + tag + "-state.bin, " + format_size(parts.reduce((n, p) => n + p.length, 0)) +
                ") and powered off: the disks written back are flushed and closed. Load the state with the same disks to go on. ",
                h("a", { href: location.pathname }, "Back to the library")));
        }
        catch(error)
        {
            await inform("The state was not saved", error.message);
        }
    };
    const suspend = async () =>
    {
        const config = /** @type {VMConfig} */ (ctx.config), store = /** @type {VMStore} */ (ctx.store);
        const space = await storage_space();
        const need = state_estimate(options);
        if(space.quota && space.free < need)
        {
            await inform("Not enough space to suspend", "The state needs about " + format_size(need) + "; the browser gives this site " +
                format_size(space.free) + " more. Free some (delete other machines' states or disks), or power off.");
            return;
        }
        // (once: ask the browser to keep this site's storage when it runs short)
        if(!space.persisted && !await store.get_pref("persist_asked"))
        {
            await store.put_pref("persist_asked", true);
            await navigator.storage.persist?.().catch(() => false);
        }
        ctx.set_status("Suspending ...");
        try
        {
            const size = await write_state(config.id, write => emulator.save_state_stream(write));
            await store.put(Object.assign({}, config, { suspended: { size, time: new Date().toISOString(), digest: await machine_digest(config) } }));
            await power_off(false);
            replace(layout.notice, h("p", null, "Suspended (" + format_size(size) + " in this browser's storage). Power it on from the ",
                h("a", { href: location.pathname }, "library"), " to resume it."));
            ctx.set_status("Suspended");
        }
        catch(error)
        {
            await delete_state(config.id).catch(() => {});
            await inform("The machine was not suspended", error.message);
            ctx.set_status(emulator.is_running() ? "Running" : "Paused");
        }
    };
    const save_state = async () =>
    {
        ctx.set_status("Saving the state ...");
        try { await save_state_to_file(emulator, options, tag + "-state.bin"); }
        catch(error) { await inform("The state was not saved", error.message); }
        ctx.set_status(running ? "Running" : "Paused");
    };
    const load_state = async () =>
    {
        const file = await pick_file("");
        if(!file) return;
        ctx.set_status("Loading the state ...");
        try
        {
            // (streams, large machines', are read from the file as needed:
            // odd versions, 7 and 9; src/state.js)
            const header = new DataView(await file.slice(0, 8).arrayBuffer());
            const stream = header.byteLength === 8 && header.getUint32(0, true) === 0x86768676 && header.getUint32(4, true) % 2 === 1;
            const was_running = emulator.is_running();
            if(was_running) await emulator.stop();
            if(stream) await emulator.restore_state_stream(file);
            else await emulator.restore_state(await file.arrayBuffer());
            if(was_running) emulator.run();
        }
        catch(error)
        {
            await inform("The state was not loaded", String(error.message || error) + " (the machine's configuration must be the one the state was saved with)");
        }
        ctx.set_status(emulator.is_running() ? "Running" : "Paused");
    };

    // ---- keys
    const send_keys = text =>
    {
        const { press, release } = combination_scancodes(text);
        emulator.keyboard_send_scancodes(press);
        setTimeout(() => emulator.keyboard_send_scancodes(release), 100);
    };
    const other_keys = async () =>
    {
        const text = await ask_text("Send keys", "Keys joined by + (Ctrl, Alt, Shift, Win, F1-F12, Del, Tab, Esc, Enter, letters)", "Ctrl+Alt+F1");
        if(!text) return;
        try { send_keys(text); }
        catch(error) { await inform("Send keys", error.message); }
    };

    // ---- removable devices and disk images
    const disks = ["hda", "hdb", "cdrom"].filter(name => options[name]).concat((options.virtio_disks || []).map((_, i) => "virtio_disk" + i));
    const floppy_inserted = async drive => !!(await (drive === "fda" ? emulator.get_disk_fda() : emulator.get_disk_fdb()));
    const insert_floppy = async drive =>
    {
        const file = await pick_file("");
        if(!file) return;
        await (drive === "fda" ? emulator.set_fda({ buffer: file }) : emulator.set_fdb({ buffer: file }));
    };
    const insert_cdrom = async () =>
    {
        const files = await new Promise(resolve =>
        {
            const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", multiple: true, style: { display: "none" } }));
            input.addEventListener("change", () => { resolve(Array.from(input.files || [])); input.remove(); });
            input.addEventListener("cancel", () => { resolve([]); input.remove(); });
            document.body.append(input);
            input.click();
        });
        if(!files.length) return;
        if(files.length === 1 && /\.(iso(9660|img)?|cdr)$/i.test(files[0].name)) await emulator.set_cdrom({ buffer: files[0] });
        else await emulator.set_cdrom_files(await Promise.all(files.map(async file => ({ name: file.name, contents: new Uint8Array(await file.arrayBuffer()) }))));
    };
    // USB disks: the configuration's and those plugged in since (their ids);
    // the guest's eject tells that one can be unplugged
    const usb_disks = options.usb ? (options.usb.mass_storage || []).map(disk => disk.id) : [];
    const usb_free = () => options.usb ? (USB_PORTS[options.usb.controller] || 0) - (options.usb.tablet ? 1 : 0) - usb_disks.length : 0;
    const usb_ejected = new Set();
    emulator.add_listener("usb-disk-ejected", id =>
    {
        usb_ejected.add(id);
        ctx.set_status("The guest ejected the USB disk " + id + ": it can be unplugged");
    });
    const insert_usb_disk = async () =>
    {
        const file = await pick_file("");
        if(!file) return;
        let n = 0;
        while(usb_disks.includes("usb" + n)) n++;
        const id = "usb" + n;
        try
        {
            await emulator.usb_attach_disk(id, { buffer: file });
            usb_disks.push(id);
        }
        catch(error) { await inform("The USB disk was not plugged in", error.message); }
    };
    const unplug_usb_disk = async id =>
    {
        if(!usb_ejected.has(id) && !await confirm("Unplug the USB disk " + id + "?", "The guest has not ejected it: what it has not written to it " +
            "yet is lost, and its file system may need a check. (Eject it in the guest first: \"Safely Remove Hardware\", eject.)", "Unplug", true))
        {
            return;
        }
        try
        {
            await emulator.usb_detach_disk(id);
            usb_disks.splice(usb_disks.indexOf(id), 1);
            usb_ejected.delete(id);
        }
        catch(error) { await inform("The USB disk was not unplugged", error.message); }
    };
    const get_disk_image = async name =>
    {
        ctx.set_status("Reading " + name + " ...");
        try
        {
            if(name === "fda" || name === "fdb")
            {
                const data = await (name === "fda" ? emulator.get_disk_fda() : emulator.get_disk_fdb());
                if(data) download([data], tag + "-" + name + ".img");
            }
            else
            {
                const parts = [];
                await emulator.export_disk_image(name, { write: chunk => { parts.push(chunk.slice()); } });
                download(parts, tag + "-" + name.replace(":", "-") + (name === "cdrom" ? ".iso" : ".img"));
            }
        }
        catch(error)
        {
            await inform("The disk image was not read", error.message);
        }
        ctx.set_status(emulator.is_running() ? "Running" : "Paused");
    };

    // ---- view
    let zoom_to_fit = false, theatre = false, scale = 1;
    const fit = () =>
    {
        emulator.screen_set_scale(1, 1);
        const box = layout.screen_container.getBoundingClientRect();
        const room = theatre ? { width: window.innerWidth, height: window.innerHeight } :
            { width: layout.screen_container.parentElement.clientWidth || window.innerWidth, height: window.innerHeight - 120 };
        const n = Math.max(0.1, Math.min(room.width / box.width, room.height / box.height));
        emulator.screen_set_scale(n, n);
    };
    const set_zoom_to_fit = enabled =>
    {
        zoom_to_fit = enabled;
        if(enabled)
        {
            window.addEventListener("resize", fit);
            fit();
        }
        else
        {
            window.removeEventListener("resize", fit);
            emulator.screen_set_scale(scale, scale);
        }
    };
    const set_scale = n =>
    {
        scale = n;
        if(zoom_to_fit) set_zoom_to_fit(false);
        emulator.screen_set_scale(n, n);
    };
    const show_ui = h("button.theatre-show-ui", { type: "button", hidden: true, onclick: () => set_theatre(false) }, "Leave theatre mode");
    layout.root.append(show_ui);
    const set_theatre = enabled =>
    {
        theatre = enabled;
        layout.root.classList.toggle("theatre", enabled);
        document.body.classList.toggle("theatre-body", enabled);
        show_ui.hidden = !enabled;
        if(zoom_to_fit) fit();
    };
    const screenshot = () =>
    {
        const image = /** @type {any} */ (emulator.screen_make_screenshot());
        const src = image && (image.src || (image.toDataURL && image.toDataURL("image/png")));
        if(!src) return;
        const link = h("a", { href: src, download: tag + "-screenshot.png", style: { display: "none" } });
        document.body.append(link);
        link.click();
        link.remove();
    };

    // ---- input
    let mouse_enabled = true;
    const set_mouse = enabled =>
    {
        mouse_enabled = enabled;
        stats.mouse_enabled = enabled;
        emulator.mouse_set_enabled(enabled);
        render();
    };
    const lock_mouse = () =>
    {
        if(!mouse_enabled) set_mouse(true);
        emulator.lock_mouse();
    };
    layout.screen_container.addEventListener("click", e =>
    {
        // (a guest that follows the host's cursor needs no lock; the menu's Lock mouse is still there for games)
        if(mouse_enabled && stats.guest_mouse && !stats.absolute_mouse && !stats.usb_tablet) emulator.lock_mouse();
        if(window.getSelection()?.isCollapsed)
        {
            layout.phone_keyboard.style.top = window.scrollY + e.clientY + 20 + "px";
            layout.phone_keyboard.style.left = window.scrollX + e.clientX + "px";
            layout.phone_keyboard.value = "";
            layout.phone_keyboard.focus();
        }
    });

    // ---- sound
    let muted = false;
    const has_speaker = !options.disable_speaker && emulator.set_speaker_volume(1);
    const mute = h("button#mute", { type: "button", hidden: !has_speaker, "aria-pressed": "false", onclick: () =>
    {
        muted = !muted;
        emulator.set_speaker_volume(muted ? 0 : 1);
        mute.textContent = muted ? "Unmute" : "Mute";
        mute.setAttribute("aria-pressed", String(muted));
    } }, "Mute");

    // ---- tools
    const memory_dump = async () =>
    {
        const size = (options.memory_size || 0) + (options.extended_memory_size || 0);
        const parts = [];
        ctx.set_status("Reading the memory ...");
        try
        {
            for await (const chunk of emulator.read_memory_chunks(0, Math.min(size, options.memory_size))) parts.push(chunk.slice());
            download(parts, tag + "-memory.bin");
        }
        catch(error)
        {
            await inform("The memory was not read", error.message);
        }
        ctx.set_status(emulator.is_running() ? "Running" : "Paused");
    };
    let capture = null, stop_capture = null;
    const capture_network = () =>
    {
        if(!capture)
        {
            capture = [];
            stop_capture = emulator.capture_network_traffic((direction, data) =>
            {
                capture.push({ direction, time: performance.now() / 1000, hex_dump: hex_dump(data) });
                ctx.set_status("Capturing network traffic: " + capture.length + " packets");
            });
            ctx.set_status("Capturing network traffic: 0 packets");
            return;
        }
        // (Wireshark: File, Import from Hex Dump, direction indication, timestamp %s.%f)
        download([capture.map(p => p.direction + " " + p.time.toFixed(6) + p.hex_dump + "\n").join("")], tag + "-traffic.hex", "text/plain");
        capture = [];
    };
    const end_capture = () =>
    {
        if(stop_capture) stop_capture();
        capture = null;
        stop_capture = null;
        ctx.set_status(emulator.is_running() ? "Running" : "Paused");
    };

    // ---- drawers: the serial terminal, the kernel console (the first virtio
    // console: hvc0 of the virt machine's Linux and Android), the shared
    // folder, the details. The consoles' output is kept from power on (the
    // last MiB), so a drawer opened later shows the boot from its start.
    let drawer = "";
    let files_tab = !!(ctx.config ? ctx.config.filesystem : ctx.options.filesystem && Object.keys(ctx.options.filesystem).length);
    const details_open = () => drawer === "details";
    const kernel_console = !!options.virtio_console;
    const serial_output = console_output(1 << 20), kernel_output = console_output(1 << 20);
    emulator.add_listener("serial0-output-byte", /** @param {number} byte */ byte => serial_output.push(Uint8Array.of(byte)));
    if(kernel_console) emulator.add_listener("virtio-console0-output-bytes", /** @param {Uint8Array} bytes */ bytes => kernel_output.push(bytes));
    const terminal = h("div.terminal"), kernel = h("div.terminal");
    /** @type {Promise<void> | null} */
    let xterm_loaded = null;
    /** @type {Set<HTMLElement>} */
    const terminals = new Set();
    /**
     * An xterm in `element` (once): what the console printed so far, then
     * what it prints; the keys typed go to `send`
     * @param {HTMLElement} element
     * @param {ReturnType<typeof console_output>} output
     * @param {(text: string) => void} send
     */
    const open_terminal = (element, output, send) =>
    {
        if(terminals.has(element)) return;
        terminals.add(element);
        xterm_loaded = xterm_loaded || new Promise((resolve, reject) =>
        {
            const script = document.createElement("script");
            script.src = "build/xterm.js" + query_append();
            script.onload = () => resolve(undefined);
            script.onerror = () => reject(new Error("build/xterm.js did not load"));
            document.head.append(script);
        });
        xterm_loaded.then(() =>
        {
            // (a boot's log runs to thousands of lines: xterm keeps 1000 by default)
            const term = new (/** @type {any} */ (window)).Terminal({ logLevel: "off", convertEol: true, scrollback: 10000 });
            term.open(element);
            output.attach(bytes => term.write(bytes));
            term.onData(/** @param {string} data */ data => send(data));
        }, error => ctx.set_status(error.message));
    };
    const details = h("div.details");
    // (the cards of the options: the library's defaults where they name none)
    const network_card = options.net_device && options.net_device.type || (virt ? "virtio" : "ne2k");
    const sound_card = virt ? (options.virtio_sound ? "virtio" : "none") : options.audio_device || "sb16";
    const render_details = () =>
    {
        const rows = [
            ["Machine", (options.machine_type || "i440fx") + ", " + options.cpu_type + ", " + options.cpu_cores + (options.cpu_cores === 1 ? " core" : " cores")],
            ["Memory", format_size((options.memory_size || 0) + (options.extended_memory_size || 0))],
            ["Running", stats.running_ms ? format_time(stats.running_ms / 1000 | 0) : "-"],
            ["Speed", stats.running_ms ? (stats.ips / 1000).toFixed(1) + " MIPS now, " + (stats.total / 1000 / stats.running_ms).toFixed(1) + " on average" : "-"],
            ["Instructions", String(stats.total)],
            ["Storage (" + (virt ? "virtio-blk" : options.machine_type === "q35" ? "AHCI" : "IDE") + ")", format_size(stats.disk_read) + " read, " +
                format_size(stats.disk_written) + " written" + (stats.disk_busy ? ", busy" : "")],
            ["Network", (NIC_LABELS[network_card] || network_card) + (network_card === "none" ? "" :
                ": " + format_size(stats.net_in) + " received, " + format_size(stats.net_out) + " sent")],
            ["Sound", (SOUND_LABELS[sound_card] || sound_card) + (options.disable_speaker ? ", muted" : "")],
            ["Shared folder", stats.fs_file ? format_size(stats.fs_read) + " read, " + format_size(stats.fs_written) + " written, last " + stats.fs_file : "-"],
            ["Display", stats.mode ? stats.mode + ", " + stats.resolution : "-"],
            ["Mouse", stats.usb_tablet ? "the USB tablet (absolute)" + (stats.pointer_locked ? "; locked: PS/2" : "") :
                stats.guest_mouse ? "used by the guest" + (stats.absolute_mouse ? " (absolute)" : "") : "not used by the guest"],
            ["USB", options.usb ? options.usb.controller.toUpperCase() + (options.usb.tablet ? ", tablet" : "") : "none"],
        ];
        replace(details, h("table.hardware", null, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", null, k), h("td", null, v))))),
            h("p.note#usb_devices"), h("p.note#execution"));
        // (each USB device's controller and speed: EHCI's companions have the full-speed ones)
        if(options.usb) emulator.usb_devices().then(list =>
        {
            const element = details.querySelector("#usb_devices");
            if(element) element.textContent = "USB devices: " + (list.map(d => d.id + " (port " + (d.port + 1) + ", " +
                (d.plugged ? (d.controller === "ehci" ? "EHCI" : options.usb.controller === "ehci" ? "UHCI companion" : "UHCI") + ", " + d.speed + " Mbit/s" :
                    "out of its port") + ")").join("; ") || "none");
        }, () => {});
        emulator.get_diagnostics().then(diagnostics =>
        {
            const execution = diagnostics && diagnostics.execution;
            const fallback = execution && execution.fallback;
            const text = options.cpu_cores === 1 ? "1 core" : execution && execution.mode === "parallel" ? options.cpu_cores + " cores, each in a host thread" :
                options.cpu_cores + " cores taking turns on one thread" + (fallback && fallback !== "not requested" ? " (parallel unavailable: " + fallback + ")" : "");
            const element = details.querySelector("#execution");
            if(element) element.textContent = "Execution: " + text;
        }).catch(() => {});
    };
    const files_panel = () =>
    {
        const send = /** @type {HTMLInputElement} */ (h("input", { type: "file", multiple: true, "aria-label": "Send files" }));
        send.addEventListener("change", async () =>
        {
            for(const file of Array.from(send.files || []))
            {
                await emulator.create_file("/" + file.name, new Uint8Array(await file.arrayBuffer()));
            }
            send.value = "";
            ctx.set_status("Sent to the shared folder");
        });
        const path = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "/file.txt", "aria-label": "File to get" }));
        const get = async () =>
        {
            try
            {
                const data = await emulator.read_file(path.value.trim());
                download([data], path.value.trim().split("/").pop() || "file");
            }
            catch(error)
            {
                await inform("The file was not read", "Can't read " + path.value + ": " + (error.message || error));
            }
        };
        path.addEventListener("keydown", e => { if(e.key === "Enter") get(); });
        return [
            h("p.note", null, "The shared folder (9p): in the guest, mount it (Linux: mount -t 9p host9p /mnt)."),
            h("label.field", null, h("span", null, "Send files into it"), send),
            h("label.field", null, h("span", null, "Get a file from it"), path), h("button", { type: "button", onclick: get }, "Get"),
        ];
    };
    const open_drawer = name =>
    {
        drawer = drawer === name ? "" : name;
        layout.drawer.hidden = !drawer;
        layout.root.classList.toggle("with-drawer", !!drawer);
        if(!drawer) { update_toolbar(); return; }
        const title = { terminal: "Serial terminal", kernel: "Kernel console", files: "Shared folder", details: "Details" }[drawer];
        replace(layout.drawer, h("header", null, h("h2", null, title), h("button", { type: "button", "aria-label": "Close", onclick: () => open_drawer("") }, "×")),
            drawer === "terminal" ? terminal : drawer === "kernel" ? kernel : drawer === "files" ? files_panel() : details);
        // (the serial port takes bytes: the keys' UTF-8 as characters 0-255)
        if(drawer === "terminal") open_terminal(terminal, serial_output, data => emulator.serial0_send(String.fromCharCode(...new TextEncoder().encode(data))));
        if(drawer === "kernel") open_terminal(kernel, kernel_output, data => emulator.virtio_console_send(data));
        if(drawer === "details") render_details();
        update_toolbar();
    };
    const show_files_tab = () =>
    {
        if(files_tab) return;
        files_tab = true;
        update_toolbar();
    };
    emulator.add_listener("9p-attach", show_files_tab);

    // ---- the disk error dialog (disk_error "stop": retry or power off; "report": the guest was told)
    emulator.add_listener("disk-error", async event =>
    {
        const stop = event.policy === "stop";
        const text = "Disk " + event.disk + ": the " + event.operation + " of " + event.length + " bytes at " + event.offset + " failed: " + event.reason + ". " +
            (!stop ? "The guest was told." : event.retryable ? "The machine is stopped: retry once the disk can be reached again, or power off." :
                "The machine is stopped: this cannot be retried; continue (the guest is told), or power off.");
        const answer = await dialog({
            title: "Disk error",
            body: h("p#disk_error_text", null, text),
            buttons: stop ? [{ label: "Power off", value: "off", danger: true }, { label: event.retryable ? "Retry" : "Continue", value: "run", primary: true }] :
                [{ label: "OK", value: "ok", primary: true }],
        });
        if(answer === "run" || answer === undefined && stop) emulator.run();
        if(answer === "off")
        {
            await power_off(false);
            replace(layout.notice, h("p", null, "Powered off: the requests still waiting for the disk are dropped, as by a power loss. ",
                h("a", { href: location.pathname }, "Back to the library")));
        }
    });

    // ---- leaving the page: disks written back, and Ctrl+W (which the guest cannot get)
    let ctrl = false;
    const ctrl_state = e => { ctrl = !!e.ctrlKey; };
    window.addEventListener("keydown", ctrl_state, true);
    window.addEventListener("keyup", ctrl_state, true);
    window.addEventListener("blur", () => { ctrl = false; });
    window.addEventListener("beforeunload", e =>
    {
        if(powered_off) return;
        if(written_back || ctrl)
        {
            e.preventDefault();
            e.returnValue = "";
        }
    });

    // ---- the toolbar
    /** @type {Object<string, () => Array<import("./dom.js").MenuItem | "-">>} */
    const items = {
        power: () => [
            { label: running ? "Pause" : "Run", id: "menu_run", action: () => running ? emulator.stop() : emulator.run() },
            { label: "Reset", id: "menu_reset", disabled: !!options.initial_state, title: options.initial_state ? "Started from a saved state" : "", action: () => emulator.restart() },
            { label: "Power off…", id: "menu_power_off", action: () => power_off() },
            ...(ctx.config ? [{ label: "Suspend", id: "menu_suspend", action: suspend }] : []),
            ...(written_back ? [{ label: "Save and power off", id: "menu_save_and_power_off", action: save_and_power_off }] : []),
            "-",
            { label: "Save the state to a file", id: "menu_save_state", action: save_state },
            { label: "Load a state from a file…", id: "menu_load_state", action: load_state },
        ],
        keys: () => [
            ...COMBINATIONS.map(c => ({ label: c, id: "keys_" + c.replace(/\W+/g, "_"), action: () => send_keys(c) })),
            "-",
            { label: "Other keys…", id: "keys_other", action: other_keys },
        ],
        devices: () => [
            ...(options.cdrom || !virt ? [{ label: "CD/DVD: insert an image or files…", id: "devices_insert_cdrom", action: insert_cdrom },
                { label: "CD/DVD: eject", id: "devices_eject_cdrom", action: () => emulator.eject_cdrom() }] : []),
            ...(!virt ? [
                { label: "Floppy A: insert…", id: "devices_insert_fda", action: () => insert_floppy("fda") },
                { label: "Floppy A: eject", id: "devices_eject_fda", action: () => emulator.eject_fda() },
                { label: "Floppy B: insert…", id: "devices_insert_fdb", action: () => insert_floppy("fdb") },
                { label: "Floppy B: eject", id: "devices_eject_fdb", action: () => emulator.eject_fdb() },
            ] : []),
            ...(options.usb && !virt ? [
                "-",
                ...(usb_free() > 0 ? [{ label: "USB disk: plug in an image…", id: "devices_usb_insert", action: insert_usb_disk }] : []),
                ...usb_disks.map(id => ({ label: "USB disk " + id + ": unplug" + (usb_ejected.has(id) ? " (ejected)" : "…"), id: "devices_usb_unplug_" + id,
                    action: () => unplug_usb_disk(id) })),
            ] : []),
            "-",
            ...disks.concat(usb_disks.map(id => "usb:" + id), virt ? [] : ["fda", "fdb"]).map(name => ({ label: "Download the " + name + " image",
                id: "devices_get_" + name.replace(":", "_"), action: () => get_disk_image(name) })),
        ],
        view: () => [
            { label: "Full screen", id: "view_fullscreen", action: () => emulator.screen_go_fullscreen() },
            { label: "Zoom to fit", id: "view_zoom_to_fit", checked: zoom_to_fit, action: () => set_zoom_to_fit(!zoom_to_fit) },
            ...SCALES.map(n => ({ label: "Scale " + n * 100 + "%", id: "view_scale_" + n * 100, checked: !zoom_to_fit && scale === n, action: () => set_scale(n) })),
            { label: "Theatre mode", id: "view_theatre", checked: theatre, action: () => set_theatre(!theatre) },
            "-",
            { label: "Screenshot", id: "view_screenshot", action: screenshot },
        ],
        input: () => [
            { label: "Mouse", id: "input_mouse", checked: mouse_enabled, action: () => set_mouse(!mouse_enabled) },
            { label: "Lock the mouse", id: "input_lock_mouse", action: lock_mouse },
        ],
        tools: () => [
            { label: "Memory dump", id: "tools_memory_dump", action: memory_dump },
            { label: capture ? "Save the " + capture.length + " packets captured" : "Capture network traffic", id: "tools_capture", action: capture_network },
            ...(capture ? [{ label: "Stop capturing", id: "tools_stop_capture", action: end_capture }] : []),
        ],
    };
    const drawer_button = (name, label) => h("button", { type: "button", id: "drawer_" + name, "aria-pressed": String(drawer === name),
        class: drawer === name ? "pressed" : "", onclick: () => open_drawer(name) }, label);
    const update_toolbar = () =>
    {
        if(powered_off) return;
        replace(layout.toolbar,
            h("a.button", { href: location.pathname }, "Library"),
            menu_button("Power", items.power, "menu_power"),
            menu_button("Keys", items.keys, "menu_keys"),
            menu_button("Devices", items.devices, "menu_devices"),
            menu_button("View", items.view, "menu_view"),
            menu_button("Input", items.input, "menu_input"),
            mute,
            menu_button("Tools", items.tools, "menu_tools"),
            h("span.toolbar-gap"),
            drawer_button("terminal", "Terminal"),
            kernel_console ? drawer_button("kernel", "Kernel console") : null,
            files_tab ? drawer_button("files", "Files") : null,
            drawer_button("details", "Details"),
            h("span.console-name", null, ctx.name));
    };
    update_toolbar();
    ctx.set_status("Starting ...");
}
