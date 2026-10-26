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

/** The network cards that are plugins (src/device_plugin.js): build/v86-<type>.js */
export const NET_DEVICE_PLUGINS = ["e1000"];

/** The sound cards (audio_device) of the PC machines: one or none (the PC speaker is not a sound card) */
export const AUDIO_DEVICES = ["sb16", "hd_audio", "none"];

/** The sound cards that are plugins: build/v86-<name>.js (underscores as dashes) */
export const AUDIO_DEVICE_PLUGINS = ["hd_audio"];

/** The USB host controllers (usb.controller) of the PC machines */
export const USB_CONTROLLERS = ["uhci"];

/** Their root ports: the tablet and USB disks each take one (there is no hub) */
export const USB_PORTS = { "uhci": 2 };

/** Options of the PC machines that the virt machine rejects */
export const PC_ONLY = ["bzimage", "bzimage_initrd_from_filesystem", "multiboot", "bios", "vga_bios", "fda", "fdb", "cdrom",
    "hpet", "smbus", "pcie_root_ports", "qemu_compatible", "uart1", "uart2", "uart3", "parallel1", "modem",
    "cpuid_level", "x87_fast_math", "x87_jit_cache", "high_memory_size", "cpu_features", "audio_device", "audio_device_path", "usb"];

/** Options of the virt machine that the PC machines reject */
export const VIRT_ONLY = ["kernel", "dtb", "virtio_disks", "virtio_rng", "virtio_transport", "virtio_input", "virtio_vsock",
    "virtio_console_ports", "virtio_gpu_pci_slot", "a64_profile"];

/** The arm64 CPU's profiles (a64_profile, src/virt/platform.js); v2 is the default */
export const A64_PROFILES = ["v1", "v1.1", "v2", "v3"];

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
 * @return {{cpu_type: string, machine_type: string}}
 */
export function check_machine_options(options)
{
    if(options["experimental_x64"] !== undefined)
    {
        throw new Error("experimental_x64 was replaced by cpu_type: \"x86_64\"");
    }
    const cpu_type = options["cpu_type"] === undefined ? CPU_TYPES[0] : options["cpu_type"];
    if(!CPU_TYPES.includes(cpu_type))
    {
        throw new Error("Unknown cpu_type " + JSON.stringify(cpu_type) + "; supported: " +
            CPU_TYPES.map(name => "\"" + name + "\"").join(", "));
    }
    const arm = is_arm(cpu_type);
    const machine_type = options["machine_type"] === undefined ? (arm ? "virt" : "i440fx") : options["machine_type"];
    if(!MACHINE_TYPES.includes(machine_type))
    {
        throw new Error("machine_type must be one of " + MACHINE_TYPES.map(m => "\"" + m + "\"").join(", ") +
            ", got " + JSON.stringify(machine_type));
    }
    for(const name of ["ranchu_display", "ranchu_properties"])
    {
        if(options[name] !== undefined && machine_type !== "ranchu") throw new Error(name + " is an option of machine_type \"ranchu\"");
    }
    if(arm !== ARM_MACHINE_TYPES.includes(machine_type))
    {
        throw new Error("cpu_type \"" + cpu_type + "\" does not run on machine_type \"" + machine_type + "\": " +
            (arm ? "the ARM CPUs need machine_type \"virt\" (the default with them) or \"ranchu\"" :
                "the " + machine_type + " machine needs cpu_type \"arm64\" or \"arm32\""));
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
        const profile = options["a64_profile"];
        if(profile !== undefined && cpu_type !== "arm64")
        {
            throw new Error("a64_profile is an option of cpu_type \"arm64\"; cpu_type \"arm32\" has its own profile");
        }
        if(profile !== undefined && !A64_PROFILES.includes(profile))
        {
            throw new Error("a64_profile is one of " + A64_PROFILES.map(p => JSON.stringify(p)).join(", ") + ", got " + JSON.stringify(profile));
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
    }
    return { cpu_type, machine_type };
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
 *     audio_devices: !Array<string>, usb_controllers: !Array<string>,
 *     max_cores: number, acpi: string, unavailable: !Object<string, string>}} machine_types: the machines
 *     of the CPU; acpi: "required" (Q35), "with_cores" (needed with more than one core), "none" (virt);
 *     unavailable: the options that do not apply, each with the reason
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
        if(cpu_type === "arm32")
        {
            unavailable["a64_profile"] = "a64_profile is an option of cpu_type \"arm64\"; cpu_type \"arm32\" has its own profile";
        }
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
        max_cores: MAX_CORES,
        acpi: virt ? "none" : machine_type === "q35" ? "required" : "with_cores",
        unavailable,
    };
}
