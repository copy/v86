// The guest CPU and machine of new V86() and the options each combination
// allows (docs/arm64-virt-android16-plan.md, the configuration contract and
// P1.1): the V86 constructor checks the options, CPU.init checks its
// settings again. The PC machines (i440fx, q35) run the x86 CPUs, the virt
// machine runs the arm64 CPU; an option of the other family is an error,
// never silently ignored.

/** The guest CPUs (`cpu_type`); the first is the default */
export const CPU_TYPES = ["x86", "x86_64", "arm64"];

/**
 * The machines (`machine_type`): "i440fx" (the default with an x86 CPU:
 * i440FX host bridge, PIIX3/4, IDE), "q35" (Q35 MCH, ICH9 LPC with its power
 * management, AHCI; docs/q35.md) and "virt" (the arm64 board, docs/virt.md)
 */
export const MACHINE_TYPES = ["i440fx", "q35", "virt"];

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
export const NET_DEVICE_TYPES = ["ne2k", "virtio", "none"];

/** Options of the PC machines that the virt machine rejects */
export const PC_ONLY = ["bzimage", "bzimage_initrd_from_filesystem", "multiboot", "bios", "vga_bios", "fda", "fdb", "cdrom",
    "hpet", "smbus", "pcie_root_ports", "qemu_compatible", "uart1", "uart2", "uart3", "parallel1", "modem",
    "cpuid_level", "x87_fast_math", "x87_jit_cache", "high_memory_size", "cpu_features"];

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
    const arm = cpu_type === "arm64";
    const machine_type = options["machine_type"] === undefined ? (arm ? "virt" : "i440fx") : options["machine_type"];
    if(!MACHINE_TYPES.includes(machine_type))
    {
        throw new Error("machine_type must be one of " + MACHINE_TYPES.map(m => "\"" + m + "\"").join(", ") +
            ", got " + JSON.stringify(machine_type));
    }
    if(arm !== (machine_type === "virt"))
    {
        throw new Error("cpu_type \"" + cpu_type + "\" does not run on machine_type \"" + machine_type + "\": " +
            (arm ? "the arm64 CPU needs machine_type \"virt\" (the default with it)" : "the virt machine needs cpu_type \"arm64\""));
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
        const transport = options["virtio_transport"];
        if(transport !== undefined && transport !== "mmio" && transport !== "pci")
        {
            throw new Error("virtio_transport is \"mmio\" (the default) or \"pci\", got " + JSON.stringify(transport));
        }
        const profile = options["a64_profile"];
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
                throw new Error(name + " is an option of machine_type \"virt\" (cpu_type \"arm64\")");
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
 *     max_cores: number, acpi: string, unavailable: !Object<string, string>}} machine_types: the machines
 *     of the CPU; acpi: "required" (Q35), "with_cores" (needed with more than one core), "none" (virt);
 *     unavailable: the options that do not apply, each with the reason
 */
export function allowed_options(cpu_type, machine_type)
{
    const virt = machine_type === "virt";
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
    }
    else
    {
        for(const name of VIRT_ONLY)
        {
            unavailable[name] = name + " is an option of the virt machine (cpu_type \"arm64\")";
        }
        if(machine_type !== "q35")
        {
            unavailable["hpet"] = "only the Q35 machine has an HPET";
            unavailable["smbus"] = "only the Q35 machine has an SMBus controller";
            unavailable["pcie_root_ports"] = "only the Q35 machine has PCI Express root ports";
        }
    }
    return {
        machine_types: cpu_type === "arm64" ? ["virt"] : MACHINE_TYPES.filter(m => m !== "virt"),
        graphics_adapters: virt ? VIRT_GRAPHICS_ADAPTERS.slice() : GRAPHICS_ADAPTERS.slice(),
        net_device_types: virt ? VIRT_NET_DEVICE_TYPES.slice() : NET_DEVICE_TYPES.slice(),
        max_cores: MAX_CORES,
        acpi: virt ? "none" : machine_type === "q35" ? "required" : "with_cores",
        unavailable,
    };
}
