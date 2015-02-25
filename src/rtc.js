"use strict";

var CMOS_RTC_SECONDS = 0x00;
var CMOS_RTC_SECONDS_ALARM = 0x01;
var CMOS_RTC_MINUTES = 0x02;
var CMOS_RTC_MINUTES_ALARM = 0x03;
var CMOS_RTC_HOURS = 0x04;
var CMOS_RTC_HOURS_ALARM = 0x05;
var CMOS_RTC_DAY_WEEK = 0x06;
var CMOS_RTC_DAY_MONTH = 0x07;
var CMOS_RTC_MONTH = 0x08;
var CMOS_RTC_YEAR = 0x09;
var CMOS_STATUS_A = 0x0a;
var CMOS_STATUS_B = 0x0b;
var CMOS_STATUS_C = 0x0c;
var CMOS_STATUS_D = 0x0d;
var CMOS_RESET_CODE = 0x0f;

var CMOS_FLOPPY_DRIVE_TYPE = 0x10;
var CMOS_DISK_DATA = 0x12;
var CMOS_EQUIPMENT_INFO = 0x14;
var CMOS_DISK_DRIVE1_TYPE = 0x19;
var CMOS_DISK_DRIVE2_TYPE = 0x1a;
var CMOS_DISK_DRIVE1_CYL = 0x1b;
var CMOS_DISK_DRIVE2_CYL = 0x24;
var CMOS_MEM_EXTMEM_LOW = 0x30;
var CMOS_MEM_EXTMEM_HIGH = 0x31;
var CMOS_CENTURY = 0x32;
var CMOS_MEM_EXTMEM2_LOW = 0x34;
var CMOS_MEM_EXTMEM2_HIGH = 0x35;
var CMOS_BIOS_BOOTFLAG1 = 0x38;
var CMOS_BIOS_DISKTRANSFLAG = 0x39;
var CMOS_BIOS_BOOTFLAG2 = 0x3d;
var CMOS_MEM_HIGHMEM_LOW = 0x5b;
var CMOS_MEM_HIGHMEM_MID = 0x5c;
var CMOS_MEM_HIGHMEM_HIGH = 0x5d;
var CMOS_BIOS_SMP_COUNT = 0x5f;

/**
 * RTC (real time clock) and CMOS
 * @constructor
 * @param {CPU} cpu
 */
function RTC(cpu)
{
    /** @const */
    this.cpu = cpu;

    /** @const */
    this.pic = cpu.devices.pic;

    this.cmos_index = 0;
    this.cmos_data = new Uint8Array(256);

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

    cpu.io.register_write(0x71, this, this.cmos_port_write);
    cpu.io.register_read(0x71, this, this.cmos_port_read);

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
RTC.prototype.cmos_port_read = function()
{
    var index = this.cmos_index;

    //this.cmos_index = 0xD;

    switch(index)
    {
        case CMOS_RTC_SECONDS:
            return this.encode_time(new Date(this.rtc_time).getUTCSeconds());
        case CMOS_RTC_MINUTES:
            return this.encode_time(new Date(this.rtc_time).getUTCMinutes());
        case CMOS_RTC_HOURS:
            // TODO: 12 hour mode
            return this.encode_time(new Date(this.rtc_time).getUTCHours());
        case CMOS_RTC_DAY_MONTH:
            return this.encode_time(new Date(this.rtc_time).getUTCDate());
        case CMOS_RTC_MONTH:
            return this.encode_time(new Date(this.rtc_time).getUTCMonth() + 1);
        case CMOS_RTC_YEAR:
            return this.encode_time(new Date(this.rtc_time).getUTCFullYear() % 100);

        case CMOS_STATUS_A:
            return this.cmos_a;
        case CMOS_STATUS_B:
            //dbg_log("cmos read from index " + h(index));
            return this.cmos_b;

        case CMOS_STATUS_C:
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

        case CMOS_STATUS_D:
            return 0xFF;

        case CMOS_CENTURY:
            return this.encode_time(new Date(this.rtc_time).getUTCFullYear() / 100 | 0);

        default:
            dbg_log("cmos read from index " + h(index), LOG_RTC);
            return this.cmos_data[this.cmos_index];
    }
};

RTC.prototype.cmos_port_write = function(data_byte)
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

/**
 * @param {number} index
 * @param {number} value
 */
RTC.prototype.cmos_write = function(index, value)
{
    dbg_log("cmos " + h(index) + " <- " + h(value), LOG_RTC);
    this.cmos_data[index] = value;
};
