import { v86 } from "./main.js";
import { LOG_RTC } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { DMA } from "./dma.js";


export const CMOS_RTC_SECONDS = 0x00;
export const CMOS_RTC_SECONDS_ALARM = 0x01;
export const CMOS_RTC_MINUTES = 0x02;
export const CMOS_RTC_MINUTES_ALARM = 0x03;
export const CMOS_RTC_HOURS = 0x04;
export const CMOS_RTC_HOURS_ALARM = 0x05;
export const CMOS_RTC_DAY_WEEK = 0x06;
export const CMOS_RTC_DAY_MONTH = 0x07;
export const CMOS_RTC_MONTH = 0x08;
export const CMOS_RTC_YEAR = 0x09;
export const CMOS_STATUS_A = 0x0a;
export const CMOS_STATUS_B = 0x0b;
export const CMOS_STATUS_C = 0x0c;
export const CMOS_STATUS_D = 0x0d;
export const CMOS_DIAG_STATUS = 0x0e;
export const CMOS_RESET_CODE = 0x0f;

export const CMOS_FLOPPY_DRIVE_TYPE = 0x10;
export const CMOS_DISK_DATA = 0x12;
export const CMOS_EQUIPMENT_INFO = 0x14;
export const CMOS_MEM_BASE_LOW = 0x15;
export const CMOS_MEM_BASE_HIGH = 0x16;
export const CMOS_MEM_OLD_EXT_LOW = 0x17;
export const CMOS_MEM_OLD_EXT_HIGH = 0x18;
export const CMOS_DISK_DRIVE1_TYPE = 0x19;
export const CMOS_DISK_DRIVE2_TYPE = 0x1a;
export const CMOS_DISK_DRIVE1_CYL = 0x1b;
export const CMOS_DISK_DRIVE2_CYL = 0x24;
export const CMOS_MEM_EXTMEM_LOW = 0x30;
export const CMOS_MEM_EXTMEM_HIGH = 0x31;
export const CMOS_CENTURY = 0x32;
export const CMOS_MEM_EXTMEM2_LOW = 0x34;
export const CMOS_MEM_EXTMEM2_HIGH = 0x35;
export const CMOS_CENTURY2 = 0x37;
export const CMOS_BIOS_BOOTFLAG1 = 0x38;
export const CMOS_BIOS_DISKTRANSFLAG = 0x39;
export const CMOS_BIOS_BOOTFLAG2 = 0x3d;
export const CMOS_MEM_HIGHMEM_LOW = 0x5b;
export const CMOS_MEM_HIGHMEM_MID = 0x5c;
export const CMOS_MEM_HIGHMEM_HIGH = 0x5d;
export const CMOS_BIOS_SMP_COUNT = 0x5f;

// see CPU.prototype.fill_cmos
export const BOOT_ORDER_CD_FIRST = 0x123;
export const BOOT_ORDER_HD_FIRST = 0x312;
export const BOOT_ORDER_FD_FIRST = 0x321;

/**
 * RTC (real time clock) and CMOS
 * @constructor
 * @param {CPU} cpu
 */
export function RTC(cpu)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    this.cmos_index = 0;
    this.cmos_data = new Uint8Array(128);

    // used for cmos entries
    this.rtc_time = Date.now();
    this.last_update = this.rtc_time;

    // used for periodic interrupt
    this.next_interrupt = 0;

    // next alarm interrupt
    this.next_interrupt_alarm = 0;

    this.periodic_interrupt = false;

    // corresponds to default value for cmos_a
    this.periodic_interrupt_time = 1000 / 1024;

    this.cmos_a = 0x26;
    this.cmos_b = 2;
    this.cmos_c = 0;

    this.cmos_diag_status = 0;

    this.nmi_disabled = 0;

    this.update_interrupt = false;
    this.update_interrupt_time = 0;

    cpu.io.register_write(0x70, this, function(out_byte)
    {
        this.cmos_index = out_byte & 0x7F;
        this.nmi_disabled = out_byte >> 7;
    });

    cpu.io.register_write(0x71, this, this.cmos_port_write);
    cpu.io.register_read(0x71, this, this.cmos_port_read);
}

RTC.prototype.get_state = function()
{
    var state = [];

    state[0] = this.cmos_index;
    state[1] = this.cmos_data;
    state[2] = this.rtc_time;
    state[3] = this.last_update;
    state[4] = this.next_interrupt;
    state[5] = this.next_interrupt_alarm;
    state[6] = this.periodic_interrupt;
    state[7] = this.periodic_interrupt_time;
    state[8] = this.cmos_a;
    state[9] = this.cmos_b;
    state[10] = this.cmos_c;
    state[11] = this.nmi_disabled;
    state[12] = this.update_interrupt;
    state[13] = this.update_interrupt_time;
    state[14] = this.cmos_diag_status;

    return state;
};

RTC.prototype.set_state = function(state)
{
    this.cmos_index = state[0];
    this.cmos_data = state[1];
    this.rtc_time = state[2];
    this.last_update = state[3];
    this.next_interrupt = state[4];
    this.next_interrupt_alarm = state[5];
    this.periodic_interrupt = state[6];
    this.periodic_interrupt_time = state[7];
    this.cmos_a = state[8];
    this.cmos_b = state[9];
    this.cmos_c = state[10];
    this.nmi_disabled = state[11];
    this.update_interrupt = state[12] || false;
    this.update_interrupt_time = state[13] || 0;
    this.cmos_diag_status = state[14] || 0;
};

RTC.prototype.timer = function(time, legacy_mode)
{
    time = Date.now(); // XXX
    this.rtc_time += time - this.last_update;
    this.last_update = time;

    if(this.periodic_interrupt && this.next_interrupt < time)
    {
        this.cpu.device_raise_irq(8);
        this.cmos_c |= 1 << 6 | 1 << 7;

        this.next_interrupt += this.periodic_interrupt_time *
                Math.ceil((time - this.next_interrupt) / this.periodic_interrupt_time);
    }
    else if(this.next_interrupt_alarm && this.next_interrupt_alarm < time)
    {
        this.cpu.device_raise_irq(8);
        this.cmos_c |= 1 << 5 | 1 << 7;

        this.next_interrupt_alarm = 0;
    }
    else if(this.update_interrupt && this.update_interrupt_time < time)
    {
        this.cpu.device_raise_irq(8);
        this.cmos_c |= 1 << 4 | 1 << 7;

        this.update_interrupt_time = time + 1000; // 1 second
    }

    let t = 100;

    if(this.periodic_interrupt && this.next_interrupt)
    {
        t = Math.min(t, Math.max(0, this.next_interrupt - time));
    }
    if(this.next_interrupt_alarm)
    {
        t = Math.min(t, Math.max(0, this.next_interrupt_alarm - time));
    }
    if(this.update_interrupt)
    {
        t = Math.min(t, Math.max(0, this.update_interrupt_time - time));
    }

    return t;
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

RTC.prototype.bcd_unpack = function(n)
{
    const low = n & 0xF;
    const high = n >> 4 & 0xF;

    dbg_assert(n < 0x100);
    dbg_assert(low < 10);
    dbg_assert(high < 10);

    return low + 10 * high;
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

RTC.prototype.decode_time = function(t)
{
    if(this.cmos_b & 4)
    {
        // binary mode
        return t;
    }
    else
    {
        return this.bcd_unpack(t);
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
            dbg_log("read second: " + h(this.encode_time(new Date(this.rtc_time).getUTCSeconds())), LOG_RTC);
            return this.encode_time(new Date(this.rtc_time).getUTCSeconds());
        case CMOS_RTC_MINUTES:
            dbg_log("read minute: " + h(this.encode_time(new Date(this.rtc_time).getUTCMinutes())), LOG_RTC);
            return this.encode_time(new Date(this.rtc_time).getUTCMinutes());
        case CMOS_RTC_HOURS:
            dbg_log("read hour: " + h(this.encode_time(new Date(this.rtc_time).getUTCHours())), LOG_RTC);
            // TODO: 12 hour mode
            return this.encode_time(new Date(this.rtc_time).getUTCHours());
        case CMOS_RTC_DAY_WEEK:
            dbg_log("read day: " + h(this.encode_time(new Date(this.rtc_time).getUTCDay() + 1)), LOG_RTC);
            return this.encode_time(new Date(this.rtc_time).getUTCDay() + 1);
        case CMOS_RTC_DAY_MONTH:
            dbg_log("read day of month: " + h(this.encode_time(new Date(this.rtc_time).getUTCDate())), LOG_RTC);
            return this.encode_time(new Date(this.rtc_time).getUTCDate());
        case CMOS_RTC_MONTH:
            dbg_log("read month: " + h(this.encode_time(new Date(this.rtc_time).getUTCMonth() + 1)), LOG_RTC);
            return this.encode_time(new Date(this.rtc_time).getUTCMonth() + 1);
        case CMOS_RTC_YEAR:
            dbg_log("read year: " + h(this.encode_time(new Date(this.rtc_time).getUTCFullYear() % 100)), LOG_RTC);
            return this.encode_time(new Date(this.rtc_time).getUTCFullYear() % 100);

        case CMOS_STATUS_A:
            if(v86.microtick() % 1000 >= 999)
            {
                // Set update-in-progress for one millisecond every second (we
                // may not have precision higher than that in browser
                // environments)
                return this.cmos_a | 0x80;
            }
            return this.cmos_a;
        case CMOS_STATUS_B:
            //dbg_log("cmos read from index " + h(index));
            return this.cmos_b;

        case CMOS_STATUS_C:
            // It is important to know that upon a IRQ 8, Status Register C
            // will contain a bitmask telling which interrupt happened.
            // What is important is that if register C is not read after an
            // IRQ 8, then the interrupt will not happen again.
            this.cpu.device_lower_irq(8);

            dbg_log("cmos reg C read", LOG_RTC);
            // Missing IRQF flag
            //return cmos_b & 0x70;
            var c = this.cmos_c;

            this.cmos_c &= ~0xF0;

            return c;

        case CMOS_STATUS_D:
            return 1 << 7; // CMOS battery charged

        case CMOS_DIAG_STATUS:
            dbg_log("cmos diagnostic status read", LOG_RTC);
            return this.cmos_diag_status;

        case CMOS_CENTURY:
        case CMOS_CENTURY2:
            dbg_log("read century: " + h(this.encode_time(new Date(this.rtc_time).getUTCFullYear() / 100 | 0)), LOG_RTC);
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
            if(this.cmos_b & 0x80)
            {
                // remove update interrupt flag
                this.cmos_b &= 0xEF;
            }
            if(this.cmos_b & 0x40)
            {
                this.next_interrupt = Date.now();
            }

            if(this.cmos_b & 0x20)
            {
                const now = new Date();

                const seconds = this.decode_time(this.cmos_data[CMOS_RTC_SECONDS_ALARM]);
                const minutes = this.decode_time(this.cmos_data[CMOS_RTC_MINUTES_ALARM]);
                const hours = this.decode_time(this.cmos_data[CMOS_RTC_HOURS_ALARM]);

                const alarm_date = new Date(Date.UTC(
                    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
                    hours, minutes, seconds
                ));

                const ms_from_now = alarm_date - now;
                dbg_log("RTC alarm scheduled for " + alarm_date +
                        " hh:mm:ss=" + hours + ":" + minutes + ":" + seconds +
                        " ms_from_now=" + ms_from_now, LOG_RTC);

                this.next_interrupt_alarm = +alarm_date;
            }

            if(this.cmos_b & 0x10)
            {
                dbg_log("update interrupt", LOG_RTC);
                this.update_interrupt_time = Date.now();
            }

            dbg_log("cmos b=" + h(this.cmos_b, 2), LOG_RTC);
            break;

        case CMOS_DIAG_STATUS:
            this.cmos_diag_status = data_byte;
            break;

        case CMOS_RTC_SECONDS_ALARM:
        case CMOS_RTC_MINUTES_ALARM:
        case CMOS_RTC_HOURS_ALARM:
            this.cmos_write(this.cmos_index, data_byte);
            break;

        default:
            dbg_log("cmos write index " + h(this.cmos_index) + ": " + h(data_byte), LOG_RTC);
    }

    this.update_interrupt = (this.cmos_b & 0x10) === 0x10 && (this.cmos_a & 0xF) > 0;
    this.periodic_interrupt = (this.cmos_b & 0x40) === 0x40 && (this.cmos_a & 0xF) > 0;
};

/**
 * @param {number} index
 */
RTC.prototype.cmos_read = function(index)
{
    dbg_assert(index < 128);
    return this.cmos_data[index];
};

/**
 * @param {number} index
 * @param {number} value
 */
RTC.prototype.cmos_write = function(index, value)
{
    dbg_log("cmos " + h(index) + " <- " + h(value), LOG_RTC);
    dbg_assert(index < 128);
    this.cmos_data[index] = value;
};
