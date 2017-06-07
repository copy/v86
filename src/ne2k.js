"use strict";


/** @const */ var E8390_CMD = 0x00 /* The command register (for all pages) */

/* Page 0 register offsets. */
/** @const */ var EN0_CLDALO = 0x01 /* Low byte of current local dma addr RD */
/** @const */ var EN0_STARTPG = 0x01 /* Starting page of ring bfr WR */
/** @const */ var EN0_CLDAHI = 0x02 /* High byte of current local dma addr RD */
/** @const */ var EN0_STOPPG = 0x02 /* Ending page +1 of ring bfr WR */
/** @const */ var EN0_BOUNDARY = 0x03 /* Boundary page of ring bfr RD WR */
/** @const */ var EN0_TSR = 0x04 /* Transmit status reg RD */
/** @const */ var EN0_TPSR = 0x04 /* Transmit starting page WR */
/** @const */ var EN0_NCR = 0x05 /* Number of collision reg RD */
/** @const */ var EN0_TCNTLO = 0x05 /* Low byte of tx byte count WR */
/** @const */ var EN0_FIFO = 0x06 /* FIFO RD */
/** @const */ var EN0_TCNTHI = 0x06 /* High byte of tx byte count WR */
/** @const */ var EN0_ISR = 0x07 /* Interrupt status reg RD WR */
/** @const */ var EN0_CRDALO = 0x08 /* low byte of current remote dma address RD */
/** @const */ var EN0_RSARLO = 0x08 /* Remote start address reg 0 */
/** @const */ var EN0_CRDAHI = 0x09 /* high byte, current remote dma address RD */
/** @const */ var EN0_RSARHI = 0x09 /* Remote start address reg 1 */
/** @const */ var EN0_RCNTLO = 0x0a /* Remote byte count reg WR */
/** @const */ var EN0_RCNTHI = 0x0b /* Remote byte count reg WR */
/** @const */ var EN0_RSR = 0x0c /* rx status reg RD */
/** @const */ var EN0_RXCR = 0x0c /* RX configuration reg WR */
/** @const */ var EN0_TXCR = 0x0d /* TX configuration reg WR */
/** @const */ var EN0_COUNTER0 = 0x0d /* Rcv alignment error counter RD */
/** @const */ var EN0_DCFG = 0x0e /* Data configuration reg WR */
/** @const */ var EN0_COUNTER1 = 0x0e /* Rcv CRC error counter RD */
/** @const */ var EN0_IMR = 0x0f /* Interrupt mask reg WR */
/** @const */ var EN0_COUNTER2 = 0x0f /* Rcv missed frame error counter RD */

/** @const */ var NE_DATAPORT = 0x10 /* NatSemi-defined port window offset. */
/** @const */ var NE_RESET = 0x1f /* Issue a read to reset, a write to clear. */

/* Bits in EN0_ISR - Interrupt status register */
/** @const */ var ENISR_RX = 0x01 /* Receiver, no error */
/** @const */ var ENISR_TX = 0x02 /* Transmitter, no error */
/** @const */ var ENISR_RX_ERR = 0x04 /* Receiver, with error */
/** @const */ var ENISR_TX_ERR = 0x08 /* Transmitter, with error */
/** @const */ var ENISR_OVER = 0x10 /* Receiver overwrote the ring */
/** @const */ var ENISR_COUNTERS = 0x20 /* Counters need emptying */
/** @const */ var ENISR_RDC = 0x40 /* remote dma complete */
/** @const */ var ENISR_RESET = 0x80 /* Reset completed */
/** @const */ var ENISR_ALL = 0x3f /* Interrupts we will enable */

/** @const */ var ENRSR_RXOK = 0x01 /* Received a good packet */

/** @const */ var START_PAGE = 0x40;
/** @const */ var START_RX_PAGE = 0x40 + 12;
/** @const */ var STOP_PAGE = 0x80;


/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
function Ne2k(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {PCI} */
    this.pci = cpu.devices.pci;

    /** @const @type {BusConnector} */
    this.bus = bus;
    this.bus.register("net0-receive", function(data)
    {
        this.receive(data);
    }, this);

    this.port = 0x300;

    this.name = "ne2k";

    /** @const */
    var use_pci = true;

    if(use_pci)
    {
        this.pci_space = [
            0xec, 0x10, 0x29, 0x80, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
            this.port & 0xFF | 1, this.port >> 8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x1a, 0x00, 0x11,
            0x00, 0x00, 0xb8, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        ];
        this.pci_id = 0x05 << 3;
        this.pci_bars = [
            {
                size: 32,
            },
        ];
    }

    this.isr = 0;
    this.imr = 0; // interrupt mask register

    this.cr = 1;

    this.dcfg = 0;

    this.rcnt = 0;

    this.tcnt = 0;
    this.tpsr = 0;
    this.memory = new Uint8Array(256 * 0x80);

    this.rxcr = 0;
    this.txcr = 0;
    this.tsr = 1;

    // mac address
    var mac = [
        0x00, 0x22, 0x15,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
        Math.random() * 255 | 0,
    ];

    for(var i = 0; i < 6; i++)
    {
        this.memory[i << 1] = this.memory[i << 1 | 1] = mac[i];
    }

    this.memory[14] = this.memory[15] = 0x57;

    dbg_log("Mac: " + h(mac[0], 2) + ":" +
                      h(mac[1], 2) + ":" +
                      h(mac[2], 2) + ":" +
                      h(mac[3], 2) + ":" +
                      h(mac[4], 2) + ":" +
                      h(mac[5], 2), LOG_NET);

    this.rsar = 0;

    this.pstart = START_PAGE;
    this.pstop = STOP_PAGE;

    this.curpg = START_RX_PAGE;
    this.boundary = START_RX_PAGE;

    var io = cpu.io;

    io.register_read(this.port | E8390_CMD, this, function()
    {
        dbg_log("Read cmd", LOG_NET);
        return this.cr;
    });

    io.register_write(this.port | E8390_CMD, this, function(data_byte)
    {
        this.cr = data_byte & ~4;
        dbg_log("Write command: " + h(data_byte, 2) + " newpg=" + (this.cr >> 6) + " txcr=" + h(this.txcr, 2), LOG_NET);

        if(this.cr & 1)
        {
            return;
        }

        if((data_byte | 0x18) && this.rcnt === 0)
        {
            this.do_interrupt(ENISR_RDC);
        }

        if(data_byte & 4)
        {
            var start = this.tpsr << 8;
            var data = this.memory.subarray(start, start + this.tcnt);
            this.bus.send("net0-send", data);
            this.bus.send("eth-transmit-end", [data.length]);
            this.do_interrupt(ENISR_TX);

            dbg_log("Command: Transfer. length=" + h(data.byteLength), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_COUNTER0, this, function()
    {
        dbg_log("Read counter0", LOG_NET);
        return 0;
    });

    io.register_read(this.port | EN0_COUNTER1, this, function()
    {
        dbg_log("Read counter1", LOG_NET);
        return 0;
    });

    io.register_read(this.port | EN0_COUNTER2, this, function()
    {
        dbg_log("Read counter2", LOG_NET);
        return 0;
    });

    io.register_read(this.port | NE_RESET, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read reset", LOG_NET);
            this.do_interrupt(ENISR_RESET);
        }
        else
        {
            dbg_log("Read pg1/1f", LOG_NET);
        }
        return 0;
    });

    io.register_write(this.port | NE_RESET, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write reset: " + h(data_byte, 2), LOG_NET);
            //this.isr &= ~ENISR_RESET;
        }
        else
        {
            dbg_log("Write pg1/1f: " + h(data_byte), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_STARTPG, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("start page: " + h(data_byte, 2), LOG_NET);
            this.pstart = data_byte;
        }
        else
        {
            dbg_log("pg1/1: " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_STOPPG, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("stop page: " + h(data_byte, 2), LOG_NET);
            this.pstop = data_byte;
        }
        else
        {
            dbg_log("pg1/2: " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_ISR, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read isr: " + h(this.isr, 2), LOG_NET);
            return this.isr;
        }
        else
        {
            dbg_log("Read curpg: " + h(this.curpg, 2), LOG_NET);
            return this.curpg;
        }
    });

    io.register_write(this.port | EN0_ISR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            // acknoledge interrupts where bit is set
            dbg_log("Write isr: " + h(data_byte, 2), LOG_NET);
            this.isr &= ~data_byte
            this.update_irq();
        }
        else
        {
            dbg_log("Write curpg: " + h(data_byte, 2), LOG_NET);
            this.curpg = data_byte
        }
    });

    io.register_write(this.port | EN0_TXCR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            this.txcr = data_byte;
            dbg_log("Write tx config: " + h(data_byte, 2), LOG_NET);
        }
        else
        {
            dbg_log("Write pg1/0x0d " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_DCFG, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write data configuration: " + h(data_byte, 2), LOG_NET);
            this.dcfg = data_byte;
        }
        else
        {
            dbg_log("Write pg1/0x0e " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_RCNTLO, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote byte count low: " + h(data_byte, 2), LOG_NET);
            this.rcnt = this.rcnt & 0xFF00 | data_byte & 0xFF;
        }
        else
        {
            dbg_log("Write pg1/0x0a " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_RCNTHI, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote byte count high: " + h(data_byte, 2), LOG_NET);
            this.rcnt = this.rcnt & 0xFF | data_byte << 8 & 0xFF00;
        }
        else
        {
            dbg_log("Write pg1/0x0b " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_RSARLO, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write remote start address low: " + h(data_byte, 2), LOG_NET);
            this.rsar = this.rsar & 0xFF00 | data_byte & 0xFF;
        }
        else
        {
            dbg_log("Write pg1/0x08 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_RSARHI, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write start addresse count high: " + h(data_byte, 2), LOG_NET);
            this.rsar = this.rsar & 0xFF | data_byte << 8 & 0xFF00;
        }
        else
        {
            dbg_log("Write pg1/0x09 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_IMR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write interrupt mask register: " + h(data_byte, 2) + " isr=" + h(this.isr, 2), LOG_NET);
            this.imr = data_byte;
            this.update_irq();
        }
        else
        {
            dbg_log("Write pg1/0x0f " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_BOUNDARY, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Read boundary: " + h(this.boundary, 2), LOG_NET);
            return this.boundary;
        }
        else
        {
            dbg_log("Read pg1/0x03", LOG_NET);
            return 0;
        }
    });

    io.register_write(this.port | EN0_BOUNDARY, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write boundary: " + h(data_byte, 2), LOG_NET);
            this.boundary = data_byte;
        }
        else
        {
            dbg_log("Write pg1/0x03 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_TSR, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            return this.tsr;
        }
        else
        {
            dbg_log("Read pg1/0x04", LOG_NET);
            return 0;
        }
    });

    io.register_write(this.port | EN0_TPSR, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write tpsr: " + h(data_byte, 2), LOG_NET);
            this.tpsr = data_byte;
        }
        else
        {
            dbg_log("Write pg1/0x04 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_TCNTLO, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write tcnt low: " + h(data_byte, 2), LOG_NET);
            this.tcnt = this.tcnt & ~0xFF | data_byte;
        }
        else
        {
            dbg_log("Write pg1/0x05 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_write(this.port | EN0_TCNTHI, this, function(data_byte)
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            dbg_log("Write tcnt high: " + h(data_byte, 2), LOG_NET);
            this.tcnt = this.tcnt & 0xFF | data_byte << 8;
        }
        else
        {
            dbg_log("Write pg1/0x06 " + h(data_byte, 2), LOG_NET);
        }
    });

    io.register_read(this.port | EN0_RSR, this, function()
    {
        var pg = this.get_page();
        if(pg === 0)
        {
            return 1 | 1 << 3; // receive status ok
        }
        else
        {
            dbg_log("Read pg1/0x0c", LOG_NET);
            return 0;
        }
    });

    io.register_write(this.port | EN0_RXCR, this, function(data_byte)
    {
        dbg_log("RX configuration reg write: " + h(data_byte, 2), LOG_NET);
        this.rxcr = data_byte;
    });

    io.register_read(this.port | NE_DATAPORT | 0, this,
            this.data_port_read8,
            this.data_port_read16,
            this.data_port_read32);
    io.register_write(this.port | NE_DATAPORT | 0, this,
            this.data_port_write16,
            this.data_port_write16,
            this.data_port_write32);

    if(use_pci)
    {
        cpu.devices.pci.register_device(this);
    }
}

Ne2k.prototype.get_state = function()
{
    var state = [];

    state[0] = this.isr;
    state[1] = this.imr;
    state[2] = this.cr;
    state[3] = this.dcfg;
    state[4] = this.rcnt;
    state[5] = this.tcnt;
    state[6] = this.tpsr;
    state[7] = this.rsar;
    state[8] = this.pstart;
    state[9] = this.curpg;
    state[10] = this.boundary;

    return state;
};

Ne2k.prototype.set_state = function(state)
{
    this.isr = state[0];
    this.imr = state[1];
    this.cr = state[2];
    this.dcfg = state[3];
    this.rcnt = state[4];
    this.tcnt = state[5];
    this.tpsr = state[6];
    this.rsar = state[7];
    this.pstart = state[8];
    this.curpg = state[9];
    this.boundary = state[10];
};

Ne2k.prototype.do_interrupt = function(ir_mask)
{
    dbg_log("Do interrupt " + h(ir_mask, 2), LOG_NET);
    this.isr |= ir_mask;
    this.update_irq();
};

Ne2k.prototype.update_irq = function()
{
    if(this.imr & this.isr)
    {
        this.pci.raise_irq(this.pci_id);
    }
    else
    {
        this.pci.lower_irq(this.pci_id);
    }
};

Ne2k.prototype.data_port_write = function(data_byte)
{
    dbg_log("Write data port: data=" + h(data_byte & 0xFF, 2) +
                            " rsar=" + h(this.rsar, 4) +
                            " rcnt=" + h(this.rcnt, 4), LOG_NET);

    if(this.rsar > 0x10 && this.rsar < (START_PAGE << 8))
    {
        // unmapped
        return;
    }

    this.rcnt--;
    this.memory[this.rsar++] = data_byte;

    if(this.rsar >= (this.pstop << 8))
    {
        this.rsar += (this.pstart - this.pstop) << 8;
    }

    if(this.rcnt === 0)
    {
        this.do_interrupt(ENISR_RDC);
    }
};

Ne2k.prototype.data_port_write16 = function(data)
{
    this.data_port_write(data);

    if(this.dcfg & 1)
    {
        this.data_port_write(data >> 8);
    }
};

Ne2k.prototype.data_port_write32 = function(data)
{
    this.data_port_write(data);
    this.data_port_write(data >> 8);
    this.data_port_write(data >> 16);
    this.data_port_write(data >> 24);
};

Ne2k.prototype.data_port_read = function()
{
    var data = this.memory[this.rsar++];

    dbg_log("Read data port: data=" + h(data, 2) +
                           " rsar=" + h(this.rsar - 1, 4) +
                           " rcnt=" + h(this.rcnt, 4), LOG_NET);
    this.rcnt--;

    if(this.rsar >= (this.pstop << 8))
    {
        this.rsar += (this.pstart - this.pstop) << 8;
    }

    if(this.rcnt === 0)
    {
        this.do_interrupt(ENISR_RDC);
    }

    return data;
};

Ne2k.prototype.data_port_read8 = function()
{
    return this.data_port_read16() & 0xFF;
};

Ne2k.prototype.data_port_read16 = function()
{
    if(this.dcfg & 1)
    {
        return this.data_port_read() | this.data_port_read() << 8;
    }
    else
    {
        return this.data_port_read();
    }
};

Ne2k.prototype.data_port_read32 = function()
{
    return this.data_port_read() | this.data_port_read() << 8 |
            this.data_port_read() << 16 | this.data_port_read() << 24;
};

Ne2k.prototype.receive = function(data)
{
    // called from the adapter when data is received over the network

    if(this.cr & 1)
    {
        // stop bit set
        return;
    }

    this.bus.send("eth-receive-end", [data.length]);

    if(this.rxcr & 0x10)
    {
        // promiscuous
    }
    else if((this.rxcr & 4) &&
            data[0] === 0xFF && data[1] === 0xFF && data[2] === 0xFF &&
            data[3] === 0xFF && data[4] === 0xFF && data[5] === 0xFF)
    {
        // broadcast
    }
    else if((this.rxcr & 8) && (data[0] & 1) === 1)
    {
        // multicast
        // XXX
        return;
    }
    else if(data[0] === this.memory[0] && data[1] === this.memory[2] &&
            data[2] === this.memory[4] && data[3] === this.memory[6] &&
            data[4] === this.memory[8] && data[5] === this.memory[10])
    {
    }
    else
    {
        return;
    }

    var packet_length = Math.max(60, data.length);

    var offset = this.curpg << 8;
    var total_length = packet_length + 4;
    var data_start = offset + 4;
    var next = this.curpg + 1 + (total_length >> 8);

    var end = offset + total_length;

    if(end > this.memory.length)
    {
        // shouldn't happen because at this size it can't cross a page
        dbg_assert(data.length >= 60);

        var cut = this.memory.length - data_start;
        this.memory.set(data.subarray(0, cut), data_start);
        this.memory.set(data.subarray(cut), START_RX_PAGE);
        dbg_log("rcv cut=" + h(cut), LOG_NET);
    }
    else
    {
        this.memory.set(data, data_start);

        if(data.length < 60)
        {
            for(var i = data.length; i < 60; i++)
            {
                this.memory[data_start + i] = 0;
            }
        }
    }

    if(next >= this.pstop)
    {
        next += this.pstart - this.pstop;
    }

    // write packet header
    this.memory[offset] = ENRSR_RXOK; // status
    this.memory[offset + 1] = next;
    this.memory[offset + 2] = total_length;
    this.memory[offset + 3] = total_length >> 8;

    this.curpg = next;

    dbg_log("rcv offset=" + h(offset) + " len=" + h(total_length) + " next=" + h(next), LOG_NET);

    this.do_interrupt(ENISR_RX);
};

Ne2k.prototype.get_page = function()
{
    return this.cr & 0xC0;
};
