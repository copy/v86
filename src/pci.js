import { LOG_PCI } from "./const.js";
import { QEMU_PCI_SUBSYSTEM, RESET_PORT } from "./platform.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";

// http://wiki.osdev.org/PCI
//
// Configuration space is reached through the address/data ports 0xCF8/0xCFC
// (mechanism #1) and, on Q35, through the memory-mapped ECAM window. Both go
// through config_read/config_write, which give the header registers their
// semantics (read-only fields, write-one-to-clear status bits, BARs); the
// device-specific part (0x40 and above) is plain storage plus the device's
// on_config_write callback.
//
// Buses behind PCI-to-PCI bridges (the PCI Express root ports of Q35): a
// function's pci_id is its place, bus 0 or a bridge's secondary bus by the
// number the machine gave that bus when it was built (a bridge's
// pci_secondary_bus), << 8 | device << 3 | function. The bus numbers the
// guest sees are the ones it programs into the bridges; configuration
// accesses are routed by them (route_config). A bridge forwards memory and
// I/O accesses within its windows while its decode is enabled, bus master
// requests (DMA, MSI) while its bus mastering is enabled, and interrupt pins
// with the swizzle of the PCI-to-PCI bridge specification. Devices behind a
// bridge take decode and DMA from memory_decoded, upstream_forwards_memory and
// is_bus_master, and hear of changes upstream by on_upstream_change; their I/O
// BARs are mapped only where the bridges forward them.
//
// The virt machine's generic PCIe host bridge (`generic`,
// docs/arm64-virt-android16-plan.md P5.6, P5.10) is the same bus without the
// PC's parts: configuration through ECAM only (ecam_handler, no 0xCF8/0xCFC
// and no reset control register), no i440FX; INTx to the GIC (an SPI per pin
// and slot, level-triggered); memory BARs decoded only while their memory
// space is enabled, reached through the bridge's windows (window_handler),
// also above 4 GiB: a BAR may be 64 bits wide (bits64, the next BAR register
// its upper half). A reset gives every function its power-on configuration.

export const PCI_CONFIG_ADDRESS = 0xCF8;
export const PCI_CONFIG_DATA = 0xCFC;

// Command register bits that have an effect, and those a guest can change
export const PCI_COMMAND_IO = 1 << 0;
export const PCI_COMMAND_MEMORY = 1 << 1;
export const PCI_COMMAND_MASTER = 1 << 2;
export const PCI_COMMAND_INTX_DISABLE = 1 << 10;
const PCI_COMMAND_WRITABLE = PCI_COMMAND_IO | PCI_COMMAND_MEMORY | PCI_COMMAND_MASTER |
    1 << 6 | 1 << 8 | PCI_COMMAND_INTX_DISABLE; // (and parity / SERR# response)

// Status register: interrupt status is read-only, the error bits are
// cleared by writing one
const PCI_STATUS_INTERRUPT = 1 << 3;
const PCI_STATUS_RW1C = 0xF900;

/** Capability ID of MSI (PCI Local Bus 3.0, 6.8.1) */
export const PCI_CAP_MSI = 0x05;
const MSI_CONTROL_ENABLE = 1 << 0;
const MSI_CONTROL_64BIT = 1 << 7;

/**
 * An MSI capability with one message and 64-bit addresses: ID, next,
 * message control, address (low, high), data
 * @param {number} next the next capability's offset, or 0
 * @return {!Array<number>}
 */
export function msi_capability(next)
{
    return [PCI_CAP_MSI, next, MSI_CONTROL_64BIT, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

/**
 * Bytes of the type 0 header (0x00-0x3F) a guest may write as plain storage;
 * everything else in the header is read-only or handled specially (command,
 * status, BARs, expansion ROM)
 * @param {number} offset
 * @return {boolean}
 */
function header_byte_writable(offset)
{
    return offset === 0x0C || offset === 0x0D || offset === 0x0F || offset === 0x3C;
}

// The type 1 header of a PCI-to-PCI bridge (PCI-to-PCI Bridge Architecture 1.2, 3.2)
const PCI_HEADER_TYPE_BRIDGE = 1;
const BRIDGE_SECONDARY_BUS = 0x19;
const BRIDGE_SUBORDINATE_BUS = 0x1A;
const BRIDGE_IO_BASE = 0x1C;
const BRIDGE_IO_LIMIT = 0x1D;
const BRIDGE_SECONDARY_STATUS = 0x1E;
const BRIDGE_MEMORY_BASE = 0x20;
const BRIDGE_MEMORY_LIMIT = 0x22;
const BRIDGE_PREFETCH_BASE = 0x24;
const BRIDGE_PREFETCH_LIMIT = 0x26;
const BRIDGE_PREFETCH_BASE_UPPER = 0x28;
const BRIDGE_PREFETCH_LIMIT_UPPER = 0x2C;
const BRIDGE_CONTROL = 0x3E;
const BRIDGE_CONTROL_ISA = 1 << 2;

/**
 * Writable bits of the type 1 header bytes 0x18-0x3F: bus numbers, secondary
 * latency timer, I/O (16-bit decode), memory and prefetchable (64-bit)
 * windows, interrupt line, bridge control (parity and SERR# response, ISA,
 * VGA, VGA 16-bit decode, secondary bus reset). The secondary status is
 * write-one-to-clear; the rest is read-only (no BARs beyond 0x10-0x17, no
 * expansion ROM).
 */
const BRIDGE_HEADER_WRITABLE = new Uint8Array(0x40);
BRIDGE_HEADER_WRITABLE.fill(0xFF, 0x18, 0x1C);
BRIDGE_HEADER_WRITABLE[BRIDGE_IO_BASE] = BRIDGE_HEADER_WRITABLE[BRIDGE_IO_LIMIT] = 0xF0;
BRIDGE_HEADER_WRITABLE.set([0xF0, 0xFF, 0xF0, 0xFF, 0xF0, 0xFF, 0xF0, 0xFF], BRIDGE_MEMORY_BASE);
BRIDGE_HEADER_WRITABLE.fill(0xFF, BRIDGE_PREFETCH_BASE_UPPER, BRIDGE_PREFETCH_LIMIT_UPPER + 4);
BRIDGE_HEADER_WRITABLE[0x3C] = 0xFF;
BRIDGE_HEADER_WRITABLE[BRIDGE_CONTROL] = 0x5F;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {{generic: boolean}=} options generic: the virt machine's generic PCIe host bridge
 */
export function PCI(cpu, options)
{
    /** the virt machine's generic PCIe host bridge (P5.6) */
    this.generic = !!(options && options.generic);

    this.pci_addr = new Uint8Array(4);
    // (pci_value, pci_response and pci_status are no longer used; they stay
    // for the layout of state images)
    this.pci_value = new Uint8Array(4);
    this.pci_response = new Uint8Array(4);
    this.pci_status = new Uint8Array(4);

    this.pci_addr32 = new Int32Array(this.pci_addr.buffer);

    /**
     * Configuration spaces by bdf (bus << 8 | device << 3 | function): 64
     * dwords (conventional PCI) or 1024 (PCI Express extended space)
     * @type {!Array<Int32Array|undefined>}
     */
    this.device_spaces = [];
    this.devices = [];

    /**
     * The IRQ line each function has asserted, by pci_id
     * @type {!Array<number|undefined>}
     */
    this.asserted_irq_lines = [];

    /**
     * The IOAPIC-only input (GSI) each function has asserted (Q35)
     * @type {!Array<number|undefined>}
     */
    this.asserted_gsis = [];

    /**
     * The level each function drives on its interrupt pin, before INTx Disable
     * @type {!Array<boolean|undefined>}
     */
    this.intx_levels = [];

    /** @const @type {CPU} */
    this.cpu = cpu;

    for(var i = 0; i < 256; i++)
    {
        this.device_spaces[i] = undefined;
        this.devices[i] = undefined;
    }

    this.io = cpu.io;

    /**
     * Where the chipset connects interrupt pin (0-3: INTA-D) of a function on
     * bus 0: an ISA IRQ for the PIC (bit 7 set: not routed) and an
     * IOAPIC-only input (GSI 16-23 on Q35, -1 when the IOAPIC sees the pin
     * through the ISA IRQ, as on i440FX). Pins behind bridges arrive here as
     * the pin of their bridge on bus 0 (root_pin). Replaced by the chipset;
     * the default is the PIIX3 PIRQ routing.
     * @type {function(number, number):{pic: number, gsi: number}}
     */
    this.irq_route = (pci_id, pin) => ({ pic: this.piix_pirq_line(pci_id, pin), gsi: -1 });
    if(this.generic)
    {
        // (the reference's interrupt-map: pin p (0-3) of slot s is SPI 3 +
        // (p + s) % 4, INTID 32 + that; not a PIC line, bit 7)
        this.irq_route = (pci_id, pin) => ({ pic: 0x80, gsi: 32 + 3 + (pin + (pci_id >> 3 & 0x1F) & 3) });
    }

    /**
     * The bridge whose secondary side each bus is, by the bus's number in
     * pci_ids (pci_secondary_bus of the bridge)
     * @type {!Array<number|undefined>}
     */
    this.bridge_for_bus = [];
    /**
     * The bridges on each bus, by the bus's number in pci_ids
     * @type {!Array<!Array<number>|undefined>}
     */
    this.bridges_on = [];

    /** The mapped ECAM window (Q35), or -1 */
    this.ecam_base = -1;
    this.ecam_size = 0;

    /**
     * Functions behind a hot plug slot that are not on the bus (the slot is
     * empty or off, src/pcie_root_port.js), by pci_id: see set_function_present
     * @type {!Array<boolean|undefined>}
     */
    this.absent = [];
    /**
     * The power-on configuration space of each function behind a bridge,
     * which a card plugged into a hot plug slot has again
     * @type {!Array<Int32Array|undefined>}
     */
    this.templates = [];

    /**
     * The generic host's decoded memory BARs: where each is, by its owner
     * (window_handler)
     * @type {!Array<{owner: !Object, base: number, size: number, handler: !Object}>}
     */
    this.memory_decoders = [];

    if(this.generic)
    {
        this.reset_control = 0;
        this.create_generic_host();
        return;
    }

    // Configuration data port. Accesses wider than a byte are one config
    // access each, so that registers keep their access-width semantics.
    const data_port = offset => this.pci_addr32[0] + offset | 0;
    cpu.io.register_read(PCI_CONFIG_DATA, this,
        () => this.config_read_cf8(data_port(0), 1),
        () => this.config_read_cf8(data_port(0), 2),
        () => this.config_read_cf8(data_port(0), 4));
    cpu.io.register_read(PCI_CONFIG_DATA + 1, this,
        () => this.config_read_cf8(data_port(1), 1));
    cpu.io.register_read(PCI_CONFIG_DATA + 2, this,
        () => this.config_read_cf8(data_port(2), 1),
        () => this.config_read_cf8(data_port(2), 2));
    cpu.io.register_read(PCI_CONFIG_DATA + 3, this,
        () => this.config_read_cf8(data_port(3), 1));

    cpu.io.register_write(PCI_CONFIG_DATA, this,
        value => this.config_write_cf8(data_port(0), 1, value),
        value => this.config_write_cf8(data_port(0), 2, value),
        value => this.config_write_cf8(data_port(0), 4, value));
    cpu.io.register_write(PCI_CONFIG_DATA + 1, this,
        value => this.config_write_cf8(data_port(1), 1, value));
    cpu.io.register_write(PCI_CONFIG_DATA + 2, this,
        value => this.config_write_cf8(data_port(2), 1, value),
        value => this.config_write_cf8(data_port(2), 2, value));
    cpu.io.register_write(PCI_CONFIG_DATA + 3, this,
        value => this.config_write_cf8(data_port(3), 1, value));

    // Configuration address register: reads return what was written (bits
    // 1:0 are zero). Byte and word writes update the corresponding bytes; a
    // byte access to 0xCF9 is the reset control register instead.
    cpu.io.register_read_consecutive(PCI_CONFIG_ADDRESS, this,
        () => this.pci_addr[0],
        () => this.pci_addr[1],
        () => this.pci_addr[2],
        () => this.pci_addr[3]);
    cpu.io.register_write_consecutive(PCI_CONFIG_ADDRESS, this,
        out_byte => { this.pci_addr[0] = out_byte & 0xFC; },
        out_byte => { this.pci_addr[1] = out_byte; },
        out_byte => { this.pci_addr[2] = out_byte; },
        out_byte => { this.pci_addr[3] = out_byte; });

    // PIIX/ICH9 reset control register (RCR): byte accesses to 0xCF9 only; word and
    // dword accesses at 0xCF8 are the configuration address. A 0 -> 1
    // transition of RST_CPU (bit 2) resets the machine (the FADT reset
    // register writes 0x06; Linux' reboot=pci writes 0x02, then 0x06).
    this.reset_control = 0;
    cpu.io.register_read(RESET_PORT, this, function()
    {
        return this.reset_control;
    });
    cpu.io.register_write(RESET_PORT, this, function(value)
    {
        const rst_cpu_rising = ~this.reset_control & value & 0x04;
        this.reset_control = value & 0x06;
        if(rst_cpu_rising)
        {
            dbg_log("CPU reboot via PIIX reset control register");
            cpu.reboot_internal("cf9");
        }
    });

    if(cpu.platform.machine === "i440fx")
    {
        this.create_i440fx();
    }
}

/**
 * The i440FX host bridge and the PIIX3 ISA bridge with its PIRQ routing
 * registers (0x60-0x63); the PIIX4 power management function is src/acpi.js
 */
PCI.prototype.create_i440fx = function()
{
    const cpu = this.cpu;

    // This needs to be set in order for seabios to not execute code outside of
    // mapped memory. While we map the BIOS into high memory, we don't allow
    // executing code there, which enables optimisations in read_imm8.
    // See [make_bios_writable_intel] in src/fw/shadow.c in seabios for details
    const PAM0 = 0x10;
    // (the ISA bridge has QEMU's subsystem in its layout; not the host
    // bridge: SeaBIOS takes it for QEMU then, and waits 5 s for something)
    const subsystem = cpu.platform.qemu_compatible ? QEMU_PCI_SUBSYSTEM : [0x00, 0x00, 0x00, 0x00];

    var host_bridge = {
        pci_id: 0,
        pci_space: [
            // 00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma] (rev 02)
            0x86, 0x80, 0x37, 0x12, 0x00, 0x00, 0x00, 0x00,  0x02, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  0x00, PAM0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        pci_bars: [],
        name: "82441FX PMC",
    };
    this.register_device(host_bridge);

    this.isa_bridge = {
        pci_id: 1 << 3,
        pci_space: [
            // 00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]
            0x86, 0x80, 0x00, 0x70, 0x07, 0x00, 0x00, 0x02, 0x00, 0x00, 0x01, 0x06, 0x00, 0x00, 0x80, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...subsystem,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        pci_bars: [],
        name: "82371SB PIIX3 ISA",
    };
    this.isa_bridge_space = this.register_device(this.isa_bridge);
    this.isa_bridge_space8 = new Uint8Array(this.isa_bridge_space.buffer);
};

/**
 * The generic host's function 00:00.0, QEMU's gpex-root ("QEMU PCIe Host
 * bridge"): its configuration as the reference's (tests/a64/linux_boot.mjs's
 * pci variant compares them)
 */
PCI.prototype.create_generic_host = function()
{
    const space = new Array(64).fill(0);
    space.splice(0, 12, 0x36, 0x1B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06);
    space.splice(0x2C, 4, 0xF4, 0x1A, 0x00, 0x11);
    this.register_device({ pci_id: 0, pci_space: space, pci_bars: [], name: "gpex-root" });
};

/** Machine reset (the generic host: every function's power-on configuration, reset_functions) */
PCI.prototype.reset = function()
{
    this.reset_control = 0;
    if(this.generic)
    {
        this.reset_functions();
    }
};

/**
 * The generic host's functions get their power-on configuration (a machine
 * reset): their BARs unassigned (where the template has them), no
 * interrupt asserted; the devices reset themselves
 */
PCI.prototype.reset_functions = function()
{
    this.devices.forEach((device, pci_id) => {
        const template = this.templates[pci_id];
        if(!device || !template) return;
        if(this.intx_levels[pci_id])
        {
            this.set_irq_level(pci_id, false);
        }
        this.device_spaces[pci_id].set(template);
        device.pci_bars.forEach((bar, i) => {
            if(bar && bar.on_move && !(template[(0x10 >> 2) + i] & 1))
            {
                this.move_memory_bar(bar, this.bar_base(template, i, bar));
            }
        });
        device.on_config_restore && device.on_config_restore();
    });
};

/**
 * Where a memory BAR's registers in `space` put it (both halves of a 64-bit one)
 * @param {!Int32Array} space
 * @param {number} bar_nr
 * @param {Object} bar
 * @return {number}
 */
PCI.prototype.bar_base = function(space, bar_nr, bar)
{
    const low = (space[(0x10 >> 2) + bar_nr] & ~0xF) >>> 0;
    return bar.bits64 ? (space[(0x10 >> 2) + bar_nr + 1] >>> 0) * 0x100000000 + low : low;
};

PCI.prototype.get_state = function()
{
    var state = [];

    for(var i = 0; i < 256; i++)
    {
        state[i] = this.device_spaces[i];
    }

    state[256] = this.pci_addr;
    state[257] = this.pci_value;
    state[258] = this.pci_response;
    state[259] = this.pci_status;
    state[260] = this.reset_control;
    // functions behind bus 0 (bdf >= 256)
    state[261] = this.device_spaces.map((space, bdf) => bdf >= 256 && space ? [bdf, space] : undefined).filter(e => e);
    // levels and routed lines of the interrupt pins
    state[262] = this.intx_levels.map((level, pci_id) => level ? pci_id : -1).filter(id => id >= 0);
    state[263] = this.asserted_irq_lines.map((irq, pci_id) => irq === undefined ? undefined : [pci_id, irq]).filter(e => e);
    state[264] = this.asserted_gsis.map((gsi, pci_id) => gsi === undefined ? undefined : [pci_id, gsi]).filter(e => e);
    // functions of empty or switched-off hot plug slots
    state[265] = this.absent.map((absent, pci_id) => absent ? pci_id : -1).filter(id => id >= 0);

    return state;
};

PCI.prototype.set_state = function(state)
{
    const spaces = [];
    for(var i = 0; i < 256; i++)
    {
        spaces.push([i, state[i]]);
    }
    for(const [bdf, space] of state[261] || [])
    {
        spaces.push([bdf, space]);
    }

    for(const [bdf, space] of spaces)
    {
        var device = this.devices[bdf];

        if(!device || !space)
        {
            if(device)
            {
                dbg_log("Warning: While restoring PCI device: Device exists in current " +
                        "configuration but not in snapshot (" + device.name + ")");
            }
            if(space)
            {
                dbg_log("Warning: While restoring PCI device: Device doesn't exist in current " +
                        "configuration but does in snapshot (device " + h(bdf, 2) + ")");
            }
            continue;
        }

        for(var bar_nr = 0; bar_nr < device.pci_bars.length; bar_nr++)
        {
            var value = space[(0x10 >> 2) + bar_nr];
            var bar = device.pci_bars[bar_nr];

            // Like register_device, allow holes in a device's BAR array.
            // A saved probe value in an unimplemented slot is not an I/O BAR.
            if(!bar) continue;

            if(bar.fixed)
            {
                // Legacy devices can expose a firmware-assigned BAR without a PnP guest driver.
                // Keep the original port mapping when restoring an old snapshot.
                space[(0x10 >> 2) + bar_nr] = bar.original_bar;
                continue;
            }

            if(value & 1)
            {
                if(bar.on_move)
                {
                    if((value | 3 | bar.size - 1) !== -1)
                    {
                        this.move_io_bar(bar, value & ~3 & 0xFFFF);
                    }
                    continue;
                }
                if(bdf >= 256)
                {
                    // (mapped once the bridges are restored too, below)
                    bar.assigned = value & ~1 & 0xFFFF;
                    continue;
                }
                var from = bar.original_bar & ~1 & 0xFFFF;
                var to = value & ~1 & 0xFFFF;
                this.set_io_bars(bar, from, to);
            }
            else if(bar.on_move)
            {
                // memory: where the snapshot's guest had put it (a snapshot
                // taken mid-sizing holds the size mask, which is not a place)
                if((value | 0xF | bar.size - 1) !== -1)
                {
                    this.move_memory_bar(bar, this.bar_base(space, bar_nr, bar));
                }
            }
        }

        if(space.length === this.device_spaces[bdf].length)
        {
            this.device_spaces[bdf].set(space);
        }
        else
        {
            // (a conventional space saved for a function that now has the
            // extended one, or the reverse: the common part)
            this.device_spaces[bdf].set(space.subarray(0, Math.min(space.length, this.device_spaces[bdf].length)));
        }
        device.on_config_restore && device.on_config_restore();
    }

    this.pci_addr.set(state[256]);
    this.pci_value.set(state[257]);
    this.pci_response.set(state[258]);
    this.pci_status.set(state[259]);
    this.reset_control = state[260] === undefined ? 0 : state[260];

    this.intx_levels = [];
    this.asserted_irq_lines = [];
    this.asserted_gsis = [];
    for(const pci_id of state[262] || [])
    {
        this.intx_levels[pci_id] = true;
    }
    for(const [pci_id, irq] of state[263] || [])
    {
        this.asserted_irq_lines[pci_id] = irq;
    }
    for(const [pci_id, gsi] of state[264] || [])
    {
        this.asserted_gsis[pci_id] = gsi;
    }
    this.absent = [];
    for(const pci_id of state[265] || [])
    {
        if(this.devices[pci_id]) this.absent[pci_id] = true;
    }

    // devices behind bridges: decode and bus mastering as the restored bridges forward them
    this.devices.forEach((device, pci_id) => {
        if(pci_id >= 256) this.upstream_changed(pci_id);
    });
};

/**
 * The function addressed by a value of the configuration address register,
 * as bdf << 12 | register, or -1 when the enable bit (31) is clear
 * @param {number} address
 * @return {number}
 */
function cf8_target(address)
{
    if(address >= 0)
    {
        return -1;
    }
    return (address >> 8 & 0xFFFF) << 12 | address & 0xFF;
}

/**
 * A config access through 0xCFC-0xCFF (the low bits of the address select the byte)
 * @param {number} address configuration address register + port offset
 * @param {number} size
 * @return {number}
 */
PCI.prototype.config_read_cf8 = function(address, size)
{
    const target = cf8_target(address);
    if(target === -1)
    {
        return size === 4 ? -1 : (1 << (size << 3)) - 1;
    }
    return this.config_read(target >>> 12, target & 0xFFF, size);
};

/**
 * @param {number} address configuration address register + port offset
 * @param {number} size
 * @param {number} value
 */
PCI.prototype.config_write_cf8 = function(address, size, value)
{
    const target = cf8_target(address);
    if(target !== -1)
    {
        this.config_write(target >>> 12, target & 0xFFF, size, value);
    }
};

/**
 * The function a configuration access to bus:device.function (bdf) reaches,
 * by the bus numbers the guest gave the bridges: bus 0 is the root bus; a
 * bridge passes an access for its secondary bus to the device there (only
 * device 0 behind a PCI Express downstream port), one for a bus up to its
 * subordinate bus on to the bridges behind it.
 * @param {number} bdf
 * @return {number} the function's pci_id, or -1: nothing answers
 */
PCI.prototype.route_config = function(bdf)
{
    const bus = bdf >> 8;
    if(bus === 0)
    {
        return bdf;
    }
    for(let at = 0; ;)
    {
        let next = -1;
        for(const bridge of this.bridges_on[at] || [])
        {
            const space = this.device_spaces[bridge];
            const secondary = space[BRIDGE_SECONDARY_BUS >> 2] >> 8 & 0xFF;
            const subordinate = space[BRIDGE_SUBORDINATE_BUS >> 2] >> 16 & 0xFF;
            const behind = this.devices[bridge].pci_secondary_bus;
            if(bus === secondary)
            {
                if(this.devices[bridge].pci_express_downstream && (bdf & 0xF8))
                {
                    return -1;
                }
                const pci_id = behind << 8 | bdf & 0xFF;
                return this.device_spaces[pci_id] && !this.absent[pci_id] ? pci_id : -1;
            }
            if(bus > secondary && bus <= subordinate)
            {
                next = behind;
                break;
            }
        }
        if(next === -1)
        {
            return -1;
        }
        at = next;
    }
};

/**
 * Read 1, 2 or 4 bytes of the configuration space of the function at
 * bus:device.function (route_config). Functions that don't exist, and
 * registers beyond a function's space, read as all ones.
 * @param {number} bdf
 * @param {number} offset
 * @param {number} size
 * @return {number} unsigned for 1 and 2 bytes, a signed 32-bit value for 4
 */
PCI.prototype.config_read = function(bdf, offset, size)
{
    return this.function_read(this.route_config(bdf), offset, size);
};

/**
 * Write 1, 2 or 4 bytes to the configuration space of the function at
 * bus:device.function (route_config); see function_write
 * @param {number} bdf
 * @param {number} offset
 * @param {number} size
 * @param {number} value
 */
PCI.prototype.config_write = function(bdf, offset, size, value)
{
    this.function_write(this.route_config(bdf), offset, size, value);
};

/**
 * Read a function's configuration space by its pci_id (-1: none, all ones)
 * @param {number} pci_id
 * @param {number} offset
 * @param {number} size
 * @return {number}
 */
PCI.prototype.function_read = function(pci_id, offset, size)
{
    const space = pci_id < 0 ? undefined : this.device_spaces[pci_id];

    if(space === undefined || offset + size > space.byteLength)
    {
        return size === 4 ? -1 : (1 << (size << 3)) - 1;
    }

    let value;
    if((offset & 3) + size <= 4)
    {
        value = space[offset >> 2] >>> ((offset & 3) << 3);
    }
    else
    {
        // (straddles two dwords: assembled from bytes)
        const bytes = new Uint8Array(space.buffer, space.byteOffset);
        value = 0;
        for(let i = 0; i < size; i++)
        {
            value |= bytes[offset + i] << (i << 3);
        }
    }

    if(size === 4)
    {
        value |= 0;
    }
    else
    {
        value &= (1 << (size << 3)) - 1;
    }

    dbg_log("PCI read" + (size << 3) + " " + h(pci_id, 4) + ":" + h(offset, 3) + " -> " + h(value >>> 0) +
            " (" + this.devices[pci_id].name + ")", LOG_PCI);
    return value;
};

/**
 * Write 1, 2 or 4 bytes of a function's configuration space (by its pci_id)
 * with the semantics of the header registers, type 0 or type 1 (bridges).
 * Writes to functions that don't exist (-1), or beyond a function's space,
 * are dropped.
 * @param {number} pci_id
 * @param {number} offset
 * @param {number} size
 * @param {number} value
 */
PCI.prototype.function_write = function(pci_id, offset, size, value)
{
    const space = pci_id < 0 ? undefined : this.device_spaces[pci_id];
    const device = this.devices[pci_id];

    if(space === undefined || offset + size > space.byteLength)
    {
        return;
    }

    dbg_log("PCI write" + (size << 3) + " " + h(pci_id, 4) + ":" + h(offset, 3) + " <- " + h(value >>> 0) +
            " (" + device.name + ")", LOG_PCI);

    const bridge = device.pci_secondary_bus !== undefined;

    // BARs and the expansion ROM base (type 0): 32-bit registers
    if(bridge ? offset >= 0x10 && offset < 0x18 : offset >= 0x10 && offset < 0x28 || offset >= 0x30 && offset < 0x34)
    {
        if(size === 4 && (offset & 3) === 0)
        {
            if(offset === 0x30)
            {
                this.write_expansion_rom(device, space, value);
            }
            else
            {
                this.write_bar(device, space, offset, value);
            }
        }
        else
        {
            // (e.g. the Bochs BIOS: narrower writes leave BARs alone)
            dbg_log("Warning: PCI: Expected 32-bit write, got " + (size << 3) + "-bit (addr: " + h(offset) + ")", LOG_PCI);
        }
        return;
    }

    const bytes = new Uint8Array(space.buffer, space.byteOffset);
    const old_command = bytes[4] | bytes[5] << 8;
    let header_written = false;
    let windows_written = false;

    for(let i = 0; i < size; i++)
    {
        const o = offset + i;
        const byte = value >>> (i << 3) & 0xFF;

        if(o >= 0x40)
        {
            bytes[o] = byte;
        }
        else if(bridge && o >= 0x18)
        {
            if(o === BRIDGE_SECONDARY_STATUS + 1)
            {
                bytes[o] &= ~(byte & PCI_STATUS_RW1C >> 8);
            }
            else
            {
                const mask = BRIDGE_HEADER_WRITABLE[o];
                bytes[o] = bytes[o] & ~mask | byte & mask;
                // (the windows and the ISA enable bit decide what is forwarded)
                windows_written = windows_written || o >= BRIDGE_IO_BASE && o < 0x30 || o === BRIDGE_CONTROL;
            }
        }
        else if(o === 0x04 || o === 0x05)
        {
            const mask = PCI_COMMAND_WRITABLE >> ((o - 4) << 3) & 0xFF;
            bytes[o] = bytes[o] & ~mask | byte & mask;
        }
        else if(o === 0x06 || o === 0x07)
        {
            // status: write one to clear
            bytes[o] &= ~(byte & PCI_STATUS_RW1C >> ((o - 6) << 3));
        }
        else if(header_byte_writable(o))
        {
            bytes[o] = byte;
            header_written = true;
        }
    }

    const command = bytes[4] | bytes[5] << 8;
    if(command !== old_command)
    {
        this.command_changed(pci_id, old_command, command);
    }
    else if(windows_written)
    {
        this.bridge_changed(pci_id);
    }

    if(offset + size > 0x40 || header_written)
    {
        device.on_config_write && device.on_config_write(offset, size);
    }
};

/**
 * @param {Object} device
 * @param {!Int32Array} space
 * @param {number} offset
 * @param {number} written
 */
PCI.prototype.write_bar = function(device, space, offset, written)
{
    var bar_nr = offset - 0x10 >> 2;
    var bar = device.pci_bars[bar_nr];
    var space_addr = offset >> 2;

    dbg_log("BAR" + bar_nr + " exists=" + (bar ? "y" : "n") + " changed from " + h(space[space_addr]) + " to " +
            h(written >>> 0) + " (" + device.name + ") ", LOG_PCI);

    if(!bar)
    {
        const lower = bar_nr > 0 ? device.pci_bars[bar_nr - 1] : undefined;
        if(lower && lower.bits64)
        {
            // the upper half of a 64-bit memory BAR (P5.10)
            this.write_bar_upper(lower, space, space_addr, written);
            return;
        }
        space[space_addr] = 0;
        return;
    }

    dbg_assert(!(bar.size & bar.size - 1), "bar size should be power of 2");

    var type = space[space_addr] & 1;
    const probe = (written | 3 | bar.size - 1) === -1;

    if(probe) // size check
    {
        written = ~(bar.size - 1) | type;

        if(type === 0)
        {
            // the type and prefetchable bits are read-only and stay
            space[space_addr] = written | bar.original_bar & 0xF;
        }
    }
    else
    {
        if(type === 0)
        {
            // memory
            var original_bar = bar.original_bar;

            if(bar.on_move)
            {
                // The device decodes its memory where the guest puts it:
                // SeaBIOS assigns every BAR, and an OS may reassign them
                const base = written & ~(bar.size - 1) & ~0xF;
                space[space_addr] = base | original_bar & 0xF;
                this.move_memory_bar(bar, this.bar_base(space, bar_nr, bar));
            }
            else
            {
                if((written & ~0xF) !== (original_bar & ~0xF))
                {
                    dbg_log("Warning: Changing memory bar not supported, ignored", LOG_PCI);
                }

                // this device cannot move, keep the default
                space[space_addr] = original_bar;
            }
        }
    }

    if(type === 1)
    {
        // io
        if(bar.on_move)
        {
            // decoded by the device itself, wherever the guest puts it
            // (also among the legacy ports below 0x1000)
            space[space_addr] = written | 1;
            if(!probe)
            {
                this.move_io_bar(bar, written & ~3 & 0xFFFF);
            }
        }
        else if(bar.fixed)
        {
            // The guest may probe BAR size, but this legacy device has no PnP driver
            // to consume a relocated resource. Keep its firmware-assigned I/O range.
            space[space_addr] = (written | 3 | bar.size - 1) === -1
                ? ~(bar.size - 1) | type
                : bar.original_bar;
        }
        else if(device.pci_id >= 256)
        {
            // behind a bridge: mapped where the bridges forward it
            bar.assigned = written & ~1 & 0xFFFF;
            space[space_addr] = written | 1;
            this.update_io_bar(device.pci_id, bar);
        }
        else
        {
            var from = space[space_addr] & ~1 & 0xFFFF;
            var to = written & ~1 & 0xFFFF;
            dbg_log("io bar changed from " + h(from >>> 0, 8) +
                    " to " + h(to >>> 0, 8) + " size=" + bar.size, LOG_PCI);
            this.set_io_bars(bar, from, to);
            space[space_addr] = written | 1;
        }
    }

    dbg_log("BAR effective value: " + h(space[space_addr] >>> 0), LOG_PCI);
};

/**
 * A write to the upper half of a 64-bit memory BAR: all its bits are
 * writable but those of a size of 4 GiB or more (sizing reads them back as
 * the mask's upper half). The BAR moves unless either half holds the size
 * mask.
 * @param {Object} bar the BAR, of the register below
 * @param {!Int32Array} space
 * @param {number} space_addr
 * @param {number} written
 */
PCI.prototype.write_bar_upper = function(bar, space, space_addr, written)
{
    const mask = ~Math.floor((bar.size - 1) / 0x100000000);
    space[space_addr] = written & mask;
    const low = space[space_addr - 1];
    if(written !== -1 && (low | 0xF | bar.size - 1) !== -1)
    {
        this.move_memory_bar(bar, this.bar_base(space, space_addr - 1 - (0x10 >> 2), bar));
    }
};

/**
 * @param {Object} device
 * @param {!Int32Array} space
 * @param {number} written
 */
PCI.prototype.write_expansion_rom = function(device, space, written)
{
    dbg_log("PCI write rom address (" + device.name + ")" + " value=" + h(written >>> 0, 8), LOG_PCI);

    if(device.pci_rom_size)
    {
        if((written | 0x7FF) === (0xFFFFFFFF|0))
        {
            space[0x30 >> 2] = -device.pci_rom_size | 0;
        }
        else
        {
            space[0x30 >> 2] = device.pci_rom_address | 0;
        }
    }
    else
    {
        space[0x30 >> 2] = 0;
    }
};

/**
 * The guest changed the command register: INTx Disable takes effect here,
 * memory/I/O decode and bus mastering in devices that implement them
 * (on_command_change, is_bus_master, ...)
 * @param {number} bdf
 * @param {number} old_command
 * @param {number} command
 */
PCI.prototype.command_changed = function(bdf, old_command, command)
{
    dbg_log("PCI command " + h(bdf, 4) + ": " + h(old_command, 4) + " -> " + h(command, 4) +
            " (" + this.devices[bdf].name + ")", LOG_PCI);

    if((old_command ^ command) & PCI_COMMAND_INTX_DISABLE)
    {
        this.drive_intx(bdf, !!this.intx_levels[bdf] && !(command & PCI_COMMAND_INTX_DISABLE));
    }

    const device = this.devices[bdf];
    device.on_command_change && device.on_command_change(old_command, command);

    if(device.pci_secondary_bus !== undefined &&
        (old_command ^ command) & (PCI_COMMAND_IO | PCI_COMMAND_MEMORY | PCI_COMMAND_MASTER))
    {
        // a bridge: what it forwards changed
        this.bridge_changed(bdf);
    }
};

/**
 * @param {number} bdf
 * @return {number}
 */
PCI.prototype.get_command = function(bdf)
{
    const space = this.device_spaces[bdf];
    return space ? space[1] & 0xFFFF : 0;
};

/**
 * Whether the function may master the bus (DMA, MSI): its bus mastering is
 * enabled, and that of every bridge between it and the root bus
 * @param {number} bdf its pci_id
 */
PCI.prototype.is_bus_master = function(bdf)
{
    return (this.get_command(bdf) & PCI_COMMAND_MASTER) !== 0 && this.upstream_bus_master(bdf);
};

/**
 * Whether the bridges between a function and the root bus forward its bus
 * master requests (for functions on bus 0: yes)
 * @param {number} pci_id
 * @return {boolean}
 */
PCI.prototype.upstream_bus_master = function(pci_id)
{
    if(this.absent[pci_id])
    {
        return false;
    }
    for(let bridge = this.parent_bridge(pci_id); bridge !== -1; bridge = this.parent_bridge(bridge))
    {
        if(!(this.get_command(bridge) & PCI_COMMAND_MASTER))
        {
            return false;
        }
    }
    return true;
};

/**
 * The bridge on whose secondary bus a function is, or -1 (bus 0)
 * @param {number} pci_id
 * @return {number}
 */
PCI.prototype.parent_bridge = function(pci_id)
{
    const bridge = pci_id >= 256 ? this.bridge_for_bus[pci_id >> 8] : undefined;
    return bridge === undefined ? -1 : bridge;
};

/**
 * Whether memory accesses to [base, base + size) reach a function: the
 * bridges between it and the root bus have memory decode enabled and the
 * range within their memory or prefetchable window (for functions on bus 0:
 * yes; the function's own memory space enable is its own business)
 * @param {number} pci_id
 * @param {number} base
 * @param {number} size
 * @return {boolean}
 */
PCI.prototype.upstream_forwards_memory = function(pci_id, base, size)
{
    if(this.absent[pci_id])
    {
        return false;
    }
    const end = base + size - 1;
    for(let bridge = this.parent_bridge(pci_id); bridge !== -1; bridge = this.parent_bridge(bridge))
    {
        if(!(this.get_command(bridge) & PCI_COMMAND_MEMORY))
        {
            return false;
        }
        const bytes = this.space_bytes(bridge);
        const u16 = o => bytes[o] | bytes[o + 1] << 8;
        const u32 = o => (bytes[o] | bytes[o + 1] << 8 | bytes[o + 2] << 16 | bytes[o + 3] << 24) >>> 0;
        const memory_base = (u16(BRIDGE_MEMORY_BASE) & 0xFFF0) * 0x10000;
        const memory_limit = (u16(BRIDGE_MEMORY_LIMIT) & 0xFFF0) * 0x10000 + 0xFFFFF;
        const prefetch_base = (u16(BRIDGE_PREFETCH_BASE) & 0xFFF0) * 0x10000 + u32(BRIDGE_PREFETCH_BASE_UPPER) * 0x100000000;
        const prefetch_limit = (u16(BRIDGE_PREFETCH_LIMIT) & 0xFFF0) * 0x10000 + 0xFFFFF + u32(BRIDGE_PREFETCH_LIMIT_UPPER) * 0x100000000;
        if(!(base >= memory_base && end <= memory_limit) && !(base >= prefetch_base && end <= prefetch_limit))
        {
            return false;
        }
    }
    return true;
};

/**
 * Whether I/O accesses to [port, port + size) reach a function: the bridges
 * between it and the root bus have I/O decode enabled and the range within
 * their I/O window (with ISA enable: not the top 768 bytes of each KiB)
 * @param {number} pci_id
 * @param {number} port
 * @param {number} size
 * @return {boolean}
 */
PCI.prototype.upstream_forwards_io = function(pci_id, port, size)
{
    if(this.absent[pci_id])
    {
        return false;
    }
    const end = port + size - 1;
    for(let bridge = this.parent_bridge(pci_id); bridge !== -1; bridge = this.parent_bridge(bridge))
    {
        if(!(this.get_command(bridge) & PCI_COMMAND_IO))
        {
            return false;
        }
        const bytes = this.space_bytes(bridge);
        const io_base = (bytes[BRIDGE_IO_BASE] & 0xF0) << 8;
        const io_limit = (bytes[BRIDGE_IO_LIMIT] & 0xF0) << 8 | 0xFFF;
        if(port < io_base || end > io_limit)
        {
            return false;
        }
        if(bytes[BRIDGE_CONTROL] & BRIDGE_CONTROL_ISA && ((port & 0x300) || (end & 0x300) || end - port >= 0x100))
        {
            return false;
        }
    }
    return true;
};

/**
 * Whether a function decodes memory at [base, base + size): its memory space
 * is enabled and the bridges upstream forward the range
 * @param {number} pci_id
 * @param {number} base
 * @param {number} size
 * @return {boolean}
 */
PCI.prototype.memory_decoded = function(pci_id, base, size)
{
    return this.is_memory_enabled(pci_id) && this.upstream_forwards_memory(pci_id, base, size);
};

/**
 * @param {number} pci_id
 * @return {!Uint8Array}
 */
PCI.prototype.space_bytes = function(pci_id)
{
    const space = this.device_spaces[pci_id];
    return new Uint8Array(space.buffer, space.byteOffset, space.byteLength);
};

/**
 * A bridge's decode, bus mastering or windows changed: the functions behind
 * it (at any depth) map their I/O BARs again and hear of it
 * (on_upstream_change)
 * @param {number} bridge
 */
PCI.prototype.bridge_changed = function(bridge)
{
    dbg_log("PCI bridge " + h(bridge, 4) + " (" + this.devices[bridge].name + "): forwarding changed", LOG_PCI);
    this.devices.forEach((device, pci_id) => {
        for(let up = this.parent_bridge(pci_id); up !== -1; up = this.parent_bridge(up))
        {
            if(up === bridge)
            {
                this.upstream_changed(pci_id);
                break;
            }
        }
    });
};

/**
 * @param {number} pci_id a function behind a bridge
 */
PCI.prototype.upstream_changed = function(pci_id)
{
    const device = this.devices[pci_id];
    for(const bar of device.pci_bars)
    {
        if(bar && bar.assigned !== undefined)
        {
            this.update_io_bar(pci_id, bar);
        }
    }
    device.on_upstream_change && device.on_upstream_change();
};

/**
 * Map an I/O BAR of a function behind a bridge where it is assigned, if the
 * bridges forward it there (never over the legacy ports below 0x1000)
 * @param {number} pci_id
 * @param {Object} bar
 */
PCI.prototype.update_io_bar = function(pci_id, bar)
{
    const at = bar.assigned >= 0x1000 && bar.assigned + bar.size <= 0x10000 &&
        this.upstream_forwards_io(pci_id, bar.assigned, bar.size) ? bar.assigned : -1;
    if(at === bar.mapped)
    {
        return;
    }
    dbg_log("PCI " + h(pci_id, 4) + ": I/O BAR " + (at === -1 ? "not forwarded" : "at " + h(at, 4)) +
        " size=" + bar.size, LOG_PCI);
    const ports = this.io.ports;
    if(bar.mapped !== -1)
    {
        for(let i = 0; i < bar.size; i++)
        {
            if(ports[bar.mapped + i] === bar.entries[i]) ports[bar.mapped + i] = this.io.create_empty_entry();
        }
    }
    if(at !== -1)
    {
        for(let i = 0; i < bar.size; i++)
        {
            ports[at + i] = bar.entries[i];
        }
    }
    bar.mapped = at;
};

/** @param {number} bdf */
PCI.prototype.is_memory_enabled = function(bdf)
{
    return (this.get_command(bdf) & PCI_COMMAND_MEMORY) !== 0;
};

/** @param {number} bdf */
PCI.prototype.is_io_enabled = function(bdf)
{
    return (this.get_command(bdf) & PCI_COMMAND_IO) !== 0;
};

/**
 * After a guest write to an MSI capability (msi_capability) at cap: the
 * capability ID, next pointer, the read-only bits of message control and the
 * low two address bits keep their values; one message (multiple message
 * enable stays 0)
 * @param {number} bdf
 * @param {number} cap
 * @param {number} next
 */
PCI.prototype.msi_config_written = function(bdf, cap, next)
{
    const space = this.device_spaces[bdf];
    const bytes = new Uint8Array(space.buffer, space.byteOffset);
    bytes[cap] = PCI_CAP_MSI;
    bytes[cap + 1] = next;
    bytes[cap + 2] = bytes[cap + 2] & MSI_CONTROL_ENABLE | MSI_CONTROL_64BIT;
    bytes[cap + 3] = 0;
    bytes[cap + 4] &= ~3;
};

/**
 * @param {number} bdf
 * @param {number} cap the offset of its MSI capability
 * @return {boolean}
 */
PCI.prototype.msi_enabled = function(bdf, cap)
{
    const space = this.device_spaces[bdf];
    return space !== undefined && (new Uint8Array(space.buffer, space.byteOffset)[cap + 2] & MSI_CONTROL_ENABLE) !== 0;
};

/**
 * Signal the function's message: its data written to its address, which
 * delivers it to the local APICs. Messages to other addresses (or above 4
 * GiB) are not supported and dropped.
 * @param {number} bdf
 * @param {number} cap
 * @return {boolean} whether a local APIC accepted it
 */
PCI.prototype.msi_notify = function(bdf, cap)
{
    const space = this.device_spaces[bdf];
    const bytes = new Uint8Array(space.buffer, space.byteOffset);
    const u32 = o => (bytes[o] | bytes[o + 1] << 8 | bytes[o + 2] << 16 | bytes[o + 3] << 24) >>> 0;
    const address = u32(cap + 4), high = u32(cap + 8);
    const data = bytes[cap + 12] | bytes[cap + 13] << 8;
    if(high !== 0 || !this.cpu.apic_msi)
    {
        dbg_log("PCI " + h(bdf, 4) + ": MSI to " + h(high) + ":" + h(address) + " dropped", LOG_PCI);
        return false;
    }
    if(!this.is_bus_master(bdf))
    {
        // (a message is a memory write: bus mastering must be on, also in
        // the bridges upstream)
        return false;
    }
    return !!this.cpu.apic_msi(address | 0, data);
};

/**
 * Map the ECAM (memory-mapped configuration) window, or unmap it (base -1).
 * Offset bits 27:20 select the bus, 19:12 device and function, 11:0 the register.
 * @param {number} base
 * @param {number} size
 */
PCI.prototype.set_ecam = function(base, size)
{
    if(base === this.ecam_base && size === this.ecam_size)
    {
        return;
    }

    if(this.ecam_base !== -1)
    {
        this.io.mmap_unregister(this.ecam_base, this.ecam_size);
    }

    dbg_log("ECAM " + (base === -1 ? "disabled" : "at " + h(base >>> 0, 8) + " size " + h(size)), LOG_PCI);
    this.ecam_base = base;
    this.ecam_size = base === -1 ? 0 : size;
    // The MCH decodes the window itself, before any BAR: device memory there
    // (the VGA's frame buffer starts at 0xE0000000, where OVMF puts the
    // window) waits until the window or the BAR moves
    this.cpu.mmio_ram_reserve(base === -1 ? 0 : base, this.ecam_size);

    if(base !== -1)
    {
        // (addresses above 2 GiB arrive as negative int32s)
        const offset = addr => addr - this.ecam_base >>> 0;
        const read8 = addr => {
            const o = offset(addr);
            return this.config_read(o >>> 12, o & 0xFFF, 1);
        };
        const write8 = (addr, value) => {
            const o = offset(addr);
            this.config_write(o >>> 12, o & 0xFFF, 1, value);
        };
        const read32 = addr => {
            const o = offset(addr);
            if(o & 3)
            {
                return read8(addr) | read8(addr + 1) << 8 | read8(addr + 2) << 16 | read8(addr + 3) << 24;
            }
            return this.config_read(o >>> 12, o & 0xFFF, 4);
        };
        const write32 = (addr, value) => {
            const o = offset(addr);
            if(o & 3)
            {
                for(let i = 0; i < 4; i++) write8(addr + i, value >>> (i << 3) & 0xFF);
                return;
            }
            this.config_write(o >>> 12, o & 0xFFF, 4, value);
        };
        this.io.mmap_register(base, size, read8, write8, read32, write32);
    }
};

/**
 * The generic host's ECAM (src/virt/io.js's handler for its 256 MiB, bus
 * 0-255): offset bits 27:20 select the bus, 19:12 device and function, 11:0
 * the register; an 8-byte access is two 4-byte ones
 * @return {{name: string, read: function(number, number): (number|bigint), write: function(number, number, (number|bigint))}}
 */
PCI.prototype.ecam_handler = function()
{
    const read = (offset, width) => this.config_read(offset >>> 12, offset & 0xFFF, width);
    const write = (offset, width, value) => this.config_write(offset >>> 12, offset & 0xFFF, width, value);
    return {
        name: "pcie-ecam",
        read: (offset, width) => width === 8 ?
            BigInt(read(offset, 4) >>> 0) | BigInt(read(offset + 4, 4) >>> 0) << 32n : read(offset, width) >>> 0,
        write: (offset, width, value) => {
            if(width === 8)
            {
                write(offset, 4, Number(BigInt.asUintN(32, /** @type {bigint} */ (value))) | 0);
                write(offset + 4, 4, Number(/** @type {bigint} */ (value) >> 32n) | 0);
            }
            else
            {
                write(offset, width, /** @type {number} */ (value));
            }
        },
    };
};

/**
 * The generic host's memory window at `window_base` (src/virt/io.js's
 * handler): an access reaches the BAR that decodes all of it
 * (set_memory_decoder), at its offset in the BAR; elsewhere reads are all
 * ones and writes go nowhere, as on the reference
 * @param {number} window_base
 * @return {{name: string, read: function(number, number): (number|bigint), write: function(number, number, (number|bigint))}}
 */
PCI.prototype.window_handler = function(window_base)
{
    const find = (address, width) => {
        for(const decoder of this.memory_decoders)
        {
            if(address >= decoder.base && address + width <= decoder.base + decoder.size) return decoder;
        }
        return null;
    };
    return {
        name: "pcie-window",
        read: (offset, width) => {
            const address = window_base + offset;
            const decoder = find(address, width);
            if(decoder) return decoder.handler.read(address - decoder.base, width);
            return width === 8 ? 0xFFFFFFFFFFFFFFFFn : 2 ** (8 * width) - 1;
        },
        write: (offset, width, value) => {
            const address = window_base + offset;
            const decoder = find(address, width);
            if(decoder) decoder.handler.write(address - decoder.base, width, value);
        },
    };
};

/**
 * A memory BAR of a function on the generic host is decoded at [base, base +
 * size) by `handler` (offset in the BAR and width, as src/virt/io.js's), or
 * no longer (base -1)
 * @param {!Object} owner the BAR's device, which names the decoder
 * @param {number} base
 * @param {number} size
 * @param {Object} handler
 */
PCI.prototype.set_memory_decoder = function(owner, base, size, handler)
{
    dbg_assert(this.generic);
    this.memory_decoders = this.memory_decoders.filter(decoder => decoder.owner !== owner);
    if(base !== -1)
    {
        dbg_log("PCI memory decoded at " + h(base) + " size " + h(size) + " (" + owner.name + ")", LOG_PCI);
        this.memory_decoders.push({ owner, base, size, handler: /** @type {!Object} */ (handler) });
    }
};

PCI.prototype.register_device = function(device)
{
    dbg_assert(device.pci_id !== undefined);
    dbg_assert(device.pci_space !== undefined);
    dbg_assert(device.pci_bars !== undefined);

    var device_id = device.pci_id;

    dbg_log("PCI register bdf=" + h(device_id) + " (" + device.name + ")", LOG_PCI);

    if(this.devices[device_id])
    {
        dbg_log("warning: overwriting device " + this.devices[device_id].name + " with " + device.name, LOG_PCI);
    }
    dbg_assert(device.pci_space.length >= 64);
    dbg_assert(device_id >= 0 && device_id < 0x10000);

    // convert bytewise notation from lspci to double words; a function with
    // PCI Express extended configuration space has 4 KiB
    const config_size = device.pci_config_size || 256;
    dbg_assert(config_size === 256 || config_size === 4096);
    var space = new Int32Array(config_size >> 2);
    space.set(new Int32Array(new Uint8Array(device.pci_space).buffer));
    this.device_spaces[device_id] = space;
    this.devices[device_id] = device;
    if(device_id >= 256 || this.generic)
    {
        this.templates[device_id] = space.slice();
    }

    if((device.pci_space[0x0E] & 0x7F) === PCI_HEADER_TYPE_BRIDGE)
    {
        // a bridge: the bus behind it (pci_secondary_bus) is reached through it
        const behind = device.pci_secondary_bus;
        dbg_assert(behind > 0 && behind < 256 && this.bridge_for_bus[behind] === undefined, "PCI bridge: bad secondary bus");
        this.bridge_for_bus[behind] = device_id;
        const bus = device_id >> 8;
        this.bridges_on[bus] = (this.bridges_on[bus] || []).concat([device_id]);
    }
    dbg_assert(device_id < 256 || this.bridge_for_bus[device_id >> 8] !== undefined,
        "PCI: no bridge leads to the bus of " + device.name);

    var bar_space = space.slice(4, 10);

    for(var i = 0; i < device.pci_bars.length; i++)
    {
        var bar = device.pci_bars[i];

        if(!bar)
        {
            continue;
        }

        var bar_base = bar_space[i];
        var type = bar_base & 1;
        dbg_log("device "+ device.name +" register bar of size "+bar.size +" at " + h(bar_base), LOG_PCI);

        bar.original_bar = bar_base;
        bar.entries = [];

        if(type === 0)
        {
            // memory: the device decodes it itself (bar.on_move)
            dbg_assert(!bar.bits64 || this.generic && (bar_base & 6) === 4 && i < 5 && !device.pci_bars[i + 1],
                "PCI: a 64-bit BAR is the generic host's, of type 64-bit, and the next register its upper half");
            bar.base = this.bar_base(space, i, bar);
        }
        else if(bar.on_move)
        {
            // an I/O BAR the device decodes itself (on_move)
            bar.base = bar_base & ~3 & 0xFFFF;
        }
        else
        {
            dbg_assert(type === 1);
            var port = bar_base & ~1;

            for(var j = 0; j < bar.size; j++)
            {
                bar.entries[j] = this.io.ports[port + j];
            }

            if(device_id >= 256)
            {
                // behind a bridge: nothing reaches the ports until the
                // bridges forward them (update_io_bar)
                dbg_assert(port >= 0x1000, "PCI: I/O BAR of a device behind a bridge in the legacy ports");
                bar.assigned = port;
                bar.mapped = port;
                this.update_io_bar(device_id, bar);
            }
        }
    }

    return space;
};

/**
 * A function behind a hot plug slot comes or goes (src/pcie_root_port.js).
 * Absent, nothing reaches it: configuration cycles, its BARs (the bridges do
 * not forward to it), and it neither masters the bus (DMA, MSI) nor drives
 * its pin. Arriving `fresh` (a card plugged in, or switched on), it has its
 * power-on configuration space, its BARs where that has them, and the device
 * is reset.
 * @param {number} pci_id a function behind a bridge
 * @param {boolean} present
 * @param {boolean=} fresh
 */
PCI.prototype.set_function_present = function(pci_id, present, fresh)
{
    const device = this.devices[pci_id];
    dbg_assert(device && pci_id >= 256);
    dbg_log("PCI " + h(pci_id, 4) + " (" + device.name + "): " + (present ? "on the bus" : "off the bus"), LOG_PCI);
    if(!present && !this.absent[pci_id])
    {
        device.on_unplug && device.on_unplug();
    }
    this.absent[pci_id] = !present;
    if(present && fresh)
    {
        const template = /** @type {!Int32Array} */ (this.templates[pci_id]);
        this.device_spaces[pci_id].set(template);
        device.pci_bars.forEach((bar, i) => {
            if(!bar) return;
            const value = template[(0x10 >> 2) + i];
            if(value & 1)
            {
                if(bar.on_move) this.move_io_bar(bar, value & ~3 & 0xFFFF);
                else bar.assigned = value & ~1 & 0xFFFF;
            }
            else if(bar.on_move)
            {
                this.move_memory_bar(bar, value & ~0xF);
            }
        });
        this.intx_levels[pci_id] = false;
        device.reset && device.reset();
    }
    this.set_irq_level(pci_id, !!this.intx_levels[pci_id]);
    this.upstream_changed(pci_id);
};

/**
 * @param {Object} bar
 * @param {number} base
 */
PCI.prototype.move_memory_bar = function(bar, base)
{
    if(!bar.bits64) base >>>= 0;
    if(bar.base !== base)
    {
        dbg_log("memory bar moved from " + h(bar.base >>> 0, 8) + " to " + h(base, 8) + " size=" + h(bar.size), LOG_PCI);
        bar.base = base;
        bar.on_move(base);
    }
};

/**
 * An I/O BAR a device decodes itself moved
 * @param {Object} bar
 * @param {number} port
 */
PCI.prototype.move_io_bar = function(bar, port)
{
    if(bar.base !== port)
    {
        dbg_log("io bar (device decoded) moved from " + h(bar.base, 4) + " to " + h(port, 4) + " size=" + bar.size, LOG_PCI);
        bar.base = port;
        bar.on_move(port);
    }
};

PCI.prototype.set_io_bars = function(bar, from, to)
{
    var count = bar.size;
    dbg_log("Move io bars: from=" + h(from) + " to=" + h(to) + " count=" + count, LOG_PCI);

    var ports = this.io.ports;

    for(var i = 0; i < count; i++)
    {
        var old_entry = ports[from + i];

        if(from + i >= 0x1000)
        {
            ports[from + i] = this.io.create_empty_entry();
        }

        var entry = bar.entries[i];
        var empty_entry = ports[to + i];
        dbg_assert(entry && empty_entry);

        if(to + i >= 0x1000)
        {
            ports[to + i] = entry;
        }
    }
};

/**
 * The IRQ line that the PIIX PIRQ routing registers (0x60..0x63 of the ISA
 * bridge) currently assign to the interrupt pin of a function. Bit 7 set
 * means the PIRQ is not routed to an ISA IRQ (e.g. after a link device's _DIS).
 * @param {number} pci_id
 * @return {number}
 */
PCI.prototype.get_irq_line = function(pci_id)
{
    const root = this.root_pin(pci_id);
    return this.piix_pirq_line(root.pci_id, root.pin);
};

/**
 * PIIX3: device d's pin p (0-3) on bus 0 is wired to PIRQ (p + d - 1) & 3
 * @param {number} pci_id
 * @param {number} pin
 * @return {number}
 */
PCI.prototype.piix_pirq_line = function(pci_id, pin)
{
    var device = (pci_id >> 3) - 1 & 0xFF;
    var parent_pin = pin + device & 3;
    return this.isa_bridge_space8[0x60 + parent_pin];
};

/**
 * The function on bus 0 and its pin that a function's interrupt pin reaches:
 * crossing a bridge, INTx of device d on its secondary bus becomes the
 * bridge's INT((x + d) % 4) (the PCI-to-PCI bridge swizzle)
 * @param {number} pci_id
 * @return {{pci_id: number, pin: number}} pin 0-3 (INTA-D), -1: none
 */
PCI.prototype.root_pin = function(pci_id)
{
    const space = this.device_spaces[pci_id];
    dbg_assert(space);
    let pin = (space[0x3C >>> 2] >> 8 & 0xFF) - 1;
    if(pin < 0 || pin > 3)
    {
        return { pci_id, pin: -1 };
    }
    for(let bridge = this.parent_bridge(pci_id); bridge !== -1; bridge = this.parent_bridge(bridge))
    {
        pin = pin + (pci_id >> 3 & 0x1F) & 3;
        pci_id = bridge;
    }
    return { pci_id, pin };
};

PCI.prototype.raise_irq = function(pci_id)
{
    this.set_irq_level(pci_id, true);
};

PCI.prototype.lower_irq = function(pci_id)
{
    this.set_irq_level(pci_id, false);
};

/**
 * A function drives its interrupt pin: the interrupt status bit follows the
 * level, the line follows it unless INTx Disable is set
 * @param {number} pci_id
 * @param {boolean} level
 */
PCI.prototype.set_irq_level = function(pci_id, level)
{
    this.intx_levels[pci_id] = level;

    const space = this.device_spaces[pci_id];
    if(space)
    {
        space[1] = level ? space[1] | PCI_STATUS_INTERRUPT << 16 : space[1] & ~(PCI_STATUS_INTERRUPT << 16);
    }

    const disabled = space !== undefined && (space[1] & PCI_COMMAND_INTX_DISABLE) !== 0;
    this.drive_intx(pci_id, level && !disabled && !this.absent[pci_id]);
};

/**
 * Drive the lines the chipset connects to a function's pin: the PIC input
 * (an ISA IRQ, also seen by the IOAPIC at the same pin) and, on Q35, the
 * IOAPIC-only input
 * @param {number} pci_id
 * @param {boolean} level
 */
PCI.prototype.drive_intx = function(pci_id, level)
{
    const root = this.root_pin(pci_id);
    const route = this.irq_route(root.pci_id, root.pin);

    if(level)
    {
        var irq = route.pic;
        var previous = this.asserted_irq_lines[pci_id];

        if(irq & 0x80)
        {
            dbg_log("PCI irq of " + this.devices[pci_id].name + " not routed (PIRQ route " + h(irq) + ")", LOG_PCI);
            irq = undefined;
        }

        if(previous !== undefined && previous !== irq)
        {
            // the guest rerouted the pin while it was asserted
            this.cpu.set_shared_irq_level(previous, pci_id, false);
        }
        this.asserted_irq_lines[pci_id] = irq;

        if(irq !== undefined)
        {
            this.cpu.set_shared_irq_level(irq, pci_id, true);
        }

        const previous_gsi = this.asserted_gsis[pci_id];
        const gsi = route.gsi >= 0 ? route.gsi : undefined;
        if(previous_gsi !== undefined && previous_gsi !== gsi)
        {
            this.cpu.set_shared_gsi_level(previous_gsi, pci_id, false);
        }
        this.asserted_gsis[pci_id] = gsi;
        if(gsi !== undefined)
        {
            this.cpu.set_shared_gsi_level(gsi, pci_id, true);
        }
    }
    else
    {
        // Deassert the line that was asserted, even if the guest has changed the
        // routing since. Without a record (e.g. after restoring a state image)
        // fall back to the current routing.
        var irq = this.asserted_irq_lines[pci_id];
        if(irq === undefined)
        {
            irq = route.pic;
        }
        this.asserted_irq_lines[pci_id] = undefined;

        if(!(irq & 0x80))
        {
            this.cpu.set_shared_irq_level(irq, pci_id, false);
        }

        var gsi = this.asserted_gsis[pci_id];
        if(gsi === undefined && route.gsi >= 0)
        {
            gsi = route.gsi;
        }
        this.asserted_gsis[pci_id] = undefined;
        if(gsi !== undefined)
        {
            this.cpu.set_shared_gsi_level(gsi, pci_id, false);
        }
    }
};
