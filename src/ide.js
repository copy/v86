"use strict";


var 
    /** @const */
    CDROM_SECTOR_SIZE = 2048,
    /** @const */
    HD_SECTOR_SIZE = 512;


/** @constructor */
function IDEDevice(dev, buffer, is_cd, nr)
{
    var pic = dev.pic,
        me = this;

    if(nr === 0)
    {
        this.ata_port = 0x1F0;
        this.irq = 14;
    }
    else
    {
        this.ata_port = 0x170;
        this.irq = 15;
    }

    // alternate status, starting at 3f4/374
    this.ata_port_high = this.ata_port | 0x204;

    this.io = dev.io;
    this.memory = dev.memory;
    this.pic = dev.pic;
    this.pci = dev.pci;

    this.sector_size = is_cd ? CDROM_SECTOR_SIZE : HD_SECTOR_SIZE;
    this.buffer = buffer;
    this.is_atapi = is_cd;

    this.sector_count = me.buffer.byteLength / this.sector_size;

    if(is_cd)
    {
        this.head_count = 1;
        this.sectors_per_track = 0;
    }
    else
    {
        this.head_count = 1;
        this.sectors_per_track = 63;
    }

    this.cylinder_count = me.buffer.byteLength / 
        this.head_count / (this.sectors_per_track + 1) / this.sector_size;

    dbg_assert(this.cylinder_count === (this.cylinder_count | 0));

    function push_irq()
    {
        if((device_control & 2) === 0)
        {
            pic.push_irq(me.irq);
        }
    }

    // 00:1f.2 IDE interface: Intel Corporation 82801JI (ICH10 Family) 4 port SATA IDE Controller #1
        //0x86, 0x80, 0x20, 0x3a, 0x05, 0x00, 0xb0, 0x02, 0x00, 0x8f, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        //0x01, 0x90, 0x00, 0x00, 0x01, 0x8c, 0x00, 0x00, 0x81, 0x88, 0x00, 0x00, 0x01, 0x88, 0x00, 0x00,
        //0x81, 0x84, 0x00, 0x00, 0x01, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x43, 0x10, 0xd4, 0x82,
        //0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x02, 0x00, 0x00,
    dev.pci.register_device([
        0x86, 0x80, 0x20, 0x3a, 0x05, 0x00, 0xa0, 0x02, 0x00, 0x8f, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        this.ata_port & 0xFF | 1, this.ata_port >> 8, 0x00, 0x00, 
        this.ata_port_high & 0xFF | 1, this.ata_port_high >> 8, 0x00, 0x00, 
        0x00, 0x00, 0x00, 0x00, 
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 
        0x00, 0x00, 0x00, 0x00, 
        0x00, 0x00, 0x00, 0x00, 
        0x43, 0x10, 0xd4, 0x82,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, this.irq, 0x02, 0x00, 0x00,
    ], 0x1f << 3);

    // status
    this.io.register_read(this.ata_port | 7, read_status);
    this.io.register_read(this.ata_port_high | 2, read_status);

    this.io.register_write(this.ata_port | 7, write_control);
    this.io.register_write(this.ata_port_high | 2, write_control);

    var device_control = 2,
        last_drive = 0xFF,
        data_pointer = 0,
        pio_data = [],
        is_lba = 0,
        slave = 0,
        bytecount = 0,
        sector = 0,
        lba_count = 0,
        cylinder_low = 0,
        cylinder_high = 0,
        head = 0,
        drive_head = 0,
        status = 0x50,
        sectors_per_drq = 1,
        atapi_command = [];


    function read_status()
    {
        dbg_log("ATA read status: " + h(status), LOG_DISK);
        return status;
    }

    function write_control(data)
    {
        dbg_log("device control: " + h(data), LOG_DISK);
        device_control = data;

        if(data & 4)
        {
            // reset
            if(me.is_atapi)
            {
                status = 1;
                bytecount = 1;
                sector = 1; // lba_low
                cylinder_low = 0x14; // lba_mid
                cylinder_high = 0xeb; // lba_high
            }
            else
            {
                status = 1;
                bytecount = 1;
                sector = 1; // lba_low
                cylinder_low = 0x3c; // lba_mid
                cylinder_high = 0xc3; // lba_high
            }
        }
    }

    function atapi_read(cmd)
    {
        // Note: Big Endian
        var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5],
            count = cmd[7] << 8 | cmd[8], 
            flags = cmd[1],
            bytecount = count * me.sector_size,
            transfered_ata_blocks = Math.min(bytecount / 512, cylinder_low << 8 | cylinder_high),
            byte_count = count * me.sector_size,
            start = lba * me.sector_size;

        dbg_log("CD read lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytecount=" + h(byte_count) +
                " flags=" + h(flags), LOG_CD);


        cylinder_low = transfered_ata_blocks >> 8;
        cylinder_high = transfered_ata_blocks;

        if(start + byte_count > buffer.byteLength)
        {
            dbg_log("CD read: Outside of disk", LOG_DISK);

            status = 0xFF;
            push_irq();
        }
        else
        {
            status = 0xFF;

            me.buffer.get(start, byte_count, function(data)
            {
                pio_data = data;
                status = 0x58;
                data_pointer = 0;
                push_irq();
            });
        }
    }

    function read_data_port(port_addr)
    {
        if(port_addr === me.ata_port)
        {
            if(data_pointer < pio_data.length)
            {
                if((data_pointer + 1)  % (sectors_per_drq * 512) === 0 || 
                    data_pointer + 1 === pio_data.length)
                {
                    if(data_pointer + 1 === pio_data.length)
                    {
                        status = 0x50;
                        bytecount = 3;
                    }

                    dbg_log("ATA IRQ", LOG_DISK);
                    push_irq();
                }

                if((data_pointer + 1 & 255) === 0)
                {
                    dbg_log("Read 1F0: " + h(pio_data[data_pointer], 2) + 
                                " cur=" + h(data_pointer) +
                                " cnt=" + h(pio_data.length), LOG_DISK);
                }

                return pio_data[data_pointer++] & 0xFF;
            }
            else
            {
                //if((data_pointer + 1 & 255) === 0)
                {
                    dbg_log("Read 1F0: empty", LOG_DISK);
                }
                data_pointer++;
                return 0;
            }
        }
        else if(port_addr === (me.ata_port | 1))
        {
            dbg_log("Read lba_count", LOG_DISK);
            return lba_count;
        }
        else if(port_addr === (me.ata_port | 2))
        {
            dbg_log("Read bytecount: " + h(bytecount & 0xFF), LOG_DISK);
            return bytecount & 0xFF;
        }
        else if(port_addr === (me.ata_port | 3))
        {
            dbg_log("Read sector", LOG_DISK);
            return sector & 0xFF;
        }
    }
    this.io.register_read(me.ata_port | 0, read_data_port);
    this.io.register_read(me.ata_port | 1, read_data_port);
    this.io.register_read(me.ata_port | 2, read_data_port);
    this.io.register_read(me.ata_port | 3, read_data_port);

    this.io.register_read(me.ata_port | 4, function()
    {
        dbg_log("Read 1F4: " + h(cylinder_low & 0xFF), LOG_DISK);
        return cylinder_low & 0xFF;
    });
    this.io.register_read(me.ata_port | 5, function(port)
    {
        dbg_log("Read 1F5: " + h(cylinder_high & 0xFF), LOG_DISK);
        return cylinder_high & 0xFF;
    });
    this.io.register_read(me.ata_port | 6, function()
    {
        dbg_log("Read 1F6", LOG_DISK);
        return drive_head;
    });

    function write_data_port(data, port_addr)
    {
        if(port_addr === me.ata_port)
        {
            atapi_command.push(data);

            if(atapi_command.length === 12)
            {

                dbg_log("ATAPI Command: " + h(atapi_command[0]), LOG_DISK);
                dbg_log(atapi_command.join(","), LOG_DISK);

                bytecount = 2;
                
                switch(atapi_command[0])
                {
                    case 0:
                        status = 0x50;
                        //pio_data = new Uint8Array(512);
                        //data_pointer = 0;
                        push_irq();
                        break;
                    case 0x28:
                        // read
                        atapi_read(atapi_command);
                        break;
                    case 0x5A:
                        // mode sense
                        push_irq();
                        status = 0x50;
                        break;
                    case 0x25:
                        // read capacity
                        pio_data = new Uint8Array([
                            me.sector_count >> 24 & 0xff,
                            me.sector_count >> 16 & 0xff,
                            me.sector_count >> 8 & 0xff,
                            me.sector_count & 0xff,
                            0,
                            0,
                            me.sector_size >> 8 & 0xff,
                            me.sector_size & 0xff,
                        ]);
                        status = 0x58;

                        data_pointer = 0;

                        bytecount = 2;
                        cylinder_low = 8;
                        cylinder_high = 0;

                        push_irq();
                        break;
                    case 0x43:
                        // read header
                        pio_data = new Uint8Array(Math.min(atapi_command[8], 4));
                        status = 0x58;
                        data_pointer = 0;
                        bytecount = 2;
                        push_irq();
                        break;
                    case 0x46:
                        // get configuration
                        pio_data = new Uint8Array(atapi_command[8] | atapi_command[7] << 8);
                        status = 0x58;
                        data_pointer = 0;
                        bytecount = 2;
                        push_irq();
                        break;
                    case 0x46:
                        // prevent/allow medium removal
                        pio_data = [];
                        status = 0x50;
                        data_pointer = 0;
                        bytecount = 2;
                        push_irq();
                        break;
                    case 0x51:
                        // read disk information
                        pio_data = new Uint8Array(0);
                        status = 0x50;
                        data_pointer = 0;
                        bytecount = 2;
                        push_irq();
                        break;
                    case 0x12:
                        // inquiry
                        pio_data = new Uint8Array(Math.min(atapi_command[4], 35));
                        status = 0x58;

                        pio_data[0] = 5;
                        pio_data[1] = 0x80;
                        pio_data[3] = 1;
                        pio_data[4] = 0x31;

                        data_pointer = 0;
                        bytecount = 2;
                        push_irq();
                        break;
                    default:
                        status = 0x50;
                        dbg_log("Unimplemented ATAPI command: " + h(atapi_command[0]), LOG_DISK);
                }

                atapi_command = [];
            }
        }
        else if(port_addr === (me.ata_port | 1))
        {
            dbg_log("1f1/lba_count: " + h(data), LOG_DISK);
            lba_count = (lba_count << 8 | data) & 0xFFFF;
        }
        else if(port_addr === (me.ata_port | 2))
        {
            dbg_log("1f2/bytecount: " + h(data), LOG_DISK);
            bytecount = (bytecount << 8 | data) & 0xFFFF;
        }
        else if(port_addr === (me.ata_port | 3))
        {
            dbg_log("1f3/sector: " + h(data), LOG_DISK);
            sector = (sector << 8 | data) & 0xFFFF;
        }
    }
    this.io.register_write(me.ata_port | 0, write_data_port);
    this.io.register_write(me.ata_port | 1, write_data_port);
    this.io.register_write(me.ata_port | 2, write_data_port);
    this.io.register_write(me.ata_port | 3, write_data_port);

    this.io.register_write(me.ata_port | 4, function(data)
    {
        dbg_log("sector low: " + h(data), LOG_DISK);
        cylinder_low = (cylinder_low << 8 | data) & 0xFFFF;
    });
    this.io.register_write(me.ata_port | 5, function(data)
    {
        dbg_log("sector high: " + h(data), LOG_DISK);
        cylinder_high = (cylinder_high << 8 | data) & 0xFFFF;
    });
    this.io.register_write(me.ata_port | 6, function(data)
    {
        var slave = data & 0x10,
            mode = data & 0xE0,
            low = data & 0xF;

        dbg_log("1F6: " + h(data, 2), LOG_DISK);

        if(slave)
        {
            return;
        }

        drive_head = data;
        is_lba = data >> 6 & 1;
        head = data & 0xF;
        last_drive = data;

    });

    this.io.register_write(me.ata_port | 7, function(cmd)
    {
        dbg_log("ATA Command: " + h(cmd), LOG_DISK);

        if(cmd === 0x08)
        {
            dbg_log("ATA device reset", LOG_DISK);
            data_pointer = 0;
            pio_data = [];
            status = 0x50;

            push_irq();
        }
        else if(cmd === 0xE1)
        {
            dbg_log("ATA idle immediate", LOG_DISK);
            push_irq();
        }
        else if(cmd === 0xA1)
        {
            dbg_log("ATA identify packet device", LOG_DISK);

            if(me.is_atapi)
            {
                data_pointer = 0;
                pio_data = new Uint8Array(512);
                
                pio_data[0] = 0x40;
                pio_data[1] = 0x05 | me.is_atapi << 7;
                status = 0x58;

                push_irq();
            }
            else
            {
                status = 0x50;
                push_irq();
            }
        }
        else if(cmd === 0xEC)
        {
            dbg_log("ATA identify device", LOG_DISK);
            // identify device
            // http://bochs.sourceforge.net/cgi-bin/lxr/source/iodev/harddrv.cc#L2821

            if(me.is_atapi)
            {
                return;
            }

            data_pointer = 0;

            pio_data = new Uint8Array(512);

            pio_data.set([
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
                me.sector_count & 0xFF, me.sector_count >> 8 & 0xFF, 
                me.sector_count >> 16 & 0xFF, me.sector_count >> 24 & 0xFF, 
                
                0, 0,
                // 60
                me.sector_count & 0xFF, me.sector_count >> 8 & 0xFF, 
                me.sector_count >> 16 & 0xFF, me.sector_count >> 24 & 0xFF, 
                
                0, 0, 0, 0, 0, 0,
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
                me.sector_count & 0xFF, me.sector_count >> 8 & 0xFF, 
                me.sector_count >> 16 & 0xFF, me.sector_count >> 24 & 0xFF, 
                

            ]);

            if(me.cylinder_count > 16383)
            {
                pio_data[2] = pio_data[108] = 16383 & 0xFF;
                pio_data[3] = pio_data[109] = 16383 >> 8;
            }

            status = 0x58;

            push_irq();
        }
        else if(cmd === 0x20 || cmd === 0x29 || cmd === 0x24)
        {
            // 0x20 read sectors
            // 0x24 read sectors ext
            // 0x29 read multiple ext

            if(cmd === 0x20)
            {
                var count = bytecount & 0xff,
                    lba = (cylinder_high << 16 & 0xff0000 | cylinder_low << 8 & 0xff00 | sector & 0xff) >>> 0;
            }
            else
            {
                var count = bytecount,
                    lba = (cylinder_high << 16 | cylinder_low) >>> 0;
            }

            var
                byte_count = count * me.sector_size,
                start = lba * me.sector_size;


            dbg_log("ATA read lba=" + h(lba) + 
                    " lbacount=" + h(count) +
                    " bytecount=" + h(byte_count), LOG_DISK);

            cylinder_low += count;

            if(start + byte_count > buffer.byteLength)
            {
                dbg_log("ATA read: Outside of disk", LOG_DISK);

                status = 0xFF;
                push_irq();
            }
            else
            {
                status = 0xFF;

                me.buffer.get(start, byte_count, function(data)
                {
                    pio_data = data;
                    status = 0x58;
                    data_pointer = 0;

                    push_irq();
                });
            }
        }
        else if(cmd === 0xEA)
        {
            //  FLUSH CACHE EXT
            dbg_log("ATA cmd EA", LOG_DISK);

            push_irq();
        }
        else if(cmd === 0x91)
        {
            // INITIALIZE DEVICE PARAMETERS
            dbg_log("ATA cmd 91", LOG_DISK);

            push_irq();
        }
        else if(cmd === 0x10)
        {
            // obsolete
            dbg_log("ATA cmd 10", LOG_DISK);

            push_irq();
        }
        else if(cmd === 0xC6)
        {
            // SET MULTIPLE MODE
            dbg_log("ATA cmd C6", LOG_DISK);

            // Logical sectors per DRQ Block in word 1
            dbg_log("Logical sectors per DRQ Block: " + h(bytecount), LOG_DISK);
            sectors_per_drq = bytecount;

            push_irq();
        }
        else if(cmd === 0xEF)
        {
            // SET FEATURES
            dbg_log("ATA cmd EF", LOG_DISK);

            push_irq();
        }
        else if(cmd === 0x27)
        {
            // READ NATIVE MAX ADDRESS EXT - read the actual size of the HD
            // https://en.wikipedia.org/wiki/Host_protected_area
            dbg_log("ATA cmd 27", LOG_DISK);
            push_irq();
            pio_data = [
                0, 0, // error
                0, 0, // count

                // result
                me.buffer.byteLength & 0xff,
                me.buffer.byteLength >> 8 & 0xff,
                me.buffer.byteLength >> 16 & 0xff,
                me.buffer.byteLength >> 24 & 0xff,
                0, 0,

                0, 0, //
            ];
            status = 0x58;
        }
        else if(cmd === 0xA0)
        {
            if(me.is_atapi)
            {
                // ATA_CMD_PACKET
                status = 0x58;
                atapi_command = [];
                bytecount = 1;
                push_irq();
            }
        }
        else
        {
            dbg_log("New ATA cmd on 1F7: " + h(cmd), LOG_DISK);
        }
    });
}
