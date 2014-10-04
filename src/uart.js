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

    io.register_write(port, function(out_byte) 
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
    }, this);

    io.register_write(port | 1, function(out_byte)
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
    }, this);

    io.register_read(port, function()
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
    }, this);

    io.register_read(port | 1, function()
    {
        if(this.line_control & DLAB)
        {
            return this.baud_rate >> 8;
        }
        else
        {
            return this.interrupt_enable;
        }
    }, this);

    io.register_read(port | 2, function()
    {
        var ret = this.iir;
        dbg_log("read interrupt identification: " + h(this.iir), LOG_SERIAL);
        this.iir ^= 1;

        return ret;
    }, this);
    io.register_write(port | 2, function(out_byte)
    {
        dbg_log("fifo control: " + h(out_byte), LOG_SERIAL);
        this.fifo_control = out_byte;
    }, this);

    io.register_read(port | 3, function()
    {
        dbg_log("read line control: " + h(this.line_control), LOG_SERIAL);
        return this.line_control;
    }, this);
    io.register_write(port | 3, function(out_byte)
    {
        dbg_log("line control: " + h(out_byte), LOG_SERIAL);
        this.line_control = out_byte;
    }, this);


    io.register_read(port | 4, function()
    {
        return this.modem_control;
    }, this);
    io.register_write(port | 4, function(out_byte)
    {
        dbg_log("modem control: " + h(out_byte), LOG_SERIAL);
        this.modem_control = out_byte;
    }, this);

    io.register_read(port | 5, function()
    {
        var line_status = 0;

        if(this.input.length)
        {
            line_status |= 1;
        }

        line_status |= 0x20 | 0x40;

        dbg_log("read line status: " + h(line_status), LOG_SERIAL);
        return line_status;
    }, this);
    io.register_write(port | 5, function(out_byte)
    {
        dbg_log("Factory test write", LOG_SERIAL);
    }, this);

    io.register_read(port | 6, function()
    {
        dbg_log("read modem status: " + h(this.modem_status), LOG_SERIAL);
        return this.modem_status;
    }, this);
    io.register_write(port | 6, function(out_byte)
    {
        dbg_log("Unkown register write (base+6)", LOG_SERIAL);
    }, this);

    io.register_read(port | 7, function()
    {
        return this.scratch_register;
    }, this);
    io.register_write(port | 7, function(out_byte)
    {
        this.scratch_register = out_byte;
    }, this);
}

UART.prototype.push_irq = function()
{
    this.pic.push_irq(this.irq);
};

