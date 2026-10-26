// A UHCI USB 1.1 host controller (Intel's Universal Host Controller
// Interface, revision 1.1): PIIX3's (8086:7020) on i440FX, ICH9's first
// (8086:2934) on Q35, as QEMU's piix3-usb-uhci and ich9-usb-uhci1, or one of
// ICH9's three companions of EHCI (ehci.js); Windows binds usbport.inf by
// its class (PCI\CC_0C0300), Linux uhci-hcd. Two root ports, the 32 I/O
// ports of BAR4, INTx.
//
// While it runs, a frame of 1 ms of the machine clock is processed at a
// time: the frame list's entry, its queue heads (QH) and transfer
// descriptors (TD) in guest memory, each TD a transaction with the device at
// its address (usb_device.js). Frames that fall due while the timer was late
// are caught up a few at a time, up to a budget: the interrupt endpoints'
// polling only NAKs meanwhile. A frame has a budget of TDs and bytes, and a
// queue head visited again without progress ends it (the full-speed
// bandwidth reclamation loop of the drivers' schedules).

import { LOG_PCI } from "../const.js";
import { h } from "../lib.js";
import { dbg_log } from "../log.js";
import { PID_IN, PID_OUT, PID_SETUP, SPEED_LOW, USB_NAK, USB_STALL } from "./usb.js";

const IO_SIZE = 32;
export const PORTS = 2;

/** The controller of each machine: [device, revision, interrupt pin] */
const IDENTITY = { "i440fx": [0x7020, 0x01, 4], "q35": [0x2934, 0x03, 1] };
/** EHCI's companions (functions 0, 1, 2 of its device): ICH9's UHCI1 to 3 */
export const COMPANION_IDENTITY = [[0x2934, 0x03, 1], [0x2935, 0x03, 2], [0x2936, 0x03, 3]];
const PCI_VENDOR = 0x8086;
const PCI_SUBSYSTEM_VENDOR = 0x1AF4, PCI_SUBSYSTEM = 0x1100;

// registers (offsets in the I/O window)
const R_USBCMD = 0x00, R_USBSTS = 0x02, R_USBINTR = 0x04, R_FRNUM = 0x06, R_FLBASEADD = 0x08, R_SOFMOD = 0x0C,
    R_PORTSC1 = 0x10;

const CMD_RS = 1 << 0, CMD_HCRESET = 1 << 1, CMD_GRESET = 1 << 2, CMD_EGSM = 1 << 3, CMD_FGR = 1 << 4, CMD_MASK = 0xFF;
const STS_USBINT = 1 << 0, STS_ERROR = 1 << 1, STS_RD = 1 << 2, STS_HSE = 1 << 3, STS_HCPE = 1 << 4, STS_HALTED = 1 << 5;
const INTR_TIMEOUT_CRC = 1 << 0, INTR_RESUME = 1 << 1, INTR_IOC = 1 << 2, INTR_SHORT = 1 << 3;

// (bits 5:4, the line status, read J for a full-speed device that is there)
const PORT_CCS = 1 << 0, PORT_CSC = 1 << 1, PORT_PE = 1 << 2, PORT_PEC = 1 << 3, PORT_RD = 1 << 6, PORT_RESERVED = 1 << 7, PORT_LSDA = 1 << 8, PORT_PR = 1 << 9, PORT_SUSPEND = 1 << 12;
const PORT_WRITE_CLEAR = PORT_CSC | PORT_PEC;
const PORT_WRITABLE = PORT_PE | PORT_RD | PORT_PR | PORT_SUSPEND;

// link pointers
const LINK_TERMINATE = 1, LINK_QH = 2, LINK_DEPTH = 4;
// a TD's control and status
const TD_ACTLEN = 0x7FF, TD_BITSTUFF = 1 << 17, TD_CRC_TIMEOUT = 1 << 18, TD_NAK = 1 << 19, TD_BABBLE = 1 << 20,
    TD_BUFFER_ERROR = 1 << 21, TD_STALLED = 1 << 22, TD_ACTIVE = 1 << 23, TD_IOC = 1 << 24, TD_ERRORS_SHIFT = 27,
    TD_SPD = 1 << 29;
const TD_STATUS = TD_BITSTUFF | TD_CRC_TIMEOUT | TD_NAK | TD_BABBLE | TD_BUFFER_ERROR | TD_STALLED;

// What a TD's processing leads to
const TD_COMPLETE = 0, TD_NEXT_QH = 1;

/** Per frame at most this many TDs and bytes; per timer round at most this many frames */
const FRAME_TDS = 256;
const FRAME_BYTES = 16 * 1024;
const FRAMES_PER_ROUND = 16;
/** Frames further behind than this are skipped (the clock jumped, the host stalled) */
const FRAMES_BEHIND = 100;

/**
 * @constructor
 * @param {!Object} machine the plugin's machine (src/usb/machine.js), or a function's
 * @param {Array<number>=} identity [device, revision, interrupt pin] (a companion's); the machine's by default
 * @param {boolean=} multifunction function 0 of a device of several (EHCI's)
 */
export function UHCIController(machine, identity, multifunction)
{
    this.machine = machine;
    this.name = "uhci";
    /** @type {!Array<?Object>} the device on each root port */
    this.devices = new Array(PORTS).fill(null);
    this.irq_level = false;

    this.io_base = machine.allocate_io(IO_SIZE);
    this.reset();
    this.register_ports();

    const [device, revision, pin] = identity || IDENTITY[machine.machine_type] || IDENTITY["i440fx"];
    const space = create_pci_space(device, revision, pin, this.io_base);
    if(multifunction) space[0x0E] = 0x80;
    machine.register_pci({
        pci_space: space,
        pci_bars: [null, null, null, null, { size: IO_SIZE, on_move: undefined }],
        on_command_change: () => { this.update_irq(); },
        on_config_restore: () => {},
        on_upstream_change: () => {},
        on_config_write: () => {},
    });
    machine.add_timer(now => this.timer(now));
}

/**
 * @param {number} device
 * @param {number} revision
 * @param {number} pin
 * @param {number} io_base
 * @return {!Array<number>}
 */
function create_pci_space(device, revision, pin, io_base)
{
    const space = new Array(256).fill(0);
    const put16 = (offset, value) => { space[offset] = value & 0xFF; space[offset + 1] = value >> 8 & 0xFF; };
    put16(0x00, PCI_VENDOR);
    put16(0x02, device);
    put16(0x06, 0x0280);
    space[0x08] = revision;
    // class 0C/03/00: a UHCI USB controller
    space[0x0A] = 0x03;
    space[0x0B] = 0x0C;
    // BAR4: the I/O ports
    put16(0x20, io_base | 1);
    put16(0x2C, PCI_SUBSYSTEM_VENDOR);
    put16(0x2E, PCI_SUBSYSTEM);
    space[0x3D] = pin;
    // SBRN: USB 1.0; LEGSUP: the PIRQ enabled, no legacy support traps (v86 has no USB SMI)
    space[0x60] = 0x10;
    put16(0xC0, 0x2000);
    return space;
}

/** Everything to its reset value (power on, HCRESET) */
UHCIController.prototype.reset = function()
{
    this.cmd = 0;
    this.status = STS_HALTED;
    /** what set USBINT: 1 IOC, 2 a short packet */
    this.status2 = 0;
    this.intr = 0;
    this.frnum = 0;
    this.flbase = 0;
    this.sofmod = 64;
    this.portsc = new Array(PORTS).fill(0);
    /** the machine time of the next frame (while running) */
    this.next_frame = 0;
    for(let i = 0; i < PORTS; i++)
    {
        if(this.devices[i])
        {
            this.devices[i].reset();
            this.portsc[i] = PORT_CCS | PORT_CSC | (this.devices[i].speed === SPEED_LOW ? PORT_LSDA : 0);
        }
    }
    this.update_irq();
};

/**
 * @param {number} port
 * @return {boolean} whether the port has a device connected (as the guest sees it)
 */
UHCIController.prototype.port_connected = function(port)
{
    return !!(this.portsc[port] & PORT_CCS);
};

/**
 * Plug a device into a root port (or take it out: null)
 * @param {number} port
 * @param {?Object} device
 */
UHCIController.prototype.attach = function(port, device)
{
    this.devices[port] = device;
    if(device)
    {
        device.reset();
        this.portsc[port] = this.portsc[port] & ~(PORT_LSDA | PORT_PE) | PORT_CCS | PORT_CSC | (device.speed === SPEED_LOW ? PORT_LSDA : 0);
    }
    else
    {
        this.portsc[port] = this.portsc[port] & ~(PORT_CCS | PORT_PE | PORT_LSDA) | PORT_CSC | (this.portsc[port] & PORT_PE ? PORT_PEC : 0);
    }
    // (a connect while the bus is suspended is a resume)
    if(this.cmd & CMD_EGSM)
    {
        this.status |= STS_RD;
        this.update_irq();
    }
};

UHCIController.prototype.register_ports = function()
{
    const machine = this.machine;
    for(let offset = 0; offset < IO_SIZE; offset++)
    {
        machine.register_read(this.io_base + offset, this,
            function() { return this.read(offset, 1); },
            function() { return this.read(offset, 2); },
            function() { return this.read(offset, 4); });
        machine.register_write(this.io_base + offset, this,
            function(value) { this.write(offset, 1, value); },
            function(value) { this.write(offset, 2, value); },
            function(value) { this.write(offset, 4, value); });
    }
};

/**
 * A register's value
 * @param {number} offset
 * @return {number}
 */
UHCIController.prototype.register = function(offset)
{
    switch(offset)
    {
        case R_USBCMD: return this.cmd;
        case R_USBSTS: return this.status;
        case R_USBINTR: return this.intr;
        case R_FRNUM: return this.frnum;
        case R_FLBASEADD: return this.flbase;
        case R_SOFMOD: return this.sofmod;
    }
    if(offset >= R_PORTSC1 && offset < R_PORTSC1 + 2 * PORTS)
    {
        const port = offset - R_PORTSC1 >> 1;
        // (bit 7 always reads 1: drivers count the ports by it)
        return this.portsc[port] | PORT_RESERVED | (this.portsc[port] & PORT_CCS && !(this.portsc[port] & PORT_LSDA) ? 1 << 4 : 0);
    }
    return 0;
};

/** The registers by first byte: [size] */
const SIZES = new Map([[R_USBCMD, 2], [R_USBSTS, 2], [R_USBINTR, 2], [R_FRNUM, 2], [R_FLBASEADD, 4], [R_SOFMOD, 1]]);
for(let i = 0; i < PORTS; i++) SIZES.set(R_PORTSC1 + 2 * i, 2);

/**
 * @param {number} offset
 * @return {Array<number>} [first byte, size] of the register the byte is in
 */
function register_at(offset)
{
    for(const [start, size] of SIZES)
    {
        if(offset >= start && offset < start + size) return [start, size];
    }
    return null;
}

/**
 * @param {number} offset
 * @param {number} size
 * @return {number}
 */
UHCIController.prototype.read = function(offset, size)
{
    let value = 0;
    for(let i = 0; i < size; i++)
    {
        const at = register_at(offset + i);
        if(!at) continue;
        value |= (this.register(at[0]) >>> ((offset + i - at[0]) << 3) & 0xFF) << (i << 3);
    }
    return value >>> 0;
};

/**
 * @param {number} offset
 * @param {number} size
 * @param {number} value
 */
UHCIController.prototype.write = function(offset, size, value)
{
    for(let i = 0; i < size;)
    {
        const at = register_at(offset + i);
        if(!at) { i++; continue; }
        const [start, length] = at;
        let mask = 0, bits = 0;
        for(; i < size && offset + i < start + length; i++)
        {
            const shift = (offset + i - start) << 3;
            mask |= 0xFF << shift;
            bits |= (value >>> (i << 3) & 0xFF) << shift;
        }
        this.write_register(start, bits >>> 0, mask >>> 0);
    }
};

/**
 * @param {number} offset
 * @param {number} bits
 * @param {number} mask
 */
UHCIController.prototype.write_register = function(offset, bits, mask)
{
    const merge = old => (old & ~mask | bits & mask) >>> 0;
    switch(offset)
    {
        case R_USBCMD:
        {
            const value = merge(this.cmd) & CMD_MASK;
            if(value & CMD_HCRESET)
            {
                dbg_log("uhci: host controller reset", LOG_PCI);
                this.reset();
                return;
            }
            if(value & CMD_GRESET && !(this.cmd & CMD_GRESET))
            {
                // the bus's reset: every device to its default state
                for(const device of this.devices) if(device) device.reset();
            }
            const was_running = this.cmd & CMD_RS;
            this.cmd = value;
            if(value & CMD_RS && !was_running)
            {
                this.status &= ~STS_HALTED;
                this.next_frame = this.machine.now() + 1;
            }
            else if(!(value & CMD_RS) && was_running)
            {
                this.status |= STS_HALTED;
            }
            if(value & CMD_FGR && this.status & STS_RD) this.status &= ~STS_RD;
            break;
        }
        case R_USBSTS:
            this.status &= ~(bits & mask & (STS_USBINT | STS_ERROR | STS_RD | STS_HSE | STS_HCPE));
            if(!(this.status & STS_USBINT)) this.status2 = 0;
            this.update_irq();
            break;
        case R_USBINTR:
            this.intr = merge(this.intr) & 0xF;
            this.update_irq();
            break;
        case R_FRNUM:
            // (only while halted)
            if(this.status & STS_HALTED) this.frnum = merge(this.frnum) & 0x7FF;
            break;
        case R_FLBASEADD:
            this.flbase = merge(this.flbase) & ~0xFFF;
            break;
        case R_SOFMOD:
            this.sofmod = merge(this.sofmod) & 0x7F;
            break;
        default:
            this.write_port(offset - R_PORTSC1 >> 1, bits, mask);
    }
};

/**
 * PORTSC
 * @param {number} port
 * @param {number} bits
 * @param {number} mask
 */
UHCIController.prototype.write_port = function(port, bits, mask)
{
    const old = this.portsc[port];
    const device = this.devices[port];
    let value = old & ~(bits & mask & PORT_WRITE_CLEAR);
    value = value & ~(PORT_WRITABLE & mask) | bits & mask & PORT_WRITABLE;
    if(value & PORT_PR && !(old & PORT_PR) && device)
    {
        // a port reset: the device to its default state, the port disabled
        device.reset();
        value &= ~PORT_PE;
    }
    if(!(value & PORT_CCS)) value &= ~PORT_PE;
    if(value & PORT_PR) value &= ~PORT_PE;
    this.portsc[port] = value;
};

/** INTx: the status bits USBINTR enables */
UHCIController.prototype.update_irq = function()
{
    const level = !!(this.status2 & 1 && this.intr & INTR_IOC || this.status2 & 2 && this.intr & INTR_SHORT ||
        this.status & STS_ERROR && this.intr & INTR_TIMEOUT_CRC || this.status & STS_RD && this.intr & INTR_RESUME ||
        this.status & (STS_HSE | STS_HCPE));
    if(level === this.irq_level) return;
    this.irq_level = level;
    if(level) this.machine.raise_irq();
    else this.machine.lower_irq();
};

// the schedule

/**
 * The machine's timers run: the frames due
 * @param {number} now
 * @return {number} milliseconds until it needs to run again
 */
UHCIController.prototype.timer = function(now)
{
    if(!(this.cmd & CMD_RS) || this.cmd & CMD_EGSM) return 100;
    if(now - this.next_frame > FRAMES_BEHIND)
    {
        // (far behind: the frames of the gap are not processed)
        const skipped = Math.floor(now - this.next_frame) - FRAMES_PER_ROUND;
        this.frnum = this.frnum + skipped & 0x7FF;
        this.next_frame += skipped;
    }
    for(let i = 0; i < FRAMES_PER_ROUND && now >= this.next_frame; i++)
    {
        this.process_frame();
        this.next_frame += 1;
        if(!(this.cmd & CMD_RS)) return 100;
    }
    return Math.max(0, this.next_frame - now);
};

/** One frame: its frame list entry's schedule, then FRNUM on and the interrupts */
UHCIController.prototype.process_frame = function()
{
    if(!this.machine.is_bus_master())
    {
        this.frnum = this.frnum + 1 & 0x7FF;
        return;
    }
    const entry = this.dma_read32(this.flbase + 4 * (this.frnum & 0x3FF));
    if(entry === null)
    {
        this.host_error();
        return;
    }
    let link = entry, tds = 0, interrupts = 0;
    this.frame_bytes = 0;
    /** queue heads seen in this frame: the TDs completed when last seen */
    const seen = new Map();
    let completed = 0;
    let qh = 0, qh_head = 0;
    while(!(link & LINK_TERMINATE) && tds < FRAME_TDS && this.frame_bytes < FRAME_BYTES)
    {
        if(link & LINK_QH)
        {
            qh = link & ~0xF;
            if(seen.has(qh) && seen.get(qh) === completed) break;
            seen.set(qh, completed);
            qh_head = this.dma_read32(qh);
            const element = this.dma_read32(qh + 4);
            if(qh_head === null || element === null) { this.host_error(); return; }
            if(element & LINK_TERMINATE) { link = qh_head; qh = 0; continue; }
            if(element & LINK_QH) { link = element; qh = 0; continue; }
            link = element;
        }
        const td = link & ~0xF;
        tds++;
        const result = this.process_td(td);
        if(result === null) { this.host_error(); return; }
        interrupts |= result.interrupts;
        if(result.outcome === TD_COMPLETE)
        {
            completed++;
            const next = result.link;
            if(qh)
            {
                // the queue goes on: its element the next TD
                this.dma_write32(qh + 4, next);
                if(!(next & LINK_DEPTH) || next & (LINK_TERMINATE | LINK_QH))
                {
                    link = qh_head;
                    qh = 0;
                }
                else
                {
                    link = next;
                }
            }
            else
            {
                link = next;
            }
        }
        else
        {
            link = qh ? qh_head : result.link;
            qh = 0;
        }
    }
    this.frnum = this.frnum + 1 & 0x7FF;
    if(interrupts)
    {
        this.status |= STS_USBINT;
        this.status2 |= interrupts;
        this.update_irq();
    }
};

/**
 * One TD: its transaction with the device at its address
 * @param {number} address
 * @return {?{outcome: number, link: number, interrupts: number}} null where the TD is not in memory
 */
UHCIController.prototype.process_td = function(address)
{
    const words = this.dma_read(address, 16);
    if(!words) return null;
    const view = new DataView(words.buffer);
    const link = view.getUint32(0, true);
    let control = view.getUint32(4, true);
    const token = view.getUint32(8, true), buffer = view.getUint32(12, true);
    if(!(control & TD_ACTIVE)) return { outcome: TD_NEXT_QH, link, interrupts: 0 };

    const pid = token & 0xFF, device_address = token >> 8 & 0x7F, endpoint = token >> 15 & 0xF;
    const max_length = (token >>> 21) + 1 & 0x7FF;
    const device = this.device_at(device_address);
    let interrupts = 0;
    const complete = (status, length) =>
    {
        control = control & ~(TD_STATUS | TD_ACTIVE | TD_ACTLEN) | status | (length - 1 & TD_ACTLEN);
        if(status & (TD_STALLED | TD_BABBLE | TD_CRC_TIMEOUT))
        {
            this.status |= STS_ERROR;
            this.update_irq();
        }
        if(control & TD_IOC) interrupts |= 1;
    };

    if(!device)
    {
        // no answer: a timeout, the error counter down, at 0 the TD is retired
        let errors = control >> TD_ERRORS_SHIFT & 3;
        control |= TD_CRC_TIMEOUT;
        if(errors)
        {
            errors--;
            if(!errors)
            {
                control &= ~TD_ACTIVE;
                this.status |= STS_ERROR;
                if(control & TD_IOC) interrupts |= 1;
                this.update_irq();
            }
        }
        control = control & ~(3 << TD_ERRORS_SHIFT) | errors << TD_ERRORS_SHIFT;
        this.dma_write32(address + 4, control);
        return { outcome: TD_NEXT_QH, link, interrupts };
    }

    let result;
    if(pid === PID_IN)
    {
        result = device.transaction(PID_IN, endpoint, null, max_length);
    }
    else if(pid === PID_OUT || pid === PID_SETUP)
    {
        const data = max_length ? this.dma_read(buffer, max_length) : new Uint8Array(0);
        if(!data) return null;
        result = device.transaction(pid, endpoint, data, max_length);
    }
    else
    {
        // (a PID that is not a token: the controller's process error)
        this.status |= STS_HCPE;
        this.cmd &= ~CMD_RS;
        this.status |= STS_HALTED;
        this.update_irq();
        return { outcome: TD_NEXT_QH, link, interrupts };
    }

    if(result === USB_NAK)
    {
        // (the TD stays active; it is tried again in a later frame)
        return { outcome: TD_NEXT_QH, link, interrupts };
    }
    if(result === USB_STALL)
    {
        complete(TD_STALLED, 0);
        this.dma_write32(address + 4, control);
        return { outcome: TD_NEXT_QH, link, interrupts };
    }
    let length;
    if(result instanceof Uint8Array)
    {
        if(result.length > max_length)
        {
            complete(TD_BABBLE | TD_STALLED, max_length);
            this.dma_write32(address + 4, control);
            return { outcome: TD_NEXT_QH, link, interrupts };
        }
        if(result.length) this.dma_write(result, buffer);
        length = result.length;
    }
    else
    {
        length = max_length;
    }
    this.frame_bytes += length;
    complete(0, length);
    this.dma_write32(address + 4, control);
    if(pid === PID_IN && length < max_length && control & TD_SPD)
    {
        // a short packet: the queue stops here (the driver goes on with it)
        interrupts |= 2;
        return { outcome: TD_NEXT_QH, link, interrupts };
    }
    return { outcome: TD_COMPLETE, link, interrupts };
};

/**
 * The device at an address, on an enabled port
 * @param {number} address
 * @return {?Object}
 */
UHCIController.prototype.device_at = function(address)
{
    for(let i = 0; i < PORTS; i++)
    {
        const device = this.devices[i];
        if(device && this.portsc[i] & PORT_PE && !(this.portsc[i] & PORT_SUSPEND) && device.address === address) return device;
    }
    return null;
};

/** A schedule outside memory: the controller stops (host system error) */
UHCIController.prototype.host_error = function()
{
    dbg_log("uhci: schedule outside memory (frame list " + h(this.flbase >>> 0, 8) + ")", LOG_PCI);
    this.status |= STS_HSE | STS_HALTED;
    this.cmd &= ~CMD_RS;
    this.update_irq();
};

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array}
 */
UHCIController.prototype.dma_read = function(address, length)
{
    try { return this.machine.read_physical(address, length); }
    catch(e) { return null; }
};

/**
 * @param {number} address
 * @return {?number}
 */
UHCIController.prototype.dma_read32 = function(address)
{
    try { return this.machine.read32_physical(address) >>> 0; }
    catch(e) { return null; }
};

/**
 * @param {number} address
 * @param {number} value
 */
UHCIController.prototype.dma_write32 = function(address, value)
{
    try { this.machine.write32_physical(address, value | 0); }
    catch(e) { dbg_log("uhci: write outside memory at " + h(address >>> 0, 8), LOG_PCI); }
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} address
 */
UHCIController.prototype.dma_write = function(bytes, address)
{
    try { this.machine.write_physical(bytes, address); }
    catch(e) { dbg_log("uhci: write outside memory at " + h(address >>> 0, 8), LOG_PCI); }
};

UHCIController.prototype.get_state = function()
{
    const now = this.machine.now();
    return [this.cmd, this.status, this.status2, this.intr, this.frnum, this.flbase, this.sofmod, this.portsc.slice(),
        this.next_frame - now, +this.irq_level];
};

UHCIController.prototype.set_state = function(state)
{
    [this.cmd, this.status, this.status2, this.intr, this.frnum, this.flbase, this.sofmod] = state;
    this.portsc = state[7].slice();
    this.next_frame = this.machine.now() + state[8];
    this.irq_level = !!state[9];
    if(this.irq_level) this.machine.raise_irq();
    else this.machine.lower_irq();
};
