/**
 * RTC (real time clock) and CMOS
 * @constructor
 */
function RTC(dev, diskette_type, boot_order)
{
    var 
        io = dev.io,
        pic = dev.pic,

        memory_size = dev.memory.size,

        cmos_index = 0,
        me = this,
        
        // used for cmos entries
        rtc_time = Date.now(),
        last_update = rtc_time,

        // used for periodic interrupt
        next_interrupt = 0,

        cmos_c_was_read = true,

        periodic_interrupt = false,

        // corresponds to default value for cmos_a
        periodic_interrupt_time = 1000 / 1024;


    var cmos_a = 0x26,
        cmos_b = 2,
        cmos_c = 0;

    this.nmi_disabled = 0;

    this.timer = function(time)
    {
        if(periodic_interrupt && cmos_c_was_read && next_interrupt < time)
        {
            cmos_c_was_read = false;
            pic.push_irq(8);
            cmos_c |= 1 << 6;

            next_interrupt += periodic_interrupt_time * 
                    Math.ceil((time - next_interrupt) / periodic_interrupt_time);
        }

        rtc_time += time - last_update;
        last_update = time;
    };

    io.register_write(0x70, function(out_byte)
    {
        cmos_index = out_byte & 0x7F;
        me.nmi_disabled = out_byte >> 7;
    });

    io.register_write(0x71, cmos_write);
    io.register_read(0x71, cmos_read);

    function encode_time(t)
    {
        if(cmos_b & 4)
        {
            // binary mode
            return t;
        }
        else
        {
            return Math.bcd_pack(t);
        }
    }
    

    // TODO
    // - interrupt on update
    // - countdown
    // - letting bios/os set values
    // (none of these are used by seabios or the OSes we're 
    // currently testing)
    function cmos_read()
    {
        var index = cmos_index;

        //cmos_index = 0xD;

        switch(index)
        {
            case 0:
                return encode_time(new Date(rtc_time).getUTCSeconds());
            case 2:
                return encode_time(new Date(rtc_time).getUTCMinutes());
            case 4:
                // TODO: 12 hour mode
                return encode_time(new Date(rtc_time).getUTCHours());
            case 7:
                return encode_time(new Date(rtc_time).getUTCDate());
            case 8:
                return encode_time(new Date(rtc_time).getUTCMonth() + 1);
            case 9:
                return encode_time(new Date(rtc_time).getUTCFullYear() % 100);

            case 0xA:
                return cmos_a;
            case 0xB:
                //dbg_log("cmos read from index " + h(index));
                return cmos_b;

            case 0xE:
                // post info
                return 0;
            case 0xC:
                cmos_c_was_read = true;

                // TODO:
                // It is important to know that upon a IRQ 8, Status Register C
                // will contain a bitmask telling which interrupt happened.
                // What is important is that if register C is not read after an
                // IRQ 8, then the interrupt will not happen again. 

                dbg_log("cmos reg C read", LOG_RTC);
                // Missing IRQF flag
                //return cmos_b & 0x70;

                return cmos_c;

            case 0xF:
                return 0;

            case 0x10:
                // floppy type
                return diskette_type;

            case 0x14:
                // equipment
                return 0x2D;

            case 0x32:
                return encode_time(new Date(rtc_time).getUTCFullYear() / 100 | 0);

            case 0x34:
                return (memory_size - 16 * 1024 * 1024) >> 16 & 0xff;
            case 0x35:
                return (memory_size - 16 * 1024 * 1024) >> 24 & 0xff;


            case 0x38:
                // used by seabios to determine the boot order
                //   Nibble
                //   1: FloppyPrio 
                //   2: HDPrio 
                //   3: CDPrio 
                //   4: BEVPrio 
                // bootflag 1, high nibble, lowest priority
                // Low nibble: Disable floppy signature check (1)
                return 1 | boot_order >> 4 & 0xF0;
            case 0x3D:
                // bootflag 2, both nibbles, high and middle priority
                return boot_order & 0xFF; 

            case 0x5B:
            case 0x5C:
            case 0x5D:
                // memory above 4GB
                return 0;
        }

        dbg_log("cmos read from index " + h(index), LOG_RTC);

        return 0xFF;
    }

    function cmos_write(data_byte)
    {
        switch(cmos_index)
        {
            case 0xA:
                cmos_a = data_byte & 0x7F;
                periodic_interrupt_time = 1000 / (32768 >> (cmos_a & 0xF) - 1);

                dbg_log("Periodic interrupt, a=" + h(cmos_a, 2) + " t=" + periodic_interrupt_time , LOG_RTC);
                break;
            case 0xB:
                cmos_b = data_byte;
                if(cmos_b & 0x40)
                {
                    next_interrupt = Date.now();
                }

                if(cmos_b & 0x20) dbg_log("Unimplemented: alarm interrupt");
                if(cmos_b & 0x10) dbg_log("Unimplemented: updated interrupt");

                dbg_log("cmos b=" + h(cmos_b, 2), LOG_RTC);
                break;
            default:
                dbg_log("cmos write index " + h(cmos_index) + ": " + h(data_byte), LOG_RTC);
        }

        periodic_interrupt = (cmos_b & 0x40) === 0x40 && (cmos_a & 0xF) > 0;
    }
}
