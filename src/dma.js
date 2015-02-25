"use strict";

/**
 * @constructor
 * @param {CPU} dev
 */
function DMA(dev)
{
    /** @const */
    this.memory = dev.memory;

    this.channels = [
        { address: 0, count: 0 },
        { address: 0, count: 0 },
        { address: 0, count: 0 },
        { address: 0, count: 0 }
    ];

    this.lsb_msb_flipflop = 0;

    var io = dev.io;
    io.register_write(0x04, this, this.port_write.bind(this, 0x04));
    io.register_write(0x05, this, this.port_write.bind(this, 0x05));
    io.register_write(0x0A, this, this.portA_write);
    io.register_write(0x0B, this, this.portB_write);
    io.register_write(0x0C, this, this.portC_write);
    io.register_write(0x81, this, this.port81_write);

    /** @const */
    this._state_skip = [
        this.memory,
    ];
};

DMA.prototype.port_write = function(port, data_byte)
{
    dbg_log("port " + port + " write " + data_byte, LOG_DMA);

    if(port < 8)
    {
        var channel = port >> 1;

        if(port & 1)
        {
            this.channels[channel].count = this.flipflop_get(this.channels[channel].count, data_byte);
        }
        else
        {
            this.channels[channel].address = this.flipflop_get(this.channels[channel].address, data_byte);
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
            return this.channels[channel].count;
        }
        else
        {
            // Bug?
            return this.channels[channel].address;
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
    this.channels[2].address = this.channels[2].address & 0xFFFF | data_byte << 16;
}

// read data, write to memory
DMA.prototype.do_read = function(buffer, start, len, channel, fn)
{
    var read_count = this.channels[channel].count + 1,
        addr = this.channels[channel].address;

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
        var memory = this.memory;
        this.channels[channel].address += read_count;

        buffer.get(start, read_count, function(data)
        {
            memory.write_blob(data, addr);
            fn(false);
        });
    }
};

// write data, read memory
DMA.prototype.do_write = function(buffer, start, len, channel, fn)
{
    var read_count = this.channels[channel].count,
        addr = this.channels[channel].address;

    dbg_log("DMA write channel " + channel, LOG_DMA);
    dbg_log("to " + h(addr) + " len " + h(read_count), LOG_DMA);
    //dbg_log(this.channels[channel], LOG_DMA);

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
        this.channels[channel].address += read_count;

        buffer.set(start,
                new Uint8Array(this.memory.buffer, addr, read_count + 1),
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
