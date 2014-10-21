/** 
 * No full implementation, just dumping serial output
 * to console
 *
 */

/** @const */
var DLAB = 0x80;

/** 
 * @constructor 
 */
function UART(cpu, port, adapter)
{
    this.pic = cpu.devices.pic;

    this.line = "";
    this.baud_rate = 0;

    this.line_control = 0;
    this.line_status = 0;

    this.fifo_control = 0;
    this.interrupt_enable = 0;

    // interrupt identification register
    this.iir = 1;

    this.modem_control = 0;
    this.modem_status = 0;

    this.scratch_register = 0;

    this.irq = 0;

    this.input = new ByteQueue(4096);

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

    function data_received(data)
    {
        this.input.push(data);

        if(this.interrupt_enable & 1)
        {
            this.push_irq();
        }
    }
    adapter.init(data_received.bind(this));

    var io = cpu.io;

    io.register_write(port, this, function(out_byte) 
    {
        if(this.line_control & DLAB)
        {
            this.baud_rate = this.baud_rate & ~0xFF | out_byte;
            return;
        }

        //dbg_log("data: " + h(out_byte), LOG_SERIAL);

        if(out_byte === 0xFF)
        {
            return;
        }

        if(!adapter)
        {
            return;
        }

        if(adapter.put_line)
        {
            if(out_byte === 0x0A)
            {
                adapter.put_line(this.line);
                this.line = "";
            }
            else
            {
                this.line += String.fromCharCode(out_byte);
            }
        }
        else
        {
            adapter.put_str(String.fromCharCode(out_byte));
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
            this.interrupt_enable = out_byte;
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
                dbg_log("Input empty", LOG_SERIAL);
            }
            else
            {
                dbg_log("Input: " + h(data), LOG_SERIAL);
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
            return this.interrupt_enable;
        }
    });

    io.register_read(port | 2, this, function()
    {
        var ret = this.iir;
        dbg_log("read interrupt identification: " + h(this.iir), LOG_SERIAL);
        this.iir ^= 1;

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
}

UART.prototype.push_irq = function()
{
    this.pic.push_irq(this.irq);
};

