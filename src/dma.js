import { track_state_io } from "./state_io.js";
import { LOG_DMA } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";

/**
 * @constructor
 * @param {CPU} cpu
 */
export function DMA(cpu)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    this.channel_page = new Uint8Array(8);
    this.channel_pagehi = new Uint8Array(8);
    this.channel_addr = new Uint16Array(8);
    this.channel_addr_init = new Uint16Array(8);
    this.channel_count = new Uint16Array(8);
    this.channel_count_init = new Uint16Array(8);
    this.channel_mask = new Uint8Array(8);
    this.channel_mode = new Uint8Array(8);
    this.unmask_listeners = [];

    this.lsb_msb_flipflop = 0;

    /** @type {number} machine resets so far: a transfer completing after one is dropped */
    this.epoch = 0;

    var io = cpu.io;

    io.register_write(0x00, this, this.port_addr_write.bind(this, 0));
    io.register_write(0x02, this, this.port_addr_write.bind(this, 1));
    io.register_write(0x04, this, this.port_addr_write.bind(this, 2));
    io.register_write(0x06, this, this.port_addr_write.bind(this, 3));
    io.register_write(0x01, this, this.port_count_write.bind(this, 0));
    io.register_write(0x03, this, this.port_count_write.bind(this, 1));
    io.register_write(0x05, this, this.port_count_write.bind(this, 2));
    io.register_write(0x07, this, this.port_count_write.bind(this, 3));

    io.register_read(0x00, this, this.port_addr_read.bind(this, 0));
    io.register_read(0x02, this, this.port_addr_read.bind(this, 1));
    io.register_read(0x04, this, this.port_addr_read.bind(this, 2));
    io.register_read(0x06, this, this.port_addr_read.bind(this, 3));
    io.register_read(0x01, this, this.port_count_read.bind(this, 0));
    io.register_read(0x03, this, this.port_count_read.bind(this, 1));
    io.register_read(0x05, this, this.port_count_read.bind(this, 2));
    io.register_read(0x07, this, this.port_count_read.bind(this, 3));

    io.register_write(0xC0, this, this.port_addr_write.bind(this, 4));
    io.register_write(0xC4, this, this.port_addr_write.bind(this, 5));
    io.register_write(0xC8, this, this.port_addr_write.bind(this, 6));
    io.register_write(0xCC, this, this.port_addr_write.bind(this, 7));
    io.register_write(0xC2, this, this.port_count_write.bind(this, 4));
    io.register_write(0xC6, this, this.port_count_write.bind(this, 5));
    io.register_write(0xCA, this, this.port_count_write.bind(this, 6));
    io.register_write(0xCE, this, this.port_count_write.bind(this, 7));

    io.register_read(0xC0, this, this.port_addr_read.bind(this, 4));
    io.register_read(0xC4, this, this.port_addr_read.bind(this, 5));
    io.register_read(0xC8, this, this.port_addr_read.bind(this, 6));
    io.register_read(0xCC, this, this.port_addr_read.bind(this, 7));
    io.register_read(0xC2, this, this.port_count_read.bind(this, 4));
    io.register_read(0xC6, this, this.port_count_read.bind(this, 5));
    io.register_read(0xCA, this, this.port_count_read.bind(this, 6));
    io.register_read(0xCE, this, this.port_count_read.bind(this, 7));

    io.register_write(0x87, this, this.port_page_write.bind(this, 0));
    io.register_write(0x83, this, this.port_page_write.bind(this, 1));
    io.register_write(0x81, this, this.port_page_write.bind(this, 2));
    io.register_write(0x82, this, this.port_page_write.bind(this, 3));
    io.register_write(0x8F, this, this.port_page_write.bind(this, 4));
    io.register_write(0x8B, this, this.port_page_write.bind(this, 5));
    io.register_write(0x89, this, this.port_page_write.bind(this, 6));
    io.register_write(0x8A, this, this.port_page_write.bind(this, 7));

    io.register_read(0x87, this, this.port_page_read.bind(this, 0));
    io.register_read(0x83, this, this.port_page_read.bind(this, 1));
    io.register_read(0x81, this, this.port_page_read.bind(this, 2));
    io.register_read(0x82, this, this.port_page_read.bind(this, 3));
    io.register_read(0x8F, this, this.port_page_read.bind(this, 4));
    io.register_read(0x8B, this, this.port_page_read.bind(this, 5));
    io.register_read(0x89, this, this.port_page_read.bind(this, 6));
    io.register_read(0x8A, this, this.port_page_read.bind(this, 7));

    io.register_write(0x487, this, this.port_pagehi_write.bind(this, 0));
    io.register_write(0x483, this, this.port_pagehi_write.bind(this, 1));
    io.register_write(0x481, this, this.port_pagehi_write.bind(this, 2));
    io.register_write(0x482, this, this.port_pagehi_write.bind(this, 3));
    io.register_write(0x48B, this, this.port_pagehi_write.bind(this, 5));
    io.register_write(0x489, this, this.port_pagehi_write.bind(this, 6));
    io.register_write(0x48A, this, this.port_pagehi_write.bind(this, 7));

    io.register_read(0x487, this, this.port_pagehi_read.bind(this, 0));
    io.register_read(0x483, this, this.port_pagehi_read.bind(this, 1));
    io.register_read(0x481, this, this.port_pagehi_read.bind(this, 2));
    io.register_read(0x482, this, this.port_pagehi_read.bind(this, 3));
    io.register_read(0x48B, this, this.port_pagehi_read.bind(this, 5));
    io.register_read(0x489, this, this.port_pagehi_read.bind(this, 6));
    io.register_read(0x48A, this, this.port_pagehi_read.bind(this, 7));

    io.register_write(0x0A, this, this.port_singlemask_write.bind(this, 0));
    io.register_write(0xD4, this, this.port_singlemask_write.bind(this, 4));
    io.register_write(0x0F, this, this.port_multimask_write.bind(this, 0));
    io.register_write(0xDE, this, this.port_multimask_write.bind(this, 4));

    io.register_read(0x0F, this, this.port_multimask_read.bind(this, 0));
    io.register_read(0xDE, this, this.port_multimask_read.bind(this, 4));

    io.register_write(0x0B, this, this.port_mode_write.bind(this, 0));
    io.register_write(0xD6, this, this.port_mode_write.bind(this, 4));

    io.register_write(0x0C, this, this.portC_write);
    io.register_write(0xD8, this, this.portC_write);
}

DMA.prototype.get_state = function()
{
    return [
        this.channel_page,
        this.channel_pagehi,
        this.channel_addr,
        this.channel_addr_init,
        this.channel_count,
        this.channel_count_init,
        this.channel_mask,
        this.channel_mode,
        this.lsb_msb_flipflop,
    ];
};

DMA.prototype.set_state = function(state)
{
    this.channel_page = state[0];
    this.channel_pagehi = state[1];
    this.channel_addr = state[2];
    this.channel_addr_init = state[3];
    this.channel_count = state[4];
    this.channel_count_init = state[5];
    this.channel_mask = state[6];
    this.channel_mode = state[7];
    this.lsb_msb_flipflop = state[8];
};

DMA.prototype.port_count_write = function(channel, data_byte)
{
    dbg_log("count write [" + channel + "] = " + h(data_byte), LOG_DMA);

    this.channel_count[channel] =
        this.flipflop_get(this.channel_count[channel], data_byte, false);

    this.channel_count_init[channel] =
        this.flipflop_get(this.channel_count_init[channel], data_byte, true);
};

DMA.prototype.port_count_read = function(channel)
{
    dbg_log("count read [" + channel + "] -> " + h(this.channel_count[channel]), LOG_DMA);
    return this.flipflop_read(this.channel_count[channel]);
};

DMA.prototype.port_addr_write = function(channel, data_byte)
{
    dbg_log("addr write [" + channel + "] = " + h(data_byte), LOG_DMA);

    this.channel_addr[channel] =
        this.flipflop_get(this.channel_addr[channel], data_byte, false);

    this.channel_addr_init[channel] =
        this.flipflop_get(this.channel_addr_init[channel], data_byte, true);
};

DMA.prototype.port_addr_read = function(channel)
{
    dbg_log("addr read [" + channel + "] -> " + h(this.channel_addr[channel]), LOG_DMA);
    return this.flipflop_read(this.channel_addr[channel]);
};

DMA.prototype.port_pagehi_write = function(channel, data_byte)
{
    dbg_log("pagehi write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_pagehi[channel] = data_byte;
};

DMA.prototype.port_pagehi_read = function(channel)
{
    dbg_log("pagehi read [" + channel + "]", LOG_DMA);
    return this.channel_pagehi[channel];
};

DMA.prototype.port_page_write = function(channel, data_byte)
{
    dbg_log("page write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_page[channel] = data_byte;
};

DMA.prototype.port_page_read = function(channel)
{
    dbg_log("page read [" + channel + "]", LOG_DMA);
    return this.channel_page[channel];
};

DMA.prototype.port_singlemask_write = function(channel_offset, data_byte)
{
    var channel = (data_byte & 0x3) + channel_offset;
    var value = data_byte & 0x4 ? 1 : 0;
    dbg_log("singlechannel mask write [" + channel + "] = " + value, LOG_DMA);
    this.update_mask(channel, value);
};

DMA.prototype.port_multimask_write = function(channel_offset, data_byte)
{
    dbg_log("multichannel mask write: " + h(data_byte), LOG_DMA);
    for(var i = 0; i < 4; i++)
    {
        this.update_mask(channel_offset + i, data_byte & (1 << i));
    }
};

DMA.prototype.port_multimask_read = function(channel_offset)
{
    var value = 0;
    value |= this.channel_mask[channel_offset + 0];
    value |= this.channel_mask[channel_offset + 1] << 1;
    value |= this.channel_mask[channel_offset + 2] << 2;
    value |= this.channel_mask[channel_offset + 3] << 3;
    dbg_log("multichannel mask read: " + h(value), LOG_DMA);
    return value;
};

DMA.prototype.port_mode_write = function(channel_offset, data_byte)
{
    var channel = (data_byte & 0x3) + channel_offset;
    dbg_log("mode write [" + channel + "] = " + h(data_byte), LOG_DMA);
    this.channel_mode[channel] = data_byte;
};

DMA.prototype.portC_write = function(data_byte)
{
    dbg_log("flipflop reset", LOG_DMA);
    this.lsb_msb_flipflop = 0;
};

DMA.prototype.on_unmask = function(fn, this_value)
{
    this.unmask_listeners.push({
        fn: fn,
        this_value: this_value,
    });
};

DMA.prototype.update_mask = function(channel, value)
{
    if(this.channel_mask[channel] !== value)
    {
        this.channel_mask[channel] = value;

        if(!value)
        {
            dbg_log("firing on_unmask(" + channel + ")", LOG_DMA);
            for(var i = 0; i < this.unmask_listeners.length; i++)
            {
                this.unmask_listeners[i].fn.call(
                    this.unmask_listeners[i].this_value,
                    channel
                );
            }
        }
    }
};

// read data, write to memory
DMA.prototype.do_read = function(buffer, start, len, channel, fn)
{
    var read_count = this.count_get_8bit(channel),
        addr = this.address_get_8bit(channel);

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
        try
        {
            if(addr + read_count > 0x100000000) throw new RangeError("DMA exceeds 32-bit address width");
            cpu.validate_physical_range(addr, read_count);
        }
        catch(error)
        {
            if(!(error instanceof RangeError)) throw error;
            fn(true);
            return;
        }
        this.channel_addr[channel] += read_count;

        const epoch = this.epoch;
        // (the image's read; when it fails, fn gets the error and this, to try
        // it again into the same memory: the registers are already as after
        // the transfer, docs/disk-persistence-plan.md, disk_error "stop")
        const attempt = () =>
        {
            if(epoch !== this.epoch) return;
            track_state_io(cpu, done => buffer.get(start, read_count, done), (data, error) =>
            {
                // (a machine reset in between: the transfer belongs to the machine before it)
                if(epoch !== this.epoch) return;
                // (the image failed the read: docs/disk-persistence-plan.md D3)
                if(error || !data)
                {
                    fn(true, error || new Error("the disk image returned no data"), attempt);
                    return;
                }
                try
                {
                    cpu.write_blob_physical(data, addr);
                }
                catch(error)
                {
                    if(!(error instanceof RangeError)) throw error;
                    fn(true);
                    return;
                }
                fn(false);
            });
        };
        attempt();
    }
};

// write data, read memory
// start and len in bytes
DMA.prototype.do_write = function(buffer, start, len, channel, fn)
{
    var read_count = (this.channel_count[channel] + 1) & 0xFFFF,
        bytes_per_count = channel >= 5 ? 2 : 1,
        read_bytes = read_count * bytes_per_count,
        addr = this.address_get_8bit(channel),
        unfinished = false,
        want_more = false,
        autoinit = this.channel_mode[channel] & 0x10;

    dbg_log("DMA write channel " + channel, LOG_DMA);
    dbg_log("to " + h(addr) + " len " + h(read_bytes), LOG_DMA);

    if(len < read_bytes)
    {
        dbg_log("DMA should read more than provided", LOG_DMA);
        read_count = Math.floor(len / bytes_per_count);
        read_bytes = read_count * bytes_per_count;
        unfinished = true;
    }
    else if(len > read_bytes)
    {
        dbg_log("DMA attempted to read more than provided", LOG_DMA);
        want_more = true;
    }

    if(start + read_bytes > buffer.byteLength)
    {
        dbg_log("DMA write outside of buffer", LOG_DMA);
        fn(true);
    }
    else
    {
        let data;
        try
        {
            if(addr + read_bytes > 0x100000000) throw new RangeError("DMA exceeds 32-bit address width");
            data = this.cpu.read_blob_physical(addr, read_bytes);
        }
        catch(error)
        {
            if(!(error instanceof RangeError)) throw error;
            fn(true);
            return;
        }
        this.channel_addr[channel] += read_count;
        this.channel_count[channel] -= read_count;
        // when complete, counter should underflow to 0xFFFF

        if(!unfinished && autoinit)
        {
            dbg_log("DMA autoinit", LOG_DMA);
            this.channel_addr[channel] = this.channel_addr_init[channel];
            this.channel_count[channel] = this.channel_count_init[channel];
        }

        const epoch = this.epoch;
        // (the image's write; when it fails, fn gets the error and this, to
        // write the same data again; after a reset it still lands, unanswered,
        // as a held write does in src/block_backend.js)
        const attempt = () =>
        {
            track_state_io(this.cpu, done => buffer.set(start, data, done),
                error =>
                {
                    if(epoch !== this.epoch) return;
                    if(error)
                    {
                        fn(true, error, attempt);
                        return;
                    }
                    if(want_more && autoinit)
                    {
                        dbg_log("DMA continuing from start", LOG_DMA);
                        this.do_write(buffer, start + read_bytes, len - read_bytes, channel, fn);
                    }
                    else
                    {
                        fn(false);
                    }
                }
            );
        };
        attempt();
    }
};

/**
 * Machine reset or power-on: transfers still in flight belong to the machine
 * before it and complete without effect (the controller's registers are
 * programmed again by the firmware)
 */
DMA.prototype.cancel_transfers = function()
{
    this.epoch++;
};

DMA.prototype.address_get_8bit = function(channel)
{
    var addr = this.channel_addr[channel];

    // http://wiki.osdev.org/ISA_DMA#16_bit_issues
    if(channel >= 5)
    {
        addr = (addr << 1);
    }

    addr &= 0xFFFF;
    addr |= this.channel_page[channel] << 16;
    addr |= this.channel_pagehi[channel] << 24;

    return addr >>> 0;
};

DMA.prototype.count_get_8bit = function(channel)
{
    var count = this.channel_count[channel] + 1;

    if(channel >= 5)
    {
        count *= 2;
    }

    return count;
};

DMA.prototype.flipflop_get = function(old_dword, new_byte, continuing)
{
    if(!continuing)
    {
        this.lsb_msb_flipflop ^= 1;
    }

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
};

DMA.prototype.flipflop_read = function(dword)
{
    this.lsb_msb_flipflop ^= 1;

    if(this.lsb_msb_flipflop)
    {
        // low byte
        return dword & 0xFF;
    }
    else
    {
        // high byte
        return (dword >> 8) & 0xFF;
    }
};
