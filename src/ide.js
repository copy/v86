"use strict";

var 
    /** @const */
    CDROM_SECTOR_SIZE = 2048,
    /** @const */
    HD_SECTOR_SIZE = 512;


/** @constructor */
function IDEDevice(cpu, buffer, is_cd, nr)
{
    // gets set via PCI in seabios, likely doesn't matter
    if(nr === 0)
    {
        this.ata_port = 0x1F0;
        this.irq = 14;

        this.pci_id = 0x1E << 3;
    }
    else
    {
        this.ata_port = 0x1F0;
        this.irq = 14;

        this.pci_id = 0x1F << 3;
    }

    // alternate status, starting at 3f4/374
    this.ata_port_high = this.ata_port | 0x204;
    
    this.master_port = 0xC000;

    this.pic = cpu.devices.pic;
    this.memory = cpu.memory;

    this.sector_size = is_cd ? CDROM_SECTOR_SIZE : HD_SECTOR_SIZE;
    this.buffer = buffer;
    this.is_atapi = is_cd;

    if(this.buffer)
    {
        this.sector_count = this.buffer.byteLength / this.sector_size;

        if(this.sector_size !== (this.sector_size | 0))
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
            this.head_count = 255;
            this.sectors_per_track = 63;
        }

        this.cylinder_count = this.sector_count / (this.head_count + 1) / (this.sectors_per_track + 1);

        if(this.cylinder_count !== (this.cylinder_count | 0))
        {
            dbg_log("Warning: Rounding up cylinder count. Choose different head number", LOG_DISK);
            this.cylinder_count = Math.ceil(this.cylinder_count);
        }
    }
    else
    {
        this.sector_count = 0;

        this.head_count = 0;
        this.sectors_per_track = 0;

        this.cylinder_count = 0;
    }

    this.stats = {
        sectors_read: 0,
        sectors_written: 0,
        bytes_read: 0,
        bytes_written: 0,
    };

    this.pci_space = [
        0x86, 0x80, 0x20, 0x3a, 0x05, 0x00, 0xa0, 0x02, 0x00, 0x8f, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        this.ata_port & 0xFF | 1,      this.ata_port >> 8, 0x00, 0x00, 
        this.ata_port_high & 0xFF | 1, this.ata_port_high >> 8, 0x00, 0x00, 
        0x00, 0x00, 0x00, 0x00, 
        0x00, 0x00, 0x00, 0x00,
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

    // 00:1f.2 IDE interface: Intel Corporation 82801JI (ICH10 Family) 4 port SATA IDE Controller #1
    //0x86, 0x80, 0x20, 0x3a, 0x05, 0x00, 0xb0, 0x02, 0x00, 0x8f, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    //0x01, 0x90, 0x00, 0x00, 0x01, 0x8c, 0x00, 0x00, 0x81, 0x88, 0x00, 0x00, 0x01, 0x88, 0x00, 0x00,
    //0x81, 0x84, 0x00, 0x00, 0x01, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x43, 0x10, 0xd4, 0x82,
    //0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x02, 0x00, 0x00,
    cpu.devices.pci.register_device(this);

    // status
    cpu.io.register_read(this.ata_port | 7, this.read_status, this);
    cpu.io.register_read(this.ata_port_high | 2, this.read_status, this);

    cpu.io.register_write(this.ata_port | 7, this.write_control, this);
    cpu.io.register_write(this.ata_port_high | 2, this.write_control, this);

    this.device_control = 2;
    this.last_drive = 0xFF;
    this.data_pointer = 0;
    this.pio_data = new Uint8Array(0);
    this.is_lba = 0;
    this.bytecount = 0;
    this.sector = 0;
    this.lba_count = 0;
    this.cylinder_low = 0;
    this.cylinder_high = 0;
    this.head = 0;
    this.drive_head = 0;
    this.status = 0x50;
    this.sectors_per_drq = 1;

    this.write_dest = 0;

    this.data_port_count = 0;
    this.data_port_current = 0;
    this.data_port_buffer = new Uint8Array(0);
    this.data_port_callback = null;


    this.next_status = -1;

    this.prdt_addr = 0;
    this.dma_status = 0;

    cpu.io.register_read(this.ata_port | 0, this.read_data_port, this);
    cpu.io.register_read(this.ata_port | 1, this.read_data_port, this);
    cpu.io.register_read(this.ata_port | 2, this.read_data_port, this);
    cpu.io.register_read(this.ata_port | 3, this.read_data_port, this);

    cpu.io.register_read(this.ata_port | 4, function()
    {
        dbg_log("Read 1F4: " + h(this.cylinder_low & 0xFF), LOG_DISK);
        return this.cylinder_low & 0xFF;
    }, this);
    cpu.io.register_read(this.ata_port | 5, function(port)
    {
        dbg_log("Read 1F5: " + h(this.cylinder_high & 0xFF), LOG_DISK);
        return this.cylinder_high & 0xFF;
    }, this);
    cpu.io.register_read(this.ata_port | 6, function()
    {
        dbg_log("Read 1F6", LOG_DISK);
        return this.drive_head;
    }, this);


    cpu.io.register_write(this.ata_port | 0, this.write_data_port, this);
    cpu.io.register_write(this.ata_port | 1, this.write_data_port, this);
    cpu.io.register_write(this.ata_port | 2, this.write_data_port, this);
    cpu.io.register_write(this.ata_port | 3, this.write_data_port, this);

    cpu.io.register_write(this.ata_port | 4, function(data)
    {
        dbg_log("1F4/sector low: " + h(data), LOG_DISK);
        this.cylinder_low = (this.cylinder_low << 8 | data) & 0xFFFF;
    }, this);
    cpu.io.register_write(this.ata_port | 5, function(data)
    {
        dbg_log("1F5/sector high: " + h(data), LOG_DISK);
        this.cylinder_high = (this.cylinder_high << 8 | data) & 0xFFFF;
    }, this);
    cpu.io.register_write(this.ata_port | 6, function(data)
    {
        var slave = data & 0x10,
            mode = data & 0xE0,
            low = data & 0xF;

        dbg_log("1F6/drive: " + h(data, 2), LOG_DISK);

        if(slave)
        {
            dbg_log("Slave", LOG_DISK);
            return;
        }
        
        if((mode & 0x40) === 0)
        {
            // chs mode
            //dbg_log("CHS mode: Unimplemented", LOG_DISK);
            //return;
        }

        this.drive_head = data;
        this.is_lba = data >> 6 & 1;
        this.head = data & 0xF;
        this.last_drive = data;
    }, this);

    cpu.io.register_write(this.ata_port | 7, this.ata_command, this);

    cpu.io.register_read(this.master_port | 4, this.dma_read_addr0, this);
    cpu.io.register_read(this.master_port | 5, this.dma_read_addr1, this);
    cpu.io.register_read(this.master_port | 6, this.dma_read_addr2, this);
    cpu.io.register_read(this.master_port | 7, this.dma_read_addr3, this);

    cpu.io.register_write(this.master_port | 4, this.dma_set_addr0, this);
    cpu.io.register_write(this.master_port | 5, this.dma_set_addr1, this);
    cpu.io.register_write(this.master_port | 6, this.dma_set_addr2, this);
    cpu.io.register_write(this.master_port | 7, this.dma_set_addr3, this);

    cpu.io.register_read(this.master_port | 2, this.dma_read_status, this);
    cpu.io.register_write(this.master_port | 2, this.dma_write_status, this);
    cpu.io.register_read(this.master_port, this.dma_read_command, this);
    cpu.io.register_write(this.master_port, this.dma_write_command, this);


}


IDEDevice.prototype.push_irq = function()
{
    if((this.device_control & 2) === 0)
    {
        dbg_log("push irq", LOG_DISK);

        this.dma_status |= 4;
        this.pic.push_irq(this.irq);
    }
};

IDEDevice.prototype.ata_command = function(cmd)
{
    dbg_log("ATA Command: " + h(cmd), LOG_DISK);

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
            this.pio_data = new Uint8Array(0);
            this.status = 0x50;

            this.push_irq();
            break;

        case 0x10:
            // obsolete
            dbg_log("ATA cmd 10", LOG_DISK);
            this.push_irq();
            break;

        case 0x27:
            // read native max address ext - read the actual size of the HD
            // https://en.wikipedia.org/wiki/Host_protected_area
            dbg_log("ATA cmd 27", LOG_DISK);
            this.push_irq();
            this.pio_data = new Uint8Array([
                0, 0, // error
                0, 0, // count

                // result
                this.buffer.byteLength & 0xff,
                this.buffer.byteLength >> 8 & 0xff,
                this.buffer.byteLength >> 16 & 0xff,
                this.buffer.byteLength >> 24 & 0xff,
                0, 0,

                0, 0, 
            ]);
            this.status = 0x58;
            break;

        case 0x20:
        case 0x29:
        case 0x24:
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
            // 0x30 write sectors
            // 0x34 write sectors ext
            // 0x39 write multiple ext
            this.ata_write(cmd);
            break;

        case 0x90:
            // EXECUTE DEVICE DIAGNOSTIC
            dbg_log("ATA cmd 90", LOG_DISK);
            this.push_irq();
            this.lba_count = 0x101;
            this.status = 0x50;
            break;

        case 0x91:
            // INITIALIZE DEVICE PARAMETERS
            dbg_log("ATA cmd 91", LOG_DISK);
            this.push_irq();
            break;

        case 0xA0:
            if(this.is_atapi)
            {
                // ATA_CMD_PACKET
                this.status = 0x58;
                this.allocate_in_buffer(12);
                this.data_port_callback = this.atapi_handle;

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

        case 0xCA:
            // write dma
            this.ata_write_dma(cmd);
            break;

        case 0xE1:
            dbg_log("ATA idle immediate", LOG_DISK);
            this.push_irq();
            break;

        case 0xEC:
            dbg_log("ATA identify device", LOG_DISK);
            // identify device

            if(this.is_atapi)
            {
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

        default:
            dbg_log("New ATA cmd on 1F7: " + h(cmd), LOG_DISK);

            // abort bit set
            this.lba_count = 4;
    }
};

IDEDevice.prototype.atapi_handle = function()
{
    dbg_log("ATAPI Command: " + h(this.data_port_buffer[0]), LOG_DISK);

    this.bytecount = 2;
    
    switch(this.data_port_buffer[0])
    {
        case 0x00:
            // test unit ready
            this.status = 0x40;
            this.cylinder_low = 8;
            this.cylinder_high = 0;
            this.push_irq();
            break;

        case 0x03:
            // request sense
            this.pio_data = new Uint8Array(Math.min(this.data_port_buffer[4], 15));
            this.status = 0x58;

            this.pio_data[0] = 0x80 | 0x70;
            this.pio_data[7] = 8;

            this.data_pointer = 0;
            this.bytecount = 2;
            this.cylinder_low = 8;
            this.cylinder_high = 0;

            this.push_irq();
            break;

        case 0x12:
            // inquiry
            this.pio_data = new Uint8Array(Math.min(this.data_port_buffer[4], 36));
            this.status = 0x58;

            // http://www.t10.org/ftp/x3t9.2/document.87/87-106r0.txt
            this.pio_data.set([
                0x05, 0x80, 0x01, 0x31,
                0, 0, 0, 0,

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

            this.data_pointer = 0;
            this.bytecount = 2;
            this.push_irq();
            break;

        case 0x1E:
            // prevent/allow medium removal
            this.pio_data = new Uint8Array(0);
            this.status = 0x50;
            this.data_pointer = 0;
            this.bytecount = 2;
            this.push_irq();
            break;

        case 0x25:
            // read capacity
            this.pio_data = new Uint8Array([
                this.sector_count >> 24 & 0xff,
                this.sector_count >> 16 & 0xff,
                this.sector_count >> 8 & 0xff,
                this.sector_count & 0xff,
                0,
                0,
                this.sector_size >> 8 & 0xff,
                this.sector_size & 0xff,
            ]);
            this.status = 0x58;

            this.data_pointer = 0;

            this.bytecount = 2;
            this.cylinder_low = 8;
            this.cylinder_high = 0;

            this.push_irq();
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

        case 0x43:
            // read header
            this.pio_data = new Uint8Array(2048);
            this.pio_data[0] = 0;
            this.pio_data[1] = 10;
            this.pio_data[2] = 1;
            this.pio_data[3] = 1;
            this.status = 0x58;
            this.data_pointer = 0;
            this.bytecount = 2;
            this.cylinder_high = 8;
            this.cylinder_low = 0;
            this.push_irq();
            break;

        case 0x46:
            // get configuration
            this.pio_data = new Uint8Array(this.data_port_buffer[8] | this.data_port_buffer[7] << 8);
            this.status = 0x58;
            this.data_pointer = 0;
            this.bytecount = 2;
            this.push_irq();
            break;

        case 0x4A:
            // get event status notification
            this.pio_data = new Uint8Array(this.data_port_buffer[8] | this.data_port_buffer[7] << 8);
            this.status = 0x58;
            this.data_pointer = 0;
            this.bytecount = 2;
            this.push_irq();
            break;

        case 0x51:
            // read disk information
            this.pio_data = new Uint8Array(0);
            this.status = 0x50;
            this.data_pointer = 0;
            this.bytecount = 2;
            this.push_irq();
            break;

        case 0x5A:
            // mode sense
            this.push_irq();
            this.status = 0x50;
            break;

        default:
            this.status = 0x50;
            dbg_log("Unimplemented ATAPI command: " + h(this.data_port_buffer[0]), LOG_DISK);
    }
};

IDEDevice.prototype.do_write = function()
{
    this.status = 0x50;

    var data = this.data_port_buffer.subarray(0, this.data_port_count);

    this.buffer.set(this.write_dest, data, function()
    {
        this.push_irq();
    }.bind(this));

    this.stats.sectors_written += this.data_port_count / this.sector_size | 0;
    this.stats.bytes_written += this.data_port_count;
};

IDEDevice.prototype.read_status = function()
{
    var ret = this.status;
    dbg_log("ATA read status: " + h(this.status), LOG_DISK);

    if(this.next_status >= 0)
    {
        this.status = this.next_status;
        this.next_status = -1;
    }

    return ret;
};

IDEDevice.prototype.write_control = function(data, port)
{
    dbg_log("device control: " + h(data) + " port=" + h(port), LOG_DISK);
    this.device_control = data;

    if(data & 4)
    {
        dbg_log("Reset via control port", LOG_DISK);

        // reset
        if(this.is_atapi)
        {
            this.status = 0x50 | 1;
            this.bytecount = 1;
            this.lba_count = 1;
            this.sector = 1; // lba_low
            this.cylinder_low = 0x14; // lba_mid
            this.cylinder_high = 0xeb; // lba_high
        }
        else
        {
            this.status = 0x50 | 1;
            this.bytecount = 1;
            this.lba_count = 1;
            this.sector = 1; // lba_low
            this.cylinder_low = 0x3c; // lba_mid
            this.cylinder_high = 0xc3; // lba_high
        }
    }
};

IDEDevice.prototype.allocate_in_buffer = function(size)
{
    // reuse old buffer if it's smaller or the same size
    if(size > this.data_port_buffer.length)
    {
        this.data_port_buffer = new Uint8Array(size);
    }

    this.data_port_count = size;
    this.data_port_current = 0;
};

IDEDevice.prototype.atapi_read = function(cmd)
{
    // Note: Big Endian
    var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5],
        count = cmd[7] << 8 | cmd[8], 
        flags = cmd[1],
        byte_count = count * this.sector_size,
        //transfered_ata_blocks = Math.min(this.bytecount / 512, this.cylinder_low << 8 | this.cylinder_high),
        max_drq_size = (this.cylinder_high & 0xFF) << 8 | this.cylinder_low & 0xFF,
        transfered_ata_blocks,
        start = lba * this.sector_size;

    dbg_log("CD read lba=" + h(lba) + 
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count) +
            " flags=" + h(flags), LOG_CD);

    if(!max_drq_size)
    {
        max_drq_size = 0x8000;
    }

    transfered_ata_blocks = Math.min(byte_count, max_drq_size);

    this.cylinder_low = transfered_ata_blocks & 0xFF;
    this.cylinder_high = transfered_ata_blocks >> 8 & 0xFF;

    if(start >= this.buffer.byteLength)
    {
        dbg_log("CD read: Outside of disk  end=" + h(start + byte_count) + 
                " size=" + h(this.buffer.byteLength), LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else
    {
        byte_count = Math.min(byte_count, this.buffer.byteLength - start);
        this.status = 0x80;

        this.buffer.get(start, byte_count, function(data)
        {
            this.pio_data = data;
            this.status = 0x58;

            //this.cylinder_low = 0;
            //this.cylinder_high = 8;

            this.data_pointer = 0;
            this.push_irq();

            this.stats.sectors_read += byte_count / this.sector_size | 0;
            this.stats.bytes_read += byte_count;
        }.bind(this));
    }
};

IDEDevice.prototype.atapi_read_dma = function(cmd)
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


    if(start >= this.buffer.byteLength)
    {
        dbg_log("CD read: Outside of disk  end=" + h(start + byte_count) + 
                " size=" + h(this.buffer.byteLength), LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else
    {
        byte_count = Math.min(byte_count, this.buffer.byteLength - start);
        this.status = 0x80;

        this.buffer.get(start, byte_count, function(data)
        {
            var prdt_start = this.prdt_addr,
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
            }
            while(!end);

            this.status = 0x50;
            this.dma_status &= ~2 & ~1;
            this.dma_status |= 4;

            this.push_irq();
            
            this.stats.sectors_read += byte_count / this.sector_size | 0;
            this.stats.bytes_read += byte_count;
        }.bind(this));
    }
};

IDEDevice.prototype.read_data_port = function(port_addr)
{
    if(port_addr === this.ata_port)
    {
        return this.read_data();
    }
    else if(port_addr === (this.ata_port | 1))
    {
        dbg_log("Read lba_count: " + h(this.lba_count & 0xFF), LOG_DISK);
        return this.lba_count & 0xFF;
    }
    else if(port_addr === (this.ata_port | 2))
    {
        dbg_log("Read bytecount: " + h(this.bytecount & 0xFF), LOG_DISK);
        return this.bytecount & 0xFF;
    }
    else if(port_addr === (this.ata_port | 3))
    {
        dbg_log("Read sector: " + h(this.sector & 0xFF), LOG_DISK);
        return this.sector & 0xFF;
    }
};

IDEDevice.prototype.read_data = function()
{
    if(this.data_pointer < this.pio_data.length)
    {
        if((this.data_pointer + 1) % (this.sectors_per_drq * 512) === 0 || 
            this.data_pointer + 1 === this.pio_data.length)
        {
            dbg_log("ATA IRQ", LOG_DISK);
            this.push_irq();
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
            var remaining = this.pio_data.length - this.data_pointer - 1;
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

        if(this.data_pointer + 1 >= this.pio_data.length)
        {
            this.status = 0x50;
            //this.bytecount = 3;
        }

        if((this.data_pointer + 1 & 255) === 0)
        {
            dbg_log("Read 1F0: " + h(this.pio_data[this.data_pointer], 2) + 
                        " cur=" + h(this.data_pointer) +
                        " cnt=" + h(this.pio_data.length), LOG_DISK);
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

IDEDevice.prototype.write_data_port = function(data, port_addr)
{
    if(port_addr === this.ata_port)
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
                this.data_port_callback();
            }
        }

    }
    else if(port_addr === (this.ata_port | 1))
    {
        dbg_log("1F1/lba_count: " + h(data), LOG_DISK);
        this.lba_count = (this.lba_count << 8 | data) & 0xFFFF;
    }
    else if(port_addr === (this.ata_port | 2))
    {
        dbg_log("1F2/bytecount: " + h(data), LOG_DISK);
        this.bytecount = (this.bytecount << 8 | data) & 0xFFFF;
    }
    else if(port_addr === (this.ata_port | 3))
    {
        dbg_log("1F3/sector: " + h(data), LOG_DISK);
        this.sector = (this.sector << 8 | data) & 0xFFFF;
    }
};

IDEDevice.prototype.ata_read_sectors = function(cmd)
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
    }

    var
        byte_count = count * this.sector_size,
        start = lba * this.sector_size;


    dbg_log("ATA read lba=" + h(lba) + 
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

        this.buffer.get(start, byte_count, function(data)
        {
            this.pio_data = data;
            this.status = 0x58;
            this.data_pointer = 0;

            this.push_irq();

            this.stats.sectors_read += byte_count / this.sector_size | 0;
            this.stats.bytes_read += byte_count;
        }.bind(this));
    }
};

IDEDevice.prototype.ata_read_sectors_dma = function(cmd)
{
    var count = this.bytecount & 0xff,
        lba = this.get_lba28();

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
    this.status = 0x80;
    this.dma_status |= 1;

    this.buffer.get(start, byte_count, function(data)
    {
        var prdt_start = this.prdt_addr,
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
        }
        while(!end);

        this.status = 0x50;
        this.dma_status &= ~2 & ~1;
        this.dma_status |= 4;

        this.push_irq();

        this.stats.sectors_read += byte_count / this.sector_size | 0;
        this.stats.bytes_read += byte_count;
    }.bind(this));
};

IDEDevice.prototype.ata_write = function(cmd)
{
    if(cmd === 0x30)
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
    }

    var byte_count = count * this.sector_size,
        start = lba * this.sector_size;


    dbg_log("ATA write lba=" + h(lba) + 
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    this.cylinder_low += count;

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_log("ATA write: Outside of disk", LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
    }
    else
    {
        this.status = 0x50;
        this.next_status = 0x58;

        this.allocate_in_buffer(byte_count);

        this.write_dest = start;
        this.data_port_callback = this.do_write;

        //this.bytecount = 1;
        this.push_irq();
    }
};

IDEDevice.prototype.ata_write_dma = function(cmd)
{
    var count = this.bytecount & 0xff,
        lba = this.get_lba28();

    var byte_count = count * this.sector_size,
        start = lba * this.sector_size;

    dbg_log("ATA DMA write lba=" + h(lba) + 
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    this.cylinder_low += count;

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_log("ATA DMA write: Outside of disk", LOG_DISK);

        this.status = 0xFF;
        this.push_irq();
        return;
    }

    //status = 0xFF & ~8;
    this.status = 0x80;
    this.dma_status |= 1;

    var prdt_start = this.prdt_addr,
        prdt_count = 0,
        prdt_write_count = 0,
        offset = 0;


    do {
        var prd_addr = this.memory.read32s(prdt_start),
            prd_count = this.memory.read16(prdt_start + 4),
            end = this.memory.read8(prdt_start + 7) & 0x80;

        if(!prd_count)
        {
            prd_count = 0x10000;
        }

        dbg_log("dma write dest=" + h(prd_addr) + " prd_count=" + h(prd_count), LOG_DISK);

        var slice = this.memory.mem8.subarray(prd_addr, prd_addr + prd_count);

        this.buffer.set(start + offset, slice, function()
        {
            prdt_write_count++;

            if(prdt_write_count === prdt_count)
            {
                dbg_log("dma write completed", LOG_DISK);
                this.status = 0x50;
                this.push_irq();
                this.dma_status &= ~2 & ~1;
                this.dma_status |= 4;
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
        this.dma_status &= ~2 & ~1;
        this.dma_status |= 4;
    }

    this.stats.sectors_written += byte_count / this.sector_size | 0;
    this.stats.bytes_written += byte_count;
};

IDEDevice.prototype.get_chs = function()
{
    var c = this.cylinder_low & 0xFF | this.cylinder_high << 8 & 0xFF00,
        h = this.head,
        s = this.sector & 0xFF;

    return (c * this.head_count + h) * this.sectors_per_track + s - 1;
};

IDEDevice.prototype.get_lba28 = function()
{
    return this.sector & 0xFF | this.cylinder_low << 8 & 0xFF00 | this.cylinder_high << 16 & 0xFF0000;
};

IDEDevice.prototype.get_lba48 = function()
{
    // Note: Bits over 32 missing
    return (this.sector & 0xFF | this.cylinder_low << 8 & 0xFF00 | this.cylinder_high << 16 & 0xFF0000 | 
            (this.sector >> 8) << 24 & 0xFF000000) >>> 0;
};

IDEDevice.prototype.create_identify_packet = function()
{
    this.data_pointer = 0;
    // http://bochs.sourceforge.net/cgi-bin/lxr/source/iodev/harddrv.cc#L2821

    if(this.drive_head & 0x10)
    {
        // slave
        this.pio_data = new Uint8Array(0);
        return;
    }

    this.pio_data = new Uint8Array([
        0x40, this.is_atapi ? 0x85 : 0, 
        // 1 cylinders
        this.cylinder_count, this.cylinder_count >> 8, 
        0, 0, 

        // 3 heads
        this.head_count, this.head_count >> 8, 
        0, 0,
        // 5
        0, 0, 
        // sectors per track
        this.sectors_per_track, 0, 
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
        32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 
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

    if(this.cylinder_count > 16383)
    {
        this.pio_data[2] = this.pio_data[108] = 16383 & 0xFF;
        this.pio_data[3] = this.pio_data[109] = 16383 >> 8;
    }
};

IDEDevice.prototype.dma_read_addr0 = function()
{
    return this.prdt_addr & 0xFF;
};
IDEDevice.prototype.dma_read_addr1 = function()
{
    return this.prdt_addr >> 8 & 0xFF;
};
IDEDevice.prototype.dma_read_addr2 = function()
{
    return this.prdt_addr >> 16 & 0xFF;
};
IDEDevice.prototype.dma_read_addr3 = function()
{
    return this.prdt_addr >> 24 & 0xFF;
};

IDEDevice.prototype.dma_set_addr0 = function(data)
{
    this.prdt_addr = this.prdt_addr & ~0xFF | data;
};
IDEDevice.prototype.dma_set_addr1 = function(data)
{
    this.prdt_addr = this.prdt_addr & ~0xFF00 | data << 8;
};
IDEDevice.prototype.dma_set_addr2 = function(data)
{
    this.prdt_addr = this.prdt_addr & ~0xFF0000 | data << 16;
};
IDEDevice.prototype.dma_set_addr3 = function(data)
{
    this.prdt_addr = this.prdt_addr & 0xFFFFFF | data << 24;
    dbg_log("Set PRDT addr: " + h(this.prdt_addr), LOG_DISK);
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
    return 1;
};

IDEDevice.prototype.dma_write_command = function(value)
{
    dbg_log("DMA write command: " + h(value), LOG_DISK);

    if(value & 1)
    {
        this.push_irq();
    }
};

