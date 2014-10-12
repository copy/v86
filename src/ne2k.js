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


/** @constructor */
function Ne2k(cpu, adapter)
{
    this.pic = cpu.devices.pic;

    this.adapter = adapter;
    adapter.init(this.receive.bind(this));


    this.pci_space = [
        0xec, 0x10, 0x29, 0x80, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
        0x01, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x1a, 0x00, 0x11,
        0x00, 0x00, 0xb8, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0x01, 0x00, 0x00,
    ];
    this.pci_id = 0x05 << 3;
    this.pci_bars = [
        {
            size: 128 * 1024,
        },
    ];

    cpu.devices.pci.register_device(this);

    this.isr = 0;
    this.imr = 0; // interrupt mask register

    this.cr = 1;

    this.port = 0xB800;
    this.irq = 0x0B;

    this.rcnt = 0;
    this.remote_buffer = new Uint8Array(0);
    this.remote_pointer = 0;

    this.receive_buffer = new Uint8Array(256 * 0x80);
    this.receiving_pointer = 0;

    // mac address
    this.receive_buffer[0] = 0x00
    this.receive_buffer[1] = 0x22;
    this.receive_buffer[2] = 0x15;
    this.receive_buffer[3] = Math.random() * 255 | 0;
    this.receive_buffer[4] = Math.random() * 255 | 0;
    this.receive_buffer[5] = Math.random() * 255 | 0;

    this.rsar = 0;

    this.curpg = START_RX_PAGE;
    this.boundary = START_RX_PAGE;

    var io = cpu.io;

    io.register_read(this.port | E8390_CMD, function()
    {
        dbg_log("Read cmd", LOG_NET);
        return this.cr;
    }, this);

    io.register_write(this.port | E8390_CMD, function(data_byte)
    {
        this.cr = data_byte | (this.cr & 4);
        dbg_log("Write command: " + h(data_byte, 2), LOG_NET);

        this.remote_pointer = 0;

        if(this.rcnt > this.remote_buffer.length)
        {
            this.remote_buffer = new Uint8Array(this.rcnt);
        }
    }, this);

    io.register_read(this.port | EN0_COUNTER0, function()
    {
        dbg_log("Read counter0", LOG_NET);
        return 0;
    }, this);

    io.register_read(this.port | EN0_COUNTER1, function()
    {
        dbg_log("Read counter1", LOG_NET);
        return 0;
    }, this);

    io.register_read(this.port | EN0_COUNTER2, function()
    {
        dbg_log("Read counter2", LOG_NET);
        return 0;
    }, this);

    io.register_read(this.port | NE_RESET, function()
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Read reset", LOG_NET);
            this.do_interrupt(ENISR_RESET);
            return 0;
        }
        else
        {
            dbg_log("Read pg1/1f", LOG_NET);
        }
    }, this);

    io.register_write(this.port | NE_RESET, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write reset: " + h(data_byte, 2), LOG_NET);
            //this.isr &= ~ENISR_RESET;
        }
        else
        {
            dbg_log("Write pg1/1f: " + h(data_byte), LOG_NET);
        }
    }, this);

    io.register_read(this.port | EN0_ISR, function()
    {
        var pg = this.cr & 0xC0;
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
    }, this);

    io.register_write(this.port | EN0_ISR, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            // acknoledge interrupts where bit is set
            dbg_log("Write isr: " + h(data_byte, 2), LOG_NET);
            this.isr &= ~data_byte
        }
        else
        {
            dbg_log("Write curpg: " + h(data_byte, 2), LOG_NET);
            this.curpg = data_byte
        }
    }, this);

    io.register_write(this.port | EN0_TXCR, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write tx config: " + h(data_byte, 2), LOG_NET);
        }
        else
        {
            dbg_log("Write pg1/0x0d " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_write(this.port | EN0_DCFG, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write data configuration: " + h(data_byte, 2), LOG_NET);
        }
        else
        {
            dbg_log("Write pg1/0x0e " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_write(this.port | EN0_RCNTLO, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write remote byte count low: " + h(data_byte, 2), LOG_NET);
            this.rcnt = this.rcnt & 0xFF00 | data_byte & 0xFF;
        }
        else
        {
            dbg_log("Write pg1/0x0a " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_write(this.port | EN0_RCNTHI, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write remote byte count high: " + h(data_byte, 2), LOG_NET);
            this.rcnt = this.rcnt & 0xFF | data_byte << 8 & 0xFF00;
        }
        else
        {
            dbg_log("Write pg1/0x0b " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_write(this.port | EN0_RSARLO, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write remote start address low: " + h(data_byte, 2), LOG_NET);
            this.rsar = this.rsar & 0xFF00 | data_byte & 0xFF;
        }
        else
        {
            dbg_log("Write pg1/0x08 " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_write(this.port | EN0_RSARHI, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write start addresse count high: " + h(data_byte, 2), LOG_NET);
            this.rsar = this.rsar & 0xFF | data_byte << 8 & 0xFF00;
        }
        else
        {
            dbg_log("Write pg1/0x09 " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_write(this.port | EN0_IMR, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            this.imr = data_byte;
            dbg_log("Write interrupt mask register: " + h(data_byte, 2), LOG_NET);
        }
        else
        {
            dbg_log("Write pg1/0x0f " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_read(this.port | EN0_BOUNDARY, function()
    {
        var pg = this.cr & 0xC0;
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
    }, this);

    io.register_write(this.port | EN0_BOUNDARY, function(data_byte)
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            dbg_log("Write boundary: " + h(data_byte, 2), LOG_NET);
            this.boundary = data_byte;
        }
        else
        {
            dbg_log("Write pg1/0x03 " + h(data_byte, 2), LOG_NET);
        }
    }, this);

    io.register_read(this.port | EN0_TSR, function()
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            return 1 | 2 | 1 << 5; // transmit status ok
        }
        else
        {
            dbg_log("Read pg1/0x04", LOG_NET);
            return 0;
        }
    }, this);

    io.register_read(this.port | EN0_RSR, function()
    {
        var pg = this.cr & 0xC0;
        if(pg === 0)
        {
            return 1 | 1 << 3; // receive status ok
        }
        else
        {
            dbg_log("Read pg1/0x0c", LOG_NET);
            return 0;
        }
    }, this);

    io.register_read(this.port | NE_DATAPORT | 0, this.data_port_read, this);
    io.register_read(this.port | NE_DATAPORT | 1, this.data_port_read, this);
    io.register_read(this.port | NE_DATAPORT | 2, this.data_port_read, this);
    io.register_read(this.port | NE_DATAPORT | 3, this.data_port_read, this);

    io.register_write(this.port | NE_DATAPORT | 0, this.data_port_write, this);
    io.register_write(this.port | NE_DATAPORT | 1, this.data_port_write, this);
    io.register_write(this.port | NE_DATAPORT | 2, this.data_port_write, this);
    io.register_write(this.port | NE_DATAPORT | 3, this.data_port_write, this);

    this._state_skip = [
        "adapter",
        "pic",
    ];
}

Ne2k.prototype.do_interrupt = function(ir_mask)
{
    dbg_log("Do interrupt " + h(ir_mask, 2), LOG_NET);
    this.isr |= ir_mask;

    if(this.imr & ir_mask)
    {
        this.pic.push_irq(this.irq);
    }
};

Ne2k.prototype.data_port_write = function(data_byte)
{
    dbg_log("Write data port: ptr=" + h(this.remote_pointer) + " rcnt=" + h(this.rcnt), LOG_NET);
    this.remote_buffer[this.remote_pointer++] = data_byte;

    if(this.remote_pointer === this.rcnt)
    {
        var data = this.remote_buffer.subarray(0, this.rcnt);
        dbg_log("Send buffer: " + [].slice.call(data), LOG_NET);

        this.do_interrupt(ENISR_RDC);
        this.cr &= ~4;

        // Not technically correct but works (TM): 
        // Send is done in another operation
        this.adapter.send(data);
        this.do_interrupt(ENISR_TX);
    }
};

Ne2k.prototype.data_port_read = function()
{
    var data = this.receive_buffer[this.rsar++];

    dbg_log("Read data port: data=" + h(data, 2) + " rsar=" + h(this.rsar - 1, 2), LOG_NET);

    return data;
};

Ne2k.prototype.receive = function(data)
{
    // called from the adapter when data is received over the network
    
    if(this.cr & 1)
    {
        // stop bit set
        return;
    }

    if(data.length < 60)
    {
        var old = data;
        data = new Uint8Array(60);
        data.set(old)
    }

    var offset = this.curpg << 8;
    var total_length = data.length + 4;
    var data_start = offset + 4;
    var next = this.curpg + 1 + (total_length >> 8);

    var end = offset + total_length;

    if(end > this.receive_buffer.length)
    {
        var cut = this.receive_buffer.length - data_start;
        this.receive_buffer.set(data.subarray(0, cut), data_start);
        this.receive_buffer.set(data.subarray(cut), START_RX_PAGE);
        dbg_log("rcv cut=" + h(cut), LOG_NET);
    }
    else
    {
        this.receive_buffer.set(data, data_start);
    }

    if(next >= STOP_PAGE)
    {
        next += START_RX_PAGE - STOP_PAGE;
    }

    // write packet header
    this.receive_buffer[offset] = ENRSR_RXOK; // status
    this.receive_buffer[offset + 1] = next;
    this.receive_buffer[offset + 2] = total_length;
    this.receive_buffer[offset + 3] = total_length >> 8;

    this.curpg = next;

    dbg_log("rcv offset=" + h(offset) + " len=" + h(total_length) + " next=" + h(next), LOG_NET);

    this.do_interrupt(ENISR_RX);
};

