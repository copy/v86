// @ts-check
// The new machine wizard's guest presets (docs/vm-manager-plan.md "客户机预设",
// U3): for each system, the whole hardware (a configuration's defaults),
// whether a document or test of the repository verified it, how it is
// installed, the steps after the installation and the known problems, from
// the systems' documents (docs/dos.md, windows-31x.md, windows-9x.md,
// windows-nt.md, multicore.md, x86-64.md, gpu-devices.md, aarch64.md).

import { new_config } from "./vm_config.js";
import { DEFAULT_GLES_VERSION } from "../android/devices.js";
import { fitted } from "./vm_model.js";

/** @typedef {import("./vm_config.js").VMConfig} VMConfig */

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} name
 * @property {string} guest the configuration's guest (its family)
 * @property {boolean} verified
 * @property {string} basis the document or test it rests on; for one not verified, the closest verified one
 * @property {Array<"cdrom" | "floppy" | "disk" | "direct" | "android">} install the ways to install it, the usual first:
 *     from a CD or a floppy, an existing hard disk image (Android's: its GPT disk, which its bootloader boots),
 *     a kernel and initrd (and its CD as a read-only disk), an Android image package (made into a disk)
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
 *     acpi?: boolean, cpuid_level?: number, tablet?: boolean, usb?: string, q35?: boolean, uefi?: boolean,
 *     secure_boot?: boolean, tpm?: boolean}} h
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
        // (the USB tablet: an absolute pointer for the systems that have its
        // drivers; xHCI for the systems with its driver, EHCI for XP to 7)
        c.usb = h.tablet ? { controller: h.usb || "uhci", tablet: true, disks: [] } : null;
        // (Windows 11's machine: Q35 with AHCI, UEFI with Secure Boot and
        // Microsoft's keys, a TPM 2.0: docs/uefi.md, docs/tpm.md)
        if(h.q35) c.machine.type = "q35";
        if(h.uefi) c.machine.firmware = "uefi";
        if(h.secure_boot) Object.assign(c.machine, { secure_boot: true, secure_boot_keys: "microsoft" });
        if(h.tpm) c.tpm = { state: null };
    };
}

const WINDOWS_81 = {
    cpu: "x86_64", memory: 2048 * MB, cores: 2, adapter: "vmware_svga", vram: 16, nic: "e1000", sound: "hd_audio", acpi: true, tablet: true, usb: "xhci",
};
const WINDOWS_81_CHECKLIST = [
    "Display driver, one of: VMware Tools 13.1.5's vm3d (install KB2919355 first), or the test-signed viogpudo 0.1.240 (2D only)",
    "Set the display driver's TDR timeout to 60 seconds",
    "Before moving the disk from IDE to Q35 (AHCI), enable storahci",
];
const WINDOWS_81_ISSUES = [
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
        hardware: pc({ memory: 2048 * MB, vram: 16, tablet: true, usb: "ehci" }),
    },
    {
        id: "windows81", name: "Windows 8.1 (x64)", guest: "windows", verified: true,
        basis: "tests/x64/windows_boot.mjs, docs/windows-nt.md (from an existing image; installing from the CD in v86 is not verified)",
        install: ["disk", "cdrom"], install_text: "An existing hard disk image", disk_mb: 32 * GB, disk_location: "service",
        checklist: WINDOWS_81_CHECKLIST, issues: WINDOWS_81_ISSUES, hardware: pc(WINDOWS_81),
    },
    {
        id: "windows11", name: "Windows 11 (x64)", guest: "windows", verified: false,
        basis: "Windows 8.1's devices (tests/x64/windows_boot.mjs), its Setup under Secure Boot with Microsoft's keys " +
            "(tests/uefi/windows_setup.mjs), the TPM 2.0 (docs/tpm.md); Windows 11 itself was never tried here",
        install: ["cdrom", "disk"], install_text: "From the CD", disk_mb: 64 * GB, disk_location: "service",
        checklist: WINDOWS_81_CHECKLIST.slice(0, 2), issues: WINDOWS_81_ISSUES.concat([
            "Windows 11 asks for a supported processor model: v86's is not on Microsoft's list",
            "No DirectX 12 / WDDM 2.0 display driver",
        ]),
        hardware: pc(Object.assign({}, WINDOWS_81, { memory: 4096 * MB, q35: true, uefi: true, secure_boot: true, tpm: true })),
    },
    {
        id: "windows7", name: "Windows Vista / 7 / 10", guest: "windows", verified: false,
        basis: "Windows 8.1's settings; Vista's installation CD only starts, 7 and 10 were never tried",
        install: ["cdrom"], install_text: "From the CD", disk_mb: 32 * GB, disk_location: "service",
        checklist: WINDOWS_81_CHECKLIST, issues: WINDOWS_81_ISSUES, hardware: pc(Object.assign({}, WINDOWS_81, { usb: "ehci" })),
    },
    {
        id: "linux", name: "Linux (32-bit)", guest: "linux", verified: true, basis: "Linux 4.16, 6.8, 6.18: docs/multicore.md, docs/acpi.md, docs/q35.md",
        install: ["cdrom"], install_text: "From a live or installation CD", disk_mb: 8 * GB, disk_location: "memory", checklist: [], issues: [],
        hardware: pc({ memory: 512 * MB, acpi: true, tablet: true, usb: "xhci" }),
    },
    {
        id: "linux64", name: "Linux (x86_64)", guest: "linux", verified: true, basis: "Alpine 3.24: docs/x86-64.md, docs/gpu-devices.md",
        install: ["cdrom"], install_text: "From a live or installation CD", disk_mb: 8 * GB, disk_location: "memory", checklist: [], issues: [],
        hardware: pc({ cpu: "x86_64", memory: 1024 * MB, cores: 2, adapter: "virtio_gpu", nic: "virtio", acpi: true, tablet: true, usb: "xhci" }),
    },
    {
        id: "linux_arm64", name: "Linux (arm64)", guest: "linux", verified: true, basis: "Alpine 3.24 aarch64: docs/aarch64.md, tests/a64/linux_boot.mjs",
        install: ["direct"], install_text: "The kernel and initrd of the ISO's boot/ directory, the ISO as a read-only virtio disk",
        disk_mb: 8 * GB, disk_location: "browser", checklist: [],
        issues: ["Only with the page tier (the JIT on), in the CPU Worker"],
        hardware: c =>
        {
            c.cpu.type = "arm64";
            // (Alpine's kernel has COMPAT: armhf programs run too)
            c.cpu.profile = "generic-arm64-compat32";
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
        id: "linux_arm32", name: "Linux (ARM 32-bit)", guest: "linux", verified: true,
        basis: "Alpine 3.24 armv7 (netboot): docs/aarch32-plan.md R5, tests/a32/linux_boot.mjs",
        install: ["direct"], install_text: "The netboot kernel and initramfs (vmlinuz-lts, initramfs-lts), its modloop and packages from a disk or the network",
        disk_mb: 4 * GB, disk_location: "browser", checklist: [],
        issues: ["Only with the page tier (the JIT on)", "The serial console only: the 32-bit virt machine's display is not verified"],
        hardware: c =>
        {
            c.cpu.type = "arm32";
            c.machine.type = "virt";
            c.machine.acpi = false;
            c.cpu.cores = 2;
            c.memory.mb = 512 * MB;
            c.display.adapter = "none";
            c.network[0].device = "virtio";
            c.sound.device = "none";
            c.kernel = { bzimage: null, initrd: null, cmdline: "console=ttyAMA0", multiboot: null, from_filesystem: false };
        },
    },
    {
        id: "android16", name: "Android (arm64)", guest: "android", verified: true,
        basis: "boot_completed and the A9 scenario on gfxstream with the official images: docs/aarch64.md, docs/gfxstream-plan.md G5",
        install: ["android", "disk"], install_text: "Android 16, and 17 as a GSI on that phone: an Android image package (Cuttlefish's images zip, " +
            "and a GSI's, made into a disk: the image's own GPU " +
            "drivers on gfxstream), or tools/a64_android.mjs's disk.img: v64's bootloader reads the kernel and initrd from the disk's boot " +
            "partitions (docs/android-images-plan.md I2, I3)",

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
            // (gfxstream: the official images' own drivers, vulkan.ranchu and ANGLE; Venus needs
            // initrd-venus.img's libvulkan; SwiftShader's desktop takes too long to draw)
            c.display.proxy = true;
            c.display.vulkan = "gfxstream";
            c.sound.device = "virtio";
            // (three virtio-net cards, as Cuttlefish's: its Wi-Fi, the third, on the fetch backend)
            c.network = [0, 1, 2].map(i => ({ device: "virtio", backend: i === 2 ? "fetch" : "none", relay_url: "", mtu: 1500, mac_address_translation: false }));
            c.virt = { transport: "pci", input: ["keyboard", "multitouch"], console_ports: 18, vsock: true, gpu_pci_slot: 2 };
            // (the bootloader: the disk's kernel and initrd, bootconfig with Venus's keys)
            c.android = { device: "cf_arm64_only_phone", gpu_mode: "gfxstream", vendor_ramdisk: "release", debug_ramdisk: null, selinux: "enforcing", display: "device",
                gles_version: DEFAULT_GLES_VERSION };
        },
    },
    {
        id: "android7_arm32", name: "Android (ARM 32-bit)", guest: "android", verified: true,
        basis: "the SDK's armeabi-v7a-25_r18 image to boot_completed: docs/aarch32-plan.md R7.1, tests/a32/android_boot.mjs",
        install: ["android"], install_text: "Android 7.1: the Android Emulator's system image zip (system-images/android-25/google_apis/armeabi-v7a, " +
            "armeabi-v7a-25_r18.zip), made into a disk: its kernel, ramdisk, system, cache and userdata (docs/android-images-plan.md I6)",
        disk_mb: 4 * GB, disk_location: "browser", checklist: [],
        issues: ["Only with the page tier, in the CPU Worker", "The first boot takes about 7 minutes on 2 cores",
            "The host's GPU draws through WebGPU (docs/gles-proxy-plan.md); without WebGPU the guest's CPU draws, slowly",
            "The guest's clock runs at a tenth of the host's, so that Android's timeouts suit this CPU", "No sound"],
        hardware: c =>
        {
            c.cpu.type = "arm32";
            c.machine.type = "ranchu";
            c.machine.acpi = false;
            c.cpu.cores = 2;
            c.memory.mb = 1024 * MB;
            c.display.adapter = "none";
            c.sound.device = "none";
            c.network = [{ device: "virtio", backend: "fetch", relay_url: "", mtu: 1500, mac_address_translation: false }];
            // (the host's GPU draws its GLES: the CPU when the page has no WebGPU, src/app/ui/console.js)
            c.android = { device: "ranchu_25_armeabi_v7a", gpu_mode: "host", vendor_ramdisk: "release", debug_ramdisk: null, selinux: "enforcing", display: "device",
                gles_version: DEFAULT_GLES_VERSION };
        },
    },
    {
        id: "android_x86_64", name: "Android (x86_64)", guest: "android", verified: false,
        basis: "Linux (x86_64)'s hardware (Alpine 3.24: docs/x86-64.md, docs/gpu-devices.md); Android-x86 was never tried here",
        install: ["cdrom"], install_text: "From Android-x86's 64-bit ISO (android-x86.org, up to Android 9.0): its installer puts it on the hard disk. " +
            "Google's x86_64 emulator images do not boot (from Android 8.0 they draw only through the emulator's host GLES)",
        disk_mb: 8 * GB, disk_location: "browser", checklist: ["Install to the hard disk from the ISO's menu (ext4, with GRUB)"],
        issues: ["Not tried on v64", "Graphics: virtio-gpu's 3D (virgl) or the guest's own software rendering"],
        hardware: pc({ cpu: "x86_64", memory: 2048 * MB, cores: 2, adapter: "virtio_gpu", nic: "virtio", sound: "hd_audio", acpi: true, tablet: true, usb: "xhci" }),
    },
    {
        id: "android_x86", name: "Android (x86)", guest: "android", verified: false,
        basis: "Linux (32-bit)'s hardware (docs/multicore.md, docs/acpi.md); Android-x86 was never tried here",
        install: ["cdrom"], install_text: "From Android-x86's 32-bit ISO (android-x86.org, up to Android 9.0): its installer puts it on the hard disk. " +
            "Google's x86 emulator images do not boot (from Android 8.0 they draw only through the emulator's host GLES)",
        disk_mb: 8 * GB, disk_location: "browser", checklist: ["Install to the hard disk from the ISO's menu (ext4, with GRUB)"],
        issues: ["Not tried on v64", "Graphics: virtio-gpu's 3D (virgl) or the guest's own software rendering"],
        hardware: pc({ memory: 2048 * MB, cores: 2, adapter: "virtio_gpu", nic: "virtio", sound: "hd_audio", acpi: true, tablet: true, usb: "xhci" }),
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
