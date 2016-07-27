"use strict";

var 
    /** @const */
    CDROM_SECTOR_SIZE = 2048,
    /** @const */
    HD_SECTOR_SIZE = 512;

var /** @const */
    IDE_CALLBACK_NONE = 0,

    /** @const */
    IDE_CALLBACK_WRITE = 1,

    /** @const */
    IDE_CALLBACK_ATAPI = 2;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {boolean} is_cd
 * @param {number} nr
 * @param {BusConnector} bus
 * */
function IDEDevice(cpu, buffer, is_cd, nr, bus)
{
    this.master = new IDEInterface(this, cpu, buffer, is_cd, nr, 0, bus);
    this.slave = new IDEInterface(this, cpu, undefined, false, nr, 1, bus);

    this.current_interface = this.master;

    this.cpu = cpu;

    // gets set via PCI in seabios, likely doesn't matter
    if(nr === 0)
    {
        this.ata_port = 0x1F0;
        this.irq = 14;

        this.pci_id = 0x1E << 3;
    }
    else if(nr === 1)
    {
        this.ata_port = 0x170;
        this.irq = 15;

        this.pci_id = 0x1F << 3;
    }
    else
    {
        dbg_assert(false, "IDE device with nr " + nr + " ignored", LOG_DISK);
    }

    // alternate status, starting at 3f4/374
    /** @type {number} */
    this.ata_port_high = this.ata_port | 0x204;

    /** @type {number} */
    this.master_port = 0xB400;

    this.pci_space = [
        0x86, 0x80, 0x20, 0x3a, 0x05, 0x00, 0xa0, 0x02, 0x00, 0x8f, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        this.ata_port & 0xFF | 1,      this.ata_port >> 8, 0x00, 0x00,
        this.ata_port_high & 0xFF | 1, this.ata_port_high >> 8, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, // second device
        0x00, 0x00, 0x00, 0x00, // second device
        this.master_port & 0xFF | 1,   this.master_port >> 8, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x43, 0x10, 0xd4, 0x82,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, this.irq, 0x01, 0x00, 0x00,

        // 0x40
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // 0x80
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    this.pci_bars = [
        {
            size: 8,
        },
        {
            size: 4,
        },
        false,
        false,
        {
            size: 0x10,
        },
    ];
    this.name = "ide" + nr;

    cpu.devices.pci.register_device(this);

    /** @type {number} */
    this.device_control = 2;

    // status
    cpu.io.register_read(this.ata_port | 7, this, function() {
        dbg_log("lower irq", LOG_DISK);
        this.cpu.device_lower_irq(this.irq);
        return this.read_status();
    });
    cpu.io.register_read(this.ata_port_high | 2, this, this.read_status);

    cpu.io.register_write(this.ata_port_high | 2, this, this.write_control);
    cpu.io.register_read(this.ata_port | 0, this, function()
    {
        return this.current_interface.read_data();
    }, function()
    {
        return this.current_interface.read_data() |
               this.current_interface.read_data() << 8;
    }, function()
    {
        return this.current_interface.read_data() |
               this.current_interface.read_data() << 8 |
               this.current_interface.read_data() << 16 |
               this.current_interface.read_data() << 24;
    });

    cpu.io.register_read(this.ata_port | 1, this, function()
    {
        dbg_log("Read error: " + h(this.error & 0xFF), LOG_DISK);
        return this.current_interface.error;
    });
    cpu.io.register_read(this.ata_port | 2, this, function()
    {
        dbg_log("Read bytecount: " + h(this.current_interface.bytecount & 0xFF), LOG_DISK);
        return this.current_interface.bytecount & 0xFF;
    });
    cpu.io.register_read(this.ata_port | 3, this, function()
    {
        dbg_log("Read sector: " + h(this.current_interface.sector & 0xFF), LOG_DISK);
        return this.current_interface.sector & 0xFF;
    });

    cpu.io.register_read(this.ata_port | 4, this, function()
    {
        dbg_log("Read 1F4: " + h(this.current_interface.cylinder_low & 0xFF), LOG_DISK);
        return this.current_interface.cylinder_low & 0xFF;
    });
    cpu.io.register_read(this.ata_port | 5, this, function()
    {
        dbg_log("Read 1F5: " + h(this.current_interface.cylinder_high & 0xFF), LOG_DISK);
        return this.current_interface.cylinder_high & 0xFF;
    });
    cpu.io.register_read(this.ata_port | 6, this, function()
    {
        dbg_log("Read 1F6", LOG_DISK);
        return this.current_interface.drive_head;
    });

    cpu.io.register_write(this.ata_port | 0, this, function(data)
    {
        this.current_interface.write_data_port8(data);
    }, function(data)
    {
        this.current_interface.write_data_port16(data);
    }, function(data)
    {
        this.current_interface.write_data_port32(data);
    });

    cpu.io.register_write(this.ata_port | 1, this, function(data)
    {
        dbg_log("1F1/lba_count: " + h(data), LOG_DISK);
        this.master.lba_count = (this.master.lba_count << 8 | data) & 0xFFFF;
        this.slave.lba_count = (this.slave.lba_count << 8 | data) & 0xFFFF;
    });
    cpu.io.register_write(this.ata_port | 2, this, function(data)
    {
        dbg_log("1F2/bytecount: " + h(data), LOG_DISK);
        this.master.bytecount = (this.master.bytecount << 8 | data) & 0xFFFF;
        this.slave.bytecount = (this.slave.bytecount << 8 | data) & 0xFFFF;
    });
    cpu.io.register_write(this.ata_port | 3, this, function(data)
    {
        dbg_log("1F3/sector: " + h(data), LOG_DISK);
        this.master.sector = (this.master.sector << 8 | data) & 0xFFFF;
        this.slave.sector = (this.slave.sector << 8 | data) & 0xFFFF;
    });

    cpu.io.register_write(this.ata_port | 4, this, function(data)
    {
        dbg_log("1F4/sector low: " + h(data), LOG_DISK);
        this.master.cylinder_low = (this.master.cylinder_low << 8 | data) & 0xFFFF;
        this.slave.cylinder_low = (this.slave.cylinder_low << 8 | data) & 0xFFFF;
    });
    cpu.io.register_write(this.ata_port | 5, this, function(data)
    {
        dbg_log("1F5/sector high: " + h(data), LOG_DISK);
        this.master.cylinder_high = (this.master.cylinder_high << 8 | data) & 0xFFFF;
        this.slave.cylinder_high = (this.slave.cylinder_high << 8 | data) & 0xFFFF;
    });
    cpu.io.register_write(this.ata_port | 6, this, function(data)
    {
        var slave = data & 0x10;
        var mode = data & 0xE0;

        dbg_log("1F6/drive: " + h(data, 2), LOG_DISK);

        if(slave)
        {
            dbg_log("Slave", LOG_DISK);
            this.current_interface = this.slave;
        }
        else
        {
            this.current_interface = this.master;
        }

        this.master.drive_head = data;
        this.slave.drive_head = data;
        this.master.is_lba = this.slave.is_lba = data >> 6 & 1;
        this.master.head = this.slave.head = data & 0xF;
    });

    /** @type {number} */
    this.prdt_addr = 0;

    /** @type {number} */
    this.dma_status = 0;

    cpu.io.register_write(this.ata_port | 7, this, function(data)
    {
        this.current_interface.ata_command(data);
    });

    cpu.io.register_read(this.master_port | 4, this, undefined, undefined, this.dma_read_addr);
    cpu.io.register_write(this.master_port | 4, this, undefined, undefined, this.dma_set_addr);

    cpu.io.register_read(this.master_port, this, this.dma_read_command8, undefined, this.dma_read_command);
    cpu.io.register_write(this.master_port, this, this.dma_write_command8, undefined, this.dma_write_command);

    cpu.io.register_read(this.master_port | 2, this, this.dma_read_status);
    cpu.io.register_write(this.master_port | 2, this, this.dma_write_status);

    cpu.io.register_read(this.master_port | 0x8, this, function() {
        dbg_log("DMA read 0x8", LOG_DISK); return 0;
    });
    cpu.io.register_read(this.master_port | 0xA, this, function() {
        dbg_log("DMA read 0xA", LOG_DISK); return 0;
    });
}

IDEDevice.prototype.read_status = function()
{
    if(this.current_interface.buffer)
    {
        var ret = this.current_interface.status;
        dbg_log("ATA read status: " + h(ret, 2), LOG_DISK);
        return ret;
    }
    else
    {
        return 0;
    }
};

IDEDevice.prototype.write_control = function(data)
{
    dbg_log("set device control: " + h(data, 2) + " interrupts " +
            ((data & 2) ? "disabled" : "enabled"), LOG_DISK)

    this.device_control = data;

    if(data & 4)
    {
        dbg_log("Reset via control port", LOG_DISK);

        this.master.device_reset();
        this.slave.device_reset();
    }
};

IDEDevice.prototype.dma_read_addr = function()
{
    dbg_log("dma get address: " + h(this.prdt_addr, 8), LOG_DISK);
    return this.prdt_addr;
};

IDEDevice.prototype.dma_set_addr = function(data)
{
    dbg_log("dma set address: " + h(data, 8), LOG_DISK);
    this.prdt_addr = data;
};

IDEDevice.prototype.dma_read_status = function()
{
    dbg_log("DMA read status: " + h(this.dma_status), LOG_DISK);
    return this.dma_status;
};

IDEDevice.prototype.dma_write_status = function(value)
{
    dbg_log("DMA set status: " + h(value), LOG_DISK);
    this.dma_status &= ~value;
};

IDEDevice.prototype.dma_read_command = function()
{
    dbg_log("DMA read command", LOG_DISK);
    return 1 | this.dma_read_status() << 16;
};

IDEDevice.prototype.dma_read_command8 = function()
{
    dbg_log("DMA read command8", LOG_DISK);
    return 1;
};

IDEDevice.prototype.dma_write_command = function(value)
{
    dbg_log("DMA write command: " + h(value), LOG_DISK);

    if(value & 1)
    {
        this.push_irq();
    }

    this.dma_write_status(value >> 16 & 0xFF);
};

IDEDevice.prototype.dma_write_command8 = function(value)
{
    dbg_log("DMA write command8: " + h(value), LOG_DISK);

    if(value & 1)
    {
        this.push_irq();
    }
};

IDEDevice.prototype.push_irq = function()
{
    if((this.device_control & 2) === 0)
    {
        dbg_log("push irq", LOG_DISK);
        this.cpu.device_raise_irq(this.irq);
    }
};

IDEDevice.prototype.get_state = function()
{
    var state = [];
    state[0] = this.master;
    state[1] = this.slave;
    state[2] = this.ata_port;
    state[3] = this.irq;
    state[4] = this.pci_id;
    state[5] = this.ata_port_high;
    state[6] = this.master_port;
    state[7] = this.name;
    state[8] = this.device_control;
    state[9] = this.prdt_addr;
    state[10] = this.dma_status;
    state[11] = this.current_interface === this.master;
    return state;
};

IDEDevice.prototype.set_state = function(state)
{
    this.master = state[0];
    this.slave = state[1];
    this.ata_port = state[2];
    this.irq = state[3];
    this.pci_id = state[4];
    this.ata_port_high = state[5];
    this.master_port = state[6];
    this.name = state[7];
    this.device_control = state[8];
    this.prdt_addr = state[9];
    this.dma_status = state[10];
    this.current_interface = state[11] ? this.master : this.slave;
};


/**
 * @constructor
 */
function IDEInterface(device, cpu, buffer, is_cd, device_nr, interface_nr, bus)
{
    this.device = device;

    /** @const @type {BusConnector} */
    this.bus = bus;

    /**
     * @const
     * @type {number}
     */
    this.nr = device_nr;

    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {Memory} */
    this.memory = cpu.memory;

    this.buffer = buffer;

    /** @type {number} */
    this.sector_size = is_cd ? CDROM_SECTOR_SIZE : HD_SECTOR_SIZE;

    /** @type {boolean} */
    this.is_atapi = is_cd;

    /** @type {number} */
    this.sector_count = 0;

    /** @type {number} */
    this.head_count = 0;

    /** @type {number} */
    this.sectors_per_track = 0;

    /** @type {number} */
    this.cylinder_count = 0;

    if(this.buffer)
    {
        this.sector_count = this.buffer.byteLength / this.sector_size;

        if(this.sector_count !== (this.sector_count | 0))
        {
            dbg_log("Warning: Disk size not aligned with sector size", LOG_DISK);
            this.sector_count = Math.ceil(this.sector_count);
        }

        if(is_cd)
        {
            this.head_count = 1;
            this.sectors_per_track = 0;
        }
        else
        {
            // "default" values: 16/63
            // common: 255, 63
            this.head_count = 16;
            this.sectors_per_track = 63;
        }


        this.cylinder_count = this.sector_count / this.head_count / this.sectors_per_track;

        if(this.cylinder_count !== (this.cylinder_count | 0))
        {
            dbg_log("Warning: Rounding up cylinder count. Choose different head number", LOG_DISK);
            this.cylinder_count = Math.floor(this.cylinder_count);
            //this.sector_count = this.cylinder_count * this.head_count *
            //                        this.sectors_per_track * this.sector_size;
        }

        //if(this.cylinder_count > 16383)
        //{
        //    this.cylinder_count = 16383;
        //}


        // disk translation translation: lba
        var rtc = cpu.devices.rtc;

        // master
        rtc.cmos_write(CMOS_BIOS_DISKTRANSFLAG, rtc.cmos_read(CMOS_BIOS_DISKTRANSFLAG) | 1 << this.nr * 4);
        rtc.cmos_write(CMOS_DISK_DATA, rtc.cmos_read(CMOS_DISK_DATA) & 0x0F | 0xF0);

        var reg = CMOS_DISK_DRIVE1_CYL;
        rtc.cmos_write(reg + 0, this.cylinder_count & 0xFF);
        rtc.cmos_write(reg + 1, this.cylinder_count >> 8 & 0xFF);
        rtc.cmos_write(reg + 2, this.head_count & 0xFF);
        rtc.cmos_write(reg + 3, 0xFF);
        rtc.cmos_write(reg + 4, 0xFF);
        rtc.cmos_write(reg + 5, 0xC8);
        rtc.cmos_write(reg + 6, this.cylinder_count & 0xFF);
        rtc.cmos_write(reg + 7, this.cylinder_count >> 8 & 0xFF);
        rtc.cmos_write(reg + 8, this.sectors_per_track & 0xFF);

        //rtc.cmos_write(CMOS_BIOS_DISKTRANSFLAG, rtc.cmos_read(CMOS_BIOS_DISKTRANSFLAG) | 1 << (nr * 4 + 2)); // slave
    }

    /** @const */
    this.stats = {
        sectors_read: 0,
        sectors_written: 0,
        bytes_read: 0,
        bytes_written: 0,
        loading: false,
    };


    this.buffer = buffer;

    /** @type {number} */
    this.is_lba = 0;

    /** @type {number} */
    this.bytecount = 0;

    /** @type {number} */
    this.sector = 0;

    /** @type {number} */
    this.lba_count = 0;

    /** @type {number} */
    this.cylinder_low = 0;

    /** @type {number} */
    this.cylinder_high = 0;

    /** @type {number} */
    this.head = 0;

    /** @type {number} */
    this.drive_head = 0;

    /** @type {number} */
    this.status = 0x50;

    /** @type {number} */
    this.sectors_per_drq = 1;

    /** @type {number} */
    this.error = 0;

    /** @type {number} */
    this.data_pointer = 0;

    this.pio_data = new Uint8Array(64 * 1024);

    /** @type {number} */
    this.write_dest = 0;

    /** @type {number} */
    this.data_port_count = 0;

    /** @type {number} */
    this.data_port_current = 0;

    this.data_port_buffer = new Uint8Array(4096);

    this.data_port_callback = IDE_CALLBACK_NONE;
}

IDEInterface.prototype.device_reset = function()
{
    if(this.is_atapi)
    {
        this.status = 0;
        this.bytecount = 1;
        this.error = 1;
        this.sector = 1; // lba_low
        this.cylinder_low = 0x14; // lba_mid
        this.cylinder_high = 0xeb; // lba_high
    }
    else
    {
        this.status = 0x50 | 1;
        this.bytecount = 1;
        this.error = 1;
        this.sector = 1; // lba_low

        // 0, 0 needed by bochs bios
        this.cylinder_low = 0; // lba_mid
        this.cylinder_high = 0; // lba_high
    }
};

IDEInterface.prototype.do_callback = function()
{
    switch(this.data_port_callback)
    {
        case IDE_CALLBACK_NONE:
            break;

        case IDE_CALLBACK_WRITE:
            this.do_write();
            break;

        case IDE_CALLBACK_ATAPI:
            this.atapi_handle();
            break;

        default:
            dbg_assert(false, "Invalid IDE callback: " + this.data_port_callback);
    }
};

IDEInterface.prototype.push_irq = function()
{
    this.device.push_irq();
};

IDEInterface.prototype.ata_command = function(cmd)
{
    dbg_log("ATA Command: " + h(cmd) + " slave=" + (this.drive_head >> 4 & 1), LOG_DISK);

    if(!this.buffer)
    {
        return;
    }

    this.error = 0;

    switch(cmd)
    {
        case 0x00:
            // NOP
            this.push_irq();
            this.status = 0x50;
            break;

        case 0x08:
            dbg_log("ATA device reset", LOG_DISK);
            this.data_pointer = 0;
            this.pio_data_allocate(0);
            this.device_reset();

            this.push_irq();
            break;

        case 0x10:
            // obsolete
            dbg_log("ATA cmd 10", LOG_DISK);
            this.push_irq();
            break;

        case 0xF8: // XXX
        case 0x27:
            // read native max address ext - read the actual size of the HD
            // https://en.wikipedia.org/wiki/Host_protected_area
            dbg_log("ATA cmd 27", LOG_DISK);
            this.push_irq();
            this.pio_data_set(new Uint8Array([
                0, 0, // error
                0, 0, // count

                // result
                this.buffer.byteLength & 0xff,
                this.buffer.byteLength >> 8 & 0xff,
                this.buffer.byteLength >> 16 & 0xff,
                this.buffer.byteLength >> 24 & 0xff,
                0, 0,
                0, 0,
            ]));
            this.status = 0x58;
            break;

        case 0x20:
        case 0x24:
        case 0x29:
        case 0xC4:
            // 0x20 read sectors
            // 0x24 read sectors ext
            // 0xC4 read multiple
            // 0x29 read multiple ext
            this.ata_read_sectors(cmd);
            break;

        case 0x30:
        case 0x34:
        case 0x39:
        case 0xC5:
            // 0x30 write sectors
            // 0x34 write sectors ext
            // 0xC5 write multiple
            // 0x39 write multiple ext
            this.ata_write(cmd);
            break;

        case 0x90:
            // EXECUTE DEVICE DIAGNOSTIC
            dbg_log("ATA cmd 90", LOG_DISK);
            this.push_irq();
            this.error = 0x101;
            this.status = 0x50;
            break;

        case 0x91:
            // INITIALIZE DEVICE PARAMETERS
            dbg_log("ATA cmd 91", LOG_DISK);
            this.push_irq();
            break;

        case 0xA0:
            // ATA_CMD_PACKET
            if(this.is_atapi)
            {
                this.status = 0x58;
                this.allocate_in_buffer(12);
                this.data_port_callback = IDE_CALLBACK_ATAPI;

                this.bytecount = 1;
                this.push_irq();
            }
            break;

        case 0xA1:
            dbg_log("ATA identify packet device", LOG_DISK);

            if(this.is_atapi)
            {
                this.create_identify_packet();
                this.status = 0x58;

                this.cylinder_low = 0x14;
                this.cylinder_high = 0xeb;

                this.push_irq();
            }
            else
            {
                this.status = 0x50;
                this.push_irq();
            }
            break;

        case 0xC6:
            // SET MULTIPLE MODE
            dbg_log("ATA cmd C6", LOG_DISK);

            // Logical sectors per DRQ Block in word 1
            dbg_log("Logical sectors per DRQ Block: " + h(this.bytecount), LOG_DISK);
            this.sectors_per_drq = this.bytecount;

            this.push_irq();
            break;

        case 0xC8:
            // 0xC8 read dma
            this.ata_read_sectors_dma(cmd);
            break;

        case 0x40:
            // read verify sectors
            this.push_irq();
            this.status = 0x50;
            this.push_irq();
            break;

        case 0xCA:
            // write dma
            this.ata_write_dma(cmd);
            break;

        case 0xDA:
            // get media status
            this.status = 0x41;
            this.error = 4;
            break;

        case 0xE1:
            dbg_log("ATA idle immediate", LOG_DISK);
            this.push_irq();
            break;

        case 0xEC:
            dbg_log("ATA identify device", LOG_DISK);

            if(this.is_atapi)
            {
                this.status = 0x41;
                this.error = 4;
                this.push_irq();
                return;
            }

            this.create_identify_packet();
            this.status = 0x58;

            this.push_irq();
            break;

        case 0xEA:
            //  FLUSH CACHE EXT
            dbg_log("ATA cmd EA", LOG_DISK);
            this.push_irq();
            break;

        case 0xEF:
            // SET FEATURES
            dbg_log("ATA cmd EF", LOG_DISK);
            this.push_irq();
            break;

        case 0xF5:
            // SECURITY FREEZE LOCK
            this.status = 0x50;
            this.push_irq();
            break;

        case 0x35: // write dma ext
        case 0x25: // read dma ext
        default:
            dbg_assert(false, "New ATA cmd on 1F7: " + h(cmd), LOG_DISK);

            this.status = 0x41;
            // abort bit set
            this.error = 4;
    }
};

IDEInterface.prototype.atapi_handle = function()
{
    dbg_log("ATAPI Command: " + h(this.data_port_buffer[0]) + " slave=" + (this.drive_head >> 4 & 1), LOG_DISK);

    this.data_pointer = 0;

    switch(this.data_port_buffer[0])
    {
        case 0x00:
            dbg_log("TEST_UNIT_READY", LOG_DISK);
            // test unit ready
            this.pio_data_allocate(0);
            this.status = 0x50;
            break;

        case 0x03:
            // request sense
            this.pio_data_allocate(this.data_port_buffer[4]);
            this.status = 0x58;

            this.pio_data[0] = 0x80 | 0x70;
            this.pio_data[7] = 8;
            break;

        case 0x12:
            // inquiry
            var length = this.data_port_buffer[4] | this.data_port_buffer[3] << 8;
            this.pio_data_allocate(length);
            this.status = 0x58;

            dbg_log("inquiry: " + h(this.data_port_buffer[1], 2) + " length=" + length, LOG_DISK);

            // http://www.t10.org/ftp/x3t9.2/document.87/87-106r0.txt
            this.pio_data.set([
                0x05, 0x80, 0x01, 0x31,
                // additional length
                31,
                0, 0, 0,

                // 8
                0x53, 0x4F, 0x4E, 0x59,
                0x20, 0x20, 0x20, 0x20,

                // 16
                0x43, 0x44, 0x2D, 0x52,
                0x4F, 0x4D, 0x20, 0x43,
                0x44, 0x55, 0x2D, 0x31,
                0x30, 0x30, 0x30, 0x20,

                // 32
                0x31, 0x2E, 0x31, 0x61,
            ]);
            break;

        case 0x1E:
            // prevent/allow medium removal
            this.pio_data_allocate(0);
            this.status = 0x50;
            break;

        case 0x25:
            // read capacity
            var count = this.sector_count - 1;
            this.pio_data_set(new Uint8Array([
                count >> 24 & 0xff,
                count >> 16 & 0xff,
                count >> 8 & 0xff,
                count & 0xff,
                0,
                0,
                this.sector_size >> 8 & 0xff,
                this.sector_size & 0xff,
            ]));
            this.status = 0x58;
            break;

        case 0x28:
            // read
            if(this.lba_count & 1)
            {
                this.atapi_read_dma(this.data_port_buffer);
            }
            else
            {
                this.atapi_read(this.data_port_buffer);
            }
            break;

        case 0x42:
            var length = this.data_port_buffer[8];
            this.pio_data_allocate(Math.min(8, length));
            dbg_log("read q subcode: length=" + length, LOG_DISK);
            this.status = 0x58;
            break;

        case 0x43:
            // read toc
            var format = this.data_port_buffer[9] >> 6;
            var length = this.data_port_buffer[8] | this.data_port_buffer[7] << 8;
            this.pio_data_allocate(length);
            dbg_log("read toc: " + h(format, 2) + " length=" + length, LOG_DISK);

            if(format === 1)
            {
                this.pio_data.set(new Uint8Array([
                    0, 10, // length
                    1, 1,
                    0, 0,
                    0, 0,
                    0, 0,
                    0, 0,
                ]));
            }

            this.status = 0x58;
            break;

        case 0x46:
            // get configuration
            this.pio_data_allocate(this.data_port_buffer[8] | this.data_port_buffer[7] << 8);
            this.status = 0x58;
            break;

        case 0x4A:
            // get event status notification
            this.pio_data_allocate(this.data_port_buffer[8] | this.data_port_buffer[7] << 8);
            this.status = 0x58;
            break;

        case 0x51:
            // read disk information
            this.pio_data_allocate(0);
            this.status = 0x50;
            break;

        case 0x1A:
            // mode sense (6)
            this.pio_data_allocate(this.data_port_buffer[4]);
            this.status = 0x58;
            break;

        case 0x5A:
            // mode sense
            var length = this.data_port_buffer[8] | this.data_port_buffer[7] << 8;
            var page_code = this.data_port_buffer[2];
            dbg_log("mode sense: " + h(page_code) + " length=" + length, LOG_DISK);
            if(page_code === 0x2A)
            {
                this.pio_data_allocate(Math.min(30, length));
            }
            this.status = 0x58;
            break;

        case 0xBD:
            // mechanism status
            this.pio_data_allocate(this.data_port_buffer[9] | this.data_port_buffer[8] << 8);
            this.pio_data[5] = 1;
            this.status = 0x58;
            break;

        default:
            this.status = 0x50;
            dbg_log("Unimplemented ATAPI command: " + h(this.data_port_buffer[0]), LOG_DISK);
            dbg_assert(false);
    }

    this.bytecount = this.bytecount & ~7 | 2;

    if((this.status & 0x80) === 0)
    {
        this.update_size();
        this.push_irq();
    }

    if((this.status & 0x80) === 0 && this.pio_data_length === 0)
    {
        this.bytecount |= 1;
        this.status &= ~8;
    }
};

IDEInterface.prototype.update_size = function()
{
    var byte_count = this.pio_data_length;
    var max_drq_size = this.cylinder_high << 8 & 0xFF00 | this.cylinder_low & 0xFF;

    if(!max_drq_size)
    {
        max_drq_size = 0x8000;
    }
    //max_drq_size &= 0xFF00;

    var transfered_ata_blocks = Math.min(byte_count, max_drq_size);
    transfered_ata_blocks &= ~1;

    this.cylinder_low = transfered_ata_blocks & 0xFF;
    this.cylinder_high = transfered_ata_blocks >> 8 & 0xFF;

    //dbg_log("pio data length: " + h(this.pio_data_length));
    this.cylinder_low = transfered_ata_blocks;
    this.cylinder_high = transfered_ata_blocks >> 8;
};

IDEInterface.prototype.do_write = function()
{
    this.status = 0x50;

    dbg_assert(this.data_port_count <= this.data_port_buffer.length);
    var data = this.data_port_buffer.subarray(0, this.data_port_count);

    //dbg_log(hex_dump(data), LOG_DISK);

    this.buffer.set(this.write_dest, data, function()
    {
        this.push_irq();
    }.bind(this));

    this.report_write(this.data_port_count);
};


IDEInterface.prototype.allocate_in_buffer = function(size)
{
    // reuse old buffer if it's smaller or the same size
    if(size > this.data_port_buffer.length)
    {
        this.data_port_buffer = new Uint8Array(size);
    }

    this.data_port_count = size;
    this.data_port_current = 0;
};

IDEInterface.prototype.atapi_read = function(cmd)
{
    // Note: Big Endian
    var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5],
        count = cmd[7] << 8 | cmd[8],
        flags = cmd[1],
        byte_count = count * this.sector_size,
        //transfered_ata_blocks = Math.min(this.bytecount / 512, this.cylinder_low << 8 | this.cylinder_high),
        start = lba * this.sector_size;

    dbg_log("CD read lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count) +
            " flags=" + h(flags), LOG_CD);

    this.pio_data_allocate_noclear(0);
    this.cylinder_low = this.cylinder_high = 0;

    //this.push_irq();

    if(start >= this.buffer.byteLength)
    {
        dbg_assert(false, "CD read: Outside of disk  end=" + h(start + byte_count) +
                          " size=" + h(this.buffer.byteLength), LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else if(byte_count === 0)
    {
        this.status = 0x50;

        this.data_pointer = 0;
        //this.push_irq();
    }
    else
    {
        byte_count = Math.min(byte_count, this.buffer.byteLength - start);
        this.status = 0x50 | 0x80;
        this.report_read_start();

        this.buffer.get(start, byte_count, function(data)
        {
            dbg_log("cd read: data arrived", LOG_CD)
            this.pio_data_set(data);
            this.status = 0x58;
            this.bytecount |= 2;

            this.data_pointer = 0;
            this.push_irq();
            this.update_size();

            this.report_read_end(byte_count);
        }.bind(this));
    }
};

IDEInterface.prototype.atapi_read_dma = function(cmd)
{
    // Note: Big Endian
    var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5],
        count = cmd[7] << 8 | cmd[8],
        flags = cmd[1],
        byte_count = count * this.sector_size,
        start = lba * this.sector_size;

    dbg_log("CD read DMA lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count) +
            " flags=" + h(flags), LOG_CD);

    this.pio_data_allocate_noclear(byte_count);

    if(start >= this.buffer.byteLength)
    {
        dbg_assert(false, "CD read: Outside of disk  end=" + h(start + byte_count) +
                          " size=" + h(this.buffer.byteLength), LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else
    {
        byte_count = Math.min(byte_count, this.buffer.byteLength - start);
        this.status = 0x80;
        this.report_read_start();

        this.buffer.get(start, byte_count, function(data)
        {
            var prdt_start = this.device.prdt_addr,
                offset = 0;

            do {
                var addr = this.memory.read32s(prdt_start),
                    count = this.memory.read16(prdt_start + 4),
                    end = this.memory.read8(prdt_start + 7) & 0x80;

                if(!count)
                {
                    count = 0x10000;
                }

                dbg_log("dma read dest=" + h(addr) + " count=" + h(count), LOG_DISK);
                this.memory.write_blob(data.subarray(offset, offset + count), addr);

                offset += count;
                prdt_start += 8;

                dbg_assert(offset <= this.buffer.byteLength);
            }
            while(!end);

            this.status = 0x50;
            this.device.dma_status &= ~2 & ~1;
            this.device.dma_status |= 4;

            this.push_irq();

            this.report_read_end(byte_count);
        }.bind(this));
    }
};

IDEInterface.prototype.read_data = function()
{
    //dbg_log("ptr: " + h(this.data_pointer, 2));
    if(this.data_pointer < this.pio_data_length)
    {
        var do_irq = false;

        if((this.data_pointer + 1) % (this.sectors_per_drq * 512) === 0 ||
            this.data_pointer + 1 === this.pio_data_length)
        {
            dbg_log("ATA IRQ", LOG_DISK);
            //this.push_irq();
            do_irq = true;
        }

        if(this.cylinder_low)
        {
            this.cylinder_low--;
        }
        else
        {
            if(this.cylinder_high)
            {
                this.cylinder_high--;
                this.cylinder_low = 0xFF;
            }
        }

        if(!this.cylinder_low && !this.cylinder_high)
        {
            var remaining = this.pio_data_length - this.data_pointer - 1;
            dbg_log("reset to " + h(remaining), LOG_DISK);

            if(remaining >= 0x10000)
            {
                this.cylinder_high = 0xF0;
                this.cylinder_low = 0;
            }
            else
            {
                this.cylinder_high = remaining >> 8;
                this.cylinder_low = remaining;
            }

        }

        if(this.data_pointer + 1 >= this.pio_data_length)
        {
            this.status = 0x50;
            this.bytecount = this.bytecount & ~7 | 3;
            //this.push_irq();
            do_irq = true;
        }

        if((this.data_pointer + 1 & 255) === 0)
        {
            dbg_log("Read 1F0: " + h(this.pio_data[this.data_pointer], 2) +
                        " cur=" + h(this.data_pointer) +
                        " cnt=" + h(this.pio_data_length), LOG_DISK);
        }

        if(do_irq)
        {
            this.push_irq();
        }

        return this.pio_data[this.data_pointer++];
    }
    else
    {
        dbg_log("Read 1F0: empty", LOG_DISK);

        this.data_pointer++;
        return 0;
    }
};

IDEInterface.prototype.write_data_port8 = function(data)
{
    if(this.data_port_current >= this.data_port_count)
    {
        dbg_log("Redundant write to data port: " + h(data) + " count=" + h(this.data_port_count) +
                " cur=" + h(this.data_port_current), LOG_DISK);
    }
    else
    {
        if((this.data_port_current + 1 & 255) === 0 || this.data_port_count < 20)
        {
            dbg_log("Data port: " + h(data) + " count=" + h(this.data_port_count) +
                    " cur=" + h(this.data_port_current), LOG_DISK);
        }

        this.data_port_buffer[this.data_port_current++] = data;

        if((this.data_port_current % (this.sectors_per_drq * 512)) === 0)
        {
            dbg_log("ATA IRQ", LOG_DISK);
            this.push_irq();
        }

        if(this.data_port_current === this.data_port_count)
        {
            this.do_callback();
        }
    }
};

IDEInterface.prototype.write_data_port16 = function(data)
{
    this.write_data_port8(data & 0xFF);
    this.write_data_port8(data >> 8 & 0xFF);
};

IDEInterface.prototype.write_data_port32 = function(data)
{
    this.write_data_port8(data & 0xFF);
    this.write_data_port8(data >> 8 & 0xFF);
    this.write_data_port8(data >> 16 & 0xFF);
    this.write_data_port8(data >> 24 & 0xFF);
};

IDEInterface.prototype.ata_read_sectors = function(cmd)
{
    if(cmd === 0x20 || cmd === 0xC4)
    {
        // read sectors
        var count = this.bytecount & 0xff,
            lba = this.is_lba ? this.get_lba28() : this.get_chs();

        if(count === 0)
            count = 0x100;
    }
    else if(cmd === 0x24 || cmd === 0x29)
    {
        // read sectors ext
        var count = this.bytecount,
            lba = this.get_lba48();

        if(count === 0)
            count = 0x10000;
    }
    else
    {
        dbg_assert(false);
        return;
    }

    var
        byte_count = count * this.sector_size,
        start = lba * this.sector_size;


    dbg_log("ATA read cmd=" + h(cmd) +
            " mode=" + (this.is_lba ? "lba" : "chs") +
            " lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    this.cylinder_low += count;

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_log("ATA read: Outside of disk", LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else
    {
        //this.status = 0xFF & ~8;
        this.status = 0x80;
        this.report_read_start();

        this.buffer.get(start, byte_count, function(data)
        {
            this.pio_data_set(data);
            this.status = 0x58;
            this.data_pointer = 0;

            this.push_irq();

            this.report_read_end(byte_count);
        }.bind(this));
    }
};

IDEInterface.prototype.ata_read_sectors_dma = function(cmd)
{
    var count = this.bytecount & 0xff,
        lba = this.get_lba28();

    dbg_assert(this.is_lba);

    var byte_count = count * this.sector_size,
        start = lba * this.sector_size;

    dbg_log("ATA DMA read lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    this.cylinder_low += count;

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_log("ATA read: Outside of disk", LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
        return;
    }

    //this.status = 0xFF & ~8;
    this.status = 0x80 | 0x58;
    this.device.dma_status |= 1;
    this.report_read_start();

    var orig_prdt_start = this.device.prdt_addr;

    this.buffer.get(start, byte_count, function(data)
    {
        var prdt_start = this.device.prdt_addr,
            offset = 0;

        dbg_assert(orig_prdt_start === prdt_start);

        do {
            var addr = this.memory.read32s(prdt_start),
                count = this.memory.read16(prdt_start + 4),
                end = this.memory.read8(prdt_start + 7) & 0x80;

            if(!count)
            {
                count = 0x10000;
            }

            dbg_log("dma read transfer dest=" + h(addr) + " count=" + h(count), LOG_DISK);
            this.memory.write_blob(data.subarray(offset, offset + count), addr);

            offset += count;
            prdt_start += 8;
        }
        while(!end);

        dbg_assert(offset === byte_count);

        this.status = 0x50;
        this.device.dma_status &= ~2 & ~1;
        this.device.dma_status |= 4;

        this.push_irq();

        this.report_read_end(byte_count);
    }.bind(this));
};

IDEInterface.prototype.ata_write = function(cmd)
{
    if(cmd === 0x30 || cmd === 0xC5)
    {
        // write sectors
        var count = this.bytecount & 0xff,
            lba = this.is_lba ? this.get_lba28() : this.get_chs();

        if(count === 0)
            count = 0x100;
    }
    else if(cmd === 0x34 || cmd === 0x39)
    {
        var count = this.bytecount,
            lba = this.get_lba48();

        if(count === 0)
            count = 0x10000;
    }
    else
    {
        dbg_assert(false);
        return;
    }

    var byte_count = count * this.sector_size,
        start = lba * this.sector_size;


    dbg_log("ATA write lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    this.cylinder_low += count;

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_assert(false, "ATA write: Outside of disk", LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else
    {
        this.status = 0x58;

        this.allocate_in_buffer(byte_count);

        this.write_dest = start;
        this.data_port_callback = IDE_CALLBACK_WRITE;

        //this.bytecount = 1;
        this.push_irq();
    }
};

IDEInterface.prototype.ata_write_dma = function(cmd)
{
    var count = this.bytecount & 0xff,
        lba = this.get_lba28();

    dbg_assert(this.is_lba);

    var byte_count = count * this.sector_size,
        start = lba * this.sector_size;

    dbg_log("ATA DMA write lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    this.cylinder_low += count;

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_assert(false, "ATA DMA write: Outside of disk", LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
        return;
    }

    //status = 0xFF & ~8;
    this.status = 0x80;
    this.device.dma_status |= 1;

    var prdt_start = this.device.prdt_addr,
        prdt_count = 0,
        prdt_write_count = 0,
        offset = 0;

    dbg_log("prdt addr: " + h(prdt_start, 8), LOG_DISK);

    do {
        var prd_addr = this.memory.read32s(prdt_start),
            prd_count = this.memory.read16(prdt_start + 4),
            end = this.memory.read8(prdt_start + 7) & 0x80;

        if(!prd_count)
        {
            prd_count = 0x10000;
            dbg_log("dma: prd count was 0", LOG_DISK);
        }

        dbg_log("dma write transfer dest=" + h(prd_addr) + " prd_count=" + h(prd_count), LOG_DISK);

        var slice = this.memory.mem8.subarray(prd_addr, prd_addr + prd_count);
        dbg_assert(slice.length === prd_count);

        //if(DEBUG)
        //{
        //    dbg_log(hex_dump(slice), LOG_DISK);
        //}

        this.buffer.set(start + offset, slice, function()
        {
            prdt_write_count++;

            if(prdt_write_count === prdt_count)
            {
                dbg_log("dma write completed", LOG_DISK);
                this.status = 0x50;
                this.push_irq();
                this.device.dma_status &= ~2 & ~1;
                this.device.dma_status |= 4;
            }
        }.bind(this));

        offset += prd_count;
        prdt_start += 8;
        prdt_count++;
    }
    while(!end);


    if(prdt_write_count === prdt_count)
    {
        dbg_log("dma write completed", LOG_DISK);
        this.status = 0x50;
        this.push_irq();
        this.device.dma_status &= ~2 & ~1;
        this.device.dma_status |= 4;
    }
    else
    {
        dbg_assert(false, "dma write not completed", LOG_DISK);
    }

    this.report_write(byte_count);
};

IDEInterface.prototype.get_chs = function()
{
    var c = this.cylinder_low & 0xFF | this.cylinder_high << 8 & 0xFF00,
        h = this.head,
        s = this.sector & 0xFF;

    return (c * this.head_count + h) * this.sectors_per_track + s - 1;
};

IDEInterface.prototype.get_lba28 = function()
{
    return this.sector & 0xFF |
            this.cylinder_low << 8 & 0xFF00 |
            this.cylinder_high << 16 & 0xFF0000 |
            (this.head & 0xF) << 24;
};

IDEInterface.prototype.get_lba48 = function()
{
    // Note: Bits over 32 missing
    return (this.sector & 0xFF | this.cylinder_low << 8 & 0xFF00 | this.cylinder_high << 16 & 0xFF0000 |
            (this.sector >> 8) << 24 & 0xFF000000) >>> 0;
};

IDEInterface.prototype.create_identify_packet = function()
{
    this.data_pointer = 0;
    // http://bochs.sourceforge.net/cgi-bin/lxr/source/iodev/harddrv.cc#L2821

    if(this.drive_head & 0x10)
    {
        // slave
        this.pio_data_allocate(0);
        return;
    }

    for(var i = 0; i < 512; i++)
    {
        this.pio_data[i] = 0;
    }

    this.pio_data_set([
        0x40, this.is_atapi ? 0x85 : 0,
        // 1 cylinders
        this.cylinder_count, this.cylinder_count >> 8,
        0, 0,

        // 3 heads
        this.head_count, this.head_count >> 8,
        this.sectors_per_track / 512, this.sectors_per_track / 512 >> 8,
        // 5
        0, 512 >> 8,
        // sectors per track
        this.sectors_per_track, this.sectors_per_track >> 8,
        0, 0, 0, 0, 0, 0,
        // 10-19 serial number
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 15
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 20
        3, 0,
        0, 2,
        4, 0,
        // 23-26 firmware revision
        0, 0, 0, 0, 0, 0, 0, 0,

        // 27 model number
        56, 118, 32, 54, 68, 72, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
        32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,

        // 47
        0xFF, 0,
        1, 0,
        0, 3,  // capabilities, 2: Only LBA / 3: LBA and DMA
        // 50
        0, 0,
        0, 2,
        0, 2,
        7, 0,

        // 54 cylinders
        this.cylinder_count, this.cylinder_count >> 8,
        // 55 heads
        this.head_count, this.head_count >> 8,
        // 56 sectors per track
        this.sectors_per_track, 0,
        // capacity in sectors
        this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF,
        this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF,

        0, 0,
        // 60
        this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF,
        this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF,

        0, 0,
        // 63, dma selected mode
        0, 4,
        //0, 0, // no DMA

        0, 0,
        // 65
        30, 0, 30, 0, 30, 0, 30, 0, 0, 0,
        // 70
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 75
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 80
        0x7E, 0, 0, 0, 0, 0, 0, 0x74, 0, 0x40,
        // 85
        0, 0x40, 0, 0x74, 0, 0x40, 0, 0, 0, 0,
        // 90
        0, 0, 0, 0, 0, 0, 1, 0x60, 0, 0,
        // 95
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 100
        this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF,
        this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF,
    ]);

    this.pio_data_length = 512;

    if(this.cylinder_count > 16383)
    {
        this.pio_data[2] = this.pio_data[108] = 16383 & 0xFF;
        this.pio_data[3] = this.pio_data[109] = 16383 >> 8;
    }
};

IDEInterface.prototype.pio_data_allocate = function(len)
{
    this.pio_data_allocate_noclear(len);

    for(var i = 0; i < len; i++)
    {
        this.pio_data[i] = 0;
    }
};

IDEInterface.prototype.pio_data_allocate_noclear = function(len)
{
    if(this.pio_data.length < len)
    {
        this.pio_data = new Uint8Array(len + 3 & ~3);
    }

    this.pio_data_length = len;
};

IDEInterface.prototype.pio_data_set = function(data)
{
    if(this.pio_data.length < data.length)
    {
        this.pio_data = new Uint8Array(data.length + 3 & ~3);
    }

    this.pio_data.set(data);
    this.pio_data_length = data.length;
};

IDEInterface.prototype.report_read_start = function()
{
    this.stats.loading = true;
    this.bus.send("ide-read-start");
};

IDEInterface.prototype.report_read_end = function(byte_count)
{
    this.stats.loading = false;

    var sector_count = byte_count / this.sector_size | 0;
    this.stats.sectors_read += sector_count;
    this.stats.bytes_read += byte_count;

    this.bus.send("ide-read-end", [this.nr, byte_count, sector_count]);
};

IDEInterface.prototype.report_write = function(byte_count)
{
    var sector_count = byte_count / this.sector_size | 0;
    this.stats.sectors_written += sector_count;
    this.stats.bytes_written += byte_count;

    this.bus.send("ide-write-end", [this.nr, byte_count, sector_count]);
};

IDEInterface.prototype.get_state = function()
{
    var state = [];
    state[0] = this.bytecount;
    state[1] = this.cylinder_count;
    state[2] = this.cylinder_high;
    state[3] = this.cylinder_low;
    state[4] = this.data_pointer;
    state[5] = this.data_port_buffer;
    state[6] = this.data_port_callback;
    state[7] = this.data_port_count;
    state[8] = this.data_port_current;
    state[9] = this.drive_head;
    state[10] = this.error;
    state[11] = this.head;
    state[12] = this.head_count;
    state[13] = this.is_atapi;
    state[14] = this.is_lba;
    state[15] = this.lba_count;
    state[16] = this.pio_data;
    state[17] = this.pio_data_length;
    state[18] = this.sector;
    state[19] = this.sector_count;
    state[20] = this.sector_size;
    state[21] = this.sectors_per_drq;
    state[22] = this.sectors_per_track;
    state[23] = this.status;
    state[24] = this.write_dest;
    return state;
};

IDEInterface.prototype.set_state = function(state)
{
    this.bytecount = state[0];
    this.cylinder_count = state[1];
    this.cylinder_high = state[2];
    this.cylinder_low = state[3];
    this.data_pointer = state[4];
    this.data_port_buffer = state[5];
    this.data_port_callback = state[6];
    this.data_port_count = state[7];
    this.data_port_current = state[8];
    this.drive_head = state[9];
    this.error = state[10];
    this.head = state[11];
    this.head_count = state[12];
    this.is_atapi = state[13];
    this.is_lba = state[14];
    this.lba_count = state[15];
    this.pio_data = state[16];
    this.pio_data_length = state[17];
    this.sector = state[18];
    this.sector_count = state[19];
    this.sector_size = state[20];
    this.sectors_per_drq = state[21];
    this.sectors_per_track = state[22];
    this.status = state[23];
    this.write_dest = state[24];
};
