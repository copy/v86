// The virt machine's PL031 real-time clock at 0x0901_0000
// (docs/arm64-virt-android16-plan.md P4.5), as the reference's (QEMU 9.2
// hw/rtc/pl031.c): seconds since the epoch from the machine clock's wall
// time (MachineClock.wall_time), the load register setting them, always
// enabled, an alarm (the match register) whose interrupt is SPI 2 (INTID
// 34, level-sensitive), and the PrimeCell identification.

import { VIRT_RTC } from "./platform.js";

const RTC_DR = 0x00;
const RTC_MR = 0x04;
const RTC_LR = 0x08;
const RTC_CR = 0x0C;
const RTC_IMSC = 0x10;
const RTC_RIS = 0x14;
const RTC_MIS = 0x18;
const RTC_ICR = 0x1C;

export const PL031_INTID = 34;

/** PeriphID0-3 (PL031) and PCellID0-3 at 0xFE0-0xFFC */
const ID = [0x31, 0x10, 0x14, 0x00, 0x0D, 0xF0, 0x05, 0xB1];

/**
 * @constructor
 * @param {Object} cpu the arm64 CPU (src/arm/cpu.js)
 * @param {number=} base the virt machine's, or the ranchu machine's
 * @param {number=} intid
 */
export function PL031(cpu, base = VIRT_RTC, intid = PL031_INTID)
{
    this.name = "pl031";
    this.cpu = cpu;
    this.intid = intid;
    this.reset();
    this.owner = cpu.io.register_mmio(base, 0x1000, {
        read: (offset, width) => this.read(offset),
        write: (offset, width, value) => this.write(offset, Number(value)),
        name: this.name,
    });
}

PL031.prototype.reset = function()
{
    // (seconds to add to the machine clock's wall time; the load register moves them)
    this.tick_offset = 0;
    this.mr = 0;
    this.lr = 0;
    this.im = 0;
    this.is = 0;
    /** the counter's value the alarm waits for, or -1 */
    this.alarm = -1;
    this.update();
};

/** The counter: seconds of wall time, as an unsigned 32-bit value */
PL031.prototype.count = function()
{
    return (Math.floor(this.cpu.clock.wall_time() / 1000) + this.tick_offset) >>> 0;
};

PL031.prototype.update = function()
{
    this.cpu.set_irq(this.intid, (this.is & this.im) !== 0);
};

PL031.prototype.set_alarm = function()
{
    if(this.mr === this.count())
    {
        this.alarm = -1;
        this.is = 1;
        this.update();
    }
    else
    {
        this.alarm = this.mr;
    }
};

/**
 * (the machine's timers) the alarm; milliseconds until it is next due
 * @return {number}
 */
PL031.prototype.timer = function()
{
    if(this.alarm < 0) return Infinity;
    const now = this.count();
    if(now === this.alarm || ((this.alarm - now) >>> 0) > 0x80000000)
    {
        this.alarm = -1;
        this.is = 1;
        this.update();
        return Infinity;
    }
    return 1000 * ((this.alarm - now) >>> 0);
};

PL031.prototype.read = function(offset)
{
    switch(offset)
    {
        case RTC_DR: return this.count();
        case RTC_MR: return this.mr;
        case RTC_IMSC: return this.im;
        case RTC_RIS: return this.is;
        case RTC_LR: return this.lr;
        case RTC_CR: return 1;
        case RTC_MIS: return this.is & this.im;
    }
    if(offset >= 0xFE0 && offset < 0x1000) return ID[offset - 0xFE0 >> 2];
    return 0;
};

PL031.prototype.write = function(offset, value)
{
    switch(offset)
    {
        case RTC_LR:
            this.lr = value >>> 0;
            this.tick_offset += (value >>> 0) - this.count();
            this.set_alarm();
            break;
        case RTC_MR:
            this.mr = value >>> 0;
            this.set_alarm();
            break;
        case RTC_IMSC: this.im = value & 1; this.update(); break;
        case RTC_ICR: this.is &= ~value; this.update(); break;
    }
};

PL031.prototype.get_state = function()
{
    return [this.tick_offset, this.mr, this.lr, this.im, this.is, this.alarm];
};

PL031.prototype.set_state = function(state)
{
    [this.tick_offset, this.mr, this.lr, this.im, this.is, this.alarm] = state;
    this.update();
};
