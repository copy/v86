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
    this.rtc = cpu.rtc_new();

    cpu.io.register_write(0x70, this, function(out_byte) {
        this.cpu.port_70_write(this.rtc, out_byte & 0x7F);
    });

    cpu.io.register_write(0x71, this, function(value) {
        this.cpu.port_71_write(this.rtc, value);
    });

    cpu.io.register_read(0x71, this, function() {
        return this.cpu.port_71_read(this.rtc);
    });
}

RTC.prototype.get_state = function()
{
    var state = [];

    state[0] = this.rtc;

    return state;
};

RTC.prototype.set_state = function(state)
{
    this.rtc = state[0];
};

RTC.prototype.timer = function (time, legacy_mode) {
    this.cpu.rtc_timer(this.rtc);
};

/**
 * @param {number} index
 */
RTC.prototype.cmos_read = function(index)
{
    return this.cpu.cmos_read(this.rtc, index);
};

/**
 * @param {number} index
 * @param {number} value
 */
RTC.prototype.cmos_write = function(index, value)
{
    this.cpu.cmos_write(this.rtc, index, value);
};
