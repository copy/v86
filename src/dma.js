"use strict";

/**
 * @constructor
 */
function DMA(dev)
{
    var io = dev.io,
        memory = dev.memory,

        channels = [
            { address: 0, count: 0 },
            { address: 0, count: 0 },
            { address: 0, count: 0 },
            { address: 0, count: 0 }
        ],

        lsb_msb_flipflop = 0;

    io.register_write(0x04, port_write.bind(0, 0x04));
    io.register_write(0x05, port_write.bind(0, 0x05));
    io.register_write(0x0A, portA_write);
    io.register_write(0x0B, portB_write);
    io.register_write(0x0C, portC_write);
    io.register_write(0x81, port81_write);

    function port_write(port, data_byte)
    {
        dbg_log("port " + port + " write " + data_byte, LOG_DMA);

        if(port < 8)
        {
            var channel = port >> 1;

            if(port & 1)
            {
                channels[channel].count = flipflop_get(channels[channel].count, data_byte);
            }
            else
            {
                channels[channel].address = flipflop_get(channels[channel].address, data_byte);
            }
        }
    };

    function port_read(port)
    {
        if(port < 8)
        {
            var channel = port >> 1;

            if(port & 1)
            {
                return channels[channel].count;
            }
            else
            {
                // Bug?
                return channels[channel].address;
            }
        }
        else
        {
            dbg_log("port " + h(port) + " read", LOG_DMA);
        }
    };

    function portA_write(data_byte)
    {
        dbg_log("port A write: " + h(data_byte), LOG_DMA);
    };

    function portB_write(data_byte)
    {
        dbg_log("port B write: " + h(data_byte), LOG_DMA);
    };

    function portC_write(data_byte)
    {
        lsb_msb_flipflop = 0;
    }

    function port81_write(data_byte)
    {
        channels[2].address = channels[2].address & 0xFFFF | data_byte << 16;
    }

    // read data, write to memory
    this.do_read = function(buffer, start, len, channel, fn)
    {
        var read_count = channels[channel].count + 1,
            addr = channels[channel].address;

        dbg_log("DMA write channel " + channel, LOG_DMA);
        dbg_log("to " + h(addr) + " len " + h(read_count), LOG_DMA);

        if(len < read_count)
        {
            dbg_log("DMA should read more than provided: " + h(len) + " " + h(read_count), LOG_DMA);
        }

        if(start + read_count > buffer.byteLength)
        {
            dbg_log("DMA read outside of buffer", LOG_DMA);
            fn(true);
        }
        else
        {
            channels[channel].address += read_count;

            buffer.get(start, read_count, function(data)
            {
                memory.write_blob(data, addr);
                fn(false);
            });
        }
    };

    // write data, read memory
    this.do_write = function(buffer, start, len, channel, fn)
    {
        var read_count = channels[channel].count,
            addr = channels[channel].address;

        dbg_log("DMA write channel " + channel, LOG_DMA);
        dbg_log("to " + h(addr) + " len " + h(read_count), LOG_DMA);
        //dbg_log(channels[channel], LOG_DMA);

        if(len < read_count)
        {
            dbg_log("DMA should read more than provided", LOG_DMA);
        }


        if(start + read_count > buffer.byteLength)
        {
            dbg_log("DMA write outside of buffer", LOG_DMA);
            fn(true);
        }
        else
        {
            channels[channel].address += read_count;

            buffer.set(start,
                    new Uint8Array(memory.buffer, addr, read_count + 1),
                    function() {
                        fn(false);
                    }
                );
        }
    }

    function flipflop_get(old_dword, new_byte)
    {
        lsb_msb_flipflop ^= 1;

        if(lsb_msb_flipflop)
        {
            // low byte
            return old_dword & ~0xFF | new_byte;
        }
        else
        {
            // high byte
            return old_dword & ~0xFF00 | new_byte << 8;
        }
    }
}
