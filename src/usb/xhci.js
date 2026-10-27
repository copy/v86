// An xHCI USB 3 host controller (eXtensible Host Controller Interface 1.2),
// as QEMU's qemu-xhci (1B36:000D, class 0C/03/30): Windows 8 and later bind
// usbxhci.inf by the class, Linux xhci-pci. Four physical ports, each a USB 3
// root port (1 to 4: a SuperSpeed device) and a USB 2 one (5 to 8: the
// others), 32 device slots, one interrupter (single-vector MSI, or INTA),
// 32-byte contexts, 4 KiB pages, no scratchpad, 64-bit addresses. BAR0 is
// 16 KiB of memory (32-bit: v86's PC host has no 64-bit BARs): the
// capability registers, the operational ones with the ports at 0x400, the
// runtime ones at 0x1000, the doorbells at 0x2000, the extended
// capabilities at 0x3000 (USB legacy support, the two supported protocols).
//
// The driver gives the controller rings of TRBs in guest memory: the
// command ring (doorbell 0, executed at once: slots, contexts, endpoints),
// a transfer ring per endpoint (its doorbell starts it: TDs of Setup, Data,
// Status, Normal and Event Data TRBs, each transaction with the device at
// the slot's port, max packet at a time), and an event ring the controller
// writes (command completions, transfer events, port status changes).
// Transfers a device NAKs are tried again each millisecond of the machine
// clock, as are endpoints with more to do than a doorbell's budget. Not
// emulated: hubs (route strings), streams, isochronous transfers, U1/U2,
// the debug capability, more interrupters, MSI-X.

import { LOG_PCI } from "../const.js";
import { h } from "../lib.js";
import { dbg_log } from "../log.js";
import { PID_IN, PID_OUT, PID_SETUP, SPEED_FULL, SPEED_HIGH, SPEED_LOW, SPEED_SUPER, USB_NAK, USB_STALL } from "./usb.js";

const MMIO_SIZE = 0x4000;
const OP = 0x40, PORTS_BASE = OP + 0x400, RUNTIME = 0x1000, DOORBELLS = 0x2000, XECP = 0x3000;
/** Physical ports: each a USB 3 root port (1 to 4) and a USB 2 one (5 to 8) */
export const XHCI_PORTS = 4;
const ROOT_PORTS = 2 * XHCI_PORTS, USB3_FIRST = 1, USB2_FIRST = XHCI_PORTS + 1;
const MAX_SLOTS = 32;

const PCI_VENDOR = 0x1B36, PCI_DEVICE = 0x000D, PCI_REVISION = 0x01;
const PCI_SUBSYSTEM_VENDOR = 0x1AF4, PCI_SUBSYSTEM = 0x1100;
const PM_CAP = 0x50, MSI_CAP = 0x70;
// power management 1.2, D0 and D3hot
const PM_PMC = 0x0003;

// capability registers: 32 slots, 1 interrupter, 8 ports; IST (a frame),
// one event ring segment, no scratchpad; 64-bit, 32-byte contexts, the
// extended capabilities
const HCSPARAMS1 = MAX_SLOTS | 1 << 8 | ROOT_PORTS << 24;
const HCSPARAMS2 = 0x0000000F;
const HCCPARAMS1 = 1 | (XECP >> 2) << 16;
// extended capabilities: USB legacy support, then USB 3 and USB 2
const LEGSUP_BIOS_OWNED = 1 << 16, LEGSUP_OS_OWNED = 1 << 24;
const EXTENDED = [
    [1 | 4 << 8, 0],
    [2 | 4 << 8 | 0x03 << 24, 0x20425355, USB3_FIRST | XHCI_PORTS << 8, 0],
    [2 | 0x02 << 24, 0x20425355, USB2_FIRST | XHCI_PORTS << 8, 0],
];

// operational registers (from OP)
const R_USBCMD = 0x00, R_USBSTS = 0x04, R_PAGESIZE = 0x08, R_DNCTRL = 0x14, R_CRCR = 0x18, R_CRCR_HIGH = 0x1C, R_DCBAAP = 0x30,
    R_DCBAAP_HIGH = 0x34, R_CONFIG = 0x38;
const CMD_RS = 1 << 0, CMD_HCRST = 1 << 1, CMD_INTE = 1 << 2, CMD_CSS = 1 << 8, CMD_CRS = 1 << 9, CMD_MASK = 0x3F0F;
const STS_HCH = 1 << 0, STS_HSE = 1 << 2, STS_EINT = 1 << 3, STS_PCD = 1 << 4, STS_SRE = 1 << 10, STS_HCE = 1 << 12;
const CRCR_RCS = 1 << 0, CRCR_CS = 1 << 1, CRCR_CA = 1 << 2, CRCR_CRR = 1 << 3;

// PORTSC
const PORT_CCS = 1 << 0, PORT_PED = 1 << 1, PORT_PR = 1 << 4, PORT_PLS_SHIFT = 5, PORT_PLS = 0xF << PORT_PLS_SHIFT, PORT_PP = 1 << 9,
    PORT_SPEED_SHIFT = 10, PORT_LWS = 1 << 16, PORT_CSC = 1 << 17, PORT_PEC = 1 << 18, PORT_WRC = 1 << 19, PORT_OCC = 1 << 20,
    PORT_PRC = 1 << 21, PORT_PLC = 1 << 22, PORT_CEC = 1 << 23, PORT_WAKE = 7 << 25, PORT_WPR = 1 << 31;
const PORT_CHANGES = PORT_CSC | PORT_PEC | PORT_WRC | PORT_OCC | PORT_PRC | PORT_PLC | PORT_CEC;
// link states
const PLS_U0 = 0, PLS_U3 = 3, PLS_DISABLED = 4, PLS_RX_DETECT = 5, PLS_POLLING = 7, PLS_RESUME = 15;
// the port's speed IDs by the device's speed (low, full, high, super)
const SPEED_IDS = [2, 1, 3, 4];

// runtime registers: MFINDEX, interrupter 0 (IMAN, IMOD, ERSTSZ, ERSTBA, ERDP)
const IMAN_IP = 1 << 0, IMAN_IE = 1 << 1;
const ERDP_EHB = 1 << 3;

// TRBs
const TRB_CYCLE = 1 << 0, TRB_TC = 1 << 1, TRB_ENT = 1 << 1, TRB_ISP = 1 << 2, TRB_CH = 1 << 4, TRB_IOC = 1 << 5, TRB_IDT = 1 << 6,
    TRB_BSR = 1 << 9, TRB_DC = 1 << 9, TRB_DIR_IN = 1 << 16;
const TRB_NORMAL = 1, TRB_SETUP = 2, TRB_DATA = 3, TRB_STATUS = 4, TRB_ISOCH = 5, TRB_LINK = 6, TRB_EVENT_DATA = 7, TRB_NOOP = 8,
    CMD_ENABLE_SLOT = 9, CMD_DISABLE_SLOT = 10, CMD_ADDRESS_DEVICE = 11, CMD_CONFIGURE_ENDPOINT = 12, CMD_EVALUATE_CONTEXT = 13,
    CMD_RESET_ENDPOINT = 14, CMD_STOP_ENDPOINT = 15, CMD_SET_TR_DEQUEUE = 16, CMD_RESET_DEVICE = 17, CMD_GET_PORT_BANDWIDTH = 21,
    CMD_NOOP = 23, EVENT_TRANSFER = 32, EVENT_COMMAND = 33, EVENT_PORT = 34, EVENT_HOST = 37;
// completion codes
const CC_SUCCESS = 1, CC_DATA_BUFFER = 2, CC_BABBLE = 3, CC_TRANSACTION = 4, CC_TRB = 5, CC_STALL = 6, CC_NO_SLOTS = 9,
    CC_SLOT_NOT_ENABLED = 11, CC_EP_NOT_ENABLED = 12, CC_SHORT_PACKET = 13, CC_PARAMETER = 17, CC_CONTEXT_STATE = 19,
    CC_EVENT_RING_FULL = 21, CC_COMMAND_RING_STOPPED = 24, CC_STOPPED = 26;
// slot and endpoint states
const SLOT_DEFAULT = 1, SLOT_ADDRESSED = 2, SLOT_CONFIGURED = 3;
const EP_DISABLED = 0, EP_RUNNING = 1, EP_HALTED = 2, EP_STOPPED = 3;
// endpoint types (an endpoint context's): 4 control; 1, 5 isochronous
const EP_CONTROL = 4, EP_ISOCH_OUT = 1, EP_ISOCH_IN = 5;

// a doorbell's budget of bytes, a millisecond's; links followed in a row; TRBs of a TD
const DOORBELL_BYTES = 64 * 1024, MS_BYTES = 1024 * 1024, LINK_LIMIT = 32, TD_TRBS = 512;

/**
 * @constructor
 * @param {!Object} machine the plugin's machine (src/usb/machine.js)
 */
export function XHCIController(machine)
{
    this.machine = machine;
    this.name = "xhci";
    /** @type {!Array<?Object>} the device in each physical port */
    this.devices = new Array(XHCI_PORTS).fill(null);
    this.irq_level = false;
    this.bar0 = 0;
    this.mmio = -1;
    this.legsup = LEGSUP_BIOS_OWNED;
    this.reset();

    const space = create_pci_space();
    machine.msi_capability(0).forEach((byte, i) => { space[MSI_CAP + i] = byte; });
    machine.register_pci({
        pci_space: space,
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
    // status: a capabilities list
    put16(0x06, 0x0010);
    space[0x08] = PCI_REVISION;
    // class 0C/03/30: an xHCI USB controller
    space[0x09] = 0x30;
    space[0x0A] = 0x03;
    space[0x0B] = 0x0C;
    put16(0x2C, PCI_SUBSYSTEM_VENDOR);
    put16(0x2E, PCI_SUBSYSTEM);
    space[0x34] = PM_CAP;
    space[0x3D] = 1;
    // SBRN: USB 3.0; FLADJ
    space[0x60] = 0x30;
    space[0x61] = 0x20;
    space[PM_CAP] = 0x01;
    space[PM_CAP + 1] = MSI_CAP;
    put16(PM_CAP + 2, PM_PMC);
    return space;
}

/** The capabilities keep their read-only bytes after the driver's writes */
XHCIController.prototype.config_written = function(offset, size)
{
    if(offset < MSI_CAP + 14 && offset + size > MSI_CAP)
    {
        this.machine.msi_config_written(MSI_CAP, 0);
        // (MSI on releases INTA; off may need it)
        this.update_irq();
    }
    if(offset < PM_CAP + 8 && offset + size > PM_CAP)
    {
        const space = this.machine.pci_config();
        const pmcsr = (space[PM_CAP + 4] | space[PM_CAP + 5] << 8) & 0x0103;
        space.set([0x01, MSI_CAP, PM_PMC & 0xFF, PM_PMC >> 8, pmcsr & 0xFF, pmcsr >> 8, 0, 0], PM_CAP);
    }
};

XHCIController.prototype.update_decode = function()
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

/** Everything to its reset value (power on, HCRST): slots disabled, the ports as their devices are */
XHCIController.prototype.reset = function()
{
    this.cmd = 0;
    this.status = STS_HCH;
    this.dnctrl = 0;
    this.crcr = [0, 0];
    /** the command ring: where the next command is, its cycle state, whether it runs */
    this.command_ring = { dequeue: 0, ccs: 1 };
    this.crr = false;
    this.dcbaap = [0, 0];
    this.config = 0;
    /** the interrupter's registers, the event ring (its one segment), where the next event goes */
    this.iman = 0;
    this.imod = 0;
    this.erstsz = 0;
    this.erstba = [0, 0];
    this.erdp = [0, 0];
    this.event_ring = { start: 0, size: 0, enqueue: 0, pcs: 1 };
    /** the time MFINDEX counts from; the next millisecond's transfers */
    this.mf_start = this.machine.now();
    this.next_ms = 0;
    this.budget = 0;
    /** @type {!Array<?Object>} slots 1 to MAX_SLOTS (index 0 unused) */
    this.slots = new Array(MAX_SLOTS + 1).fill(null);
    /** endpoints with transfers to go on with: "slot:dci" */
    this.active = new Set();
    this.portsc = new Array(ROOT_PORTS + 1).fill(0);
    for(let port = 0; port < XHCI_PORTS; port++) this.update_port(port, false);
    this.update_irq();
};

/** A machine reset (PCIRST#) */
XHCIController.prototype.reset_all = function()
{
    this.legsup = LEGSUP_BIOS_OWNED;
    this.reset();
    this.update_decode();
};

// ports

/**
 * The root port a physical port's device is on: USB 3 for a SuperSpeed device, USB 2 for the others
 * @param {number} port
 * @param {?Object} device
 * @return {number}
 */
function root_port(port, device)
{
    return device && device.speeds.includes(SPEED_SUPER) ? USB3_FIRST + port : USB2_FIRST + port;
}

/**
 * A physical port's root ports as its device has them: the one with the
 * device connected (a SuperSpeed device's link up and the port enabled at
 * once; the others polling, enabled by a port reset), the other empty
 * @param {number} port
 * @param {boolean} notify a Port Status Change Event where the connection changed
 */
XHCIController.prototype.update_port = function(port, notify)
{
    const device = this.devices[port];
    for(const root of [USB3_FIRST + port, USB2_FIRST + port])
    {
        const connected = !!device && root === root_port(port, device);
        const before = this.portsc[root];
        let value = PORT_PP | before & PORT_WAKE;
        if(connected)
        {
            const speed = root < USB2_FIRST ? SPEED_SUPER : device.speeds.includes(SPEED_HIGH) ? SPEED_HIGH :
                device.speeds.includes(SPEED_FULL) ? SPEED_FULL : SPEED_LOW;
            device.set_speed(speed);
            value |= PORT_CCS | SPEED_IDS[speed] << PORT_SPEED_SHIFT;
            value |= speed === SPEED_SUPER ? PORT_PED | PLS_U0 << PORT_PLS_SHIFT : PLS_POLLING << PORT_PLS_SHIFT;
        }
        else
        {
            value |= (root < USB2_FIRST ? PLS_RX_DETECT : PLS_DISABLED) << PORT_PLS_SHIFT;
        }
        if(!!(before & PORT_CCS) !== connected) value |= PORT_CSC;
        this.portsc[root] = value | before & PORT_CHANGES;
        if(notify && value & PORT_CSC) this.port_event(root);
    }
};

/**
 * Plug a device into a physical port (or take it out: null): its slot's
 * transfers end
 * @param {number} port
 * @param {?Object} device
 */
XHCIController.prototype.attach = function(port, device)
{
    if(this.devices[port])
    {
        for(const slot of this.slots) if(slot && slot.port === port) slot.gone = true;
    }
    this.devices[port] = device;
    if(device) device.reset();
    this.update_port(port, true);
};

/**
 * @param {number} port
 * @return {boolean} whether the physical port has a device connected
 */
XHCIController.prototype.port_connected = function(port)
{
    return !!((this.portsc[USB3_FIRST + port] | this.portsc[USB2_FIRST + port]) & PORT_CCS);
};

/** @param {number} root a Port Status Change Event (while running) */
XHCIController.prototype.port_event = function(root)
{
    this.status |= STS_PCD;
    if(!(this.status & STS_HCH)) this.event(root << 24, 0, CC_SUCCESS << 24, EVENT_PORT << 10);
};

/**
 * PORTSC written: change bits cleared, a reset, the link state, the port disabled
 * @param {number} root
 * @param {number} value
 */
XHCIController.prototype.write_port = function(root, value)
{
    const port = (root - 1) % XHCI_PORTS;
    const device = this.devices[port];
    const here = device && root === root_port(port, device);
    if(value & (PORT_PR | PORT_WPR))
    {
        // a reset (a warm one: USB 3's): the device to its default state, the link up, enabled
        if(here)
        {
            device.reset();
            this.portsc[root] = this.portsc[root] & ~(PORT_PLS | PORT_PR) | PLS_U0 << PORT_PLS_SHIFT | PORT_PED | PORT_PRC |
                (value & PORT_WPR && root < USB2_FIRST ? PORT_WRC : 0);
            this.port_event(root);
        }
        return;
    }
    let portsc = this.portsc[root] & ~(value & PORT_CHANGES);
    // (PED written 1: the driver disables the port)
    if(value & PORT_PED) portsc &= ~PORT_PED;
    if(value & PORT_LWS)
    {
        const pls = value >> PORT_PLS_SHIFT & 0xF, before = portsc >> PORT_PLS_SHIFT & 0xF;
        // suspend (U3) and resume (U0: Port Link State Change); the others are not the driver's
        if(pls === PLS_U3 && before === PLS_U0) portsc = portsc & ~PORT_PLS | PLS_U3 << PORT_PLS_SHIFT;
        else if((pls === PLS_U0 || pls === PLS_RESUME) && before === PLS_U3)
        {
            portsc = portsc & ~PORT_PLS | PLS_U0 << PORT_PLS_SHIFT | PORT_PLC;
            this.portsc[root] = portsc;
            this.port_event(root);
            return;
        }
    }
    this.portsc[root] = portsc & ~PORT_WAKE | value & PORT_WAKE;
};

// registers

/**
 * A register's value
 * @param {number} offset its first byte
 * @return {number}
 */
XHCIController.prototype.register = function(offset)
{
    if(offset < OP)
    {
        switch(offset)
        {
            // CAPLENGTH, HCIVERSION 1.0
            case 0x00: return OP | 0x0100 << 16;
            case 0x04: return HCSPARAMS1;
            case 0x08: return HCSPARAMS2;
            case 0x10: return HCCPARAMS1;
            case 0x14: return DOORBELLS;
            case 0x18: return RUNTIME;
        }
        return 0;
    }
    if(offset >= PORTS_BASE && offset < PORTS_BASE + 0x10 * ROOT_PORTS)
    {
        return (offset & 0xF) === 0 ? this.portsc[(offset - PORTS_BASE >> 4) + 1] : 0;
    }
    if(offset < RUNTIME)
    {
        switch(offset - OP)
        {
            case R_USBCMD: return this.cmd;
            case R_USBSTS: return this.status;
            // 4 KiB pages
            case R_PAGESIZE: return 1;
            case R_DNCTRL: return this.dnctrl;
            case R_CRCR: return this.crr ? CRCR_CRR : 0;
            case R_CRCR_HIGH: return 0;
            case R_DCBAAP: return this.dcbaap[0];
            case R_DCBAAP_HIGH: return this.dcbaap[1];
            case R_CONFIG: return this.config;
        }
        return 0;
    }
    if(offset < DOORBELLS)
    {
        switch(offset - RUNTIME)
        {
            case 0x00: return this.mfindex();
            case 0x20: return this.iman;
            case 0x24: return this.imod;
            case 0x28: return this.erstsz;
            case 0x30: return this.erstba[0];
            case 0x34: return this.erstba[1];
            case 0x38: return this.erdp[0];
            case 0x3C: return this.erdp[1];
        }
        return 0;
    }
    if(offset >= XECP && offset < XECP + 16 * EXTENDED.length)
    {
        const capability = EXTENDED[offset - XECP >> 4];
        const word = (offset & 0xF) >> 2;
        // (USB legacy support: its semaphores)
        if(offset === XECP) return (capability[0] | this.legsup) >>> 0;
        return word < capability.length ? capability[word] >>> 0 : 0;
    }
    // (doorbells read 0)
    return 0;
};

/** @return {number} the micro-frame index: 125 µs of the machine clock since the controller ran */
XHCIController.prototype.mfindex = function()
{
    return this.status & STS_HCH ? 0 : Math.floor((this.machine.now() - this.mf_start) * 8) & 0x3FFF;
};

/**
 * @param {number} offset
 * @param {number} size
 * @return {number}
 */
XHCIController.prototype.read = function(offset, size)
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
XHCIController.prototype.write = function(offset, size, value)
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
XHCIController.prototype.write_register = function(offset, bits, mask)
{
    const merge = old => (old & ~mask | bits & mask) >>> 0;
    if(offset >= PORTS_BASE && offset < PORTS_BASE + 0x10 * ROOT_PORTS)
    {
        if((offset & 0xF) === 0) this.write_port((offset - PORTS_BASE >> 4) + 1, merge(this.portsc[(offset - PORTS_BASE >> 4) + 1]) & ~PORT_CHANGES | bits & mask & PORT_CHANGES);
        return;
    }
    if(offset === XECP)
    {
        // the OS taking the controller from the firmware gets it at once (no USB SMI)
        this.legsup = merge(this.legsup) & (LEGSUP_BIOS_OWNED | LEGSUP_OS_OWNED);
        if(this.legsup & LEGSUP_OS_OWNED) this.legsup &= ~LEGSUP_BIOS_OWNED;
        return;
    }
    if(offset >= DOORBELLS && offset < DOORBELLS + 4 * (MAX_SLOTS + 1))
    {
        this.doorbell(offset - DOORBELLS >> 2, merge(0));
        return;
    }
    switch(offset)
    {
        case OP + R_USBCMD:
        {
            const value = merge(this.cmd);
            if(value & CMD_HCRST)
            {
                dbg_log("xhci: host controller reset", LOG_PCI);
                this.reset();
                return;
            }
            if(value & CMD_RS && this.status & STS_HCH)
            {
                this.status &= ~STS_HCH;
                this.mf_start = this.machine.now();
                this.next_ms = this.machine.now() + 1;
            }
            else if(!(value & CMD_RS) && !(this.status & STS_HCH))
            {
                this.status |= STS_HCH;
            }
            // (save and restore state: nothing to save)
            if(value & CMD_CSS) this.status &= ~STS_SRE;
            this.cmd = value & CMD_MASK & ~(CMD_CSS | CMD_CRS);
            this.update_irq();
            break;
        }
        case OP + R_USBSTS:
            this.status &= ~(bits & mask & (STS_HSE | STS_EINT | STS_PCD | STS_SRE));
            this.update_irq();
            break;
        case OP + R_DNCTRL:
            this.dnctrl = merge(this.dnctrl) & 0xFFFF;
            break;
        case OP + R_CRCR:
        {
            const value = merge(this.crcr[0]);
            if(value & (CRCR_CS | CRCR_CA) && this.crr)
            {
                // stopped (or aborted: commands run at once, none is under way)
                this.crr = false;
                this.event(this.command_ring.dequeue % 0x100000000, Math.floor(this.command_ring.dequeue / 0x100000000),
                    CC_COMMAND_RING_STOPPED << 24, EVENT_COMMAND << 10);
                break;
            }
            this.crcr[0] = value & ~0x3F | value & CRCR_RCS;
            if(!this.crr) this.command_ring = { dequeue: this.crcr[1] * 0x100000000 + ((this.crcr[0] & ~0x3F) >>> 0), ccs: value & CRCR_RCS };
            break;
        }
        case OP + R_CRCR_HIGH:
            this.crcr[1] = merge(this.crcr[1]);
            if(!this.crr) this.command_ring = { dequeue: this.crcr[1] * 0x100000000 + ((this.crcr[0] & ~0x3F) >>> 0), ccs: this.crcr[0] & CRCR_RCS };
            break;
        case OP + R_DCBAAP:
            this.dcbaap[0] = merge(this.dcbaap[0]) & ~0x3F;
            break;
        case OP + R_DCBAAP_HIGH:
            this.dcbaap[1] = merge(this.dcbaap[1]);
            break;
        case OP + R_CONFIG:
            this.config = merge(this.config) & 0x3FF;
            break;
        case RUNTIME + 0x20:
        {
            // IMAN: IP written 1 is cleared; IE
            const value = merge(this.iman);
            this.iman = this.iman & ~(value & IMAN_IP) & ~IMAN_IE | value & IMAN_IE;
            this.update_irq();
            break;
        }
        case RUNTIME + 0x24:
            this.imod = merge(this.imod);
            break;
        case RUNTIME + 0x28:
            this.erstsz = merge(this.erstsz) & 0xFFFF;
            break;
        case RUNTIME + 0x30:
            this.erstba[0] = merge(this.erstba[0]) & ~0x3F;
            this.event_ring_reset();
            break;
        case RUNTIME + 0x34:
            this.erstba[1] = merge(this.erstba[1]);
            this.event_ring_reset();
            break;
        case RUNTIME + 0x38:
        {
            // ERDP: the driver's dequeue pointer; EHB written 1 is cleared,
            // and events still to read interrupt again
            const value = merge(this.erdp[0]);
            this.erdp[0] = (value & ~ERDP_EHB | this.erdp[0] & ERDP_EHB & ~(value & ERDP_EHB)) >>> 0;
            if(value & ERDP_EHB && this.event_ring.size && this.event_dequeue() !== this.event_ring.enqueue) this.interrupt();
            break;
        }
        case RUNTIME + 0x3C:
            this.erdp[1] = merge(this.erdp[1]);
            break;
    }
};

XHCIController.prototype.update_irq = function()
{
    const msi = this.machine.msi_enabled(MSI_CAP);
    const level = !!(this.iman & IMAN_IP && this.iman & IMAN_IE && this.cmd & CMD_INTE) && !msi;
    if(level === this.irq_level) return;
    this.irq_level = level;
    if(level) this.machine.raise_irq();
    else this.machine.lower_irq();
};

// the event ring

/** The event ring's one segment from ERSTBA's first entry: events start at its beginning */
XHCIController.prototype.event_ring_reset = function()
{
    const base = this.erstba[1] * 0x100000000 + this.erstba[0];
    this.event_ring = { start: 0, size: 0, enqueue: 0, pcs: 1 };
    if(!this.erstsz || !base) return;
    const entry = this.dma_read(base, 16);
    if(!entry) return;
    const view = new DataView(entry.buffer);
    const size = view.getUint32(8, true) & 0xFFFF;
    if(size < 16 || size > 4096) return;
    this.event_ring = { start: view.getUint32(4, true) * 0x100000000 + ((view.getUint32(0, true) & ~0x3F) >>> 0), size, enqueue: 0, pcs: 1 };
};

/** @return {number} the index of the driver's dequeue pointer in the event ring */
XHCIController.prototype.event_dequeue = function()
{
    const erdp = this.erdp[1] * 0x100000000 + ((this.erdp[0] & ~0xF) >>> 0);
    return Math.floor((erdp - this.event_ring.start) / 16);
};

/**
 * Write an event TRB (its dwords) to the event ring, and interrupt. A full
 * ring drops the event; the last free entry takes an Event Ring Full Error.
 * @param {number} parameter_low
 * @param {number} parameter_high
 * @param {number} status
 * @param {number} control (no cycle bit)
 */
XHCIController.prototype.event = function(parameter_low, parameter_high, status, control)
{
    const ring = this.event_ring;
    if(!ring.size) return;
    const dequeue = this.event_dequeue();
    if(dequeue < 0 || dequeue >= ring.size)
    {
        dbg_log("xhci: the event ring's dequeue pointer outside the ring", LOG_PCI);
        this.status |= STS_HCE;
        return;
    }
    if((ring.enqueue + 1) % ring.size === dequeue) return;
    if((ring.enqueue + 2) % ring.size === dequeue)
    {
        parameter_low = parameter_high = 0;
        status = CC_EVENT_RING_FULL << 24;
        control = EVENT_HOST << 10;
    }
    const trb = new Uint8Array(16);
    const view = new DataView(trb.buffer);
    view.setUint32(0, parameter_low >>> 0, true);
    view.setUint32(4, parameter_high >>> 0, true);
    view.setUint32(8, status >>> 0, true);
    view.setUint32(12, (control | ring.pcs) >>> 0, true);
    if(!this.dma_write(trb, ring.start + 16 * ring.enqueue)) return;
    ring.enqueue++;
    if(ring.enqueue === ring.size)
    {
        ring.enqueue = 0;
        ring.pcs ^= 1;
    }
    this.interrupt();
};

/** An event for the driver: EHB, IP, EINT; an interrupt unless one is pending */
XHCIController.prototype.interrupt = function()
{
    const pending = this.erdp[0] & ERDP_EHB;
    this.erdp[0] |= ERDP_EHB;
    this.iman |= IMAN_IP;
    this.status |= STS_EINT;
    if(pending || !(this.iman & IMAN_IE) || !(this.cmd & CMD_INTE)) return;
    if(this.machine.msi_enabled(MSI_CAP))
    {
        // (a message: IP clears once it is sent)
        if(this.machine.msi_notify(MSI_CAP)) this.iman &= ~IMAN_IP;
    }
    this.update_irq();
};

// rings

/**
 * The next TRB of a ring (Link TRBs followed), or null where the driver
 * has not put one yet (its cycle bit is not the ring's)
 * @param {{dequeue: number, ccs: number}} ring advanced past it
 * @return {?{address: number, low: number, high: number, status: number, control: number, type: number, ccs: number}}
 */
XHCIController.prototype.fetch = function(ring)
{
    for(let links = 0; links < LINK_LIMIT; links++)
    {
        const bytes = this.dma_read(ring.dequeue, 16);
        if(!bytes) return null;
        const view = new DataView(bytes.buffer);
        const control = view.getUint32(12, true);
        if((control & TRB_CYCLE) !== ring.ccs) return null;
        const type = control >> 10 & 0x3F;
        const low = view.getUint32(0, true), high = view.getUint32(4, true);
        if(type === TRB_LINK)
        {
            ring.dequeue = high * 0x100000000 + ((low & ~0xF) >>> 0);
            if(control & TRB_TC) ring.ccs ^= 1;
            continue;
        }
        const trb = { address: ring.dequeue, low, high, status: view.getUint32(8, true), control, type, ccs: ring.ccs };
        ring.dequeue += 16;
        return trb;
    }
    return null;
};

// commands

/**
 * A doorbell: the command ring (0), or an endpoint of a slot's (its DCI)
 * @param {number} target
 * @param {number} value
 */
XHCIController.prototype.doorbell = function(target, value)
{
    if(this.status & STS_HCH) return;
    if(target === 0)
    {
        if(value === 0) this.run_commands();
        return;
    }
    const dci = value & 0xFF;
    if(target > MAX_SLOTS || dci < 1 || dci > 31) return;
    const slot = this.slots[target];
    if(!slot || !slot.endpoints[dci]) return;
    // (a stopped endpoint runs again; a halted one waits for Reset Endpoint)
    if(slot.endpoints[dci].state === EP_STOPPED) this.set_endpoint_state(slot, slot.endpoints[dci], EP_RUNNING);
    this.active.add(target + ":" + dci);
    this.budget = DOORBELL_BYTES;
    this.run_endpoint(slot, slot.endpoints[dci]);
};

XHCIController.prototype.run_commands = function()
{
    this.crr = true;
    for(let count = 0; count < 256; count++)
    {
        const trb = this.fetch(this.command_ring);
        if(!trb) break;
        let slot_id = trb.control >>> 24;
        let code = CC_SUCCESS;
        switch(trb.type)
        {
            case CMD_ENABLE_SLOT:
                slot_id = this.slots.findIndex((slot, i) => i > 0 && !slot);
                if(slot_id < 0) { slot_id = 0; code = CC_NO_SLOTS; }
                else this.slots[slot_id] = { port: -1, root: 0, context: 0, state: SLOT_DEFAULT, endpoints: new Array(32).fill(null), gone: false };
                break;
            case CMD_NOOP:
                slot_id = 0;
                break;
            case CMD_GET_PORT_BANDWIDTH:
                // (80% of every port free, as QEMU)
                code = this.dma_write(Uint8Array.of(0, ...new Array(ROOT_PORTS).fill(80)), trb.high * 0x100000000 + trb.low) ? CC_SUCCESS : CC_TRB;
                slot_id = 0;
                break;
            case CMD_DISABLE_SLOT: case CMD_ADDRESS_DEVICE: case CMD_CONFIGURE_ENDPOINT: case CMD_EVALUATE_CONTEXT:
            case CMD_RESET_ENDPOINT: case CMD_STOP_ENDPOINT: case CMD_SET_TR_DEQUEUE: case CMD_RESET_DEVICE:
                code = slot_id < 1 || slot_id > MAX_SLOTS ? CC_TRB : !this.slots[slot_id] ? CC_SLOT_NOT_ENABLED : this.slot_command(trb, slot_id);
                break;
            default:
                code = CC_TRB;
        }
        this.event(trb.address % 0x100000000, Math.floor(trb.address / 0x100000000), code << 24, EVENT_COMMAND << 10 | slot_id << 24);
    }
};

/**
 * A command for an enabled slot
 * @param {!Object} trb
 * @param {number} id
 * @return {number} its completion code
 */
XHCIController.prototype.slot_command = function(trb, id)
{
    const slot = this.slots[id];
    const dci = trb.control >> 16 & 0x1F;
    const pointer = trb.high * 0x100000000 + ((trb.low & ~0xF) >>> 0);
    switch(trb.type)
    {
        case CMD_DISABLE_SLOT:
            for(let i = 1; i <= 31; i++) if(slot.endpoints[i]) this.disable_endpoint(id, i);
            this.slots[id] = null;
            return CC_SUCCESS;
        case CMD_ADDRESS_DEVICE:
            return this.address_device(id, pointer, !!(trb.control & TRB_BSR));
        case CMD_CONFIGURE_ENDPOINT:
            return this.configure_endpoints(id, pointer, !!(trb.control & TRB_DC));
        case CMD_EVALUATE_CONTEXT:
            return this.evaluate_context(id, pointer);
        case CMD_RESET_ENDPOINT:
        {
            const ep = slot.endpoints[dci];
            if(!ep) return CC_EP_NOT_ENABLED;
            if(ep.state !== EP_HALTED) return CC_CONTEXT_STATE;
            ep.td = null;
            this.set_endpoint_state(slot, ep, EP_STOPPED);
            return CC_SUCCESS;
        }
        case CMD_STOP_ENDPOINT:
        {
            const ep = slot.endpoints[dci];
            if(!ep) return CC_EP_NOT_ENABLED;
            if(ep.td)
            {
                // the TD under way: a Transfer Event, Stopped, at its TRB; the ring from there
                const trb_now = ep.td.trbs[Math.min(ep.td.index, ep.td.trbs.length - 1)];
                const left = (trb_now.status & 0x1FFFF) - (ep.td.done[ep.td.index] || 0);
                this.event(trb_now.address % 0x100000000, Math.floor(trb_now.address / 0x100000000), CC_STOPPED << 24 | Math.max(0, left),
                    EVENT_TRANSFER << 10 | dci << 16 | id << 24);
                ep.ring = { dequeue: trb_now.address, ccs: trb_now.ccs };
                ep.td = null;
            }
            this.set_endpoint_state(slot, ep, EP_STOPPED);
            return CC_SUCCESS;
        }
        case CMD_SET_TR_DEQUEUE:
        {
            const ep = slot.endpoints[dci];
            if(!ep) return CC_EP_NOT_ENABLED;
            if(ep.state !== EP_STOPPED && ep.state !== EP_HALTED) return CC_CONTEXT_STATE;
            ep.ring = { dequeue: pointer, ccs: trb.low & 1 };
            ep.td = null;
            this.set_endpoint_state(slot, ep, ep.state);
            return CC_SUCCESS;
        }
        case CMD_RESET_DEVICE:
        {
            if(slot.state < SLOT_ADDRESSED) return CC_CONTEXT_STATE;
            for(let i = 2; i <= 31; i++) if(slot.endpoints[i]) this.disable_endpoint(id, i);
            const device = this.slot_device(slot);
            if(device) device.reset();
            slot.state = SLOT_DEFAULT;
            this.write_slot_state(slot, SLOT_DEFAULT, 0, 1);
            return CC_SUCCESS;
        }
    }
    return CC_TRB;
};

/**
 * The device a slot was addressed to (still in its port)
 * @param {!Object} slot
 * @return {?Object}
 */
XHCIController.prototype.slot_device = function(slot)
{
    if(slot.port < 0 || slot.gone) return null;
    const device = this.devices[slot.port];
    return device && root_port(slot.port, device) === slot.root && this.portsc[slot.root] & PORT_PED ? device : null;
};

/**
 * Address Device: the input context's slot and endpoint 0 into the output
 * context (DCBAA's entry); the device's address the slot's ID (BSR: not
 * yet: the default state)
 * @param {number} id
 * @param {number} input
 * @param {boolean} bsr
 * @return {number}
 */
XHCIController.prototype.address_device = function(id, input, bsr)
{
    const slot = this.slots[id];
    const control = this.dma_read(input, 8);
    const words = this.dma_read(input + 32, 32 + 32);
    const entry = this.dma_read(this.dcbaap[1] * 0x100000000 + this.dcbaap[0] + 8 * id, 8);
    if(!control || !words || !entry) return CC_TRB;
    const c = new DataView(control.buffer), w = new DataView(words.buffer), e = new DataView(entry.buffer);
    if(c.getUint32(0, true) !== 0 || (c.getUint32(4, true) & 3) !== 3) return CC_TRB;
    const slot_context = [0, 1, 2, 3].map(i => w.getUint32(4 * i, true));
    const ep0 = [0, 1, 2, 3, 4].map(i => w.getUint32(32 + 4 * i, true));
    // the root port (no hubs: no route string)
    const root = slot_context[1] >>> 16 & 0xFF;
    if(root < 1 || root > ROOT_PORTS || slot_context[0] & 0xFFFFF) return CC_PARAMETER;
    const port = (root - 1) % XHCI_PORTS;
    const device = this.devices[port];
    if(!device || root_port(port, device) !== root || !(this.portsc[root] & PORT_PED)) return CC_TRANSACTION;
    if(this.slots.some((other, i) => other && i !== id && other.port === port && !other.gone && other.state >= SLOT_ADDRESSED)) return CC_TRB;
    slot.port = port;
    slot.root = root;
    slot.gone = false;
    slot.context = e.getUint32(4, true) * 0x100000000 + ((e.getUint32(0, true) & ~0x3F) >>> 0);
    device.reset();
    if(!bsr)
    {
        // SET_ADDRESS to the slot's ID
        device.transaction(PID_SETUP, 0, Uint8Array.of(0x00, 0x05, id, 0, 0, 0, 0, 0), 8);
        device.transaction(PID_IN, 0, null, 0);
    }
    slot.state = bsr ? SLOT_DEFAULT : SLOT_ADDRESSED;
    slot_context[3] = slot.state << 27 | (bsr ? 0 : id);
    this.write_dwords(slot.context, slot_context);
    if(slot.endpoints[1]) this.disable_endpoint(id, 1);
    this.enable_endpoint(slot, 1, ep0);
    return CC_SUCCESS;
};

/**
 * Configure Endpoint: the endpoints the input context drops and adds
 * (DC: every endpoint but 0 dropped, back to Addressed)
 * @param {number} id
 * @param {number} input
 * @param {boolean} deconfigure
 * @return {number}
 */
XHCIController.prototype.configure_endpoints = function(id, input, deconfigure)
{
    const slot = this.slots[id];
    if(slot.state < SLOT_ADDRESSED) return CC_CONTEXT_STATE;
    if(deconfigure)
    {
        for(let i = 2; i <= 31; i++) if(slot.endpoints[i]) this.disable_endpoint(id, i);
        slot.state = SLOT_ADDRESSED;
        this.write_slot_state(slot, SLOT_ADDRESSED, id, -1);
        return CC_SUCCESS;
    }
    const bytes = this.dma_read(input, 32 * 33);
    if(!bytes) return CC_TRB;
    const view = new DataView(bytes.buffer);
    const drop = view.getUint32(0, true), add = view.getUint32(4, true);
    if(drop & 3 || (add & 3) !== 1) return CC_TRB;
    for(let i = 2; i <= 31; i++)
    {
        if(drop & 1 << i || add & 1 << i) this.disable_endpoint(id, i);
        if(add & 1 << i)
        {
            const context = [0, 1, 2, 3, 4].map(k => view.getUint32(32 * (i + 1) + 4 * k, true));
            const type = context[1] >> 3 & 7;
            if(type === EP_ISOCH_OUT || type === EP_ISOCH_IN || type === 0) return CC_PARAMETER;
            this.enable_endpoint(slot, i, context);
        }
    }
    // the slot: its context entries, configured
    const entries = view.getUint32(32, true) >>> 27;
    const any = slot.endpoints.some((ep, i) => ep && i > 1);
    slot.state = any ? SLOT_CONFIGURED : SLOT_ADDRESSED;
    this.write_slot_state(slot, slot.state, id, entries);
    return CC_SUCCESS;
};

/**
 * Evaluate Context: the slot's max exit latency and interrupter, endpoint 0's max packet
 * @param {number} id
 * @param {number} input
 * @return {number}
 */
XHCIController.prototype.evaluate_context = function(id, input)
{
    const slot = this.slots[id];
    const bytes = this.dma_read(input, 96);
    const output = this.dma_read(slot.context, 64);
    if(!bytes || !output || !slot.context) return CC_TRB;
    const view = new DataView(bytes.buffer), out = new DataView(output.buffer);
    const drop = view.getUint32(0, true), add = view.getUint32(4, true);
    if(drop || add & ~3) return CC_TRB;
    if(add & 1)
    {
        out.setUint32(4, (out.getUint32(4, true) & ~0xFFFF | view.getUint32(32 + 4, true) & 0xFFFF) >>> 0, true);
        out.setUint32(8, (out.getUint32(8, true) & 0x3FFFFF | view.getUint32(32 + 8, true) & ~0x3FFFFF) >>> 0, true);
    }
    if(add & 2)
    {
        const max_packet = view.getUint32(64 + 4, true) >>> 16;
        out.setUint32(32 + 4, (out.getUint32(32 + 4, true) & 0xFFFF | max_packet << 16) >>> 0, true);
        if(slot.endpoints[1]) slot.endpoints[1].max_packet = max_packet;
    }
    this.dma_write(output, slot.context);
    return CC_SUCCESS;
};

/**
 * @param {!Object} slot
 * @param {number} dci
 * @param {!Array<number>} context the input endpoint context's five dwords
 */
XHCIController.prototype.enable_endpoint = function(slot, dci, context)
{
    const ep = {
        dci,
        type: context[1] >> 3 & 7,
        max_packet: context[1] >>> 16,
        interval: context[0] >> 16 & 0xFF,
        ring: { dequeue: context[3] * 0x100000000 + ((context[2] & ~0xF) >>> 0), ccs: context[2] & 1 },
        state: EP_RUNNING,
        /** @type {Object} the TD under way */
        td: null,
    };
    slot.endpoints[dci] = ep;
    context[0] = context[0] & ~7 | EP_RUNNING;
    this.write_dwords(slot.context + 32 * dci, context);
};

/**
 * @param {number} id
 * @param {number} dci
 */
XHCIController.prototype.disable_endpoint = function(id, dci)
{
    const slot = this.slots[id];
    const ep = slot.endpoints[dci];
    if(!ep) return;
    this.set_endpoint_state(slot, ep, EP_DISABLED);
    slot.endpoints[dci] = null;
    this.active.delete(id + ":" + dci);
};

/**
 * An endpoint's state and dequeue pointer into its output context
 * @param {!Object} slot
 * @param {!Object} ep
 * @param {number} state
 */
XHCIController.prototype.set_endpoint_state = function(slot, ep, state)
{
    ep.state = state;
    if(!slot.context) return;
    const at = slot.context + 32 * ep.dci;
    const bytes = this.dma_read(at, 16);
    if(!bytes) return;
    const view = new DataView(bytes.buffer);
    view.setUint32(0, (view.getUint32(0, true) & ~7 | state) >>> 0, true);
    view.setUint32(8, (ep.ring.dequeue % 0x100000000 & ~0xF | ep.ring.ccs) >>> 0, true);
    view.setUint32(12, Math.floor(ep.ring.dequeue / 0x100000000), true);
    this.dma_write(bytes, at);
};

/**
 * The slot context's state, address and context entries (-1: kept)
 * @param {!Object} slot
 * @param {number} state
 * @param {number} address
 * @param {number} entries
 */
XHCIController.prototype.write_slot_state = function(slot, state, address, entries)
{
    if(!slot.context) return;
    const bytes = this.dma_read(slot.context, 16);
    if(!bytes) return;
    const view = new DataView(bytes.buffer);
    if(entries >= 0) view.setUint32(0, (view.getUint32(0, true) & 0x7FFFFFF | entries << 27) >>> 0, true);
    view.setUint32(12, (state << 27 | address & 0xFF) >>> 0, true);
    this.dma_write(bytes, slot.context);
};

// transfers

/**
 * An endpoint's TDs while it runs and the budget lasts; one a device NAKs
 * waits (the endpoint stays active: the timer tries again)
 * @param {!Object} slot
 * @param {!Object} ep
 */
XHCIController.prototype.run_endpoint = function(slot, ep)
{
    const key = this.slots.indexOf(slot) + ":" + ep.dci;
    for(let tds = 0; tds < 256 && this.budget > 0; tds++)
    {
        if(ep.state !== EP_RUNNING) { this.active.delete(key); return; }
        if(!ep.td)
        {
            ep.td = this.fetch_td(ep);
            if(!ep.td) { this.active.delete(key); return; }
        }
        if(!this.run_td(slot, ep)) return;
        ep.td = null;
    }
};

/**
 * The next TD of an endpoint's ring: its TRBs (to the last without the chain
 * bit; a control transfer's Setup to its Status, and an Event Data chained
 * after it), or null where it is not all there yet
 * @param {!Object} ep
 * @return {Object}
 */
XHCIController.prototype.fetch_td = function(ep)
{
    const ring = { dequeue: ep.ring.dequeue, ccs: ep.ring.ccs };
    const trbs = [];
    let status = false;
    while(trbs.length < TD_TRBS)
    {
        const trb = this.fetch(ring);
        if(!trb) return null;
        trbs.push(trb);
        // (a control transfer: until its Status stage and what is chained to it)
        if(trb.type === TRB_STATUS) status = true;
        if(ep.type === EP_CONTROL && !status) continue;
        if(!(trb.control & TRB_CH)) break;
    }
    return { trbs, index: 0, offset: 0, done: trbs.map(() => 0), short: -1, error: 0, error_index: -1, after: ring };
};

/**
 * A TD's transactions from where it was: true once it is over (its events
 * written, the ring past it, or the endpoint halted), false while the
 * device NAKs
 * @param {!Object} slot
 * @param {!Object} ep
 * @return {boolean}
 */
XHCIController.prototype.run_td = function(slot, ep)
{
    const td = ep.td;
    const device = this.slot_device(slot);
    const endpoint = ep.dci >> 1;
    for(; td.index < td.trbs.length && !td.error; td.index++)
    {
        const trb = td.trbs[td.index];
        if(trb.type === TRB_EVENT_DATA || trb.type === TRB_NOOP) continue;
        // (after a short packet the TD's data is over; a control transfer's Status stage still runs)
        if(td.short >= 0 && (trb.type === TRB_NORMAL || trb.type === TRB_DATA)) continue;
        if(trb.type === TRB_ISOCH || trb.type !== TRB_NORMAL && trb.type !== TRB_SETUP && trb.type !== TRB_DATA && trb.type !== TRB_STATUS)
        {
            td.error = CC_TRB;
            break;
        }
        if(!device)
        {
            td.error = CC_TRANSACTION;
            break;
        }
        if(trb.type === TRB_SETUP)
        {
            // (immediate data: the request's eight bytes)
            const setup = new Uint8Array(8);
            new DataView(setup.buffer).setUint32(0, trb.low, true);
            new DataView(setup.buffer).setUint32(4, trb.high, true);
            const result = device.transaction(PID_SETUP, 0, setup, 8);
            if(result === USB_NAK) return false;
            if(result === USB_STALL) { td.error = CC_STALL; break; }
            td.done[td.index] = 8;
            continue;
        }
        if(trb.type === TRB_STATUS)
        {
            // the status stage: no data, the other way from the data stage
            const result = trb.control & TRB_DIR_IN ? device.transaction(PID_IN, 0, null, 0) : device.transaction(PID_OUT, 0, new Uint8Array(0), 0);
            if(result === USB_NAK) return false;
            if(result === USB_STALL) { td.error = CC_STALL; break; }
            continue;
        }
        const length = trb.status & 0x1FFFF;
        const into = trb.type === TRB_DATA ? !!(trb.control & TRB_DIR_IN) : !!(ep.dci & 1);
        const buffer = trb.high * 0x100000000 + (trb.low >>> 0);
        const max_packet = ep.max_packet || 8;
        while(td.done[td.index] < length)
        {
            if(this.budget <= 0) return false;
            const n = Math.min(max_packet, length - td.done[td.index]);
            let result;
            if(into)
            {
                result = device.transaction(PID_IN, endpoint, null, n);
            }
            else
            {
                const data = trb.control & TRB_IDT ? immediate(trb).subarray(td.done[td.index], td.done[td.index] + n) :
                    this.dma_read(buffer + td.done[td.index], n);
                if(!data) { td.error = CC_DATA_BUFFER; break; }
                result = device.transaction(PID_OUT, endpoint, data, n);
            }
            if(result === USB_NAK) return false;
            if(result === USB_STALL) { td.error = CC_STALL; break; }
            let moved = n;
            if(result instanceof Uint8Array)
            {
                if(result.length > n) { td.error = CC_BABBLE; break; }
                if(result.length && !this.dma_write(result, buffer + td.done[td.index])) { td.error = CC_DATA_BUFFER; break; }
                moved = result.length;
            }
            td.done[td.index] += moved;
            this.budget -= Math.max(moved, 64);
            if(into && moved < n)
            {
                td.short = td.index;
                break;
            }
        }
        if(td.error) break;
    }
    if(td.error) td.error_index = Math.min(td.index, td.trbs.length - 1);
    this.report(slot, ep, td);
    return true;
};

/**
 * @param {!Object} trb an IDT TRB
 * @return {!Uint8Array} its eight bytes of data
 */
function immediate(trb)
{
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, trb.low, true);
    view.setUint32(4, trb.high, true);
    return bytes;
}

/**
 * A TD over: its Transfer Events (the first TRB with IOC, a short packet's
 * with ISP, an error's; a control transfer's Status stage again; Event Data
 * TRBs with the bytes so far), the ring past it, or the endpoint halted
 * at it
 * @param {!Object} slot
 * @param {!Object} ep
 * @param {!Object} td
 */
XHCIController.prototype.report = function(slot, ep, td)
{
    const id = this.slots.indexOf(slot);
    let reported = false, short = false, edtla = 0;
    for(let i = 0; i < td.trbs.length; i++)
    {
        const trb = td.trbs[i];
        const length = trb.type === TRB_SETUP ? 8 : trb.status & 0x1FFFF;
        if(trb.type === TRB_STATUS) { reported = false; short = false; }
        if(i === td.short) short = true;
        if(trb.type === TRB_NORMAL || trb.type === TRB_DATA) edtla += td.done[i];
        const error = td.error && i === td.error_index;
        if(!reported && (trb.control & TRB_IOC || short && trb.control & TRB_ISP || error))
        {
            const code = error ? td.error : short ? CC_SHORT_PACKET : CC_SUCCESS;
            if(trb.type === TRB_EVENT_DATA)
            {
                // (the Event Data TRB's parameter, the bytes transferred so far; ED)
                this.event(trb.low, trb.high, code << 24 | edtla & 0xFFFFFF, EVENT_TRANSFER << 10 | 1 << 2 | ep.dci << 16 | id << 24);
                edtla = 0;
            }
            else
            {
                const left = trb.type === TRB_STATUS ? 0 : Math.max(0, length - td.done[i]);
                this.event(trb.address % 0x100000000, Math.floor(trb.address / 0x100000000), code << 24 | left,
                    EVENT_TRANSFER << 10 | ep.dci << 16 | id << 24);
            }
            reported = true;
            if(error) break;
        }
        if(trb.type === TRB_SETUP) { reported = false; short = false; }
        if(error) break;
    }
    if(td.error)
    {
        // halted: the ring at the TD's first TRB (the driver resets the endpoint and moves on)
        ep.ring = { dequeue: td.trbs[0].address, ccs: td.trbs[0].ccs };
        this.set_endpoint_state(slot, ep, EP_HALTED);
        return;
    }
    ep.ring = td.after;
};

/**
 * @param {number} now the machine time
 * @return {number} milliseconds until the next work
 */
XHCIController.prototype.timer = function(now)
{
    if(this.status & STS_HCH || !this.active.size) return 100;
    if(now < this.next_ms) return this.next_ms - now;
    this.next_ms = now + 1;
    if(!this.machine.is_bus_master()) return 1;
    this.budget = MS_BYTES;
    for(const key of Array.from(this.active))
    {
        const [id, dci] = key.split(":").map(Number);
        const slot = this.slots[id];
        const ep = slot && slot.endpoints[dci];
        if(!ep) { this.active.delete(key); continue; }
        this.run_endpoint(/** @type {!Object} */ (slot), ep);
    }
    return 1;
};

/**
 * @param {number} address
 * @param {!Array<number>} words
 */
XHCIController.prototype.write_dwords = function(address, words)
{
    const bytes = new Uint8Array(4 * words.length);
    const view = new DataView(bytes.buffer);
    words.forEach((word, i) => view.setUint32(4 * i, word >>> 0, true));
    this.dma_write(bytes, address);
};

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array}
 */
XHCIController.prototype.dma_read = function(address, length)
{
    try { return this.machine.read_physical(address, length); }
    catch(e)
    {
        dbg_log("xhci: read outside memory at " + h(address >>> 0, 8), LOG_PCI);
        this.status |= STS_HSE;
        return null;
    }
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} address
 * @return {boolean}
 */
XHCIController.prototype.dma_write = function(bytes, address)
{
    try { this.machine.write_physical(bytes, address); return true; }
    catch(e)
    {
        dbg_log("xhci: write outside memory at " + h(address >>> 0, 8), LOG_PCI);
        this.status |= STS_HSE;
        return false;
    }
};

// snapshots

/** @param {Object} td */
function td_state(td)
{
    return td && [td.trbs.map(t => [t.address, t.low, t.high, t.status, t.control, t.ccs]), td.index, td.done.slice(), td.short, td.error,
        td.error_index, td.after.dequeue, td.after.ccs];
}

/** @param {Array} state */
function td_of_state(state)
{
    return state && {
        trbs: state[0].map(t => ({ address: t[0], low: t[1], high: t[2], status: t[3], control: t[4], type: t[4] >> 10 & 0x3F, ccs: t[5] })),
        index: state[1], offset: 0, done: state[2].slice(), short: state[3], error: state[4], error_index: state[5],
        after: { dequeue: state[6], ccs: state[7] },
    };
}

XHCIController.prototype.get_state = function()
{
    const er = this.event_ring;
    return [this.cmd, this.status, this.dnctrl, this.crcr.slice(), this.command_ring.dequeue, this.command_ring.ccs, +this.crr,
        this.dcbaap.slice(), this.config, this.iman, this.imod, this.erstsz, this.erstba.slice(), this.erdp.slice(),
        [er.start, er.size, er.enqueue, er.pcs], this.machine.now() - this.mf_start, this.portsc.slice(),
        this.slots.map(slot => slot && [slot.port, slot.root, slot.context, slot.state, +slot.gone,
            slot.endpoints.map(ep => ep && [ep.dci, ep.type, ep.max_packet, ep.interval, ep.ring.dequeue, ep.ring.ccs, ep.state, td_state(ep.td)])]),
        Array.from(this.active), this.legsup, +this.irq_level, this.bar0];
};

XHCIController.prototype.set_state = function(state)
{
    this.cmd = state[0];
    this.status = state[1];
    this.dnctrl = state[2];
    this.crcr = state[3].slice();
    this.command_ring = { dequeue: state[4], ccs: state[5] };
    this.crr = !!state[6];
    this.dcbaap = state[7].slice();
    this.config = state[8];
    this.iman = state[9];
    this.imod = state[10];
    this.erstsz = state[11];
    this.erstba = state[12].slice();
    this.erdp = state[13].slice();
    this.event_ring = { start: state[14][0], size: state[14][1], enqueue: state[14][2], pcs: state[14][3] };
    this.mf_start = this.machine.now() - state[15];
    this.next_ms = this.machine.now();
    this.portsc = state[16].slice();
    this.slots = state[17].map(s => s && {
        port: s[0], root: s[1], context: s[2], state: s[3], gone: !!s[4],
        endpoints: s[5].map(e => e && {
            dci: e[0], type: e[1], max_packet: e[2], interval: e[3], ring: { dequeue: e[4], ccs: e[5] }, state: e[6], td: td_of_state(e[7]),
        }),
    });
    this.active = new Set(state[18]);
    this.legsup = state[19];
    this.irq_level = !!state[20];
    if(this.irq_level) this.machine.raise_irq();
    else this.machine.lower_irq();
    this.bar0 = state[21];
    this.update_decode();
};
