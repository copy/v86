// @ts-check
// A virtual machine's configuration in the VM manager (docs/vm-manager-plan.md,
// "虚拟机配置格式", U1): the format and its version, the defaults, the
// migration of older versions, the checks, the V86 options of a
// configuration (config_to_options, with the old page's rules of
// src/browser/vm_options.js) and the configuration of an old page's profile
// (src/browser/profiles.js).

import { CPU_TYPES, MACHINE_TYPES, MAX_VRAM_SIZE, Q35_ROOT_PORTS_MAX, allowed_options, check_machine_options } from "../machine_options.js";
import { DISK_OPTIONS, DISK_ERRORS, check_disk_options } from "../disk_options.js";
import { DEFAULT_FORM, DEFAULT_MEMORY_SIZE, MAX_MEMORY_SIZE, MAX_HEAP_MEMORY_SIZE, MAX_ARRAY_BUFFER_SIZE_MB, DEFAULT_VGA_MEMORY_SIZE,
    DEFAULT_MTU, apply_form, settings_to_options } from "../browser/vm_options.js";

export const FORMAT = "v86-vm";
export const VERSION = 1;

/**
 * Where an image is (the plan's 镜像来源): a URL (or a disk service's), a
 * file on this computer (its handle in the store, src/app/vm_store.js), an
 * empty disk in memory, or a browser disk (OPFS)
 * @typedef {{kind: "url", url: string, size?: number, async?: boolean, fixed_chunk_size?: number, use_parts?: boolean}
 *     | {kind: "file", name: string, size: number, last_modified: number, handle?: string}
 *     | {kind: "empty", size: number}
 *     | {kind: "browser", path: string, size: number}} Image
 */

/**
 * @typedef {Object} Disk
 * @property {"hda" | "hdb"} slot
 * @property {Image} image
 * @property {"read_only" | "read_write"} disk_option
 * @property {"stop" | "report"} disk_error
 */

/**
 * @typedef {Object} Floppy
 * @property {"fda" | "fdb"} slot
 * @property {Image | null} image
 * @property {"read_only" | "read_write"} disk_option
 */

/**
 * @typedef {Object} Network
 * @property {string} device ne2k, virtio or none
 * @property {"none" | "inbrowser" | "relay" | "wisp" | "fetch"} backend
 * @property {string} relay_url the relay's or wisp's URL; fetch: the CORS proxy, or ""
 * @property {number} mtu
 * @property {boolean} mac_address_translation
 */

/**
 * @typedef {Object} VMConfig
 * @property {"v86-vm"} format
 * @property {number} version
 * @property {string} id
 * @property {string} name
 * @property {string} notes
 * @property {string} guest the preset's family (src/app/guest_presets.js), or "other"
 * @property {string | null} template the preset it was made from
 * @property {string} created
 * @property {string} modified
 * @property {{type: string, acpi: boolean, hpet: boolean, smbus: boolean, pcie_root_ports: number, boot_order: number,
 *     fastboot: boolean, bootmenu: boolean, bios: Image | null, vga_bios: Image | null}} machine
 * @property {{type: string, cores: number, parallel: boolean, jit: boolean}} cpu
 * @property {{mb: number}} memory
 * @property {Disk[]} disks
 * @property {{image: Image | null, disk_error: "stop" | "report"}} cdrom
 * @property {Floppy[]} floppies
 * @property {{bzimage: Image | null, initrd: Image | null, cmdline: string | null, multiboot: Image | null, from_filesystem: boolean} | null} kernel
 * @property {{adapter: string, vram_mb: number | null, proxy: boolean, displays: number}} display vram_mb: null
 *     with an initial_state, whose video memory it is
 * @property {Network[]} network one in version 1
 * @property {{device: "sb16" | "none"}} sound
 * @property {{port: number, attach: "none" | "terminal" | "modem"}[]} serial
 * @property {{baseurl?: string, basefs?: {url: string}} | null} filesystem the 9p file system: its files' base URL, its description (fs.json)
 * @property {Image | null} initial_state a state to start from (an old page's profile with a state)
 * @property {{cpu_worker: boolean, ir_tier0: boolean, x87_fast_math: boolean, x87_jit_cache: boolean,
 *     cpuid_level: number | null, mouse_disabled: boolean}} advanced
 * @property {{size: number, time: string, digest: string} | null} suspended the suspended state (U5)
 */

/** The network backends and the old page's relay_url of each */
export const NETWORK_BACKENDS = ["none", "inbrowser", "relay", "wisp", "fetch"];
/** The boot orders the old page offers (index.html's boot_order) */
export const BOOT_ORDERS = [0, 0x213, 0x123, 0x231, 0x321, 0x312, 0x132];
export const SOUND_DEVICES = ["sb16", "none"];
export const SERIAL_ATTACH = ["none", "terminal", "modem"];
/** The floppy images' sizes (as the old page's empty floppies, src/floppy.js) */
export const FLOPPY_SIZES = [320, 360, 400, 640, 720, 800, 1440, 2400, 2880, 3444, 5760, 7680].map(sectors => sectors * 512);

/**
 * A new identifier
 * @return {string}
 */
export function new_id()
{
    return globalThis.crypto.randomUUID();
}

/**
 * A new configuration with the defaults: the old page's machine before
 * anyone changes its form (DEFAULT_FORM)
 * @param {Partial<VMConfig>} [fields]
 * @return {VMConfig}
 */
export function new_config(fields = {})
{
    const now = new Date().toISOString();
    return with_defaults(Object.assign({ format: FORMAT, version: VERSION, id: new_id(), created: now, modified: now }, fields));
}

/** @param {*} value */
const is_object = value => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A configuration with each field it lacks set to its default (the fields
 * it has stay, the checks are validate_config's)
 * @param {Object} config
 * @return {VMConfig}
 */
export function with_defaults(config)
{
    /** @type {any} */
    const c = Object.assign({}, config);
    const section = (name, defaults) => { c[name] = Object.assign(defaults, is_object(c[name]) ? c[name] : {}); };
    c.format = c.format ?? FORMAT;
    c.version = c.version ?? VERSION;
    c.name = c.name ?? "New virtual machine";
    c.notes = c.notes ?? "";
    c.guest = c.guest ?? "other";
    c.template = c.template ?? null;
    c.created = c.created ?? new Date().toISOString();
    c.modified = c.modified ?? c.created;
    section("machine", { type: DEFAULT_FORM.machine_type, acpi: DEFAULT_FORM.acpi, hpet: false, smbus: false, pcie_root_ports: 0,
        boot_order: 0, fastboot: false, bootmenu: false, bios: null, vga_bios: null });
    section("cpu", { type: DEFAULT_FORM.cpu_type, cores: 1, parallel: DEFAULT_FORM.parallel, jit: true });
    section("memory", { mb: DEFAULT_MEMORY_SIZE });
    c.disks = Array.isArray(c.disks) ? c.disks.map(d => Object.assign({ disk_option: "read_only", disk_error: "stop" }, d)) : [];
    section("cdrom", { image: null, disk_error: "stop" });
    c.floppies = Array.isArray(c.floppies) ? c.floppies.map(f => Object.assign({ image: null, disk_option: "read_only" }, f)) : [];
    c.kernel = is_object(c.kernel) ? Object.assign({ bzimage: null, initrd: null, cmdline: null, multiboot: null, from_filesystem: false }, c.kernel) : null;
    section("display", { adapter: DEFAULT_FORM.graphics_adapter, vram_mb: DEFAULT_VGA_MEMORY_SIZE, proxy: false, displays: 1 });
    c.network = Array.isArray(c.network) ? c.network.map(n => Object.assign(default_network(), n)) : [default_network()];
    section("sound", { device: "sb16" });
    c.serial = Array.isArray(c.serial) ? c.serial : [{ port: 0, attach: "terminal" }];
    c.filesystem = is_object(c.filesystem) ? c.filesystem : null;
    c.initial_state = is_object(c.initial_state) ? c.initial_state : null;
    section("advanced", { cpu_worker: true, ir_tier0: true, x87_fast_math: true, x87_jit_cache: true, cpuid_level: null, mouse_disabled: false });
    c.suspended = is_object(c.suspended) ? c.suspended : null;
    return c;
}

/**
 * The old page's network: its card and relay
 * @return {Network}
 */
function default_network()
{
    return { device: DEFAULT_FORM.net_device_type, backend: "relay", relay_url: DEFAULT_FORM.relay_url, mtu: DEFAULT_MTU, mac_address_translation: false };
}

/**
 * Each version's change to the next (none yet: version 1 is the first)
 * @type {Object<number, function(any): any>}
 */
const MIGRATIONS = {};

/**
 * A stored or imported configuration in the current version: older versions
 * changed step by step, missing fields set to their defaults
 * @param {*} raw
 * @return {VMConfig}
 */
export function migrate(raw)
{
    if(!is_object(raw) || raw.format !== FORMAT)
    {
        throw new Error("This is not a v86 virtual machine (" + JSON.stringify(FORMAT) + " format)");
    }
    let config = raw;
    let version = config.version;
    if(!Number.isInteger(version) || version < 1)
    {
        throw new Error("The virtual machine's format version " + JSON.stringify(version) + " is not valid");
    }
    if(version > VERSION)
    {
        throw new Error("The virtual machine was made by a newer v86 (format version " + version + "; this one reads up to " + VERSION + ")");
    }
    while(version < VERSION)
    {
        config = MIGRATIONS[version](config);
        version++;
        config.version = version;
    }
    return with_defaults(config);
}

/**
 * @typedef {{path: string, message: string}} Problem a field (as "machine.type", "disks.0.image") and what is wrong
 */

/**
 * The problems of an image's description
 * @param {*} image
 * @param {string} path
 * @param {Problem[]} problems
 */
function check_image(image, path, problems)
{
    const problem = message => problems.push({ path, message });
    if(!is_object(image))
    {
        problem("an image is an object with a kind");
        return;
    }
    const size_ok = size => Number.isSafeInteger(size) && size > 0;
    switch(image.kind)
    {
        case "url":
            if(typeof image.url !== "string" || !image.url) problem("the image's URL is missing");
            if(image.size !== undefined && !size_ok(image.size)) problem("the image's size must be a positive integer");
            break;
        case "file":
            if(typeof image.name !== "string" || !image.name) problem("the file's name is missing");
            if(!Number.isSafeInteger(image.size) || image.size < 0) problem("the file's size must be a non-negative integer");
            break;
        case "empty":
            if(!size_ok(image.size)) problem("an empty disk's size must be a positive integer");
            break;
        case "browser":
            if(typeof image.path !== "string" || !/^v86\/disks\/[A-Za-z0-9_-]+\.img$/.test(image.path))
            {
                problem("a browser disk's path is v86/disks/<id>.img");
            }
            if(!size_ok(image.size)) problem("the browser disk's size must be a positive integer");
            break;
        default:
            problem("the image's kind is url, file, empty or browser, not " + JSON.stringify(image.kind));
    }
}

/**
 * The problems of a configuration: each field's values and the combinations
 * the machines allow (allowed_options); none for a configuration that
 * config_to_options can start
 * @param {VMConfig} config
 * @return {Problem[]}
 */
export function validate_config(config)
{
    /** @type {Problem[]} */
    const problems = [];
    const problem = (path, message) => problems.push({ path, message });
    const bool = (value, path) => { if(typeof value !== "boolean") problem(path, "must be true or false"); };
    const int = (value, path, min, max) =>
    {
        if(!Number.isInteger(value) || value < min || value > max) problem(path, "must be an integer from " + min + " to " + max);
    };

    if(config.format !== FORMAT) problem("format", "must be " + JSON.stringify(FORMAT));
    if(config.version !== VERSION) problem("version", "must be " + VERSION);
    if(typeof config.id !== "string" || !config.id) problem("id", "is missing");
    if(typeof config.name !== "string" || !config.name.trim()) problem("name", "a virtual machine needs a name");
    else if(config.name.length > 200) problem("name", "is longer than 200 characters");
    if(typeof config.notes !== "string") problem("notes", "must be text");

    const machine = config.machine, cpu = config.cpu;
    // (the rest depends on the CPU and the machine)
    if(!CPU_TYPES.includes(cpu.type) || !MACHINE_TYPES.includes(machine.type))
    {
        if(!CPU_TYPES.includes(cpu.type)) problem("cpu.type", "must be one of " + CPU_TYPES.join(", "));
        if(!MACHINE_TYPES.includes(machine.type)) problem("machine.type", "must be one of " + MACHINE_TYPES.join(", "));
        return problems;
    }

    const allowed = allowed_options(cpu.type, machine.type);
    const virt = machine.type === "virt";
    if(!allowed.machine_types.includes(machine.type))
    {
        problem("machine.type", cpu.type === "arm64" ? "the arm64 CPU runs on the virt machine" : "the virt machine needs the arm64 CPU");
        return problems;
    }

    int(cpu.cores, "cpu.cores", 1, allowed.max_cores);
    bool(cpu.parallel, "cpu.parallel");
    bool(cpu.jit, "cpu.jit");

    int(config.memory.mb, "memory.mb", 16, MAX_MEMORY_SIZE);
    if(config.memory.mb > MAX_HEAP_MEMORY_SIZE && cpu.type === "x86")
    {
        problem("memory.mb", "more than " + MAX_HEAP_MEMORY_SIZE + " MB needs a 64-bit CPU (x86_64)");
    }

    bool(machine.acpi, "machine.acpi");
    if(virt && machine.acpi) problem("machine.acpi", allowed.unavailable["acpi"]);
    if(allowed.acpi === "required" && !machine.acpi) problem("machine.acpi", "the Q35 machine always has ACPI");
    if(allowed.acpi === "with_cores" && cpu.cores > 1 && !machine.acpi) problem("machine.acpi", "more than one core needs ACPI");
    for(const name of ["hpet", "smbus"])
    {
        bool(machine[name], "machine." + name);
        if(machine[name] && allowed.unavailable[name]) problem("machine." + name, allowed.unavailable[name]);
    }
    int(machine.pcie_root_ports, "machine.pcie_root_ports", 0, Q35_ROOT_PORTS_MAX);
    if(machine.pcie_root_ports && allowed.unavailable["pcie_root_ports"]) problem("machine.pcie_root_ports", allowed.unavailable["pcie_root_ports"]);
    if(!BOOT_ORDERS.includes(machine.boot_order)) problem("machine.boot_order", "must be one of the boot orders (0 for automatic)");
    bool(machine.fastboot, "machine.fastboot");
    bool(machine.bootmenu, "machine.bootmenu");
    for(const name of ["bios", "vga_bios"])
    {
        if(machine[name] === null) continue;
        if(virt) problem("machine." + name, allowed.unavailable[name]);
        else check_image(machine[name], "machine." + name, problems);
    }

    // the disks (docs/disk-persistence-plan.md: read write needs a source that can be written back)
    const slots = new Set();
    config.disks.forEach((disk, i) =>
    {
        const path = "disks." + i;
        if(disk.slot !== "hda" && disk.slot !== "hdb") problem(path + ".slot", "must be hda or hdb");
        else if(slots.has(disk.slot)) problem(path + ".slot", disk.slot + " is given twice");
        slots.add(disk.slot);
        check_image(disk.image, path + ".image", problems);
        if(!DISK_OPTIONS.includes(disk.disk_option)) problem(path + ".disk_option", "must be read_only or read_write");
        if(!DISK_ERRORS.includes(disk.disk_error)) problem(path + ".disk_error", "must be stop or report");
        if(disk.disk_option === "read_write" && disk.image && (disk.image.kind === "file" || disk.image.kind === "empty"))
        {
            problem(path + ".disk_option", disk.image.kind === "file" ?
                "a file chosen on this computer can only be read: its changes stay in memory (read write needs a disk service or a browser disk)" :
                "an empty disk in memory has nothing to write back to: use a browser disk or a disk service");
        }
        if(disk.image && disk.image.kind === "empty" && disk.image.size > MAX_ARRAY_BUFFER_SIZE_MB * 1024 * 1024)
        {
            problem(path + ".image", "an empty disk in memory has at most " + MAX_ARRAY_BUFFER_SIZE_MB + " MB");
        }
    });
    if(config.cdrom.image !== null) check_image(config.cdrom.image, "cdrom.image", problems);
    if(config.cdrom.image && config.cdrom.image.kind === "empty") problem("cdrom.image", "a CD-ROM is not empty");
    if(!DISK_ERRORS.includes(config.cdrom.disk_error)) problem("cdrom.disk_error", "must be stop or report");
    const floppies = new Set();
    config.floppies.forEach((floppy, i) =>
    {
        const path = "floppies." + i;
        if(virt) problem(path, allowed.unavailable["fda"]);
        if(floppy.slot !== "fda" && floppy.slot !== "fdb") problem(path + ".slot", "must be fda or fdb");
        else if(floppies.has(floppy.slot)) problem(path + ".slot", floppy.slot + " is given twice");
        floppies.add(floppy.slot);
        if(floppy.image !== null) check_image(floppy.image, path + ".image", problems);
        if(floppy.image && floppy.image.kind === "empty" && !FLOPPY_SIZES.includes(floppy.image.size))
        {
            problem(path + ".image", "an empty floppy has one of the floppy sizes");
        }
        if(!DISK_OPTIONS.includes(floppy.disk_option)) problem(path + ".disk_option", "must be read_only or read_write");
    });

    if(config.kernel !== null)
    {
        for(const name of ["bzimage", "initrd", "multiboot"])
        {
            if(config.kernel[name] !== null) check_image(config.kernel[name], "kernel." + name, problems);
        }
        if(virt && config.kernel.multiboot) problem("kernel.multiboot", allowed.unavailable["multiboot"]);
        if(config.kernel.cmdline !== null && typeof config.kernel.cmdline !== "string") problem("kernel.cmdline", "must be text");
        bool(config.kernel.from_filesystem, "kernel.from_filesystem");
    }

    const display = config.display;
    if(!allowed.graphics_adapters.includes(display.adapter))
    {
        problem("display.adapter", virt ? "the virt machine has no VGA: virtio-gpu or none" : "must be one of " + allowed.graphics_adapters.join(", "));
    }
    if(display.vram_mb === null)
    {
        if(config.initial_state === null) problem("display.vram_mb", "only a state image has the video memory it was saved with");
    }
    else if(!Number.isInteger(display.vram_mb) || display.vram_mb < 1 || display.vram_mb > MAX_VRAM_SIZE >> 20 || (display.vram_mb & display.vram_mb - 1))
    {
        problem("display.vram_mb", "must be a power of two from 1 to " + (MAX_VRAM_SIZE >> 20) + " MB");
    }
    bool(display.proxy, "display.proxy");
    int(display.displays, "display.displays", 1, 4);
    if(display.displays > 1 && display.adapter !== "virtio_gpu") problem("display.displays", "only virtio-gpu has more than one display");

    if(config.network.length > 1) problem("network", "this version has one network card");
    config.network.forEach((network, i) =>
    {
        const path = "network." + i;
        if(!allowed.net_device_types.includes(network.device))
        {
            problem(path + ".device", virt ? "the virt machine has virtio-net" : "must be one of " + allowed.net_device_types.join(", "));
        }
        if(!NETWORK_BACKENDS.includes(network.backend)) problem(path + ".backend", "must be one of " + NETWORK_BACKENDS.join(", "));
        const url = network.relay_url;
        if(network.backend === "relay" && !/^wss?:\/\//.test(url)) problem(path + ".relay_url", "a relay's URL starts with ws:// or wss://");
        if(network.backend === "wisp" && !/^wisps?:\/\//.test(url)) problem(path + ".relay_url", "a wisp server's URL starts with wisp:// or wisps://");
        if(network.backend === "fetch" && url && !/^https?:\/\//.test(url)) problem(path + ".relay_url", "the CORS proxy's URL starts with http:// or https://");
        int(network.mtu, path + ".mtu", 68, 65535);
        bool(network.mac_address_translation, path + ".mac_address_translation");
    });

    if(!SOUND_DEVICES.includes(config.sound.device)) problem("sound.device", "must be sb16 or none");
    if(virt && config.sound.device !== "none") problem("sound.device", "the virt machine has no Sound Blaster");

    const ports = new Set();
    let modems = 0;
    config.serial.forEach((serial, i) =>
    {
        const path = "serial." + i;
        int(serial.port, path + ".port", 0, 3);
        if(ports.has(serial.port)) problem(path + ".port", "UART" + serial.port + " is given twice");
        ports.add(serial.port);
        if(!SERIAL_ATTACH.includes(serial.attach)) problem(path + ".attach", "must be none, terminal or modem");
        if(serial.attach === "modem") modems++;
        if(serial.attach === "modem" && virt) problem(path + ".attach", allowed.unavailable["modem"]);
    });
    if(modems > 1) problem("serial", "one modem at most");

    if(config.filesystem !== null)
    {
        const { baseurl, basefs } = config.filesystem;
        if(baseurl !== undefined && typeof baseurl !== "string") problem("filesystem.baseurl", "must be a URL");
        // (the file system's description, fs.json: as a file of the library, { url })
        if(basefs !== undefined && !(is_object(basefs) && typeof basefs.url === "string")) problem("filesystem.basefs", "must be { url }");
    }
    if(config.initial_state !== null)
    {
        check_image(config.initial_state, "initial_state", problems);
        if(config.initial_state.kind === "empty") problem("initial_state", "a state is not empty");
    }

    const advanced = config.advanced;
    for(const name of ["cpu_worker", "ir_tier0", "x87_fast_math", "x87_jit_cache", "mouse_disabled"])
    {
        bool(advanced[name], "advanced." + name);
    }
    if(advanced.cpuid_level !== null) int(advanced.cpuid_level, "advanced.cpuid_level", 1, 0x20);
    if(virt && advanced.cpuid_level !== null) problem("advanced.cpuid_level", allowed.unavailable["cpuid_level"]);
    return problems;
}

/**
 * Every problem of a configuration, the library's checks of its options
 * included (check_machine_options, check_disk_options): the settings dialog's
 * check before saving
 * @param {VMConfig} config
 * @return {Problem[]}
 */
export function check_config(config)
{
    const problems = validate_config(config);
    if(problems.length) return problems;
    // (a picked file stands in as an empty Blob: the checks look at the kind of source)
    const options = config_to_options(config, { debug: false, query_append: "", graphics_proxy: false, screen_container: undefined, file: () => new Blob([]) });
    for(const [path, check] of [["machine", check_machine_options], ["disks", check_disk_options]])
    {
        try
        {
            check(options);
        }
        catch(e)
        {
            problems.push({ path, message: e.message });
        }
    }
    return problems;
}

/**
 * An image of an old page's profile (its url, size, async, fixed_chunk_size, use_parts)
 * @param {*} image
 * @return {Image | null}
 */
function profile_image(image)
{
    if(!image) return null;
    /** @type {any} */
    const result = { kind: "url", url: image.url };
    for(const name of ["size", "async", "fixed_chunk_size", "use_parts"])
    {
        if(image[name] !== undefined) result[name] = image[name];
    }
    return result;
}

/**
 * The configuration of an old page's profile (src/browser/profiles.js), for
 * the console's "add to the library" (U4): the same machine, as the old page
 * starts it with the form's defaults (form: the page's own, DEFAULT_FORM by default)
 * @param {Object} profile
 * @param {Object} [form]
 * @return {VMConfig}
 */
export function profile_to_config(profile, form = DEFAULT_FORM)
{
    /** @type {any} */
    const p = profile;
    const MB = 1024 * 1024;
    const kernel = p.bzimage || p.initrd || p.multiboot || p.cmdline || p.bzimage_initrd_from_filesystem ? {
        bzimage: profile_image(p.bzimage), initrd: profile_image(p.initrd), multiboot: profile_image(p.multiboot),
        cmdline: p.cmdline ?? null, from_filesystem: !!p.bzimage_initrd_from_filesystem,
    } : null;
    const relay_url = form.relay_url;
    const backend = !relay_url ? "none" : relay_url === "inbrowser" ? "inbrowser" : relay_url.startsWith("fetch") ? "fetch" :
        /^wisps?:/.test(relay_url) ? "wisp" : "relay";
    return new_config({
        name: p.name,
        notes: p.homepage ? p.homepage : "",
        template: "profile:" + p.id,
        machine: /** @type {any} */ ({ acpi: !!p.acpi, boot_order: p.boot_order || 0 }),
        memory: { mb: p.memory_size ? p.memory_size / MB : DEFAULT_MEMORY_SIZE },
        disks: /** @type {any} */ ([["hda", p.hda], ["hdb", p.hdb]].filter(([, image]) => image).map(([slot, image]) => ({ slot, image: profile_image(image) }))),
        cdrom: /** @type {any} */ ({ image: profile_image(p.cdrom) }),
        floppies: /** @type {any} */ ([["fda", p.fda], ["fdb", p.fdb]].filter(([, image]) => image).map(([slot, image]) => ({ slot, image: profile_image(image) }))),
        kernel,
        display: /** @type {any} */ ({ adapter: p.graphics_adapter || DEFAULT_FORM.graphics_adapter,
            vram_mb: p.vram_size ? p.vram_size / MB : p.state ? null : DEFAULT_VGA_MEMORY_SIZE }),
        network: [{ device: p.net_device_type || DEFAULT_FORM.net_device_type, backend, relay_url: backend === "fetch" ? relay_url.slice(6) :
            backend === "relay" || backend === "wisp" ? relay_url : "", mtu: DEFAULT_MTU, mac_address_translation: !!p.mac_address_translation }],
        serial: p.modem ? (p.modem.uart === 0 ? [] : [{ port: 0, attach: "terminal" }]).concat([{ port: p.modem.uart, attach: "modem" }]) :
            [{ port: 0, attach: "terminal" }],
        filesystem: p.filesystem || null,
        initial_state: profile_image(p.state),
        advanced: /** @type {any} */ ({ cpuid_level: p.cpuid_level ?? null, mouse_disabled: !!p.mouse_disabled_default }),
    });
}

/**
 * An image of a configuration as a
 * V86 image option: a URL as given, a file (env.file finds the picked File
 * for it), an empty disk in memory, a browser disk (OPFS: "opfs:<path>")
 * @param {Image | null} image
 * @param {(image: Image) => (Blob | undefined)} file
 * @return {any}
 */
function image_option(image, file)
{
    if(!image) return undefined;
    switch(image.kind)
    {
        case "url":
        {
            /** @type {any} */
            const option = { url: image.url };
            for(const name of ["size", "async", "fixed_chunk_size", "use_parts"])
            {
                if(image[name] !== undefined) option[name] = image[name];
            }
            return option;
        }
        case "file":
        {
            const buffer = file(image);
            if(!buffer) throw new Error("The file " + image.name + " needs to be chosen again");
            return { buffer };
        }
        case "empty":
            return { buffer: new ArrayBuffer(image.size) };
        case "browser":
            return { url: "opfs:" + image.path, size: image.size };
    }
    throw new Error("Unknown image kind " + JSON.stringify(/** @type {any} */ (image).kind));
}

/**
 * The old page's relay_url of a configuration's network backend
 * @param {Network | undefined} network
 * @return {string}
 */
function relay_url_of(network)
{
    if(!network) return "";
    switch(network.backend)
    {
        case "inbrowser": return "inbrowser";
        case "fetch": return network.relay_url ? "fetch:" + network.relay_url : "fetch";
        case "relay": case "wisp": return network.relay_url;
    }
    return "";
}

/**
 * The V86 options of a configuration (checked by validate_config): its
 * fields as the settings of a profile and of the address, the form filled
 * in with them, both made consistent by apply_form as the old page does
 * (src/browser/vm_options.js), then settings_to_options
 * @param {VMConfig} config
 * @param {{debug: boolean, query_append: string, graphics_proxy: (Object | boolean), screen_container: any,
 *     file: (image: Image) => (Blob | undefined)}} env the page (as settings_to_options's), and the
 *     picked File of an image of kind "file"
 * @return {any}
 */
export function config_to_options(config, env)
{
    const MB = 1024 * 1024;
    const image = value => image_option(value, env.file);
    const machine = config.machine, cpu = config.cpu, display = config.display, advanced = config.advanced;
    const network = config.network[0];
    const modem = config.serial.find(serial => serial.attach === "modem");
    /** @type {any} */
    const settings = {};
    settings["ir_tier0"] = advanced.ir_tier0;
    settings["x87_fast_math"] = advanced.x87_fast_math;
    settings["x87_jit_cache"] = advanced.x87_jit_cache;

    // (as a profile's: profile_settings)
    settings.initial_state = image(config.initial_state);
    settings.filesystem = config.filesystem || undefined;
    for(const disk of config.disks)
    {
        const option = image(disk.image);
        if(disk.disk_option === "read_write") option.disk_option = "read_write";
        if(disk.disk_error !== "stop") option.disk_error = disk.disk_error;
        settings[disk.slot] = option;
    }
    settings.cdrom = image(config.cdrom.image);
    if(settings.cdrom && config.cdrom.disk_error !== "stop") settings.cdrom.disk_error = config.cdrom.disk_error;
    for(const floppy of config.floppies)
    {
        const option = image(floppy.image);
        if(option && floppy.disk_option === "read_write") option.disk_option = "read_write";
        settings[floppy.slot] = option;
    }
    if(config.kernel)
    {
        settings.bzimage = image(config.kernel.bzimage);
        settings.initrd = image(config.kernel.initrd);
        settings.multiboot = image(config.kernel.multiboot);
        settings.cmdline = config.kernel.cmdline ?? undefined;
        if(config.kernel.from_filesystem) settings.bzimage_initrd_from_filesystem = true;
    }
    settings.bios = image(machine.bios);
    settings.vga_bios = image(machine.vga_bios);
    if(network && network.mac_address_translation) settings.mac_address_translation = true;
    settings.cpuid_level = advanced.cpuid_level ?? undefined;
    settings.acpi = machine.acpi;
    settings.memory_size = config.memory.mb * MB;
    settings.graphics_adapter = display.adapter;
    settings.vram_size = display.vram_mb === null ? undefined : display.vram_mb * MB;
    settings.boot_order = machine.boot_order || undefined;
    settings.net_device_type = network ? network.device : "none";
    if(modem) settings.modem = { uart: modem.port };

    // (as the address's: apply_query_args; a state image has its own machine)
    if(!settings.initial_state)
    {
        settings.cpu_cores = cpu.cores;
        settings.parallel = cpu.parallel;
        settings.cpu_type = cpu.type;
        settings.machine_type = machine.type;
        if(machine.type === "q35")
        {
            settings.hpet = machine.hpet;
            settings.smbus = machine.smbus;
            settings.pcie_root_ports = machine.pcie_root_ports;
        }
        if(display.displays > 1) settings.displays = display.displays;
        settings.mtu = network ? network.mtu : DEFAULT_MTU;
    }
    settings.relay_url = relay_url_of(network);
    if(!cpu.jit) settings.disable_jit = true;
    if(config.sound.device === "none") settings.disable_audio = true;

    // (the form, filled in with the configuration's values)
    const form = Object.assign({}, DEFAULT_FORM, {
        relay_url: settings.relay_url,
        disable_audio: config.sound.device === "none",
        files: {},
        empty_sizes: {},
        urls: {},
        disk_options: {},
        memory_size: String(config.memory.mb),
        vga_memory_size: String(display.vram_mb ?? DEFAULT_VGA_MEMORY_SIZE),
        graphics_adapter: display.adapter,
        boot_order: machine.boot_order.toString(16),
        cpu_cores: String(cpu.cores),
        parallel: cpu.parallel,
        cpu_type: cpu.type,
        machine_type: machine.type,
        acpi: machine.acpi,
        net_device_type: settings.net_device_type,
        mtu: String(network ? network.mtu : DEFAULT_MTU),
        modem: "none",
    });
    apply_form(settings, form, new Map(), { location_args: new URLSearchParams(), origin: "", debug: env.debug });

    const options = settings_to_options(settings, {
        cpu_worker: advanced.cpu_worker,
        debug: env.debug,
        query_append: env.query_append,
        graphics_proxy: env.graphics_proxy,
        screen_container: env.screen_container,
    });
    // (the firmware's boot options, which the old page does not have)
    if(machine.fastboot) options.fastboot = true;
    if(machine.bootmenu) options.bootmenu = true;
    return options;
}
