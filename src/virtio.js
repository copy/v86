"use strict";


/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {FS} filesystem
 */
function VirtIO(cpu, bus, filesystem)
{
    // http://ozlabs.org/~rusty/virtio-spec/virtio-0.9.5.pdf

    this.pci_space = [
        0xf4, 0x1a, 0x09, 0x10, 0x07, 0x05, 0x10, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0xa8, 0x00, 0x00, 0x00, 0x10, 0xbf, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x1a, 0x09, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
    ];
    this.pci_id = 0x06 << 3;
    this.pci_bars = [
        {
            size: 256,
        },
    ];
    this.name = "virtio";

    var io = cpu.io;

    io.register_read(0xA800, this,
        function() {
            dbg_log("Read device features", LOG_VIRTIO);
            return 1;
        },
        undefined,
        function()
        {
            dbg_log("Read device features", LOG_VIRTIO);
            return 1;
        }
    );

    io.register_write(0xA804, this, undefined, undefined, function(data)
    {
        // write guest features
        dbg_log("Guest feature selection: " + h(data, 8), LOG_VIRTIO);
    });

    io.register_write(0xA80E, this, undefined, function(data)
    {
        // rw queue select
        dbg_log("Queue select: " + h(data, 4), LOG_VIRTIO);
        this.queue_select = data;
    }, undefined);

    io.register_read(0xA80C, this, undefined, function()
    {
        // read queue size
        dbg_log("Read queue size", LOG_VIRTIO);
        return this.queue_size;
    }, undefined);

    io.register_read(0xA808, this, undefined, undefined, function()
    {
        // rw queue address
        dbg_log("Read queue address", LOG_VIRTIO);

        if(this.queue_select === 0)
        {
            return this.queue_address;
        }
        else
        {
            // queue does not exist
            return 0;
        }
    });

    io.register_write(0xA808, this, undefined, undefined, function(data)
    {
        // rw queue address
        dbg_log("Write queue address: " + h(data, 8), LOG_VIRTIO);
        this.queue_address = data;
    });

    io.register_write(0xA812, this, function(data)
    {
        dbg_log("Write device status: " + h(data, 2), LOG_VIRTIO);

        if(data === 0)
        {
            dbg_log("Reset", LOG_VIRTIO);
            this.reset();
        }
        else if(data & 0x80)
        {
            dbg_log("Warning: Device status failed", LOG_VIRTIO);
        }
        else
        {
            dbg_log(((data & 1) ? "ACKNOWLEDGE " : "") +
                    ((data & 2) ? "DRIVER " : "") +
                    ((data & 4) ? "DRIVER_OK" : ""),
                    LOG_VIRTIO);

        }

        this.device_status = data;
    });

    io.register_read(0xA812, this, function()
    {
        dbg_log("Read device status: " + h(this.device_status), LOG_VIRTIO);
        return this.device_status;
    });

    io.register_read(0xA813, this, function()
    {
        dbg_log("Read isr", LOG_VIRTIO);

        // reading resets the isr
        var isr = this.isr;
        this.isr = 0;
        this.pci.lower_irq(this.pci_id);
        return isr;
    });

    io.register_write(0xA810, this, undefined, function(data)
    {
        dbg_log("Write queue notify: " + h(data, 4), LOG_VIRTIO);

        // only queue 0 supported
        dbg_assert(data === 0);

        var queue_start = this.queue_address << 12;
        var ring_start = queue_start + 16 * this.queue_size;
        var ring_desc_start = ring_start + 4;

        var //flags = this.cpu.read16(ring_start),
            // index of the next free ring
            idx = this.cpu.read16(ring_start + 2);

        dbg_log("idx=" + h(idx, 4), LOG_VIRTIO);
        //dbg_assert(idx < this.queue_size);

        var mask = this.queue_size - 1;
        idx &= mask;

        while(this.last_idx !== idx)
        {
            var desc_idx = this.cpu.read16(ring_desc_start + this.last_idx * 2);
            this.handle_descriptor(desc_idx);

            this.last_idx = this.last_idx + 1 & mask;
        }
    });

    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {PCI} */
    this.pci = cpu.devices.pci;

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.queue_select = 0;
    this.device_status = 0;
    this.isr = 0;

    // these should be stored per queue if there is more than one queue
    this.last_idx = 0;
    this.queue_size = 32;
    this.queue_address = 0;

    for(var i = 0; i < 128; i++)
    {
        io.register_read(0xA814 + i, this, function(port)
        {
            dbg_log("Read device " + h(port), LOG_VIRTIO);

            if(port < this.device.configspace.length)
            {
                return this.device.configspace[port];
            }
            else
            {
                return 0;
            }
        }.bind(this, i), undefined, undefined);

        io.register_write(0xA814 + i, this, function(port, data)
        {
            dbg_log("Write device " + h(port) + ": " + h(data, 2), LOG_VIRTIO);
        }.bind(this, i), undefined, undefined);
    }

    // should be generalized to support more devices than just the filesystem
    this.device = new Virtio9p(filesystem, bus);
    this.device.SendReply = this.device_reply.bind(this);

    cpu.devices.pci.register_device(this);
}

VirtIO.prototype.get_state = function()
{
    var state = [];

    state[0] = 0; // unused
    state[1] = this.queue_select;
    state[2] = this.device_status;
    state[3] = this.isr;
    state[4] = this.last_idx;
    state[5] = this.queue_size;
    state[6] = this.queue_address;
    state[7] = this.device;

    return state;
};

VirtIO.prototype.set_state = function(state)
{
    this.queue_select = state[1];
    this.device_status = state[2];
    this.isr = state[3];
    this.last_idx = state[4];
    this.queue_size = state[5];
    this.queue_address = state[6];

    this.device = state[7];
    this.device.SendReply = this.device_reply.bind(this);
};

VirtIO.prototype.reset = function()
{
    this.queue_select = 0;
    this.device_status = 0;
    this.isr = 0;

    this.last_idx = 0;
    this.queue_size = 32;
    this.queue_address = 0;
};

VirtIO.prototype.handle_descriptor = function(idx)
{
    var next = idx;
    var desc_start = this.queue_address << 12;

    var buffer_idx = 0;
    var buffers = [];

    do
    {
        var addr = desc_start + next * 16;
        var flags = this.cpu.read16(addr + 12);

        if(flags & VRING_DESC_F_WRITE)
        {
            break;
        }

        if(flags & VRING_DESC_F_INDIRECT) {
            dbg_assert(false, "unsupported");
        }

        var addr_low = this.cpu.read32s(addr);
        var addr_high = this.cpu.read32s(addr + 4);
        var len = this.cpu.read32s(addr + 8) >>> 0;

        buffers.push({
            addr_low: addr_low,
            addr_high: addr_high,
            len: len,
        });

        dbg_log("descriptor: addr=" + h(addr_high, 8) + ":" + h(addr_low, 8) +
                             " len=" + h(len, 8) + " flags=" + h(flags, 4) + " next=" + h(next, 4), LOG_VIRTIO);

        if(flags & VRING_DESC_F_NEXT)
        {
            next = this.cpu.read16(addr + 14);
            dbg_assert(next < this.queue_size);
        }
        else
        {
            next = -1;
            break;
        }
    }
    while(true);

    var buffer_len = -1;
    var pointer = 0;

    var infos = {
        start: idx,
        next: next,
    };

    this.device.ReceiveRequest(infos, function()
    {
        // return one byte

        if(pointer >= buffer_len)
        {
            if(buffer_idx === buffers.length)
            {
                dbg_log("Read more data than descriptor has", LOG_VIRTIO);
                return 0;
            }

            var buf = buffers[buffer_idx++];

            addr_low = buf.addr_low;
            buffer_len = buf.len;
            pointer = 0;
        }

        return this.cpu.read8(addr_low + pointer++);
    }.bind(this));
};

VirtIO.prototype.device_reply = function(queueidx, infos)
{
    if(infos.next === -1)
    {
        dbg_log("Reply to invalid index", LOG_VIRTIO);
        return;
    }

    var mask = this.queue_size - 1;
    var result_length = this.device.replybuffersize;

    var next = infos.next;
    var desc_start = this.queue_address << 12;

    var buffer_idx = 0;
    var buffers = [];

    do
    {
        var addr = desc_start + next * 16;
        var flags = this.cpu.read16(addr + 12);

        if((flags & VRING_DESC_F_WRITE) === 0)
        {
            dbg_log("Bug: Readonly ring after writeonly ring", LOG_VIRTIO);
            break;
        }

        var addr_low = this.cpu.read32s(addr);
        var addr_high = this.cpu.read32s(addr + 4);
        var len = this.cpu.read32s(addr + 8) >>> 0;

        buffers.push({
            addr_low: addr_low,
            addr_high: addr_high,
            len: len,
        });

        dbg_log("descriptor: addr=" + h(addr_high, 8) + ":" + h(addr_low, 8) +
                             " len=" + h(len, 8) + " flags=" + h(flags, 4) + " next=" + h(next, 4), LOG_VIRTIO);

        if(flags & VRING_DESC_F_NEXT)
        {
            next = this.cpu.read16(addr + 14);
            dbg_assert(next < this.queue_size);
        }
        else
        {
            break;
        }
    }
    while(true);

    var buffer_len = -1;
    var pointer = 0;

    for(var i = 0; i < result_length; i++)
    {
        var data = this.device.replybuffer[i];

        if(pointer >= buffer_len)
        {
            if(buffer_idx === buffers.length)
            {
                dbg_log("Write more data than descriptor has", LOG_VIRTIO);
                return 0;
            }

            var buf = buffers[buffer_idx++];

            addr_low = buf.addr_low;
            buffer_len = buf.len;
            pointer = 0;
        }

        this.cpu.write8(addr_low + pointer++, data);
    }

    var used_desc_start = (this.queue_address << 12) + 16 * this.queue_size + 4 + 2 * this.queue_size;
    used_desc_start = used_desc_start + 4095 & ~4095;

    var flags = this.cpu.read16(used_desc_start);
    var used_idx = this.cpu.read16(used_desc_start + 2);
    this.cpu.write16(used_desc_start + 2, used_idx + 1);

    dbg_log("used descriptor: addr=" + h(used_desc_start, 8) + " flags=" + h(flags, 4) + " idx=" + h(used_idx, 4), LOG_VIRTIO);

    used_idx &= mask;
    var used_desc_offset = used_desc_start + 4 + used_idx * 8;
    this.cpu.write32(used_desc_offset, infos.start);
    this.cpu.write32(used_desc_offset + 4, result_length);

    this.isr |= 1;
    this.pci.raise_irq(this.pci_id);
};
