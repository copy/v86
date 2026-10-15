// The virt machine's PL011 UART at 0x0900_0000 (docs/arm64-virt-android16-plan.md
// P4.5; A1 has the minimal subset): the data register, the flag register,
// a receive FIFO fed by serial0-input, the control registers kept as
// written, and the PrimeCell identification. Output goes out as
// serial0-output-byte, as from the PC machines' UART. Interrupts: P4.5.

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
const FR_TXFE = 1 << 7;

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
    this.bus = bus;
    this.rx = [];
    this.registers = { ibrd: 0, fbrd: 0, lcr_h: 0, cr: 0x300, ifls: 0x12, imsc: 0, ris: 0, dmacr: 0, ilpr: 0 };
    this.owner = cpu.io.register_mmio(VIRT_UART, 0x1000, {
        read: (offset, width) => this.read(offset, width),
        write: (offset, width, value) => this.write(offset, width, Number(value)),
        name: this.name,
    });
    bus.register("serial0-input", byte => { this.rx.push(byte & 0xFF); }, this);
}

PL011.prototype.read = function(offset, width)
{
    const r = this.registers;
    switch(offset)
    {
        case UARTDR: return this.rx.length ? this.rx.shift() : 0;
        case UARTRSR: return 0;
        case UARTFR: return FR_TXFE | (this.rx.length ? 0 : FR_RXFE);
        case UARTILPR: return r.ilpr;
        case UARTIBRD: return r.ibrd;
        case UARTFBRD: return r.fbrd;
        case UARTLCR_H: return r.lcr_h;
        case UARTCR: return r.cr;
        case UARTIFLS: return r.ifls;
        case UARTIMSC: return r.imsc;
        case UARTRIS: return r.ris;
        case UARTMIS: return r.ris & r.imsc;
        case UARTDMACR: return r.dmacr;
    }
    if(offset >= 0xFE0 && offset < 0x1000) return ID[offset - 0xFE0 >> 2];
    return 0;
};

PL011.prototype.write = function(offset, width, value)
{
    const r = this.registers;
    switch(offset)
    {
        case UARTDR: this.bus.send("serial0-output-byte", value & 0xFF); break;
        case UARTRSR: break;
        case UARTILPR: r.ilpr = value & 0xFF; break;
        case UARTIBRD: r.ibrd = value & 0xFFFF; break;
        case UARTFBRD: r.fbrd = value & 0x3F; break;
        case UARTLCR_H: r.lcr_h = value & 0xFF; break;
        case UARTCR: r.cr = value & 0xFFFF; break;
        case UARTIFLS: r.ifls = value & 0x3F; break;
        case UARTIMSC: r.imsc = value & 0x7FF; break;
        case UARTICR: r.ris &= ~value; break;
        case UARTDMACR: r.dmacr = value & 7; break;
    }
};

PL011.prototype.get_state = function()
{
    const r = this.registers;
    return [r.ibrd, r.fbrd, r.lcr_h, r.cr, r.ifls, r.imsc, r.ris, r.dmacr, r.ilpr, this.rx.slice()];
};

PL011.prototype.set_state = function(state)
{
    const r = this.registers;
    [r.ibrd, r.fbrd, r.lcr_h, r.cr, r.ifls, r.imsc, r.ris, r.dmacr, r.ilpr] = state;
    this.rx = state[9].slice();
};
