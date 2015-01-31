/**
 * RTC (real time clock) and CMOS
 * @constructor
 */
function RTC(cpu, diskette_type, boot_order)
{
    /** @const */
    this.cpu = cpu;

    /** @const */
    this.pic = cpu.devices.pic;

    this.cmos_index = 0;
    this.boot_order = boot_order;
    this.diskette_type = diskette_type;
        
    // used for cmos entries
    this.rtc_time = Date.now();
    this.last_update = this.rtc_time;

    // used for periodic interrupt
    this.next_interrupt = 0;

    this.cmos_c_was_read = true;

    this.periodic_interrupt = false;

    // corresponds to default value for cmos_a
    this.periodic_interrupt_time = 1000 / 1024;

    this.cmos_a = 0x26;
    this.cmos_b = 2;
    this.cmos_c = 0;

    this.nmi_disabled = 0;

    cpu.io.register_write(0x70, this, function(out_byte)
    {
        this.cmos_index = out_byte & 0x7F;
        this.nmi_disabled = out_byte >> 7;
    });

    cpu.io.register_write(0x71, this, this.cmos_write);
    cpu.io.register_read(0x71, this, this.cmos_read);

    this._state_skip = [
        this.cpu,
        this.pic,
    ];
}

RTC.prototype.timer = function(time, legacy_mode)
{
    this.rtc_time += time - this.last_update;
    this.last_update = time;

    if(this.periodic_interrupt && this.cmos_c_was_read && this.next_interrupt < time)
    {
        this.cmos_c_was_read = false;
        this.pic.push_irq(8);
        this.cmos_c |= 1 << 6;

        this.next_interrupt += this.periodic_interrupt_time * 
                Math.ceil((time - this.next_interrupt) / this.periodic_interrupt_time);

        return Math.max(0, time - this.next_interrupt);
    }

    return 100;
};

RTC.prototype.bcd_pack = function(n)
{ 
    var i = 0, 
        result = 0,
        digit;
    
    while(n)
    {
        digit = n % 10; 
        
        result |= digit << (4 * i); 
        i++; 
        n = (n - digit) / 10;
    } 
    
    return result;
};

RTC.prototype.encode_time = function(t)
{
    if(this.cmos_b & 4)
    {
        // binary mode
        return t;
    }
    else
    {
        return this.bcd_pack(t);
    }
};

// TODO
// - interrupt on update
// - countdown
// - letting bios/os set values
// (none of these are used by seabios or the OSes we're 
// currently testing)
RTC.prototype.cmos_read = function()
{
    var index = this.cmos_index;

    //this.cmos_index = 0xD;

    switch(index)
    {
        case 0:
            return this.encode_time(new Date(this.rtc_time).getUTCSeconds());
        case 2:
            return this.encode_time(new Date(this.rtc_time).getUTCMinutes());
        case 4:
            // TODO: 12 hour mode
            return this.encode_time(new Date(this.rtc_time).getUTCHours());
        case 7:
            return this.encode_time(new Date(this.rtc_time).getUTCDate());
        case 8:
            return this.encode_time(new Date(this.rtc_time).getUTCMonth() + 1);
        case 9:
            return this.encode_time(new Date(this.rtc_time).getUTCFullYear() % 100);

        case 0xA:
            return this.cmos_a;
        case 0xB:
            //dbg_log("cmos read from index " + h(index));
            return this.cmos_b;

        case 0xE:
            // post info
            return 0;
        case 0xC:
            this.cmos_c_was_read = true;

            // TODO:
            // It is important to know that upon a IRQ 8, Status Register C
            // will contain a bitmask telling which interrupt happened.
            // What is important is that if register C is not read after an
            // IRQ 8, then the interrupt will not happen again. 

            dbg_log("cmos reg C read", LOG_RTC);
            // Missing IRQF flag
            //return cmos_b & 0x70;

            return this.cmos_c;

        case 0xF:
            return 0;

        case 0x10:
            // floppy type
            return this.diskette_type;

        case 0x14:
            // equipment
            return 0x2D;

        case 0x32:
            return this.encode_time(new Date(this.rtc_time).getUTCFullYear() / 100 | 0);

        case 0x34:
            return (this.cpu.memory_size - 16 * 1024 * 1024) >> 16 & 0xff;
        case 0x35:
            return (this.cpu.memory_size - 16 * 1024 * 1024) >> 24 & 0xff;


        case 0x38:
            // used by seabios to determine the boot order
            //   Nibble
            //   1: FloppyPrio 
            //   2: HDPrio 
            //   3: CDPrio 
            //   4: BEVPrio 
            // bootflag 1, high nibble, lowest priority
            // Low nibble: Disable floppy signature check (1)
            return 1 | this.boot_order >> 4 & 0xF0;
        case 0x3D:
            // bootflag 2, both nibbles, high and middle priority
            return this.boot_order & 0xFF; 

        case 0x39:
            // disk translation translation -> lba
            return 1;

        case 0x5B:
        case 0x5C:
        case 0x5D:
            // memory above 4GB
            return 0;
    }

    dbg_log("cmos read from index " + h(index), LOG_RTC);

    return 0xFF;
};

RTC.prototype.cmos_write = function(data_byte)
{
    switch(this.cmos_index)
    {
        case 0xA:
            this.cmos_a = data_byte & 0x7F;
            this.periodic_interrupt_time = 1000 / (32768 >> (this.cmos_a & 0xF) - 1);

            dbg_log("Periodic interrupt, a=" + h(this.cmos_a, 2) + " t=" + this.periodic_interrupt_time , LOG_RTC);
            break;
        case 0xB:
            this.cmos_b = data_byte;
            if(this.cmos_b & 0x40)
            {
                this.next_interrupt = Date.now();
            }

            if(this.cmos_b & 0x20) dbg_log("Unimplemented: alarm interrupt");
            if(this.cmos_b & 0x10) dbg_log("Unimplemented: updated interrupt");

            dbg_log("cmos b=" + h(this.cmos_b, 2), LOG_RTC);
            break;
        default:
            dbg_log("cmos write index " + h(this.cmos_index) + ": " + h(data_byte), LOG_RTC);
    }

    this.periodic_interrupt = (this.cmos_b & 0x40) === 0x40 && (this.cmos_a & 0xF) > 0;
};
