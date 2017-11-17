"use strict";

/**
 * @constructor
 * @param {CPU} cpu
 */
function DMA(cpu)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    this.channel_addr = new Int32Array(8);
    this.channel_count = new Int32Array(8);
    this.channel_mask = new Uint8Array(8);
    this.channel_mode = new Uint8Array(8);
    this.channel_on_unmask = [];

    this.lsb_msb_flipflop = 0;

    var io = cpu.io;

    io.register_write(0x00, this, this.port_addr_write.bind(this, 0));
    io.register_write(0x02, this, this.port_addr_write.bind(this, 1));
    io.register_write(0x04, this, this.port_addr_write.bind(this, 2));
    io.register_write(0x06, this, this.port_addr_write.bind(this, 3));
    io.register_write(0x01, this, this.port_count_write.bind(this, 0));
    io.register_write(0x03, this, this.port_count_write.bind(this, 1));
    io.register_write(0x05, this, this.port_count_write.bind(this, 2));
    io.register_write(0x07, this, this.port_count_write.bind(this, 3));

    io.register_write(0xC0, this, this.port_addr_write.bind(this, 4));
    io.register_write(0xC4, this, this.port_addr_write.bind(this, 5));
    io.register_write(0xC8, this, this.port_addr_write.bind(this, 6));
    io.register_write(0xCC, this, this.port_addr_write.bind(this, 7));
    io.register_write(0xC2, this, this.port_count_write.bind(this, 4));
    io.register_write(0xC6, this, this.port_count_write.bind(this, 5));
    io.register_write(0xCA, this, this.port_count_write.bind(this, 6));
    io.register_write(0xCE, this, this.port_count_write.bind(this, 7));

    io.register_write(0x87, this, this.port_page_write.bind(this, 0));
    io.register_write(0x83, this, this.port_page_write.bind(this, 1));
    io.register_write(0x81, this, this.port_page_write.bind(this, 2));
    io.register_write(0x82, this, this.port_page_write.bind(this, 3));
    io.register_write(0x8F, this, this.port_page_write.bind(this, 4));
    io.register_write(0x8B, this, this.port_page_write.bind(this, 5));
    io.register_write(0x89, this, this.port_page_write.bind(this, 6));
    io.register_write(0x8A, this, this.port_page_write.bind(this, 7));

    io.register_write(0x0A, this, this.port_singlemask_write.bind(this, 0));
    io.register_write(0xD4, this, this.port_singlemask_write.bind(this, 4));
    io.register_write(0x0F, this, this.port_multimask_write.bind(this, 0));
    io.register_write(0xDE, this, this.port_multimask_write.bind(this, 4));

    io.register_write(0x0B, this, this.port_mode_write.bind(this, 0));
    io.register_write(0xD6, this, this.port_mode_write.bind(this, 4));

    io.register_write(0x0C, this, this.portC_write);
    io.register_write(0xD8, this, this.portC_write);
}

DMA.prototype.get_state = function()
{
    return [
        this.channel_addr,
        this.channel_count,
        this.lsb_msb_flipflop,
    ];
};

DMA.prototype.set_state = function(state)
{
    this.channel_addr = state[0];
    this.channel_count = state[1];
    this.lsb_msb_flipflop = state[2];
};

DMA.prototype.port_count_write = function(channel, data_byte)
{
    dbg_log("count write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_count[channel] = this.flipflop_get(this.channel_count[channel], data_byte);
}

DMA.prototype.port_addr_write = function(channel, data_byte)
{
    dbg_log("addr write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_addr[channel] = this.flipflop_get(this.channel_addr[channel], data_byte);
}

DMA.prototype.port_page_write = function(channel, data_byte)
{
    dbg_log("page write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_addr[channel] = this.channel_addr[channel] & 0xFFFF | data_byte << 16;
}

DMA.prototype.port_page_read = function(channel)
{
    dbg_log("page read [" + channel + "]", LOG_DMA);
    return this.channel_addr[channel] >> 16;
}

DMA.prototype.port_singlemask_write = function(channel_offset, data_byte)
{
    var channel = data_byte & 0x4 + channel_offset;
    var value = !!(data_byte & 0x8);
    dbg_log("singlechannel mask write [" + channel + "] = " + value, LOG_DMA);
    this.update_mask(channel, value);
}

DMA.prototype.port_multimask_write = function(channel_offset, data_byte)
{
    dbg_log("multichannel mask write: " + h(data_byte), LOG_DMA);
    for(var i = 0; i < 4; i++)
    {
        this.update_mask(channel_offset + i, data_byte & (1 << i));
    }
}

DMA.prototype.port_multimask_read = function(channel_offset)
{
    var value = 0;
    value |= this.channel_mask[channel_offset + 0] * 0x1;
    value |= this.channel_mask[channel_offset + 1] * 0x2;
    value |= this.channel_mask[channel_offset + 2] * 0x4;
    value |= this.channel_mask[channel_offset + 3] * 0x8;
    dbg_log("multichannel mask read: " + h(value), LOG_DMA);
    return value;
}

DMA.prototype.port_mode_write = function(channel_offset, data_byte)
{
    var channel = data_byte & 0x4 + channel_offset;
    dbg_log("mode write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_mode[channel] = data_byte;
}

DMA.prototype.portC_write = function(data_byte)
{
    dbg_log("flipflop reset", LOG_DMA);
    this.lsb_msb_flipflop = 0;
}

DMA.prototype.on_unmask = function(channel, fn)
{
    this.channel_on_unmask[channel] = fn;
}

DMA.prototype.update_mask = function(channel, value)
{
    if(this.channel_mask[channel] !== value)
    {
        this.channel_mask[channel] ^= 1;

        if(!value && this.channel_on_unmask[channel])
        {
            dbg_log("firing on_unmask[" + channel + "]", LOG_DMA);
            this.channel_on_unmask[channel]();
        }
    }
}
/*
DMA.prototype.port_write = function(port, data_byte)
{
    dbg_log("port " + port + " write " + data_byte, LOG_DMA);

    if(port < 8)
    {
        var channel = port >> 1;

        if(port & 1)
        {
            this.channel_count[channel] = this.flipflop_get(this.channel_count[channel], data_byte);
        }
        else
        {
            this.channel_addr[channel] = this.flipflop_get(this.channel_addr[channel], data_byte);
        }
    }
};

DMA.prototype.port_read = function(port)
{
    if(port < 8)
    {
        var channel = port >> 1;

        if(port & 1)
        {
            return this.channel_count[channel];
        }
        else
        {
            // Bug?
            return this.channel_addr[channel];
        }
    }
    else
    {
        dbg_log("port " + h(port) + " read", LOG_DMA);
    }
};


DMA.prototype.portA_write = function(data_byte)
{
    dbg_log("port A write: " + h(data_byte), LOG_DMA);
};

DMA.prototype.portB_write = function(data_byte)
{
    dbg_log("port B write: " + h(data_byte), LOG_DMA);
};

DMA.prototype.portC_write = function(data_byte)
{
    this.lsb_msb_flipflop = 0;
}

DMA.prototype.port81_write = function(data_byte)
{
    this.channel_addr[2] = this.channel_addr[2] & 0xFFFF | data_byte << 16;
}
*/

// read data, write to memory
DMA.prototype.do_read = function(buffer, start, len, channel, fn)
{
    var read_count = this.channel_count[channel] + 1,
        addr = this.channel_addr[channel];

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
        var cpu = this.cpu;
        this.channel_addr[channel] += read_count;

        buffer.get(start, read_count, function(data)
        {
            cpu.write_blob(data, addr);
            fn(false);
        });
    }
};

// write data, read memory
DMA.prototype.do_write = function(buffer, start, len, channel, fn)
{
    var read_count = this.channel_count[channel],
        addr = this.channel_addr[channel];

    dbg_log("DMA write channel " + channel, LOG_DMA);
    dbg_log("to " + h(addr) + " len " + h(read_count), LOG_DMA);

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
        this.channel_addr[channel] += read_count;

        buffer.set(start,
                this.cpu.mem8.subarray(addr, addr + read_count + 1),
                function() {
                    fn(false);
                }
            );
    }
}

DMA.prototype.flipflop_get = function(old_dword, new_byte)
{
    this.lsb_msb_flipflop ^= 1;

    if(this.lsb_msb_flipflop)
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
