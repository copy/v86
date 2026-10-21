// The old page's address (docs/vm-manager-plan.md, U0): ?profile=, ?hda.url=
// and the rest, as the page's settings, and a start's settings from the
// profile, the address and the form (src/browser/vm_options.js). Sites and
// bookmarks link to these addresses; the VM manager and the debug page both
// import this module (the plan's G5: no Closure defines, no internals).

import { CPU_TYPES, MACHINE_TYPES, Q35_ROOT_PORTS_MAX } from "../machine_options.js";
import { clamp_chunk_size, clamp_memory_size, clamp_vram_size, set_memory_size, profile_settings, apply_form } from "./vm_options.js";

/**
 * A boolean argument: present and not "0"
 * @param {*} x
 * @return {boolean}
 */
export function bool_arg(x)
{
    return !!x && x !== "0";
}

/**
 * ?cpu_type=; undefined when absent or unknown
 * @param {URLSearchParams} query_args
 * @return {string|undefined}
 */
export function cpu_type_arg(query_args)
{
    const cpu_type = query_args.get("cpu_type");
    return cpu_type && CPU_TYPES.includes(cpu_type) ? cpu_type : undefined;
}

/**
 * ?machine_type=; undefined when absent or unknown
 * @param {URLSearchParams} query_args
 * @return {string|undefined}
 */
export function machine_type_arg(query_args)
{
    const machine_type = query_args.get("machine_type");
    return machine_type && MACHINE_TYPES.includes(machine_type) ? machine_type : undefined;
}

/**
 * ?root_ports=: Q35's PCI Express root ports; undefined when absent or out of range
 * @param {URLSearchParams} query_args
 * @return {number|undefined}
 */
export function root_ports_arg(query_args)
{
    const ports = parseInt(query_args.get("root_ports"), 10);
    return ports >= 0 && ports <= Q35_ROOT_PORTS_MAX ? ports : undefined;
}

/**
 * Where the profiles' images are: ?cdn=, else images/ on localhost, else copy.sh's
 * @param {URLSearchParams} query_args
 * @param {boolean} on_localhost
 * @return {string}
 */
export function image_host(query_args, on_localhost)
{
    return query_args.get("cdn") || (on_localhost ? "images/" : "//i.copy.sh/");
}

/**
 * The address's settings: on top of a profile's, except those a state image
 * (the profile's initial_state) does not allow
 * @param {!Object} settings
 * @param {!URLSearchParams} query_args
 */
export function apply_query_args(settings, query_args)
{
    // ignore certain settings when using a state image
    if(!settings.initial_state)
    {
        const chunk_size = clamp_chunk_size(parseInt(query_args.get("chunk_size"), 10));

        if(query_args.has("hda.url"))
        {
            settings.hda = {
                size: parseInt(query_args.get("hda.size"), 10) || undefined,
                // TODO: synchronous if small?
                url: query_args.get("hda.url"),
                fixed_chunk_size: chunk_size,
                async: true,
            };
        }
        else if(query_args.has("hda.empty"))
        {
            const empty_size = parseInt(query_args.get("hda.empty"), 10);
            if(empty_size > 0)
            {
                settings.hda = { buffer: new ArrayBuffer(empty_size) };
            }
        }

        if(query_args.has("hdb.url"))
        {
            settings.hdb = {
                size: parseInt(query_args.get("hdb.size"), 10) || undefined,
                // TODO: synchronous if small?
                url: query_args.get("hdb.url"),
                fixed_chunk_size: chunk_size,
                async: true,
            };
        }
        else if(query_args.has("hdb.empty"))
        {
            const empty_size = parseInt(query_args.get("hdb.empty"), 10);
            if(empty_size > 0)
            {
                settings.hdb = { buffer: new ArrayBuffer(empty_size) };
            }
        }

        if(query_args.has("cdrom.url"))
        {
            settings.cdrom = {
                size: parseInt(query_args.get("cdrom.size"), 10) || undefined,
                url: query_args.get("cdrom.url"),
                fixed_chunk_size: chunk_size,
                async: true,
            };
        }

        if(query_args.has("fda.url"))
        {
            settings.fda = {
                size: parseInt(query_args.get("fda.size"), 10) || undefined,
                url: query_args.get("fda.url"),
                async: false,
            };
        }

        // the disks' policies (docs/disk-persistence-plan.md): hda.disk_option=read_write
        // with a disk service's URL writes the guest's changes back; hda.disk_error=report
        // (the settings' names as properties, as main.js had them for its ADVANCED build)
        for(const [name, disk] of [["hda", settings.hda], ["hdb", settings.hdb], ["fda", settings.fda]])
        {
            if(!disk) continue;
            if(query_args.has(name + ".disk_option")) disk.disk_option = query_args.get(name + ".disk_option");
            if(query_args.has(name + ".disk_error")) disk.disk_error = query_args.get(name + ".disk_error");
        }

        // (a kernel and an initrd: the PC's bzImage, or the arm64 virt machine's Image)
        if(query_args.has("kernel.url")) settings.bzimage = { url: query_args.get("kernel.url"), async: false };
        if(query_args.has("initrd.url")) settings.initrd = { url: query_args.get("initrd.url"), async: false };
        if(query_args.has("cmdline")) settings.cmdline = query_args.get("cmdline");

        const m = parseInt(query_args.get("m"), 10);
        if(m > 0)
        {
            set_memory_size(settings, clamp_memory_size(m));
        }

        const cores = parseInt(query_args.get("cores"), 10);
        if(cores > 0)
        {
            settings.cpu_cores = cores;
        }
        if(query_args.has("parallel"))
        {
            settings.parallel = bool_arg(query_args.get("parallel"));
        }
        settings.cpu_type = cpu_type_arg(query_args);
        settings.machine_type = machine_type_arg(query_args);
        if(query_args.has("hpet")) settings.hpet = bool_arg(query_args.get("hpet"));
        if(query_args.has("smbus")) settings.smbus = bool_arg(query_args.get("smbus"));
        settings.pcie_root_ports = root_ports_arg(query_args);

        const vram = parseInt(query_args.get("vram"), 10);
        if(vram > 0)
        {
            settings.vram_size = clamp_vram_size(vram) * 1024 * 1024;
        }
        if(query_args.has("graphics_adapter"))
        {
            settings.graphics_adapter = query_args.get("graphics_adapter");
        }
        // virtio_gpu: how many displays the guest gets (side by side in
        // the window), a developer's setting
        if(query_args.has("displays"))
        {
            settings.displays = Math.max(1, Math.min(4, parseInt(query_args.get("displays"), 10) || 1));
        }

        settings.acpi = query_args.has("acpi") ? bool_arg(query_args.get("acpi")) : settings.acpi;
        settings.use_bochs_bios = query_args.get("bios") === "bochs";
        settings.net_device_type = query_args.get("net_device_type") || settings.net_device_type;
        settings.mtu = parseInt(query_args.get("mtu"), 10) || undefined;
    }

    settings.relay_url = query_args.get("relay_url");
    settings.disable_jit = bool_arg(query_args.get("disable_jit"));
    settings.disable_audio = bool_arg(query_args.get("mute"));

    if(query_args.has("modem"))
    {
        const modem = parseInt(query_args.get("modem"), 10);
        if(!Number.isNaN(modem) && modem >= 0 && modem < 4)
        {
            settings.modem = {uart: modem};
        }
    }
}

/**
 * A start's settings (the old page's start_emulation): the profile's, the
 * address's (query_args: null when the user started from the form) and the
 * form's (DEFAULT_FORM when there is none), and the CPU's policies of the address
 * @param {Object} profile
 * @param {URLSearchParams} query_args
 * @param {!Object} form
 * @param {{location_args: !URLSearchParams, origin: string, debug: boolean, graphics_proxy: boolean}} page the page's
 *     address (the CPU's policies when query_args is null), origin, debug builds and graphics proxy
 * @return {{settings: !Object, new_query_args: !Map<string, string>, cpu_worker: boolean,
 *     error: (string|undefined), title: (string|undefined), updates: !Object}} new_query_args: the start's
 *     address for push_state; error: why it cannot start; title: of the chosen files; updates: the form's
 *     fields the start changed
 */
export function start_settings(profile, query_args, form, page)
{
    // Manual starts rebuild the URL. Read the CPU policies before push_state
    // and preserve the ones that differ from the defaults.
    const cpu_args = query_args || page.location_args;

    // The CPU runs in a Worker unless the URL says ?cpu_worker=0
    const cpu_worker = !cpu_args.has("cpu_worker") || bool_arg(cpu_args.get("cpu_worker"));

    const new_query_args = new Map();
    new_query_args.set("profile", profile?.id || "custom");
    if(!cpu_worker) new_query_args.set("cpu_worker", "0");
    if(page.graphics_proxy) new_query_args.set("graphics_proxy", "1");
    // ir_tier0 (32-bit code in the x64 page tier) and the x87 fast paths are on unless the URL passes =0.
    const settings = {};
    for(const name of ["ir_tier0", "x87_fast_math", "x87_jit_cache"])
    {
        settings[name] = !cpu_args.has(name) || bool_arg(cpu_args.get(name));
        if(!settings[name]) new_query_args.set(name, "0");
    }

    if(profile)
    {
        profile_settings(profile, settings);
    }

    if(query_args)
    {
        apply_query_args(settings, query_args);
    }

    const { error, title, updates } = apply_form(settings, form, new_query_args, page);
    return { settings, new_query_args, cpu_worker, error, title, updates };
}

/**
 * The address of a start's arguments (new_query_args), as push_state writes it
 * @param {!Map<string, string>|!URLSearchParams} params
 * @return {string}
 */
export function format_query_args(params)
{
    const entries = Array.from(params.entries());
    if(entries.length)
    {
        return "?" + entries.map(([key, value]) => key + "=" + value.replace(/[?&=#+]/g, encodeURIComponent)).join("&");
    }
    else
    {
        return "";
    }
}
