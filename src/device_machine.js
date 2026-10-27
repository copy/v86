// A plugin's view of the machine (plugin side of src/device_plugin.js). v86
// hands a plugin a handle whose names are all quoted, because the plugin is
// not compiled with v86. DeviceMachine wraps that handle in a typed class, so
// that the device code reads like any other v86 device, and converts what
// crosses the boundary (port handlers, the PCI description) between plugin
// names and quoted names. Display adapters extend it (GraphicsMachine in
// src/graphics_adapters/machine.js); network and sound cards use it with
// their kind's part (NetMachine, AudioMachine). ISA cards (the SB16) have
// their interrupt line and the 8237's channels here too.

/**
 * Make a plugin's device known to v86. Plugin files call this when they load.
 * @param {string} registry the kind's global registry ("V86GraphicsAdapters",
 *     "V86NetAdapters", "V86AudioDevices")
 * @param {!Object} descriptor { "name", "create", ... }
 */
export function register_device_plugin(registry, descriptor)
{
    const entries = globalThis[registry] || (globalThis[registry] = {});
    entries[descriptor["name"]] = descriptor;
}

/**
 * @constructor
 * @param {!Object} handle the quoted machine handle from src/device_plugin.js
 */
export function DeviceMachine(handle)
{
    this.handle = handle;

    /** @const @type {string} */
    this.name = handle["name"];

    /** @const @type {!WebAssembly.Memory} */
    this.wasm_memory = handle["wasm_memory"];

    /** @const @type {boolean} */
    this.qemu_compatible = !!handle["qemu_compatible"];

    /** @const @type {string} "i440fx", "q35" */
    this.machine_type = handle["machine_type"] || "i440fx";
}

/**
 * Like IO.register_read; the handlers are called with `device` as this
 * @param {number} port
 * @param {!Object} device
 * @param {function(number):number=} r8
 * @param {function(number):number=} r16
 * @param {function(number):number=} r32
 */
DeviceMachine.prototype.register_read = function(port, device, r8, r16, r32)
{
    this.handle["register_read"](port, r8 && r8.bind(device), r16 && r16.bind(device), r32 && r32.bind(device));
};

/**
 * Like IO.register_write
 * @param {number} port
 * @param {!Object} device
 * @param {function(number)=} w8
 * @param {function(number)=} w16
 * @param {function(number)=} w32
 */
DeviceMachine.prototype.register_write = function(port, device, w8, w16, w32)
{
    this.handle["register_write"](port, w8 && w8.bind(device), w16 && w16.bind(device), w32 && w32.bind(device));
};

/**
 * Like IO.register_write_consecutive: two (or four) byte ports, wider writes split
 * @param {number} port
 * @param {!Object} device
 * @param {function(number)} w8_1
 * @param {function(number)} w8_2
 * @param {function(number)=} w8_3
 * @param {function(number)=} w8_4
 */
DeviceMachine.prototype.register_write_consecutive = function(port, device, w8_1, w8_2, w8_3, w8_4)
{
    this.handle["register_write_consecutive"](port, w8_1.bind(device), w8_2.bind(device),
        w8_3 && w8_3.bind(device), w8_4 && w8_4.bind(device));
};

/**
 * Like IO.register_read_consecutive: two (or four) byte ports, wider reads combined
 * @param {number} port
 * @param {!Object} device
 * @param {function():number} r8_1
 * @param {function():number} r8_2
 * @param {function():number=} r8_3
 * @param {function():number=} r8_4
 */
DeviceMachine.prototype.register_read_consecutive = function(port, device, r8_1, r8_2, r8_3, r8_4)
{
    this.handle["register_read_consecutive"](port, r8_1.bind(device), r8_2.bind(device),
        r8_3 && r8_3.bind(device), r8_4 && r8_4.bind(device));
};

/**
 * Like IO.mmap_register: whole 128 KiB blocks
 * @param {number} address
 * @param {number} size
 * @param {function(number):number} read8
 * @param {function(number, number)} write8
 * @param {function(number):number=} read32
 * @param {function(number, number)=} write32
 */
DeviceMachine.prototype.mmap_register = function(address, size, read8, write8, read32, write32)
{
    this.handle["mmap_register"](address, size, read8, write8, read32, write32);
};

/**
 * Like IO.mmap_register_range: an exact range (a BAR), owned by the device
 * @param {number} address
 * @param {number} size
 * @param {function(number):number} read8
 * @param {function(number, number)} write8
 * @param {function(number):number=} read32 aligned dwords
 * @param {function(number, number)=} write32
 */
DeviceMachine.prototype.mmap_register_range = function(address, size, read8, write8, read32, write32)
{
    this.handle["mmap_register_range"](address, size, read8, write8, read32, write32);
};

/**
 * @param {number} address
 * @param {number} size
 */
DeviceMachine.prototype.mmap_unregister_range = function(address, size)
{
    this.handle["mmap_unregister_range"](address, size);
};

/**
 * A free window of I/O ports for an I/O BAR
 * @param {number} size a power of two
 * @return {number} its first port
 */
DeviceMachine.prototype.allocate_io = function(size)
{
    return this.handle["allocate_io"](size);
};

/**
 * Another function of the device's PCI slot (a device of several, as EHCI
 * with its companions): a machine of its own for that function's PCI
 * registration, interrupt and configuration space
 * @param {number} number 0 to 7
 * @return {!DeviceMachine}
 */
DeviceMachine.prototype.function_machine = function(number)
{
    return new DeviceMachine(this.handle["function"](number));
};

/**
 * Describe the device on the PCI bus. v86 picks the slot. The hooks are
 * src/pci.js's: on_command_change (the command register: memory decode, bus
 * mastering), on_config_restore (a snapshot restored the space),
 * on_upstream_change (a bridge's forwarding changed), on_config_write
 * (offset, size: a write to the space beyond the header).
 * @param {{
 *     pci_space: !Array<number>,
 *     pci_bars: !Array<?{size: number, on_move: (function(number)|undefined)}>,
 *     pci_rom_size: (number|undefined),
 *     pci_rom_address: (number|undefined),
 *     on_command_change: (function()|undefined),
 *     on_config_restore: (function()|undefined),
 *     on_upstream_change: (function()|undefined),
 *     on_config_write: (function(number, number)|undefined),
 * }} description
 * @return {*} (v86's own record of the function; the device uses pci_config)
 */
DeviceMachine.prototype.register_pci = function(description)
{
    return this.handle["register_pci"]({
        "pci_space": description.pci_space,
        "pci_bars": description.pci_bars.map(bar => bar && { "size": bar.size, "on_move": bar.on_move }),
        "pci_rom_size": description.pci_rom_size,
        "pci_rom_address": description.pci_rom_address,
        "on_command_change": description.on_command_change,
        "on_config_restore": description.on_config_restore,
        "on_upstream_change": description.on_upstream_change,
        "on_config_write": description.on_config_write,
    });
};

/** @return {number} the device's PCI function (bus << 8 | device << 3 | function) */
DeviceMachine.prototype.pci_id = function()
{
    return this.handle["pci_id"]();
};

DeviceMachine.prototype.raise_irq = function()
{
    this.handle["raise_irq"]();
};

DeviceMachine.prototype.lower_irq = function()
{
    this.handle["lower_irq"]();
};

/**
 * Whether the function decodes memory at [base, base + size): memory space
 * enabled, and the bridges upstream forward the range
 * @param {number} base
 * @param {number} size
 * @return {boolean}
 */
DeviceMachine.prototype.memory_decoded = function(base, size)
{
    return this.handle["memory_decoded"](base, size);
};

/** @return {boolean} whether the function may master the bus (DMA, MSI) */
DeviceMachine.prototype.is_bus_master = function()
{
    return this.handle["is_bus_master"]();
};

/**
 * The bytes of a single-vector MSI capability (src/pci.js)
 * @param {number} next the next capability's offset, or 0
 * @return {!Array<number>}
 */
DeviceMachine.prototype.msi_capability = function(next)
{
    return this.handle["msi_capability"](next);
};

/**
 * The guest wrote the MSI capability at `cap`: keep its read-only bits
 * @param {number} cap
 * @param {number=} next
 */
DeviceMachine.prototype.msi_config_written = function(cap, next)
{
    this.handle["msi_config_written"](cap, next || 0);
};

/**
 * @param {number} cap
 * @return {boolean}
 */
DeviceMachine.prototype.msi_enabled = function(cap)
{
    return this.handle["msi_enabled"](cap);
};

/**
 * Send the message of the MSI capability at `cap`
 * @param {number} cap
 * @return {boolean} whether a local APIC accepted it
 */
DeviceMachine.prototype.msi_notify = function(cap)
{
    return this.handle["msi_notify"](cap);
};

/**
 * The function's configuration space, a view taken now (a snapshot restores
 * it in place; the view is not kept)
 * @return {!Uint8Array}
 */
DeviceMachine.prototype.pci_config = function()
{
    return this.handle["pci_config"]();
};

/**
 * An ISA card's interrupt line (0 to 15): raised
 * @param {number} irq
 */
DeviceMachine.prototype.isa_raise_irq = function(irq)
{
    this.handle["isa_raise_irq"](irq);
};

/** @param {number} irq */
DeviceMachine.prototype.isa_lower_irq = function(irq)
{
    this.handle["isa_lower_irq"](irq);
};

/**
 * The 8237 DMA: `listener` is called with a channel when the guest unmasks it
 * @param {function(number)} listener
 */
DeviceMachine.prototype.dma_on_unmask = function(listener)
{
    this.handle["dma_on_unmask"](listener);
};

/**
 * @param {number} channel
 * @return {boolean} whether the guest masked the channel (its DREQ is ignored)
 */
DeviceMachine.prototype.dma_masked = function(channel)
{
    return this.handle["dma_masked"](channel);
};

/**
 * A transfer from memory to the device on `channel` (the 8237 programmed by
 * the guest), into `target` from `start`, at most `length` bytes: the
 * DMA's callback (error, cause, retry)
 * @param {number} channel
 * @param {!Uint8Array} target
 * @param {number} start
 * @param {number} length
 * @param {function(boolean, *=, function()=)} callback
 */
DeviceMachine.prototype.dma_write = function(channel, target, start, length, callback)
{
    this.handle["dma_write"](channel, target, start, length, callback);
};

/**
 * Guest physical memory, including RAM above 4 GiB
 * @param {number} address
 * @param {number} length
 * @return {!Uint8Array}
 */
DeviceMachine.prototype.read_physical = function(address, length)
{
    return this.handle["read_physical"](address, length);
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} address
 */
DeviceMachine.prototype.write_physical = function(bytes, address)
{
    this.handle["write_physical"](bytes, address);
};

/**
 * @param {number} address
 * @return {number}
 */
DeviceMachine.prototype.read16_physical = function(address)
{
    return this.handle["read16_physical"](address);
};

/**
 * @param {number} address
 * @return {number}
 */
DeviceMachine.prototype.read32_physical = function(address)
{
    return this.handle["read32_physical"](address);
};

/**
 * @param {number} address
 * @param {number} value
 */
DeviceMachine.prototype.write16_physical = function(address, value)
{
    this.handle["write16_physical"](address, value);
};

/**
 * @param {number} address
 * @param {number} value
 */
DeviceMachine.prototype.write32_physical = function(address, value)
{
    this.handle["write32_physical"](address, value);
};

/**
 * Whether [address, address + length) is guest memory a device may access
 * (throws a RangeError where it is not)
 * @param {number} address
 * @param {number} length
 * @return {boolean}
 */
DeviceMachine.prototype.validate_physical_range = function(address, length)
{
    return this.handle["validate_physical_range"](address, length);
};

/** @return {number} the machine clock, in milliseconds */
DeviceMachine.prototype.now = function()
{
    return this.handle["now"]();
};

/**
 * Called whenever the machine's timers run (each slice of the CPU's): a
 * device's own polling. Returns milliseconds until it needs to run again.
 * @param {function(number):number} timer
 */
DeviceMachine.prototype.add_timer = function(timer)
{
    this.handle["add_timer"](timer);
};

/**
 * Something outside the machine's own run (a frame from the network) set a
 * deadline: run the timers soon, also when the machine is halted
 */
DeviceMachine.prototype.wake = function()
{
    this.handle["wake"]();
};
