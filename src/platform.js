// Description of the emulated PC platform: the single source for the ACPI
// tables (src/acpi_tables.js), the fw_cfg and CMOS inputs of the firmware,
// and the fixed resources of the devices that implement them.
// See docs/acpi.md.

import { dbg_assert } from "./log.js";
import { h } from "./lib.js";
import { MACHINE_TYPES } from "./machine_options.js";

/** Must match MAX_CORES in src/rust/cpu/apic.rs */
export const MAX_CORES = 8;

export const LAPIC_ADDRESS = 0xFEE00000;
export const IOAPIC_ADDRESS = 0xFEC00000;
/** Must match IOAPIC_ID in src/rust/cpu/ioapic.rs */
export const IOAPIC_ID = 0;

/** PCI memory BARs must lie below the IOAPIC; v86 does not relocate them */
export const PCI_MMIO_END = 0xFEBFFFFF;

// PIIX4 power management function (PCI 00:07.0)
export const ACPI_PM_PCI_ID = 0x07 << 3;

/** The PCI subsystem (vendor 1AF4, device 1100) of QEMU's emulated devices */
export const QEMU_PCI_SUBSYSTEM = [0xF4, 0x1A, 0x00, 0x11];

// settings.machine_type: see src/machine_options.js ("i440fx", "q35" and,
// with cpu_type "arm64", "virt"); this file describes the PC machines
export { MACHINE_TYPES } from "./machine_options.js";

/**
 * Version of the device layout a snapshot records with its machine type;
 * raised when a machine's devices change in a way old snapshots can't express
 */
export const MACHINE_LAYOUT_VERSION = 1;

// Q35. SeaBIOS rel-1.16.2 programs PCIEXBAR to this fixed address and then
// allocates PCI memory above the ECAM window (src/fw/dev-q35.h, pciinit.c
// mch_mem_addr_setup); the platform has to match it.
export const Q35_ECAM_BASE = 0xB0000000;
export const Q35_ECAM_SIZE = 0x10000000;
export const Q35_PCI_MMIO_START = Q35_ECAM_BASE + Q35_ECAM_SIZE;
/** ICH9 root complex register block (LPC config 0xF0), as SeaBIOS programs it */
export const ICH9_RCBA_ADDRESS = 0xFED1C000;
export const ICH9_RCBA_SIZE = 0x4000;
/** The ICH9 PM I/O block decoded at PMBASE (LPC config 0x40), 128-aligned */
export const ICH9_PM_LENGTH = 0x80;
/** GPE0_STS (8 bytes) and GPE0_EN (8 bytes) inside the ICH9 PM block */
export const ICH9_GPE0_OFFSET = 0x20;
export const ICH9_GPE0_LENGTH = 0x10;
/** SMI_CMD values of QEMU's ICH9 (include/hw/southbridge/ich9.h) */
export const ICH9_ACPI_ENABLE = 0x02;
export const ICH9_ACPI_DISABLE = 0x03;

// PCI functions of the Q35 chipset (bus 0)
export const Q35_MCH_PCI_ID = 0x00 << 3;
export const ICH9_LPC_PCI_ID = 0x1F << 3;
export const ICH9_AHCI_PCI_ID = 0x1F << 3 | 2;
/** Device numbers that only the chipset may use */
const Q35_CHIPSET_SLOTS = [0x00, 0x1F];
/** ICH9's PCI Express root ports: device 28, one function per port (src/pcie_root_port.js) */
export const Q35_ROOT_PORT_SLOT = 0x1C;
export const Q35_ROOT_PORTS_MAX = 6;

/**
 * PCI functions (device << 3 | function on bus 0) of the devices whose place
 * differs between the machine layouts. i440FX: v86's layout, or QEMU's PC with
 * settings.qemu_compatible (a Windows installed under QEMU then finds its
 * devices where they were). Q35: QEMU's layout (display at 00:01.0, the first
 * network card at 00:02.0) with the chipset at 00:00.0 and 00:1f.*.
 * Functions a machine does not have are -1.
 * @param {?Platform} platform
 * @return {{ide: number, acpi_pm: number, vga: number, ne2k: number, lpc: number, ahci: number}}
 */
export function pci_functions(platform)
{
    if(platform && platform.machine === "q35")
    {
        return { ide: -1, acpi_pm: -1, vga: 0x01 << 3, ne2k: 0x02 << 3, lpc: ICH9_LPC_PCI_ID, ahci: ICH9_AHCI_PCI_ID };
    }
    return platform && platform.qemu_compatible ?
        { ide: 0x01 << 3 | 1, acpi_pm: 0x01 << 3 | 3, vga: 0x02 << 3, ne2k: 0x03 << 3, lpc: -1, ahci: -1 } :
        { ide: 0x1E << 3, acpi_pm: ACPI_PM_PCI_ID, vga: 0x12 << 3, ne2k: 0x05 << 3, lpc: -1, ahci: -1 };
}
/** PM I/O block size decoded at PMBA (PCI config 0x40) */
export const ACPI_PM_LENGTH = 0x40;
/**
 * PM base that SeaBIOS programs when it loads v86's tables through
 * etc/table-loader (src/fw/paravirt.c). The device decodes whatever the
 * firmware writes to PMBA; the tables are generated from that value.
 */
export const ACPI_PM_BASE_DEFAULT = 0x600;
export const ACPI_GPE0_BASE = 0xAFE0;
export const ACPI_GPE0_LENGTH = 4;
export const ACPI_SMI_CMD_PORT = 0xB2;
export const ACPI_ENABLE = 0xF1;
export const ACPI_DISABLE = 0xF0;
export const ACPI_SCI_IRQ = 9;

/** PIIX reset control register; the FADT reset register writes RESET_VALUE to it */
export const RESET_PORT = 0xCF9;
export const RESET_VALUE = 0x06;

export const FW_CFG_PORT = 0x510;

/**
 * ISA IRQs that the PCI interrupt links (PIRQA..D) may use. SeaBIOS routes
 * them to 10, 10, 11, 11. IRQ 5 is not offered: the SB16 uses it.
 */
export const PCI_LINK_IRQS = [10, 11];

/**
 * Sleep states. The SLP_TYP values are what the ACPI device decodes; the
 * tables advertise a state only when it is supported.
 */
export const ACPI_SLEEP_STATES = [
    // S3 (suspend to RAM): cores stop, RAM and the BIOS shadow are kept; a
    // wake event resets CPUs and devices and SeaBIOS jumps to the FACS
    // waking vector
    { state: 3, slp_typ: 1, supported: true },
    // S4 (OS-directed hibernation): a soft off for the hardware; the guest
    // restores itself from disk at the next power-on
    { state: 4, slp_typ: 2, supported: true },
    // S5 (soft off)
    { state: 5, slp_typ: 0, supported: true },
];

/**
 * Sleep states of the Q35 machine: S3 and S4 stay unadvertised until the
 * firmware's resume path and the AHCI lifecycle are verified for them (see
 * docs/q35.md); the encodings match the i440FX ones.
 */
const Q35_SLEEP_STATES = ACPI_SLEEP_STATES.map(s => ({ state: s.state, slp_typ: s.slp_typ, supported: s.state === 5 }));

/**
 * Legacy devices at fixed resources. `when` names the setting that enables an
 * optional device.
 */
const UARTS = [
    { port: 0x3F8, irq: 4 },
    { port: 0x2F8, irq: 3, when: "uart1" },
    { port: 0x3E8, irq: 4, when: "uart2" },
    { port: 0x2E8, irq: 3, when: "uart3" },
];

const PARALLEL_PORTS = [
    { port: 0x378, irq: 7 },
    { port: 0x278, irq: 5, when: "parallel1" },
];

/**
 * @typedef {{
 *     cores: number,
 *     topology: {sockets: number, cores_per_socket: number, threads_per_core: number, logical_processors: number, package_shift: number},
 *     cpuid_profile: string,
 *     apic_ids: !Array<number>,
 *     memory_size: number,
 *     pci_mmio_start: number,
 *     uarts: !Array<{index: number, port: number, irq: number}>,
 *     parallel_ports: !Array<{index: number, port: number, irq: number}>,
 *     qemu_compatible: boolean,
 *     machine: string,
 *     acpi: boolean,
 *     ecam: ?{base: number, size: number},
 *     pm: {length: number, gpe0_offset: number, gpe0_base: number, gpe0_length: number, acpi_enable: number, acpi_disable: number},
 *     sleep_states: !Array<{state: number, slp_typ: number, supported: boolean}>,
 *     reserved_pci_slots: !Array<number>,
 *     pcie_root_ports: number,
 *     root_port_devices: !Object<string, number>,
 *     hpet: boolean,
 *     smbus: boolean,
 * }}
 */
export var Platform;

/**
 * The built-in devices that may sit behind a root port (their options'
 * pcie_root_port), by their name in settings.root_port_devices
 */
export const ROOT_PORT_DEVICES = ["net", "virtio_9p", "virtio_console", "virtio_balloon"];

/**
 * The machine type of the settings, validated
 * @param {Object} settings
 * @return {string}
 */
export function machine_type(settings)
{
    const machine = settings.machine_type === undefined ? "i440fx" : settings.machine_type;
    if(!MACHINE_TYPES.includes(machine))
    {
        throw new Error("machine_type must be one of " + MACHINE_TYPES.map(m => "\"" + m + "\"").join(", ") + ", got " + JSON.stringify(machine));
    }
    if(machine === "virt")
    {
        throw new Error("machine_type \"virt\" is not a PC machine (cpu_type \"arm64\")");
    }
    return machine;
}

/**
 * Whether the machine has ACPI: as configured; Q35 has it unless switched off,
 * which it does not support (SeaBIOS's fallback DSDT only describes an i440FX,
 * and v86 without ACPI has neither the PM function nor the IOAPIC)
 * @param {Object} settings
 * @return {boolean}
 */
export function machine_acpi(settings)
{
    if(machine_type(settings) === "q35")
    {
        if(settings.acpi === false)
        {
            throw new Error("machine_type \"q35\" requires ACPI (it is on by default); acpi: false is not supported");
        }
        return true;
    }
    return !!settings.acpi;
}

/**
 * @param {Object} settings
 * @param {number} memory_size RAM below 4 GiB in bytes
 * @return {Platform}
 */
export function create_platform(settings, memory_size)
{
    const enabled = device => !device.when || !!settings[device.when];
    const indexed = list => list.map((device, index) => ({ index, port: device.port, irq: device.irq })).filter((_, i) => enabled(list[i]));

    const machine = machine_type(settings);
    const acpi = machine_acpi(settings);
    const q35 = machine === "q35";

    // One socket, `cpu_cores` cores, one thread per core. CPUID, fw_cfg, CMOS
    // and the MADT all read the core count from here.
    const cores = settings.cpu_cores === undefined ? 1 : settings.cpu_cores;
    if(!Number.isInteger(cores) || cores < 1 || cores > MAX_CORES)
    {
        throw new Error("cpu_cores must be an integer from 1 to " + MAX_CORES + ", got " + cores);
    }
    if(cores > 1 && !acpi)
    {
        throw new Error("cpu_cores > 1 requires acpi: true (it enables the local APICs)");
    }
    if(q35 && memory_size > Q35_ECAM_BASE)
    {
        throw new Error("machine_type \"q35\": RAM below 4 GiB must end below the ECAM window at 0x" + Q35_ECAM_BASE.toString(16));
    }

    // Q35: the ICH9 PCI Express root ports (settings.pcie_root_ports)
    const root_ports = settings.pcie_root_ports === undefined ? 0 : settings.pcie_root_ports;
    if(!(Number.isInteger(root_ports) && root_ports >= 0 && root_ports <= Q35_ROOT_PORTS_MAX))
    {
        throw new Error("pcie_root_ports must be an integer from 0 to " + Q35_ROOT_PORTS_MAX + ", got " + root_ports);
    }
    if(root_ports && !q35)
    {
        throw new Error("pcie_root_ports requires machine_type \"q35\"");
    }
    // built-in devices behind root ports (settings.root_port_devices: their
    // root port, and whether they start plugged in), one per port
    const root_port_devices = {};
    const taken = new Set();
    for(const [name, placement] of Object.entries(settings.root_port_devices || {}))
    {
        const port = placement.port;
        if(!ROOT_PORT_DEVICES.includes(name))
        {
            throw new Error("root_port_devices: unknown device " + JSON.stringify(name));
        }
        if(!(Number.isInteger(port) && port >= 0 && port < root_ports))
        {
            throw new Error(name + ": pcie_root_port must be the number of a root port (0 to pcie_root_ports - 1), got " +
                port + (q35 ? "" : " (root ports need machine_type \"q35\")"));
        }
        if(taken.has(port))
        {
            throw new Error(name + ": root port " + port + " is taken by another device");
        }
        taken.add(port);
        root_port_devices[name] = port;
    }
    // Q35: ICH9's high precision event timer (settings.hpet) and SMBus
    // controller (settings.smbus)
    const hpet = !!settings.hpet;
    if(hpet && !q35)
    {
        throw new Error("hpet requires machine_type \"q35\"");
    }
    const smbus = !!settings.smbus;
    if(smbus && !q35)
    {
        throw new Error("smbus requires machine_type \"q35\"");
    }

    // i440FX: the PCI memory window starts at the first 256 MiB boundary above
    // RAM. Q35: above the ECAM window, where SeaBIOS allocates the BARs.
    const pci_mmio_start = q35 ? Q35_PCI_MMIO_START : Math.ceil(memory_size / 0x10000000) * 0x10000000;

    const platform = {
        cores,
        topology: {
            sockets: 1,
            cores_per_socket: cores,
            threads_per_core: 1,
            logical_processors: cores,
            package_shift: Math.ceil(Math.log2(cores)),
        },
        cpuid_profile: cores === 1 ? "legacy" : "smp32",
        apic_ids: Array.from({ length: cores }, (_, i) => i),
        memory_size,
        pci_mmio_start,
        uarts: indexed(UARTS),
        parallel_ports: indexed(PARALLEL_PORTS),
        // devices with the places and identities of QEMU's i440FX PC
        // (pci_functions, and the ACPI namespace, see acpi_tables.js); on
        // Q35 the layout is always QEMU's, the option keeps QEMU's
        // identities (subsystem, drive names)
        qemu_compatible: !!settings.qemu_compatible,
        machine,
        acpi,
        ecam: q35 ? { base: Q35_ECAM_BASE, size: Q35_ECAM_SIZE } : null,
        // The power management block: PIIX4 (PMBA, separate GPE0 block) or
        // ICH9 (PMBASE, GPE0 inside the block). gpe0_base is absolute for
        // PIIX4; ICH9's is pm_base + gpe0_offset (gpe0_block).
        pm: q35 ?
            { length: ICH9_PM_LENGTH, gpe0_offset: ICH9_GPE0_OFFSET, gpe0_base: -1, gpe0_length: ICH9_GPE0_LENGTH,
              acpi_enable: ICH9_ACPI_ENABLE, acpi_disable: ICH9_ACPI_DISABLE } :
            { length: ACPI_PM_LENGTH, gpe0_offset: -1, gpe0_base: ACPI_GPE0_BASE, gpe0_length: ACPI_GPE0_LENGTH,
              acpi_enable: ACPI_ENABLE, acpi_disable: ACPI_DISABLE },
        sleep_states: q35 ? Q35_SLEEP_STATES : ACPI_SLEEP_STATES,
        reserved_pci_slots: q35 ? Q35_CHIPSET_SLOTS.concat(root_ports ? [Q35_ROOT_PORT_SLOT] : []) : [],
        // the root ports at 00:1c.0 and up; behind port n is the bus that
        // pci_ids number n + 1
        pcie_root_ports: root_ports,
        root_port_devices,
        hpet,
        smbus,
    };

    check_platform(platform);
    return platform;
}

/**
 * The GPE0 register block (status, then enable bytes) for a PM base
 * @param {Platform} platform
 * @param {number} pm_base
 * @return {{base: number, length: number}}
 */
export function gpe0_block(platform, pm_base)
{
    const pm = platform.pm;
    return { base: pm.gpe0_offset >= 0 ? pm_base + pm.gpe0_offset : pm.gpe0_base, length: pm.gpe0_length };
}

/**
 * I/O port ranges with a fixed owner. Everything the tables describe must be
 * in here, and no two ranges may overlap.
 * @param {Platform} platform
 * @param {number=} pm_base
 * @return {!Array<{name: string, start: number, length: number}>}
 */
export function platform_io_ranges(platform, pm_base)
{
    const ranges = [
        { name: "dma1", start: 0x00, length: 0x10 },
        { name: "pic1", start: 0x20, length: 2 },
        { name: "pit", start: 0x40, length: 4 },
        { name: "kbd-data", start: 0x60, length: 1 },
        { name: "speaker", start: 0x61, length: 1 },
        { name: "kbd-cmd", start: 0x64, length: 1 },
        { name: "rtc", start: 0x70, length: 2 },
        { name: "dma-page", start: 0x80, length: 0x10 },
        { name: "port92", start: 0x92, length: 1 },
        { name: "pic2", start: 0xA0, length: 2 },
        { name: "smi-cmd", start: ACPI_SMI_CMD_PORT, length: 2 },
        { name: "dma2", start: 0xC0, length: 0x20 },
        { name: "fpu", start: 0xF0, length: 0x10 },
        { name: "sb16", start: 0x220, length: 0x10 },
        { name: "fdc", start: 0x3F2, length: 4 },
        { name: "fdc-dir", start: 0x3F7, length: 1 },
        { name: "elcr", start: 0x4D0, length: 2 },
        { name: "fw-cfg", start: FW_CFG_PORT, length: 2 },
        { name: "pci-config", start: 0xCF8, length: 8 },
    ];
    if(platform.pm.gpe0_offset < 0)
    {
        // (ICH9's GPE0 block is part of the PM block)
        ranges.push({ name: "gpe0", start: platform.pm.gpe0_base, length: platform.pm.gpe0_length });
    }

    for(const { index, port } of platform.uarts)
    {
        ranges.push({ name: "uart" + index, start: port, length: 8 });
    }
    for(const { index, port } of platform.parallel_ports)
    {
        ranges.push({ name: "parallel" + index, start: port, length: 8 });
    }
    if(pm_base !== undefined)
    {
        ranges.push({ name: "acpi-pm", start: pm_base, length: platform.pm.length });
    }

    return ranges;
}

/**
 * @param {Platform} platform
 * @param {number=} pm_base
 */
export function check_platform(platform, pm_base)
{
    const ranges = platform_io_ranges(platform, pm_base).sort((a, b) => a.start - b.start);

    for(let i = 1; i < ranges.length; i++)
    {
        const a = ranges[i - 1];
        const b = ranges[i];
        if(a.start + a.length > b.start)
        {
            throw new Error("Platform I/O conflict: " + a.name + " " + h(a.start, 4) + " overlaps " + b.name + " " + h(b.start, 4));
        }
    }

    dbg_assert(platform.cores >= 1 && platform.apic_ids.length === platform.cores);
    dbg_assert(platform.pci_mmio_start <= 0xE0000000, "RAM overlaps the PCI memory window");
    dbg_assert(!platform.ecam || platform.memory_size <= platform.ecam.base &&
        platform.ecam.base + platform.ecam.size <= platform.pci_mmio_start, "ECAM overlaps RAM or the PCI memory window");
}
