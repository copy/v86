"use strict";


var 
    /** @const */
    CDROM_SECTOR_SIZE = 2048,
    /** @const */
    HD_SECTOR_SIZE = 512;


/** @constructor */
function CDRom(dev, cd_buffer)
{
    this.io = dev.io;
    this.memory = dev.memory;
    this.pic = dev.pic;
    this.pci = dev.pci;

    this.vendor_id = 0x1002;
    this.class_revision = 0x106 << 16 | 0x01 << 8;
    this.irq = 14;
    this.iobase = 0xFFF10000;
    this.sector_size = CDROM_SECTOR_SIZE;
    this.buffer = cd_buffer;
    this.atapi = true;
    this.pci_id = 8;

    this.init();
}
CDRom.prototype = new AHCIDevice();

/** @constructor */
function HDD(dev, disk_buffer, nr)
{
    var port = nr === 0 ? 0x1F0 : 0x170,
        irq = nr === 0 ? 14 : 15;

    var pic = dev.pic;

    this.io = dev.io;
    this.memory = dev.memory;
    this.pic = dev.pic;
    this.pci = dev.pci;

    this.vendor_id = 0x1002;
    this.class_revision = 0x106 << 16 | 0x01 << 8;
    this.irq = irq;
    this.iobase = 0xFFF00000;
    this.sector_size = HD_SECTOR_SIZE;
    this.sector_count = disk_buffer.byteLength / this.sector_size;
    this.buffer = disk_buffer;
    this.atapi = false;
    this.pci_id = 0x10;

    this.head_count = 16;
    this.sectors_per_track = 63;

    this.cylinder_count = disk_buffer.byteLength / 
        this.head_count / (this.sectors_per_track + 1) / this.sector_size;

    dbg_assert(this.cylinder_count === (this.cylinder_count | 0));
    dbg_assert(this.cylinder_count <= 16383);

    var me = this;

    // status
    this.io.register_read(port | 7, read_status);

    // alternate status, starting at 3f6/376
    this.io.register_read(port | 0x206, read_status);

    function read_status()
    {
        dbg_log("ATA read status", LOG_DISK);

        var status = 0x50;

        if(data_pointer < pio_data.length)
            status |= 8;

        return status;
    }

    var last_drive = 0xFF,
        data_pointer = 0,
        pio_data = [],
        drq = false,
        is_lba = 0,
        slave = 0,
        bytecount = 0,
        sector = 0,
        cylinder = 0,
        head = 0;


    function push_irq()
    {
        pic.push_irq(me.irq);
    }

    this.io.register_write(port | 6, function(data)
    {
        dbg_log("1F6 write " + h(data), LOG_DISK);

        var slave = data & 0x10,
            mode = data & 0xE0,
            low = data & 0xF;


        if(slave)
        {
            //drq = false;
            return;
        }

        is_lba = data >> 6 & 1;
        head = data & 0xF;
        last_drive = data;
    });

    this.io.register_write(port | 2, function(data)
    {
        dbg_log("1F2 write: " + data, LOG_DISK);
        if(data)
        {
            bytecount = data << 9;
        }
        else
        {
            bytecount = 256 << 9;
        }
        //bytecount = 1 << 9;
    });
    this.io.register_write(port | 3, function(data)
    {
        sector = data;
    });
    this.io.register_write(port | 4, function(data)
    {
        cylinder = cylinder & 0xFF00 | data;
    });
    this.io.register_write(port | 5, function(data)
    {
        cylinder = cylinder & 0xFF | data << 8;
    });

    this.io.register_write(port | 7, function(cmd)
    {
        if(cmd === 0xEC)
        {
            dbg_log("ATA identify device", LOG_DISK);
            // identify device
            // http://bochs.sourceforge.net/cgi-bin/lxr/source/iodev/harddrv.cc#L2821

            data_pointer = 0;

            pio_data = new Uint8Array([
                0x40, 0, 
                // 1 cylinders
                me.cylinder_count, me.cylinder_count >> 8, 
                0, 0, 
        
                // 3 heads
                me.head_count, me.head_count >> 8, 
                0, 0,
                // 5
                0, 0, 
                // sectors per track
                me.sectors_per_track, 0, 
                0, 0, 0, 0, 0, 0,
                // 10-19 serial number
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 15
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 20
                3, 0, 0, 2, 4, 0, 
                // 23-26 firmware revision
                0, 0, 0, 0, 0, 0, 0, 0, 

                // 27 model number
                32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 
                32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,

                // 47
                0, 0, 
                1, 0, 
                0, 3,  // capabilities
                // 50
                0, 0, 
                0, 2, 
                0, 2, 
                7, 0, 

                // 54 cylinders
                me.cylinder_count, me.cylinder_count >> 8, 
                // 55 heads
                me.head_count, me.head_count >> 8, 
                // 56 sectors per track
                me.sectors_per_track, 0, 
                // capacity in sectors
                this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF, 
                this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF, 
                
                0, 0,
                // 60
                this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF, 
                this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF, 
                
                0, 0, 0, 0, 0, 0,
                // 65
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 70
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 75
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 80
                0x7E, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 85
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 90
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 95
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                // 100
                this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF, 
                this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF, 
                

            ]);

            push_irq();
        }
        else if(cmd === 0x91)
        {
            dbg_log("ATA cmd 91", LOG_DISK);
            push_irq();
        }
        else if(cmd === 0x10)
        {
            // obsolete
            dbg_log("ATA cmd 10", LOG_DISK);
            push_irq();
        }
        else if(cmd = 0x27)
        {
            // READ NATIVE MAX ADDRESS EXT - read the actual size of the HD
            // https://en.wikipedia.org/wiki/Host_protected_area
            dbg_log("ATA cmd 27", LOG_DISK);
            push_irq();
            pio_data = [
                0, 0, // error
                0, 0, // count

                // result
                disk_buffer.byteLength & 0xff,
                disk_buffer.byteLength >> 8 & 0xff,
                disk_buffer.byteLength >> 16 & 0xff,
                disk_buffer.byteLength >> 24 & 0xff,
                0, 0,

                0, 0, //
            ];
        }
        else if(cmd === 0x20)
        {
            if(DEBUG && is_lba)
                throw "unimplemented";

            var lba = (cylinder * me.head_count + head) * me.sectors_per_track + sector - 1;
            dbg_log("ATA read: from=" + h(lba * me.sector_size) + " chs=" + cylinder + "/" + head + "/" + sector + " length=" + h(bytecount), LOG_DISK);

            me.buffer.get(lba * me.sector_size, bytecount, function(data)
            {
                data_pointer = 0;
                pio_data = data;

                push_irq();
            });
        }
        else
        {
            dbg_log("New ATA cmd on 1F7: " + h(cmd), LOG_DISK);
        }
    });

    this.io.register_read(port | 0, function()
    {
        if(data_pointer < pio_data.length)
        {
            dbg_log("Read 1F0: " + h(pio_data[data_pointer], 2), LOG_DISK);

            if((data_pointer & 511)  === 0)
                push_irq();

            return pio_data[data_pointer++] & 0xFF;
        }
        else
        {
            dbg_log("Read 1F0: empty", LOG_DISK);
            return 0;
        }
    });


    this.io.register_read(port | 1, function()
    {
        dbg_log("Read 1F1", LOG_DISK);
        return 0xFF;
    });

    this.io.register_read(port | 2, function()
    {
        dbg_log("Read 1F2", LOG_DISK);
        return 0xFF;
    });


    this.io.register_read(port | 3, function()
    {
        dbg_log("Read 1F3", LOG_DISK);
        return 0xFF;
    });

    this.io.register_read(port | 6, function()
    {
        dbg_log("Read 1F6", LOG_DISK);
        return last_drive;
    });

    this.init();
}
HDD.prototype = new AHCIDevice();


/** @constructor */
function AHCIDevice()
{
    var me,
        memory;

    this.init = function()
    {
        me = this;
        memory = this.memory;

        this.pci.register_device(this, this.pci_id);

        this.memory.mmap_register(this.iobase, 0x4000, true, mmio_read, mmio_write);

    };

    var host_ctl = 0,
        host_caps = 1,
        host_ports_impl = 1,
        host_intbits = 1,
        port_lst_addr,
        port_fis_addr;

    function atapi_command_read(atapi, dest, byte_len)
    {
        var lba = Math.to_be32(memory.read32s(atapi + 2)),
            count = Math.to_be16(memory.read16(atapi + 7)),
            flags = memory.read8(atapi + 1),

            //bytecount = Math.min(count * me.sector_size, byte_len + 1);
            bytecount = count * me.sector_size;

        dbg_log("CD read lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytelen=" + h(byte_len) +
                " copycount=" + h(bytecount) +
                " flags=" + h(flags) +
                " buf=" + h(dest, 8), LOG_CD);

        me.buffer.get(lba * me.sector_size, bytecount, function(data)
        {
            memory.write_blob(data, dest);
        });

        //pic.push_irq(me.irq);
    }

    function ata_command_rw(cmd_fis, dest, is_read)
    {
        var lba = memory.read32s(cmd_fis + 4) & 0xFFFFFF,
            count = memory.read16(cmd_fis + 12),
            bytecount = count * me.sector_size;

        dbg_log("ahci " + (is_read ? "read" : "write") + ": lba=" + h(lba, 8) +
                " count=" + h(count, 4) +
                " dest=" + h(dest, 8));

        if(is_read)
        {
            this.buffer.get(lba * me.sector_size, bytecount, function(data)
            {
                memory.write_blob(data, dest);
            });
        }
        else
        {
            this.buffer.set(lba * me.sector_size, 
                new Uint8Array(memory.buffer, dest, bytecount), 
                function()
                {
                });
        }
    }


    function mmio_read(addr)
    {
        switch(addr)
        {
            case 0: 
                return host_caps;

            case 4: 
                return host_ctl;

            case 0xC:
                return host_ports_impl;

            case 0x128:
                return 0x03;

            case 0x110:
                return host_intbits;

            default: 
                dbg_log("New PCI mmio read from " + h(addr, 8), LOG_CD);
        }
    }

    function mmio_write(addr, value)
    {
        switch(addr)
        {
            case 0x100:
                port_lst_addr = value;
                dbg_log("lst at " + h(value, 8), LOG_CD);
                break;
            case 0x108:
                port_fis_addr = value;
                dbg_log("fis at " + h(value, 8), LOG_CD);
                break;

            case 0x118:
                dbg_log("port cmd: " + h(value, 8), LOG_CD);
                break;

            case 0x138:
                var 
                    
                    ctba_addr = memory.read32s(port_lst_addr + 8),

                    first_prdt_start = ctba_addr + 0x80,
                    flags = memory.read16(port_lst_addr),
                    prdt_addr = memory.read32s(first_prdt_start) + 0x100000000 * memory.read32s(first_prdt_start + 4),
                    prdt_len = memory.read32s(ctba_addr + 0x80 + 0xC) & 0xFFF,
                    atapi_command = memory.read8(ctba_addr + 0x40),
                    fis_command = memory.read8(ctba_addr + 2),

                    dma_fis_start = port_fis_addr + 0,
                    pio_fis_start = port_fis_addr + 0x20,
                    d2h_fis_start = port_fis_addr + 0x40,
                    ufis_start = port_fis_addr + 0x60,

                    command_fis_start = ctba_addr + 0,
                    atapi_command_start = ctba_addr + 0x40;

                if((fis_command === 0xA0 || fis_command === 0xA1) &&
                        !me.atapi)
                {
                    return;
                }

                // status success
                memory.write8(d2h_fis_start + 2, 0x40);

                dbg_log("ctba at " + h(ctba_addr), LOG_CD);
                dbg_log("prdt at " + h(prdt_addr), LOG_CD);
                dbg_log("flags: " + h(flags, 2), LOG_CD);
                dbg_log("cmd fis command: " + h(fis_command, 2), LOG_CD);

                dbg_log("fis LBA=" + h(memory.read32s(command_fis_start + 4) & 0xffffff), LOG_CD);

                dbg_log("Prdts count: " + h(memory.read16(port_lst_addr + 2)), LOG_CD);
                dbg_log("PRD byte count: " + h(memory.read32s(port_lst_addr + 4)), LOG_CD);

                dbg_log("First prdt byte count: " + h(memory.read32s(ctba_addr + 0x80 + 0xC)), LOG_CD);

                if(fis_command === 0xC8 || fis_command === 0xCA)
                {
                    ata_command_rw(command_fis_start, prdt_addr, fis_command === 0xC8);
                }
                else if(fis_command === 0xEC)
                {
                    // ATA_CMD_IDENTIFY_DEVICE

                    // number of sectors
                    memory.write32(prdt_addr + 120, me.buffer.byteLength / me.sector_size);
                }
                else if(fis_command === 0xA1)
                {
                    // ATA_CMD_IDENTIFY_PACKET_DEVICE

                    // is CD
                    memory.write32(prdt_addr, 0x0500);
                }
                else if(fis_command === 0xA0)
                {
                    // ATA_CMD_PACKET
                    if(atapi_command === 0x28)
                    {
                        atapi_command_read(ctba_addr + 0x40, prdt_addr, prdt_len);
                    }
                    else if(atapi_command === 0x2a)
                    {
                        // write
                        dbg_log("atapi - unimplemented write", LOG_CD);
                    }
                    else if(atapi_command === 0x25)
                    {
                        // read capacity
                        dbg_log("atapi - unimplemented read cap", LOG_CD);
                    }
                    else
                    {
                        dbg_log("atapi - unimplemented " + h(atapi_command, 2), LOG_CD);
                    }
                }
                else 
                {
                    dbg_log("unimplemented fis command: " + h(fis_command, 2));
                }

                break;

            default: 
                dbg_log("PCI mmio write addr=" + h(addr, 8) + " value=" + h(value, 8), LOG_CD);
        }
    }
}

