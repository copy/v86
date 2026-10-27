// An EHCI USB 2.0 host controller (Enhanced Host Controller Interface 1.0):
// ICH9's EHCI1 (8086:293A, function 7 of the USB device) with its three
// UHCI companions (8086:2934, 2935, 2936, functions 0-2, uhci.js), as
// QEMU's ich9-usb-ehci1 with ich9-usb-uhci1..3 (masterbus, firstport 0, 2,
// 4). Windows binds usbport.inf by the class (PCI\CC_0C0320), Linux
// ehci-pci. Six root ports: a high-speed device stays on the EHCI, a full-
// or low-speed one goes to the companion of its port (CONFIGFLAG 0, or the
// driver's Port Owner after a reset that left the port disabled). BAR0 is
// memory (the capability and operational registers), the interrupt INTD.
//
// While it runs, the controller goes through micro-frames of 125 µs of the
// machine clock (FRINDEX), caught up a millisecond at a time: the periodic
// schedule's frame list entry for each micro-frame (interrupt queue heads by
// their S-mask; isochronous descriptors are skipped: no device has them),
// then the asynchronous schedule's ring of queue heads (control and bulk),
// pass after pass while transactions happen, up to a budget of bytes; a
// pass without any ends it (the reclamation). Interrupt on Async Advance is
// at once: nothing of the schedule is kept between passes. No split
// transactions (no hubs), no 64-bit buffer pointers above the guest's
// memory, no isochronous transfers.

import { LOG_PCI } from "../const.js";
import { h } from "../lib.js";
import { dbg_log } from "../log.js";
import { PID_IN, PID_OUT, PID_SETUP, SPEED_FULL, SPEED_HIGH, SPEED_LOW, USB_NAK, USB_STALL } from "./usb.js";

const MMIO_SIZE = 0x1000;
/** The operational registers' offset (CAPLENGTH) */
const OP = 0x20;
export const EHCI_PORTS = 6;
const PORTS_PER_COMPANION = 2, COMPANIONS = 3;

const PCI_VENDOR = 0x8086, PCI_DEVICE = 0x293A, PCI_REVISION = 0x03;
const PCI_SUBSYSTEM_VENDOR = 0x1AF4, PCI_SUBSYSTEM = 0x1100;
// the legacy support capability (USBLEGSUP, USBLEGCTLSTS): EECP
const LEGSUP = 0x68;
const LEGSUP_BIOS_OWNED = 1 << 16, LEGSUP_OS_OWNED = 1 << 24;

// capability registers: N_PORTS, N_PCC, N_CC (no port power control); 64-bit
// addressing, the isochronous threshold (a whole frame), EECP
const HCSPARAMS = EHCI_PORTS | PORTS_PER_COMPANION << 8 | COMPANIONS << 12;
const HCCPARAMS = 1 | 0x80 | LEGSUP << 8;

// operational registers (from OP)
const R_USBCMD = 0x00, R_USBSTS = 0x04, R_USBINTR = 0x08, R_FRINDEX = 0x0C, R_CTRLDSSEGMENT = 0x10,
    R_PERIODICLISTBASE = 0x14, R_ASYNCLISTADDR = 0x18, R_CONFIGFLAG = 0x40, R_PORTSC = 0x44;

const CMD_RS = 1 << 0, CMD_HCRESET = 1 << 1, CMD_PSE = 1 << 4, CMD_ASE = 1 << 5, CMD_IAAD = 1 << 6,
    CMD_ITC_DEFAULT = 8 << 16, CMD_MASK = 0x00FF0B7F;
const STS_USBINT = 1 << 0, STS_USBERRINT = 1 << 1, STS_PCD = 1 << 2, STS_FLR = 1 << 3, STS_HSE = 1 << 4, STS_IAA = 1 << 5,
    STS_HALTED = 1 << 12, STS_PSS = 1 << 14, STS_ASS = 1 << 15;
const STS_WRITE_CLEAR = 0x3F;

const PORT_CCS = 1 << 0, PORT_CSC = 1 << 1, PORT_PED = 1 << 2, PORT_PEDC = 1 << 3, PORT_OCC = 1 << 5, PORT_FPR = 1 << 6,
    PORT_SUSPEND = 1 << 7, PORT_PR = 1 << 8, PORT_LS_J = 2 << 10, PORT_LS_K = 1 << 10, PORT_PP = 1 << 12, PORT_PO = 1 << 13;
const PORT_WRITE_CLEAR = PORT_CSC | PORT_PEDC | PORT_OCC;
/** what the driver sets as it likes: resume, suspend, the indicators, test control, wake enables */
const PORT_DRIVER = PORT_FPR | PORT_SUSPEND | 0x7FC000;

// link pointers: T, the type (0 iTD, 1 QH, 2 siTD, 3 FSTN)
const LINK_TERMINATE = 1, TYPE_QH = 1;
// a queue head's endpoint speed (0 full, 1 low: split transactions, behind a hub)
const EPS_HIGH = 2;
// a qTD's token
const TOKEN_ACTIVE = 1 << 7, TOKEN_HALTED = 1 << 6, TOKEN_BUFFER_ERROR = 1 << 5, TOKEN_BABBLE = 1 << 4,
    TOKEN_XACTERR = 1 << 3, TOKEN_PING = 1 << 0, TOKEN_IOC = 1 << 15, TOKEN_DT = 1 << 31;
const PID_CODES = [PID_OUT, PID_IN, PID_SETUP];

/** Per millisecond: the asynchronous schedule's bytes, its queue heads */
const ASYNC_BYTES = 256 * 1024;
const ASYNC_QHS = 512;
/** Per micro-frame: the periodic schedule's nodes */
const PERIODIC_NODES = 128;
/** Milliseconds caught up per timer round, and the most behind before skipping */
const MS_PER_ROUND = 4;
const MS_BEHIND = 100;

/**
 * @constructor
 * @param {!Object} machine the EHCI function's machine (src/device_machine.js)
 * @param {!Array<!Object>} companions the UHCI controllers of ports 0-1, 2-3, 4-5
 */
export function EHCIController(machine, companions)
{
    this.machine = machine;
    this.companions = companions;
    this.name = "ehci";
    /** @type {!Array<?Object>} the device in each root port, whichever controller has it */
    this.devices = new Array(EHCI_PORTS).fill(null);
    this.irq_level = false;
    this.bar0 = 0;
    this.mmio = -1;
    /** the asynchronous schedule's bytes left in this millisecond; the interrupts the transfers raise */
    this.async_bytes = 0;
    this.interrupts = 0;
    this.reset();

    machine.register_pci({
        pci_space: create_pci_space(),
        pci_bars: [{ size: MMIO_SIZE, on_move: base => { this.bar0 = base; this.update_decode(); } }],
        on_command_change: () => { this.update_decode(); this.update_irq(); },
        on_config_restore: () => this.update_decode(),
        on_upstream_change: () => this.update_decode(),
        on_config_write: (offset, size) => this.config_written(offset, size),
    });
    machine.add_timer(now => this.timer(now));
}

/** @return {!Array<number>} */
function create_pci_space()
{
    const space = new Array(256).fill(0);
    const put16 = (offset, value) => { space[offset] = value & 0xFF; space[offset + 1] = value >> 8 & 0xFF; };
    put16(0x00, PCI_VENDOR);
    put16(0x02, PCI_DEVICE);
    put16(0x06, 0x0290);
    space[0x08] = PCI_REVISION;
    // class 0C/03/20: an EHCI USB controller
    space[0x09] = 0x20;
    space[0x0A] = 0x03;
    space[0x0B] = 0x0C;
    put16(0x2C, PCI_SUBSYSTEM_VENDOR);
    put16(0x2E, PCI_SUBSYSTEM);
    space[0x3D] = 4;
    // SBRN: USB 2.0; FLADJ; no port wake capability
    space[0x60] = 0x20;
    space[0x61] = 0x20;
    // USBLEGSUP (capability 1, the last), USBLEGCTLSTS
    space[LEGSUP] = 0x01;
    return space;
}

/**
 * The legacy support capability: the driver taking the controller from the
 * firmware (OS owned) gets it at once: v86 has no USB legacy SMI
 * @param {number} offset
 * @param {number} size
 */
EHCIController.prototype.config_written = function(offset, size)
{
    if(offset + size <= LEGSUP || offset >= LEGSUP + 8) return;
    const space = this.machine.pci_config();
    let legsup = (space[LEGSUP] | space[LEGSUP + 1] << 8 | space[LEGSUP + 2] << 16 | space[LEGSUP + 3] << 24) >>> 0;
    legsup = (legsup & (LEGSUP_BIOS_OWNED | LEGSUP_OS_OWNED) | 0x01) >>> 0;
    if(legsup & LEGSUP_OS_OWNED) legsup &= ~LEGSUP_BIOS_OWNED;
    space.set([legsup & 0xFF, legsup >> 8 & 0xFF, legsup >> 16 & 0xFF, legsup >>> 24], LEGSUP);
};

EHCIController.prototype.update_decode = function()
{
    const base = this.bar0 && this.machine.memory_decoded(this.bar0, MMIO_SIZE) ? this.bar0 : -1;
    if(base === this.mmio) return;
    if(this.mmio !== -1) this.machine.mmap_unregister_range(this.mmio, MMIO_SIZE);
    this.mmio = base;
    if(base !== -1)
    {
        this.machine.mmap_register_range(base, MMIO_SIZE,
            address => this.read(address - this.mmio, 1),
            (address, value) => this.write(address - this.mmio, 1, value),
            address => this.read(address - this.mmio, 4),
            (address, value) => this.write(address - this.mmio, 4, value));
    }
};

/** Everything to its reset value (power on, HCRESET): every port the companions' */
EHCIController.prototype.reset = function()
{
    this.cmd = CMD_ITC_DEFAULT;
    this.status = STS_HALTED;
    this.intr = 0;
    this.frindex = 0;
    this.segment = 0;
    this.periodic_base = 0;
    this.async_address = 0;
    this.configflag = 0;
    this.portsc = new Array(EHCI_PORTS).fill(PORT_PP | PORT_PO);
    /** the machine time of the next millisecond's work (while running) */
    this.next_ms = 0;
    for(let port = 0; port < EHCI_PORTS; port++) this.route(port);
    this.update_irq();
};

/** A machine reset (PCIRST#): the companions too */
EHCIController.prototype.reset_all = function()
{
    for(const companion of this.companions) companion.reset();
    this.reset();
    this.update_decode();
};

/**
 * @param {number} port
 * @return {boolean} whether the EHCI has the port (otherwise its companion)
 */
EHCIController.prototype.owns = function(port)
{
    return this.configflag !== 0 && !(this.portsc[port] & PORT_PO);
};

/**
 * Put the port's device where the port's owner sees it: the companion's
 * port, or the EHCI's (each side sees a device arrive and leave)
 * @param {number} port
 */
EHCIController.prototype.route = function(port)
{
    const device = this.devices[port];
    const companion = this.companions[port / PORTS_PER_COMPANION | 0], companion_port = port % PORTS_PER_COMPANION;
    if(!this.owns(port))
    {
        if(this.portsc[port] & PORT_CCS) this.disconnected(port);
        // (also a device that left while the snapshot had it there)
        if(companion.devices[companion_port] !== device || !device && companion.port_connected(companion_port))
        {
            if(device) device.set_speed(device.speeds.includes(SPEED_FULL) ? SPEED_FULL : SPEED_LOW);
            companion.attach(companion_port, device);
        }
        return;
    }
    if(companion.devices[companion_port]) companion.attach(companion_port, null);
    if(device && !(this.portsc[port] & PORT_CCS))
    {
        this.portsc[port] = this.portsc[port] & ~(PORT_PED | PORT_SUSPEND) | PORT_CCS | PORT_CSC;
        this.port_change();
    }
    else if(!device && this.portsc[port] & PORT_CCS)
    {
        this.disconnected(port);
    }
};

/** @param {number} port the EHCI's port lost its device */
EHCIController.prototype.disconnected = function(port)
{
    const enabled = this.portsc[port] & PORT_PED;
    this.portsc[port] = this.portsc[port] & ~(PORT_CCS | PORT_PED | PORT_SUSPEND) | PORT_CSC | (enabled ? PORT_PEDC : 0);
    this.port_change();
};

EHCIController.prototype.port_change = function()
{
    this.status |= STS_PCD;
    this.update_irq();
};

/**
 * Plug a device into a root port (or take it out: null). One that leaves a
 * companion's port gives the port back to the EHCI (EHCI 4.2.2).
 * @param {number} port
 * @param {?Object} device
 */
EHCIController.prototype.attach = function(port, device)
{
    const owned_by_companion = !this.owns(port) && this.devices[port];
    this.devices[port] = device;
    if(device) device.reset();
    this.route(port);
    if(!device && owned_by_companion && this.configflag)
    {
        this.portsc[port] &= ~PORT_PO;
        this.route(port);
    }
};

/** After a snapshot's registers and devices: the companions' ports have the devices their owners had */
EHCIController.prototype.restore_routing = function()
{
    for(let port = 0; port < EHCI_PORTS; port++)
    {
        this.companions[port / PORTS_PER_COMPANION | 0].devices[port % PORTS_PER_COMPANION] = this.owns(port) ? null : this.devices[port];
    }
};

/**
 * @param {number} port
 * @return {boolean} whether the port has a device connected, on whichever side
 */
EHCIController.prototype.port_connected = function(port)
{
    const companion = this.companions[port / PORTS_PER_COMPANION | 0];
    return !!(this.portsc[port] & PORT_CCS) || companion.port_connected(port % PORTS_PER_COMPANION);
};

// registers

/**
 * A register's value
 * @param {number} offset its first byte
 * @return {number}
 */
EHCIController.prototype.register = function(offset)
{
    switch(offset)
    {
        // CAPLENGTH, HCIVERSION
        case 0x00: return OP | 0x0100 << 16;
        case 0x04: return HCSPARAMS;
        case 0x08: return HCCPARAMS;
        case OP + R_USBCMD: return this.cmd;
        case OP + R_USBSTS: return this.status;
        case OP + R_USBINTR: return this.intr;
        case OP + R_FRINDEX: return this.frindex;
        case OP + R_CTRLDSSEGMENT: return this.segment;
        case OP + R_PERIODICLISTBASE: return this.periodic_base;
        case OP + R_ASYNCLISTADDR: return this.async_address;
        case OP + R_CONFIGFLAG: return this.configflag;
    }
    if(offset >= OP + R_PORTSC && offset < OP + R_PORTSC + 4 * EHCI_PORTS)
    {
        const port = offset - OP - R_PORTSC >> 2;
        let value = this.portsc[port];
        // the line status of a connected, not enabled port: J for a
        // full-speed device, K for a low-speed one
        if(value & PORT_CCS && !(value & PORT_PED) && this.devices[port])
        {
            value |= this.devices[port].speeds.includes(SPEED_FULL) || this.devices[port].speeds.includes(SPEED_HIGH) ? PORT_LS_J : PORT_LS_K;
        }
        return value;
    }
    return 0;
};

/**
 * @param {number} offset
 * @param {number} size
 * @return {number}
 */
EHCIController.prototype.read = function(offset, size)
{
    const value = this.register(offset & ~3);
    if(size === 4) return value >>> 0;
    return value >>> ((offset & 3) << 3) & (size === 1 ? 0xFF : 0xFFFF);
};

/**
 * @param {number} offset
 * @param {number} size
 * @param {number} value
 */
EHCIController.prototype.write = function(offset, size, value)
{
    const shift = (offset & 3) << 3;
    const mask = (size === 4 ? -1 : (size === 1 ? 0xFF : 0xFFFF) << shift) >>> 0;
    this.write_register(offset & ~3, value << shift >>> 0, mask);
};

/**
 * @param {number} offset
 * @param {number} bits
 * @param {number} mask
 */
EHCIController.prototype.write_register = function(offset, bits, mask)
{
    const merge = old => (old & ~mask | bits & mask) >>> 0;
    switch(offset)
    {
        case OP + R_USBCMD:
        {
            const value = merge(this.cmd) & CMD_MASK;
            if(value & CMD_HCRESET)
            {
                dbg_log("ehci: host controller reset", LOG_PCI);
                this.reset();
                return;
            }
            const was_running = this.cmd & CMD_RS;
            // (the frame list's size stays 1024)
            this.cmd = value & ~(3 << 2);
            if(value & CMD_RS && !was_running)
            {
                this.status &= ~STS_HALTED;
                this.next_ms = this.machine.now();
            }
            else if(!(value & CMD_RS) && was_running)
            {
                this.status |= STS_HALTED;
            }
            this.status = this.status & ~(STS_PSS | STS_ASS) | (this.cmd & CMD_PSE ? STS_PSS : 0) | (this.cmd & CMD_ASE ? STS_ASS : 0);
            if(this.cmd & CMD_IAAD)
            {
                // Interrupt on Async Advance: no queue head of the
                // schedule is kept between passes, so the driver may free
                // the one it took out at once
                this.cmd &= ~CMD_IAAD;
                this.status |= STS_IAA;
            }
            this.update_irq();
            break;
        }
        case OP + R_USBSTS:
            this.status &= ~(bits & mask & STS_WRITE_CLEAR);
            this.update_irq();
            break;
        case OP + R_USBINTR:
            this.intr = merge(this.intr) & 0x3F;
            this.update_irq();
            break;
        case OP + R_FRINDEX:
            // (only while halted)
            if(this.status & STS_HALTED) this.frindex = merge(this.frindex) & 0x3FFF;
            break;
        case OP + R_CTRLDSSEGMENT:
            this.segment = merge(this.segment);
            break;
        case OP + R_PERIODICLISTBASE:
            this.periodic_base = merge(this.periodic_base) & ~0xFFF;
            break;
        case OP + R_ASYNCLISTADDR:
            this.async_address = merge(this.async_address) & ~0x1F;
            break;
        case OP + R_CONFIGFLAG:
        {
            const value = merge(this.configflag) & 1;
            if(value === this.configflag) break;
            this.configflag = value;
            // (set: every port the EHCI's, to be reset; cleared: the companions')
            for(let port = 0; port < EHCI_PORTS; port++)
            {
                this.portsc[port] = value ? this.portsc[port] & ~PORT_PO : this.portsc[port] | PORT_PO;
                this.route(port);
            }
            break;
        }
        default:
            if(offset >= OP + R_PORTSC && offset < OP + R_PORTSC + 4 * EHCI_PORTS)
            {
                this.write_port(offset - OP - R_PORTSC >> 2, bits & mask);
            }
    }
};

/**
 * @param {number} port
 * @param {number} value
 */
EHCIController.prototype.write_port = function(port, value)
{
    let portsc = this.portsc[port] & ~(value & PORT_WRITE_CLEAR);
    // (the driver may disable the port, not enable it)
    if(!(value & PORT_PED)) portsc &= ~PORT_PED;
    // the port to the other controller (Port Owner, with CONFIGFLAG set)
    const owner = value & PORT_PO;
    if(owner !== (portsc & PORT_PO) && this.configflag)
    {
        this.portsc[port] = portsc & ~PORT_PO | owner;
        this.route(port);
        portsc = this.portsc[port];
    }
    const device = this.devices[port];
    if(!(value & PORT_PR) && portsc & PORT_PR)
    {
        // the end of a port reset: a high-speed device is enabled; a
        // full- or low-speed one is not (its driver gives it to the companion)
        portsc &= ~PORT_PR;
        if(device && this.owns(port))
        {
            device.reset();
            if(device.speeds.includes(SPEED_HIGH))
            {
                device.set_speed(SPEED_HIGH);
                portsc |= PORT_PED;
            }
        }
    }
    else if(value & PORT_PR && !(portsc & PORT_PR))
    {
        portsc = portsc & ~PORT_PED | PORT_PR;
    }
    // (a resume ends the suspend)
    if(!(value & PORT_FPR) && portsc & PORT_FPR) value &= ~PORT_SUSPEND;
    portsc = portsc & ~PORT_DRIVER | value & PORT_DRIVER;
    if(!(portsc & PORT_PED)) portsc &= ~PORT_SUSPEND;
    this.portsc[port] = portsc;
};

EHCIController.prototype.update_irq = function()
{
    const level = !!(this.status & this.intr & 0x3F);
    if(level === this.irq_level) return;
    this.irq_level = level;
    if(level) this.machine.raise_irq();
    else this.machine.lower_irq();
};

// the schedules

/**
 * @param {number} now the machine time
 * @return {number} milliseconds until the next work
 */
EHCIController.prototype.timer = function(now)
{
    if(!(this.cmd & CMD_RS)) return 100;
    if(now - this.next_ms > MS_BEHIND)
    {
        // (far behind: the time of the gap passes without its work)
        const skipped = Math.floor(now - this.next_ms) - MS_PER_ROUND;
        this.frindex = this.frindex + 8 * skipped & 0x3FFF;
        this.next_ms += skipped;
    }
    for(let i = 0; i < MS_PER_ROUND && now >= this.next_ms; i++)
    {
        this.process_ms();
        this.next_ms += 1;
        if(!(this.cmd & CMD_RS)) return 100;
    }
    return Math.max(0, this.next_ms - now);
};

/** A millisecond: eight micro-frames of the periodic schedule, then the asynchronous one */
EHCIController.prototype.process_ms = function()
{
    if(!this.machine.is_bus_master())
    {
        this.advance_frindex(8);
        return;
    }
    this.interrupts = 0;
    for(let i = 0; i < 8; i++)
    {
        if(this.cmd & CMD_PSE && !this.process_periodic()) return;
        this.advance_frindex(1);
    }
    if(this.cmd & CMD_ASE && !this.process_async()) return;
    if(this.interrupts)
    {
        this.status |= this.interrupts;
        this.update_irq();
    }
};

/** @param {number} uframes */
EHCIController.prototype.advance_frindex = function(uframes)
{
    const before = this.frindex;
    this.frindex = this.frindex + uframes & 0x3FFF;
    // (the frame list's index wrapped: Frame List Rollover)
    if((before ^ this.frindex) & 0x2000)
    {
        this.status |= STS_FLR;
        this.update_irq();
    }
};

/**
 * The periodic schedule of the current micro-frame
 * @return {boolean} false after a host system error
 */
EHCIController.prototype.process_periodic = function()
{
    const uframe = this.frindex & 7;
    let link = this.dma_read32(this.address(this.periodic_base + 4 * (this.frindex >> 3 & 0x3FF)));
    for(let n = 0; n < PERIODIC_NODES; n++)
    {
        if(link === null) return this.host_error();
        if(link & LINK_TERMINATE) break;
        const node = link & ~0x1F, type = link >> 1 & 3;
        if(type === TYPE_QH)
        {
            const caps = this.dma_read32(this.address(node + 8));
            if(caps === null) return this.host_error();
            // (an interrupt endpoint's queue head, in the micro-frames of its S-mask)
            if(caps & 1 << uframe && this.process_qh(node, Math.max(1, caps >>> 30)) === null) return this.host_error();
        }
        // (an iTD, siTD or FSTN: skipped, by its next link, also dword 0)
        link = this.dma_read32(this.address(node));
    }
    return true;
};

/**
 * The asynchronous schedule: its ring from ASYNCLISTADDR, pass after pass
 * while transactions happen
 * @return {boolean} false after a host system error
 */
EHCIController.prototype.process_async = function()
{
    this.async_bytes = ASYNC_BYTES;
    let qh = this.async_address, start = qh, progress = false;
    for(let n = 0; n < ASYNC_QHS && this.async_bytes > 0; n++)
    {
        const result = this.process_qh(qh, 0);
        if(result === null) return this.host_error();
        progress = progress || result;
        const link = this.dma_read32(this.address(qh));
        if(link === null) return this.host_error();
        // (the ring is of queue heads; anything else ends the pass)
        if(link & LINK_TERMINATE || (link >> 1 & 3) !== TYPE_QH) break;
        qh = link & ~0x1F;
        if(qh === start)
        {
            if(!progress) break;
            progress = false;
        }
    }
    this.async_address = qh;
    return true;
};

/**
 * A 64-bit data structure address from its low dword (CTRLDSSEGMENT)
 * @param {number} low
 * @return {number}
 */
EHCIController.prototype.address = function(low)
{
    return this.segment ? this.segment * 0x100000000 + (low >>> 0) : low >>> 0;
};

/**
 * The device at an address on an enabled port the EHCI owns
 * @param {number} address
 * @return {?Object}
 */
EHCIController.prototype.device_at = function(address)
{
    for(let port = 0; port < EHCI_PORTS; port++)
    {
        const device = this.devices[port];
        if(device && this.owns(port) && this.portsc[port] & PORT_PED && !(this.portsc[port] & PORT_SUSPEND) && device.address === address)
        {
            return device;
        }
    }
    return null;
};

/**
 * A queue head: its current qTD's transactions, then the next qTDs while
 * they are active (at most `limit` transactions: a periodic one's, or 0)
 * @param {number} qh
 * @param {number} limit
 * @return {?boolean} whether transactions happened; null where the queue head is not in memory
 */
EHCIController.prototype.process_qh = function(qh, limit)
{
    const words = this.dma_read(this.address(qh), 68);
    if(!words) return null;
    const view = new DataView(words.buffer);
    const dw = i => view.getUint32(4 * i, true);
    const characteristics = dw(1);
    const device_address = characteristics & 0x7F, endpoint = characteristics >> 8 & 0xF, speed = characteristics >> 12 & 3;
    const dtc = characteristics & 1 << 14, max_packet = characteristics >> 16 & 0x7FF;
    const reload = characteristics >>> 28;
    // the overlay: current qTD, next, alternate next (and the NAK counter), token, five buffer pointers (and their high dwords)
    const overlay = [dw(3), dw(4), dw(5), dw(6), dw(7), dw(8), dw(9), dw(10), dw(11), dw(12), dw(13), dw(14), dw(15), dw(16)];
    let progress = false, transactions = 0;

    for(let qtds = 0; qtds < 64; qtds++)
    {
        let token = overlay[3];
        if(token & TOKEN_HALTED) break;
        if(!(token & TOKEN_ACTIVE))
        {
            // the next qTD: the alternate one after a short packet
            const left = token >> 16 & 0x7FFF;
            const next = left && !(overlay[2] & LINK_TERMINATE) ? overlay[2] : overlay[1];
            if(next & LINK_TERMINATE) break;
            const qtd = next & ~0x1F;
            const words2 = this.dma_read(this.address(qtd), 52);
            if(!words2) return null;
            const q = new DataView(words2.buffer);
            const qtd_token = q.getUint32(8, true);
            if(!(qtd_token & TOKEN_ACTIVE)) break;
            // (the overlay: the data toggle stays the queue head's unless
            // the qTDs carry it; the ping state stays)
            let new_token = qtd_token;
            if(!dtc) new_token = (new_token & ~TOKEN_DT | token & TOKEN_DT) >>> 0;
            if(speed === EPS_HIGH) new_token = new_token & ~TOKEN_PING | token & TOKEN_PING;
            overlay[0] = qtd;
            overlay[1] = q.getUint32(0, true);
            overlay[2] = q.getUint32(4, true) & ~0x1E | reload << 1;
            overlay[3] = new_token >>> 0;
            for(let i = 0; i < 5; i++) overlay[4 + i] = q.getUint32(12 + 4 * i, true);
            for(let i = 0; i < 5; i++) overlay[9 + i] = q.getUint32(32 + 4 * i, true);
            // (the C-prog-mask and S-bytes, split transactions' fields, start at 0)
            overlay[5] &= ~0xFF;
            overlay[6] &= ~0xFFF;
            this.write_overlay(qh, overlay);
            continue;
        }

        const pid = PID_CODES[token >> 8 & 3];
        const device = speed === EPS_HIGH ? this.device_at(device_address) : null;
        let bytes = token >> 16 & 0x7FFF;
        let page = token >> 12 & 7, offset = overlay[4] & 0xFFF;
        let done = false, error = 0, short = false;
        while(!done)
        {
            if(limit && transactions >= limit || this.async_bytes <= 0 && !limit) break;
            if(pid === undefined || !device)
            {
                // no answer (no device, a split transaction): CERR down, at 0 the qTD halts
                let errors = token >> 10 & 3;
                if(errors) errors--;
                token = (token & ~(3 << 10) | errors << 10 | TOKEN_XACTERR) >>> 0;
                if(!errors || pid === undefined)
                {
                    error = TOKEN_HALTED;
                    done = true;
                }
                break;
            }
            const length = pid === PID_SETUP ? 8 : Math.min(bytes, max_packet || 8);
            let data = null;
            if(pid !== PID_IN)
            {
                data = this.read_buffer(overlay, page, offset, length);
                if(!data) { error = TOKEN_HALTED | TOKEN_BUFFER_ERROR; done = true; break; }
            }
            const result = device.transaction(pid, endpoint, data, length);
            transactions++;
            if(result === USB_NAK)
            {
                // (tried again later; a high-speed OUT pings meanwhile)
                if(pid === PID_OUT && speed === EPS_HIGH) token |= TOKEN_PING;
                break;
            }
            token &= ~TOKEN_PING;
            if(result === USB_STALL)
            {
                error = TOKEN_HALTED;
                done = true;
                break;
            }
            let moved = length;
            if(result instanceof Uint8Array)
            {
                if(result.length > length)
                {
                    error = TOKEN_HALTED | TOKEN_BABBLE;
                    done = true;
                    break;
                }
                moved = result.length;
                if(moved && !this.write_buffer(overlay, page, offset, result)) { error = TOKEN_HALTED | TOKEN_BUFFER_ERROR; done = true; break; }
            }
            progress = true;
            if(!limit) this.async_bytes -= Math.max(moved, 64);
            // the bytes on, the page and offset on, the data toggle over
            bytes -= Math.min(bytes, moved);
            offset += moved;
            page += offset >> 12;
            offset &= 0xFFF;
            token = (token ^ TOKEN_DT) >>> 0;
            if(pid === PID_IN && moved < length) short = true;
            if(!bytes || short || pid === PID_SETUP) done = true;
        }
        token = (token & ~(0x7FFF << 16 | 7 << 12) | bytes << 16 | (page & 7) << 12) >>> 0;
        overlay[4] = (overlay[4] & ~0xFFF | offset) >>> 0;
        if(done)
        {
            token = (token & ~TOKEN_ACTIVE | error) >>> 0;
            overlay[3] = token;
            this.write_overlay(qh, overlay);
            // the qTD's token, as it ended
            this.dma_write32(this.address(overlay[0] + 8), token);
            if(token & TOKEN_IOC || short) this.interrupts |= STS_USBINT;
            if(error) this.interrupts |= STS_USBERRINT;
            if(error) break;
            continue;
        }
        overlay[3] = token;
        this.write_overlay(qh, overlay);
        break;
    }
    return progress;
};

/**
 * The overlay into the queue head (dwords 3 to 16)
 * @param {number} qh
 * @param {!Array<number>} overlay
 */
EHCIController.prototype.write_overlay = function(qh, overlay)
{
    const bytes = new Uint8Array(overlay.length * 4);
    const view = new DataView(bytes.buffer);
    overlay.forEach((value, i) => view.setUint32(4 * i, value >>> 0, true));
    this.dma_write(bytes, this.address(qh + 12));
};

/**
 * The guest memory of a qTD's buffer at its page and offset
 * @param {!Array<number>} overlay
 * @param {number} page
 * @return {number} -1 past the fifth page
 */
EHCIController.prototype.buffer_address = function(overlay, page)
{
    if(page > 4) return -1;
    return (overlay[9 + page] >>> 0) * 0x100000000 + ((overlay[4 + page] & ~0xFFF) >>> 0);
};

/**
 * @param {!Array<number>} overlay
 * @param {number} page
 * @param {number} offset
 * @param {number} length
 * @return {Uint8Array}
 */
EHCIController.prototype.read_buffer = function(overlay, page, offset, length)
{
    const data = new Uint8Array(length);
    for(let at = 0; at < length;)
    {
        const base = this.buffer_address(overlay, page);
        if(base < 0) return null;
        const n = Math.min(length - at, 0x1000 - offset);
        const part = this.dma_read(base + offset, n);
        if(!part) return null;
        data.set(part, at);
        at += n;
        page++;
        offset = 0;
    }
    return data;
};

/**
 * @param {!Array<number>} overlay
 * @param {number} page
 * @param {number} offset
 * @param {!Uint8Array} data
 * @return {boolean}
 */
EHCIController.prototype.write_buffer = function(overlay, page, offset, data)
{
    for(let at = 0; at < data.length;)
    {
        const base = this.buffer_address(overlay, page);
        if(base < 0) return false;
        const n = Math.min(data.length - at, 0x1000 - offset);
        if(!this.dma_write(data.subarray(at, at + n), base + offset)) return false;
        at += n;
        page++;
        offset = 0;
    }
    return true;
};

/**
 * A schedule outside memory: the controller stops (host system error)
 * @return {boolean} false
 */
EHCIController.prototype.host_error = function()
{
    dbg_log("ehci: schedule outside memory (async " + h(this.async_address >>> 0, 8) + ", periodic " + h(this.periodic_base >>> 0, 8) + ")", LOG_PCI);
    this.status |= STS_HSE | STS_HALTED;
    this.cmd &= ~CMD_RS;
    this.update_irq();
    return false;
};

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array}
 */
EHCIController.prototype.dma_read = function(address, length)
{
    try { return this.machine.read_physical(address, length); }
    catch(e) { return null; }
};

/**
 * @param {number} address
 * @return {?number}
 */
EHCIController.prototype.dma_read32 = function(address)
{
    try { return this.machine.read32_physical(address) >>> 0; }
    catch(e) { return null; }
};

/**
 * @param {number} address
 * @param {number} value
 */
EHCIController.prototype.dma_write32 = function(address, value)
{
    try { this.machine.write32_physical(address, value | 0); }
    catch(e) { dbg_log("ehci: write outside memory at " + h(address >>> 0, 8), LOG_PCI); }
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} address
 * @return {boolean}
 */
EHCIController.prototype.dma_write = function(bytes, address)
{
    try { this.machine.write_physical(bytes, address); return true; }
    catch(e) { dbg_log("ehci: write outside memory at " + h(address >>> 0, 8), LOG_PCI); return false; }
};

EHCIController.prototype.get_state = function()
{
    const now = this.machine.now();
    return [this.cmd, this.status, this.intr, this.frindex, this.segment, this.periodic_base, this.async_address, this.configflag,
        this.portsc.slice(), this.next_ms - now, +this.irq_level, 0, this.bar0, this.companions.map(companion => companion.get_state())];
};

EHCIController.prototype.set_state = function(state)
{
    this.cmd = state[0];
    this.status = state[1];
    this.intr = state[2];
    this.frindex = state[3];
    this.segment = state[4];
    this.periodic_base = state[5];
    this.async_address = state[6];
    this.configflag = state[7];
    this.portsc = state[8].slice();
    this.next_ms = this.machine.now() + state[9];
    this.irq_level = !!state[10];
    if(this.irq_level) this.machine.raise_irq();
    else this.machine.lower_irq();
    this.bar0 = state[12];
    this.update_decode();
    state[13].forEach((companion, i) => this.companions[i].set_state(companion));
};
