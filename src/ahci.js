// AHCI host bus adapter with SATA ports: the ICH9 AHCI function (00:1f.2) of
// the Q35 machine. Each port with a drive hosts an ATA or ATAPI device of
// src/ide.js, for which the port is the transport (IDEInterface's channel):
// the command FIS is loaded into the device's task file registers, data
// phases go through the command's PRDT, and completions become received FISes
// and interrupt status bits.
//
// Drives can be attached to and detached from the ports at runtime (hot
// plug): the guest sees the link change (PxSERR.DIAG.X/N, the PCS and PRCS
// interrupts) and finds out what is there by resetting the port.
//
// Serial ATA AHCI 1.3.1 specification:
// https://www.intel.com/content/dam/www/public/us/en/documents/technical-specifications/serial-ata-ahci-spec-rev1-3-1.pdf
// Behaviour the guests depend on (SeaBIOS rel-1.16.2 src/hw/ahci.c, Linux
// drivers/ata/libahci.c, QEMU hw/ide/ahci.c) is listed in docs/ahci.md; the
// ports, links and devices are described in docs/sata.md.

import { LOG_DISK } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { IDEInterface } from "./ide.js";
import { QEMU_PCI_SUBSYSTEM, pci_functions } from "./platform.js";
import { msi_capability } from "./pci.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const PORT_COUNT = 6;
const COMMAND_SLOTS = 32;
const ABAR_SIZE = 0x1000;
const PORT_REGISTERS = 0x100;
const PORT_REGISTERS_SIZE = 0x80;

// Generic host control
const HOST_CAP = 0x00;
const HOST_GHC = 0x04;
const HOST_IS = 0x08;
const HOST_PI = 0x0C;
const HOST_VS = 0x10;

const CAP_PSC = 1 << 13;            // partial state capable
const CAP_SSC = 1 << 14;            // slumber state capable
const CAP_SAM = 1 << 18;            // supports AHCI mode only
const CAP_ISS_GEN1 = 1 << 20;       // interface speed: Gen 1 (1.5 Gbps)
const CAP_SALP = 1 << 26;           // aggressive link power management
const CAP_SNCQ = 1 << 30;           // native command queuing
const CAP_S64A = 1 << 31;           // 64-bit addressing

const GHC_HR = 1 << 0;              // HBA reset
const GHC_IE = 1 << 1;              // interrupt enable
const GHC_AE = 1 << 31;             // AHCI enable (read-only 1: CAP.SAM)

/** AHCI 1.0, as QEMU reports it (CAP2 and BOHC exist from AHCI 1.2) */
const AHCI_VERSION = 0x00010000;

// Port registers
const PX_CLB = 0x00;
const PX_CLBU = 0x04;
const PX_FB = 0x08;
const PX_FBU = 0x0C;
const PX_IS = 0x10;
const PX_IE = 0x14;
const PX_CMD = 0x18;
const PX_TFD = 0x20;
const PX_SIG = 0x24;
const PX_SSTS = 0x28;
const PX_SCTL = 0x2C;
const PX_SERR = 0x30;
const PX_SACT = 0x34;
const PX_CI = 0x38;

// PxIS / PxIE
const IS_DHRS = 1 << 0;             // D2H register FIS received (with I)
const IS_PSS = 1 << 1;              // PIO setup FIS received (with I)
const IS_SDBS = 1 << 3;             // set device bits FIS
const IS_DPS = 1 << 5;              // descriptor processed
const IS_PCS = 1 << 6;              // port connect change (PxSERR.DIAG.X)
const IS_PRCS = 1 << 22;            // PhyRdy change (PxSERR.DIAG.N)
const IS_OFS = 1 << 24;             // overflow
const IS_IFS = 1 << 27;             // interface fatal error
const IS_HBFS = 1 << 29;            // host bus fatal error
const IS_TFES = 1 << 30;            // task file error
/** PxIS bits software can clear and PxIE bits it can set */
const IS_IMPLEMENTED = 0xFDC000FF;

// PxCMD
const CMD_ST = 1 << 0;
const CMD_SUD = 1 << 1;
const CMD_POD = 1 << 2;
const CMD_CLO = 1 << 3;
const CMD_FRE = 1 << 4;
const CMD_FR = 1 << 14;
const CMD_CR = 1 << 15;
const CMD_HPCP = 1 << 18;           // hot plug capable port
const CMD_ALPE = 1 << 26;           // aggressive link power management enable
const CMD_ASP = 1 << 27;            // aggressive slumber (else partial)
const CMD_ICC_SHIFT = 28;           // interface communication control (a request; reads 0)
/** Software-writable bits: ST, FRE, ATAPI, DLAE, ALPE, ASP (ICC is not implemented) */
const CMD_WRITABLE = CMD_ST | CMD_FRE | 1 << 24 | 1 << 25 | 1 << 26 | 1 << 27;

// PxSSTS: device present, communication established, Gen 1, active
const SSTS_DEVICE = 0x113;
// Interface power management states (PxSSTS.IPM, and the PxCMD.ICC requests)
const IPM_ACTIVE = 1;
const IPM_PARTIAL = 2;
const IPM_SLUMBER = 6;
// PxSCTL.IPM: transitions software does not allow
const SCTL_IPM_NO_PARTIAL = 1 << 8;
const SCTL_IPM_NO_SLUMBER = 2 << 8;
const SERR_DIAG_N = 1 << 16;        // PhyRdy change
const SERR_DIAG_X = 1 << 26;        // exchanged

// Command header (32 bytes) DW0
const HEADER_CFL = 0x1F;            // command FIS length in dwords
const HEADER_WRITE = 1 << 6;

// FIS types
const FIS_REG_H2D = 0x27;
const FIS_REG_D2H = 0x34;
const FIS_PIO_SETUP = 0x5F;
const FIS_SET_DEVICE_BITS = 0xA1;
const FIS_H2D_COMMAND = 0x80;       // C: command register update (else device control)

// Received FIS area
const RFIS_PIO_SETUP = 0x20;
const RFIS_D2H = 0x40;
const RFIS_SDB = 0x58;

// ATA/ATAPI
const ATA_SR_ERR = 0x01;
const ATA_SR_DRQ = 0x08;
const ATA_SR_DSC = 0x10;
const ATA_SR_DRDY = 0x40;
const ATA_SR_BSY = 0x80;
const ATA_ER_ABRT = 0x04;
const ATA_CR_SRST = 0x04;
const ATA_CMD_PACKET = 0xA0;
const ATA_CMD_READ_FPDMA_QUEUED = 0x60;
const ATA_CMD_WRITE_FPDMA_QUEUED = 0x61;
const ATA_CMD_READ_LOG_EXT = 0x2F;
const ATA_ER_IDNF = 0x10;
/** READ/WRITE DMA (EXT): their data moves by DMA once the command is set up */
const ATA_DMA_COMMANDS = new Set([0xC8, 0x25, 0xCA, 0x35]);
const ATA_READ_DMA = new Set([0xC8, 0x25]);
/** PIO commands whose data goes from the host to the device */
const ATA_PIO_OUT_COMMANDS = new Set([0x30, 0x34, 0x39, 0xC5]);

/** The MSI capability (where ICH9's is) */
const MSI_CAP = 0x80;

const STATE_FORMAT = 1;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {!Array<({buffer: ?, is_cdrom: (boolean|undefined)}|undefined)>} drives by port
 * @param {number=} pci_id the function (ICH9's 00:1f.2 by default)
 */
export function AHCIController(cpu, bus, drives, pci_id)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    /** @const @type {BusConnector} */
    this.bus = bus;
    this.name = "ahci";

    this.pci_id = pci_id === undefined ? pci_functions(cpu.platform).ahci : pci_id;
    dbg_assert(this.pci_id >= 0);

    const qemu = cpu.platform.qemu_compatible;
    // 00:1f.2 SATA controller: Intel Corporation 82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode] (rev 02)
    const space = new Array(256).fill(0);
    space.splice(0, 16, 0x86, 0x80, 0x22, 0x29, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00);
    space.splice(0x2C, 4, ...qemu ? QEMU_PCI_SUBSYSTEM : [0x86, 0x80, 0x22, 0x29]);
    space[0x06] = 0x10; // status: capabilities list
    space[0x34] = MSI_CAP;
    space.splice(MSI_CAP, 14, ...msi_capability(0));
    space[0x3D] = 1;    // INTA
    space[0x90] = 0x40; // MAP: SATA mode select = AHCI
    this.pci_space = space;
    this.pci_bars = [undefined, undefined, undefined, undefined, undefined,
        { size: ABAR_SIZE, on_move: base => this.update_decode() }];
    this.on_command_change = () => {
        this.update_decode();
        // (bus mastering was off: commands wait for it)
        this.ports.forEach(port => port.check_commands());
    };
    this.on_config_restore = () => this.update_decode();
    // (behind a bridge: its decode and bus mastering changed)
    this.on_upstream_change = () => {
        this.update_decode();
        this.ports.forEach(port => port.check_commands());
    };
    this.on_config_write = (offset, size) => {
        if(offset < MSI_CAP + 14 && offset + size > MSI_CAP)
        {
            this.cpu.devices.pci.msi_config_written(this.pci_id, MSI_CAP, 0);
            // (enabling MSI releases INTA; disabling it may need INTA)
            this.update_irq();
        }
    };

    /** @type {!Array<AHCIPort>} */
    this.ports = [];
    for(let i = 0; i < PORT_COUNT; i++)
    {
        this.ports.push(new AHCIPort(this, i, drives[i]));
    }

    this.ghc = GHC_AE;
    /** Where ABAR is decoded, or -1 */
    this.abar = -1;
    /** The level this function drives on INTA */
    this.irq_level = false;
    /** With MSI: whether an interrupt is pending (a message was sent for it) */
    this.msi_pending = false;
    /** A port set status bits since the last interrupt decision */
    this.new_event = false;

    /** @const @type {!Int32Array} */
    this.pci_config = cpu.devices.pci.register_device(this);

    this.update_decode();
}

/**
 * HBA capabilities: six ports, 32 command slots, AHCI only, Gen 1, 64-bit
 * addressing (limited by the 36-bit physical address space), native command
 * queuing, link power management (partial, slumber, aggressive).
 * @return {number}
 */
AHCIController.prototype.capabilities = function()
{
    return (PORT_COUNT - 1 | COMMAND_SLOTS - 1 << 8 | CAP_SAM | CAP_ISS_GEN1 |
        CAP_PSC | CAP_SSC | CAP_SALP |
        (this.ports[0].ncq_depth ? CAP_SNCQ : 0) | (this.s64a ? CAP_S64A : 0)) >>> 0;
};

/**
 * 64-bit addressing: the upper halves of the list, FIS, command table and data
 * addresses are used (CLBU, FBU, CTBAU, DBAU); addresses beyond guest RAM
 * fail like any address outside it
 */
AHCIController.prototype.s64a = true;

/**
 * The drive configured as hda, hdb or cdrom: a hard disk on port 0 or 1, the
 * CD drive on port 2
 * @param {string} name
 * @return {IDEInterface|undefined}
 */
AHCIController.prototype.disk_device = function(name)
{
    const port = { "hda": 0, "hdb": 1, "cdrom": 2 }[name];
    const device = port === undefined ? null : this.ports[port].device;
    return device && device.is_atapi === (name === "cdrom") ? device : undefined;
};

/** @return {!Array<!Array<?>>} [name, device] of every port with a drive */
AHCIController.prototype.disk_devices = function()
{
    return this.ports.filter(port => port.device).map(port => {
        const name = ["hda", "hdb", "cdrom"][port.number];
        return [name && this.disk_device(name) === port.device ? name : "sata" + port.number, port.device];
    });
};

/** The machine's CD drive (cpu.devices.cdrom) is the ATAPI drive on port 2 */
AHCIController.prototype.update_cdrom = function()
{
    if(this.cpu.devices.ahci === this)
    {
        this.cpu.devices.cdrom = this.disk_device("cdrom");
    }
};

/**
 * Hot plug: attach a drive to a free port. The device signals its presence
 * (COMINIT): PxSERR.DIAG.X and DIAG.N are set (PCS, PRCS), the link comes up
 * unless software holds it in reset or disabled, and the device sends its
 * signature once FIS reception is on.
 * @param {number} number the port
 * @param {{buffer: ?, is_cdrom: (boolean|undefined)}} drive
 * @return {IDEInterface}
 */
AHCIController.prototype.attach = function(number, drive)
{
    const port = this.ports[number];
    if(!port || port.device)
    {
        throw new Error("AHCI: port " + number + (port ? " already has a drive" : " does not exist"));
    }
    port.attach(drive);
    this.update_cdrom();
    this.update_irq();
    return port.device;
};

/**
 * Hot plug: remove the drive of a port (a surprise removal). The link goes
 * down, PxSERR.DIAG.N is set (PRCS); commands issued stay issued until
 * software stops the port. Disk I/O in flight completes nowhere; writes
 * already handed to the disk image land.
 * @param {number} number the port
 */
AHCIController.prototype.detach = function(number)
{
    const port = this.ports[number];
    if(!port || !port.device)
    {
        throw new Error("AHCI: port " + number + " has no drive");
    }
    port.detach();
    this.update_cdrom();
    this.update_irq();
};

/**
 * Decode ABAR (BAR5) where the guest put it while memory space is enabled
 * (and, behind a bridge, the bridges forward it)
 */
AHCIController.prototype.update_decode = function()
{
    const pci = this.cpu.devices.pci;
    const bar = this.pci_bars[5];
    const base = bar.base && pci.memory_decoded(this.pci_id, bar.base, ABAR_SIZE) ? bar.base : -1;

    if(base === this.abar)
    {
        return;
    }

    const io = this.cpu.io;
    if(this.abar !== -1)
    {
        io.mmap_unregister_range(this.abar, ABAR_SIZE, this);
    }
    dbg_log("AHCI: ABAR " + (base === -1 ? "not decoded" : "at " + h(base >>> 0, 8)), LOG_DISK);
    this.abar = base;
    if(base !== -1)
    {
        io.mmap_register_range(base, ABAR_SIZE, this,
            addr => this.read32(addr - this.abar & ~3) >>> ((addr & 3) << 3) & 0xFF,
            (addr, value) => this.write32(addr - this.abar & ~3, value << ((addr & 3) << 3), 0xFF << ((addr & 3) << 3)),
            addr => this.read32(addr - this.abar),
            (addr, value) => this.write32(addr - this.abar, value, -1));
    }
};

/** Whether the function may access memory (PCI bus mastering) */
AHCIController.prototype.can_dma = function()
{
    return this.cpu.devices.pci.is_bus_master(this.pci_id);
};

/**
 * @param {number} offset
 * @return {number}
 */
AHCIController.prototype.read32 = function(offset)
{
    offset >>>= 0;
    let value = 0;
    if(offset >= PORT_REGISTERS && offset < PORT_REGISTERS + PORT_COUNT * PORT_REGISTERS_SIZE)
    {
        const port = this.ports[offset - PORT_REGISTERS >> 7];
        value = port.read32(offset & PORT_REGISTERS_SIZE - 1);
    }
    else
    {
        switch(offset)
        {
            case HOST_CAP: value = this.capabilities(); break;
            case HOST_GHC: value = this.ghc; break;
            case HOST_IS: value = this.interrupt_status(); break;
            case HOST_PI: value = (1 << PORT_COUNT) - 1; break;
            case HOST_VS: value = AHCI_VERSION; break;
            // CCC, enclosure management, vendor specific: not implemented
        }
    }
    dbg_log("AHCI read " + h(offset, 3) + " -> " + h(value >>> 0, 8), LOG_DISK);
    return value | 0;
};

/**
 * @param {number} offset
 * @param {number} value
 * @param {number} mask the bytes written (a byte access writes one)
 */
AHCIController.prototype.write32 = function(offset, value, mask)
{
    offset >>>= 0;
    dbg_log("AHCI write " + h(offset, 3) + " <- " + h(value >>> 0, 8) + (mask === -1 ? "" : " mask " + h(mask >>> 0, 8)), LOG_DISK);
    if(offset >= PORT_REGISTERS && offset < PORT_REGISTERS + PORT_COUNT * PORT_REGISTERS_SIZE)
    {
        this.ports[offset - PORT_REGISTERS >> 7].write32(offset & PORT_REGISTERS_SIZE - 1, value & mask, mask);
        return;
    }
    switch(offset)
    {
        case HOST_GHC:
            if(value & mask & GHC_HR)
            {
                this.hba_reset();
            }
            else
            {
                this.ghc = GHC_AE | (this.ghc & ~mask | value & mask) & GHC_IE;
                this.update_irq();
            }
            break;
        case HOST_IS:
            // write one to clear: the bits follow the ports' status, as in QEMU
            this.update_irq();
            break;
    }
};

/** IS: the ports with an enabled interrupt pending */
AHCIController.prototype.interrupt_status = function()
{
    let status = 0;
    this.ports.forEach((port, i) => {
        if(port.interrupt_bits() & port.ie)
        {
            status |= 1 << i;
        }
    });
    return status;
};

/**
 * Interrupts from the ports' enabled status and GHC.IE: INTA follows the
 * level; with MSI enabled, a message is sent when an interrupt becomes
 * pending and for every new event while it is (QEMU sends one per check)
 */
AHCIController.prototype.update_irq = function()
{
    const pci = this.cpu.devices.pci;
    const pending = (this.ghc & GHC_IE) !== 0 && this.interrupt_status() !== 0;
    const msi = pci.msi_enabled(this.pci_id, MSI_CAP);
    const level = pending && !msi;
    if(level !== this.irq_level)
    {
        this.irq_level = level;
        level ? pci.raise_irq(this.pci_id) : pci.lower_irq(this.pci_id);
    }
    if(msi && pending && (!this.msi_pending || this.new_event))
    {
        pci.msi_notify(this.pci_id, MSI_CAP);
    }
    this.msi_pending = msi && pending;
    this.new_event = false;
};

/** GHC.HR: the HBA and every port return to their reset state, each link is reset (COMRESET) */
AHCIController.prototype.hba_reset = function()
{
    dbg_log("AHCI: HBA reset", LOG_DISK);
    this.ghc = GHC_AE;
    this.ports.forEach(port => port.reset(false));
    this.update_irq();
};

/** PCIRST#: as GHC.HR, and the list and FIS base addresses are cleared too */
AHCIController.prototype.reset = function()
{
    this.ghc = GHC_AE;
    this.ports.forEach(port => port.reset(true));
    this.update_irq();
};

AHCIController.prototype.get_state = function()
{
    const state = [];
    state[0] = STATE_FORMAT;
    state[1] = this.ghc;
    state[2] = this.irq_level;
    state[3] = this.ports.map(port => port.get_state());
    state[4] = this.msi_pending;
    return state;
};

AHCIController.prototype.set_state = function(state)
{
    dbg_assert(state[0] === STATE_FORMAT);
    this.ghc = state[1];
    this.irq_level = state[2];
    this.new_event = false;
    // (a drive present on one side only becomes a hot plug event, signalled
    // by update_irq once the whole machine is restored)
    this.ports.forEach((port, i) => port.set_state(state[3][i]));
    this.msi_pending = !!state[4];
    this.update_cdrom();
};

/**
 * A SATA port and the transport of its device
 * @constructor
 * @param {AHCIController} controller
 * @param {number} number
 * @param {({buffer: ?, is_cdrom: (boolean|undefined)}|undefined)} drive
 */
function AHCIPort(controller, number, drive)
{
    this.controller = controller;
    this.number = number;
    /** @const @type {CPU} */
    this.cpu = controller.cpu;
    this.bus = controller.bus;
    this.name = "ahci" + number;

    // The transport as IDEInterface sees it. channel_nr and the device's
    // interface_nr give the drive the IDE position of the same name
    // (hda: 0.0, hdb: 0.1, cdrom: 1.0) for names, serial numbers and the
    // disk activity events.
    this.channel_nr = number >> 1;
    this.cmos_geometry = false;
    this.sata = true;
    /** Native command queuing, 32 deep */
    this.ncq_depth = COMMAND_SLOTS;
    /** bit 0: the current command's DMA may run (IDEInterface checks it) */
    this.dma_status = 0;
    this.slave = null;

    /** @type {IDEInterface|null} */
    this.device = null;
    this.device = drive && (drive.buffer || drive.is_cdrom) ?
        new IDEInterface(this, number & 1, drive.buffer, !!drive.is_cdrom) : null;
    this.master = this.device;
    /**
     * PxCMD.HPCP, set by the platform: the ports without a drive at power-on
     * are the hot plug capable ones (every port supports hot plug; Windows
     * offers to eject the drives on such ports)
     * @const
     */
    this.hot_plug_capable = !this.device;

    this.clb = 0;
    this.clbu = 0;
    this.fb = 0;
    this.fbu = 0;
    this.is = 0;
    this.ie = 0;
    this.cmd = 0;
    this.tfd = 0x7F;
    this.sig = -1;
    this.ssts = 0;
    this.sctl = 0;
    this.serr = 0;
    this.sact = 0;
    this.ci = 0;

    /** The device's first D2H register FIS after a reset, sent once FIS reception is on */
    this.init_d2h_pending = false;
    /** A command failed (PxIS.TFES): nothing is issued until software clears ST */
    this.halted = false;
    /** The slot being executed, or -1 */
    this.busy_slot = -1;
    /**
     * The command being executed
     * @type {?{slot: number, header: number, table: number, prdtl: number, dma: boolean,
     *          dma_started: boolean, packet_sent: boolean, bytes: number, first_drq: boolean}}
     */
    this.command = null;
    /** Device control: SRST was set by a control FIS */
    this.srst = false;

    // Native command queuing: the tags in flight, a generation that stops
    // their completions after a stop or reset, the failed command for the
    // NCQ command error log
    this.ncq_active = 0;
    this.ncq_epoch = 0;
    /** @type {?{tag: number, error: number, lba: number, count: number}} */
    this.ncq_error = null;

    // re-entrancy of the command state machine
    this.advancing = false;
    this.advance_again = false;
    this.in_device = false;

    this.reset(true);
}

/**
 * Reset the port and its link (COMRESET): with a device, the link comes up
 * and the device sends its signature once FIS reception is on
 * @param {boolean} power_on also clear the list and FIS base addresses
 */
AHCIPort.prototype.reset = function(power_on)
{
    if(power_on)
    {
        this.clb = this.clbu = this.fb = this.fbu = 0;
    }
    this.is = 0;
    this.ie = 0;
    this.cmd = CMD_SUD | CMD_POD;
    this.sctl = 0;
    this.serr = 0;
    this.sact = 0;
    this.ci = 0;
    this.halted = false;
    this.abort_command();
    this.link_reset();
};

/** COMRESET: the device resets, the link comes up again if there is one */
AHCIPort.prototype.link_reset = function()
{
    this.tfd = 0x7F;
    this.sig = -1;
    this.srst = false;
    this.abort_command();
    if(this.device)
    {
        this.device_reset();
        this.ssts = SSTS_DEVICE;
        this.init_d2h_pending = true;
        this.send_init_d2h();
    }
    else
    {
        this.ssts = 0;
        this.init_d2h_pending = false;
    }
};

/** The device's own reset: its signature in the task file, no command */
AHCIPort.prototype.device_reset = function()
{
    const device = this.device;
    this.ncq_error = null;
    device.device_reset();
    device.current_command = -1;
    device.data_pointer = device.data_end = device.data_length = 0;
    // ready: an ATA device reports DRDY, an ATAPI device 0 ([ATA8-ACS] 9.12)
    device.status_reg = device.is_atapi ? 0 : ATA_SR_DRDY | ATA_SR_DSC;
    device.error_reg = 1; // diagnostic code: no error
};

/** The first D2H register FIS after a reset: signature and status */
AHCIPort.prototype.send_init_d2h = function()
{
    if(!this.init_d2h_pending || !(this.cmd & CMD_FRE))
    {
        return;
    }
    this.init_d2h_pending = false;
    const device = this.device;
    this.sig = (device.lba_high_reg & 0xFF) << 24 | (device.lba_mid_reg & 0xFF) << 16 |
        (device.lba_low_reg & 0xFF) << 8 | device.sector_count_reg & 0xFF;
    this.post_d2h(true);
    this.controller.update_irq();
};

/**
 * PxIS: the status bits, and PCS and PRCS, which reflect PxSERR.DIAG.X and
 * DIAG.N (they clear when those are cleared)
 * @return {number}
 */
AHCIPort.prototype.interrupt_bits = function()
{
    return (this.is | (this.serr & SERR_DIAG_X ? IS_PCS : 0) | (this.serr & SERR_DIAG_N ? IS_PRCS : 0)) >>> 0;
};

/**
 * @param {{buffer: ?, is_cdrom: (boolean|undefined)}} drive
 */
AHCIPort.prototype.attach = function(drive)
{
    this.attach_device(new IDEInterface(this, this.number & 1, drive.buffer, !!drive.is_cdrom));
};

/**
 * @param {!IDEInterface} device
 */
AHCIPort.prototype.attach_device = function(device)
{
    dbg_log("AHCI port " + this.number + ": " + (device.is_atapi ? "CD drive" : "disk") + " attached", LOG_DISK);
    this.device = device;
    this.master = device;
    // COMINIT from the device (exchanged), the PhyRdy change
    this.serr = (this.serr | SERR_DIAG_X | SERR_DIAG_N) >>> 0;
    this.controller.new_event = true;
    const det = this.sctl & 0xF;
    if(det === 4)
    {
        // the interface is disabled: offline
        this.ssts = 4;
    }
    else if(det !== 1)
    {
        // (with COMRESET asserted the link comes up when software releases it)
        this.link_reset();
    }
};

AHCIPort.prototype.detach = function()
{
    dbg_log("AHCI port " + this.number + ": drive detached", LOG_DISK);
    const device = this.device;
    // its disk I/O in flight is dropped (and the requests held after an
    // I/O error: src/block_backend.js)
    device.cancel_io_operations();
    device.drop_held_requests();
    device.reset_epoch++;
    this.device = this.master = null;
    // PhyRdy lost; no device: no link, PxTFD 7Fh, no signature
    this.serr = (this.serr | SERR_DIAG_N) >>> 0;
    this.controller.new_event = true;
    this.link_reset();
};

/**
 * Interrupt status bits the port sets (PxIS)
 * @param {number} bits
 */
AHCIPort.prototype.set_status = function(bits)
{
    this.is = (this.is | bits) >>> 0;
    this.controller.new_event = true;
};

/** Stop the command being executed; its completion, if it comes, is ignored */
AHCIPort.prototype.abort_command = function()
{
    this.command = null;
    this.busy_slot = -1;
    this.dma_status = 0;
    this.ncq_active = 0;
    this.ncq_epoch++;
};

/**
 * @param {number} offset
 * @return {number}
 */
AHCIPort.prototype.read32 = function(offset)
{
    switch(offset)
    {
        case PX_CLB: return this.clb;
        case PX_CLBU: return this.clbu;
        case PX_FB: return this.fb;
        case PX_FBU: return this.fbu;
        case PX_IS: return this.interrupt_bits();
        case PX_IE: return this.ie;
        case PX_CMD:
            return this.cmd | (this.cmd & CMD_ST ? CMD_CR : 0) | (this.cmd & CMD_FRE ? CMD_FR : 0) |
                (this.hot_plug_capable ? CMD_HPCP : 0) | (this.busy_slot === -1 ? 0 : this.busy_slot << 8);
        case PX_TFD: return this.tfd;
        case PX_SIG: return this.sig;
        case PX_SSTS: return this.ssts;
        case PX_SCTL: return this.sctl;
        case PX_SERR: return this.serr;
        case PX_SACT: return this.sact;
        case PX_CI: return this.ci;
    }
    return 0;
};

/**
 * @param {number} offset
 * @param {number} value (only the bytes in mask)
 * @param {number} mask
 */
AHCIPort.prototype.write32 = function(offset, value, mask)
{
    const merge = old => (old & ~mask | value) >>> 0;
    switch(offset)
    {
        case PX_CLB:
            // 1 KiB aligned
            this.clb = merge(this.clb) & ~0x3FF;
            break;
        case PX_CLBU:
            if(this.controller.s64a) this.clbu = merge(this.clbu);
            break;
        case PX_FB:
            // 256 bytes aligned
            this.fb = merge(this.fb) & ~0xFF;
            break;
        case PX_FBU:
            if(this.controller.s64a) this.fbu = merge(this.fbu);
            break;
        case PX_IS:
            this.is &= ~value;
            this.controller.update_irq();
            break;
        case PX_IE:
            this.ie = merge(this.ie) & IS_IMPLEMENTED;
            this.controller.update_irq();
            break;
        case PX_CMD:
            this.write_command(merge(this.cmd));
            break;
        case PX_SCTL:
        {
            const old = this.sctl;
            this.sctl = merge(this.sctl) & 0xFFF;
            const det = this.sctl & 0xF;
            if(det === 1)
            {
                // COMRESET asserted: no communication until it is released
                this.ssts = 0;
                this.abort_command();
            }
            else if((old & 0xF) === 1 && det === 0)
            {
                dbg_log("AHCI port " + this.number + ": COMRESET", LOG_DISK);
                this.link_reset();
            }
            else if(det === 4)
            {
                // the interface is disabled
                this.ssts = this.device ? 4 : 0;
            }
            break;
        }
        case PX_SERR:
            // (clearing DIAG.X and DIAG.N clears PCS and PRCS)
            this.serr &= ~value;
            this.controller.update_irq();
            break;
        case PX_SACT:
            if(this.cmd & CMD_ST) this.sact = (this.sact | value) >>> 0;
            break;
        case PX_CI:
            if(this.cmd & CMD_ST)
            {
                // (a command for the device wakes a sleeping link)
                this.ci = (this.ci | value) >>> 0;
                this.check_commands();
            }
            break;
    }
};

/**
 * PxCMD: start/stop the command list (ST) and FIS reception (FRE)
 * @param {number} value
 */
AHCIPort.prototype.write_command = function(value)
{
    const old = this.cmd;
    this.cmd = value & CMD_WRITABLE | CMD_SUD | CMD_POD;

    // ICC: move the link to active, partial or slumber (done at once: the
    // field reads as idle); not while the device has work
    const icc = value >>> CMD_ICC_SHIFT;
    if(icc === IPM_ACTIVE)
    {
        this.set_link_power(IPM_ACTIVE);
    }
    else if((icc === IPM_PARTIAL || icc === IPM_SLUMBER) && this.busy_slot === -1 && !this.ncq_active)
    {
        this.set_link_power(icc);
    }

    if(old & CMD_ST && !(value & CMD_ST))
    {
        // the command list stops: commands issued are dropped (CR clears at once)
        this.ci = 0;
        this.sact = 0;
        this.halted = false;
        this.abort_command();
    }
    if(value & CMD_FRE && !(old & CMD_FRE))
    {
        this.send_init_d2h();
    }
    if(value & CMD_ST && !(old & CMD_ST))
    {
        this.halted = false;
        this.check_commands();
    }
    // (ALPE set on an idle port)
    this.idle_link_power();
};

/** Execute the next command issued, if the port can */
AHCIPort.prototype.check_commands = function()
{
    if(this.ci && this.cmd & CMD_ST)
    {
        // commands wake the link from partial or slumber
        this.set_link_power(IPM_ACTIVE);
    }
    // (the lowest slot first, as QEMU does; non-queued commands run one at a
    // time, queued ones are handed to the device as long as it takes them)
    while(this.busy_slot === -1 && !this.halted && this.cmd & CMD_ST && this.ci &&
        this.link_up() && !this.init_d2h_pending && this.controller.can_dma())
    {
        const before = this.ci;
        this.start_command(31 - Math.clz32(this.ci & -this.ci));
        if(this.ci === before && this.busy_slot === -1)
        {
            // a non-queued command waits for the queued ones in flight
            break;
        }
    }
    this.idle_link_power();
};

/** PxSSTS.DET: a device is present and communication established */
AHCIPort.prototype.link_up = function()
{
    return (this.ssts & 0xF) === 3;
};

/**
 * Interface power management: the link goes to state (IPM_ACTIVE,
 * IPM_PARTIAL, IPM_SLUMBER) if it is up and PxSCTL.IPM allows the low power
 * states. There is no real link: the transitions take no time and change no
 * PhyRdy (no PxSERR.DIAG.N).
 * @param {number} state
 */
AHCIPort.prototype.set_link_power = function(state)
{
    if(!this.link_up() || (this.ssts >> 8 & 0xF) === state ||
        state === IPM_PARTIAL && this.sctl & SCTL_IPM_NO_PARTIAL ||
        state === IPM_SLUMBER && this.sctl & SCTL_IPM_NO_SLUMBER)
    {
        return;
    }
    dbg_log("AHCI port " + this.number + ": link " + (state === IPM_ACTIVE ? "active" : state === IPM_PARTIAL ? "partial" : "slumber"), LOG_DISK);
    this.ssts = this.ssts & ~0xF00 | state << 8;
};

/** PxCMD.ALPE: an idle port (nothing issued or queued) puts its link to partial, or slumber with ASP */
AHCIPort.prototype.idle_link_power = function()
{
    if(this.cmd & CMD_ALPE && this.cmd & CMD_ST && !this.ci && !this.sact &&
        this.busy_slot === -1 && !this.ncq_active)
    {
        this.set_link_power(this.cmd & CMD_ASP ? IPM_SLUMBER : IPM_PARTIAL);
    }
};

/**
 * @param {number} slot
 */
AHCIPort.prototype.start_command = function(slot)
{
    const cpu = this.cpu;
    const header = this.list_base() + slot * 32;

    let dw0, table, fis;
    try
    {
        cpu.validate_physical_range(header, 32);
        const head = cpu.read_blob_physical(header, 16);
        dw0 = (head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24) >>> 0;
        // CTBA (128-byte aligned) and CTBAU
        table = ((head[8] | head[9] << 8 | head[10] << 16 | head[11] << 24) & ~0x7F) >>> 0;
        if(this.controller.s64a)
        {
            table += (head[12] | head[13] << 8 | head[14] << 16 | head[15] << 24) * 0x100000000;
        }
        // PRDBC: nothing transferred yet
        cpu.write_blob_physical(new Uint8Array(4), header + 4);
        const fis_length = Math.max(5, dw0 & HEADER_CFL) * 4;
        fis = cpu.read_blob_physical(table, Math.min(fis_length, 64));
    }
    catch(error)
    {
        if(!(error instanceof RangeError)) throw error;
        this.host_bus_error();
        return;
    }

    dbg_log("AHCI port " + this.number + " slot " + slot + ": FIS " + h(fis[0], 2) + " C=" + (fis[1] >> 7) +
        " command " + h(fis[2], 2) + " header " + h(dw0, 8), LOG_DISK);

    if(fis[0] !== FIS_REG_H2D)
    {
        // only register FISes are sent from a command list
        this.complete_slot(slot);
        this.set_status(IS_IFS);
        this.halted = true;
        this.controller.update_irq();
        return;
    }

    if(!(fis[1] & FIS_H2D_COMMAND))
    {
        this.device_control(slot, fis[15]);
        return;
    }

    const device = this.device;
    const command = fis[2];

    if(command === ATA_CMD_READ_FPDMA_QUEUED || command === ATA_CMD_WRITE_FPDMA_QUEUED)
    {
        this.start_queued(slot, header, table, dw0 >>> 16, fis);
        return;
    }
    if(this.ncq_active)
    {
        // non-queued commands wait until the queued ones are done
        return;
    }

    // the task file registers: the high order byte of each is the previous write
    device.features_reg = fis[11] << 8 | fis[3];
    device.lba_low_reg = fis[8] << 8 | fis[4];
    device.lba_mid_reg = fis[9] << 8 | fis[5];
    device.lba_high_reg = fis[10] << 8 | fis[6];
    device.device_reg = fis[7];
    device.is_lba = fis[7] >> 6 & 1;
    device.head = fis[7] & 0xF;
    device.sector_count_reg = fis[13] << 8 | fis[12];

    const dma = ATA_DMA_COMMANDS.has(command) || command === ATA_CMD_PACKET && (fis[3] & 1) !== 0;
    this.busy_slot = slot;
    this.command = {
        slot, header, table, prdtl: dw0 >>> 16, dma, dma_started: false,
        packet_sent: false, bytes: 0, first_drq: true,
    };
    this.dma_status = dma ? 1 : 0;
    // (the HBA shows the device busy once it has sent the command)
    this.tfd = this.tfd & ~0xFF | ATA_SR_BSY;

    device.status_reg &= ~(ATA_SR_ERR | 0x20);
    if(command === ATA_CMD_READ_LOG_EXT && !device.is_atapi)
    {
        this.read_log(fis[4], fis[5], (fis[12] | fis[13] << 8) || 0x10000);
    }
    else
    {
        this.call_device(() => device.ata_command(command));
    }
    this.advance();
};

/**
 * READ FPDMA QUEUED / WRITE FPDMA QUEUED: the device takes the command at
 * once (PxCI clears, BSY is not set), moves the data whenever the disk image
 * has it, and reports completion with a set device bits FIS for its tag
 * (PxSACT clears, SDBS); several are in flight at a time. Native command
 * queuing: Serial ATA 2.6, 13.6; AHCI 1.3.1, 5.6.4.
 * @param {number} slot
 * @param {number} header
 * @param {number} table
 * @param {number} prdtl
 * @param {!Uint8Array} fis
 */
AHCIPort.prototype.start_queued = function(slot, header, table, prdtl, fis)
{
    const device = this.device;
    const tag = fis[12] >> 3;
    const count = (fis[3] | fis[11] << 8) || 0x10000;
    const lba = fis[4] + fis[5] * 0x100 + fis[6] * 0x10000 + fis[8] * 0x1000000 + fis[9] * 0x100000000 + fis[10] * 0x10000000000;
    const write = fis[2] === ATA_CMD_WRITE_FPDMA_QUEUED;
    const job = { slot, tag, header, table, prdtl, bytes: 0, epoch: this.ncq_epoch, lba, count, write };

    // accepted: the slot is free again, and the device releases the bus with
    // a register FIS without the interrupt bit (BSY clear: ready for more)
    this.ci &= ~(1 << slot);
    device.status_reg = ATA_SR_DRDY | ATA_SR_DSC;
    device.error_reg = 0;
    this.post_d2h(false);

    dbg_log("AHCI port " + this.number + " NCQ " + (write ? "write" : "read") + " tag " + tag + " lba " + h(lba) + " count " + count, LOG_DISK);

    if(!this.ncq_depth || device.is_atapi || !device.buffer || this.ncq_error || this.ncq_active & 1 << tag)
    {
        this.ncq_failed(job, ATA_ER_ABRT);
        return;
    }
    const start = lba * 512, length = count * 512;
    if(start + length > device.buffer.byteLength)
    {
        this.ncq_failed(job, ATA_ER_IDNF);
        return;
    }

    this.ncq_active |= 1 << tag;
    if(write)
    {
        let data;
        try
        {
            data = new Uint8Array(length);
            for(const segment of this.prdt_segments(job, 0, length))
            {
                data.set(this.cpu.read_blob_physical(segment.address, segment.length), segment.offset);
            }
        }
        catch(error)
        {
            if(!(error instanceof RangeError)) throw error;
            this.ncq_active &= ~(1 << tag);
            this.set_status(IS_OFS);
            this.ncq_failed(job, ATA_ER_ABRT);
            return;
        }
        // (FUA, the device register's bit 7: durable before it completes)
        device.write_to_backend(start, data, () => this.queued_done(job), () => this.queued_failed(job), !!(fis[7] & 0x80));
        device.report_write(length);
    }
    else
    {
        device.report_read_start();
        device.read_buffer(start, length, data =>
        {
            device.report_read_end(length);
            if(job.epoch !== this.ncq_epoch)
            {
                return;
            }
            try
            {
                for(const segment of this.prdt_segments(job, 0, length))
                {
                    this.cpu.write_blob_physical(data.subarray(segment.offset, segment.offset + segment.length), segment.address);
                }
            }
            catch(error)
            {
                if(!(error instanceof RangeError)) throw error;
                this.ncq_active &= ~(1 << tag);
                this.set_status(IS_OFS);
                this.ncq_failed(job, ATA_ER_ABRT);
                return;
            }
            this.queued_done(job);
        }, () =>
        {
            device.report_read_end(0);
            this.queued_failed(job);
        });
    }
};

/**
 * A queued command completed: a set device bits FIS with its tag
 * @param {!Object} job
 */
AHCIPort.prototype.queued_done = function(job)
{
    if(job.epoch !== this.ncq_epoch || !(this.ncq_active & 1 << job.tag))
    {
        // (the list was stopped or the port reset meanwhile)
        return;
    }
    this.ncq_active &= ~(1 << job.tag);
    this.post_sdb(ATA_SR_DRDY | ATA_SR_DSC, 0, 1 << job.tag);
    this.controller.update_irq();
    this.check_commands();
};

/**
 * The disk image failed a queued command's read or write
 * (docs/disk-image-formats-plan.md P0): it ends with ABRT, as QEMU's
 * ncq_err
 * @param {!Object} job
 */
AHCIPort.prototype.queued_failed = function(job)
{
    if(job.epoch !== this.ncq_epoch || !(this.ncq_active & 1 << job.tag))
    {
        return;
    }
    this.ncq_active &= ~(1 << job.tag);
    this.ncq_failed(job, ATA_ER_ABRT);
};

/**
 * A queued command failed: the device reports the error with a set device
 * bits FIS without its tag, keeps it for the NCQ command error log (READ LOG
 * EXT 10h) and rejects queued commands until the log is read; the HBA stops
 * (TFES) until software clears ST
 * @param {!Object} job
 * @param {number} error
 */
AHCIPort.prototype.ncq_failed = function(job, error)
{
    dbg_log("AHCI port " + this.number + " NCQ tag " + job.tag + " failed, error " + h(error, 2), LOG_DISK);
    if(!this.ncq_error)
    {
        this.ncq_error = { tag: job.tag, error, lba: job.lba, count: job.count };
    }
    // the device aborts every queued command it has: none of them completes
    // (writes already handed to the disk image still land)
    this.ncq_active = 0;
    this.ncq_epoch++;
    this.post_sdb(ATA_SR_DRDY | ATA_SR_ERR, error, 0);
    this.halted = true;
    this.controller.update_irq();
};

/**
 * A set device bits FIS: PxSACT loses the completed tags, PxTFD takes the
 * status and error, SDBS (the interrupt bit is always set), TFES with ERR
 * @param {number} status
 * @param {number} error
 * @param {number} completed
 */
AHCIPort.prototype.post_sdb = function(status, error, completed)
{
    this.post_fis(RFIS_SDB, [FIS_SET_DEVICE_BITS, 1 << 6, status & 0x77, error,
        completed & 0xFF, completed >> 8 & 0xFF, completed >> 16 & 0xFF, completed >>> 24]);
    this.sact = (this.sact & ~completed) >>> 0;
    this.tfd = error << 8 | this.tfd & 0x88 | status & 0x77;
    this.set_status(IS_SDBS);
    if(status & ATA_SR_ERR)
    {
        this.set_status(IS_TFES);
    }
};

/**
 * READ LOG EXT for the logs native command queuing needs: the directory
 * (00h) and the NCQ command error log (10h, whose read clears the error),
 * one page each; other logs and pages are aborted. The data goes out like
 * any PIO data-in command.
 * @param {number} log
 * @param {number} page
 * @param {number} pages
 */
AHCIPort.prototype.read_log = function(log, page, pages)
{
    const device = this.device;
    device.current_command = ATA_CMD_READ_LOG_EXT;
    device.error_reg = 0;

    const data = new Uint8Array(512);
    if(page + pages > 1)
    {
        log = -1;
    }
    if(log === 0x00 && this.ncq_depth)
    {
        // version 1; log 10h has one page
        data[0] = 1;
        data[0x10 * 2] = 1;
    }
    else if(log === 0x10 && this.ncq_depth && page === 0)
    {
        const e = this.ncq_error;
        if(e)
        {
            data[0] = e.tag;
            data[2] = ATA_SR_DRDY | ATA_SR_ERR;
            data[3] = e.error;
            data[4] = e.lba & 0xFF;
            data[5] = e.lba >> 8 & 0xFF;
            data[6] = e.lba >> 16 & 0xFF;
            data[7] = 0x40;
            data[8] = Math.floor(e.lba / 0x1000000) & 0xFF;
            data[9] = Math.floor(e.lba / 0x100000000) & 0xFF;
            data[10] = Math.floor(e.lba / 0x10000000000) & 0xFF;
            data[12] = e.count & 0xFF;
            data[13] = e.count >> 8 & 0xFF;
        }
        else
        {
            data[0] = 0x80; // NQ: no queued command failed
        }
        data[511] = -data.subarray(0, 511).reduce((a, b) => a + b, 0) & 0xFF;
        this.ncq_error = null;
    }
    else
    {
        device.current_command = -1;
        device.error_reg = ATA_ER_ABRT;
        device.status_reg = ATA_SR_DRDY | ATA_SR_ERR;
        return;
    }
    device.data_set(data);
    device.data_end = data.length;
    device.status_reg = ATA_SR_DRDY | ATA_SR_DSC | ATA_SR_DRQ;
};

/**
 * A register FIS without the C bit: an update of the device control
 * register. SRST set and then cleared resets the device (software reset).
 * @param {number} slot
 * @param {number} control
 */
AHCIPort.prototype.device_control = function(slot, control)
{
    dbg_log("AHCI port " + this.number + ": device control " + h(control, 2), LOG_DISK);
    this.complete_slot(slot);

    if(control & ATA_CR_SRST)
    {
        this.srst = true;
        this.tfd = this.tfd & ~0xFF | ATA_SR_BSY;
    }
    else if(this.srst)
    {
        this.srst = false;
        this.device_reset();
        this.sig = (this.device.lba_high_reg & 0xFF) << 24 | (this.device.lba_mid_reg & 0xFF) << 16 |
            (this.device.lba_low_reg & 0xFF) << 8 | this.device.sector_count_reg & 0xFF;
        this.post_d2h(true);
    }
    this.controller.update_irq();
    this.check_commands();
};

/**
 * Run a device method; interrupts it signals (push_irq) are looked at
 * afterwards by advance, not in the middle of it
 * @param {function()} f
 */
AHCIPort.prototype.call_device = function(f)
{
    const was = this.in_device;
    this.in_device = true;
    try
    {
        f();
    }
    finally
    {
        this.in_device = was;
    }
};

/** IDEInterface: the device signals an interrupt or a new phase */
AHCIPort.prototype.push_irq = function()
{
    if(!this.device || this.in_device)
    {
        return;
    }
    this.advance();
};

/** Drive the current command through its phases until it waits for the backend or is done */
AHCIPort.prototype.advance = function()
{
    if(this.advancing)
    {
        this.advance_again = true;
        return;
    }
    this.advancing = true;
    try
    {
        do
        {
            this.advance_again = false;
            this.advance_once();
        }
        while(this.advance_again);
    }
    finally
    {
        this.advancing = false;
    }
};

AHCIPort.prototype.advance_once = function()
{
    const command = this.command;
    if(!command)
    {
        return;
    }
    const device = this.device;
    const status = device.status_reg;

    if(status & ATA_SR_BSY)
    {
        // waiting for the disk image; push_irq continues
        return;
    }

    if(status & ATA_SR_DRQ)
    {
        if(device.current_command === ATA_CMD_PACKET && !command.packet_sent)
        {
            // the command packet (ACMD), then the device executes it
            command.packet_sent = true;
            let packet;
            try
            {
                packet = this.cpu.read_blob_physical(command.table + 0x40, 16);
            }
            catch(error)
            {
                if(!(error instanceof RangeError)) throw error;
                this.host_bus_error();
                return;
            }
            device.data.set(packet.subarray(0, 12));
            device.data_pointer = 12;
            this.call_device(() => device.write_end());
            this.advance_again = true;
            return;
        }

        if(command.dma && ATA_DMA_COMMANDS.has(device.current_command))
        {
            if(!command.dma_started)
            {
                // what the bus master start bit does for IDE
                command.dma_started = true;
                this.call_device(() => ATA_READ_DMA.has(device.current_command) ?
                    device.do_ata_read_sectors_dma() : device.do_ata_write_sectors_dma());
                this.advance_again = true;
            }
            return;
        }

        this.transfer_block(command);
        return;
    }

    this.complete_command();
};

/**
 * One data block of a command whose device has it ready (DRQ): from the
 * device's buffer to the PRDT or the reverse. ATAPI commands with DMA move
 * their data here too (the device prepared it like for PIO).
 * @param {!Object} command
 */
AHCIPort.prototype.transfer_block = function(command)
{
    const device = this.device;
    const start = device.data_pointer;
    const end = device.data_end;
    const length = end - start;
    const to_device = ATA_PIO_OUT_COMMANDS.has(device.current_command);
    const pio = !command.dma;
    const status_before = device.status_reg;

    try
    {
        if(length > 0)
        {
            const segments = this.prdt_segments(command, command.bytes, length);
            for(const segment of segments)
            {
                if(to_device)
                {
                    device.data.set(this.cpu.read_blob_physical(segment.address, segment.length), start + segment.offset);
                }
                else
                {
                    this.cpu.write_blob_physical(device.data.subarray(start + segment.offset, start + segment.offset + segment.length), segment.address);
                }
            }
            command.bytes += length;
            this.write_prdbc(command);
        }
    }
    catch(error)
    {
        if(!(error instanceof RangeError)) throw error;
        // the PRDT doesn't hold the transfer
        dbg_log("AHCI port " + this.number + ": " + error.message, LOG_DISK);
        this.set_status(IS_OFS);
        device.data_pointer = device.data_end = device.data_length = 0;
        device.current_command = -1;
        device.error_reg = ATA_ER_ABRT;
        device.status_reg = ATA_SR_DRDY | ATA_SR_ERR;
        this.advance_again = true;
        return;
    }

    device.data_pointer = end;
    this.call_device(() => to_device ? device.write_end() : device.read_end());

    if(pio)
    {
        // The PIO setup FIS of the block: its interrupt bit is set for data
        // from the device, and for data to it after the first block; never
        // for the command packet of an ATAPI command (QEMU's rule, which
        // SeaBIOS depends on: it takes the status from this FIS)
        const interrupt = !to_device || !command.first_drq;
        this.post_pio_setup(status_before, device.status_reg, length, !to_device, interrupt);
    }
    command.first_drq = false;
    this.advance_again = true;
};

/** The command is done (the device is neither busy nor has data): D2H FIS and status */
AHCIPort.prototype.complete_command = function()
{
    const command = this.command;
    const device = this.device;
    if(!command)
    {
        return;
    }
    this.command = null;
    this.busy_slot = -1;
    this.dma_status = 0;
    this.write_prdbc(command);

    // with the interrupt bit: DHRS, and TFES when the device reports an error
    this.post_d2h(true);

    if(device.status_reg & ATA_SR_ERR)
    {
        // the slot stays issued and the list stops until software clears ST
        dbg_log("AHCI port " + this.number + " slot " + command.slot + ": error " + h(device.error_reg & 0xFF, 2), LOG_DISK);
        this.halted = true;
    }
    else
    {
        this.ci &= ~(1 << command.slot);
    }
    this.controller.update_irq();
    this.check_commands();
};

/**
 * Clear a slot that completed without a D2H FIS
 * @param {number} slot
 */
AHCIPort.prototype.complete_slot = function(slot)
{
    this.ci &= ~(1 << slot);
};

/** The HBA could not read or write a command structure */
AHCIPort.prototype.host_bus_error = function()
{
    dbg_log("AHCI port " + this.number + ": host bus fatal error", LOG_DISK);
    this.abort_command();
    this.set_status(IS_HBFS);
    this.halted = true;
    this.controller.update_irq();
};

/**
 * The guest memory of bytes [offset, offset + length) of the command's
 * PRDT. Throws a RangeError when the PRDT is shorter or not in RAM.
 * @param {!Object} command
 * @param {number} offset
 * @param {number} length
 * @return {!Array<{address: number, offset: number, length: number}>}
 */
AHCIPort.prototype.prdt_segments = function(command, offset, length)
{
    const cpu = this.cpu;
    const segments = [];
    let position = 0;
    const end = offset + length;

    for(let i = 0; i < command.prdtl && position < end; i++)
    {
        const entry = command.table + 0x80 + i * 16;
        cpu.validate_physical_range(entry, 16);
        const bytes = cpu.read_blob_physical(entry, 16);
        // DBA: word aligned (bit 0 reserved); DBAU only with 64-bit addressing
        let address = (bytes[0] & ~1 | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        if(this.controller.s64a)
        {
            address += (bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24) * 0x100000000;
        }
        const count = ((bytes[12] | bytes[13] << 8 | bytes[14] << 16) & 0x3FFFFF) + 1;

        const from = Math.max(position, offset);
        const to = Math.min(position + count, end);
        if(from < to)
        {
            const part = to - from;
            const at = address + (from - position);
            cpu.validate_physical_range(at, part);
            segments.push({ address: at, offset: from - offset, length: part });
        }
        position += count;
    }

    if(position < end)
    {
        throw new RangeError("AHCI PRDT ends before the transfer (" + position + " < " + end + ")");
    }
    return segments;
};

/**
 * IDEInterface: the memory of a DMA transfer of the current command
 * @param {number} byte_count
 * @return {!Array<{address: number, offset: number, length: number}>}
 */
AHCIPort.prototype.dma_segments = function(byte_count)
{
    const command = this.command;
    if(!command)
    {
        throw new RangeError("AHCI: DMA without a command");
    }
    const segments = this.prdt_segments(command, 0, byte_count);
    command.bytes = byte_count;
    return segments;
};

/**
 * PRDBC of the command header: the bytes transferred
 * @param {!Object} command
 */
AHCIPort.prototype.write_prdbc = function(command)
{
    const bytes = command.bytes;
    try
    {
        this.cpu.write_blob_physical(new Uint8Array([bytes & 0xFF, bytes >> 8 & 0xFF, bytes >> 16 & 0xFF, bytes >>> 24]), command.header + 4);
    }
    catch(error)
    {
        if(!(error instanceof RangeError)) throw error;
    }
};

/** The command list's address (CLB, and CLBU with 64-bit addressing) */
AHCIPort.prototype.list_base = function()
{
    return this.clb + (this.controller.s64a ? this.clbu * 0x100000000 : 0);
};

/** The received FIS area's address (FB, FBU) */
AHCIPort.prototype.fis_base = function()
{
    return this.fb + (this.controller.s64a ? this.fbu * 0x100000000 : 0);
};

/**
 * Write a received FIS (when FIS reception is on)
 * @param {number} offset in the received FIS area
 * @param {!Array<number>} fis
 */
AHCIPort.prototype.post_fis = function(offset, fis)
{
    if(!(this.cmd & CMD_FRE))
    {
        return;
    }
    try
    {
        this.cpu.write_blob_physical(new Uint8Array(fis), this.fis_base() + offset);
    }
    catch(error)
    {
        if(!(error instanceof RangeError)) throw error;
        this.set_status(IS_HBFS);
    }
};

/**
 * The task file registers in FIS byte order (bytes 4-13)
 * @return {!Array<number>}
 */
AHCIPort.prototype.task_file = function()
{
    const d = this.device;
    return [
        d.lba_low_reg & 0xFF, d.lba_mid_reg & 0xFF, d.lba_high_reg & 0xFF, d.device_reg & 0xF0 | d.head & 0x0F,
        d.lba_low_reg >> 8 & 0xFF, d.lba_mid_reg >> 8 & 0xFF, d.lba_high_reg >> 8 & 0xFF, 0,
        d.sector_count_reg & 0xFF, d.sector_count_reg >> 8 & 0xFF,
    ];
};

/**
 * The device's register FIS: PxTFD follows it; DHRS with the interrupt bit,
 * TFES with an error
 * @param {boolean} interrupt
 */
AHCIPort.prototype.post_d2h = function(interrupt)
{
    const d = this.device;
    const status = d.status_reg & 0xFF;
    const error = d.error_reg & 0xFF;
    this.post_fis(RFIS_D2H, [FIS_REG_D2H, interrupt ? 1 << 6 : 0, status, error,
        ...this.task_file(), 0, 0, 0, 0, 0, 0]);
    this.tfd = error << 8 | status;
    if(interrupt)
    {
        this.set_status(IS_DHRS);
    }
    if(status & ATA_SR_ERR)
    {
        this.set_status(IS_TFES);
    }
};

/**
 * A PIO setup FIS: the status while the block is transferred, the ending
 * status (E_Status) after it, and the transfer count
 * @param {number} status
 * @param {number} end_status
 * @param {number} count
 * @param {boolean} from_device
 * @param {boolean} interrupt
 */
AHCIPort.prototype.post_pio_setup = function(status, end_status, count, from_device, interrupt)
{
    const d = this.device;
    this.post_fis(RFIS_PIO_SETUP, [FIS_PIO_SETUP, (interrupt ? 1 << 6 : 0) | (from_device ? 1 << 5 : 0),
        status & 0xFF, d.error_reg & 0xFF, ...this.task_file(), 0, end_status & 0xFF,
        count & 0xFF, count >> 8 & 0xFF, 0, 0]);
    this.tfd = (d.error_reg & 0xFF) << 8 | end_status & 0xFF;
    if(interrupt)
    {
        this.set_status(IS_PSS);
    }
};

AHCIPort.prototype.get_state = function()
{
    const state = [];
    state[0] = this.clb;
    state[1] = this.clbu;
    state[2] = this.fb;
    state[3] = this.fbu;
    state[4] = this.is;
    state[5] = this.ie;
    state[6] = this.cmd;
    state[7] = this.tfd;
    state[8] = this.sig;
    state[9] = this.ssts;
    state[10] = this.sctl;
    state[11] = this.serr;
    state[12] = this.sact;
    state[13] = this.ci;
    state[14] = this.init_d2h_pending;
    state[15] = this.halted;
    state[16] = this.srst;
    state[17] = this.device;
    const e = this.ncq_error;
    state[18] = e ? [e.tag, e.error, e.lba, e.count] : null;
    // (a snapshot waits for the disk I/O in flight: no command is running)
    dbg_assert(!this.command && !this.ncq_active);
    return state;
};

AHCIPort.prototype.set_state = function(state)
{
    this.clb = state[0];
    this.clbu = state[1];
    this.fb = state[2];
    this.fbu = state[3];
    this.is = state[4];
    this.ie = state[5];
    this.cmd = state[6];
    this.tfd = state[7];
    this.sig = state[8];
    this.ssts = state[9];
    this.sctl = state[10];
    this.serr = state[11];
    this.sact = state[12];
    this.ci = state[13];
    this.init_d2h_pending = state[14];
    this.halted = state[15];
    this.srst = state[16];
    const e = state[18];
    this.ncq_error = e ? { tag: e[0], error: e[1], lba: e[2], count: e[3] } : null;
    this.abort_command();
    if(this.device && state[17])
    {
        this.device.set_state(state[17]);
    }
    else if(this.device)
    {
        // a drive attached after the snapshot was taken: for the restored
        // guest, it was plugged in just now
        const device = this.device;
        this.device = this.master = null;
        this.attach_device(device);
    }
    else if(state[17])
    {
        // the snapshot's port had a drive this machine does not have (one
        // that was hot plugged): for the restored guest, it was removed
        dbg_log("AHCI port " + this.number + ": the snapshot has a drive here, this machine does not", LOG_DISK);
        this.serr = (this.serr | SERR_DIAG_N) >>> 0;
        this.link_reset();
    }
};
