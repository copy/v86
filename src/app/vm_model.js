// @ts-check
// The settings dialog's rules (docs/vm-manager-plan.md "设置对话框", U3): what
// each control may hold for a configuration (from allowed_options in
// src/machine_options.js, the one place of the machines' rules) and a change
// with what it implies (another CPU picks its machine, Q35 has ACPI, a
// second core needs ACPI, more than 2048 MB needs x86_64, the virt machine
// drops what it does not have), each implication told. A configuration made
// only through change() passes check_config.

import { CPU_TYPES, MAX_VRAM_SIZE, allowed_options } from "../machine_options.js";
import { MAX_MEMORY_SIZE, MAX_HEAP_MEMORY_SIZE, Q35_PAGE_DEVICES } from "../browser/vm_options.js";
import { SOUND_DEVICES, BOOT_ORDERS } from "./vm_config.js";

/** @typedef {import("./vm_config.js").VMConfig} VMConfig */

/** The sound devices of the virt machine (virtio-snd) */
export const VIRT_SOUND_DEVICES = ["virtio", "none"];

/** The input devices a virt machine may have (virtio_input) */
export const VIRT_INPUTS = ["keyboard", "tablet", "multitouch"];

/**
 * A network backend's URL by default (the old page's buttons: its relay, a
 * public wisp server; fetch without a CORS proxy), and whether a URL fits it
 */
export const BACKEND_URLS = {
    none: { default: "", fits: url => url === "" },
    inbrowser: { default: "", fits: url => url === "" },
    relay: { default: "wss://relay.widgetry.org/", fits: url => /^wss?:\/\//.test(url) },
    wisp: { default: "wisps://wisp.mercurywork.shop/v86/", fits: url => /^wisps?:\/\//.test(url) },
    fetch: { default: "", fits: url => url === "" || /^https?:\/\//.test(url) },
};

/**
 * What the controls may hold for a configuration
 * @param {VMConfig} config
 */
export function choices(config)
{
    const allowed = allowed_options(config.cpu.type, config.machine.type);
    const virt = config.machine.type === "virt";
    const sixty_four = config.cpu.type !== "x86";
    return {
        cpu_types: CPU_TYPES.slice(),
        machine_types: allowed.machine_types,
        graphics_adapters: allowed.graphics_adapters,
        net_devices: allowed.net_device_types,
        sound_devices: virt ? VIRT_SOUND_DEVICES : SOUND_DEVICES,
        boot_orders: virt ? [0] : BOOT_ORDERS,
        max_cores: allowed.max_cores,
        /** the most memory in MB: the Wasm heap for x86, extended RAM above it for the 64-bit CPUs */
        max_memory: sixty_four ? MAX_MEMORY_SIZE : MAX_HEAP_MEMORY_SIZE,
        max_vram: MAX_VRAM_SIZE >> 20,
        /** ACPI: set by the machine (Q35: always, virt: never), or by more than one core; null when free */
        acpi_fixed: allowed.acpi === "required" ? { value: true, reason: "the Q35 machine always has ACPI" } :
            allowed.acpi === "none" ? { value: false, reason: allowed.unavailable["acpi"] } :
            config.cpu.cores > 1 ? { value: true, reason: "more than one core needs ACPI" } : null,
        /** the most network cards (virt: virtio-net functions, Android's three) */
        max_network: virt ? 4 : 1,
        /** an option's reason when it does not apply (allowed_options's names) */
        unavailable: allowed.unavailable,
    };
}

/**
 * A copy to change
 * @param {VMConfig} config
 * @return {VMConfig}
 */
function copy(config)
{
    return JSON.parse(JSON.stringify(config));
}

/**
 * The fields that depend on the CPU, machine, cores and display, made to fit them; the notes say what changed
 * @param {VMConfig} c
 * @param {string[]} notes
 */
function fit(c, notes)
{
    const allowed = allowed_options(c.cpu.type, c.machine.type);
    const virt = c.machine.type === "virt";
    const note = text => { if(!notes.includes(text)) notes.push(text); };

    if(!allowed.machine_types.includes(c.machine.type))
    {
        c.machine.type = allowed.machine_types[0];
        note("Machine: " + c.machine.type + " (the " + c.cpu.type + " CPU's)");
        return fit(c, notes);
    }
    if(c.cpu.cores > allowed.max_cores) c.cpu.cores = allowed.max_cores;
    if(c.cpu.type === "x86" && c.memory.mb > MAX_HEAP_MEMORY_SIZE)
    {
        c.cpu.type = "x86_64";
        note("Processor: x86_64 (more than " + MAX_HEAP_MEMORY_SIZE + " MB needs a 64-bit CPU)");
        return fit(c, notes);
    }

    // ACPI and the Q35 machine's devices
    if(allowed.acpi === "none" && c.machine.acpi) { c.machine.acpi = false; note("ACPI off: " + allowed.unavailable["acpi"]); }
    if(allowed.acpi === "required" && !c.machine.acpi) { c.machine.acpi = true; note("ACPI on: the Q35 machine always has it"); }
    if(allowed.acpi === "with_cores" && c.cpu.cores > 1 && !c.machine.acpi) { c.machine.acpi = true; note("ACPI on: more than one core needs it"); }
    if(c.machine.type === "q35") { /* (kept: the Q35 devices are the user's) */ }
    else
    {
        if(c.machine.hpet || c.machine.smbus || c.machine.pcie_root_ports) note("HPET, SMBus and root ports off: only the Q35 machine has them");
        c.machine.hpet = false;
        c.machine.smbus = false;
        c.machine.pcie_root_ports = 0;
    }

    // the PC's firmware, floppies, modem, Sound Blaster and CPUID level: not on virt
    if(virt)
    {
        if(c.machine.bios || c.machine.vga_bios) { c.machine.bios = c.machine.vga_bios = null; note("BIOS removed: " + allowed.unavailable["bios"]); }
        if(c.machine.boot_order) { c.machine.boot_order = 0; note("Boot order: automatic (the virt machine boots its kernel)"); }
        if(c.floppies.length) { c.floppies = []; note("Floppy drives removed: " + allowed.unavailable["fda"]); }
        if(c.kernel && c.kernel.multiboot) { c.kernel.multiboot = null; note("Multiboot image removed: " + allowed.unavailable["multiboot"]); }
        for(const serial of c.serial) if(serial.attach === "modem") { serial.attach = "terminal"; note("Modem removed: " + allowed.unavailable["modem"]); }
        if(c.advanced.cpuid_level !== null) { c.advanced.cpuid_level = null; note("CPUID level: the CPU's own"); }
    }
    else
    {
        const v = c.virt;
        if(v && (v.transport !== "mmio" || v.input !== null || v.console_ports || v.vsock || v.gpu_pci_slot !== null))
        {
            c.virt = { transport: "mmio", input: null, console_ports: 0, vsock: false, gpu_pci_slot: null };
            note("The virt machine's devices removed (virtio transport, input, console ports, vsock)");
        }
    }

    // display, network, sound
    if(!allowed.graphics_adapters.includes(c.display.adapter))
    {
        c.display.adapter = virt ? "virtio_gpu" : "bochs_vga";
        note("Display: " + c.display.adapter + (virt ? " (the virt machine has no VGA)" : ""));
    }
    if(c.display.adapter !== "virtio_gpu" && c.display.displays > 1) { c.display.displays = 1; note("One display: only virtio-gpu has more"); }
    const max_network = virt ? 4 : 1;
    if(c.network.length > max_network)
    {
        c.network = c.network.slice(0, max_network);
        note("Network: one card (the PC machines have one)");
    }
    for(const n of c.network)
    {
        if(!allowed.net_device_types.includes(n.device))
        {
            n.device = virt ? "virtio" : "ne2k";
            note("Network card: " + n.device + (virt ? " (the virt machine has virtio-net)" : ""));
        }
    }
    // (one card with a backend: the virt machine's NICs share one)
    let served = false;
    for(const n of c.network)
    {
        if(n.backend === "none") continue;
        if(served) { n.backend = "none"; n.relay_url = ""; note("Network: one card reaches the network, the others stay unconnected"); }
        served = true;
    }
    const sound = virt ? VIRT_SOUND_DEVICES : SOUND_DEVICES;
    if(!sound.includes(c.sound.device))
    {
        c.sound.device = "none";
        note("Sound: none" + (virt ? " (the virt machine has no Sound Blaster)" : ""));
    }
    return c;
}

/**
 * A change of one field and what it implies
 * @param {VMConfig} config
 * @param {string} path "cpu.type", "machine.acpi", "memory.mb", "display.adapter", "network.0.device", ...
 * @param {any} value
 * @return {{config: VMConfig, notes: string[]}} notes: what else changed, for people
 */
export function change(config, path, value)
{
    const c = copy(config);
    const notes = [];
    const keys = path.split(".");
    /** @type {any} */
    let target = c;
    for(const key of keys.slice(0, -1)) target = target[key];
    const last = keys[keys.length - 1];
    const before = target[last];
    target[last] = value;

    const backend = /^network\.(\d+)\.backend$/.exec(path);
    if(backend && BACKEND_URLS[value] && !BACKEND_URLS[value].fits(c.network[+backend[1]].relay_url))
    {
        c.network[+backend[1]].relay_url = BACKEND_URLS[value].default;
    }
    if(path === "machine.type" && value === "q35" && before !== "q35")
    {
        // (the page's Q35: an HPET and an SMBus controller, as a real board has them)
        c.machine.hpet = Q35_PAGE_DEVICES.hpet;
        c.machine.smbus = Q35_PAGE_DEVICES.smbus;
        c.machine.pcie_root_ports = Q35_PAGE_DEVICES.pcie_root_ports;
    }
    if(path === "cpu.type" && value === "arm64" && c.machine.type !== "virt")
    {
        c.machine.type = "virt";
        notes.push("Machine: virt (the arm64 CPU's)");
    }
    if(path === "cpu.type" && value !== "arm64" && c.machine.type === "virt")
    {
        c.machine.type = "i440fx";
        notes.push("Machine: i440fx (the " + value + " CPU's)");
    }
    if(path === "cpu.type" && value === "x86" && c.memory.mb > MAX_HEAP_MEMORY_SIZE)
    {
        c.memory.mb = MAX_HEAP_MEMORY_SIZE;
        notes.push("Memory: " + MAX_HEAP_MEMORY_SIZE + " MB (the most of the 32-bit CPU)");
    }
    if(path === "machine.type" && value === "virt" && c.cpu.type !== "arm64")
    {
        c.cpu.type = "arm64";
        notes.push("Processor: arm64 (the virt machine's)");
    }
    if(path === "machine.type" && value !== "virt" && c.cpu.type === "arm64")
    {
        c.cpu.type = "x86";
        notes.push("Processor: x86 (the PC machines')");
    }
    return { config: fit(c, notes), notes };
}

/**
 * A configuration made to fit its CPU and machine (a preset's, an imported one's)
 * @param {VMConfig} config
 * @return {{config: VMConfig, notes: string[]}}
 */
export function fitted(config)
{
    const notes = [];
    return { config: fit(copy(config), notes), notes };
}
