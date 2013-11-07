"use strict";

/** @constructor */
function FloppyController(dev, floppy_image)
{
    var 
        io = dev.io,
        pic = dev.pic,
        dma = dev.dma,

        bytes_expecting = 0,
        receiving_command = new Uint8Array(10),
        receiving_index = 0,
        next_command,

        response_data = new Uint8Array(10),
        response_index = 0,
        response_length = 0,

        floppy_size,

        /** @const */
        byte_per_sector = 512;

    this.buffer = floppy_image;

    if(!floppy_image)
    {
        this.type = 0;
        return;
    }

    floppy_size = floppy_image.byteLength;

    var floppy_types = {
        160  : { type: 1, tracks: 40, sectors: 8 , heads: 1 },
        180  : { type: 1, tracks: 40, sectors: 9 , heads: 1 },
        200  : { type: 1, tracks: 40, sectors: 10, heads: 1 },
        320  : { type: 1, tracks: 40, sectors: 8 , heads: 2 },
        360  : { type: 1, tracks: 40, sectors: 9 , heads: 2 },
        400  : { type: 1, tracks: 40, sectors: 10, heads: 2 },
        720  : { type: 3, tracks: 80, sectors: 9 , heads: 2 },
        1200 : { type: 2, tracks: 80, sectors: 15, heads: 2 },
        1440 : { type: 4, tracks: 80, sectors: 18, heads: 2 },
        1722 : { type: 5, tracks: 82, sectors: 21, heads: 2 },
        2880 : { type: 5, tracks: 80, sectors: 36, heads: 2 },
    };

    var number_of_cylinders,
        sectors_per_track,
        number_of_heads,
        floppy_type = floppy_types[floppy_size >> 10];

    if(floppy_type && (floppy_size & 0x3FF) === 0)
    {
        this.type = floppy_type.type;

        sectors_per_track = floppy_type.sectors;
        number_of_heads = floppy_type.heads;
        number_of_cylinders = floppy_type.tracks;
    }
    else
    {
        throw unimpl("Unknown floppy size: " + h(floppy_image.byteLength));
    }

    var status_reg0 = 0,
        status_reg1 = 0,
        status_reg2 = 0,
        drive = 0;

    var last_cylinder = 0,
        last_head = 0,
        last_sector = 1;

    io.register_read(0x3F0, port3F0_read);
    io.register_read(0x3F4, port3F4_read);
    io.register_read(0x3F5, port3F5_read);
    io.register_read(0x3F7, port3F7_read);

    io.register_write(0x3F5, port3F5_write);

    function port3F0_read()
    {
        dbg_log("3F0 read", LOG_DISK);

        return 0;
    };


    function port3F4_read()
    {
        dbg_log("3F4 read", LOG_DISK);

        var return_byte = 0x80;

        if(response_index < response_length)
        {
            return_byte |= 0x40 | 0x10;
        }

        if((dor & 8) === 0)
        {
            return_byte |= 0x20;
        }

        return return_byte;
    };

    function port3F7_read()
    {
        dbg_log("3F7 read", LOG_DISK);
        return 0x00;
    }

    function port3F5_read()
    {
        if(response_index < response_length)
        {
            dbg_log("3F5 read: " + response_data[response_index], LOG_DISK);
            return response_data[response_index++];
        }
        else
        {
            dbg_log("3F5 read, empty", LOG_DISK);
            return 0xFF;
        }
    };

    function port3F5_write(reg_byte)
    {
        dbg_log("3F5 write " + h(reg_byte), LOG_DISK);

        if(bytes_expecting > 0)
        {
            receiving_command[receiving_index++] = reg_byte;

            bytes_expecting--;

            if(bytes_expecting === 0)
            {
                if(DEBUG)
                {
                    var log = "3F5 command received: ";
                    for(var i = 0; i < receiving_index; i++) 
                        log += h(receiving_command[i]) + " ";
                    dbg_log(log, LOG_DISK);
                }

                next_command(receiving_command);
            }
        }
        else
        {
            switch(reg_byte)
            {
                // TODO
                //case 2:
                    //next_command = read_complete_track;
                    //bytes_expecting = 8;
                    //break;
                case 0x03:
                    next_command = fix_drive_data;
                    bytes_expecting = 2;
                    break;
                case 0x04:
                    next_command = check_drive_status;
                    bytes_expecting = 1;
                    break;
                case 0x05:
                case 0xC5:
                    next_command = function(args) { do_sector(true, args); };
                    bytes_expecting = 8;
                    break;
                case 0xE6:
                    next_command = function(args) { do_sector(false, args); };
                    bytes_expecting = 8;
                    break;
                case 0x07:
                    next_command = calibrate;
                    bytes_expecting = 1;
                    break;
                case 0x08:
                    check_interrupt_status();
                    break;
                case 0x4A:
                    next_command = read_sector_id;
                    bytes_expecting = 1;
                    break;
                case 0x0F:
                    bytes_expecting = 2;
                    next_command = seek;
                    break;
                case 0x0E:
                    // dump regs 
                    dbg_log("dump registers", LOG_DISK);
                    response_data[0] = 0x80;
                    response_index = 0;
                    response_length = 1;

                    bytes_expecting = 0;
                    break;
                default:
                    if(DEBUG) throw "unimpl floppy command call " + h(reg_byte);
            }

            receiving_index = 0;
        }
    };


    // this should actually be write-only ... but people read it anyway
    var dor = 0;

    function port3F2_read()
    {
        dbg_log("read 3F2: DOR", LOG_DISK);
        return dor;
    }
    io.register_read(0x3F2, port3F2_read);

    function port3F2_write(value)
    {
        if((value & 4) === 4 && (dor & 4) === 0)
        {
            // reset
            pic.push_irq(6);
        }

        dbg_log("start motors: " + h(value >> 4), LOG_DISK);
        dbg_log("enable dma: " + !!(value & 8), LOG_DISK);
        dbg_log("reset fdc: " + !!(value & 4), LOG_DISK);
        dbg_log("drive select: " + (value & 3), LOG_DISK);
        dbg_log("DOR = " + h(value), LOG_DISK);

        dor = value;

    }
    io.register_write(0x3F2, port3F2_write);

    function check_drive_status(args)
    {
        dbg_log("check drive status", LOG_DISK);

        response_index = 0;
        response_length = 1;
        response_data[0] = 1 << 5;
    }

    function seek(args)
    {
        dbg_log("seek", LOG_DISK);

        last_cylinder = args[1];
        last_head = args[0] >> 2 & 1;
        
        if(dor & 8)
        {
            pic.push_irq(6);
        }
    }

    function calibrate(args)
    {
        dbg_log("floppy calibrate", LOG_DISK);

        if(dor & 8)
        {
            pic.push_irq(6);
        }
    }

    function check_interrupt_status()
    {
        // do not trigger an interrupt here
        dbg_log("floppy check interrupt status", LOG_DISK);

        response_index = 0;
        response_length = 2;

        response_data[0] = 1 << 5;
        response_data[1] = last_cylinder;
    }

    function do_sector(is_write, args)
    {
        var head = args[2],
            cylinder = args[1],
            sector = args[3],
            sector_size = 128 * (1 << args[4]),
            read_count = args[5] - args[3] + 1,

            read_offset = ((head + number_of_heads * cylinder) * sectors_per_track + sector - 1) * sector_size;
        
        dbg_log("Floppy Read", LOG_DISK);
        dbg_log("from " + h(read_offset) + " length " + h(read_count * sector_size), LOG_DISK);
        dbg_log(cylinder + " / " + head + " / " + sector, LOG_DISK);

        if(!args[4])
        {
            dbg_log("FDC: sector count is zero, use data length instead", LOG_DISK);
        }

        if(is_write)
        {
            dma.do_write(floppy_image, read_offset, read_count * sector_size, 2, done);
        }
        else
        {
            dma.do_read(floppy_image, read_offset, read_count * sector_size, 2, done);
        }

        function done()
        {
            sector++;

            if(sector > sectors_per_track)
            {
                sector = 1;
                head++;

                if(head >= number_of_heads)
                {
                    head = 0;
                    cylinder++;
                }
            }

            last_cylinder = cylinder;
            last_head = head;
            last_sector = sector;

            response_index = 0;
            response_length = 7;

            response_data[0] = head << 2 | 0x20; 
            response_data[1] = 0; 
            response_data[2] = 0; 
            response_data[3] = cylinder; 
            response_data[4] = head; 
            response_data[5] = sector; 
            response_data[6] = args[4];

            if(dor & 8)
            {
                pic.push_irq(6);
            }
        }
    }
    
    function fix_drive_data(args)
    {
        dbg_log("floppy fix drive data " + args, LOG_DISK);
    }

    function read_sector_id(args)
    {
        dbg_log("floppy read sector id " + args, LOG_DISK);

        response_index = 0;
        response_length = 7;

        response_data[0] = 0;
        response_data[1] = 0;
        response_data[2] = 0;
        response_data[3] = 0;
        response_data[4] = 0;
        response_data[5] = 0;
        response_data[6] = 0;

        if(dor & 8)
        {
            pic.push_irq(6);
        }
    }
}

