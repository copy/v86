// The virt machine of cpu_type "arm64" (docs/virt.md,
// docs/arm64-virt-android16-plan.md): its physical address map, which copies
// QEMU's virt-9.2 (the fixed reference), and the identity snapshots record.

/** Version of the virt machine's device layout, recorded in snapshots (2: the PCIe host, P5.6) */
export const VIRT_LAYOUT_VERSION = 2;

/** The CPU profile (tests/platform/a64-profile.json) */
/** The CPU profiles' base name: v1; v1.1 adds ".1"; v2 is the default (src/arm/cpu.js) */
export const A64_PROFILE = "v86-aarch64-v1";
/**
 * The CPU profiles (docs/arm64-virt-android16-plan.md, "CPU profile") by
 * a64_profile's value: [name, granules (bit 0 4 KiB, 1 16 KiB, 2 64 KiB),
 * optional features (bit 0 FEAT_PAN, bit 1 AArch32 at EL0)]
 * @type {!Object<string, !Array>}
 */
export const A64_PROFILES = {
    "v1": [A64_PROFILE, 1, 0],
    "v1.1": [A64_PROFILE + ".1", 7, 0],
    "v2": ["v86-aarch64-v2", 7, 1],
    // (v2 and 32-bit processes: docs/aarch32-plan.md)
    "v3": ["v86-aarch64-v3", 7, 3],
};

/**
 * cpu_type "arm32"'s profile (docs/aarch32-plan.md part 2): AArch32
 * throughout (feature bit 2), with AArch32's instructions (bit 1); its
 * name, granules (none of AArch64's: the 4 KiB one), features
 */
export const ARM32_PROFILE = ["v86-arm32-v1", 1, 6];

/** Must match MAX_CORES in src/rust/aarch64/isa_hooks.rs */
export const VIRT_MAX_CORES = 8;

/** Guest RAM's base (src/rust/aarch64/bus.rs RAM_BASE) */
export const VIRT_RAM_BASE = 0x40000000;
/** extended RAM (P8.5): from 4 GiB, to where the reference's RAM ends (256 GiB, before the high ECAM) */
export const VIRT_EXTENDED_RAM_BASE = 0x100000000;
export const VIRT_EXTENDED_RAM_END = 0x4000000000;

// QEMU virt-9.2 with highmem-ecam/-mmio/-redists on (docs/virt.md)
export const VIRT_GIC_DIST = 0x08000000;
export const VIRT_GIC_DIST_SIZE = 0x10000;
export const VIRT_GIC_REDIST = 0x080A0000;
export const VIRT_GIC_REDIST_STRIDE = 0x20000;
export const VIRT_UART = 0x09000000;
export const VIRT_RTC = 0x09010000;
export const VIRT_MMIO = 0x0A000000;
export const VIRT_MMIO_SIZE = 0x200;
export const VIRT_MMIO_COUNT = 32;
export const VIRT_PCIE_MMIO = 0x10000000;
export const VIRT_PCIE_MMIO_SIZE = 0x2EFF0000;
export const VIRT_PCIE_PIO = 0x3EFF0000;
export const VIRT_PCIE_PIO_SIZE = 0x10000;
/** above 4 GiB: as [low, high] 32-bit halves */
export const VIRT_PCIE_ECAM_HIGH = [0x10000000, 0x40];
/** 256 buses */
export const VIRT_PCIE_ECAM_SIZE = 0x10000000;
export const VIRT_PCIE_MMIO_HIGH = [0x00000000, 0x80];
export const VIRT_PCIE_MMIO_HIGH_SIZE = 0x8000000000;

/**
 * The machine's settings, validated: cores and RAM
 * @param {Object} settings
 * @return {{cores: number, memory_size: number}}
 */
export function virt_machine(settings)
{
    const cores = settings.cpu_cores === undefined ? 1 : settings.cpu_cores;
    if(!Number.isInteger(cores) || cores < 1 || cores > VIRT_MAX_CORES)
    {
        throw new Error("cpu_cores must be an integer from 1 to " + VIRT_MAX_CORES + ", got " + cores);
    }
    const memory_size = settings.memory_size === undefined ? 512 * 1024 * 1024 : settings.memory_size;
    if(!Number.isInteger(memory_size) || memory_size < 1024 * 1024 || memory_size % 4096)
    {
        throw new Error("memory_size must be a multiple of 4096 of at least 1 MiB, got " + memory_size);
    }
    return { cores, memory_size };
}
