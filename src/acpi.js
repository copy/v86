// ACPI fixed hardware: the PIIX4 power management function (PCI 00:07.0) of
// the i440FX machine, or the power management of the ICH9 LPC (Q35).
//
// PIIX4: the PM I/O block (PM1 event and control registers, PM timer) is
// decoded at the base the firmware writes to PMBA (PCI config 0x40) once
// PMREGMISC (0x80) enables it; with v86's own ACPI tables SeaBIOS uses 0x600.
// The GPE0 block is fixed at 0xAFE0 (as in QEMU), SMI_CMD is 0xB2 with
// ACPI_ENABLE = 0xF1 and ACPI_DISABLE = 0xF0.
// ICH9: the LPC function (src/q35.js) decodes the 128-byte block at PMBASE
// (LPC config 0x40) once ACPI_EN (config 0x44 bit 7) is set and tells this
// device (set_pm_decode). GPE0 is part of the block (+0x20, 16 bytes), SMI_EN
// is at +0x30, SMI_CMD values are QEMU's 0x02/0x03. The SCI is IRQ 9 on both
// (src/platform.js describes the layouts).
//
// Register semantics: ACPI 6.6, section 4.8 (fixed hardware registers)
// https://uefi.org/specs/ACPI/6.6/04_ACPI_Hardware_Specification.html

import { LOG_ACPI } from "../src/const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";
import { ICH9_PM_TCO, ICH9_TCO_LENGTH, SMI_TCO, TCO } from "./ich9_tco.js";
import {
    ACPI_SCI_IRQ, ACPI_SMI_CMD_PORT, QEMU_PCI_SUBSYSTEM, pci_functions,
} from "./platform.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";
import { Platform } from "./platform.js";

/** Source id of the SCI on its (possibly shared) IRQ line; PCI functions use their pci_id */
export const ACPI_SCI_SOURCE = 0x100;

// PIIX4 PM function configuration registers
const PCI_PMBA = 0x40; // PM base address, bits 15:6; bit 0 reads as 1 (I/O space)
const PCI_PMREGMISC = 0x80; // bit 0: PM I/O space enable

export const PM_TIMER_TICKS_PER_MS = 3579545 / 1000;
// TMR_STS is set whenever bit 23 of the 24-bit timer changes
const PM_TIMER_STATUS_PERIOD = 1 << 23;

// PM1_STS and PM1_EN bits
const TMR = 1 << 0;
const BM = 1 << 4;
const GBL = 1 << 5;
const PWRBTN = 1 << 8;
const SLPBTN = 1 << 9;
const RTC = 1 << 10;
const WAK = 1 << 15;

const PM1_STS_MASK = TMR | BM | GBL | PWRBTN | SLPBTN | RTC | WAK;
const PM1_EN_MASK = TMR | GBL | PWRBTN | SLPBTN | RTC;

// PM1_CNT bits
const SCI_EN = 1 << 0;
const BM_RLS = 1 << 1;
const SLP_TYP_SHIFT = 10;
const SLP_TYP = 7 << SLP_TYP_SHIFT;
const SLP_EN = 1 << 13;

// SCI_EN belongs to the hardware (changed through SMI_CMD, preserved by
// OSPM); GBL_RLS and SLP_EN are write-only and read as zero
const PM1_CNT_WRITABLE = BM_RLS | SLP_TYP;

// PIIX4 GLBCTL: SeaBIOS sets SMI_EN in it. Without SMM it is plain storage.
const PM_GLBCTL = 0x28;
// ICH9 SMI_EN and SMI_STS: SeaBIOS reads SMI_EN to decide whether to set up
// SMM and then sets APMC_EN/GLB_SMI_EN. Without SMM they are plain storage.
const ICH9_PM_SMI_EN = 0x30;
const ICH9_PM_SMI_STS = 0x34;
/** SMI_EN.APMC_EN and SMI_STS.APM_STS: SMIs from writes to the APM control port */
const ICH9_SMI_APM = 1 << 5;
const APM_STS_PORT = 0xB3;

const STATE_FORMAT = 3;

// CMOS shutdown status byte: 0xFE tells SeaBIOS to resume from S3
const CMOS_SHUTDOWN_STATUS = 0x0F;
const CMOS_SHUTDOWN_S3_RESUME = 0xFE;

/**
 * Contents of the fw_cfg file etc/system-states, read by SeaBIOS's ACPI
 * builder: indexed by sleep state, bit 7 = advertised, bits 0-6 = SLP_TYP.
 * @param {Platform} platform
 * @return {!Uint8Array}
 */
export function acpi_system_states_file(platform)
{
    const states = new Uint8Array(6);
    states[0] = 0x80;
    for(const { state, slp_typ, supported } of platform.sleep_states)
    {
        states[state] = (supported ? 0x80 : 0) | slp_typ;
    }
    return states;
}

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function ACPI(cpu, bus)
{
    /** @type {CPU} */
    this.cpu = cpu;

    /** @const */
    this.bus = bus;

    /**
     * Time in milliseconds for port reads and snapshots. timer() gets the
     * same time from the main loop. Tests may replace it.
     * @type {function():number}
     */
    this.clock = () => this.cpu.clock.now();

    /** @const @type {Platform} */
    this.platform = /** @type {Platform} */ (cpu.platform);

    /** PIIX4 (with its own PCI function) or ICH9 (decoded by the LPC) */
    this.ich9 = this.platform.machine === "q35";

    /** @const */
    this.pm_length = this.platform.pm.length;

    /** @type {Int32Array} PIIX4: the PM function's configuration space */
    this.pci_config = null;

    if(!this.ich9)
    {
        // (QEMU's: revision 3 and its subsystem)
        const qemu = cpu.platform.qemu_compatible;
        const acpi = {
            pci_id: pci_functions(cpu.platform).acpi_pm,
            pci_space: [
                0x86, 0x80, 0x13, 0x71, 0x07, 0x00, 0x80, 0x02, qemu ? 0x03 : 0x08, 0x00, 0x80, 0x06, 0x00, 0x00, 0x80, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...qemu ? QEMU_PCI_SUBSYSTEM : [0x00, 0x00, 0x00, 0x00],
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x01, 0x00, 0x00,
            ],
            pci_bars: [],
            name: "acpi",
            on_config_write: offset => {
                if(offset >> 2 === PCI_PMBA >> 2 || offset >> 2 === PCI_PMREGMISC >> 2)
                {
                    this.update_pm_decode();
                }
            },
            on_config_restore: () => this.update_pm_decode(),
        };

        // 00:07.0 Bridge: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)
        this.pci_config = cpu.devices.pci.register_device(acpi);
    }

    /** Base of the decoded PM I/O block, -1 while not decoded */
    this.pm_base = -1;

    this.pm1_sts = 0;
    this.pm1_en = 0;
    this.pm1_cnt = 0;
    this.gpe_sts = 0;
    this.gpe_en = 0;
    this.smi_cmd = 0;
    this.glbctl = 0;
    /** ICH9 SMI_EN and SMI_STS */
    this.smi_en = 0;
    this.smi_sts = 0;
    /** ICH9: the TCO watchdog, at PMBASE + 0x60, with SMIs if SMI_EN.TCO_EN */
    // (as in QEMU, TCO SMIs go to the bootstrap processor)
    this.tco = this.ich9 ? new TCO(cpu, () => this.raise_smi(SMI_TCO, 0)) : null;
    /** ICH9: APM status port (0xB3), a scratch register (SeaBIOS's SMM handshake) */
    this.apm_sts = 0;

    /**
     * 0 while the machine is on, otherwise the sleeping state (4 or 5) the
     * guest used to turn it off
     */
    this.soft_off = 0;

    /** 3 while the machine is suspended to RAM (S3), otherwise 0 */
    this.sleeping = 0;

    /** Level this device currently drives on the SCI line */
    this.sci_level = false;

    // The PM timer counts from 0 at power-on. timer_last keeps it monotonic,
    // timer_offset keeps it continuous across snapshots (like the TSC).
    this.timer_last = 0;
    this.timer_offset = -Math.floor(this.clock() * PM_TIMER_TICKS_PER_MS);
    this.timer_period = 0;

    /**
     * Where vCPU workers read the PM timer themselves (src/parallel):
     * the PM base, the timer offset and the timer's maximum so far, shared
     * by every thread (share_timer)
     * @type {Int32Array}
     */
    this.shared_base = null;
    /** @type {Float64Array} */
    this.shared_offset = null;
    /** @type {BigInt64Array} */
    this.shared_last = null;

    const io = cpu.io;
    this.reset_pm_config();
    if(!this.ich9)
    {
        // (ICH9's GPE0 block is part of the PM block)
        this.register_block(io, this.platform.pm.gpe0_base, this.platform.pm.gpe0_length, this.gpe_read, this.gpe_write);
    }

    io.register_read(ACPI_SMI_CMD_PORT, this,
        () => this.smi_cmd,
        () => this.smi_cmd,
        () => this.smi_cmd);
    io.register_write(ACPI_SMI_CMD_PORT, this,
        value => this.smi_cmd_write(value & 0xFF),
        value => this.smi_cmd_write(value & 0xFF),
        value => this.smi_cmd_write(value & 0xFF));
    if(this.ich9)
    {
        io.register_read(APM_STS_PORT, this, () => this.apm_sts);
        io.register_write(APM_STS_PORT, this, value => { this.apm_sts = value & 0xFF; });
    }
}

/**
 * Registers every access width on every port of a register block. Accesses
 * wider than a byte are handled as one access, so a register read cannot tear.
 * @param {Object} io
 * @param {number} base
 * @param {number} length
 * @param {function(this:ACPI, number, number):number} read
 * @param {function(this:ACPI, number, number, number)} write
 */
ACPI.prototype.register_block = function(io, base, length, read, write)
{
    for(let offset = 0; offset < length; offset++)
    {
        io.register_read(base + offset, this,
            () => read.call(this, offset, 1),
            () => read.call(this, offset, 2),
            () => read.call(this, offset, 4));
        io.register_write(base + offset, this,
            value => write.call(this, offset, 1, value),
            value => write.call(this, offset, 2, value),
            value => write.call(this, offset, 4, value));
    }
};

/**
 * PMBA and PMREGMISC after PCIRST#: PM I/O space disabled (PIIX4; the ICH9
 * LPC resets PMBASE and ACPI_CNTL itself)
 */
ACPI.prototype.reset_pm_config = function()
{
    if(this.ich9)
    {
        return;
    }
    this.pci_config[PCI_PMBA >> 2] = 1;
    this.pci_config[PCI_PMREGMISC >> 2] &= ~0xFF;
    this.update_pm_decode();
};

/** PIIX4: move the PM I/O block to the base in PMBA, or stop decoding it */
ACPI.prototype.update_pm_decode = function()
{
    // bits 31:16 and 5:1 are reserved (zero), bit 0 is hardwired to 1
    const pmba = this.pci_config[PCI_PMBA >> 2] & 0xFFC0;
    this.pci_config[PCI_PMBA >> 2] = pmba | 1;

    const enabled = (this.pci_config[PCI_PMREGMISC >> 2] & 1) !== 0;
    this.set_pm_decode(enabled && pmba !== 0 ? pmba : -1);
};

/**
 * Decode the PM I/O block at base, or nowhere (-1). PIIX4 derives the base
 * from its configuration; on Q35 the ICH9 LPC calls this.
 * @param {number} base
 */
ACPI.prototype.set_pm_decode = function(base)
{
    if(base === this.pm_base)
    {
        return;
    }

    const io = this.cpu.io;
    if(this.pm_base !== -1)
    {
        io.unregister_range(this.pm_base, this.pm_length, this);
    }

    dbg_log("ACPI PM block " + (base === -1 ? "disabled" : "at " + h(base, 4)), LOG_ACPI);
    this.pm_base = base;
    this.publish_timer();

    if(base !== -1)
    {
        for(let port = base; port < base + this.pm_length; port++)
        {
            if(io.ports[port].device)
            {
                dbg_log("Warning: ACPI PM block at " + h(base, 4) + " overlaps " + io.ports[port].device.name, LOG_ACPI);
                break;
            }
        }
        this.register_block(io, base, this.pm_length, this.pm_read, this.pm_write);
    }
};

ACPI.prototype.pm_read = function(offset, size)
{
    let timer = 0;
    if(offset === 8)
    {
        // (the step profile's PM timer reads, docs/jit-unification-plan.md P4.0)
        const note = this.cpu.wm?.exports["step_profile_note_event"];
        if(note) note(11, 0); // step_profile::event::PM_TIMER_READ
    }
    if(offset < 12 && offset + size > 8 || offset < 2)
    {
        const ticks = this.timer_ticks(this.clock());
        timer = ticks & 0xFFFFFF;
        this.update_timer_status(ticks);
    }

    let value = 0;
    for(let i = 0; i < size; i++)
    {
        value |= this.pm_read_byte(offset + i, timer) << (i << 3);
    }
    return value;
};

ACPI.prototype.pm_read_byte = function(offset, timer)
{
    if(this.ich9)
    {
        const gpe0 = this.platform.pm.gpe0_offset;
        if(offset >= gpe0 && offset < gpe0 + this.platform.pm.gpe0_length)
        {
            return this.gpe_read(offset - gpe0, 1);
        }
        if(offset >= ICH9_PM_SMI_EN && offset < ICH9_PM_SMI_EN + 4)
        {
            return this.smi_en >>> ((offset - ICH9_PM_SMI_EN) << 3) & 0xFF;
        }
        if(offset >= ICH9_PM_SMI_STS && offset < ICH9_PM_SMI_STS + 4)
        {
            return this.smi_sts >>> ((offset - ICH9_PM_SMI_STS) << 3) & 0xFF;
        }
        if(offset >= PM_GLBCTL && offset < PM_GLBCTL + 4)
        {
            // (ICH9 has no GLBCTL here)
            return 0;
        }
        if(offset >= ICH9_PM_TCO && offset < ICH9_PM_TCO + ICH9_TCO_LENGTH)
        {
            return this.tco.read_byte(offset - ICH9_PM_TCO);
        }
    }
    switch(offset)
    {
        case 0: return this.pm1_sts & 0xFF;
        case 1: return this.pm1_sts >> 8;
        case 2: return this.pm1_en & 0xFF;
        case 3: return this.pm1_en >> 8;
        case 4: return this.pm1_cnt & 0xFF;
        case 5: return this.pm1_cnt >> 8;
        case 8: return timer & 0xFF;
        case 9: return timer >> 8 & 0xFF;
        case 10: return timer >> 16 & 0xFF;
        case PM_GLBCTL: case PM_GLBCTL + 1: case PM_GLBCTL + 2: case PM_GLBCTL + 3:
            return this.glbctl >>> ((offset - PM_GLBCTL) << 3) & 0xFF;
        default:
            // reserved, and the upper byte of the 24-bit timer
            return 0;
    }
};

ACPI.prototype.pm_write = function(offset, size, value)
{
    dbg_log("ACPI PM write" + (size << 3) + " offset=" + h(offset, 2) + " value=" + h(value >>> 0), LOG_ACPI);

    let sleep = false;

    for(let i = 0; i < size; i++)
    {
        const o = offset + i;
        const shift = (o & 1) << 3;
        const byte = value >>> (i << 3) & 0xFF;
        const bits = byte << shift;
        const byte_mask = 0xFF << shift;

        switch(o)
        {
            case 0: case 1:
                // write one to clear
                this.pm1_sts &= ~(bits & PM1_STS_MASK);
                break;
            case 2: case 3:
                this.pm1_en = (this.pm1_en & ~byte_mask | bits) & PM1_EN_MASK;
                break;
            case 4: case 5:
                this.pm1_cnt = this.pm1_cnt & ~(byte_mask & PM1_CNT_WRITABLE) | bits & PM1_CNT_WRITABLE;
                sleep = sleep || (bits & SLP_EN) !== 0;
                break;
            case PM_GLBCTL: case PM_GLBCTL + 1: case PM_GLBCTL + 2: case PM_GLBCTL + 3:
            {
                if(this.ich9)
                {
                    // (ICH9: part of GPE0)
                    this.pm_write_ich9(o, byte);
                    break;
                }
                const glbctl_shift = (o - PM_GLBCTL) << 3;
                this.glbctl = this.glbctl & ~(0xFF << glbctl_shift) | byte << glbctl_shift;
                break;
            }
            default:
                // the timer is read-only; everything else is reserved
                if(this.ich9)
                {
                    this.pm_write_ich9(o, byte);
                }
                break;
        }
    }

    this.update_sci();

    if(sleep)
    {
        this.enter_sleep_state((this.pm1_cnt & SLP_TYP) >> SLP_TYP_SHIFT);
    }
};

/**
 * ICH9 PM registers that PIIX4 doesn't have (GPE0 inside the block, SMI_EN,
 * SMI_STS); one byte
 * @param {number} offset
 * @param {number} byte
 */
ACPI.prototype.pm_write_ich9 = function(offset, byte)
{
    const gpe0 = this.platform.pm.gpe0_offset;
    if(offset >= gpe0 && offset < gpe0 + this.platform.pm.gpe0_length)
    {
        this.gpe_write(offset - gpe0, 1, byte);
    }
    else if(offset >= ICH9_PM_SMI_EN && offset < ICH9_PM_SMI_EN + 4)
    {
        const shift = (offset - ICH9_PM_SMI_EN) << 3;
        this.smi_en = (this.smi_en & ~(0xFF << shift) | byte << shift) >>> 0;
    }
    else if(offset >= ICH9_PM_SMI_STS && offset < ICH9_PM_SMI_STS + 4)
    {
        // write one to clear
        this.smi_sts = (this.smi_sts & ~(byte << ((offset - ICH9_PM_SMI_STS) << 3))) >>> 0;
    }
    else if(offset >= ICH9_PM_TCO && offset < ICH9_PM_TCO + ICH9_TCO_LENGTH)
    {
        this.tco.write_byte(offset - ICH9_PM_TCO, byte);
    }
};

/**
 * GPE0: the status bytes (write one to clear), then as many enable bytes.
 * PIIX4 has 2 + 2 bytes, ICH9 8 + 8; gpe_sts and gpe_en hold the first 32
 * bits (no GPE source above them is implemented)
 * @param {number} offset
 * @param {number} size
 * @return {number}
 */
ACPI.prototype.gpe_read = function(offset, size)
{
    const half = this.platform.pm.gpe0_length >> 1;
    let value = 0;
    for(let i = 0; i < size; i++)
    {
        const o = offset + i;
        const register = o < half ? this.gpe_sts : this.gpe_en;
        const index = o < half ? o : o - half;
        const byte = index < 4 ? register >>> (index << 3) & 0xFF : 0;
        value |= byte << (i << 3);
    }
    return size === 4 ? value | 0 : value;
};

ACPI.prototype.gpe_write = function(offset, size, value)
{
    dbg_log("ACPI GPE write" + (size << 3) + " offset=" + offset + " value=" + h(value >>> 0), LOG_ACPI);

    const half = this.platform.pm.gpe0_length >> 1;
    const bits_mask = half >= 4 ? -1 : (1 << (half << 3)) - 1;

    for(let i = 0; i < size && offset + i < this.platform.pm.gpe0_length; i++)
    {
        const o = offset + i;
        const index = o < half ? o : o - half;
        if(index >= 4)
        {
            continue;
        }
        const shift = index << 3;
        const bits = (value >>> (i << 3) & 0xFF) << shift;

        if(o < half)
        {
            // GPE0_STS: write one to clear
            this.gpe_sts = (this.gpe_sts & ~bits) & bits_mask;
        }
        else
        {
            this.gpe_en = (this.gpe_en & ~(0xFF << shift) | bits) & bits_mask;
        }
    }

    this.update_sci();
};

/**
 * Port 0xB2 (APM control). The FADT names it SMI_CMD: OSPM writes
 * ACPI_ENABLE/ACPI_DISABLE to switch SCI_EN. On real hardware this goes
 * through an SMI handler; here the device switches it (as QEMU's does). On
 * ICH9 every other value raises an SMI if SMI_EN.APMC_EN is set (SeaBIOS's
 * SMM: the SMBASE relocation, call32_smm).
 */
ACPI.prototype.smi_cmd_write = function(value)
{
    this.smi_cmd = value;

    if(value === this.platform.pm.acpi_enable)
    {
        dbg_log("ACPI enable", LOG_ACPI);
        this.pm1_cnt |= SCI_EN;
        this.update_sci();
    }
    else if(value === this.platform.pm.acpi_disable)
    {
        dbg_log("ACPI disable", LOG_ACPI);
        this.pm1_cnt &= ~SCI_EN;
        this.update_sci();
    }
    else if(this.ich9)
    {
        this.raise_smi(ICH9_SMI_APM);
    }
};

/**
 * ICH9: an SMI source fired; with its enable bit in SMI_EN, its status bit
 * in SMI_STS is set and a core enters SMM: by default the one whose port
 * access raised it (the APM control port's). (Like QEMU, SMI_EN.GBL_SMI_EN is
 * not needed: SeaBIOS does not set it.)
 * @param {number} bit
 * @param {number=} core
 */
ACPI.prototype.raise_smi = function(bit, core)
{
    if(!(this.smi_en & bit))
    {
        return;
    }
    dbg_log("SMI (SMI_STS " + h(bit, 8) + ")", LOG_ACPI);
    this.smi_sts = (this.smi_sts | bit) >>> 0;
    this.cpu.smi(core);
};

/**
 * The SCI is a level-triggered interrupt: it stays asserted while an
 * enabled fixed event or GPE is pending and SCI_EN is set.
 */
ACPI.prototype.update_sci = function()
{
    const level = (this.pm1_cnt & SCI_EN) !== 0 &&
        ((this.pm1_sts & this.pm1_en & PM1_EN_MASK) !== 0 || (this.gpe_sts & this.gpe_en) !== 0);

    if(level !== this.sci_level)
    {
        dbg_log("ACPI SCI " + (level ? "raise" : "lower"), LOG_ACPI);
        this.sci_level = level;
        this.cpu.set_shared_irq_level(ACPI_SCI_IRQ, ACPI_SCI_SOURCE, level);
    }
};

/**
 * Re-derive the SCI after the interrupt controllers were restored from a
 * snapshot: sci_level must describe the restored line, not the pre-restore one.
 */
ACPI.prototype.sync_sci = function()
{
    this.sci_level = this.cpu.shared_irq_sources[ACPI_SCI_IRQ].has(ACPI_SCI_SOURCE);
    this.update_sci();
};

ACPI.prototype.enter_sleep_state = function(slp_typ)
{
    const sleep_state = this.platform.sleep_states.find(s => s.slp_typ === slp_typ);

    if(sleep_state && sleep_state.state >= 4 && sleep_state.supported)
    {
        // S4 and S5 turn the machine off; for S4 the guest resumes from disk
        // at the next power-on
        this.power_off(sleep_state.state);
    }
    else if(sleep_state && sleep_state.state === 3 && sleep_state.supported)
    {
        this.suspend();
    }
    else
    {
        // Sleeping states that are not implemented: behave as if a wake event
        // arrived immediately, so that the guest does not wait forever
        dbg_log("ACPI: sleep type " + slp_typ + " not supported, waking up", LOG_ACPI);
        this.pm1_sts |= WAK;
    }
};

ACPI.prototype.power_off = function(sleep_state)
{
    if(this.soft_off)
    {
        return;
    }

    dbg_log("ACPI: soft off (S" + sleep_state + ")", LOG_ACPI);
    this.soft_off = sleep_state;
    // The disks are complete when the host hears of it: writes still in flight
    // (only with an embedder's asynchronous disk buffer) land first
    const cpu = this.cpu, bus = this.bus, deadline = Date.now() + 30000;
    const announce = () => {
        if(cpu["snapshot_io_pending"] && Date.now() < deadline)
        {
            setTimeout(announce, 1);
            return;
        }
        bus.send("acpi-power-off", "S" + sleep_state);
    };
    announce();
};

/**
 * S3: every core stops at the end of its current instruction and RAM is
 * kept. The device timers keep running, so an RTC alarm can wake the
 * machine; so can the power button.
 */
ACPI.prototype.suspend = function()
{
    if(this.sleeping || this.soft_off)
    {
        return;
    }
    dbg_log("ACPI: suspend to RAM (S3)", LOG_ACPI);
    this.sleeping = 3;
    this.cpu.devices.rtc.cmos_write(CMOS_SHUTDOWN_STATUS, CMOS_SHUTDOWN_S3_RESUME);
    this.cpu.enter_sleep();
    this.bus.send("acpi-sleep", "S3");
};

/**
 * Leave S3 because of a wake event (fixed event status bits, e.g. PWRBTN or
 * RTC). The CPUs and devices are reset without reloading the BIOS, so
 * SeaBIOS sees that POST already ran and resumes through the FACS waking
 * vector. WAK_STS and the cause are set after the reset.
 * @param {number} status
 * @return {boolean}
 */
ACPI.prototype.wake = function(status)
{
    if(this.sleeping !== 3)
    {
        return false;
    }
    dbg_log("ACPI: wake from S3, status " + h(status), LOG_ACPI);
    this.sleeping = 0;
    this.cpu.resume_from_sleep();
    this.pm1_sts |= WAK | status;
    this.update_sci();
    this.bus.send("acpi-wake", status & PWRBTN ? "power-button" : status & RTC ? "rtc" : "other");
    return true;
};

/** The RTC alarm fired: RTC_STS, and a wake from S3 if RTC_EN is set */
ACPI.prototype.rtc_alarm = function()
{
    if(this.sleeping)
    {
        if(this.pm1_en & RTC)
        {
            this.wake(RTC);
        }
        return;
    }
    this.pm1_sts |= RTC;
    this.update_sci();
};

/**
 * Press the power button of a running machine. The guest sees a fixed
 * power button event; with SCI_EN clear (no ACPI OS) nothing happens.
 * A suspended (S3) machine wakes up.
 */
ACPI.prototype.press_power_button = function()
{
    if(this.sleeping)
    {
        this.wake(PWRBTN);
        return;
    }
    this.pm1_sts |= PWRBTN;
    this.update_sci();
};

/** Hardware reset: the registers return to their power-on values; the PM timer keeps running */
ACPI.prototype.reset = function()
{
    this.pm1_sts = 0;
    this.pm1_en = 0;
    this.pm1_cnt = 0;
    this.gpe_sts = 0;
    this.gpe_en = 0;
    this.smi_cmd = 0;
    this.glbctl = 0;
    this.smi_en = 0;
    this.smi_sts = 0;
    this.apm_sts = 0;
    this.tco && this.tco.reset();
    this.soft_off = 0;
    this.sleeping = 0;
    this.update_sci();
    this.reset_pm_config();
};

/**
 * PM timer ticks since power-on (not truncated to 24 bits). Monotonic; it
 * advances with time only, not with the number of reads.
 * @param {number} now
 * @return {number}
 */
ACPI.prototype.timer_ticks = function(now)
{
    const ticks = Math.floor(now * PM_TIMER_TICKS_PER_MS) + this.timer_offset;

    if(this.shared_last)
    {
        // vCPU workers read the timer too: one maximum for every thread
        this.timer_last = pm_timer_shared_max(this.shared_last, ticks);
    }
    else if(ticks > this.timer_last)
    {
        this.timer_last = ticks;
    }

    return this.timer_last;
};

/**
 * Let vCPU workers read the PM timer (port PM base + 8, 32 bits) without
 * asking this thread: where the block is, the timer offset and a maximum
 * all threads share (src/parallel/vcpu.js computes the same ticks from the
 * shared machine clock). Status bits and every other register stay here.
 * @param {!Int32Array} base one word: the PM base, or -1
 * @param {!Float64Array} offset one number: timer_offset
 * @param {!BigInt64Array} last one number: the largest value read
 */
ACPI.prototype.share_timer = function(base, offset, last)
{
    this.shared_base = base;
    this.shared_offset = offset;
    this.shared_last = last;
    Atomics.store(last, 0, /** @type {?} */ (BigInt(this.timer_last)));
    this.publish_timer();
};

ACPI.prototype.publish_timer = function()
{
    if(!this.shared_base) return;
    this.shared_offset[0] = this.timer_offset;
    Atomics.store(this.shared_base, 0, this.pm_base);
};

/**
 * Raise the shared maximum to `ticks` unless it is larger already
 * @param {!BigInt64Array} last
 * @param {number} ticks
 * @return {number} the maximum
 */
export function pm_timer_shared_max(last, ticks)
{
    const value = BigInt(ticks);
    let seen = Atomics.load(last, 0);
    while(value > seen)
    {
        const previous = Atomics.compareExchange(last, 0, seen, /** @type {?} */ (value));
        if(previous === seen) return ticks;
        seen = previous;
    }
    return Number(seen);
}

ACPI.prototype.update_timer_status = function(ticks)
{
    const period = Math.floor(ticks / PM_TIMER_STATUS_PERIOD);

    if(period !== this.timer_period)
    {
        this.timer_period = period;
        this.pm1_sts |= TMR;
        this.update_sci();
    }
};

/**
 * Called from the main loop
 * @param {number} now
 * @return {number} milliseconds until this device needs to be called again
 */
ACPI.prototype.timer = function(now)
{
    const ticks = this.timer_ticks(now);
    this.update_timer_status(ticks);
    const tco = this.tco ? this.tco.timer(now) : 100;

    if((this.pm1_en & TMR) && (this.pm1_cnt & SCI_EN))
    {
        const next = (this.timer_period + 1) * PM_TIMER_STATUS_PERIOD;
        return Math.min(100, tco, (next - ticks) / PM_TIMER_TICKS_PER_MS);
    }

    return tco;
};

ACPI.prototype.get_state = function()
{
    const state = [];
    state[0] = this.pm1_cnt;
    state[1] = this.pm1_sts;
    state[2] = this.pm1_en;
    // GPE0 status bytes, then enable bytes (PIIX4: 2 + 2, ICH9: 8 + 8)
    const half = this.platform.pm.gpe0_length >> 1;
    state[3] = new Uint8Array(half << 1);
    for(let i = 0; i < Math.min(half, 4); i++)
    {
        state[3][i] = this.gpe_sts >>> (i << 3) & 0xFF;
        state[3][half + i] = this.gpe_en >>> (i << 3) & 0xFF;
    }
    state[4] = STATE_FORMAT;
    state[5] = this.timer_ticks(this.clock());
    state[6] = this.timer_period;
    state[7] = this.smi_cmd;
    state[8] = this.glbctl;
    state[9] = this.soft_off;
    state[10] = this.sleeping;
    state[11] = this.smi_en;
    state[12] = this.smi_sts;
    state[13] = this.tco ? this.tco.get_state() : null;
    state[14] = this.apm_sts;
    return state;
};

ACPI.prototype.set_state = function(state)
{
    const gpe = state[3];
    const gpe_half = gpe.length >> 1;
    const gpe_bytes = (start) => {
        let value = 0;
        for(let i = 0; i < Math.min(gpe_half, 4); i++) value |= gpe[start + i] << (i << 3);
        return value >>> 0;
    };
    this.pm1_sts = state[1] & PM1_STS_MASK;
    this.pm1_en = state[2] & PM1_EN_MASK;
    this.gpe_en = gpe_bytes(gpe_half);
    this.smi_en = state[11] || 0;
    this.smi_sts = state[12] || 0;
    if(this.tco && state[13])
    {
        this.tco.set_state(state[13]);
    }
    this.apm_sts = state[14] || 0;

    let ticks = 0;

    if(state[4] === undefined)
    {
        // Before STATE_FORMAT 2, PM1_CNT was stored as last written (including
        // SLP_EN), the GPE bytes were raw storage (status bits the guest had
        // cleared read back as set) and the timer phase was not saved.
        this.pm1_cnt = state[0] & (SCI_EN | PM1_CNT_WRITABLE);
        this.gpe_sts = 0;
        this.smi_cmd = 0;
        this.glbctl = 0;
        this.soft_off = 0;
        this.sleeping = 0;
    }
    else
    {
        this.pm1_cnt = state[0] & (SCI_EN | PM1_CNT_WRITABLE);
        this.gpe_sts = gpe_bytes(0);
        ticks = state[5];
        this.timer_period = state[6];
        this.smi_cmd = state[7];
        this.glbctl = state[8];
        this.soft_off = state[9];
        // (format 3) suspended to RAM
        this.sleeping = state[4] >= 3 ? state[10] : 0;
    }

    this.timer_offset = ticks - Math.floor(this.clock() * PM_TIMER_TICKS_PER_MS);
    this.timer_last = ticks;
    if(this.shared_last) Atomics.store(this.shared_last, 0, /** @type {?} */ (BigInt(ticks)));
    this.publish_timer();
    if(state[4] === undefined)
    {
        this.timer_period = Math.floor(ticks / PM_TIMER_STATUS_PERIOD);
    }
    // PCI restores PMBA/PMREGMISC after this device, then on_config_restore
    // rebuilds the PM I/O mapping from the restored configuration.
    // sci_level is re-derived by sync_sci once the interrupt controllers are restored
};
