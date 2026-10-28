// @ts-check
// A virtual machine's configuration in the VM manager (docs/vm-manager-plan.md,
// "虚拟机配置格式", U1): the format and its version, the defaults, the
// migration of older versions, the checks, the V86 options of a
// configuration (config_to_options, with the old page's rules of
// src/browser/vm_options.js).

import { CPU_PROFILES, MACHINE_CPU_PROFILES, ARM_MACHINE_TYPES, CPU_TYPES, FIRMWARE_TYPES, MACHINE_TYPES, MAX_VRAM_SIZE, Q35_ROOT_PORTS_MAX, USB_PORTS, allowed_options,
    check_machine_options } from "../machine_options.js";
import { ANDROID_DEVICES as ANDROID_DEVICE_MODELS } from "../android/bootloader.js";
import { DEFAULT_GLES_VERSION, GLES_VERSIONS } from "../android/devices.js";
import { DISK_OPTIONS, DISK_ERRORS, check_disk_options } from "../disk_options.js";
import { DEFAULT_FORM, DEFAULT_MEMORY_SIZE, MAX_MEMORY_SIZE, MAX_HEAP_MEMORY_SIZE, MAX_ARRAY_BUFFER_SIZE_MB, DEFAULT_VGA_MEMORY_SIZE,
    DEFAULT_MTU, apply_form, settings_to_options } from "../browser/vm_options.js";

export const FORMAT = "v86-vm";
export const VERSION = 4;

/** The UEFI firmware's images (machine.firmware "uefi"; bios/fetch-ovmf.sh) */
export const UEFI_CODE_URL = "bios/ovmf-code.fd";
export const UEFI_VARS_URL = "bios/ovmf-vars.fd";
/** With Secure Boot (machine.secure_boot, docs/uefi.md): the build whose variables are SMM's; Microsoft's keys enrolled */
export const UEFI_SECURE_CODE_URL = "bios/ovmf-secure-code.fd";
export const UEFI_MS_VARS_URL = "bios/ovmf-vars-ms.fd";
/** machine.secure_boot_keys: the keys a new variable store has */
export const SECURE_BOOT_KEYS = ["microsoft", "none"];

/**
 * The variable store's template for a machine: Microsoft's keys with Secure
 * Boot and those keys, else none (Setup Mode)
 * @param {{secure_boot: boolean, secure_boot_keys: string}} machine
 */
export const uefi_vars_template = machine => machine.secure_boot && machine.secure_boot_keys === "microsoft" ? UEFI_MS_VARS_URL : UEFI_VARS_URL;
/** The TPM's state store (docs/tpm.md, src/tpm/store.js): two slots of 256 KiB */
export const TPM_STATE_SIZE = 512 * 1024;

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
 * @typedef {Object} UsbDisk a disk image as a USB disk (usb.mass_storage)
 * @property {string} id its name (V86's usb_attach_disk id; "usb:" + id for its image)
 * @property {Image} image
 * @property {"read_only" | "read_write"} disk_option the source's policy, as a hard disk's
 * @property {"stop" | "report"} disk_error
 * @property {boolean} write_protected the guest sees it read only
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
 *     fastboot: boolean, bootmenu: boolean, bios: Image | null, vga_bios: Image | null, firmware: string,
 *     uefi_vars: Image | null, secure_boot: boolean, secure_boot_keys: string}} machine
 *     (firmware: "seabios", the BIOS images' or SeaBIOS, or "uefi", OVMF: docs/uefi.md; uefi_vars: its variable
 *     store, a browser disk made from the template at the first power-on, null before and after a reset to it;
 *     secure_boot: the Secure Boot firmware (Q35); secure_boot_keys: "microsoft" or "none", the keys a store gets
 *     when it is made or reset)
 * @property {{state: Image | null} | null} tpm a TPM 2.0 (docs/tpm.md); its state a browser disk made at the first
 *     power-on (null before)
 * @property {{type: string, cores: number, parallel: boolean, jit: boolean, profile: (string|null)}} cpu (profile: the CPU model, cpu_profile; null the CPU type's default)
 * @property {{mb: number}} memory
 * @property {Disk[]} disks
 * @property {{image: Image | null, disk_error: "stop" | "report"}} cdrom
 * @property {Floppy[]} floppies
 * @property {{bzimage: Image | null, initrd: Image | null, cmdline: string | null, multiboot: Image | null, from_filesystem: boolean} | null} kernel
 * @property {Android | null} android Android booted from its disk: the kernel and initrd from its boot partitions
 *     (kernel's cmdline, if any, after the device's)
 * @property {{adapter: string, vram_mb: number | null, proxy: boolean, vulkan: "none" | "venus" | "gfxstream", displays: number}} display
 *     vram_mb: null with an initial_state, whose video memory it is; vulkan: virtio-gpu's Vulkan, drawn by the graphics
 *     proxy's WebGPU renderer: Venus contexts, or gfxstream's (its contexts only: Android's official images)
 * @property {Network[]} network one on the PC machines; up to four virtio-net cards on virt (Android's
 *     three), at most one of them with a backend
 * @property {{device: "sb16" | "hd_audio" | "virtio" | "none", mute: boolean}} sound the sound card (virtio: virt's
 *     virtio-snd; none: no card, the PC speaker stays) and whether the page plays nothing
 * @property {{controller: "uhci", tablet: boolean, disks: UsbDisk[]} | null} usb a USB controller and its devices (the PC
 *     machines'): the tablet, USB disks; each in a port of its own
 * @property {{transport: "mmio" | "pci", input: string[] | null, console_ports: number, vsock: boolean,
 *     gpu_pci_slot: number | null}} virt the virt machine's devices: input null as the display has them
 *     (keyboard, tablet and touch screen with virtio-gpu); console_ports 0: no virtio console
 * @property {{port: number, attach: "none" | "terminal" | "modem"}[]} serial
 * @property {{baseurl?: string, basefs?: {url: string}} | null} filesystem the 9p file system: its files' base URL, its description (fs.json)
 * @property {Image | null} initial_state a state to start from (an old page's profile with a state)
 * @property {{cpu_worker: boolean, ir_tier0: boolean, x87_fast_math: boolean, x87_jit_cache: boolean,
 *     cpuid_level: number | null, mouse_disabled: boolean}} advanced
 * @property {{size: number, time: string, digest: string} | null} suspended the suspended state (U5)
 */

/**
 * Android's bootloader (docs/android-images-plan.md I2): the device
 * models of src/android/devices.js, its GPU modes (venus: Android's own
 * Venus driver, as tools/a64_android.mjs puts it in odm, with display.vulkan
 * "venus"; gfxstream: the image's own drivers, with display.vulkan
 * "gfxstream"; an emulator image's own two, docs/gles-proxy-plan.md E5:
 * host, its GLES drawn by the page's WebGPU, and guest, the CPU draws, as
 * swiftshader does there), the vendor ramdisks (debug: Cuttlefish's
 * vendor_ramdisk-debug.img, a file of its own), SELinux's modes and the
 * display (device: the device model's, the screen zoomed to the window;
 * window: a display of the window's size, following it)
 * @typedef {{device: string, gpu_mode: "swiftshader" | "venus" | "gfxstream" | "host" | "guest", vendor_ramdisk: "release" | "debug",
 *     debug_ramdisk: Image | null, selinux: "enforcing" | "permissive", display: "device" | "window", gles_version: string}} Android
 */
/** the device models (src/android/devices.js): Cuttlefish's phone (arm64 on virt), the emulator images (ranchu) */
export const ANDROID_DEVICES = Object.keys(ANDROID_DEVICE_MODELS);
export const ANDROID_GPU_MODES = ["swiftshader", "venus", "gfxstream"];
/** an emulator image's (the ranchu machine's): the host's GPU, the guest's CPU ("swiftshader" is "guest" there) */
export const RANCHU_GPU_MODES = ["host", "guest"];
/** display.vulkan: none, Venus contexts, gfxstream's */
export const DISPLAY_VULKAN = ["none", "venus", "gfxstream"];
export const ANDROID_VENDOR_RAMDISKS = ["release", "debug"];
export const ANDROID_SELINUX = ["enforcing", "permissive"];
export const ANDROID_DISPLAYS = ["device", "window"];
/** the GLES version an emulator image announces on the host's GPU (docs/gles3-plan.md) */
export const ANDROID_GLES_VERSIONS = Object.keys(GLES_VERSIONS);
/** an android section's defaults
 * @type {Android} */
export const ANDROID_DEFAULTS = { device: "cf_arm64_only_phone", gpu_mode: "swiftshader", vendor_ramdisk: "release", debug_ramdisk: null, selinux: "enforcing",
    display: "device", gles_version: DEFAULT_GLES_VERSION };

/**
 * The display an Android machine's virtio-gpu gets: its device model's
 * (android.display "device"), or null when the display follows the window
 * @param {VMConfig} config
 * @return {{width: number, height: number} | null}
 */
export function android_display(config)
{
    const a = config.android;
    if(!a || a.display === "window") return null;
    const model = /** @type {any} */ (ANDROID_DEVICE_MODELS)[a.device];
    return model && model.display || null;
}

/** The network backends and the old page's relay_url of each */
export const NETWORK_BACKENDS = ["none", "inbrowser", "relay", "wisp", "fetch"];
/** The boot orders the old page offers (index.html's boot_order) */
export const BOOT_ORDERS = [0, 0x213, 0x123, 0x231, 0x321, 0x312, 0x132];
/** The sound devices of the PC machines (virt: virtio, none; ranchu: none, its goldfish audio is not played) */
export const SOUND_DEVICES = ["sb16", "hd_audio", "none"];
const VIRT_SOUND_DEVICES = ["virtio", "none"];
const RANCHU_SOUND_DEVICES = ["none"];
/** The virt machine's input devices (virtio_input) */
const VIRT_INPUTS = ["keyboard", "tablet", "multitouch"];
/** The virt section of a PC machine, and virt's defaults */
export const VIRT_DEFAULTS = { transport: "mmio", input: null, console_ports: 0, vsock: false, gpu_pci_slot: null };
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
        boot_order: 0, fastboot: false, bootmenu: false, bios: null, vga_bios: null, firmware: "seabios", uefi_vars: null,
        secure_boot: false, secure_boot_keys: "microsoft" });
    // (profile: the CPU model, cpu_profile; null the CPU type's default)
    section("cpu", { type: DEFAULT_FORM.cpu_type, cores: 1, parallel: DEFAULT_FORM.parallel, jit: true, profile: null });
    section("memory", { mb: DEFAULT_MEMORY_SIZE });
    c.disks = Array.isArray(c.disks) ? c.disks.map(d => Object.assign({ disk_option: "read_only", disk_error: "stop" }, d)) : [];
    section("cdrom", { image: null, disk_error: "stop" });
    c.floppies = Array.isArray(c.floppies) ? c.floppies.map(f => Object.assign({ image: null, disk_option: "read_only" }, f)) : [];
    c.kernel = is_object(c.kernel) ? Object.assign({ bzimage: null, initrd: null, cmdline: null, multiboot: null, from_filesystem: false }, c.kernel) : null;
    c.android = is_object(c.android) ? Object.assign({}, ANDROID_DEFAULTS, c.android) : null;
    section("display", { adapter: DEFAULT_FORM.graphics_adapter, vram_mb: DEFAULT_VGA_MEMORY_SIZE, proxy: false, vulkan: "none", displays: 1 });
    c.network = Array.isArray(c.network) ? c.network.map(n => Object.assign(default_network(), n)) : [default_network()];
    section("sound", { device: "sb16", mute: false });
    c.usb = is_object(c.usb) ? Object.assign({ controller: "uhci", tablet: true, disks: [] }, c.usb) : null;
    c.tpm = is_object(c.tpm) ? Object.assign({ state: null }, c.tpm) : null;
    if(c.usb && Array.isArray(c.usb.disks))
    {
        c.usb.disks = c.usb.disks.map(d => Object.assign({ disk_option: "read_only", disk_error: "stop", write_protected: false }, d));
    }
    section("virt", Object.assign({}, VIRT_DEFAULTS));
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
 * Each version's change to the next
 * @type {Object<number, function(any): any>}
 */
const MIGRATIONS = {
    // 2 (2026-10-24, docs/gfxstream-plan.md G5): display.vulkan names the kind, Venus or gfxstream
    1: config => {
        if(is_object(config.display) && typeof config.display.vulkan === "boolean")
        {
            config = Object.assign({}, config, { display: Object.assign({}, config.display, { vulkan: config.display.vulkan ? "venus" : "none" }) });
        }
        return config;
    },
    // 3 (2026-10-26, docs/modern-pc-devices-plan.md H1): a PC's sound "none"
    // was the Sound Blaster muted (the guest had one); it stays so, as
    // sound.mute, and "none" is no sound card from now on
    2: config => {
        const sound = is_object(config.sound) ? config.sound : {};
        const virt = is_object(config.machine) && ARM_MACHINE_TYPES.includes(config.machine.type);
        const changed = !virt && sound.device === "none" ? { device: "sb16", mute: true } : { mute: false };
        return Object.assign({}, config, { sound: Object.assign({}, sound, changed) });
    },
    // 4 (2026-10-26, U1): the usb section (none before)
    3: config => Object.assign({}, config, { usb: null }),
};

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
            else if(image.url.endsWith("/")) problem("the URL names a directory, not an image (choose the disk service's image)");
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
    // (arm: an ARM board, virt or ranchu; virt: the virt machine's own devices)
    const arm = ARM_MACHINE_TYPES.includes(machine.type);
    const virt = machine.type === "virt", ranchu = machine.type === "ranchu";
    if(!allowed.machine_types.includes(machine.type))
    {
        problem("machine.type", arm ? "the " + machine.type + " machine needs an ARM CPU (arm64 or arm32)" :
            "the " + cpu.type + " CPU runs on " + allowed.machine_types.join(" or "));
        return problems;
    }

    int(cpu.cores, "cpu.cores", 1, allowed.max_cores);
    bool(cpu.parallel, "cpu.parallel");
    bool(cpu.jit, "cpu.jit");
    if(cpu.profile !== null && cpu.profile !== undefined)
    {
        const model = Object.prototype.hasOwnProperty.call(CPU_PROFILES, cpu.profile) ? CPU_PROFILES[cpu.profile] : null;
        const only = MACHINE_CPU_PROFILES[machine.type]?.[cpu.type];
        if(!model) problem("cpu.profile", "must be one of " + Object.keys(CPU_PROFILES).join(", "));
        else if(model.cpu_type !== cpu.type) problem("cpu.profile", "is a CPU of type " + model.cpu_type + ", not " + cpu.type);
        else if(only && !only.includes(cpu.profile)) problem("cpu.profile", "the " + machine.type + " machine takes " + only.join(", "));
    }

    int(config.memory.mb, "memory.mb", 16, MAX_MEMORY_SIZE);
    if(config.memory.mb > MAX_HEAP_MEMORY_SIZE && cpu.type === "x86")
    {
        problem("memory.mb", "more than " + MAX_HEAP_MEMORY_SIZE + " MB needs a 64-bit CPU (x86_64)");
    }

    bool(machine.acpi, "machine.acpi");
    if(arm && machine.acpi) problem("machine.acpi", allowed.unavailable["acpi"]);
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
        if(arm) problem("machine." + name, allowed.unavailable[name]);
        else if(machine.firmware === "uefi") problem("machine." + name, "UEFI takes the place of the BIOS images");
        else check_image(machine[name], "machine." + name, problems);
    }
    if(machine.uefi_vars !== null)
    {
        check_image(machine.uefi_vars, "machine.uefi_vars", problems);
        if(machine.uefi_vars.kind !== "browser") problem("machine.uefi_vars", "is a browser disk");
    }
    if(!FIRMWARE_TYPES.includes(machine.firmware)) problem("machine.firmware", "must be one of " + FIRMWARE_TYPES.join(", "));
    else if(machine.firmware === "uefi")
    {
        if(arm) problem("machine.firmware", allowed.unavailable["firmware"]);
        else if(cpu.type !== "x86_64") problem("machine.firmware", "UEFI (OVMF) needs the x86_64 CPU");
        else if(!machine.acpi) problem("machine.firmware", "UEFI needs ACPI");
    }
    bool(machine.secure_boot, "machine.secure_boot");
    if(machine.secure_boot === true)
    {
        // (the Secure Boot firmware keeps its variables in SMM: Q35's)
        if(machine.firmware !== "uefi") problem("machine.secure_boot", "Secure Boot needs UEFI");
        else if(machine.type !== "q35") problem("machine.secure_boot", "Secure Boot needs the Q35 machine (its firmware runs in SMM)");
    }
    if(!SECURE_BOOT_KEYS.includes(machine.secure_boot_keys)) problem("machine.secure_boot_keys", "must be one of " + SECURE_BOOT_KEYS.join(", "));

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
        if(arm) problem(path, allowed.unavailable["fda"]);
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
        if(arm && config.kernel.multiboot) problem("kernel.multiboot", allowed.unavailable["multiboot"]);
        if(config.kernel.cmdline !== null && typeof config.kernel.cmdline !== "string") problem("kernel.cmdline", "must be text");
        bool(config.kernel.from_filesystem, "kernel.from_filesystem");
    }

    if(config.android !== null)
    {
        const a = config.android;
        const one_of = (value, list, path) => { if(!list.includes(value)) problem(path, "must be one of " + list.join(", ")); };
        one_of(a.device, ANDROID_DEVICES, "android.device");
        const model = ANDROID_DEVICE_MODELS[a.device];
        if(model && (model.machine !== machine.type || model.cpu !== cpu.type))
        {
            problem("android", model.id + " boots on the " + model.machine + " machine with the " + model.cpu + " CPU");
        }
        one_of(a.gpu_mode, model && model.machine === "ranchu" ? RANCHU_GPU_MODES.concat("swiftshader") : ANDROID_GPU_MODES, "android.gpu_mode");
        if(a.gpu_mode === "venus" && config.display.vulkan !== "venus") problem("android.gpu_mode", "Venus needs virtio-gpu's Venus (display.vulkan)");
        if(a.gpu_mode === "gfxstream" && config.display.vulkan !== "gfxstream") problem("android.gpu_mode", "gfxstream needs virtio-gpu's gfxstream (display.vulkan)");
        one_of(a.vendor_ramdisk, ANDROID_VENDOR_RAMDISKS, "android.vendor_ramdisk");
        if(a.vendor_ramdisk === "debug" && a.debug_ramdisk === null) problem("android.debug_ramdisk", "the debug vendor ramdisk (vendor_ramdisk-debug.img) is a file of its own: choose it");
        if(a.debug_ramdisk !== null) check_image(a.debug_ramdisk, "android.debug_ramdisk", problems);
        one_of(a.selinux, ANDROID_SELINUX, "android.selinux");
        one_of(a.display, ANDROID_DISPLAYS, "android.display");
        one_of(a.gles_version, ANDROID_GLES_VERSIONS, "android.gles_version");
        if(config.kernel && (config.kernel.bzimage || config.kernel.initrd || config.kernel.multiboot))
        {
            problem("kernel", "Android's kernel and initrd come from its disk's boot partitions: leave them out");
        }
        // (its disk, the first hard disk, may come later: without it the start says so, src/browser/starter.js)
        if(config.cdrom.image !== null) problem("cdrom.image", "Android's disk is the first virtio disk: no CD-ROM");
    }

    const display = config.display;
    if(!allowed.graphics_adapters.includes(display.adapter))
    {
        problem("display.adapter", ranchu ? "the ranchu machine has the emulator's framebuffer: none" :
            virt ? "the virt machine has no VGA: virtio-gpu or none" : "must be one of " + allowed.graphics_adapters.join(", "));
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
    if(!DISPLAY_VULKAN.includes(display.vulkan)) problem("display.vulkan", "must be one of " + DISPLAY_VULKAN.join(", "));
    else if(display.vulkan !== "none" && display.adapter !== "virtio_gpu") problem("display.vulkan", "only virtio-gpu has Vulkan");
    else if(display.vulkan !== "none" && display.proxy !== true) problem("display.vulkan", "needs the graphics proxy, whose WebGPU renderer draws it");
    int(display.displays, "display.displays", 1, 4);
    if(display.displays > 1 && display.adapter !== "virtio_gpu") problem("display.displays", "only virtio-gpu has more than one display");

    if(config.network.length > (virt ? 4 : 1)) problem("network", virt ? "the virt machine has four network cards at most" : "a PC machine has one network card");
    if(config.network.filter(n => n.backend !== "none").length > 1) problem("network", "one network card reaches the network, the others stay unconnected");
    if(virt && config.network.length > 1 && config.network.some(n => n.device !== "virtio")) problem("network", "the virt machine's cards are virtio-net");
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

    if(!(ranchu ? RANCHU_SOUND_DEVICES : virt ? VIRT_SOUND_DEVICES : SOUND_DEVICES).includes(config.sound.device))
    {
        problem("sound.device", ranchu ? "the ranchu machine's sound is not played: none" :
            virt ? "the virt machine has virtio-snd or none (no Sound Blaster)" : "must be sb16, hd_audio or none (virtio-snd is the virt machine's)");
    }
    bool(config.sound.mute, "sound.mute");
    if(config.tpm !== null)
    {
        if(!is_object(config.tpm)) problem("tpm", "an object or null");
        else if(arm) problem("tpm", allowed.unavailable["tpm"]);
        else
        {
            if(!machine.acpi) problem("tpm", "the TPM needs ACPI");
            if(config.tpm.state !== null)
            {
                check_image(config.tpm.state, "tpm.state", problems);
                if(config.tpm.state.kind !== "browser") problem("tpm.state", "is a browser disk");
            }
        }
    }
    if(config.usb !== null)
    {
        if(!is_object(config.usb)) problem("usb", "an object or null");
        else
        {
            if(!allowed.usb_controllers.includes(config.usb.controller))
            {
                problem("usb.controller", virt ? "the virt machine has no USB (its input is virtio-input)" : "must be one of " + allowed.usb_controllers.join(", "));
            }
            bool(config.usb.tablet, "usb.tablet");
            // USB disks: a port each (the tablet takes one), their images as hard disks'
            const disks = config.usb.disks === undefined ? [] : config.usb.disks;
            if(!Array.isArray(disks)) problem("usb.disks", "a list");
            else
            {
                const ids = new Set();
                disks.forEach((disk, i) =>
                {
                    const path = "usb.disks." + i;
                    if(typeof disk.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(disk.id) || disk.id === "tablet") problem(path + ".id", "letters, digits, - and _");
                    else if(ids.has(disk.id)) problem(path + ".id", disk.id + " is given twice");
                    ids.add(disk.id);
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
                    bool(disk.write_protected, path + ".write_protected");
                });
                const ports = USB_PORTS[config.usb.controller];
                if(ports && disks.length + (config.usb.tablet ? 1 : 0) > ports)
                {
                    problem("usb.disks", "the " + config.usb.controller.toUpperCase() + " controller has " + ports + " ports" +
                        (config.usb.tablet ? ", one of them the tablet's" : ""));
                }
            }
        }
    }

    const v = config.virt;
    if(!virt)
    {
        if(v.transport !== "mmio" || v.input !== null || v.console_ports || v.vsock || v.gpu_pci_slot !== null)
        {
            problem("virt", "the virtio transport, input devices, console ports, vsock and GPU slot are the virt machine's");
        }
    }
    else
    {
        if(v.transport !== "mmio" && v.transport !== "pci") problem("virt.transport", "must be mmio or pci");
        if(v.input !== null && !(Array.isArray(v.input) && v.input.every(kind => VIRT_INPUTS.includes(kind)) && new Set(v.input).size === v.input.length))
        {
            problem("virt.input", "is null (as the display has them) or a list of " + VIRT_INPUTS.join(", "));
        }
        int(v.console_ports, "virt.console_ports", 0, 30);
        bool(v.vsock, "virt.vsock");
        if(v.gpu_pci_slot !== null)
        {
            int(v.gpu_pci_slot, "virt.gpu_pci_slot", 1, 31);
            if(v.transport !== "pci" || display.adapter !== "virtio_gpu") problem("virt.gpu_pci_slot", "a PCI slot for virtio-gpu needs the pci transport and virtio-gpu");
        }
    }

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
        if(serial.attach === "modem" && arm) problem(path + ".attach", allowed.unavailable["modem"]);
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
    if(arm && advanced.cpuid_level !== null) problem("advanced.cpuid_level", allowed.unavailable["cpuid_level"]);
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
    /** @type {Array<[string, (options: any) => any]>} */
    const checks = [["machine", check_machine_options], ["disks", check_disk_options]];
    for(const [path, check] of checks)
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
    // (the card the backend serves: the virt machine's net<id>; else the first)
    const served = Math.max(0, config.network.findIndex(n => n.backend !== "none"));
    const network = config.network[served];
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
    if(!ARM_MACHINE_TYPES.includes(machine.type)) settings.audio_device = config.sound.device;
    if(modem) settings.modem = { uart: modem.port };

    // (as the address's: apply_query_args; a state image has its own machine)
    if(!settings.initial_state)
    {
        settings.cpu_cores = cpu.cores;
        settings.parallel = cpu.parallel;
        settings.cpu_type = cpu.type;
        if(cpu.profile) settings.cpu_profile = cpu.profile;
        settings.machine_type = machine.type;
        if(machine.type === "q35")
        {
            settings.hpet = machine.hpet;
            settings.smbus = machine.smbus;
            settings.pcie_root_ports = machine.pcie_root_ports;
        }
        if(display.displays > 1) settings.displays = display.displays;
        // (the device's level, chosen at power-on: a state image has its own)
        if(display.vulkan !== "none") settings.virtio_gpu_level = display.vulkan;
        settings.mtu = network ? network.mtu : DEFAULT_MTU;
    }
    settings.relay_url = relay_url_of(network);
    if(!cpu.jit) settings.disable_jit = true;
    // (muted; a virt machine without virtio-snd has nothing to play either; a
    // PC without a sound card still has its speaker)
    const quiet = config.sound.mute || ARM_MACHINE_TYPES.includes(machine.type) && config.sound.device === "none";
    if(quiet) settings.disable_audio = true;

    // (the form, filled in with the configuration's values)
    const form = Object.assign({}, DEFAULT_FORM, {
        relay_url: settings.relay_url,
        disable_audio: quiet,
        audio_device: settings.audio_device || DEFAULT_FORM.audio_device,
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
    // (UEFI, likewise: OVMF in place of the BIOS images; on i440FX with
    // QEMU's device layout, which OVMF expects)
    // (the variable store: the machine's browser disk written back, which
    // needs the CPU Worker; else the template, its changes in memory)
    if(machine.firmware === "uefi")
    {
        delete options.bios;
        delete options.vga_bios;
        const vars = machine.uefi_vars && advanced.cpu_worker ? Object.assign(image(machine.uefi_vars), { disk_option: "read_write" }) :
            { url: uefi_vars_template(machine) };
        options.firmware = machine.secure_boot ? { type: "uefi", secure_boot: true, code: { url: UEFI_SECURE_CODE_URL }, vars } :
            { type: "uefi", code: { url: UEFI_CODE_URL }, vars };
        if(machine.type === "i440fx") options.qemu_compatible = true;
    }
    // (USB, likewise)
    if(config.usb && !ARM_MACHINE_TYPES.includes(machine.type))
    {
        options.usb = { controller: config.usb.controller, tablet: config.usb.tablet };
        if(config.usb.disks && config.usb.disks.length)
        {
            options.usb.mass_storage = config.usb.disks.map(disk =>
            {
                const option = image(disk.image);
                if(disk.disk_option === "read_write") option.disk_option = "read_write";
                if(disk.disk_error !== "stop") option.disk_error = disk.disk_error;
                return { id: disk.id, image: option, read_only: disk.write_protected };
            });
        }
    }
    // (the TPM, likewise, on the PC machines: its state the machine's browser disk written back, which
    // needs the CPU Worker; else in memory, a new TPM at each power-on)
    if(config.tpm && !ARM_MACHINE_TYPES.includes(machine.type))
    {
        options.tpm = { version: "2.0" };
        if(config.tpm.state && advanced.cpu_worker) options.tpm.state = Object.assign(image(config.tpm.state), { disk_option: "read_write" });
    }
    if(machine.bootmenu) options.bootmenu = true;
    // (the virt machine's devices, which the old page does not have either)
    if(machine.type === "virt")
    {
        const v = config.virt;
        if(v.transport === "pci") options.virtio_transport = "pci";
        if(v.input !== null) options.virtio_input = v.input.length ? v.input.slice() : undefined;
        if(v.console_ports)
        {
            options.virtio_console = true;
            options.virtio_console_ports = v.console_ports;
        }
        if(v.vsock) options.virtio_vsock = true;
        if(v.gpu_pci_slot !== null) options.virtio_gpu_pci_slot = v.gpu_pci_slot;
        if(config.sound.device === "virtio") options.virtio_sound = true;
        if(config.network.length > 1)
        {
            options.net_device.count = config.network.length;
            options.net_device.id = served;
        }
    }
    // (Android: its bootloader gives the kernel, initrd and command line;
    // the kernel section's cmdline goes after the device's)
    if(config.android)
    {
        const a = config.android;
        options.android = { device: a.device, gpu_mode: a.gpu_mode, selinux: a.selinux,
            vendor_ramdisk: a.vendor_ramdisk === "debug" ? image(a.debug_ramdisk) : undefined,
            // (an emulator image on the host's GPU: the GLES version its host announces)
            gles_version: a.gpu_mode === "host" ? a.gles_version : undefined };
        delete options.kernel;
        delete options.initrd;
        options.cmdline = config.kernel && config.kernel.cmdline || undefined;
    }
    return options;
}
