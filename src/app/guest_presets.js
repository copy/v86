// @ts-check
// The new machine wizard's guest presets (docs/vm-manager-plan.md "客户机预设",
// U3): for each system, the whole hardware (a configuration's defaults),
// whether a document or test of the repository verified it, how it is
// installed, the steps after the installation and the known problems, from
// the systems' documents (docs/dos.md, windows-31x.md, windows-9x.md,
// windows-nt.md, multicore.md, x86-64.md, gpu-devices.md, aarch64.md).

import { new_config } from "./vm_config.js";
import { fitted } from "./vm_model.js";

/** @typedef {import("./vm_config.js").VMConfig} VMConfig */

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} name
 * @property {string} guest the configuration's guest (its family)
 * @property {boolean} verified
 * @property {string} basis the document or test it rests on; for one not verified, the closest verified one
 * @property {Array<"cdrom" | "floppy" | "disk" | "direct">} install the ways to install it, the usual first:
 *     from a CD or a floppy, an existing hard disk image (Android's: its GPT disk, which its bootloader boots),
 *     a kernel and initrd (and its CD as a read-only disk)
 * @property {string} install_text
 * @property {number} disk_mb the new empty disk's default size
 * @property {"memory" | "browser" | "service"} disk_location where its new disk goes by default
 * @property {string[]} checklist the steps after the installation
 * @property {string[]} issues the known problems
 * @property {(c: any) => void} hardware its hardware on a new configuration
 */

const MB = 1;
const GB = 1024;

/**
 * A PC's hardware
 * @param {{cpu?: string, memory: number, cores?: number, adapter?: string, vram?: number, nic?: string, sound?: string,
 *     acpi?: boolean, cpuid_level?: number}} h
 */
function pc(h)
{
    return c =>
    {
        c.cpu.type = h.cpu || "x86";
        c.cpu.cores = h.cores || 1;
        c.memory.mb = h.memory;
        c.machine.type = "i440fx";
        c.machine.acpi = !!h.acpi;
        c.display.adapter = h.adapter || "bochs_vga";
        c.display.vram_mb = h.vram || 8;
        c.network[0].device = h.nic || "ne2k";
        if(c.network[0].device === "none") { c.network[0].backend = "none"; c.network[0].relay_url = ""; }
        c.sound.device = h.sound || "sb16";
        if(h.cpuid_level) c.advanced.cpuid_level = h.cpuid_level;
    };
}

const WINDOWS_81 = {
    cpu: "x86_64", memory: 2048 * MB, cores: 2, adapter: "vmware_svga", vram: 16, nic: "none", sound: "none", acpi: true,
};
const WINDOWS_81_CHECKLIST = [
    "Display driver, one of: VMware Tools 13.1.5's vm3d (install KB2919355 first), or the test-signed viogpudo 0.1.240 (2D only)",
    "Set the display driver's TDR timeout to 60 seconds",
    "Before moving the disk from IDE to Q35 (AHCI), enable storahci",
];
const WINDOWS_81_ISSUES = [
    "ne2k has no Windows 8.1 driver; virtio-net's driver is not verified",
    "No sound card (HD Audio is in the modern PC devices plan)",
    "Too slow without the JIT (do not turn it off)",
];

/** @type {Preset[]} */
export const PRESETS = [
    {
        id: "dos", name: "DOS (MS-DOS 6.22, FreeDOS)", guest: "dos", verified: true, basis: "docs/dos.md, tests/full/run.js",
        install: ["floppy", "cdrom"], install_text: "MS-DOS from its floppies, FreeDOS from its CD (or its boot floppy)",
        disk_mb: 128 * MB, disk_location: "memory", checklist: [], issues: [],
        hardware: pc({ memory: 64 * MB }),
    },
    {
        id: "windows3x", name: "Windows 3.x", guest: "windows3x", verified: true, basis: "docs/windows-31x.md",
        install: ["floppy"], install_text: "Install MS-DOS 6.22 first, then Windows from its floppies",
        disk_mb: 128 * MB, disk_location: "memory",
        checklist: ["Windows for Workgroups 3.11: the keyboard fix (vkda.386)", "The Sound Blaster 16 driver", "The vbesvga display driver"],
        issues: ["Windows 3.1 has no usable network card driver: use the modem and PPP"],
        hardware: pc({ memory: 64 * MB }),
    },
    ...[["windows95", "Windows 95", 64], ["windows98", "Windows 98", 256], ["windowsme", "Windows ME", 256]].map(([id, name, memory]) => ({
        id: /** @type {string} */ (id), name: /** @type {string} */ (name), guest: "windows9x", verified: true,
        basis: "tests/r1/windows9x.mjs (the site's Windows 98 state), docs/windows-9x.md",
        install: /** @type {Array<"cdrom">} */ (["cdrom"]), install_text: "From the CD, with the Patcher9x floppy",
        disk_mb: 2 * GB, disk_location: /** @type {"memory"} */ ("memory"), checklist: [],
        issues: ["Retail CDs need FIX95CPU or Patcher9x (#1556)", "The floppy drive works in MS-DOS compatibility mode only",
            "No ACPI: the images have no ACPI HAL"],
        hardware: pc({ memory: /** @type {number} */ (memory) * MB, vram: 16 }),
    })),
    {
        id: "windowsnt4", name: "Windows NT 4", guest: "windowsnt", verified: true, basis: "docs/windows-nt.md",
        install: ["cdrom"], install_text: "From the CD", disk_mb: 2 * GB, disk_location: "memory", checklist: [], issues: [],
        hardware: pc({ memory: 512 * MB, vram: 16, cpuid_level: 2 }),
    },
    {
        id: "windows2000", name: "Windows 2000", guest: "windowsnt", verified: true, basis: "docs/windows-nt.md, tests/full/run.js",
        install: ["cdrom"], install_text: "From the CD", disk_mb: 2 * GB, disk_location: "memory",
        checklist: ["Switch the HAL to \"Standard PC\"", "The Sound Blaster 16 driver"], issues: [],
        hardware: pc({ memory: 512 * MB, vram: 16 }),
    },
    {
        id: "windowsxp", name: "Windows XP", guest: "windowsnt", verified: true, basis: "the owner's XP performance gate (tests/ir/performance/xp_boot.mjs)",
        install: ["cdrom"], install_text: "From the CD", disk_mb: 4 * GB, disk_location: "memory",
        checklist: ["D3D programs such as 3DMark06: d3d9.dll from driver.iso"],
        issues: ["Keep the x86 CPU: x86_64 makes XP use its PAE kernel", "XP's and 2000's ACPI HAL is not verified: one core only"],
        hardware: pc({ memory: 2048 * MB, vram: 16 }),
    },
    {
        id: "windows81", name: "Windows 8.1 (x64)", guest: "windows", verified: true,
        basis: "tests/x64/windows_boot.mjs, docs/windows-nt.md (from an existing image; installing from the CD in v86 is not verified)",
        install: ["disk", "cdrom"], install_text: "An existing hard disk image", disk_mb: 32 * GB, disk_location: "service",
        checklist: WINDOWS_81_CHECKLIST, issues: WINDOWS_81_ISSUES, hardware: pc(WINDOWS_81),
    },
    {
        id: "windows7", name: "Windows Vista / 7 / 10", guest: "windows", verified: false,
        basis: "Windows 8.1's settings; Vista's installation CD only starts, 7 and 10 were never tried",
        install: ["cdrom"], install_text: "From the CD", disk_mb: 32 * GB, disk_location: "service",
        checklist: WINDOWS_81_CHECKLIST, issues: WINDOWS_81_ISSUES, hardware: pc(WINDOWS_81),
    },
    {
        id: "linux", name: "Linux (32-bit)", guest: "linux", verified: true, basis: "Linux 4.16, 6.8, 6.18: docs/multicore.md, docs/acpi.md, docs/q35.md",
        install: ["cdrom"], install_text: "From a live or installation CD", disk_mb: 8 * GB, disk_location: "memory", checklist: [], issues: [],
        hardware: pc({ memory: 512 * MB, acpi: true }),
    },
    {
        id: "linux64", name: "Linux (x86_64)", guest: "linux", verified: true, basis: "Alpine 3.24: docs/x86-64.md, docs/gpu-devices.md",
        install: ["cdrom"], install_text: "From a live or installation CD", disk_mb: 8 * GB, disk_location: "memory", checklist: [], issues: [],
        hardware: pc({ cpu: "x86_64", memory: 1024 * MB, cores: 2, adapter: "virtio_gpu", nic: "virtio", acpi: true }),
    },
    {
        id: "linux_arm64", name: "Linux (arm64)", guest: "linux", verified: true, basis: "Alpine 3.24 aarch64: docs/aarch64.md, tests/a64/linux_boot.mjs",
        install: ["direct"], install_text: "The kernel and initrd of the ISO's boot/ directory, the ISO as a read-only virtio disk",
        disk_mb: 8 * GB, disk_location: "browser", checklist: [],
        issues: ["Only with the page tier (the JIT on), in the CPU Worker"],
        hardware: c =>
        {
            c.cpu.type = "arm64";
            c.machine.type = "virt";
            c.machine.acpi = false;
            c.cpu.cores = 4;
            c.memory.mb = 1024 * MB;
            c.display.adapter = "virtio_gpu";
            c.network[0].device = "virtio";
            c.sound.device = "none";
        },
    },
    {
        id: "android16", name: "Android 16 (arm64)", guest: "android", verified: true,
        basis: "boot_completed and the A9 scenario: docs/aarch64.md (graphics: the ARM64 plan's P11.4)",
        install: ["disk"], install_text: "tools/a64_android.mjs's disk.img (its GPT disk, Venus's driver in odm): v64's bootloader reads " +
            "the kernel and initrd from its boot partitions (docs/android-images-plan.md I2)",

        disk_mb: 8 * GB, disk_location: "browser", checklist: [],
        issues: ["Only with the page tier, in the CPU Worker", "The first boot takes about 20 minutes on 4 cores", "See docs/aarch64.md"],
        hardware: c =>
        {
            c.cpu.type = "arm64";
            c.machine.type = "virt";
            c.machine.acpi = false;
            c.cpu.cores = 4;
            c.memory.mb = 1536 * MB;
            c.display.adapter = "virtio_gpu";
            // (Venus, as initrd-venus.img's libvulkan wants it: SwiftShader's desktop on initrd.img takes too long to draw)
            c.display.proxy = true;
            c.display.vulkan = true;
            c.sound.device = "virtio";
            // (three virtio-net cards, as Cuttlefish's: its Wi-Fi, the third, on the fetch backend)
            c.network = [0, 1, 2].map(i => ({ device: "virtio", backend: i === 2 ? "fetch" : "none", relay_url: "", mtu: 1500, mac_address_translation: false }));
            c.virt = { transport: "pci", input: ["keyboard", "multitouch"], console_ports: 18, vsock: true, gpu_pci_slot: 2 };
            // (the bootloader: the disk's kernel and initrd, bootconfig with Venus's keys)
            c.android = { device: "cf_arm64_only_phone", gpu_mode: "venus", vendor_ramdisk: "release", debug_ramdisk: null, selinux: "enforcing" };
        },
    },
    {
        id: "other", name: "Other", guest: "other", verified: false, basis: "the old page's machine without changes",
        install: ["cdrom", "floppy", "disk", "direct"], install_text: "Any", disk_mb: 512 * MB, disk_location: "memory", checklist: [], issues: [],
        hardware: () => {},
    },
];

/**
 * A preset by its id
 * @param {string | null} id
 * @return {Preset | undefined}
 */
export function preset(id)
{
    return PRESETS.find(p => p.id === id);
}

/**
 * A new configuration of a preset: its hardware on the defaults, fitted to its machine
 * @param {Preset} p
 * @param {Partial<VMConfig>} [fields] name and the rest
 * @return {VMConfig}
 */
export function preset_config(p, fields = {})
{
    const config = new_config(Object.assign({ name: p.name, guest: p.guest, template: p.id }, fields));
    p.hardware(config);
    return fitted(config).config;
}
