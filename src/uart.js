import { LOG_SERIAL } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

/*
 * Serial ports
 * http://wiki.osdev.org/UART
 * https://github.com/s-macke/jor1k/blob/master/js/worker/dev/uart.js
 * https://www.freebsd.org/doc/en/articles/serial-uart/
 */

const DLAB = 0x80;

const UART_IER_MSI  = 0x08; /* Modem Status Changed int. */
const UART_IER_THRI = 0x02; /* Enable Transmitter holding register int. */
const UART_IER_RDI = 0x01; /* Enable receiver data interrupt */

const UART_IIR_MSI = 0x00; /* Modem status interrupt (Low priority) */
const UART_IIR_NO_INT = 0x01;
const UART_IIR_THRI = 0x02; /* Transmitter holding register empty */
const UART_IIR_RDI = 0x04; /* Receiver data interrupt */
const UART_IIR_RLSI = 0x06; /* Receiver line status interrupt (High p.) */
const UART_IIR_CTI = 0x0c; /* Character timeout */

// Modem control register
const UART_MCR_LOOPBACK = 0x10;
const UART_MCR_RTS = 0x2;
const UART_MCR_DTR = 0x1;

const UART_LSR_DATA_READY        = 0x1;  // data available
const UART_LSR_TX_EMPTY        = 0x20; // TX (THR) buffer is empty
const UART_LSR_TRANSMITTER_EMPTY = 0x40; // TX empty and line is idle

// Modem status register
const UART_MSR_DCD = 0x7; // Data Carrier Detect
const UART_MSR_RI = 0x6; // Ring Indicator
const UART_MSR_DSR = 0x5; // Data Set Ready
const UART_MSR_CTS = 0x4; // Clear To Send
// Delta bits
const UART_MSR_DDCD = 0x3; // Delta DCD
const UART_MSR_TERI = 0x2; // Trailing Edge RI
const UART_MSR_DDSR = 0x1; // Delta DSR
const UART_MSR_DCTS = 0x0; // Delta CTS


/**
 * @constructor
 * @param {CPU} cpu
 * @param {number} port
 * @param {BusConnector} bus
 */
export function UART(cpu, port, bus)
{
    /** @const @type {BusConnector} */
    this.bus = bus;

    /** @const @type {CPU} */
    this.cpu = cpu;

    this.ints = 1 << UART_IIR_THRI;

    this.baud_rate = 0;

    this.line_control = 0;

    // line status register
    this.lsr = UART_LSR_TRANSMITTER_EMPTY | UART_LSR_TX_EMPTY;

    this.fifo_control = 0;

    // interrupts enable
    this.ier = 0;

    // interrupt identification register
    this.iir = UART_IIR_NO_INT;

    this.modem_control = 0;
    this.modem_status = 0;

    this.scratch_register = 0;

    this.irq = 0;

    this.input = [];

    this.current_line = "";

    switch(port)
    {
        case 0x3F8:
            this.com = 0;
            this.irq = 4;
            break;
        case 0x2F8:
            this.com = 1;
            this.irq = 3;
            break;
        case 0x3E8:
            this.com = 2;
            this.irq = 4;
            break;
        case 0x2E8:
            this.com = 3;
            this.irq = 3;
            break;
        default:
            dbg_log("Invalid serial port: " + h(port), LOG_SERIAL);
            this.com = 0;
            this.irq = 4;
    }

    this.bus.register("serial" + this.com + "-input", function(data)
    {
        this.data_received(data);
    }, this);

    // Set individual modem status bits

    this.bus.register("serial" + this.com + "-carrier-detect-input", function(data)
    {
        this.set_modem_status_bit(UART_MSR_DCD, data);
    }, this);

    this.bus.register("serial" + this.com + "-ring-indicator-input", function(data)
    {
        this.set_modem_status_bit(UART_MSR_RI, data);
    }, this);

    this.bus.register("serial" + this.com + "-data-set-ready-input", function(data)
    {
        this.set_modem_status_bit(UART_MSR_DSR, data);
    }, this);

    this.bus.register("serial" + this.com + "-clear-to-send-input", function(data)
    {
        this.set_modem_status_bit(UART_MSR_CTS, data);
    }, this);

    var io = cpu.io;

    io.register_write(port, this, function(out_byte)
    {
        this.write_data(out_byte);
    }, function(out_word)
    {
        this.write_data(out_word & 0xFF);
        this.write_data(out_word >> 8);
    });

    io.register_write(port | 1, this, function(out_byte)
    {
        if(this.line_control & DLAB)
        {
            this.baud_rate = this.baud_rate & 0xFF | out_byte << 8;
            dbg_log("baud rate: " + h(this.baud_rate), LOG_SERIAL);
        }
        else
        {
            if((this.ier & UART_IIR_THRI) === 0 && (out_byte & UART_IIR_THRI))
            {
                // re-throw THRI if it was masked
                this.ThrowInterrupt(UART_IIR_THRI);
            }

            this.ier = out_byte & 0xF;
            dbg_log("interrupt enable: " + h(out_byte), LOG_SERIAL);
            this.CheckInterrupt();
        }
    });

    io.register_read(port, this, function()
    {
        if(this.line_control & DLAB)
        {
            return this.baud_rate & 0xFF;
        }
        else
        {
            let data = 0;

            if(this.input.length === 0)
            {
                dbg_log("Read input empty", LOG_SERIAL);
            }
            else
            {
                data = this.input.shift();
                dbg_log("Read input: " + h(data), LOG_SERIAL);
            }

            if(this.input.length === 0)
            {
                this.lsr &= ~UART_LSR_DATA_READY;
                this.ClearInterrupt(UART_IIR_CTI);
                this.ClearInterrupt(UART_IIR_RDI);
            }

            return data;
        }
    });

    io.register_read(port | 1, this, function()
    {
        if(this.line_control & DLAB)
        {
            return this.baud_rate >> 8;
        }
        else
        {
            return this.ier & 0xF;
        }
    });

    io.register_read(port | 2, this, function()
    {
        var ret = this.iir & 0xF;
        dbg_log("read interrupt identification: " + h(this.iir), LOG_SERIAL);

        if(this.iir === UART_IIR_THRI) {
            this.ClearInterrupt(UART_IIR_THRI);
        }

        if(this.fifo_control & 1) ret |= 0xC0;

        return ret;
    });
    io.register_write(port | 2, this, function(out_byte)
    {
        dbg_log("fifo control: " + h(out_byte), LOG_SERIAL);
        this.fifo_control = out_byte;
    });

    io.register_read(port | 3, this, function()
    {
        dbg_log("read line control: " + h(this.line_control), LOG_SERIAL);
        return this.line_control;
    });
    io.register_write(port | 3, this, function(out_byte)
    {
        dbg_log("line control: " + h(out_byte), LOG_SERIAL);
        this.line_control = out_byte;
    });


    io.register_read(port | 4, this, function()
    {
        return this.modem_control;
    });
    io.register_write(port | 4, this, function(out_byte)
    {
        dbg_log("modem control: " + h(out_byte), LOG_SERIAL);
        const bits_changed = this.modem_control ^ out_byte;
        this.modem_control = out_byte;
        if(bits_changed & UART_MCR_DTR)
        {
            this.bus.send("serial" + this.com + "-data-terminal-ready-output", !!(out_byte & UART_MCR_DTR));
        }
        if(bits_changed & UART_MCR_RTS)
        {
            this.bus.send("serial" + this.com + "-request-to-send-output", !!(out_byte & UART_MCR_RTS));
        }
    });

    io.register_read(port | 5, this, function()
    {
        dbg_log("read line status: " + h(this.lsr), LOG_SERIAL);
        return this.lsr;
    });
    io.register_write(port | 5, this, function(out_byte)
    {
        dbg_log("Factory test write", LOG_SERIAL);
    });

    io.register_read(port | 6, this, function()
    {
        dbg_log("read modem status: " + h(this.modem_status), LOG_SERIAL);
        const result = this.modem_status;
        // clear MSR delta bits and interrupt flag
        this.modem_status &= 0xF0;
        this.ClearInterrupt(UART_IIR_MSI);
        return result;
    });

    io.register_read(port | 7, this, function()
    {
        return this.scratch_register;
    });
    io.register_write(port | 7, this, function(out_byte)
    {
        this.scratch_register = out_byte;
    });
}

UART.prototype.get_state = function()
{
    var state = [];

    state[0] = this.ints;
    state[1] = this.baud_rate;
    state[2] = this.line_control;
    state[3] = this.lsr;
    state[4] = this.fifo_control;
    state[5] = this.ier;
    state[6] = this.iir;
    state[7] = this.modem_control;
    state[8] = this.modem_status;
    state[9] = this.scratch_register;
    state[10] = this.irq;

    return state;
};

UART.prototype.set_state = function(state)
{
    this.ints = state[0];
    this.baud_rate = state[1];
    this.line_control = state[2];
    this.lsr = state[3];
    this.fifo_control = state[4];
    this.ier = state[5];
    this.iir = state[6];
    this.modem_control = state[7];
    this.modem_status = state[8];
    this.scratch_register = state[9];
    this.irq = state[10];
};

UART.prototype.CheckInterrupt = function()
{
    if((this.ints & (1 << UART_IIR_CTI)) && (this.ier & UART_IER_RDI))
    {
        this.iir = UART_IIR_CTI;
        this.cpu.device_raise_irq(this.irq);
    }
    else if((this.ints & (1 << UART_IIR_RDI)) && (this.ier & UART_IER_RDI))
    {
        this.iir = UART_IIR_RDI;
        this.cpu.device_raise_irq(this.irq);
    }
    else if((this.ints & (1 << UART_IIR_THRI)) && (this.ier & UART_IER_THRI))
    {
        this.iir = UART_IIR_THRI;
        this.cpu.device_raise_irq(this.irq);
    }
    else if((this.ints & (1 << UART_IIR_MSI)) && (this.ier & UART_IER_MSI))
    {
        this.iir = UART_IIR_MSI;
        this.cpu.device_raise_irq(this.irq);
    }
    else
    {
        this.iir = UART_IIR_NO_INT;
        this.cpu.device_lower_irq(this.irq);
    }
};

UART.prototype.ThrowInterrupt = function(line)
{
    this.ints |= (1 << line);
    this.CheckInterrupt();
};

UART.prototype.ClearInterrupt = function(line)
{
    this.ints &= ~(1 << line);
    this.CheckInterrupt();
};

/**
 * @param {number} data
 */
UART.prototype.data_received = function(data)
{
    dbg_log("input: " + h(data), LOG_SERIAL);
    this.input.push(data);

    this.lsr |= UART_LSR_DATA_READY;

    if(this.fifo_control & 1)
    {
        this.ThrowInterrupt(UART_IIR_CTI);
    }
    else
    {
        this.ThrowInterrupt(UART_IIR_RDI);
    }
};

UART.prototype.write_data = function(out_byte)
{
    if(this.line_control & DLAB)
    {
        this.baud_rate = this.baud_rate & ~0xFF | out_byte;
        return;
    }

    dbg_log("data: " + h(out_byte), LOG_SERIAL);

    this.ThrowInterrupt(UART_IIR_THRI);

    if(this.modem_control & UART_MCR_LOOPBACK) {
        this.data_received(out_byte);
    } else {
        this.bus.send("serial" + this.com + "-output-byte", out_byte);
    }

    if(DEBUG)
    {
        var char = String.fromCharCode(out_byte);
        this.current_line += char;

        if(char === "\n")
        {
            const line = this.current_line.trimRight().replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\xff]/g, "");
            dbg_log("SERIAL: " + line);
            this.current_line = "";
        }
    }
};

/**
 * Set or clear bit "msr_bit" in the Modem Status Register (MSR).
 *
 * The upper nibble of the MSR reflects the current status of the 4
 * control lines (CTS/DSR/RI/DCD), the lower nibble (the delta bits)
 * indicates which of of these have changed since the last time the
 * MSR was read.
 *
 * If any delta bit is set at the end of this operation and interrupts
 * are enabled, raise a Modem Status Register interrupt.
 *
 * The MSR is a read-only register for the PC, its upper nibble is
 * controlled by the Modem, and its lower nibble by the UART. The UART
 * clears all delta bits (and lowers the interrupt) after the MSR has
 * been read by the PC.
 *
 * @param {number} msr_bit
 * @param {boolean} set_bit
 */
UART.prototype.set_modem_status_bit = function(msr_bit, set_bit)
{
    const new_modem_status = set_bit ?
        this.modem_status | (1 << msr_bit) :
        this.modem_status & ~(1 << msr_bit);
    const new_delta_bits = (this.modem_status ^ new_modem_status) >> 4;
    this.modem_status = new_modem_status | new_delta_bits;
    if(this.modem_status & 0x0F)
    {
        this.ThrowInterrupt(UART_IIR_MSI);
    }
};
