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
function UART(dev, port, adapter)
{
    var io = dev.io,
        pic = dev.pic,

        line = "",
        baud_rate = 0,

        line_control = 0,
        line_status = 0,

        fifo_control = 0,
        interrupt_enable = 0,

        modem_control = 0,
        modem_status = 0,

        scratch_register = 0,

        irq = 0,

        input = new ByteQueue(4096);

    if(port === 0x3E8 || port === 0x3F8)
    {
        irq = 4;
    }
    else if(port === 0x3E8 || port === 0x3E8)
    {
        irq = 3;
    }
    else
    {
        dbg_log("Invalid port: " + h(port), LOG_SERIAL);
        return;
    }

    function data_received(data)
    {
        input.push(data);

        if(interrupt_enable & 1)
        {
            push_irq();
        }
    }
    adapter.init(data_received);

    function push_irq()
    {
        pic.push_irq(irq);
    }

    io.register_write(port, function(out_byte) 
    {
        if(line_control & DLAB)
        {
            baud_rate = baud_rate & ~0xFF | out_byte;
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
                adapter.put_line(line);
                line = "";
            }
            else
            {
                line += String.fromCharCode(out_byte);
            }
        }
        else
        {
            adapter.put_str(String.fromCharCode(out_byte));
        }
    });

    io.register_write(port | 1, function(out_byte)
    {
        if(line_control & DLAB)
        {
            baud_rate = baud_rate & 0xFF | out_byte << 8;
            dbg_log("baud rate: " + h(baud_rate), LOG_SERIAL);
        }
        else
        {
            interrupt_enable = out_byte;
            dbg_log("interrupt enable: " + h(out_byte), LOG_SERIAL);
        }
    });

    io.register_read(port, function()
    {
        if(line_control & DLAB)
        {
            return baud_rate & 0xFF;
        }
        else
        {
            var data = input.shift();

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

    io.register_read(port | 1, function()
    {
        if(line_control & DLAB)
        {
            return baud_rate >> 8;
        }
        else
        {
            return interrupt_enable;
        }
    });

    io.register_read(port | 2, function()
    {
        return fifo_control;
    });
    io.register_write(port | 2, function(out_byte)
    {
        dbg_log("fifo control: " + h(out_byte), LOG_SERIAL);
        fifo_control = out_byte;
    });

    io.register_read(port | 3, function()
    {
        return line_control;
    });
    io.register_write(port | 3, function(out_byte)
    {
        dbg_log("line control: " + h(out_byte), LOG_SERIAL);
        line_control = out_byte;
    });


    io.register_read(port | 4, function()
    {
        return modem_control;
    });
    io.register_write(port | 4, function(out_byte)
    {
        dbg_log("modem control: " + h(out_byte), LOG_SERIAL);
        modem_control = out_byte;
    });

    io.register_read(port | 5, function()
    {
        var line_status = 0;

        if(input.length)
        {
            line_status |= 1;
        }

        line_status |= 0x20;

        //dbg_log("read line status: " + h(line_status), LOG_SERIAL);
        return line_status;
    });
    io.register_write(port | 5, function(out_byte)
    {
    });

    io.register_read(port | 6, function()
    {
        //dbg_log("read modem status: " + h(modem_status), LOG_SERIAL);
        return modem_status;
    });
    io.register_write(port | 6, function(out_byte)
    {
        modem_status = out_byte;
    });

    io.register_read(port | 7, function()
    {
        return scratch_register;
    });
    io.register_write(port | 7, function(out_byte)
    {
        scratch_register = out_byte;
    });
}
