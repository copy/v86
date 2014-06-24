"use strict";


var 
    /** @const */
    CDROM_SECTOR_SIZE = 2048,
    /** @const */
    HD_SECTOR_SIZE = 512;


/** @constructor */
function IDEDevice(cpu, buffer, is_cd, nr)
{
    var pic = cpu.devices.pic,
        memory = cpu.memory,
        me = this;

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

    this.io = cpu.io;
    this.pic = cpu.devices.pic;
    this.pci = cpu.devices.pci;

    this.sector_size = is_cd ? CDROM_SECTOR_SIZE : HD_SECTOR_SIZE;
    this.buffer = buffer;
    this.is_atapi = is_cd;

    if(buffer)
    {
        this.sector_count = me.buffer.byteLength / this.sector_size;

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
            this.head_count = 1;
            this.sectors_per_track = 63;
        }

        this.cylinder_count = me.buffer.byteLength / 
            this.head_count / (this.sectors_per_track + 1) / this.sector_size;

        if(this.cylinder_count !== (this.cylinder_count | 0))
        {
            dbg_log("Warning: Rounding up cylinder count. Choose different sector per track", LOG_DISK);
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

    function push_irq()
    {
        if((device_control & 2) === 0)
        {
            dbg_log("push irq", LOG_DISK);

            dma_status |= 4;
            pic.push_irq(me.irq);
        }
    }

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
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, this.irq, 0x00, 0x00, 0x00,
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
    this.io.register_read(this.ata_port | 7, read_status);
    this.io.register_read(this.ata_port_high | 2, read_status);

    this.io.register_write(this.ata_port | 7, write_control);
    this.io.register_write(this.ata_port_high | 2, write_control);

    var device_control = 2,
        last_drive = 0xFF,
        data_pointer = 0,
        pio_data = new Uint8Array(0),
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

        write_dest,

        data_port_count = 0,
        data_port_current = 0,
        data_port_buffer = [],
        data_port_callback;


    function atapi_handle()
    {
        dbg_log("ATAPI Command: " + h(data_port_buffer[0]), LOG_DISK);

        bytecount = 2;
        
        switch(data_port_buffer[0])
        {
            case 0x00:
                status = 0x50;
                //pio_data = new Uint8Array(512);
                //data_pointer = 0;
                push_irq();
                break;

            case 0x03:
                // request sense
                pio_data = new Uint8Array(Math.min(data_port_buffer[4], 15));
                status = 0x58;

                pio_data[0] = 0x80 | 0x70;
                pio_data[7] = 8;

                data_pointer = 0;
                bytecount = 2;
                cylinder_low = 8;
                cylinder_high = 0;

                push_irq();
                break;

            case 0x12:
                // inquiry
                pio_data = new Uint8Array(Math.min(data_port_buffer[4], 35));
                status = 0x58;

                pio_data[0] = 5;
                pio_data[1] = 0x80;
                pio_data[3] = 1;
                pio_data[4] = 0x31;

                data_pointer = 0;
                bytecount = 2;
                push_irq();
                break;

            case 0x1E:
                // prevent/allow medium removal
                pio_data = new Uint8Array(0);
                status = 0x50;
                data_pointer = 0;
                bytecount = 2;
                push_irq();
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

            case 0x28:
                // read
                if(lba_count & 1)
                {
                    atapi_read_dma(data_port_buffer);
                }
                else
                {
                    atapi_read(data_port_buffer);
                }
                break;

            case 0x43:
                // read header
                pio_data = new Uint8Array(2048);
                pio_data[0] = 0;
                pio_data[1] = 10;
                pio_data[2] = 1;
                pio_data[3] = 1;
                status = 0x58;
                data_pointer = 0;
                bytecount = 2;
                cylinder_high = 8;
                cylinder_low = 0;
                push_irq();
                break;

            case 0x46:
                // get configuration
                pio_data = new Uint8Array(data_port_buffer[8] | data_port_buffer[7] << 8);
                status = 0x58;
                data_pointer = 0;
                bytecount = 2;
                push_irq();
                break;

            case 0x4A:
                // get event status notification
                pio_data = new Uint8Array(data_port_buffer[8] | data_port_buffer[7] << 8);
                status = 0x58;
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

            case 0x5A:
                // mode sense
                push_irq();
                status = 0x50;
                break;

            default:
                status = 0x50;
                dbg_log("Unimplemented ATAPI command: " + h(data_port_buffer[0]), LOG_DISK);
        }
    }

    function do_write()
    {
        status = 0x50;

        me.buffer.set(write_dest, data_port_buffer, function()
        {
            push_irq();
        });

        me.stats.sectors_written += data_port_buffer.length / me.sector_size | 0;
        me.stats.bytes_written += data_port_buffer.length;
    }

    var next_status = -1;

    function read_status()
    {
        var ret = status;
        dbg_log("ATA read status: " + h(status), LOG_DISK);

        if(next_status >= 0)
        {
            status = next_status;
            next_status = -1;
        }

        return ret;
    }

    function write_control(data, port)
    {
        dbg_log("device control: " + h(data) + " port=" + h(port), LOG_DISK);
        device_control = data;

        if(data & 4)
        {
            // reset
            if(me.is_atapi)
            {
                status = 0x50 | 1;
                bytecount = 1;
                sector = 1; // lba_low
                cylinder_low = 0x14; // lba_mid
                cylinder_high = 0xeb; // lba_high
            }
            else
            {
                status = 0x50 | 1;
                bytecount = 1;
                sector = 1; // lba_low
                cylinder_low = 0x3c; // lba_mid
                cylinder_high = 0xc3; // lba_high
            }
        }
    }

    function allocate_in_buffer(size)
    {
        // reuse old buffer if it's smaller or the same size
        if(size > data_port_buffer.length)
        {
            data_port_buffer = new Uint8Array(size);
        }

        data_port_count = size;
        data_port_current = 0;
    }

    function atapi_read(cmd)
    {
        // Note: Big Endian
        var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5],
            count = cmd[7] << 8 | cmd[8], 
            flags = cmd[1],
            byte_count = count * me.sector_size,
            //transfered_ata_blocks = Math.min(bytecount / 512, cylinder_low << 8 | cylinder_high),
            max_drq_size = (cylinder_high & 0xFF) << 8 | cylinder_low & 0xFF,
            transfered_ata_blocks,
            start = lba * me.sector_size;

        dbg_log("CD read lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytecount=" + h(byte_count) +
                " flags=" + h(flags), LOG_CD);

        if(!max_drq_size)
        {
            max_drq_size = 0x8000;
        }

        transfered_ata_blocks = Math.min(byte_count, max_drq_size);

        cylinder_low = transfered_ata_blocks & 0xFF;
        cylinder_high = transfered_ata_blocks >> 8 & 0xFF;

        if(start >= buffer.byteLength)
        {
            dbg_log("CD read: Outside of disk  end=" + h(start + byte_count) + 
                    " size=" + h(buffer.byteLength), LOG_DISK);

            status = 0xFF;
            push_irq();
        }
        else
        {
            byte_count = Math.min(byte_count, buffer.byteLength - start);
            status = 0x80;

            me.buffer.get(start, byte_count, function(data)
            {
                pio_data = data;
                status = 0x58;

                //cylinder_low = 0;
                //cylinder_high = 8;

                data_pointer = 0;
                push_irq();

                me.stats.sectors_read += byte_count / me.sector_size | 0;
                me.stats.bytes_read += byte_count;
            });
        }
    }

    function atapi_read_dma(cmd)
    {
        // Note: Big Endian
        var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5],
            count = cmd[7] << 8 | cmd[8], 
            flags = cmd[1],
            byte_count = count * me.sector_size,
            start = lba * me.sector_size;

        dbg_log("CD read DMA lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytecount=" + h(byte_count) +
                " flags=" + h(flags), LOG_CD);


        if(start >= buffer.byteLength)
        {
            dbg_log("CD read: Outside of disk  end=" + h(start + byte_count) + 
                    " size=" + h(buffer.byteLength), LOG_DISK);

            status = 0xFF;
            push_irq();
        }
        else
        {
            byte_count = Math.min(byte_count, buffer.byteLength - start);
            status = 0x80;

            me.buffer.get(start, byte_count, function(data)
            {
                var prdt_start = prdt_addr,
                    offset = 0;

                do {
                    var addr = memory.read32s(prdt_start),
                        count = memory.read16(prdt_start + 4),
                        end = memory.read8(prdt_start + 7) & 0x80;

                    if(!count)
                    {
                        count = 0x10000;
                    }

                    dbg_log("dma read dest=" + h(addr) + " count=" + h(count), LOG_DISK);
                    memory.write_blob(data.subarray(offset, offset + count), addr);

                    offset += count;
                    prdt_start += 8;
                }
                while(!end);

                status = 0x50;
                dma_status &= ~2 & ~1;
                dma_status |= 4;

                push_irq();
                
                me.stats.sectors_read += byte_count / me.sector_size | 0;
                me.stats.bytes_read += byte_count;
            });
        }
    }

    function read_data_port(port_addr)
    {
        if(port_addr === me.ata_port)
        {
            return read_data();
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

    function read_data()
    {
        if(data_pointer < pio_data.length)
        {
            if((data_pointer + 1) % (sectors_per_drq * 512) === 0 || 
                data_pointer + 1 === pio_data.length)
            {
                dbg_log("ATA IRQ", LOG_DISK);
                push_irq();
            }

            if(cylinder_low)
            {
                cylinder_low--;
            }
            else
            {
                if(cylinder_high)
                {
                    cylinder_high--;
                    cylinder_low = 0xFF;
                }
            }

            if(!cylinder_low && !cylinder_high)
            {
                var remaining = pio_data.length - data_pointer - 1;
                dbg_log("reset to " + h(remaining), LOG_DISK);

                if(remaining >= 0x10000)
                {
                    cylinder_high = 0xF0;
                    cylinder_low = 0;
                }
                else
                {
                    cylinder_high = remaining >> 8;
                    cylinder_low = remaining;
                }

            }

            if(data_pointer + 1 >= pio_data.length)
            {
                status = 0x50;
                //bytecount = 3;
            }

            if((data_pointer + 1 & 255) === 0)
            {
                dbg_log("Read 1F0: " + h(pio_data[data_pointer], 2) + 
                            " cur=" + h(data_pointer) +
                            " cnt=" + h(pio_data.length), LOG_DISK);
            }

            return pio_data[data_pointer++];
        }
        else
        {
            dbg_log("Read 1F0: empty", LOG_DISK);

            data_pointer++;
            return 0;
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
            if(data_port_current >= data_port_count)
            {
                dbg_log("Redundant write to data port: " + h(data) + " count=" + h(data_port_count) +
                        " cur=" + h(data_port_current), LOG_DISK);
            }
            else
            {
                dbg_log("Data port: " + h(data) + " count=" + h(data_port_count) +
                        " cur=" + h(data_port_current), LOG_DISK);

                data_port_buffer[data_port_current++] = data;

                if(data_port_current === data_port_count)
                {
                    data_port_callback();
                }
            }

        }
        else if(port_addr === (me.ata_port | 1))
        {
            dbg_log("1F1/lba_count: " + h(data), LOG_DISK);
            lba_count = (lba_count << 8 | data) & 0xFFFF;
        }
        else if(port_addr === (me.ata_port | 2))
        {
            dbg_log("1F2/bytecount: " + h(data), LOG_DISK);
            bytecount = (bytecount << 8 | data) & 0xFFFF;
        }
        else if(port_addr === (me.ata_port | 3))
        {
            dbg_log("1F3/sector: " + h(data), LOG_DISK);
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

        switch(cmd)
        {
            case 0x00:
                // NOP
                push_irq();
                status = 0x50;
                break;

            case 0x08:
                dbg_log("ATA device reset", LOG_DISK);
                data_pointer = 0;
                pio_data = new Uint8Array(0);
                status = 0x50;

                push_irq();
                break;

            case 0x10:
                // obsolete
                dbg_log("ATA cmd 10", LOG_DISK);
                push_irq();
                break;

            case 0x27:
                // READ NATIVE MAX ADDRESS EXT - read the actual size of the HD
                // https://en.wikipedia.org/wiki/Host_protected_area
                dbg_log("ATA cmd 27", LOG_DISK);
                push_irq();
                pio_data = new Uint8Array([
                    0, 0, // error
                    0, 0, // count

                    // result
                    me.buffer.byteLength & 0xff,
                    me.buffer.byteLength >> 8 & 0xff,
                    me.buffer.byteLength >> 16 & 0xff,
                    me.buffer.byteLength >> 24 & 0xff,
                    0, 0,

                    0, 0, 
                ]);
                status = 0x58;
                break;

            case 0x20:
            case 0x29:
            case 0x24:
                // 0x20 read sectors
                // 0x24 read sectors ext
                // 0x29 read multiple ext
                ata_read_sectors(cmd);
                break;

            case 0x30:
            case 0x34:
            case 0x39:
                // 0x30 write sectors
                // 0x34 write sectors ext
                // 0x39 write multiple ext
                ata_write(cmd);
                break;

            case 0x90:
                // EXECUTE DEVICE DIAGNOSTIC
                dbg_log("ATA cmd 90", LOG_DISK);
                push_irq();
                lba_count = 0x101;
                status = 0x50;
                break;

            case 0x91:
                // INITIALIZE DEVICE PARAMETERS
                dbg_log("ATA cmd 91", LOG_DISK);
                push_irq();
                break;

            case 0xA0:
                if(me.is_atapi)
                {
                    // ATA_CMD_PACKET
                    status = 0x58;
                    allocate_in_buffer(12);
                    data_port_callback = atapi_handle;

                    bytecount = 1;
                    push_irq();
                }
                break;

            case 0xA1:
                dbg_log("ATA identify packet device", LOG_DISK);

                if(me.is_atapi)
                {
                    create_identify_packet();
                    
                    status = 0x58;

                    push_irq();
                }
                else
                {
                    status = 0x50;
                    push_irq();
                }
                break;

            case 0xC6:
                // SET MULTIPLE MODE
                dbg_log("ATA cmd C6", LOG_DISK);

                // Logical sectors per DRQ Block in word 1
                dbg_log("Logical sectors per DRQ Block: " + h(bytecount), LOG_DISK);
                sectors_per_drq = bytecount;

                push_irq();
                break;

            case 0xC8:
                // 0xC8 read dma
                ata_read_sectors_dma(cmd);
                break;

            case 0xCA:
                // write dma
                ata_write_dma(cmd);
                break;

            case 0xE1:
                dbg_log("ATA idle immediate", LOG_DISK);
                push_irq();
                break;

            case 0xEC:
                dbg_log("ATA identify device", LOG_DISK);
                // identify device

                if(me.is_atapi)
                {
                    return;
                }

                create_identify_packet();

                status = 0x58;

                push_irq();
                break;

            case 0xEA:
                //  FLUSH CACHE EXT
                dbg_log("ATA cmd EA", LOG_DISK);
                push_irq();
                break;

            case 0xEF:
                // SET FEATURES
                dbg_log("ATA cmd EF", LOG_DISK);

                push_irq();
                break;

            default:
                dbg_log("New ATA cmd on 1F7: " + h(cmd), LOG_DISK);

                // abort bit set
                lba_count = 4;
        }
    });


    function ata_read_sectors(cmd)
    {
        if(cmd === 0x20)
        {
            var count = bytecount & 0xff,
                lba = get_lba28();
        }
        else if(cmd === 0x29)
        {
            var count = bytecount,
                lba = get_lba28();
        }
        else
        {
            var count = bytecount,
                lba = (cylinder_high << 16 | cylinder_low) >>> 0;
        }

        if(!count)
            count = 0x10000;

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
            //status = 0xFF & ~8;
            status = 0x80;

            me.buffer.get(start, byte_count, function(data)
            {
                pio_data = data;
                status = 0x58;
                data_pointer = 0;

                push_irq();

                me.stats.sectors_read += byte_count / me.sector_size | 0;
                me.stats.bytes_read += byte_count;
            });
        }
    }

    function ata_read_sectors_dma(cmd)
    {
        var count = bytecount & 0xff,
            lba = get_lba28();

        var byte_count = count * me.sector_size,
            start = lba * me.sector_size;

        dbg_log("ATA DMA read lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytecount=" + h(byte_count), LOG_DISK);

        cylinder_low += count;

        if(start + byte_count > buffer.byteLength)
        {
            dbg_log("ATA read: Outside of disk", LOG_DISK);

            status = 0xFF;
            push_irq();
            return;
        }

        //status = 0xFF & ~8;
        status = 0x80;
        dma_status |= 1;

        me.buffer.get(start, byte_count, function(data)
        {
            var prdt_start = prdt_addr,
                offset = 0;

            do {
                var addr = memory.read32s(prdt_start),
                    count = memory.read16(prdt_start + 4),
                    end = memory.read8(prdt_start + 7) & 0x80;

                if(!count)
                {
                    count = 0x10000;
                }

                dbg_log("dma read dest=" + h(addr) + " count=" + h(count), LOG_DISK);
                memory.write_blob(data.subarray(offset, offset + count), addr);

                offset += count;
                prdt_start += 8;
            }
            while(!end);

            status = 0x50;
            dma_status &= ~2 & ~1;
            dma_status |= 4;

            push_irq();

            me.stats.sectors_read += byte_count / me.sector_size | 0;
            me.stats.bytes_read += byte_count;
        });
    }

    function ata_write(cmd)
    {
        if(cmd === 0x30)
        {
            var count = bytecount & 0xff,
                lba = get_lba28();
        }
        else if(cmd === 0x39)
        {
            var count = bytecount,
                lba = get_lba28();
        }
        else
        {
            var count = bytecount,
                lba = (cylinder_high << 16 | cylinder_low) >>> 0;
        }

        var byte_count = count * me.sector_size,
            start = lba * me.sector_size;


        dbg_log("ATA write lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytecount=" + h(byte_count), LOG_DISK);

        cylinder_low += count;

        if(start + byte_count > buffer.byteLength)
        {
            dbg_log("ATA write: Outside of disk", LOG_DISK);

            status = 0xFF;
            push_irq();
        }
        else
        {
            status = 0x50;
            next_status = 0x58;

            allocate_in_buffer(byte_count);

            write_dest = start;
            data_port_callback = do_write;

            //bytecount = 1;
            push_irq();
        }
    }

    function ata_write_dma(cmd)
    {
        var count = bytecount & 0xff,
            lba = get_lba28();

        var byte_count = count * me.sector_size,
            start = lba * me.sector_size;

        dbg_log("ATA DMA write lba=" + h(lba) + 
                " lbacount=" + h(count) +
                " bytecount=" + h(byte_count), LOG_DISK);

        cylinder_low += count;

        if(start + byte_count > buffer.byteLength)
        {
            dbg_log("ATA DMA write: Outside of disk", LOG_DISK);

            status = 0xFF;
            push_irq();
            return;
        }

        //status = 0xFF & ~8;
        status = 0x80;
        dma_status |= 1;

        var prdt_start = prdt_addr,
            prdt_count = 0,
            prdt_write_count = 0,
            offset = 0;


        do {
            var prd_addr = memory.read32s(prdt_start),
                prd_count = memory.read16(prdt_start + 4),
                end = memory.read8(prdt_start + 7) & 0x80;

            if(!prd_count)
            {
                prd_count = 0x10000;
            }

            dbg_log("dma write dest=" + h(prd_addr) + " prd_count=" + h(prd_count), LOG_DISK);

            var slice = memory.mem8.subarray(prd_addr, prd_addr + prd_count);

            me.buffer.set(start + offset, slice, function()
            {
                prdt_write_count++;

                if(prdt_write_count === prdt_count)
                {
                    dbg_log("dma write completed", LOG_DISK);
                    status = 0x50;
                    push_irq();
                    dma_status &= ~2 & ~1;
                    dma_status |= 4;
                }
            });

            offset += prd_count;
            prdt_start += 8;
            prdt_count++;
        }
        while(!end);


        if(prdt_write_count === prdt_count)
        {
            dbg_log("dma write completed", LOG_DISK);
            status = 0x50;
            push_irq();
            dma_status &= ~2 & ~1;
            dma_status |= 4;
        }

        me.stats.sectors_written += byte_count / me.sector_size | 0;
        me.stats.bytes_written += byte_count;
    }

    function get_lba28()
    {
        return cylinder_high << 16 & 0x0F0000 | cylinder_low << 8 & 0xFF00 | sector & 0xFF;
    }

    function create_identify_packet()
    {
        // http://bochs.sourceforge.net/cgi-bin/lxr/source/iodev/harddrv.cc#L2821

        data_pointer = 0;

        pio_data = new Uint8Array([
            0x40, me.is_atapi ? 0x85 : 0, 
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
            
            0, 0, 
            // 63, dma selected mode
            0, 4, 
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
            me.sector_count & 0xFF, me.sector_count >> 8 & 0xFF, 
            me.sector_count >> 16 & 0xFF, me.sector_count >> 24 & 0xFF, 
            

        ]);

        if(me.cylinder_count > 16383)
        {
            pio_data[2] = pio_data[108] = 16383 & 0xFF;
            pio_data[3] = pio_data[109] = 16383 >> 8;
        }
    }


    var prdt_addr = 0,
        dma_status;

    this.io.register_read(this.master_port | 4, dma_read_addr0);
    this.io.register_read(this.master_port | 5, dma_read_addr1);
    this.io.register_read(this.master_port | 6, dma_read_addr2);
    this.io.register_read(this.master_port | 7, dma_read_addr3);

    this.io.register_write(this.master_port | 4, dma_set_addr0);
    this.io.register_write(this.master_port | 5, dma_set_addr1);
    this.io.register_write(this.master_port | 6, dma_set_addr2);
    this.io.register_write(this.master_port | 7, dma_set_addr3);


    function dma_read_addr0()
    {
        return prdt_addr & 0xFF;
    }
    function dma_read_addr1()
    {
        return prdt_addr >> 8 & 0xFF;
    }
    function dma_read_addr2()
    {
        return prdt_addr >> 16 & 0xFF;
    }
    function dma_read_addr3()
    {
        return prdt_addr >> 24 & 0xFF;
    }

    function dma_set_addr0(data)
    {
        prdt_addr = prdt_addr & ~0xFF | data;
    }
    function dma_set_addr1(data)
    {
        prdt_addr = prdt_addr & ~0xFF00 | data << 8;
    }
    function dma_set_addr2(data)
    {
        prdt_addr = prdt_addr & ~0xFF0000 | data << 16;
    }
    function dma_set_addr3(data)
    {
        prdt_addr = prdt_addr & 0xFFFFFF | data << 24;
        dbg_log("Set PRDT addr: " + h(prdt_addr), LOG_DISK);
    }

    this.io.register_read(this.master_port | 2, dma_read_status);
    this.io.register_write(this.master_port | 2, dma_write_status);

    function dma_read_status()
    {
        dbg_log("DMA read status: " + h(dma_status), LOG_DISK);
        return dma_status;
    }

    function dma_write_status(value)
    {
        dbg_log("DMA write status: " + h(value), LOG_DISK);
        dma_status &= ~value;
    }

    this.io.register_read(this.master_port, dma_read_command);
    this.io.register_write(this.master_port, dma_write_command);

    function dma_read_command()
    {
        dbg_log("DMA read command", LOG_DISK);
        return 1;
    }

    function dma_write_command(value)
    {
        dbg_log("DMA write command: " + h(value), LOG_DISK);

        if(value & 1)
        {
            push_irq();
        }
    }
}
