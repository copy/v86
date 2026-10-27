// The Q35 chipset: the MCH host bridge (PCI 00:00.0) with its PCI Express
// configuration window (ECAM), and the ICH9 LPC bridge (00:1f.0) with the
// power management base, the PIRQ routing and the root complex register
// block. The AHCI function (00:1f.2) is src/ahci.js, the PM I/O block that
// the LPC decodes is src/acpi.js.
//
// Register layouts: Intel 3 Series Express Chipset Family datasheet (MCH),
// Intel I/O Controller Hub 9 datasheet (LPC), and QEMU's implementation, whose
// defaults and interrupt routing the guest sees here as well:
// https://github.com/qemu/qemu/blob/v9.2.0/hw/pci-host/q35.c
// https://github.com/qemu/qemu/blob/v9.2.0/hw/isa/lpc_ich9.c
// See docs/q35.md.

import { LOG_PCI } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";
import {
    ICH9_LPC_PCI_ID, ICH9_RCBA_SIZE, QEMU_PCI_SUBSYSTEM, Q35_MCH_PCI_ID,
} from "./platform.js";

// For Types Only
import { CPU } from "./cpu.js";

// MCH configuration registers
const MCH_PCIEXBAR = 0x60;          // 64 bits: base, length (bits 2:1), enable (bit 0)
const MCH_PAM0 = 0x90;              // PAM0..PAM6: BIOS shadow attributes
const MCH_SMRAM = 0x9D;
const MCH_ESMRAMC = 0x9E;
const MCH_SMRAM_DEFAULT = 0x02;     // C_BASE_SEG = 010b (A/B segment), read-only
const SMRAM_G_SMRAME = 1 << 3;
const SMRAM_D_LCK = 1 << 4;
const SMRAM_D_CLS = 1 << 5;
const SMRAM_D_OPEN = 1 << 6;
const MCH_ESMRAMC_DEFAULT = 0x38;     // SM_CACHE, SM_L1, SM_L2: read-only ones
const ESMRAMC_T_EN = 1 << 0;
const ESMRAMC_TSEG_SZ_SHIFT = 1;      // 1, 2 or 8 MiB, or the extended size
const ESMRAMC_H_SMRAME = 1 << 7;
const ESMRAMC_WRITABLE = ESMRAMC_H_SMRAME | 3 << ESMRAMC_TSEG_SZ_SHIFT | ESMRAMC_T_EN;
// QEMU's extended TSEG: writing 0xFFFF reads back its size in MiB
const MCH_EXT_TSEG_MBYTES = 0x50;
const EXT_TSEG_QUERY = 0xFFFF;
const EXT_TSEG_MBYTES = 16;

// This needs to be set in order for seabios to not execute code outside of
// mapped memory (as for the i440FX in src/pci.js): with PAM0's "RAM present"
// bit SeaBIOS doesn't copy itself from the alias below 4 GiB.
// See [make_bios_writable_intel] in src/fw/shadow.c in seabios
const PAM0_DEFAULT = 0x10;

// LPC configuration registers
const LPC_PMBASE = 0x40;            // bits 15:7 base, bit 0 hardwired to 1
const LPC_ACPI_CNTL = 0x44;         // bit 7 ACPI_EN, bits 2:0 SCI IRQ select
const LPC_ACPI_EN = 0x80;
const LPC_PIRQA_ROUT = 0x60;        // PIRQA..D
const LPC_SIRQ_CNTL = 0x64;
const LPC_PIRQE_ROUT = 0x68;        // PIRQE..H
const LPC_PIRQ_ROUT_DISABLED = 0x80;
const LPC_GEN_PMCON_1 = 0xA0;
const GEN_PMCON_1_SMI_LOCK = 0x10;  // set once until reset: SMI_EN.GBL_SMI_EN read-only
const LPC_RCBA = 0xF0;              // bits 31:14 base, bit 0 enable

// Chipset configuration registers in the RCBA block
// Device 25..31 interrupt route: INTA..D -> PIRQ (3 bits per pin, 4 apart)
const RCBA_DIR = { 31: 0x3140, 29: 0x3144, 28: 0x3146, 27: 0x3148, 26: 0x314C, 25: 0x3150 };
const RCBA_DIR_DEFAULT = 0x3210;    // INTA -> PIRQA, ..., INTD -> PIRQD
const RCBA_GCS = 0x3410;
const RCBA_GCS_DEFAULT = 0x20;      // no reboot on TCO timeout
const RCBA_HPTC = 0x3404;
const RCBA_HPTC_ENABLED = 0x80;     // HPET address enable, address select 0: 0xFED00000

/**
 * @constructor
 * @param {CPU} cpu
 */
export function Q35(cpu)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    this.name = "q35";

    const pci = cpu.devices.pci;
    this.pci = pci;
    const qemu = cpu.platform.qemu_compatible;

    // 00:00.0 Host bridge: Intel Corporation 82G33/G31/P35/P31 Express DRAM Controller
    // (no QEMU subsystem on the host bridge: with it SeaBIOS takes the
    // machine for QEMU, as with the i440FX in src/pci.js)
    const mch_space = new Array(256).fill(0);
    mch_space.splice(0, 16, 0x86, 0x80, 0xC0, 0x29, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00);
    this.mch = {
        pci_id: Q35_MCH_PCI_ID,
        pci_space: mch_space,
        pci_bars: [],
        name: "Q35 MCH",
        on_config_write: (offset, size) => this.mch_config_written(offset, size),
        on_config_restore: () => {
            this.update_ecam();
            this.smram_locked = (this.mch_space8[MCH_SMRAM] & SMRAM_D_LCK) !== 0;
            this.smram_locked_value = this.mch_space8[MCH_SMRAM] & (SMRAM_G_SMRAME | SMRAM_D_LCK);
            this.esmramc = this.mch_space8[MCH_ESMRAMC];
            this.update_smram();
        },
    };
    /** @const @type {!Int32Array} */
    this.mch_space = pci.register_device(this.mch);
    /** @const @type {!Uint8Array} */
    this.mch_space8 = new Uint8Array(this.mch_space.buffer);

    // 00:1f.0 ISA bridge: Intel Corporation 82801IB (ICH9) LPC Interface Controller (rev 02)
    // (multi-function: the AHCI controller is function 2)
    const lpc_space = new Array(256).fill(0);
    lpc_space.splice(0, 16, 0x86, 0x80, 0x18, 0x29, 0x07, 0x00, 0x00, 0x02, 0x02, 0x00, 0x01, 0x06, 0x00, 0x00, 0x80, 0x00);
    lpc_space.splice(0x2C, 4, ...qemu ? QEMU_PCI_SUBSYSTEM : [0x00, 0x00, 0x00, 0x00]);
    this.lpc = {
        pci_id: ICH9_LPC_PCI_ID,
        pci_space: lpc_space,
        pci_bars: [],
        name: "ICH9 LPC",
        on_config_write: (offset, size) => this.lpc_config_written(offset, size),
        on_config_restore: () => {
            this.update_pm_decode();
            this.update_rcba();
            this.smi_lock = (this.lpc_space8[LPC_GEN_PMCON_1] & GEN_PMCON_1_SMI_LOCK) !== 0;
        },
    };
    /** @const @type {!Int32Array} */
    this.lpc_space = pci.register_device(this.lpc);
    /** @const @type {!Uint8Array} */
    this.lpc_space8 = new Uint8Array(this.lpc_space.buffer);

    /** The root complex register block (chipset configuration registers) */
    this.rcba = new Uint8Array(ICH9_RCBA_SIZE);
    /** Where the block is decoded, or -1 */
    this.rcba_base = -1;

    pci.irq_route = (pci_id, pin) => this.irq_route(pci_id, pin);

    this.reset();
}

/** Power-on values of the chipset registers (PCIRST#) */
Q35.prototype.reset = function()
{
    const mch = this.mch_space8;
    mch.fill(0, MCH_PCIEXBAR, MCH_PCIEXBAR + 8);
    mch.fill(0, MCH_PAM0, MCH_PAM0 + 7);
    mch[MCH_PAM0] = PAM0_DEFAULT;
    mch[MCH_SMRAM] = MCH_SMRAM_DEFAULT;
    mch[MCH_ESMRAMC] = MCH_ESMRAMC_DEFAULT;
    /** ESMRAMC as written (it is read-only once SMRAM.D_LCK is set) */
    this.esmramc = MCH_ESMRAMC_DEFAULT;
    mch[MCH_EXT_TSEG_MBYTES] = EXT_TSEG_QUERY & 0xFF;
    mch[MCH_EXT_TSEG_MBYTES + 1] = EXT_TSEG_QUERY >> 8;
    /** SMRAM.D_LCK was set: the locked bits */
    this.smram_locked = false;
    this.smram_locked_value = 0;
    this.update_smram();

    const lpc = this.lpc_space8;
    this.lpc_space[LPC_PMBASE >> 2] = 1;
    lpc[LPC_ACPI_CNTL] = 0;
    lpc.fill(LPC_PIRQ_ROUT_DISABLED, LPC_PIRQA_ROUT, LPC_PIRQA_ROUT + 4);
    lpc.fill(LPC_PIRQ_ROUT_DISABLED, LPC_PIRQE_ROUT, LPC_PIRQE_ROUT + 4);
    lpc[LPC_SIRQ_CNTL] = 0x10;
    lpc.fill(0, LPC_GEN_PMCON_1, LPC_GEN_PMCON_1 + 8); // GEN_PMCON_1..3, GEN_PMCON_LOCK
    /** GEN_PMCON_1.SMI_LOCK: SMI_EN.GBL_SMI_EN cannot be cleared */
    this.smi_lock = false;
    this.lpc_space[LPC_RCBA >> 2] = 0;

    this.rcba.fill(0);
    for(const offset of Object.values(RCBA_DIR))
    {
        this.rcba[offset] = RCBA_DIR_DEFAULT & 0xFF;
        this.rcba[offset + 1] = RCBA_DIR_DEFAULT >> 8;
    }
    this.rcba[RCBA_GCS] = RCBA_GCS_DEFAULT;
    // (the HPET, if the machine has one, is always at 0xFED00000)
    this.rcba[RCBA_HPTC] = this.cpu.platform.hpet ? RCBA_HPTC_ENABLED : 0;

    this.update_ecam();
    this.update_pm_decode();
    this.update_rcba();
};

/**
 * @param {number} offset
 * @param {number} size
 * @param {number} start
 * @param {number} end
 * @return {boolean}
 */
function touches(offset, size, start, end)
{
    return offset < end && offset + size > start;
}

/**
 * @param {number} offset
 * @param {number} size
 */
Q35.prototype.mch_config_written = function(offset, size)
{
    if(touches(offset, size, MCH_ESMRAMC, MCH_ESMRAMC + 1))
    {
        // H_SMRAME, TSEG_SZ and T_EN, until D_LCK (also when this write sets it)
        if(!this.smram_locked)
        {
            this.esmramc = this.mch_space8[MCH_ESMRAMC] & ESMRAMC_WRITABLE | MCH_ESMRAMC_DEFAULT;
        }
        this.mch_space8[MCH_ESMRAMC] = this.esmramc;
    }
    if(touches(offset, size, MCH_EXT_TSEG_MBYTES, MCH_EXT_TSEG_MBYTES + 2) &&
        (this.mch_space8[MCH_EXT_TSEG_MBYTES] | this.mch_space8[MCH_EXT_TSEG_MBYTES + 1] << 8) === EXT_TSEG_QUERY)
    {
        this.mch_space8[MCH_EXT_TSEG_MBYTES] = EXT_TSEG_MBYTES & 0xFF;
        this.mch_space8[MCH_EXT_TSEG_MBYTES + 1] = EXT_TSEG_MBYTES >> 8;
    }
    if(touches(offset, size, MCH_SMRAM, MCH_ESMRAMC + 1))
    {
        // C_BASE_SEG is read-only; once D_LCK is set, D_OPEN, G_SMRAME and
        // D_LCK are too (until a reset), and D_OPEN is clear
        let value = this.mch_space8[MCH_SMRAM] & ~7 | MCH_SMRAM_DEFAULT;
        if(this.smram_locked)
        {
            value = value & ~(SMRAM_D_OPEN | SMRAM_G_SMRAME | SMRAM_D_LCK) | this.smram_locked_value;
        }
        if(value & SMRAM_D_LCK)
        {
            value &= ~SMRAM_D_OPEN;
            this.smram_locked = true;
            this.smram_locked_value = value & (SMRAM_G_SMRAME | SMRAM_D_LCK);
        }
        this.mch_space8[MCH_SMRAM] = value;
        this.update_smram();
    }
    if(touches(offset, size, MCH_PCIEXBAR, MCH_PCIEXBAR + 8))
    {
        this.update_ecam();
    }
};

/**
 * The CPU's view of SMRAM (src/rust/cpu/smm.rs): compatible SMRAM is RAM at
 * 0xA0000-0xBFFFF in SMM with G_SMRAME (with D_CLS, for instruction fetches
 * only), and always with D_OPEN; with H_SMRAME, the same RAM is at
 * 0xFEDA0000-0xFEDBFFFF instead (high SMRAM). TSEG (T_EN with G_SMRAME), the
 * top of the RAM below 4 GiB, is RAM in SMM only. As in QEMU: TSEG_SZ 11 is
 * the extended size (EXT_TSEG_MBYTES).
 */
Q35.prototype.update_smram = function()
{
    const smram = this.mch_space8[MCH_SMRAM];
    const esmramc = this.mch_space8[MCH_ESMRAMC];
    this.cpu.smram_set_control && this.cpu.smram_set_control(
        (smram & SMRAM_G_SMRAME ? 1 : 0) | (smram & SMRAM_D_OPEN ? 2 : 0) |
        (esmramc & ESMRAMC_H_SMRAME ? 4 : 0) | (smram & SMRAM_D_CLS ? 8 : 0));
    const top = this.cpu.low_memory_size;
    let size = 0;
    if(esmramc & ESMRAMC_T_EN && smram & SMRAM_G_SMRAME)
    {
        size = Math.min(top, [1, 2, 8, EXT_TSEG_MBYTES][esmramc >> ESMRAMC_TSEG_SZ_SHIFT & 3] << 20);
    }
    this.cpu.smram_set_tseg && this.cpu.smram_set_tseg(top - size, top);
};

/** Map the ECAM window where PCIEXBAR puts it, or unmap it */
Q35.prototype.update_ecam = function()
{
    const low = this.mch_space[MCH_PCIEXBAR >> 2] >>> 0;
    const high = this.mch_space[MCH_PCIEXBAR + 4 >> 2] >>> 0;

    if(!(low & 1))
    {
        this.pci.set_ecam(-1, 0);
        return;
    }

    // length 00b: 256 MiB (256 buses), 01b: 128 MiB, 10b: 64 MiB
    const length = low >> 1 & 3;
    const size = length === 1 ? 128 << 20 : length === 2 ? 64 << 20 : 256 << 20;
    const base = (low & ~(size - 1)) >>> 0;

    if(high & 0xF)
    {
        // (v86's memory map ends at 4 GiB; firmware puts it below)
        dbg_log("Q35: ECAM above 4 GiB is not supported, disabled", LOG_PCI);
        this.pci.set_ecam(-1, 0);
        return;
    }
    if(base < this.cpu.memory_size[0])
    {
        dbg_log("Q35: ECAM at " + h(base, 8) + " overlaps RAM, disabled", LOG_PCI);
        this.pci.set_ecam(-1, 0);
        return;
    }

    this.pci.set_ecam(base, size);
};

/**
 * @param {number} offset
 * @param {number} size
 */
Q35.prototype.lpc_config_written = function(offset, size)
{
    if(touches(offset, size, LPC_PMBASE, LPC_ACPI_CNTL + 1))
    {
        this.update_pm_decode();
    }
    if(touches(offset, size, LPC_PIRQA_ROUT, LPC_PIRQA_ROUT + 4) || touches(offset, size, LPC_PIRQE_ROUT, LPC_PIRQE_ROUT + 4))
    {
        for(let i = 0; i < 4; i++)
        {
            // bit 7: not routed, bits 3:0: ISA IRQ
            this.lpc_space8[LPC_PIRQA_ROUT + i] &= 0x8F;
            this.lpc_space8[LPC_PIRQE_ROUT + i] &= 0x8F;
        }
        this.reroute_pins();
    }
    if(touches(offset, size, LPC_RCBA, LPC_RCBA + 4))
    {
        this.update_rcba();
    }
    if(touches(offset, size, LPC_GEN_PMCON_1, LPC_GEN_PMCON_1 + 1))
    {
        // SMI_LOCK stays set until the platform's reset (OVMF sets it, then
        // checks that GBL_SMI_EN no longer clears)
        if(this.smi_lock) this.lpc_space8[LPC_GEN_PMCON_1] |= GEN_PMCON_1_SMI_LOCK;
        this.smi_lock = (this.lpc_space8[LPC_GEN_PMCON_1] & GEN_PMCON_1_SMI_LOCK) !== 0;
    }
};

/**
 * Decode the ICH9 PM I/O block at PMBASE once ACPI_EN is set. The SCI IRQ
 * select (ACPI_CNTL bits 2:0) is not implemented: the SCI is IRQ 9, the
 * default SeaBIOS keeps.
 */
Q35.prototype.update_pm_decode = function()
{
    // bits 31:16 and 6:1 are reserved, bit 0 is hardwired to 1
    const pmbase = this.lpc_space[LPC_PMBASE >> 2] & 0xFF80;
    this.lpc_space[LPC_PMBASE >> 2] = pmbase | 1;

    const enabled = (this.lpc_space8[LPC_ACPI_CNTL] & LPC_ACPI_EN) !== 0;
    const acpi = this.cpu.devices.acpi;
    if(acpi)
    {
        acpi.set_pm_decode(enabled && pmbase !== 0 ? pmbase : -1);
    }
};

/** Decode the root complex register block at RCBA, or stop decoding it */
Q35.prototype.update_rcba = function()
{
    const value = this.lpc_space[LPC_RCBA >> 2];
    // bits 13:1 are reserved
    this.lpc_space[LPC_RCBA >> 2] = value & ~0x3FFE;
    const base = value & 1 ? (value & ~0x3FFF) >>> 0 : -1;

    if(base === this.rcba_base)
    {
        return;
    }

    const io = this.cpu.io;
    if(this.rcba_base !== -1)
    {
        io.mmap_unregister_range(this.rcba_base, ICH9_RCBA_SIZE, this);
    }

    dbg_log("ICH9 RCBA " + (base === -1 ? "disabled" : "at " + h(base, 8)), LOG_PCI);
    this.rcba_base = base;

    if(base !== -1)
    {
        const offset = addr => addr - this.rcba_base >>> 0;
        io.mmap_register_range(base, ICH9_RCBA_SIZE, this,
            addr => this.rcba[offset(addr)],
            (addr, value) => this.rcba_write(offset(addr), value),
            addr => {
                const o = offset(addr);
                return this.rcba[o] | this.rcba[o + 1] << 8 | this.rcba[o + 2] << 16 | this.rcba[o + 3] << 24;
            },
            (addr, value) => {
                const o = offset(addr);
                for(let i = 0; i < 4; i++) this.rcba_write(o + i, value >>> (i << 3) & 0xFF);
            });
    }
};

/**
 * One byte of the chipset configuration registers: storage, except that the
 * device 25-31 interrupt routes take effect
 * @param {number} offset
 * @param {number} value
 */
Q35.prototype.rcba_write = function(offset, value)
{
    this.rcba[offset] = value;
    if(offset >= 0x3140 && offset < 0x3154)
    {
        this.reroute_pins();
    }
};

/**
 * Where interrupt pin (0-3: INTA-D) of a function on bus 0 goes: QEMU's Q35
 * wiring. Devices 0-24: INTA-D rotate over PIRQE-H; 25-31: the DxxIR route
 * registers (default: INTA-D -> PIRQA-D; the root ports' secondary buses
 * arrive here through device 28's); PIRQn is IOAPIC input 16 + n, and the
 * ISA IRQ in its routing register for the PIC.
 * @param {number} pci_id
 * @param {number} pin
 * @return {{pic: number, gsi: number}}
 */
Q35.prototype.irq_route = function(pci_id, pin)
{
    if(pin < 0 || pin > 3 || pci_id >= 256)
    {
        return { pic: LPC_PIRQ_ROUT_DISABLED, gsi: -1 };
    }

    const slot = pci_id >> 3;
    let pirq;
    if(slot <= 24)
    {
        pirq = 4 + (slot + pin) % 4;
    }
    else if(RCBA_DIR[slot] !== undefined)
    {
        const offset = RCBA_DIR[slot];
        const route = this.rcba[offset] | this.rcba[offset + 1] << 8;
        pirq = route >> (pin << 2) & 7;
    }
    else
    {
        // device 30 (a DMI-to-PCI bridge on real hardware): PIRQE-H
        pirq = 4 + pin;
    }

    const rout = this.lpc_space8[pirq < 4 ? LPC_PIRQA_ROUT + pirq : LPC_PIRQE_ROUT + pirq - 4];
    return { pic: rout & LPC_PIRQ_ROUT_DISABLED ? LPC_PIRQ_ROUT_DISABLED : rout & 0x0F, gsi: 16 + pirq };
};

/** The routing changed: pins that are asserted move to their new lines */
Q35.prototype.reroute_pins = function()
{
    const pci = this.pci;
    pci.intx_levels.forEach((level, pci_id) => {
        if(level)
        {
            const disabled = (pci.get_command(pci_id) & 1 << 10) !== 0;
            pci.drive_intx(pci_id, !disabled);
        }
    });
};

Q35.prototype.get_state = function()
{
    const state = [];
    state[0] = this.rcba;
    return state;
};

Q35.prototype.set_state = function(state)
{
    this.rcba.set(state[0]);
    // (PCI restores the configuration, and with it the decodes, separately)
};
