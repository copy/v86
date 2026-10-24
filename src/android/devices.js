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
