// The guest CPU and machine of new V86() and the options each combination
// allows (docs/arm64-virt-android16-plan.md, the configuration contract and
// P1.1): the V86 constructor checks the options, CPU.init checks its
// settings again. The PC machines (i440fx, q35) run the x86 CPUs, the virt
// machine runs the arm64 CPU; an option of the other family is an error,
// never silently ignored.

/** The guest CPUs (`cpu_type`); the first is the default */
export const CPU_TYPES = ["x86", "x86_64", "arm64", "arm32"];
/** The ARM family's CPU types: the ARM core (v86-arm64.wasm) on the virt machine; arm32 is AArch32 throughout (docs/aarch32-plan.md part 2) */
export const ARM_CPU_TYPES = ["arm64", "arm32"];
/**
 * @param {string|undefined} cpu_type
 * @return {boolean} whether the ARM core runs it
 */
export function is_arm(cpu_type) { return ARM_CPU_TYPES.includes(/** @type {string} */ (cpu_type)); }

/**
 * The CPU models (`cpu_profile`, docs/iphone4-plan.md "CPU 型号：统一的
 * cpu_profile"): which CPU the guest sees. Each runs on one cpu_type, so a
 * cpu_profile alone picks it. The generic- ones are v86's own (all it
 * implements), each cpu_type's default; a real chip goes by its model's
 * name, for software that checks which CPU it runs on. hidden: for the
 * regression tests against the QEMU references only (the VM manager leaves
 * them out). The instruction set levels stay with cpu_features.
 * @type {!Object<string, {cpu_type: string, hidden: (boolean|undefined)}>}
 */
export const CPU_PROFILES = {
    "generic-x86": { cpu_type: "x86" },
    "generic-x86-64": { cpu_type: "x86_64" },
    // (src/virt/platform.js: v86-aarch64-v2, with FEAT_PAN; -compat32 is v3, AArch32 at EL0 too)
    "generic-arm64": { cpu_type: "arm64" },
    "generic-arm64-compat32": { cpu_type: "arm64" },
    "generic-arm64-v1": { cpu_type: "arm64", hidden: true },
    "generic-arm64-v1.1": { cpu_type: "arm64", hidden: true },
    "cortex-a15": { cpu_type: "arm32" },
};

/** Each cpu_type's CPU model when cpu_profile is not given */
export const DEFAULT_CPU_PROFILES = { "x86": "generic-x86", "x86_64": "generic-x86-64", "arm64": "generic-arm64", "arm32": "cortex-a15" };

/** The CPU models a machine takes, where it is choosy: machine_type → cpu_type → models */
export const MACHINE_CPU_PROFILES = { "ranchu": { "arm32": ["cortex-a15"] } };

/**
 * The CPU models a page may offer for a CPU type and machine (the hidden ones left out)
 * @param {string} cpu_type
 * @param {string=} machine_type
 * @return {!Array<string>}
 */
export function cpu_profiles_of(cpu_type, machine_type)
{
    const only = machine_type && MACHINE_CPU_PROFILES[machine_type] && MACHINE_CPU_PROFILES[machine_type][cpu_type];
    return Object.keys(CPU_PROFILES).filter(name => CPU_PROFILES[name].cpu_type === cpu_type && !CPU_PROFILES[name].hidden &&
        (!only || only.includes(name)));
}

/**
 * The machines (`machine_type`): "i440fx" (the default with an x86 CPU:
 * i440FX host bridge, PIIX3/4, IDE), "q35" (Q35 MCH, ICH9 LPC with its power
 * management, AHCI; docs/q35.md), "virt" (the ARM board, docs/virt.md) and
 * "ranchu" (the Android emulator's ARM board: its SDK images, src/virt/ranchu.js)
 */
export const MACHINE_TYPES = ["i440fx", "q35", "virt", "ranchu"];
/** The ARM CPUs' machines */
export const ARM_MACHINE_TYPES = ["virt", "ranchu"];

/**
 * The most cores (`cpu_cores`) of the PC machines (src/platform.js): must
 * match MAX_CORES in src/rust/cpu/apic.rs. The virt machine has as many
 * (VIRT_MAX_CORES in src/virt/platform.js; tests/app/machine_rules.mjs checks)
 */
export const MAX_CORES = 8;

/** Q35's PCI Express root ports (`pcie_root_ports`): ICH9 has six, device 28 (src/platform.js) */
export const Q35_ROOT_PORTS_MAX = 6;

/**
 * The largest vram_size: the VGA core backs at most this much
 * (VGA_MAX_MEMORY_SIZE in graphics_adapters/vga_core.js), and a device whose
 * BAR were larger would reach past it (src/graphics_adapter.js)
 */
export const MAX_VRAM_SIZE = 256 << 20;

/** Every value graphics_adapter may name (src/graphics_adapter.js) */
export const GRAPHICS_ADAPTERS = ["bochs_vga", "vmware_svga", "virtio_gpu", "none"];

/** The network cards (net_device.type) of the PC machines */
export const NET_DEVICE_TYPES = ["ne2k", "e1000", "virtio", "none"];

/** The network cards that are plugins (src/device_plugin.js): build/v86-<type>.js; all but virtio-net */
export const NET_DEVICE_PLUGINS = ["ne2k", "e1000"];

/** The sound cards (audio_device) of the PC machines: one or none (the PC speaker is not a sound card) */
export const AUDIO_DEVICES = ["sb16", "hd_audio", "none"];

/** The sound cards that are plugins: build/v86-<name>.js (underscores as dashes); all of them */
export const AUDIO_DEVICE_PLUGINS = ["sb16", "hd_audio"];

/** The USB host controllers (usb.controller) of the PC machines: UHCI, EHCI with its UHCI companions, xHCI */
export const USB_CONTROLLERS = ["uhci", "ehci", "xhci"];

/** Their ports: the tablet and USB disks each take one (there is no hub; xHCI's are each a USB 3 and a USB 2 root port) */
export const USB_PORTS = { "uhci": 2, "ehci": 6, "xhci": 4 };

/** The firmware of the PC machines (firmware.type): SeaBIOS (bios, vga_bios), the default, or UEFI (OVMF, docs/uefi.md) */
export const FIRMWARE_TYPES = ["seabios", "uefi"];

/** Options of the PC machines that the virt machine rejects */
export const PC_ONLY = ["bzimage", "bzimage_initrd_from_filesystem", "multiboot", "bios", "vga_bios", "fda", "fdb", "cdrom",
    "hpet", "smbus", "pcie_root_ports", "qemu_compatible", "uart1", "uart2", "uart3", "parallel1", "modem",
    "cpuid_level", "x87_fast_math", "x87_jit_cache", "high_memory_size", "cpu_features", "audio_device", "audio_device_path", "usb", "firmware", "tpm"];

/** Options of the virt machine that the PC machines reject */
export const VIRT_ONLY = ["kernel", "dtb", "virtio_disks", "virtio_rng", "virtio_transport", "virtio_input", "virtio_vsock",
    "virtio_console_ports", "virtio_gpu_pci_slot"];

/** The display adapters of the virt machine (no VGA) */
export const VIRT_GRAPHICS_ADAPTERS = ["none", "virtio_gpu"];

/** The network cards of the virt machine (virtio-net) */
export const VIRT_NET_DEVICE_TYPES = ["virtio", "none"];

/** Options that only the Q35 machine has */
export const Q35_ONLY = ["hpet", "smbus", "pcie_root_ports"];

const given = value => value !== undefined && value !== null && value !== false;

/**
 * Check the guest CPU, the machine and the options that belong to them
 * @param {!Object} options the options of new V86(), or CPU.init's settings
 * @return {{cpu_type: string, machine_type: string, cpu_profile: string}}
 */
export function check_machine_options(options)
{
    if(options["experimental_x64"] !== undefined)
    {
        throw new Error("experimental_x64 was replaced by cpu_type: \"x86_64\"");
    }
    if(options["a64_profile"] !== undefined)
    {
        throw new Error("a64_profile was replaced by cpu_profile: \"generic-arm64\" (a64_profile \"v2\"), " +
            "\"generic-arm64-compat32\" (\"v3\"), \"generic-arm64-v1.1\", \"generic-arm64-v1\"");
    }
    const cpu_profile = options["cpu_profile"];
    if(cpu_profile !== undefined && !Object.prototype.hasOwnProperty.call(CPU_PROFILES, cpu_profile))
    {
        throw new Error("Unknown cpu_profile " + JSON.stringify(cpu_profile) + "; supported: " +
            Object.keys(CPU_PROFILES).map(name => "\"" + name + "\"").join(", "));
    }
    // (a CPU model alone picks its CPU type)
    const cpu_type = options["cpu_type"] !== undefined ? options["cpu_type"] :
        cpu_profile !== undefined ? CPU_PROFILES[cpu_profile].cpu_type : CPU_TYPES[0];
    if(!CPU_TYPES.includes(cpu_type))
    {
        throw new Error("Unknown cpu_type " + JSON.stringify(cpu_type) + "; supported: " +
            CPU_TYPES.map(name => "\"" + name + "\"").join(", "));
    }
    if(cpu_profile !== undefined && CPU_PROFILES[cpu_profile].cpu_type !== cpu_type)
    {
        throw new Error("cpu_profile \"" + cpu_profile + "\" is a CPU of cpu_type \"" + CPU_PROFILES[cpu_profile].cpu_type +
            "\", not \"" + cpu_type + "\"; cpu_type \"" + cpu_type + "\" has " + cpu_profiles_of(cpu_type).map(name => "\"" + name + "\"").join(", "));
    }
    const arm = is_arm(cpu_type);
    const machine_type = options["machine_type"] === undefined ? (arm ? "virt" : "i440fx") : options["machine_type"];
    if(!MACHINE_TYPES.includes(machine_type))
    {
        throw new Error("machine_type must be one of " + MACHINE_TYPES.map(m => "\"" + m + "\"").join(", ") +
            ", got " + JSON.stringify(machine_type));
    }
    for(const name of ["ranchu_display", "ranchu_properties", "ranchu_gpu", "ranchu_gles_version"])
    {
        if(options[name] !== undefined && machine_type !== "ranchu") throw new Error(name + " is an option of machine_type \"ranchu\"");
    }
    // (the GPU of the emulator's images: the guest renders, or the GLES host, docs/gles-proxy-plan.md)
    if(options["ranchu_gpu"] !== undefined && !["guest", "host"].includes(options["ranchu_gpu"]))
    {
        throw new Error("ranchu_gpu must be \"guest\" or \"host\", got " + JSON.stringify(options["ranchu_gpu"]));
    }
    // (the highest GLES version the GLES host announces, docs/gles3-plan.md)
    if(options["ranchu_gles_version"] !== undefined && !["2.0", "3.0", "3.1", "3.2"].includes(options["ranchu_gles_version"]))
    {
        throw new Error("ranchu_gles_version must be \"2.0\", \"3.0\", \"3.1\" or \"3.2\", got " + JSON.stringify(options["ranchu_gles_version"]));
    }
    // (the GLES backdoor of arm32's user code, docs/gles-proxy-plan.md "iOS 传输": the iOS machine's, the virt machine's in tests)
    if(options["gles_backdoor"] !== undefined && typeof options["gles_backdoor"] !== "boolean")
    {
        throw new Error("gles_backdoor must be a boolean, got " + JSON.stringify(options["gles_backdoor"]));
    }
    if(options["gles_backdoor"] && (cpu_type !== "arm32" || machine_type !== "virt"))
    {
        throw new Error("gles_backdoor is an option of cpu_type \"arm32\" on machine_type \"virt\"");
    }
    if(arm !== ARM_MACHINE_TYPES.includes(machine_type))
    {
        throw new Error("cpu_type \"" + cpu_type + "\" does not run on machine_type \"" + machine_type + "\": " +
            (arm ? "the ARM CPUs need machine_type \"virt\" (the default with them) or \"ranchu\"" :
                "the " + machine_type + " machine needs cpu_type \"arm64\" or \"arm32\""));
    }
    const profile = cpu_profile === undefined ? DEFAULT_CPU_PROFILES[cpu_type] : cpu_profile;
    const only = MACHINE_CPU_PROFILES[machine_type] && MACHINE_CPU_PROFILES[machine_type][cpu_type];
    if(only && !only.includes(profile))
    {
        throw new Error("machine_type \"" + machine_type + "\" takes cpu_profile " + only.map(name => "\"" + name + "\"").join(", ") +
            " with cpu_type \"" + cpu_type + "\", got " + JSON.stringify(profile));
    }

    if(arm)
    {
        for(const name of PC_ONLY)
        {
            if(given(options[name]))
            {
                throw new Error(name + " is an option of the PC machines (machine_type \"i440fx\", \"q35\"), not of machine_type \"virt\"");
            }
        }
        if(options["acpi"])
        {
            throw new Error("acpi: true is an option of the PC machines; the virt machine describes itself with a device tree");
        }
        const adapter = options["graphics_adapter"];
        if(adapter !== undefined && typeof adapter === "string" && !VIRT_GRAPHICS_ADAPTERS.includes(adapter))
        {
            throw new Error("graphics_adapter " + JSON.stringify(adapter) + " is not on machine_type \"virt\" (no VGA); supported: " +
                VIRT_GRAPHICS_ADAPTERS.map(name => "\"" + name + "\"").join(", "));
        }
        const net = options["net_device"];
        if(net && net["type"] !== undefined && net["type"] !== "virtio" && net["type"] !== "none")
        {
            throw new Error("net_device type " + JSON.stringify(net["type"]) + " is not on machine_type \"virt\"; it has virtio-net");
        }
        if((given(options["hda"]) || given(options["hdb"])) && given(options["virtio_disks"]))
        {
            throw new Error("hda/hdb and virtio_disks both name the virt machine's first disks: give one of them");
        }
        const input = options["virtio_input"];
        if(Array.isArray(input) && input.some(kind => !["keyboard", "tablet", "multitouch"].includes(kind)))
        {
            throw new Error("virtio_input is true or a list of \"keyboard\", \"tablet\" and \"multitouch\", got " + JSON.stringify(input));
        }
        // (ranchu: its own framebuffer, no PCIe)
        if(machine_type === "ranchu" && adapter !== undefined && adapter !== "none" && adapter !== null)
        {
            throw new Error("graphics_adapter " + JSON.stringify(adapter) + " is not on machine_type \"ranchu\", which has the emulator's framebuffer");
        }
        if(machine_type === "ranchu" && options["virtio_transport"] === "pci")
        {
            throw new Error("virtio_transport \"pci\" is not on machine_type \"ranchu\", which has no PCIe host");
        }
        const transport = options["virtio_transport"];
        if(transport !== undefined && transport !== "mmio" && transport !== "pci")
        {
            throw new Error("virtio_transport is \"mmio\" (the default) or \"pci\", got " + JSON.stringify(transport));
        }
    }
    else
    {
        for(const name of VIRT_ONLY)
        {
            if(given(options[name]))
            {
                throw new Error(name + " is an option of machine_type \"virt\" (cpu_type \"arm64\" or \"arm32\")");
            }
        }
        const net = options["net_device"];
        if(net && net["type"] !== undefined && !NET_DEVICE_TYPES.includes(net["type"]))
        {
            throw new Error("Unknown net_device type " + JSON.stringify(net["type"]) + "; supported: " +
                NET_DEVICE_TYPES.map(type => "\"" + type + "\"").join(", "));
        }
        const path = net && net["plugin_path"];
        if(path !== undefined && (typeof path !== "string" || !path))
        {
            throw new Error("net_device.plugin_path must be the path or URL of the plugin file");
        }
        const audio = options["audio_device"];
        if(audio !== undefined && !AUDIO_DEVICES.includes(audio))
        {
            throw new Error("Unknown audio_device " + JSON.stringify(audio) + "; supported: " +
                AUDIO_DEVICES.map(name => "\"" + name + "\"").join(", "));
        }
        const audio_path = options["audio_device_path"];
        if(audio_path !== undefined && (typeof audio_path !== "string" || !audio_path))
        {
            throw new Error("audio_device_path must be the path or URL of the plugin file");
        }
        const usb = options["usb"];
        if(usb !== undefined && usb !== null)
        {
            if(typeof usb !== "object" || !USB_CONTROLLERS.includes(usb["controller"]))
            {
                throw new Error("usb.controller must be one of " + USB_CONTROLLERS.map(name => "\"" + name + "\"").join(", "));
            }
            if(usb["tablet"] !== undefined && typeof usb["tablet"] !== "boolean") throw new Error("usb.tablet must be true or false");
            if(usb["plugin_path"] !== undefined && (typeof usb["plugin_path"] !== "string" || !usb["plugin_path"]))
            {
                throw new Error("usb.plugin_path must be the path or URL of the plugin file");
            }
            // USB disks: { id, image, read_only }, each in a port of its own
            const disks = usb["mass_storage"];
            if(disks !== undefined)
            {
                if(!Array.isArray(disks)) throw new Error("usb.mass_storage must be a list of USB disks ({ id, image, read_only })");
                const ids = new Set(["tablet"]);
                for(const disk of disks)
                {
                    const id = disk && disk["id"];
                    if(typeof id !== "string" || !id) throw new Error("usb.mass_storage: each USB disk needs an id (a string)");
                    if(ids.has(id)) throw new Error("usb.mass_storage: the id " + JSON.stringify(id) + " is taken");
                    ids.add(id);
                    if(!disk["image"] || typeof disk["image"] !== "object") throw new Error("usb.mass_storage: " + JSON.stringify(id) + " needs an image");
                    if(disk["read_only"] !== undefined && typeof disk["read_only"] !== "boolean")
                    {
                        throw new Error("usb.mass_storage: read_only of " + JSON.stringify(id) + " must be true or false");
                    }
                }
                const ports = USB_PORTS[usb["controller"]];
                if(disks.length + (usb["tablet"] ? 1 : 0) > ports)
                {
                    throw new Error("usb: the " + usb["controller"].toUpperCase() + " controller has " + ports + " ports, for " +
                        (usb["tablet"] ? "the tablet and " : "") + disks.length + " USB disk" + (disks.length === 1 ? "" : "s"));
                }
            }
        }
        const tpm = options["tpm"];
        if(tpm !== undefined && tpm !== null)
        {
            if(typeof tpm !== "object" || (tpm["version"] !== undefined && tpm["version"] !== "2.0"))
            {
                throw new Error("tpm.version must be \"2.0\" (the TPM 2.0, docs/tpm.md)");
            }
            if(tpm["interface"] !== undefined && tpm["interface"] !== "crb")
            {
                throw new Error("tpm.interface must be \"crb\" (the Command Response Buffer)");
            }
            if(tpm["state"] !== undefined && (!tpm["state"] || typeof tpm["state"] !== "object"))
            {
                throw new Error("tpm.state must be the image of the TPM's state ({ url } or { buffer }, disk_option \"read_write\" to keep it)");
            }
            for(const name of ["plugin_path", "wasm_path"])
            {
                if(tpm[name] !== undefined && (typeof tpm[name] !== "string" || !tpm[name])) throw new Error("tpm." + name + " must be a path or URL");
            }
        }
        const firmware = options["firmware"];
        if(firmware !== undefined && firmware !== null)
        {
            if(typeof firmware !== "object" || !FIRMWARE_TYPES.includes(firmware["type"]))
            {
                throw new Error("firmware.type must be one of " + FIRMWARE_TYPES.map(name => "\"" + name + "\"").join(", "));
            }
            if(firmware["type"] === "uefi")
            {
                if(!firmware["code"] || typeof firmware["code"] !== "object")
                {
                    throw new Error("firmware: UEFI needs its code image (firmware.code: { url } or { buffer })");
                }
                if(firmware["vars"] !== undefined && (!firmware["vars"] || typeof firmware["vars"] !== "object"))
                {
                    throw new Error("firmware.vars must be the variable store's image ({ url } or { buffer })");
                }
                if(options["bios"] || options["vga_bios"])
                {
                    throw new Error("firmware: UEFI takes the place of bios and vga_bios; give one or the other");
                }
                if(cpu_type !== "x86_64")
                {
                    throw new Error("firmware: the UEFI firmware (OVMF, X64) needs cpu_type \"x86_64\"");
                }
                if(!options["acpi"])
                {
                    throw new Error("firmware: UEFI needs acpi: true (OVMF installs the machine's ACPI tables)");
                }
                if(machine_type === "i440fx" && !options["qemu_compatible"])
                {
                    throw new Error("firmware: UEFI on machine_type \"i440fx\" needs qemu_compatible: true " +
                        "(OVMF expects QEMU's PIIX3/PIIX4 functions at 00:01.0 to 00:01.3)");
                }
                if(firmware["secure_boot"] !== undefined && typeof firmware["secure_boot"] !== "boolean")
                {
                    throw new Error("firmware.secure_boot must be a boolean");
                }
                if(firmware["secure_boot"])
                {
                    // (the Secure Boot build keeps its variables in SMM: Q35's SMRAM)
                    if(machine_type !== "q35")
                    {
                        throw new Error("firmware.secure_boot needs machine_type \"q35\" (the firmware runs its variable services in SMM)");
                    }
                    if(!firmware["vars"])
                    {
                        throw new Error("firmware.secure_boot needs the variable store (firmware.vars)");
                    }
                }
            }
        }
    }
    return { cpu_type, machine_type, cpu_profile: profile };
}

/**
 * What the options of new V86() may be on a CPU and machine, for a page that
 * offers them (docs/vm-manager-plan.md, the settings dialog: it disables what
 * does not apply and says why). The same rules as check_machine_options and
 * the machines' own checks (src/platform.js: hpet, smbus and pcie_root_ports
 * need Q35, Q35 needs ACPI, more than one core needs ACPI).
 * @param {string} cpu_type
 * @param {string} machine_type
 * @return {{machine_types: !Array<string>, graphics_adapters: !Array<string>, net_device_types: !Array<string>,
 *     audio_devices: !Array<string>, usb_controllers: !Array<string>, cpu_profiles: !Array<string>,
 *     max_cores: number, acpi: string, unavailable: !Object<string, string>}} machine_types: the machines
 *     of the CPU; cpu_profiles: the CPU models to offer (cpu_profile); acpi: "required" (Q35),
 *     "with_cores" (needed with more than one core), "none" (virt); unavailable: the options that do
 *     not apply, each with the reason
 */
export function allowed_options(cpu_type, machine_type)
{
    const virt = ARM_MACHINE_TYPES.includes(machine_type);
    /** @type {!Object<string, string>} */
    const unavailable = {};
    if(virt)
    {
        for(const name of PC_ONLY)
        {
            unavailable[name] = name + " is an option of the PC machines (i440FX, Q35), not of the virt machine";
        }
        unavailable["bios"] = unavailable["vga_bios"] = "the virt machine has no PC firmware (it boots its kernel directly)";
        unavailable["fda"] = unavailable["fdb"] = "the virt machine has no floppy controller";
        unavailable["acpi"] = "the virt machine describes itself with a device tree, not ACPI";
        if(machine_type === "ranchu")
        {
            unavailable["virtio_transport"] = "the ranchu machine has no PCIe host: its virtio devices are on virtio-mmio";
        }
    }
    else
    {
        for(const name of VIRT_ONLY)
        {
            unavailable[name] = name + " is an option of the virt machine (cpu_type \"arm64\" or \"arm32\")";
        }
        if(machine_type !== "q35")
        {
            unavailable["hpet"] = "only the Q35 machine has an HPET";
            unavailable["smbus"] = "only the Q35 machine has an SMBus controller";
            unavailable["pcie_root_ports"] = "only the Q35 machine has PCI Express root ports";
        }
    }
    return {
        machine_types: is_arm(cpu_type) ? ARM_MACHINE_TYPES.slice() : MACHINE_TYPES.filter(m => !ARM_MACHINE_TYPES.includes(m)),
        graphics_adapters: machine_type === "ranchu" ? ["none"] : virt ? VIRT_GRAPHICS_ADAPTERS.slice() : GRAPHICS_ADAPTERS.slice(),
        net_device_types: virt ? VIRT_NET_DEVICE_TYPES.slice() : NET_DEVICE_TYPES.slice(),
        // (the virt machine's sound is virtio_sound)
        audio_devices: virt ? [] : AUDIO_DEVICES.slice(),
        // (the virt machine's input is virtio_input)
        usb_controllers: virt ? [] : USB_CONTROLLERS.slice(),
        cpu_profiles: cpu_profiles_of(cpu_type, machine_type),
        max_cores: MAX_CORES,
        acpi: virt ? "none" : machine_type === "q35" ? "required" : "with_cores",
        unavailable,
    };
}
