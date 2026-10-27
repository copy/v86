import { V86 } from "./starter.js";
import { LOG_NAMES } from "../const.js";
import { SyncBuffer, SyncFileBuffer } from "../buffer.js";
import { h, pad0, pads, hex_dump, dump_file, download } from "../lib.js";
import { log_data, LOG_LEVEL, set_log_level } from "../log.js";
import * as iso9660 from "../iso9660.js";
import { DEFAULT_CPU_CORES, DEFAULT_GRAPHICS_ADAPTER, MAX_ARRAY_BUFFER_SIZE_MB, settings_to_options } from "./vm_options.js";
import { bool_arg, cpu_type_arg, machine_type_arg, start_settings, format_query_args } from "./query_compat.js";


// (served from this computer: the local network relay)
const ON_LOCALHOST = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

function query_append()
{
    const version = $("version");
    return version ? "?" + version.textContent : "";
}

function set_title(text)
{
    document.title = text + " - v86" +  (DEBUG ? " - debug" : "");
    const description = document.querySelector("meta[name=description]");
    description && (description.content = "Running " + text);
}

function format_timestamp(time)
{
    if(time < 60)
    {
        return time + "s";
    }
    else if(time < 3600)
    {
        return (time / 60 | 0) + "m " + pad0(time % 60, 2) + "s";
    }
    else
    {
        return (time / 3600 | 0) + "h " +
            pad0((time / 60 | 0) % 60, 2) + "m " +
            pad0(time % 60, 2) + "s";
    }
}

function read_file(file)
{
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = e => reject(e);
        fr.readAsArrayBuffer(file);
    });
}

let progress_ticks = 0;

function show_progress(e)
{
    const el = $("loading");
    el.style.display = "block";

    const file_name = e.file_name.split("?", 1)[0];

    if(file_name.endsWith(".wasm"))
    {
        const parts = file_name.split("/");
        el.textContent = "Fetching " + parts[parts.length - 1] + " ...";
        return;
    }

    if(e.file_index === e.file_count - 1 && e.loaded >= e.total - 2048)
    {
        // last file is (almost) loaded
        el.textContent = "Done downloading. Starting now ...";
        return;
    }

    let line = "Downloading images ";

    if(typeof e.file_index === "number" && e.file_count)
    {
        line += "[" + (e.file_index + 1) + "/" + e.file_count + "] ";
    }

    if(e.total && typeof e.loaded === "number")
    {
        var per100 = Math.floor(e.loaded / e.total * 100);
        per100 = Math.min(100, Math.max(0, per100));

        var per50 = Math.floor(per100 / 2);

        line += per100 + "% [";
        line += "#".repeat(per50);
        line += " ".repeat(50 - per50) + "]";
    }
    else
    {
        line += ".".repeat(progress_ticks++ % 50);
    }

    el.textContent = line;
}

function $(id)
{
    return document.getElementById(id);
}

/** RAM and video memory from which the page saves states as V7 streams */
const STREAMED_STATE_MEMORY = 1024 * 1024 * 1024;

/**
 * (docs/disk-persistence-plan.md D3: the page's notes about its disks)
 * @param {string} text
 */
function show_disk_status(text)
{
    $("disk_status").textContent = text;
    $("disk_status").style.display = "";
}

/**
 * Save a V7 snapshot, which never exists in one buffer: straight into a file
 * where the browser lets the page write one, else collected into a Blob
 * @param {V86} emulator
 * @param {string} name
 */
async function save_state_stream_to_file(emulator, name)
{
    if(typeof window["showSaveFilePicker"] === "function")
    {
        let handle;
        try
        {
            handle = await window["showSaveFilePicker"]({ "suggestedName": name });
        }
        catch(e)
        {
            if(e.name === "AbortError") return;
            throw e;
        }
        const writable = await handle["createWritable"]();
        try
        {
            await emulator.save_state_stream(chunk => writable["write"](chunk.slice()));
            await writable["close"]();
        }
        catch(e)
        {
            await writable["abort"]().catch(() => {});
            throw e;
        }
        return;
    }
    const parts = [];
    await emulator.save_state_stream(chunk => { parts.push(chunk.slice()); });
    dump_file(parts, name);
}

// These values were previously stored in localStorage
const elements_to_restore = [
    "memory_size",
    "video_memory_size",
    "networking_proxy",
    "disable_audio",
    "enable_acpi",
    "boot_order",
];
for(const item of elements_to_restore)
{
    try
    {
        window.localStorage.removeItem(item);
    }
    catch(e) {}
}

function onload()
{
    if(!window.WebAssembly)
    {
        alert("Your browser is not supported because it doesn't support WebAssembly");
        return;
    }

    $("start_emulation").onclick = function(e)
    {
        start_emulation(null, null);
        $("start_emulation").blur();
        e.preventDefault();
    };

    if(DEBUG)
    {
        debug_onload();
    }

    if(DEBUG && ON_LOCALHOST)
    {
        // don't use online relay in debug mode
        $("relay_url").value = "ws://localhost:8080/";
    }

    const query_args = new URLSearchParams(location.search);
    if(query_args.has("graphics_proxy")) $("graphics_proxy").checked = bool_arg(query_args.get("graphics_proxy"));
    // (the systems this page starts by ?profile=<id>: in DEBUG, the kvm-unit-tests)
    const oses = [];

    if(DEBUG)
    {
        // see tests/kvm-unit-tests/x86/
        const tests = [
            "realmode",
            // All tests below require an APIC
            "cmpxchg8b",
            "port80",
            "setjmp",
            "sieve",
            "hypercall", // crashes
            "init", // stops execution
            "msr", // TODO: Expects 64 bit msrs
            "smap", // test stops, SMAP not enabled
            "tsc_adjust", // TODO: IA32_TSC_ADJUST
            "tsc", // TODO: rdtscp
            "rmap_chain", // crashes
            "memory", // missing mfence (uninteresting)
            "taskswitch", // TODO: Jump
            "taskswitch2", // TODO: Call TSS
            "eventinj", // Missing #nt
            "ioapic",
            "apic",
        ];

        for(const test of tests)
        {
            oses.push({
                name: "Test case: " + test,
                id: "test-" + test,
                memory_size: 128 * 1024 * 1024,
                multiboot: { url: "tests/kvm-unit-tests/x86/" + test + ".flat" }
            });
        }
    }

    const profile = query_args.get("profile");

    if(!profile && !DEBUG)
    {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = "build/v86.wasm" + query_append();
        document.head.appendChild(link);
    }

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = "build/xterm.js";
    document.head.appendChild(link);

    for(const os of oses)
    {
        if(profile === os.id)
        {
            start_emulation(os, query_args);
            return;
        }

        const element = $("start_" + os.id);

        if(element)
        {
            element.onclick = e =>
            {
                if(!e.ctrlKey)
                {
                    e.preventDefault();
                    element.blur();
                    start_emulation(os, null);
                }
            };
        }
    }

    if(profile === "custom")
    {
        // TODO: if one of the file form fields has a value (firefox), start here?

        if(query_args.has("hda.url") || query_args.has("cdrom.url") || query_args.has("fda.url"))
        {
            start_emulation(null, query_args);
            return;
        }
    }

    if(query_args.has("m")) $("memory_size").value = query_args.get("m");
    if(query_args.has("cores")) $("cpu_cores").value = query_args.get("cores");
    if(query_args.has("parallel")) $("parallel").checked = bool_arg(query_args.get("parallel"));
    $("cpu_type").value = cpu_type_arg(query_args) || $("cpu_type").value;
    $("machine_type").value = machine_type_arg(query_args) || $("machine_type").value;
    if(query_args.has("vram")) $("vga_memory_size").value = query_args.get("vram");
    if(query_args.has("graphics_adapter")) $("graphics_adapter").value = query_args.get("graphics_adapter");
    if(query_args.has("relay_url")) $("relay_url").value = query_args.get("relay_url");
    if(query_args.has("mute")) $("disable_audio").checked = bool_arg(query_args.get("mute"));
    if(query_args.has("acpi")) $("acpi").checked = bool_arg(query_args.get("acpi"));
    if(query_args.has("boot_order")) $("boot_order").value = query_args.get("boot_order");
    if(query_args.has("net_device_type")) $("net_device_type").value = query_args.get("net_device_type");
    if(query_args.has("audio_device")) $("audio_device").value = query_args.get("audio_device");
    if(query_args.has("mtu")) $("mtu").value = query_args.get("mtu");
    if(query_args.has("modem")) $("modem").value = query_args.get("modem");

    $("mtu_ui").style.display = $("net_device_type").value === "virtio" ? "table-row" : "none";
    $("net_device_type").onchange = function()
    {
        $("mtu_ui").style.display = $("net_device_type").value === "virtio" ? "table-row" : "none";
        $("net_device_type").blur();
    };

    for(const dev of ["fda", "fdb"])
    {
        const toggle = $(dev + "_toggle_empty_disk");
        if(!toggle) continue;

        toggle.onclick = function(e)
        {
            e.preventDefault();
            const select = document.createElement("select");
            select.id = dev + "_empty_size";
            for(const n_sect of [320, 360, 400, 640, 720, 800, 1440, 2400, 2880, 3444, 5760, 7680])
            {
                const n_bytes = n_sect * 512, kb = 1024, MB = kb * 1000;
                const option = document.createElement("option");
                if(n_bytes < MB)
                {
                    option.textContent = (n_bytes / kb) + " kB";
                }
                else
                {
                    option.textContent = (n_bytes / MB).toFixed(2) + " MB";
                }
                if(n_sect === 2880)
                {
                    option.selected = true;
                }
                option.value = n_bytes;
                select.appendChild(option);
            }
            // TODO (when closure compiler supports it): parent.parentNode.replaceChildren(...);
            const parent = toggle.parentNode;
            parent.innerHTML = "";
            parent.append("Empty disk of ", select);
        };
    }

    for(const dev of ["hda", "hdb"])
    {
        const toggle = $(dev + "_toggle_empty_disk");
        if(!toggle) continue;

        toggle.onclick = function(e)
        {
            e.preventDefault();
            const input = document.createElement("input");
            input.id = dev + "_empty_size";
            input.type = "number";
            input.min = "0";
            input.max = String(MAX_ARRAY_BUFFER_SIZE_MB);
            input.step = "100";
            input.value = "100";
            // TODO (when closure compiler supports it): parent.parentNode.replaceChildren(...);
            const parent = toggle.parentNode;
            parent.innerHTML = "";
            parent.append("Empty disk of ", input, " MB");
        };
    }

    const os_info = Array.from(document.querySelectorAll("#oses a.tr")).map(element =>
    {
        const [_, size_raw, unit] = element.children[1].textContent.match(/([\d\.]+)\+? (\w+)/);
        let size = +size_raw;
        if(unit === "MB") size *= 1024 * 1024;
        else if(unit === "KB") size *= 1024;
        return {
            element,
            size,
            graphical: element.children[2].firstChild.className === "gui_icon",
            family: element.children[3].textContent.replace(/-like/, ""),
            arch: element.children[4].textContent,
            status: element.children[5].textContent,
            source: element.children[6].textContent,
            languages: new Set(element.children[7].textContent.split(", ")),
            medium: element.children[8].textContent,
        };
    });

    const known_filter = [
        [   // Family:
            { id: "linux", condition: os => os.family === "Linux" },
            { id: "bsd", condition: os => os.family === "BSD" },
            { id: "windows", condition: os => os.family === "Windows" },
            { id: "unix", condition: os => os.family === "Unix" },
            { id: "dos", condition: os => os.family === "DOS" },
            { id: "custom", condition: os => os.family === "Custom" },
        ],
        [   // UI:
            { id: "graphical", condition: os => os.graphical },
            { id: "text", condition: os => !os.graphical },
        ],
        [   // Medium:
            { id: "floppy", condition: os => os.medium === "Floppy" },
            { id: "cd", condition: os => os.medium === "CD" },
            { id: "hd", condition: os => os.medium === "HD" },
        ],
        [   // Size:
            { id: "bootsector", condition: os => os.size <= 512 },
            { id: "lt5mb", condition: os => os.size <= 5 * 1024 * 1024 },
            { id: "gt5mb", condition: os => os.size > 5 * 1024 * 1024 },
        ],
        [   // Status:
            { id: "modern", condition: os => os.status === "Modern" },
            { id: "historic", condition: os => os.status === "Historic" },
        ],
        [   // License:
            { id: "opensource", condition: os => os.source === "Open-source" },
            { id: "proprietary", condition: os => os.source === "Proprietary" },
        ],
        [   // Arch:
            { id: "16bit", condition: os => os.arch === "16-bit" },
            { id: "32bit", condition: os => os.arch === "32-bit" },
        ],
        [   // Lang:
            { id: "asm", condition: os => os.languages.has("ASM") },
            { id: "c", condition: os => os.languages.has("C") },
            { id: "cpp", condition: os => os.languages.has("C++") },
            { id: "other_lang", condition: os => ["ASM", "C", "C++"].every(lang => !os.languages.has(lang)) },
        ],
    ];

    const defined_filter = [];
    for(const known_category of known_filter)
    {
        const category = known_category.filter(filter => {
            const element = document.getElementById(`filter_${filter.id}`);
            if(element)
            {
                element.onchange = update_filters;
                filter.element = element;
            }
            return element;
        });
        if(category.length)
        {
            defined_filter.push(category);
        }
    }

    function update_filters()
    {
        const conjunction = [];
        for(const category of defined_filter)
        {
            const disjunction = category.filter(filter => filter.element.checked);
            if(disjunction.length)
            {
                conjunction.push(disjunction);
            }
        }
        for(const os of os_info)
        {
            os.element.style.display = conjunction.every(disjunction => disjunction.some(filter => filter.condition(os))) ? "" : "none";
        }
    }

    if($("reset_filters"))
    {
        $("reset_filters").onclick = function()
        {
            for(const element of document.querySelectorAll("#filter input[type=checkbox]"))
            {
                element.checked = false;
            }
            update_filters();
        };
    }

    function set_proxy_value(id, value)
    {
        const elem = $(id);
        if(elem)
        {
            elem.onclick = () => $("relay_url").value = value;
        }
    }
    set_proxy_value("network_none", "");
    set_proxy_value("network_inbrowser", "inbrowser");
    set_proxy_value("network_fetch", "fetch");
    set_proxy_value("network_relay", "wss://relay.widgetry.org/");
    set_proxy_value("network_wisp", "wisps://wisp.mercurywork.shop/v86/");
}

function debug_onload()
{
    // called on window.onload, in debug mode

    const log_levels = $("log_levels");

    if(!log_levels)
    {
        return;
    }

    for(let i = 0; i < LOG_NAMES.length; i++)
    {
        const mask = LOG_NAMES[i][0];

        if(mask === 1)
            continue;

        const name = LOG_NAMES[i][1].toLowerCase();
        const input = document.createElement("input");
        const label = document.createElement("label");

        input.type = "checkbox";

        label.htmlFor = input.id = "log_" + name;

        if(LOG_LEVEL & mask)
        {
            input.checked = true;
        }
        input.mask = mask;

        label.append(input, pads(name, 4) + " ");
        log_levels.appendChild(label);

        if(i === Math.floor(LOG_NAMES.length / 2))
        {
            log_levels.append("\n");
        }
    }

    log_levels.onchange = function(e)
    {
        const target = e.target;
        const mask = target.mask;

        if(target.checked)
        {
            set_log_level(LOG_LEVEL | mask);
        }
        else
        {
            set_log_level(LOG_LEVEL & ~mask);
        }

        target.blur();
    };
}

window.addEventListener("load", onload, false);

// old webkit fires popstate on every load, fuck webkit
// https://code.google.com/p/chromium/issues/detail?id=63040
window.addEventListener("load", function()
{
    setTimeout(function()
    {
        window.addEventListener("popstate", onpopstate);
    }, 0);
});

// works in firefox and chromium
if(document.readyState === "complete")
{
    onload();
}

function set_graphics_proxy_status(message)
{
    const status = $("graphics_proxy_status");
    status.textContent = message;
    status.style.display = message ? "block" : "none";
}

async function load_graphics_proxy()
{
    if(!navigator["gpu"])
    {
        throw new Error("WebGPU is unavailable. Use a WebGPU-capable browser over HTTPS or localhost.");
    }
    if(typeof window["V86GraphicsProxy"] === "function") return;

    // Fetch the current revision so the bundle and shader workers use matching assets.
    const response = await fetch("build/glbridge/manifest.json", { cache: "no-store" });
    if(!response.ok) throw new Error("Graphics bundle is missing. Run make glbridge and reload.");
    const manifest = await response.json();
    await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "build/glbridge/libv86-webgpu.js?v=" + encodeURIComponent(manifest["revision"]);
        script.onload = () => resolve();
        script.onerror = () => {
            script.remove();
            reject(new Error("Could not load the graphics bundle. Run make glbridge and reload."));
        };
        document.head.appendChild(script);
    });
    if(typeof window["V86GraphicsProxy"] !== "function")
    {
        throw new Error("Graphics bundle did not initialize. Check the browser console and rebuild with make glbridge.");
    }
}

/**
 * The boot form's fields (src/browser/vm_options.js, DEFAULT_FORM)
 * @return {!Object}
 */
function read_form()
{
    const file = id => $(id)?.files[0];
    return {
        relay_url: $("relay_url").value,
        disable_audio: $("disable_audio").checked,
        files: {
            bios: file("bios"),
            vga_bios: file("vga_bios"),
            fda: file("fda_image"),
            fdb: file("fdb_image"),
            cdrom: file("cdrom_image"),
            hda: file("hda_image"),
            hdb: file("hdb_image"),
            multiboot: file("multiboot_image"),
            bzimage: file("bzimage"),
            initrd: file("initrd"),
        },
        empty_sizes: {
            fda: +$("fda_empty_size")?.value,
            fdb: +$("fdb_empty_size")?.value,
            hda: +$("hda_empty_size")?.value,
            hdb: +$("hdb_empty_size")?.value,
        },
        // (read by the disk's name: quoted, or Closure renames them)
        urls: { "hda": $("hda_url")?.value, "hdb": $("hdb_url")?.value },
        disk_options: { "hda": $("hda_disk_option")?.value, "hdb": $("hdb_disk_option")?.value },
        memory_size: $("memory_size").value,
        vga_memory_size: $("vga_memory_size").value,
        graphics_adapter: $("graphics_adapter").value,
        boot_order: $("boot_order").value,
        cpu_cores: $("cpu_cores").value,
        parallel: $("parallel").checked,
        cpu_type: $("cpu_type").value,
        machine_type: $("machine_type").value,
        acpi: $("acpi").checked,
        net_device_type: $("net_device_type").value,
        audio_device: $("audio_device").value,
        mtu: $("mtu").value,
        modem: $("modem").value,
    };
}

// we can get here in various ways:
// - the user clicked on the "start emulation" button
// - the user clicked on a profile
// - the ?profile= query parameter specified a valid profile
// - the ?profile= query parameter was set to "custom" and at least one disk image was given
async function start_emulation(profile, query_args)
{
    $("boot_options").style.display = "none";

    const graphics_proxy = query_args?.has("graphics_proxy") ?
        bool_arg(query_args.get("graphics_proxy")) : $("graphics_proxy").checked;
    set_graphics_proxy_status("");
    if(graphics_proxy)
    {
        set_graphics_proxy_status("Loading graphics proxy...");
        try
        {
            await load_graphics_proxy();
            set_graphics_proxy_status("");
        }
        catch(error)
        {
            set_graphics_proxy_status("Graphics proxy could not start: " + error.message);
            $("boot_options").style.display = "block";
            return;
        }
    }

    // the settings of the profile, the address and the form (src/browser/query_compat.js)
    const start = start_settings(profile, query_args, read_form(),
        { location_args: new URLSearchParams(window.location.search), origin: location.origin, debug: DEBUG, graphics_proxy });
    const settings = start.settings;

    if(profile)
    {
        if(profile.state)
        {
            $("reset").style.display = "none";
        }

        set_title(profile.name);

        if(!DEBUG && profile.homepage)
        {
            $("description").style.display = "block";
            const link = document.createElement("a");
            link.href = profile.homepage;
            link.textContent = profile.name;
            link.target = "_blank";
            $("description").append(document.createTextNode("Running "), link);
        }
    }

    if(start.error)
    {
        alert(start.error);
        $("boot_options").style.display = "block";
        return;
    }
    for(const id of ["memory_size", "vga_memory_size", "cpu_type", "machine_type"])
    {
        if(start.updates[id] !== undefined) $(id).value = start.updates[id];
    }
    if(start.updates["acpi"]) $("acpi").checked = true;
    if(start.title)
    {
        set_title(start.title);
    }

    if(!query_args)
    {
        push_state(start.new_query_args);
    }

    const options = settings_to_options(settings, {
        cpu_worker: start.cpu_worker,
        debug: DEBUG,
        query_append: query_append(),
        graphics_proxy: graphics_proxy && {
            "onError": error => {
                console.error("Graphics proxy initialization failed", error);
                set_graphics_proxy_status("Graphics proxy failed; VGA remains available: " + error.message);
            },
        },
        screen_container: $("screen_container"),
    });

    // (tests/app/legacy_options.mjs: the options this page gives V86, recorded
    // instead of starting the emulator)
    if(typeof window["v86_record_options"] === "function")
    {
        window["v86_record_options"](options);
        return;
    }

    const emulator = new V86(options);

    if(DEBUG) window.emulator = emulator;

    // virtio_gpu: the guest's display follows the window (the guest's
    // driver asks for the new size after a display event); with several
    // displays (?displays=N), each gets its share of the width
    if((settings.graphics_adapter || DEFAULT_GRAPHICS_ADAPTER) === "virtio_gpu")
    {
        let resize_timer = 0;
        const displays = settings.displays || 1;
        const report_display_size = () => {
            clearTimeout(resize_timer);
            resize_timer = setTimeout(() => {
                for(let i = 0; i < displays; i++) emulator.set_display_size(Math.floor(window.innerWidth / displays), window.innerHeight, i);
            }, 250);
        };
        window.addEventListener("resize", report_display_size);
        emulator.add_listener("emulator-ready", report_display_size);
    }

    emulator.add_listener("emulator-ready", function()
    {
        if(DEBUG && !emulator.worker_controller)
        {
            debug_start(emulator);
        }
        else if(DEBUG)
        {
            // the CPU is in the Worker (a release build): nothing to inspect here
            for(const id of ["dump_regs", "dump_gdt", "dump_idt", "dump_pt"])
            {
                $(id).disabled = true;
                $(id).title = "The CPU runs in a Worker; open debug.html?cpu_worker=0 to debug it in the page";
            }
        }

        if(!emulator.worker_controller && emulator.v86.cpu.wm.exports["profiler_is_enabled"]())
        {
            const CLEAR_STATS = false;

            const panel = document.createElement("pre");
            document.body.appendChild(panel);

            setInterval(function()
                {
                    if(!emulator.is_running())
                    {
                        return;
                    }

                    panel.textContent = emulator.get_instruction_stats();

                    CLEAR_STATS && emulator.v86.cpu.clear_stats();
                }, CLEAR_STATS ? 5000 : 1000);
        }

        init_ui(profile, settings, emulator);

        if(query_args?.has("c"))
        {
            setTimeout(function()
            {
                emulator.keyboard_send_text(query_args.get("c") + "\n");
            }, 25);
        }

        if(query_args?.has("s"))
        {
            setTimeout(function()
            {
                emulator.serial0_send(query_args.get("s") + "\n");
            }, 25);
        }

        if(query_args?.has("theatre") && bool_arg(query_args?.get("theatre")))
        {
            $("toggle_theatre").click();
        }
    });

    emulator.add_listener("emulator-loaded", function()
    {
        if(emulator.worker_controller ? !emulator.worker_controller.device_info["cdrom"] : !emulator.v86.cpu.devices.cdrom)
        {
            $("change_cdrom_image").style.display = "none";
        }
        // how the cores run: in host threads, or taking turns (and why)
        const cores = settings.cpu_cores || DEFAULT_CPU_CORES;
        Promise.resolve(emulator.get_diagnostics()).then(diagnostics => {
            const execution = diagnostics && diagnostics["execution"];
            const fallback = execution && execution["fallback"];
            $("info_execution").textContent = cores === 1 ? "1 core" :
                execution && execution["mode"] === "parallel" ? cores + " cores, each in a host thread" :
                cores + " cores taking turns on one thread" +
                    (fallback && fallback !== "not requested" ? " (parallel unavailable: " + fallback + ")" : "");
        }).catch(() => {});
    });

    emulator.add_listener("emulator-error", function(error)
    {
        $("loading").style.display = "block";
        $("loading").textContent = "Emulator failed: " + error.message;
        if(DEBUG && emulator.worker_controller && !emulator.worker_controller.ready)
        {
            $("loading").textContent += " (the CPU Worker is build/cpu-worker.js from `make all-debug`; " +
                "debug.html?cpu_worker=0 runs the CPU in the page)";
        }
    });

    emulator.add_listener("download-progress", function(e)
    {
        show_progress(e);
    });

    emulator.add_listener("download-error", function(e)
    {
        const el = $("loading");
        el.style.display = "block";
        el.textContent = `Loading ${e.file_name} failed. Check your connection and reload the page to try again.`;
    });
}

/**
 * @param {Object} settings
 * @param {V86} emulator
 */
function init_ui(profile, settings, emulator)
{
    $("loading").style.display = "none";
    $("runtime_options").style.display = "block";
    $("runtime_infos").style.display = "block";
    $("screen_container").style.display = "block";

    var filesystem_is_enabled = false;

    if(settings.filesystem)
    {
        filesystem_is_enabled = true;
        init_filesystem_panel(emulator);
    }
    else
    {
        emulator.add_listener("9p-attach", function()
        {
            filesystem_is_enabled = true;
            init_filesystem_panel(emulator);
        });
    }

    $("run").onclick = function()
    {
        if(emulator.is_running())
        {
            $("run").textContent = "Run";
            emulator.stop();
        }
        else
        {
            $("run").textContent = "Pause";
            emulator.run();
        }

        $("run").blur();
    };

    $("exit").onclick = function()
    {
        emulator.destroy();
        const params = new URLSearchParams(location.search);
        params.delete("profile");
        location.href = location.pathname + format_query_args(params);
    };

    $("lock_mouse").onclick = function()
    {
        if(!mouse_is_enabled)
        {
            $("toggle_mouse").onclick();
        }

        emulator.lock_mouse();
        $("lock_mouse").blur();
    };

    var mouse_is_enabled = true;

    $("toggle_mouse").onclick = function()
    {
        mouse_is_enabled = !mouse_is_enabled;

        emulator.mouse_set_enabled(mouse_is_enabled);
        $("toggle_mouse").textContent = (mouse_is_enabled ? "Dis" : "En") + "able mouse";
        $("toggle_mouse").blur();
    };

    if(profile?.mouse_disabled_default)
    {
        $("toggle_mouse").onclick();
    }

    var theatre_mode = false;
    var theatre_ui = true;
    var theatre_zoom_to_fit = false;

    function zoom_to_fit()
    {
        // reset size
        emulator.screen_set_scale(1, 1);

        const emulator_screen = $("screen_container").getBoundingClientRect();
        const emulator_screen_width = emulator_screen.width;
        const emulator_screen_height = emulator_screen.height;

        const viewport_screen_width = window.innerWidth;
        const viewport_screen_height = window.innerHeight;

        const n = Math.min(viewport_screen_width / emulator_screen_width, viewport_screen_height / emulator_screen_height);
        emulator.screen_set_scale(n, n);
    }

    /**
     * @param {boolean} enabled
     */
    function enable_theatre_ui(enabled)
    {
        theatre_ui = enabled;

        $("runtime_options").style.display = theatre_ui ? "block" : "none";
        $("runtime_infos").style.display = theatre_ui ? "block" : "none";
        $("filesystem_panel").style.display = (filesystem_is_enabled && theatre_ui) ? "block" : "none";

        $("toggle_ui").textContent = (theatre_ui ? "Hide" : "Show") + " UI";
    }

    /**
     * @param {boolean} enabled
     */
    function enable_zoom_to_fit(enabled)
    {
        theatre_zoom_to_fit = enabled;
        $("scale").disabled = theatre_zoom_to_fit;

        if(theatre_zoom_to_fit)
        {
            window.addEventListener("resize", zoom_to_fit, true);
            emulator.add_listener("screen-set-size", zoom_to_fit);

            zoom_to_fit();
        }
        else
        {
            window.removeEventListener("resize", zoom_to_fit, true);
            emulator.remove_listener("screen-set-size", zoom_to_fit);

            const n = parseFloat($("scale").value) || 1;
            emulator.screen_set_scale(n, n);
        }

        $("toggle_zoom_to_fit").textContent = (theatre_zoom_to_fit ? "Dis" : "En") + "able zoom to fit";
    }

    /**
     * @param {boolean} enabled
     */
    function enable_theatre_mode(enabled)
    {
        theatre_mode = enabled;

        if(!theatre_ui)
        {
            enable_theatre_ui(true);
        }

        if(!theatre_mode && theatre_zoom_to_fit)
        {
            enable_zoom_to_fit(false);
        }

        for(const el of ["screen_container", "runtime_options", "runtime_infos", "filesystem_panel"])
        {
            $(el).classList.toggle("theatre_" + el);
        }

        $("theatre_background").style.display = theatre_mode ? "block" : "none";
        $("toggle_zoom_to_fit").style.display = theatre_mode ? "inline" : "none";
        $("toggle_ui").style.display = theatre_mode ? "block" : "none";

        // hide scrolling
        document.body.style.overflow = theatre_mode ? "hidden" : "visible";

        $("toggle_theatre").textContent = (theatre_mode ? "Dis" : "En") + "able theatre mode";
    }

    $("toggle_ui").onclick = function()
    {
        enable_theatre_ui(!theatre_ui);
        $("toggle_ui").blur();
    };

    $("toggle_theatre").onclick = function()
    {
        enable_theatre_mode(!theatre_mode);
        $("toggle_theatre").blur();
    };

    $("toggle_zoom_to_fit").onclick = function()
    {
        enable_zoom_to_fit(!theatre_zoom_to_fit);
        $("toggle_zoom_to_fit").blur();
    };

    var last_tick = 0;
    var running_time = 0;
    var last_instr_counter = 0;
    var interval = null;
    var os_uses_mouse = false;
    var os_uses_absolute_mouse = false;
    var total_instructions = 0;

    function update_info()
    {
        var now = Date.now();

        var instruction_counter = emulator.get_instruction_counter();

        if(instruction_counter < last_instr_counter)
        {
            // 32-bit wrap-around
            last_instr_counter -= 0x100000000;
        }

        var last_ips = instruction_counter - last_instr_counter;
        last_instr_counter = instruction_counter;
        total_instructions += last_ips;

        var delta_time = now - last_tick;

        if(delta_time)
        {
            running_time += delta_time;
            last_tick = now;

            $("speed").textContent = (last_ips / 1000 / delta_time).toFixed(1);
            $("avg_speed").textContent = (total_instructions / 1000 / running_time).toFixed(1);
            $("running_time").textContent = format_timestamp(running_time / 1000 | 0);
        }
    }

    emulator.add_listener("emulator-started", function()
    {
        last_tick = Date.now();
        interval = setInterval(update_info, 1000);
    });

    emulator.add_listener("emulator-stopped", function()
    {
        update_info();
        if(interval !== null)
        {
            clearInterval(interval);
        }
    });

    var stats_9p = {
        read: 0,
        write: 0,
        files: [],
    };

    emulator.add_listener("9p-read-start", function(args)
    {
        const file = args[0];
        stats_9p.files.push(file);
        $("info_filesystem").style.display = "block";
        $("info_filesystem_status").textContent = "Loading ...";
        $("info_filesystem_last_file").textContent = file;
    });
    emulator.add_listener("9p-read-end", function(args)
    {
        stats_9p.read += args[1];
        $("info_filesystem_bytes_read").textContent = stats_9p.read;

        const file = args[0];
        stats_9p.files = stats_9p.files.filter(f => f !== file);

        if(stats_9p.files[0])
        {
            $("info_filesystem_last_file").textContent = stats_9p.files[0];
        }
        else
        {
            $("info_filesystem_status").textContent = "Idle";
        }
    });
    emulator.add_listener("9p-write-end", function(args)
    {
        stats_9p.write += args[1];
        $("info_filesystem_bytes_written").textContent = stats_9p.write;

        if(!stats_9p.files[0])
        {
            $("info_filesystem_last_file").textContent = args[0];
        }
    });

    var stats_storage = {
        read: 0,
        read_sectors: 0,
        write: 0,
        write_sectors: 0,
    };

    $("storage_bus").textContent = settings.machine_type === "q35" ? "AHCI" : "IDE";
    $("ide_type").textContent = settings.cdrom ? " (CD-ROM)" : " (hard disk)";

    emulator.add_listener("ide-read-start", function()
    {
        $("info_storage").style.display = "block";
        $("info_storage_status").textContent = "Loading ...";
    });
    emulator.add_listener("ide-read-end", function(args)
    {
        stats_storage.read += args[1];
        stats_storage.read_sectors += args[2];

        $("info_storage_status").textContent = "Idle";
        $("info_storage_bytes_read").textContent = stats_storage.read;
        $("info_storage_sectors_read").textContent = stats_storage.read_sectors;
    });
    emulator.add_listener("ide-write-end", function(args)
    {
        stats_storage.write += args[1];
        stats_storage.write_sectors += args[2];

        $("info_storage_bytes_written").textContent = stats_storage.write;
        $("info_storage_sectors_written").textContent = stats_storage.write_sectors;
    });

    var stats_net = {
        bytes_transmitted: 0,
        bytes_received: 0,
    };

    emulator.add_listener("eth-receive-end", function(args)
    {
        stats_net.bytes_received += args[0];

        $("info_network").style.display = "block";
        $("info_network_bytes_received").textContent = stats_net.bytes_received;
    });
    emulator.add_listener("eth-transmit-end", function(args)
    {
        stats_net.bytes_transmitted += args[0];

        $("info_network").style.display = "block";
        $("info_network_bytes_transmitted").textContent = stats_net.bytes_transmitted;
    });


    emulator.add_listener("mouse-enable", function(is_enabled)
    {
        os_uses_mouse = is_enabled;
        $("info_mouse_enabled").textContent = is_enabled ? "Yes" : "No";
    });

    emulator.add_listener("vmware-absolute-mouse", function(is_enabled)
    {
        os_uses_absolute_mouse = is_enabled;
    });

    // (the ARM machines' virtio tablet and touch screens: [active, the guest's cursor])
    emulator.add_listener("absolute-pointer", function(state)
    {
        os_uses_absolute_mouse = state[0];
    });

    emulator.add_listener("screen-set-size", function(args)
    {
        const [w, h, bpp] = args;
        $("info_res").textContent = w + "x" + h + (bpp ? "x" + bpp : "");
        $("info_vga_mode").textContent = bpp ? "Graphical" : "Text";
    });


    $("reset").onclick = function()
    {
        emulator.restart();
        $("reset").blur();
    };

    add_image_download_button(settings.hda, () => emulator.v86.cpu.disk_device("hda").buffer, "hda");
    add_image_download_button(settings.hdb, () => emulator.v86.cpu.disk_device("hdb").buffer, "hdb");
    add_image_download_button(settings.fda, () => emulator.v86.cpu.devices.fdc.drives[0].buffer, "fda");
    add_image_download_button(settings.fdb, () => emulator.v86.cpu.devices.fdc.drives[1].buffer, "fdb");
    add_image_download_button(settings.cdrom, () => emulator.v86.cpu.disk_device("cdrom").buffer, "cdrom");

    function add_image_download_button(obj, get_buffer, type)
    {
        var elem = $("get_" + type + "_image");

        // (a disk image in a container format: exported RAW, in parts;
        // docs/disk-image-formats-plan.md P2)
        const exported = obj && obj.format && obj.format !== "raw";
        if(!obj || obj.async && !exported)
        {
            elem.style.display = "none";
        }

        elem.onclick = async function(e)
        {
            if(exported)
            {
                const parts = [];
                try
                {
                    await emulator.export_disk_image(type, { write: chunk => { parts.push(chunk); } });
                    download(new Blob(parts), (profile?.id || "v86") + "-" + type + ".img");
                }
                catch(error)
                {
                    alert("The disk could not be exported: " + error.message);
                }
                elem.blur();
                return;
            }
            if(emulator.worker_controller)
            {
                const name = (profile?.id || "v86") + "-" + type + (type === "cdrom" ? ".iso" : ".img");
                const result = await emulator.worker_controller.rpc("disk", [type]);
                if(result instanceof Blob)
                {
                    // (a local file read in parts, with the blocks written)
                    download(result, result instanceof File ? result.name : name);
                }
                else if(result)
                {
                    dump_file(result, name);
                }
                else
                {
                    alert("The file could not be loaded. Maybe it's too big?");
                }
                elem.blur();
                return;
            }
            const buffer = get_buffer();
            const filename = buffer.file && buffer.file.name || ((profile?.id || "v86") + "-" + type + (type === "cdrom" ? ".iso" : ".img"));

            if(buffer.get_as_file)
            {
                var file = buffer.get_as_file(filename);
                download(file, filename);
            }
            else
            {
                buffer.get_buffer(function(b)
                {
                    if(b)
                    {
                        dump_file(b, filename);
                    }
                    else
                    {
                        alert("The file could not be loaded. Maybe it's too big?");
                    }
                });
            }

            elem.blur();
        };
    }

    function pick_file(multiple)
    {
        return new Promise(resolve => {
            const file_input = document.createElement("input");
            file_input.type = "file";
            file_input.multiple = multiple;
            file_input.onchange = function()
            {
                resolve(file_input.files);
            };
            file_input.oncancel = function()
            {
                resolve([]);
            };
            file_input.click();
        });
    }

    $("change_fda_image").textContent = settings.fda ? "Eject floppy image" : "Insert floppy image";
    $("change_fda_image").ondragover = function(e)
    {
        e.preventDefault();
    };
    async function insert_fda(files)
    {
        const file = files[0];
        if(file)
        {
            await emulator.set_fda({ buffer: file });
            $("change_fda_image").textContent = "Eject floppy image";
            $("get_fda_image").style.display = "block";
        }
    }
    $("change_fda_image").ondrop = function(e)
    {
        e.preventDefault();
        if(emulator.get_disk_fda())
        {
            emulator.eject_fda();
        }
        insert_fda(e.dataTransfer.files);
    };
    $("change_fda_image").onclick = async function()
    {
        if(emulator.get_disk_fda())
        {
            emulator.eject_fda();
            $("change_fda_image").textContent = "Insert floppy image";
            $("get_fda_image").style.display = "none";
        }
        else
        {
            const files = await pick_file(false);
            insert_fda(files);
        }
        $("change_fda_image").blur();
    };

    $("change_fdb_image").textContent = settings.fdb ? "Eject second floppy image" : "Insert second floppy image";
    $("change_fdb_image").ondragover = function(e)
    {
        e.preventDefault();
    };
    async function insert_fdb(files)
    {
        const file = files[0];
        if(file)
        {
            await emulator.set_fdb({ buffer: file });
            $("change_fdb_image").textContent = "Eject second floppy image";
            $("get_fdb_image").style.display = "block";
        }
    }
    $("change_fdb_image").ondrop = function(e)
    {
        e.preventDefault();
        if(emulator.get_disk_fdb())
        {
            emulator.eject_fdb();
        }
        insert_fdb(e.dataTransfer.files);
    };
    $("change_fdb_image").onclick = async function()
    {
        if(emulator.get_disk_fdb())
        {
            emulator.eject_fdb();
            $("change_fdb_image").textContent = "Insert second floppy image";
            $("get_fdb_image").style.display = "none";
        }
        else
        {
            const files = await pick_file(false);
            insert_fdb(files);
        }
        $("change_fdb_image").blur();
    };

    $("change_cdrom_image").textContent = settings.cdrom ? "Eject CD image" : "Insert CD image";
    $("change_cdrom_image").ondragover = function(e)
    {
        e.preventDefault();
    };
    async function insert_cdrom(files)
    {
        let buffer;

        if(files.length === 1 && /\.(iso(9660|img)?|cdr)$/i.test(files[0].name))
        {
            buffer = files[0];
        }
        else if(files.length)
        {
            const files2 = [];
            for(const file of files)
            {
                files2.push({
                    name: file.name,
                    contents: new Uint8Array(await read_file(file)),
                });

            }
            buffer = iso9660.generate(files2).buffer;
        }

        if(buffer)
        {
            await emulator.set_cdrom({ buffer });
            $("change_cdrom_image").textContent = "Eject CD image";
            $("get_cdrom_image").style.display = "block";
        }
    }
    $("change_cdrom_image").ondrop = function(e)
    {
        e.preventDefault();
        if(emulator.worker_controller ? emulator.worker_controller.device_info["cdrom_present"] : emulator.v86.cpu.devices.cdrom.has_disk())
        {
            emulator.eject_cdrom();
        }
        insert_cdrom(e.dataTransfer.files);
    };
    $("change_cdrom_image").onclick = async function()
    {
        if(emulator.worker_controller ? emulator.worker_controller.device_info["cdrom_present"] : emulator.v86.cpu.devices.cdrom.has_disk())
        {
            emulator.eject_cdrom();
            $("change_cdrom_image").textContent = "Insert CD image";
            $("get_cdrom_image").style.display = "none";
        }
        else
        {
            const files = await pick_file(true);
            insert_cdrom(files);
        }
        $("change_cdrom_image").blur();
    };

    $("memory_dump").onclick = async function()
    {
        if(emulator.worker_controller)
        {
            dump_file(await emulator.worker_controller.rpc("memory_dump"), "v86memory.bin");
            return;
        }
        const mem8 = emulator.v86.cpu.mem8;
        dump_file(new Uint8Array(mem8.buffer, mem8.byteOffset, mem8.length), "v86memory.bin");
        $("memory_dump").blur();
    };

    //$("memory_dump_dmp").onclick = function()
    //{
    //    var memory = emulator.v86.cpu.mem8;
    //    var memory_size = memory.length;
    //    var page_size = 4096;
    //    var header = new Uint8Array(4096);
    //    var header32 = new Int32Array(header.buffer);

    //    header32[0] = 0x45474150; // 'PAGE'
    //    header32[1] = 0x504D5544; // 'DUMP'

    //    header32[0x10 >> 2] = emulator.v86.cpu.cr[3]; // DirectoryTableBase
    //    header32[0x24 >> 2] = 1; // NumberProcessors
    //    header32[0xf88 >> 2] = 1; // DumpType: full dump
    //    header32[0xfa0 >> 2] = header.length + memory_size; // RequiredDumpSpace

    //    header32[0x064 + 0 >> 2] = 1; // NumberOfRuns
    //    header32[0x064 + 4 >> 2] = memory_size / page_size; // NumberOfPages
    //    header32[0x064 + 8 >> 2] = 0; // BasePage
    //    header32[0x064 + 12 >> 2] = memory_size / page_size; // PageCount

    //    dump_file([header, memory], "v86memory.dmp");

    //    $("memory_dump_dmp").blur();
    //};

    /**
     * @this HTMLElement
     */
    $("capture_network_traffic").onclick = function()
    {
        this.textContent = "0 packets";

        let capture = [];

        function do_capture(direction, data)
        {
            capture.push({ direction, time: performance.now() / 1000, hex_dump: hex_dump(data) });
            $("capture_network_traffic").textContent = capture.length + " packets";
        }

        emulator.emulator_bus.register("net0-receive", do_capture.bind(this, "I"));
        emulator.add_listener("net0-send", do_capture.bind(this, "O"));

        this.onclick = function()
        {
            const capture_raw = capture.map(({ direction, time, hex_dump }) => {
                // https://www.wireshark.org/docs/wsug_html_chunked/ChIOImportSection.html
                // In wireshark: file -> import from hex -> tick direction indication, timestamp %s.%f
                return direction + " " + time.toFixed(6) + hex_dump + "\n";
            }).join("");
            dump_file(capture_raw, "traffic.hex");
            capture = [];
            this.textContent = "0 packets";
        };
    };


    $("save_state").onclick = async function()
    {
        const button = $("save_state");
        button.disabled = true;
        const label = button.textContent;
        button.textContent = "Saving...";
        try
        {
            // A single-buffer snapshot is less than 2 GiB (the RAM in use,
            // video memory, the SVGA's 3D objects), and the browser allocates
            // it in one piece, beside the guest's RAM: machines of 1 GiB or
            // more save a V7 stream, written to the file as it is made (into
            // a Blob where the browser lets the page write no file); the
            // others too when one buffer fails (RangeError)
            let result = null;
            if(!settings.extended_memory_size && settings.memory_size + (settings.vram_size || 0) < STREAMED_STATE_MEMORY)
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
            if(result) dump_file(result, "v86state.bin");
            else await save_state_stream_to_file(emulator, "v86state.bin");
        }
        catch(error)
        {
            console.error("Could not save emulator state", error);
            alert("Could not save the state:\n" + error.message);
        }
        finally
        {
            button.disabled = false;
            button.textContent = label;
            button.blur();
        }
    };

    // Disks written back (docs/disk-persistence-plan.md D3): their changes
    // are in their images, a snapshot holds only a reference of each, valid
    // until the image is written again. So the page offers "save and power
    // off": the state saved, the machine destroyed (the disks flushed and
    // closed); restored later with the same disks, the machine goes on.
    const written_back = [settings.hda, settings.hdb, settings.fda, settings.fdb].some(disk => disk && disk.disk_option === "read_write");
    $("save_and_power_off").style.display = written_back ? "" : "none";
    $("save_and_power_off").onclick = async function()
    {
        const button = $("save_and_power_off");
        button.disabled = true;
        try
        {
            const parts = [];
            await emulator.save_state_stream(chunk => { parts.push(chunk.slice()); });
            dump_file(parts, "v86state.bin");
            await emulator.destroy();
            show_disk_status("Saved the state (v86state.bin, " + parts.reduce((n, p) => n + p.length, 0) + " bytes) and powered off: " +
                "the disks written back are flushed and closed. Load the state with the same disks to go on.");
        }
        catch(error)
        {
            console.error("Could not save and power off", error);
            alert("Could not save the state:\n" + error.message);
            button.disabled = false;
        }
    };
    // a disk's read or write failed: with disk_error "stop" the machine
    // waits for the user: retry (or, when it cannot be retried, continue:
    // the guest sees the error), or power off
    emulator.add_listener("disk-error", event =>
    {
        const stop = event["policy"] === "stop";
        $("disk_error_text").textContent = "Disk " + event["disk"] + ": the " + event["operation"] + " of " + event["length"] +
            " bytes at " + event["offset"] + " failed: " + event["reason"] + ". " +
            (!stop ? "The guest was told." : event["retryable"] ? "The machine is stopped: retry once the disk can be reached again, or power off." :
                "The machine is stopped: this cannot be retried; continue (the guest is told), or power off.");
        $("disk_error_retry").textContent = event["retryable"] ? "Retry" : "Continue";
        $("disk_error_retry").style.display = stop ? "" : "none";
        $("disk_error_power_off").style.display = stop ? "" : "none";
        $("disk_error_box").style.display = "";
    });
    $("disk_error_retry").onclick = function()
    {
        $("disk_error_box").style.display = "none";
        emulator.run();
    };
    $("disk_error_power_off").onclick = async function()
    {
        $("disk_error_box").style.display = "none";
        await emulator.destroy();
        show_disk_status("Powered off: the requests still waiting for the disk are dropped, as by a power loss.");
    };

    $("load_state").onclick = async function()
    {
        $("load_state").blur();

        const files = await pick_file(false);
        const file = files[0];

        if(!file)
        {
            return;
        }

        const button = $("load_state");
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "Loading...";
        try
        {
            // streams (large machines) are read from the file as needed:
            // odd versions, 7 and 9 (src/state.js)
            const header = new DataView(await file.slice(0, 8).arrayBuffer());
            const stream = header.byteLength === 8 && header.getUint32(0, true) === 0x86768676 &&
                header.getUint32(4, true) % 2 === 1;
            const state = stream ? null : await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.onabort = () => reject(new Error("State file reading was cancelled"));
                reader.readAsArrayBuffer(file);
            });
            const was_running = emulator.is_running();
            if(was_running) await emulator.stop();
            if(stream) await emulator.restore_state_stream(file);
            else await emulator.restore_state(state);
            if(was_running) emulator.run();
        }
        catch(err)
        {
            console.error("Could not restore emulator state", err);
            alert("Something bad happened while restoring the state:\n" + err + "\n\n" +
                  "Note that the current configuration must be the same as the original");
        }
        finally
        {
            button.disabled = false;
            button.textContent = label;
        }
    };

    $("ctrlaltdel").onclick = function()
    {
        emulator.keyboard_send_scancodes([
            0x1D, // ctrl
            0x38, // alt
            0x53, // delete

            // break codes
            0x1D | 0x80,
            0x38 | 0x80,
            0x53 | 0x80,
        ]);

        $("ctrlaltdel").blur();
    };

    $("alttab").onclick = function()
    {
        emulator.keyboard_send_scancodes([
            0x38, // alt
            0x0F, // tab
        ]);

        setTimeout(function()
        {
            emulator.keyboard_send_scancodes([
                0x38 | 0x80,
                0x0F | 0x80,
            ]);
        }, 100);

        $("alttab").blur();
    };

    /**
     * @this HTMLElement
     */
    $("scale").onchange = function()
    {
        var n = parseFloat(this.value);

        if(n || n > 0)
        {
            emulator.screen_set_scale(n, n);
        }
    };

    $("fullscreen").onclick = function()
    {
        emulator.screen_go_fullscreen();
    };

    $("screen_container").onclick = function(e)
    {
        if(emulator.is_running() && emulator.speaker_adapter?.audio_context?.state === "suspended")
        {
            emulator.speaker_adapter.audio_context.resume();
        }

        // No need to lock the mouse if the guest tracks the host cursor
        // through the absolute pointing device. The "Lock mouse" button can
        // still be used, e.g. for games (movement is then sent as relative
        // deltas).
        if(mouse_is_enabled && os_uses_mouse && !os_uses_absolute_mouse)
        {
            emulator.lock_mouse();
        }

        // allow text selection
        if(window.getSelection().isCollapsed)
        {
            const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

            phone_keyboard.style.top = window.scrollY + e.clientY + 20 + "px";
            phone_keyboard.style.left = window.scrollX + e.clientX + "px";

            // clean after previous input
            phone_keyboard.value = "";
            phone_keyboard.focus();
        }
    };

    const phone_keyboard = document.getElementsByClassName("phone_keyboard")[0];

    phone_keyboard.setAttribute("autocorrect", "off");
    phone_keyboard.setAttribute("autocapitalize", "off");
    phone_keyboard.setAttribute("spellcheck", "false");
    phone_keyboard.tabIndex = 0;

    $("take_screenshot").onclick = function()
    {
        const image = emulator.screen_make_screenshot();
        try {
            const w = window.open("");
            w.document.write(image.outerHTML);
        }
        catch(e) {}
        $("take_screenshot").blur();
    };

    if(emulator.speaker_adapter)
    {
        let is_muted = false;

        $("mute").onclick = function()
        {
            if(is_muted)
            {
                emulator.speaker_adapter.mixer.set_volume(1, undefined);
                is_muted = false;
                $("mute").textContent = "Mute";
            }
            else
            {
                emulator.speaker_adapter.mixer.set_volume(0, undefined);
                is_muted = true;
                $("mute").textContent = "Unmute";
            }

            $("mute").blur();
        };
    }
    else
    {
        $("mute").remove();
    }

    window.addEventListener("keydown", ctrl_w_rescue, false);
    window.addEventListener("keyup", ctrl_w_rescue, false);
    window.addEventListener("blur", ctrl_w_rescue, false);

    function ctrl_w_rescue(e)
    {
        if(e.ctrlKey)
        {
            window.onbeforeunload = function()
            {
                window.onbeforeunload = null;
                return "CTRL-W cannot be sent to the emulator.";
            };
        }
        else
        {
            window.onbeforeunload = null;
        }
    }

    const script = document.createElement("script");
    script.src = "build/xterm.js";
    script.async = true;
    script.onload = function()
    {
        emulator.set_serial_container_xtermjs($("terminal"));
        emulator.serial_adapter.term.write("This is the serial console. Whatever you type or paste here will be sent to COM1");
    };
    document.body.appendChild(script);
}

function init_filesystem_panel(emulator)
{
    $("filesystem_panel").style.display = "block";

    /**
     * @this HTMLElement
     */
    $("filesystem_send_file").onchange = function()
    {
        Array.prototype.forEach.call(this.files, function(file)
        {
            var loader = new SyncFileBuffer(file);
            loader.onload = function()
            {
                loader.get_buffer(async function(buffer)
                {
                    await emulator.create_file("/" + file.name, new Uint8Array(buffer));
                });
            };
            loader.load();
        }, this);

        this.value = "";
        this.blur();
    };

    /**
     * @this HTMLElement
     */
    $("filesystem_get_file").onkeypress = async function(e)
    {
        if(e.which !== 13)
        {
            return;
        }

        this.disabled = true;

        let result;
        try
        {
             result = await emulator.read_file(this.value);
        }
        catch(err)
        {
            console.log(err);
        }

        this.disabled = false;

        if(result)
        {
            var filename = this.value.replace(/\/$/, "").split("/");
            filename = filename[filename.length - 1] || "root";

            dump_file(result, filename);
            this.value = "";
        }
        else
        {
            alert("Can't read file");
        }
    };
}

function debug_start(emulator)
{
    if(!emulator.v86)
    {
        return;
    }

    // called as soon as soon as emulation is started, in debug mode
    const cpu = emulator.v86.cpu;

    $("dump_gdt").onclick = cpu.dump_gdt_ldt.bind(cpu);
    $("dump_idt").onclick = cpu.dump_idt.bind(cpu);
    $("dump_regs").onclick = () => { cpu.dump_regs_short(); cpu.dump_state(); };
    $("dump_pt").onclick = cpu.dump_page_structures.bind(cpu);

    $("dump_log").onclick = function()
    {
        dump_file(log_data.join(""), "v86.log");
    };

    $("debug_panel").style.display = "block";
    setInterval(function()
    {
        $("debug_panel").textContent =
            cpu.get_regs_short().join("\n") + "\n" + cpu.debug_get_state();

        $("dump_log").textContent = "Dump log" + (log_data.length ? " (" + log_data.length + " lines)" : "");
    }, 1000);

    // helps debugging
    window.cpu = cpu;
    window.h = h;
    window.dump_file = dump_file;
}

function onpopstate(e)
{
    location.reload();
}

function push_state(params)
{
    if(window.history.pushState)
    {
        const search = format_query_args(params);
        window.history.pushState({ search }, "", search);
    }
}
