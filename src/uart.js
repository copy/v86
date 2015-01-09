"use strict";

/*
 * Serial ports
 * http://wiki.osdev.org/UART
 * https://github.com/s-macke/jor1k/blob/master/js/worker/dev/uart.js
 * https://www.freebsd.org/doc/en/articles/serial-uart/
 */

/** @const */
var DLAB = 0x80;

/** @const */ var UART_IER_THRI = 0x02; /* Enable Transmitter holding register int. */
/** @const */ var UART_IER_RDI = 0x01; /* Enable receiver data interrupt */

/** @const */var UART_IIR_MSI = 0x00; /* Modem status interrupt (Low priority) */
/** @const */var UART_IIR_NO_INT = 0x01;
/** @const */var UART_IIR_THRI = 0x02; /* Transmitter holding register empty */
/** @const */var UART_IIR_RDI = 0x04; /* Receiver data interrupt */
/** @const */var UART_IIR_RLSI = 0x06; /* Receiver line status interrupt (High p.) */
/** @const */var UART_IIR_CTI = 0x0c; /* Character timeout */


/** 
 * @constructor 
 */
function UART(cpu, port, bus)
{
    this.bus = bus;

    this.pic = cpu.devices.pic;

    this.interrupts = 0;

    this.baud_rate = 0;

    this.line_control = 0;
    this.line_status = 0;

    this.fifo_control = 0;


    // interrupts enable
    this.ier = 0;

    // interrupt identification register
    this.iir = 1;

    this.modem_control = 0;
    this.modem_status = 0;

    this.scratch_register = 0;

    this.irq = 0;

    this.input = new ByteQueue(4096);

    this.current_line = "";

    if(port === 0x3E8 || port === 0x3F8)
    {
        this.irq = 4;
    }
    else if(port === 0x3E8 || port === 0x3E8)
    {
        this.irq = 3;
    }
    else
    {
        dbg_log("Invalid port: " + h(port), LOG_SERIAL);
        return;
    }

    this.bus.register("serial0-input", function(data)
    {
        this.data_received(data);
    }, this);

    var io = cpu.io;

    io.register_write(port, this, function(out_byte) 
    {
        if(this.line_control & DLAB)
        {
            this.baud_rate = this.baud_rate & ~0xFF | out_byte;
            return;
        }

        dbg_log("data: " + h(out_byte), LOG_SERIAL);

        if(this.ier & UART_IER_THRI)
        {
            this.push_irq();
        }

        if(out_byte === 0xFF)
        {
            return;
        }

        var char = String.fromCharCode(out_byte);

        this.bus.send("serial0-output-char", char);

        if(this.bus.should_send("serial0-output-line"))
        {
            this.current_line += char;

            if(char === "\n")
            {
                this.bus.send("serial0-output-line", this.current_line);
                this.current_line = "";
            }
        }
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
            this.ier = out_byte;
            dbg_log("interrupt enable: " + h(out_byte), LOG_SERIAL);
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
            var data = this.input.shift();

            if(data === -1)
            {
                dbg_log("Read input empty", LOG_SERIAL);
            }
            else
            {
                dbg_log("Read input: " + h(data), LOG_SERIAL);
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
            return this.ier;
        }
    });

    io.register_read(port | 2, this, function()
    {
        var ret = this.iir & 0xF | 0xC0;
        dbg_log("read interrupt identification: " + h(this.iir), LOG_SERIAL);

        if(this.iir === UART_IIR_THRI)
        {
            this.clear_interrupt(UART_IIR_THRI);
        }
        else if(this.iir === UART_IIR_CTI)
        {
            this.clear_interrupt(UART_IIR_CTI);
        }

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
        this.modem_control = out_byte;
    });

    io.register_read(port | 5, this, function()
    {
        var line_status = 0;

        if(this.input.length)
        {
            line_status |= 1;
        }

        line_status |= 0x20 | 0x40;

        dbg_log("read line status: " + h(line_status), LOG_SERIAL);
        return line_status;
    });
    io.register_write(port | 5, this, function(out_byte)
    {
        dbg_log("Factory test write", LOG_SERIAL);
    });

    io.register_read(port | 6, this, function()
    {
        dbg_log("read modem status: " + h(this.modem_status), LOG_SERIAL);
        return this.modem_status;
    });
    io.register_write(port | 6, this, function(out_byte)
    {
        dbg_log("Unkown register write (base+6)", LOG_SERIAL);
    });

    io.register_read(port | 7, this, function()
    {
        return this.scratch_register;
    });
    io.register_write(port | 7, this, function(out_byte)
    {
        this.scratch_register = out_byte;
    });

    this._state_skip = [
        "bus",
    ];
}

UART.prototype.push_irq = function()
{
    dbg_log("Push irq", LOG_SERIAL);
    this.pic.push_irq(this.irq);
};

UART.prototype.clear_interrupt = function(line)
{
    this.interrupts &= ~(1 << line);
    this.iir = UART_IIR_NO_INT;

    if(line === this.iir) 
    {
        this.next_interrupt();
    }
};

UART.prototype.next_interrupt = function()
{
    if ((this.interrupts & (1 << UART_IIR_CTI)) && (this.ier & UART_IER_RDI)) {
        //this.ThrowCTI();
    }
    else if ((this.interrupts & (1 << UART_IIR_THRI)) && (this.ier & UART_IER_THRI)) {
        //this.ThrowTHRI();
    }
    else {
        this.iir = UART_IIR_NO_INT;
        //this.intdev.ClearInterrupt(0x2);
    }
};

/** 
 * @param {number} data
 */
UART.prototype.data_received = function(data)
{
    dbg_log("input: " + h(data), LOG_SERIAL);
    this.input.push(data);
    this.interrupts |= 1 << UART_IIR_CTI;

    if(this.ier & UART_IER_RDI)
    {
        this.iir = UART_IIR_CTI;
        this.push_irq();
    }
};
