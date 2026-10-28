// Android device models (docs/android-images-plan.md I2.1): how a build for
// a device boots on the virt machine, as that device's bootloader and
// launcher would boot it: the disk's partitions, the kernel command line's
// tail and what goes into bootconfig.

/**
 * Cuttlefish's arm64-only phone (aosp_cf_arm64_only_phone): what its
 * launcher puts into bootconfig (host/commands/assemble_cvd/
 * bootconfig_args.cpp, QEMU, no host services) and its bootloader (slot,
 * normal boot, verified boot state). The host services Cuttlefish provides
 * through virtio-console ports are replaced by the guest's own: KeyMint and
 * Gatekeeper from the vendor's nonsecure APEXes.
 */
export const CF_ARM64_ONLY_PHONE = {
    id: "cf_arm64_only_phone",
    cpu: "arm64",
    machine: "virt",
    /** its display (Cuttlefish's phone: 720x1280 at androidboot.lcd_density
     * 320); the VM manager gives virtio-gpu this size and zooms the screen
     * to the window, rather than a display the window's size */
    display: { width: 720, height: 1280 },
    /** the virt machine's PCIe host bridge (high ECAM), under which first
     * stage init looks for the partitions */
    boot_devices: "4010000000.pcie",
    /** the disk: Cuttlefish's partition order (host/commands/assemble_cvd/
     * disk_flags.cc); slotted ones twice (_a, _b); blank ones with their
     * size. frp is from Cuttlefish's second, persistent disk:
     * PersistentDataBlockService's, without which system_server dies at
     * boot phase 500 */
    partitions: [
        { name: "misc", blank: 1 << 20 },
        { name: "boot", slots: true },
        { name: "init_boot", slots: true },
        { name: "vendor_boot", slots: true },
        { name: "vbmeta", slots: true },
        { name: "vbmeta_system", slots: true },
        { name: "vbmeta_vendor_dlkm", slots: true },
        { name: "vbmeta_system_dlkm", slots: true },
        { name: "super" },
        { name: "userdata" },
        { name: "metadata", blank: 64 << 20 },
        { name: "frp", blank: 1 << 20 },
    ],
    slot: "_a",
    /** the kernel's console is hvc0 (the first virtio-console port, as
     * Cuttlefish's) after earlycon on the PL011 */
    cmdline_tail: "console=hvc0 earlycon=pl011,mmio32,0x9000000",
    /** the GPU modes' bootconfig: SwiftShader's (gpu_mode guest_swiftshader:
     * VK_API_VERSION_1_2, OpenGL ES 3.1), and what Venus changes (as
     * Cuttlefish's drm_virgl: SurfaceFlinger composes on the GPU, the ranchu
     * HWC only scans out; ANGLE on Venus gives OpenGL ES 3.0) */
    gpu_modes: {
        swiftshader: [
            ["androidboot.cpuvulkan.version", String((1 << 22) | (2 << 12))],
            ["androidboot.hardware.gralloc", "minigbm"],
            ["androidboot.hardware.hwcomposer", "ranchu"],
            ["androidboot.hardware.hwcomposer.display_finder_mode", "drm"],
            ["androidboot.hardware.hwcomposer.display_framebuffer_format", "rgba"],
            ["androidboot.hardware.egl", "angle"],
            ["androidboot.hardware.vulkan", "pastel"],
            ["androidboot.opengles.version", "196609"],
        ],
        venus: [
            ["androidboot.hardware.vulkan", "virtio"],
            ["androidboot.hardware.hwcomposer.mode", "client"],
            ["androidboot.opengles.version", "196608"],
        ],
        // gpu_mode gfxstream_guest_angle as the launcher writes it
        // (host/libs/vm_manager/qemu_manager.cpp; docs/gfxstream-protocol.md):
        // the guest's Vulkan driver gfxstream's (vulkan.ranchu), GLES ANGLE on
        // it, the transport ASG rings in virtio-gpu blobs; for v64's
        // gfxstream device (docs/gfxstream-plan.md G1-G5). Composition as
        // Venus's: SurfaceFlinger on the GPU, the HWC scanning out through
        // KMS (the launcher's HWC composes on the host, renderControl's
        // rcCompose); ANGLE gets OpenGL ES 3.0 of VX
        gfxstream: [
            ["androidboot.cpuvulkan.version", "0"],
            ["androidboot.hardware.vulkan", "ranchu"],
            ["androidboot.hardware.gltransport", "virtio-gpu-asg"],
            ["androidboot.hardware.hwcomposer.mode", "client"],
            ["androidboot.opengles.version", "196608"],
        ],
    },
};

/**
 * Cuttlefish's arm64 phone of Android 14 (aosp_cf_arm64_phone from the
 * aosp-android14-gsi branch, vsoc_arm64): a 32-bit second architecture
 * (zygote64_32), for 32-bit apps on arm64 (docs/aarch32-plan.md Q5.2);
 * otherwise as the arm64-only phone, tools/a64_android.mjs --build a14
 */
export const CF_ARM64_PHONE_A14 = /** @type {!Object} */ (Object.assign({}, CF_ARM64_ONLY_PHONE, {
    id: "cf_arm64_phone_a14",
    // (no vbmeta_system_dlkm: the build has no such image, system_dlkm is
    // in vbmeta's chain)
    partitions: CF_ARM64_ONLY_PHONE.partitions.filter(p => p.name !== "vbmeta_system_dlkm"),
}));

/**
 * The partitions of a device's disk in order, each slotted one per slot
 * @param {!Object} device
 * @return {!Array<{name: string, base: string, blank: (number|undefined)}>}
 */
export function device_partitions(device)
{
    return device.partitions.flatMap(p => p.slots ? ["_a", "_b"].map(slot => ({ name: p.name + slot, base: p.name })) :
        [{ name: p.name, base: p.name, blank: p.blank }]);
}

/**
 * The launcher's and bootloader's bootconfig (key order as Cuttlefish
 * writes it), with the GPU mode's keys
 * @param {!Object} device
 * @param {{vbmeta: {size: number, digest: string}, memory_mb: number, selinux: (string|undefined), page_size: (number|undefined), gpu_mode: (string|undefined)}} options
 * @return {!Map<string, string>}
 */
export function device_bootconfig(device, options)
{
    const map = new Map([
        ["androidboot.slot_suffix", device.slot],
        ["androidboot.force_normal_boot", "1"],
        ["androidboot.verifiedbootstate", "orange"],
        ["androidboot.vbmeta.device_state", "unlocked"],
        ["androidboot.vbmeta.hash_alg", "sha256"],
        ["androidboot.vbmeta.size", String(options.vbmeta.size)],
        ["androidboot.vbmeta.digest", options.vbmeta.digest],
        ["androidboot.vbmeta.avb_version", "1.3"],
        ["androidboot.vbmeta.invalidate_on_error", "yes"],
        ["androidboot.veritymode", "enforcing"],
        ["androidboot.boot_devices", device.boot_devices],
        ["androidboot.serialno", "V86A64ANDROID01"],
        ["androidboot.ddr_size", options.memory_mb + "MB"],
        ["androidboot.console", "ttyAMA0"],
        ["androidboot.serialconsole", "1"],
        ["androidboot.lcd_density", "320"],
        ["androidboot.setupwizard_mode", "DISABLED"],
        ["androidboot.enable_bootanimation", "1"],
        ...(options.selinux === "permissive" ? [["androidboot.selinux", "permissive"]] : []),
        ["androidboot.enable_confirmationui", "0"],
        // (the audio HAL's primary output is tinyalsa's card 0 device 0:
        // the guest's virtio-snd card, v86's virtio_sound, QEMU's
        // virtio-sound-pci; P12.5)
        ["androidboot.audio.tinyalsa.ignore_output", "false"],
        ["androidboot.audio.tinyalsa.simulate_input", "true"],
        // (16 KiB pages: f2fs's block is the page, the image's userdata is
        // f2fs in 4 KiB blocks; ext4 takes 4 KiB blocks under 16K pages)
        ["androidboot.fstab_suffix", (options.page_size || 4096) === 4096 ? "cf.f2fs.hctr2" : "cf.ext4.hctr2"],
        ["androidboot.wifi_mac_prefix", "5554"],
        ["androidboot.hw_timeout_multiplier", "50"],
        ["androidboot.hypervisor.vm.supported", "0"],
        ["androidboot.hypervisor.protected_vm.supported", "0"],
        ["androidboot.vendor.apex.com.android.hardware.keymint", "com.android.hardware.keymint.rust_nonsecure"],
        ["androidboot.vendor.apex.com.android.hardware.gatekeeper", "com.android.hardware.gatekeeper.nonsecure"],
        ["androidboot.vendor.apex.com.android.hardware.secure_element", "com.android.hardware.secure_element"],
        ["androidboot.vendor.apex.com.android.hardware.strongbox", "none"],
        ["androidboot.vendor.apex.com.android.hardware.graphics.composer", "com.android.hardware.graphics.composer.ranchu"],
        ["androidboot.wifi_impl", "virt_wifi"],
        // the lights HAL listens on this vsock port (a privileged port 0
        // without it: EACCES, and system_server waits for the HAL forever);
        // the Thread network HAL needs a node id above 0
        ["androidboot.vsock_lights_port", "6900"],
        ["androidboot.vsock_lights_cid", "3"],
        ["androidboot.openthread_node_id", "1"],
        ...device.gpu_modes.swiftshader,
    ]);
    const mode = options.gpu_mode || "swiftshader";
    if(!device.gpu_modes[mode]) throw new Error(`${device.id}: no GPU mode ${mode}`);
    if(mode !== "swiftshader") for(const [key, value] of device.gpu_modes[mode]) map.set(key, value);
    return map;
}

/**
 * The Android Emulator's system images on the ranchu machine
 * (docs/android-images-plan.md I6, docs/aarch32-plan.md R6): how the
 * emulator boots an SDK image of one API level and ABI: its kernel
 * (kernel-ranchu) and ramdisk, its disks in the emulator's order (the
 * virtio disks vda, vdb, ...: the ramdisk's fstab.ranchu names them) and
 * the kernel command line (src/virt/ranchu.js). On v64's disk each is a
 * partition: `member` the zip's file (in its ABI's directory), `ext4` an
 * empty file system of that size (the emulator's own, made at its start:
 * src/android/ext4.js); the bootloader (bootloader.js) makes each `disk`
 * partition a virtio disk, read-only or not
 */
export const RANCHU_25_ARMEABI_V7A = {
    id: "ranchu_25_armeabi_v7a",
    name: "Android 7.1 emulator image (armeabi-v7a)",
    cpu: "arm32",
    machine: "ranchu",
    api: 25,
    abi: "armeabi-v7a",
    partitions: [
        { name: "kernel", member: "kernel-ranchu" },
        { name: "ramdisk", member: "ramdisk.img" },
        // (fstab.ranchu: vda /system, vdb /cache, vdc /data)
        { name: "system", member: "system.img", disk: "read_only" },
        { name: "cache", ext4: 64 << 20, disk: "read_write" },
        { name: "userdata", member: "userdata.img", disk: "read_write" },
    ],
    // (no boot animation: the CPU draws it, which slows the first boot down)
    cmdline: { arm32: true, bootanim: false },
    // the GPU modes (docs/gles-proxy-plan.md "Android 传输"): "guest" the
    // CPU renders (qemu.gles=0); "host" the emulator's GL libraries send
    // GLES to v64's GLES host (ranchu_gpu "host": qemu.gles=1, and
    // ro.opengles.version the GLES version the host announces,
    // ranchu_gpu_mode's). The low-RAM setting, the boot animation and the
    // clock rate stay as "guest" has them until E3 measures them with host GLES.
    gpu_modes: {
        guest: { ranchu_gpu: "guest", gles: false, properties: {} },
        host: { ranchu_gpu: "host", gles: true, properties: {} },
    },
    // qemud's boot properties (src/virt/goldfish.js), beyond the machine's:
    // a low-RAM device (ActivityManager.isHighEndGfx false), so that
    // system_server draws its own windows with the CPU. Its GL would be the
    // guest's SwiftShader (without a host GPU the EGL loader takes the
    // vendor's SwiftShader: qemu.gles 2), whose JIT the image's SELinux
    // policy denies system_server (execmem): its first GL frame killed it.
    // No ANR stack traces (an empty dalvik.vm.stack-trace-file: AMS's
    // dumpStackTraces returns at once): on a CPU this slow an ANR's dumps of
    // every process held ActivityManager's lock past the Watchdog's 60 s,
    // which killed system_server
    properties: { "ro.config.low_ram": "true", "dalvik.vm.stack-trace-file": "" },
    // the machine's clock at a tenth of the host's (cpu_clock.rate, with
    // cooperative cores): Android 7.1's timeouts are a real phone's (a
    // service's start 20 s, the Watchdog 60 s); on this CPU SystemUI's start
    // took longer, ActivityManager killed it again and again (a background
    // ANR) and the keyguard's black scrim never went away
    clock_rate: 0.1,
    // init's additions (src/android/ramdisk_overlay.js): background ANRs
    // shown, not killed (Settings.Secure.ANR_SHOW_BACKGROUND, set by the
    // shell's settings command when the boot completes), so that a slow
    // service start (on a slower host) does not kill SystemUI for good
    // (init of Android 7.1 takes no quoted arguments; the shell's domain
    // is entered by /system/bin/sh only)
    init: {
        rc: [
            "# v64 (src/android/devices.js): background ANRs shown, not killed",
            "service v64_anr /system/bin/sh /system/bin/settings put secure anr_show_background 1",
            "    user shell",
            "    group shell",
            "    seclabel u:r:shell:s0",
            "    disabled",
            "    oneshot",
            "",
            "on property:sys.boot_completed=1",
            "    start v64_anr",
            "",
        ].join("\n"),
    },
};

/** The emulator images v64 boots, by API level and ABI */
export const RANCHU_DEVICES = [RANCHU_25_ARMEABI_V7A];

/** GLES versions as Android's ro.opengles.version (the major version << 16 | the minor) */
export const GLES_VERSIONS = { "2.0": "131072", "3.0": "196608", "3.1": "196609", "3.2": "196610" };

/**
 * The GLES version a GLES host announces where nothing says: 3.1, the
 * highest Android 7.1's library goes (3.2 is offered, of which the
 * library passes on part: gpu-deviations.md G-68; docs/gles3-plan.md)
 */
export const DEFAULT_GLES_VERSION = "3.1";

/**
 * An emulator image's GPU mode: the VM config's android.gpu_mode, "guest"
 * when it names none (or "swiftshader", the VM config's default, which is
 * the guest's own rendering here as well); with the GLES host, the GLES
 * version it announces (android.gles_version) as ro.opengles.version
 * @param {!Object} device
 * @param {string|undefined} gpu_mode
 * @param {string=} gles_version GLES_VERSIONS', DEFAULT_GLES_VERSION unless given
 * @return {{ranchu_gpu: string, gles: boolean, gles_version: (string|undefined), properties: !Object<string, string>}}
 */
export function ranchu_gpu_mode(device, gpu_mode, gles_version)
{
    const mode = !gpu_mode || gpu_mode === "swiftshader" ? "guest" : gpu_mode;
    const m = device.gpu_modes[mode];
    if(!m) throw new Error(`${device.id}: no GPU mode ${gpu_mode} (${Object.keys(device.gpu_modes).join(", ")})`);
    if(!m.gles) return m;
    const version = gles_version || DEFAULT_GLES_VERSION;
    if(!GLES_VERSIONS[version]) throw new Error(`${device.id}: no GLES version ${version} (${Object.keys(GLES_VERSIONS).join(", ")})`);
    return /** @type {{ranchu_gpu: string, gles: boolean, gles_version: (string|undefined), properties: !Object<string, string>}} */ (
        Object.assign({}, m, { gles_version: version, properties: Object.assign({}, m.properties, { "ro.opengles.version": GLES_VERSIONS[version] }) }));
}
