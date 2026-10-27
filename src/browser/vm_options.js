// A page's V86 options (docs/vm-manager-plan.md, U0): the settings of a
// profile and of the old page's form, normalized as the old page always did
// it, and the options new V86() gets for them. The VM manager (index.html,
// an ES module outside Closure) and the debug page (debug.html,
// src/browser/main.js) both import this module, so it uses neither Closure's
// defines nor the emulator's internals (the plan's G5); the library reads
// some options by their quoted names, and they stay quoted here as they were
// in main.js.

import { CPU_TYPES, MACHINE_TYPES, MAX_VRAM_SIZE, is_arm } from "../machine_options.js";

export const DEFAULT_NETWORKING_PROXIES = ["wss://relay.widgetry.org/", "ws://localhost:8080/"];
export const DEFAULT_MEMORY_SIZE = 128;
// Guest RAM up to 2048 MB lives in the WebAssembly heap (just under 2 GiB:
// wasm32). The rest is extended RAM at 4 GiB and above, host-backed and usable
// by 64-bit guests only (docs/x86-64.md); the 36-bit physical address space
// ends at 64 GiB.
export const MAX_HEAP_MEMORY_SIZE = 2048;
/** The arm64 core's RAM in MB: below 2 GiB with the display adapter's 128 MiB of device memory */
export const ARM64_MAX_MEMORY_SIZE = 1792;
/** The arm64 virt machine's command line when none is given: Alpine's ISO (its initramfs finds the ISO on virtio-blk) */
export const ARM64_DEFAULT_CMDLINE = "console=ttyAMA0 console=tty0 modules=loop,squashfs,sd-mod,usb-storage";
/** The same without a display: the last console, where init writes and the login comes, is the serial one */
export const ARM64_SERIAL_CMDLINE = "console=ttyAMA0 modules=loop,squashfs,sd-mod,usb-storage";
export const MAX_MEMORY_SIZE = MAX_HEAP_MEMORY_SIZE + 60 * 1024;
export const DEFAULT_CPU_CORES = 1;
export const DEFAULT_CPU_TYPE = CPU_TYPES[0];
export const DEFAULT_MACHINE_TYPE = MACHINE_TYPES[0];
export const DEFAULT_VGA_MEMORY_SIZE = 8;
export const DEFAULT_GRAPHICS_ADAPTER = "bochs_vga";
export const DEFAULT_BOOT_ORDER = 0;
export const DEFAULT_MTU = 1500;
export const DEFAULT_NIC_TYPE = "ne2k";
/** The sound card (audio_device) of the PC machines */
export const DEFAULT_AUDIO_DEVICE = "sb16";

/** The largest empty hard disk in MB (an ArrayBuffer) */
export const MAX_ARRAY_BUFFER_SIZE_MB = 2000;

/**
 * The Q35 machine's own optional devices, as the page has them: the HPET and
 * the SMBus controller, as a real Q35 board and QEMU's Q35 have them; no root
 * ports, which only serve devices placed behind them (the API's hot plug)
 */
export const Q35_PAGE_DEVICES = { hpet: true, smbus: true, pcie_root_ports: 0 };

/**
 * The old page's form as index.html has it before anyone changes it (the
 * fields' values as strings, the checkboxes' states): what a start from the
 * address (?profile=, ?hda.url=) reads besides the address
 */
export const DEFAULT_FORM = {
    relay_url: DEFAULT_NETWORKING_PROXIES[0],
    disable_audio: false,
    /** the chosen files: bios, vga_bios, fda, fdb, cdrom, hda, hdb, multiboot, bzimage, initrd */
    files: {},
    /** empty disks: fda and fdb in bytes, hda and hdb in MB */
    empty_sizes: {},
    /** the hard disks' URLs ("hda", "hdb": read by the disk's name, so quoted) */
    urls: {},
    /** the hard disks' disk_option ("hda", "hdb") */
    disk_options: {},
    memory_size: String(DEFAULT_MEMORY_SIZE),
    vga_memory_size: String(DEFAULT_VGA_MEMORY_SIZE),
    graphics_adapter: DEFAULT_GRAPHICS_ADAPTER,
    boot_order: String(DEFAULT_BOOT_ORDER),
    cpu_cores: String(DEFAULT_CPU_CORES),
    parallel: true,
    cpu_type: DEFAULT_CPU_TYPE,
    machine_type: DEFAULT_MACHINE_TYPE,
    acpi: false,
    net_device_type: DEFAULT_NIC_TYPE,
    mtu: String(DEFAULT_MTU),
    modem: "none",
    audio_device: DEFAULT_AUDIO_DEVICE,
};

/**
 * @param {number} x
 * @return {number}
 */
function round_up_to_next_power_of_2(x)
{
    return x <= 1 ? 1 : 1 << 32 - Math.clz32(x - 1);
}

/**
 * A chunk size of ?chunk_size= (a power of two from 512 bytes to 4 MiB; 256 KiB without it)
 * @param {number} chunk_size
 * @return {number}
 */
export function clamp_chunk_size(chunk_size)
{
    if(chunk_size >= 0)
    {
        chunk_size = Math.min(4 * 1024 * 1024, Math.max(512, chunk_size));
        return round_up_to_next_power_of_2(chunk_size);
    }
    return 256 * 1024;
}

/**
 * A Video Memory size in MB that can be configured: vram_size is a power of
 * two, at most MAX_VRAM_SIZE
 * @param {number} size
 * @return {number}
 */
export function clamp_vram_size(size)
{
    return round_up_to_next_power_of_2(Math.min(Math.max(1, size), MAX_VRAM_SIZE >> 20));
}

/**
 * A guest RAM size in MB that can be configured: extended RAM comes in 2 MB pages
 * @param {number} total
 * @return {number}
 */
export function clamp_memory_size(total)
{
    total = Math.min(Math.max(16, total), MAX_MEMORY_SIZE);
    if(total > MAX_HEAP_MEMORY_SIZE)
    {
        total = MAX_HEAP_MEMORY_SIZE + Math.ceil((total - MAX_HEAP_MEMORY_SIZE) / 2) * 2;
    }
    return total;
}

/**
 * `total` MB of guest RAM: the WebAssembly heap first, then extended RAM
 * @param {Object} settings
 * @param {number} total
 */
export function set_memory_size(settings, total)
{
    const MB = 1024 * 1024;
    settings.memory_size = Math.min(total, MAX_HEAP_MEMORY_SIZE) * MB;
    settings.extended_memory_size = Math.max(0, total - MAX_HEAP_MEMORY_SIZE) * MB;
}

/**
 * A profile's settings (debug.html's kvm-unit-tests: name, memory_size, multiboot, ...)
 * @param {!Object} profile
 * @param {!Object} settings
 */
export function profile_settings(profile, settings)
{
    settings.initial_state = profile.state;
    settings.filesystem = profile.filesystem;
    settings.fda = profile.fda;
    settings.fdb = profile.fdb;
    settings.cdrom = profile.cdrom;
    settings.hda = profile.hda;
    settings.hdb = profile.hdb;
    settings.multiboot = profile.multiboot;
    settings.bzimage = profile.bzimage;
    settings.initrd = profile.initrd;
    settings.cmdline = profile.cmdline;
    settings.bzimage_initrd_from_filesystem = profile.bzimage_initrd_from_filesystem;
    settings.mac_address_translation = profile.mac_address_translation;
    settings.cpuid_level = profile.cpuid_level;
    settings.acpi = profile.acpi;
    settings.memory_size = profile.memory_size;
    settings.graphics_adapter = profile.graphics_adapter;
    settings.vram_size = profile.vram_size;
    settings.boot_order = profile.boot_order;
    settings.net_device_type = profile.net_device_type;
    settings.audio_device = profile.audio_device;
    settings.modem = profile.modem;
}

/**
 * The form's settings (DEFAULT_FORM's fields) on top of the profile's and the
 * address's, and the settings made consistent: the field's default keeps a
 * profile's or the address's choice, a value the user chose wins. Some
 * settings cannot be overridden when a state image is used.
 * @param {!Object} settings
 * @param {!Object} form
 * @param {!Map<string, string>} new_query_args the address of the start, for push_state
 * @param {{location_args: !URLSearchParams, origin: string, debug: boolean}} page the page's address
 *     and origin (in the message about read write), its debug builds of the firmware
 * @return {{error: (string|undefined), title: (string|undefined), updates: !Object}} updates: the form's
 *     fields the start changed, by their ids
 */
export function apply_form(settings, form, new_query_args, page)
{
    /** @type {!Object} */
    const updates = {};
    let title;

    if(!settings.relay_url)
    {
        settings.relay_url = form.relay_url;
        if(!DEFAULT_NETWORKING_PROXIES.includes(settings.relay_url)) new_query_args.set("relay_url", settings.relay_url);
    }
    if(settings.relay_url.startsWith("fetch:"))
    {
        settings.cors_proxy = settings.relay_url.slice(6);
        settings.relay_url = "fetch";
    }
    settings.disable_audio = form.disable_audio || settings.disable_audio;
    if(settings.disable_audio) new_query_args.set("mute", "1");

    // some settings cannot be overridden when a state image is used
    if(!settings.initial_state)
    {
        const files = form.files;
        const empty_sizes = form.empty_sizes;
        const bios = files.bios;
        if(bios)
        {
            settings.bios = { buffer: bios };
        }
        const vga_bios = files.vga_bios;
        if(vga_bios)
        {
            settings.vga_bios = { buffer: vga_bios };
        }
        const fda = files.fda;
        if(fda)
        {
            settings.fda = { buffer: fda };
        }
        const fda_empty_size = empty_sizes.fda;
        if(fda_empty_size)
        {
            settings.fda = { buffer: new ArrayBuffer(fda_empty_size) };
        }
        const fdb = files.fdb;
        if(fdb)
        {
            settings.fdb = { buffer: fdb };
        }
        const fdb_empty_size = empty_sizes.fdb;
        if(fdb_empty_size)
        {
            settings.fdb = { buffer: new ArrayBuffer(fdb_empty_size) };
        }
        const cdrom = files.cdrom;
        if(cdrom)
        {
            settings.cdrom = { buffer: cdrom };
        }
        const hda = files.hda;
        if(hda)
        {
            settings.hda = { buffer: hda };
        }
        const hda_empty_size = empty_sizes.hda;
        if(hda_empty_size)
        {
            const size = Math.max(1, Math.min(MAX_ARRAY_BUFFER_SIZE_MB, hda_empty_size)) * 1024 * 1024;
            settings.hda = { buffer: new ArrayBuffer(size) };
            new_query_args.set("hda.empty", String(size));
        }
        const hdb = files.hdb;
        if(hdb)
        {
            settings.hdb = { buffer: hdb };
        }
        const hdb_empty_size = empty_sizes.hdb;
        if(hdb_empty_size)
        {
            const size = Math.max(1, Math.min(MAX_ARRAY_BUFFER_SIZE_MB, hdb_empty_size)) * 1024 * 1024;
            settings.hdb = { buffer: new ArrayBuffer(size) };
            new_query_args.set("hdb.empty", String(size));
        }
        // (or an image's URL; read write: the guest's changes written back to
        // it, which needs a disk service's URL, docs/disk-persistence-plan.md:
        // a file chosen above can only be read)
        const disk_from_url = name =>
        {
            const url = form.urls[name]?.trim();
            if(!url) return undefined;
            const disk = { url, async: true };
            new_query_args.set(name + ".url", url);
            if(form.disk_options[name] === "read_write")
            {
                disk.disk_option = "read_write";
                new_query_args.set(name + ".disk_option", "read_write");
            }
            return disk;
        };
        const hda_url = disk_from_url("hda");
        if(hda_url) settings.hda = hda_url;
        const hdb_url = disk_from_url("hdb");
        if(hdb_url) settings.hdb = hdb_url;
        for(const [name, label, disk] of [["hda", "Hard disk image", settings.hda], ["hdb", "Second hard disk image", settings.hdb]])
        {
            if(form.disk_options[name] === "read_write" && !(disk && disk.url))
            {
                return {
                    error: label + ": read write needs the image's URL from a disk service (e.g. http://127.0.0.1:8471/disk.img, " +
                        "started by make run for images/, or node tools/disk-service.mjs --dir <directory> --origin " + page.origin +
                        "). A file chosen on this computer can only be read, so its changes stay in memory: choose read only for it.",
                    title: undefined,
                    updates,
                };
            }
        }
        const multiboot = files.multiboot;
        if(multiboot)
        {
            settings.multiboot = { buffer: multiboot };
        }
        const bzimage = files.bzimage;
        if(bzimage)
        {
            settings.bzimage = { buffer: bzimage };
        }
        const initrd = files.initrd;
        if(initrd)
        {
            settings.initrd = { buffer: initrd };
        }

        title = multiboot?.name || hda?.name || cdrom?.name || hdb?.name || fda?.name || bios?.name;

        const MB = 1024 * 1024;

        const memory_size = clamp_memory_size(parseInt(form.memory_size, 10) || DEFAULT_MEMORY_SIZE);
        updates["memory_size"] = String(memory_size);
        if(!settings.memory_size || memory_size !== DEFAULT_MEMORY_SIZE)
        {
            set_memory_size(settings, memory_size);
        }
        if(memory_size !== DEFAULT_MEMORY_SIZE) new_query_args.set("m", String(memory_size));

        const vram_mb = clamp_vram_size(parseInt(form.vga_memory_size, 10) || DEFAULT_VGA_MEMORY_SIZE);
        updates["vga_memory_size"] = String(vram_mb);
        if(!settings.vram_size || vram_mb !== DEFAULT_VGA_MEMORY_SIZE)
        {
            settings.vram_size = vram_mb * MB;
        }
        if(vram_mb !== DEFAULT_VGA_MEMORY_SIZE) new_query_args.set("vram", String(vram_mb));

        // (like the sizes above: the field's default keeps a profile's or ?graphics_adapter='s choice)
        const graphics_adapter = form.graphics_adapter || DEFAULT_GRAPHICS_ADAPTER;
        if(!settings.graphics_adapter || graphics_adapter !== DEFAULT_GRAPHICS_ADAPTER)
        {
            settings.graphics_adapter = graphics_adapter;
        }
        if(settings.graphics_adapter !== DEFAULT_GRAPHICS_ADAPTER) new_query_args.set("graphics_adapter", settings.graphics_adapter);
        // (?displays=N: virtio_gpu's displays, kept from the address)
        const displays = parseInt(page.location_args.get("displays"), 10);
        if(displays > 1)
        {
            settings.displays = Math.min(4, displays);
            new_query_args.set("displays", String(settings.displays));
        }

        const boot_order = parseInt(form.boot_order, 16) || DEFAULT_BOOT_ORDER;
        if(!settings.boot_order || boot_order !== DEFAULT_BOOT_ORDER)
        {
            settings.boot_order = boot_order;
        }
        if(settings.boot_order !== DEFAULT_BOOT_ORDER) new_query_args.set("boot_order", settings.boot_order.toString(16));

        const cpu_cores = parseInt(form.cpu_cores, 10) || DEFAULT_CPU_CORES;
        if(!settings.cpu_cores)
        {
            settings.cpu_cores = cpu_cores;
        }
        if(settings.cpu_cores !== DEFAULT_CPU_CORES) new_query_args.set("cores", String(settings.cpu_cores));
        // with more than one core: cores in host threads where the page allows
        // it (src/parallel), else they take turns on one thread
        if(settings.parallel === undefined)
        {
            settings.parallel = form.parallel;
        }
        if(settings.cpu_cores > 1 && !settings.parallel) new_query_args.set("parallel", "0");

        if(settings.cpu_type === undefined)
        {
            settings.cpu_type = form.cpu_type || DEFAULT_CPU_TYPE;
        }
        // the 64-bit CPUs reach extended RAM: x86_64 above the Wasm heap's
        // RAM, arm64 above ARM64_MAX_MEMORY_SIZE MB (its RAM and a display
        // adapter's device memory are less than 2 GiB of the heap), at 4 GiB
        // (docs/aarch64.md)
        if(settings.cpu_type === "arm64")
        {
            const total = (settings.memory_size + (settings.extended_memory_size || 0)) / MB;
            if(total > ARM64_MAX_MEMORY_SIZE)
            {
                settings.memory_size = ARM64_MAX_MEMORY_SIZE * MB;
                settings.extended_memory_size = Math.ceil((total - ARM64_MAX_MEMORY_SIZE) / 2) * 2 * MB;
            }
        }
        else if(settings.extended_memory_size && settings.cpu_type !== "x86_64")
        {
            console.log("More than " + MAX_HEAP_MEMORY_SIZE + " MB of memory: selecting the x86_64 CPU");
            settings.cpu_type = "x86_64";
            updates["cpu_type"] = "x86_64";
        }
        if(settings.cpu_type !== DEFAULT_CPU_TYPE) new_query_args.set("cpu_type", settings.cpu_type);

        // (the instruction sets come with the CPU type, docs/x86-64.md: x86
        // up to SSE3, x86_64 all of them; the library's cpu_features option
        // is for tests and debugging, the page has none, and an old link's
        // cpu_features is dropped)

        if(settings.machine_type === undefined)
        {
            settings.machine_type = form.machine_type || DEFAULT_MACHINE_TYPE;
        }
        // the arm64 CPU runs on the virt machine, the x86 CPUs on the PC
        // machines (src/machine_options.js)
        const arm = settings.cpu_type === "arm64" || settings.cpu_type === "arm32";
        if(arm !== (settings.machine_type === "virt" || settings.machine_type === "ranchu"))
        {
            settings.machine_type = arm ? "virt" : DEFAULT_MACHINE_TYPE;
            updates["machine_type"] = settings.machine_type;
        }
        if(settings.machine_type !== DEFAULT_MACHINE_TYPE) new_query_args.set("machine_type", settings.machine_type);
        if(settings.machine_type === "q35")
        {
            // Q35's own devices are not on the form: the page's machine has
            // Q35_PAGE_DEVICES (?hpet=, ?smbus= and ?root_ports= change them)
            if(settings.hpet === undefined) settings.hpet = Q35_PAGE_DEVICES.hpet;
            if(settings.smbus === undefined) settings.smbus = Q35_PAGE_DEVICES.smbus;
            if(settings.pcie_root_ports === undefined) settings.pcie_root_ports = Q35_PAGE_DEVICES.pcie_root_ports;
            if(settings.hpet !== Q35_PAGE_DEVICES.hpet) new_query_args.set("hpet", settings.hpet ? "1" : "0");
            if(settings.smbus !== Q35_PAGE_DEVICES.smbus) new_query_args.set("smbus", settings.smbus ? "1" : "0");
            if(settings.pcie_root_ports !== Q35_PAGE_DEVICES.pcie_root_ports) new_query_args.set("root_ports", String(settings.pcie_root_ports));
        }

        // multiple cores are described to the guest through ACPI (MADT);
        // Q35 always has ACPI (virt describes itself with a device tree)
        if(is_arm(settings.cpu_type))
        {
            settings.acpi = false;
        }
        else if((settings.cpu_cores > 1 || settings.machine_type === "q35") && !settings.acpi)
        {
            settings.acpi = true;
            updates["acpi"] = true;
        }
        if(settings.acpi === undefined)
        {
            settings.acpi = form.acpi;
        }
        if(settings.acpi) new_query_args.set("acpi", "1");

        const BIOSPATH = "bios/";

        if(is_arm(settings.cpu_type))
        {
            // (virt: no PC firmware, ACPI, VGA or NE2000)
            settings.acpi = false;
            if(settings.graphics_adapter !== "virtio_gpu") settings.graphics_adapter = "none";
        }
        else if(!settings.bios)
        {
            settings.bios = { url: BIOSPATH + (page.debug ? "seabios-debug.bin" : "seabios.bin") };
        }
        if(!settings.vga_bios && !is_arm(settings.cpu_type))
        {
            settings.vga_bios = { url: BIOSPATH + (page.debug ? "vgabios-debug.bin" : "vgabios.bin") };
        }
        if(settings.use_bochs_bios && !is_arm(settings.cpu_type))
        {
            settings.bios = { url: BIOSPATH + "bochs-bios.bin" };
            settings.vga_bios = { url: BIOSPATH + "bochs-vgabios.bin" };
        }

        const nic_type = form.net_device_type || DEFAULT_NIC_TYPE;
        if(!settings.net_device_type || nic_type !== DEFAULT_NIC_TYPE)
        {
            settings.net_device_type = nic_type;
        }
        if(settings.net_device_type !== DEFAULT_NIC_TYPE) new_query_args.set("net_device_type", settings.net_device_type);

        const audio_device = form.audio_device || DEFAULT_AUDIO_DEVICE;
        if(!settings.audio_device || audio_device !== DEFAULT_AUDIO_DEVICE)
        {
            settings.audio_device = audio_device;
        }
        if(settings.audio_device !== DEFAULT_AUDIO_DEVICE) new_query_args.set("audio_device", settings.audio_device);

        const mtu = parseInt(form.mtu, 10) || DEFAULT_MTU;
        if(!settings.mtu || mtu !== DEFAULT_MTU)
        {
            settings.mtu = mtu;
        }
        if(settings.mtu !== DEFAULT_MTU) new_query_args.set("mtu", settings.mtu.toString());

        const modem = parseInt(form.modem, 10);
        if(!Number.isNaN(modem) && modem >= 0 && modem < 4)
        {
            settings.modem = {uart: modem};
            new_query_args.set("modem", modem.toString());
        }
    }

    return { error: undefined, title, updates };
}

/**
 * What virtio_gpu is pinned to (graphics_adapter_test, the device's own
 * name for it): its displays, and its level when the settings ask for one
 * (virtio_gpu_level: "venus", Vulkan through the page's renderer)
 * @param {!Object} settings
 * @return {(Object|undefined)}
 */
function virtio_gpu_test(settings)
{
    if(settings.graphics_adapter !== "virtio_gpu") return undefined;
    const test = {};
    if(settings.displays > 1) test["scanouts"] = settings.displays;
    if(settings.virtio_gpu_level) test["level"] = settings.virtio_gpu_level;
    return Object.keys(test).length ? test : undefined;
}

/**
 * The options of new V86() for the settings
 * @param {!Object} settings
 * @param {{cpu_worker: boolean, debug: boolean, query_append: string, graphics_proxy: (Object|boolean), screen_container: *}} env
 *     the page: the CPU in a Worker, the debug builds, the files' ?version, the graphics proxy's
 *     option, the screen's element
 * @return {!Object}
 */
export function settings_to_options(settings, env)
{
    const query_append = env.query_append;
    const debug = env.debug;
    return {
        "cpu_worker": env.cpu_worker,
        "cpu_worker_url": "build/cpu-worker.js" + query_append,
        "ir_tier0": settings["ir_tier0"],
        // (the core of the CPU type: arm64's is a separate build, docs/aarch64.md)
        wasm_path: "build/" + (is_arm(settings.cpu_type) ? (debug ? "v86-arm64-debug.wasm" : "v86-arm64.wasm") :
            debug ? "v86-debug.wasm" : "v86.wasm") + query_append,
        // more than one core: each in a host thread (v86-parallel.wasm) where the
        // page is cross-origin isolated and the host has the threads; otherwise
        // the build above with the cores taking turns (see the runtime infos)
        "parallel": settings.cpu_cores > 1 && settings.parallel ? "auto" : false,
        "parallel_wasm_path": "build/" + (is_arm(settings.cpu_type) ? "v86-arm64-parallel.wasm" : "v86-parallel.wasm") + query_append,
        // (the source tree's module entry, unless the bundled CPU worker starts them)
        "vcpu_worker_url": debug && !env.cpu_worker ? undefined : "build/vcpu-worker.js" + query_append,
        "graphics_proxy": env.graphics_proxy,
        screen: {
            container: env.screen_container,
        },
        net_device: {
            type: is_arm(settings.cpu_type) ? "virtio" : settings.net_device_type || DEFAULT_NIC_TYPE,
            relay_url: settings.relay_url,
            cors_proxy: settings.cors_proxy,
            mtu: settings.mtu
        },
        modem: is_arm(settings.cpu_type) ? undefined : settings.modem,
        autostart: true,

        memory_size: settings.memory_size,
        extended_memory_size: settings.extended_memory_size || undefined,
        "graphics_adapter": settings.graphics_adapter || DEFAULT_GRAPHICS_ADAPTER,
        "vram_size": settings.vram_size,
        "graphics_adapter_test": virtio_gpu_test(settings),
        boot_order: settings.boot_order,

        // the arm64 virt machine (docs/virt.md): the page's kernel and
        // initrd, the CD-ROM image and the disks as virtio-blk disks (the
        // image read-only), virtio-rng, the keyboard, tablet and touch screen
        // with a display; the PC's firmware, floppies and IDE otherwise
        ...(is_arm(settings.cpu_type) ? {
            kernel: settings.bzimage,
            initrd: settings.initrd,
            virtio_disks: [settings.cdrom && Object.assign({}, settings.cdrom, { readonly: true }), settings.hda, settings.hdb].filter(Boolean),
            virtio_rng: true,
            virtio_input: settings.graphics_adapter === "virtio_gpu" ? ["keyboard", "tablet", "multitouch"] : undefined,
            cmdline: settings.cmdline || (settings.graphics_adapter === "virtio_gpu" ? ARM64_DEFAULT_CMDLINE : ARM64_SERIAL_CMDLINE),
            // (the A64 page tier: the library's default is off until its F gate;
            // quoted, as the library reads it, or Closure renames it)
            "jit_switches": settings.disable_jit ? undefined : { "a64_page": 1 },
        } : {
            bios: settings.bios,
            vga_bios: settings.vga_bios,
            fda: settings.fda,
            fdb: settings.fdb,
            hda: settings.hda,
            hdb: settings.hdb,
            cdrom: settings.cdrom,
            multiboot: settings.multiboot,
            bzimage: settings.bzimage,
            initrd: settings.initrd,
            cmdline: settings.cmdline,
            bzimage_initrd_from_filesystem: settings.bzimage_initrd_from_filesystem,
        }),
        acpi: !is_arm(settings.cpu_type) && (settings.acpi || settings.cpu_cores > 1 || settings.machine_type === "q35"),
        // (the CPU model: the cpu_type's default when not chosen; generic-arm64-compat32 runs 32-bit programs too)
        "cpu_profile": settings.cpu_profile || undefined,
        cpu_cores: settings.cpu_cores,
        "cpu_type": settings.cpu_type,
        machine_type: settings.machine_type,
        pcie_root_ports: settings.machine_type === "q35" ? settings.pcie_root_ports : undefined,
        hpet: settings.machine_type === "q35" ? settings.hpet : undefined,
        smbus: settings.machine_type === "q35" ? settings.smbus : undefined,
        // without it, more than one core runs in the interpreter
        experimental_smp_jit: settings.cpu_cores > 1 && !settings.disable_jit,
        disable_jit: settings.disable_jit,
        "x87_fast_math": is_arm(settings.cpu_type) ? undefined : settings["x87_fast_math"],
        "x87_jit_cache": is_arm(settings.cpu_type) ? undefined : settings["x87_jit_cache"],
        initial_state: settings.initial_state,
        filesystem: settings.filesystem || {},
        disable_speaker: settings.disable_audio,
        // (the library's default is the SB16; the virt machine has virtio_sound)
        audio_device: is_arm(settings.cpu_type) || !settings.audio_device || settings.audio_device === DEFAULT_AUDIO_DEVICE ?
            undefined : settings.audio_device,
        mac_address_translation: settings.mac_address_translation,
        cpuid_level: settings.cpuid_level,
    };
}
