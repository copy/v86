// The virt machine of cpu_type "arm64" (docs/virt.md,
// docs/arm64-virt-android16-plan.md): its physical address map, which copies
// QEMU's virt-9.2 (the fixed reference), and the identity snapshots record.

/** Version of the virt machine's device layout, recorded in snapshots */
export const VIRT_LAYOUT_VERSION = 1;

/** The CPU profile (tests/platform/a64-profile.json) */
export const A64_PROFILE = "v86-aarch64-v1";

/** Must match MAX_CORES in src/rust/aarch64/isa_hooks.rs */
export const VIRT_MAX_CORES = 8;

/** Guest RAM's base (src/rust/aarch64/bus.rs RAM_BASE) */
export const VIRT_RAM_BASE = 0x40000000;

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
