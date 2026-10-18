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

/** Options of the PC machines that the virt machine rejects */
const PC_ONLY = ["bzimage", "bzimage_initrd_from_filesystem", "multiboot", "bios", "vga_bios", "fda", "fdb", "cdrom",
    "hpet", "smbus", "pcie_root_ports", "qemu_compatible", "uart1", "uart2", "uart3", "parallel1", "modem",
    "cpuid_level", "x87_fast_math", "x87_jit_cache", "high_memory_size", "cpu_features"];

/** Options of the virt machine that the PC machines reject */
const VIRT_ONLY = ["kernel", "dtb", "virtio_disks", "virtio_rng", "virtio_transport", "virtio_input", "virtio_vsock",
    "virtio_console_ports", "virtio_gpu_pci_slot"];

/** The display adapters of the virt machine (no VGA) */
const VIRT_GRAPHICS_ADAPTERS = ["none", "virtio_gpu"];

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
