// The virt machine's PL011 UART at 0x0900_0000 (docs/arm64-virt-android16-plan.md
// P4.5), as the reference's (QEMU 9.2 hw/char/pl011.c): a receive FIFO of
// 16 bytes (1 without LCR_H.FEN) fed by serial0-input, the receive
// interrupt as soon as a byte waits (the reference's trigger level 1), the
// transmit interrupt after every byte written (transmission is immediate,
// out as serial0-output-byte), loopback, the registers as written, and the
// PrimeCell identification the AMBA bus binds the driver by. The combined
// interrupt is SPI 1 (INTID 33), level-sensitive. Bytes that arrive while
// the FIFO is full wait in a backlog, as the reference's character device
// holds them back.

import { VIRT_UART } from "./platform.js";

const UARTDR = 0x000;
const UARTRSR = 0x004;
const UARTFR = 0x018;
const UARTILPR = 0x020;
const UARTIBRD = 0x024;
const UARTFBRD = 0x028;
const UARTLCR_H = 0x02C;
const UARTCR = 0x030;
const UARTIFLS = 0x034;
const UARTIMSC = 0x038;
const UARTRIS = 0x03C;
const UARTMIS = 0x040;
const UARTICR = 0x044;
const UARTDMACR = 0x048;

const FR_RXFE = 1 << 4;
const FR_TXFF = 1 << 5;
const FR_RXFF = 1 << 6;
const FR_TXFE = 1 << 7;

const INT_TX = 1 << 5;
const INT_RX = 1 << 4;

const LCR_FEN = 1 << 4;
const CR_LBE = 1 << 7;

const FIFO_DEPTH = 16;
export const PL011_INTID = 33;

/** PeriphID0-3 (PL011 r1p5) and PCellID0-3 at 0xFE0-0xFFC */
const ID = [0x11, 0x10, 0x14, 0x00, 0x0D, 0xF0, 0x05, 0xB1];

/**
 * @constructor
 * @param {Object} cpu the arm64 CPU (src/arm/cpu.js)
 * @param {Object} bus
 */
export function PL011(cpu, bus)
{
    this.name = "pl011";
    this.cpu = cpu;
    this.bus = bus;
    /** @type {!Array<number>} what arrived while the FIFO was full */
    this.backlog = [];
    this.reset();
    this.owner = cpu.io.register_mmio(VIRT_UART, 0x1000, {
        read: (offset, width) => this.read(offset, width),
        write: (offset, width, value) => this.write(offset, width, Number(value)),
        name: this.name,
    });
    bus.register("serial0-input", byte => this.receive(byte & 0xFF), this);
}

PL011.prototype.reset = function()
{
    this.lcr = 0;
    this.rsr = 0;
    this.dmacr = 0;
    this.int_enabled = 0;
    this.int_level = 0;
    this.ilpr = 0;
    this.ibrd = 0;
    this.fbrd = 0;
    this.read_trigger = 1;
    this.ifl = 0x12;
    this.cr = 0x300;
    this.flags = 0;
    this.read_fifo = new Array(FIFO_DEPTH).fill(0);
    this.reset_fifos();
    this.update();
};

PL011.prototype.reset_fifos = function()
{
    this.read_count = 0;
    this.read_pos = 0;
    this.flags = this.flags & ~(FR_RXFF | FR_TXFF) | FR_RXFE | FR_TXFE;
};

PL011.prototype.depth = function()
{
    return this.lcr & LCR_FEN ? FIFO_DEPTH : 1;
};

/** The combined interrupt line to the GIC */
PL011.prototype.update = function()
{
    this.cpu.set_irq(PL011_INTID, (this.int_level & this.int_enabled) !== 0);
};

PL011.prototype.fifo_put = function(value)
{
    const depth = this.depth();
    this.read_fifo[(this.read_pos + this.read_count) & (depth - 1)] = value;
    this.read_count++;
    this.flags &= ~FR_RXFE;
    if(this.read_count === depth) this.flags |= FR_RXFF;
    if(this.read_count === this.read_trigger)
    {
        this.int_level |= INT_RX;
        this.update();
    }
};

/** A byte from serial0-input (ignored in loopback; held back while the FIFO is full) */
PL011.prototype.receive = function(byte)
{
    if(this.cr & CR_LBE) return;
    if(this.read_count < this.depth() && !this.backlog.length) this.fifo_put(byte);
    else this.backlog.push(byte);
};

PL011.prototype.read_data = function()
{
    this.flags &= ~FR_RXFF;
    const c = this.read_fifo[this.read_pos];
    if(this.read_count > 0)
    {
        this.read_count--;
        this.read_pos = (this.read_pos + 1) & (this.depth() - 1);
    }
    if(this.read_count === 0) this.flags |= FR_RXFE;
    if(this.read_count === this.read_trigger - 1) this.int_level &= ~INT_RX;
    this.rsr = c >> 8;
    this.update();
    this.refill();
    return c;
};

/** The backlog into the FIFO, as far as it has room (as it drains, and after the FIFOs are reset) */
PL011.prototype.refill = function()
{
    while(this.backlog.length && this.read_count < this.depth() && !(this.cr & CR_LBE)) this.fifo_put(this.backlog.shift());
};

PL011.prototype.read = function(offset, width)
{
    switch(offset)
    {
        case UARTDR: return this.read_data();
        case UARTRSR: return this.rsr;
        case UARTFR: return this.flags;
        case UARTILPR: return this.ilpr;
        case UARTIBRD: return this.ibrd;
        case UARTFBRD: return this.fbrd;
        case UARTLCR_H: return this.lcr;
        case UARTCR: return this.cr;
        case UARTIFLS: return this.ifl;
        case UARTIMSC: return this.int_enabled;
        case UARTRIS: return this.int_level;
        case UARTMIS: return this.int_level & this.int_enabled;
        case UARTDMACR: return this.dmacr;
    }
    if(offset >= 0xFE0 && offset < 0x1000) return ID[offset - 0xFE0 >> 2];
    return 0;
};

PL011.prototype.write = function(offset, width, value)
{
    switch(offset)
    {
        case UARTDR:
            this.bus.send("serial0-output-byte", value & 0xFF);
            if(this.cr & CR_LBE) this.fifo_put(value & 0xFF);
            this.int_level |= INT_TX;
            this.update();
            break;
        case UARTRSR: this.rsr = 0; break;
        case UARTILPR: this.ilpr = value; break;
        case UARTIBRD: this.ibrd = value & 0xFFFF; break;
        case UARTFBRD: this.fbrd = value & 0x3F; break;
        case UARTLCR_H:
            // (enabling or disabling the FIFOs empties them; what the host
            // held back while the FIFO was full comes in then: a driver that
            // set FEN would otherwise never see another byte)
            if((this.lcr ^ value) & LCR_FEN) this.reset_fifos();
            this.lcr = value;
            this.read_trigger = 1;
            this.refill();
            break;
        case UARTCR: this.cr = value; break;
        case UARTIFLS: this.ifl = value; this.read_trigger = 1; break;
        case UARTIMSC: this.int_enabled = value; this.update(); break;
        case UARTICR: this.int_level &= ~value; this.update(); break;
        case UARTDMACR: this.dmacr = value; break;
    }
};

PL011.prototype.get_state = function()
{
    return [this.lcr, this.rsr, this.dmacr, this.int_enabled, this.int_level, this.ilpr, this.ibrd, this.fbrd, this.read_trigger,
        this.ifl, this.cr, this.flags, this.read_fifo.slice(), this.read_count, this.read_pos, this.backlog.slice()];
};

PL011.prototype.set_state = function(state)
{
    [this.lcr, this.rsr, this.dmacr, this.int_enabled, this.int_level, this.ilpr, this.ibrd, this.fbrd, this.read_trigger,
        this.ifl, this.cr, this.flags] = state;
    this.read_fifo = state[12].slice();
    this.read_count = state[13];
    this.read_pos = state[14];
    this.backlog = state[15].slice();
    this.update();
};
