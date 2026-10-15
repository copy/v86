// The High Precision Event Timer of the Q35 machine's ICH9 (settings.hpet):
// a 64-bit main counter at 14.31818 MHz and three timers at 0xFED00000.
// IA-PC HPET (High Precision Event Timers) Specification 1.0a.
//
// Each timer compares the main counter with its comparator, one-shot or
// periodic, in 64-bit or 32-bit mode, and interrupts edge or level
// triggered: through an FSB message (MSI), the legacy replacement route
// (timer 0 on IRQ 0, timer 1 on IRQ 8; the PIT and the RTC then no longer
// reach those), or an I/O APIC input (20-23, as ICH9's). As in QEMU, FSB
// delivery goes before the legacy replacement route: Windows sets both, and
// takes its clock interrupt from timer 0's message. The comparator and
// period registers behave as QEMU's (hw/timer/hpet.c): in periodic mode a
// comparator write sets the period, and with Tn_VAL_SET_CNF the comparator
// (a 64-bit timer's Tn_VAL_SET_CNF clears after its upper half is written).
// The ACPI HPET table and a PNP0103 device describe it (acpi_tables.js).

import { LOG_PIT } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";

export const HPET_ADDRESS = 0xFED00000;
export const HPET_SIZE = 0x400;
/** The main counter's period in femtoseconds: 14.31818 MHz */
const PERIOD_FS = 69841279;
const TICKS_PER_MS = 1e12 / PERIOD_FS;
const TIMER_COUNT = 3;

/**
 * GCAP_ID bits 31:0, also the ACPI HPET table's event timer block ID:
 * revision 1, three timers, 64-bit counter, legacy replacement route
 * capable, vendor Intel
 */
export const HPET_BLOCK_ID = 0x8086A201;

const GCAP_ID = 0x000;
const GEN_CONF = 0x010;
const GINTR_STA = 0x020;
const MAIN_CNT = 0x0F0;
const TIMER_BASE = 0x100;
const TIMER_STRIDE = 0x20;
const TN_CONF = 0x00;
const TN_COMPARATOR = 0x08;
const TN_FSB_ROUTE = 0x10;

const ENABLE_CNF = 1 << 0;
const LEG_RT_CNF = 1 << 1;

const TN_INT_TYPE_LEVEL = 1 << 1;
const TN_INT_ENB = 1 << 2;
const TN_TYPE_PERIODIC = 1 << 3;
const TN_PER_INT_CAP = 1 << 4;
const TN_SIZE_CAP = 1 << 5;
const TN_VAL_SET = 1 << 6;
const TN_32MODE = 1 << 8;
const TN_INT_ROUTE_SHIFT = 9;
const TN_FSB_EN = 1 << 14;
const TN_FSB_INT_DEL_CAP = 1 << 15;
/** Software-writable bits of Tn_CONF_CAP (31:0) */
const TN_CONF_WRITABLE = TN_INT_TYPE_LEVEL | TN_INT_ENB | TN_TYPE_PERIODIC | TN_VAL_SET | TN_32MODE |
    0x1F << TN_INT_ROUTE_SHIFT | TN_FSB_EN;
/** Tn_INT_ROUTE_CAP (Tn_CONF_CAP 63:32): I/O APIC inputs 20-23, as on ICH9 */
const TN_INT_ROUTE_CAP = 0x00F00000;

const STATE_FORMAT = 1;

/** The source of timer n on a shared I/O APIC input is HPET_SOURCE + n (beyond any pci_id) */
const HPET_SOURCE = 0x10000;

/**
 * @constructor
 * @param {CPU} cpu
 */
export function HPET(cpu)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    this.name = "hpet";

    this.config = 0;
    /** GINTR_STA: level-triggered interrupts active */
    this.isr = 0;
    /** The main counter: its value at base_time (clock ms); it counts while enabled */
    this.counter_base = 0;
    this.base_time = 0;

    /**
     * Comparator and period as 32-bit halves (the comparator resets to all
     * ones, beyond what a double holds exactly); deadline: the main counter
     * value of the next match
     * @type {!Array<{config: number, comparator: !Uint32Array, period: !Uint32Array, fsb_value: number,
     *     fsb_address: number, deadline: number, line: ?{irq: number, gsi: number}}>}
     */
    this.timers = [];
    for(let i = 0; i < TIMER_COUNT; i++)
    {
        this.timers.push({ config: 0, comparator: new Uint32Array(2), period: new Uint32Array(2),
            fsb_value: 0, fsb_address: 0, deadline: Infinity, line: null });
    }

    cpu.io.mmap_register_range(HPET_ADDRESS, HPET_SIZE, this,
        addr => {
            this.note_read();
            return this.read32(addr - HPET_ADDRESS & ~3) >>> ((addr & 3) << 3) & 0xFF;
        },
        (addr, value) => {
            const shift = (addr & 3) << 3;
            const offset = addr - HPET_ADDRESS & ~3;
            // (the other bytes as they are; of the write-one-to-clear status, none)
            const others = (offset & ~4) === GINTR_STA ? 0 : this.read32(offset) & ~(0xFF << shift);
            this.write32(offset, others | (value & 0xFF) << shift);
        },
        addr => {
            this.note_read();
            return this.read32(addr - HPET_ADDRESS);
        },
        (addr, value) => this.write32(addr - HPET_ADDRESS, value));

    this.reset();
}

/** A register read, for the step profile (docs/jit-unification-plan.md P4.0: what QueryPerformanceCounter reads) */
HPET.prototype.note_read = function()
{
    const note = this.cpu.wm?.exports["step_profile_note_event"];
    if(note) note(10, 0); // step_profile::event::HPET_READ
};

HPET.prototype.reset = function()
{
    for(let i = 0; i < TIMER_COUNT; i++)
    {
        this.set_line(i, false);
    }
    this.config = 0;
    this.isr = 0;
    this.counter_base = 0;
    this.base_time = 0;
    this.timers.forEach(timer => {
        timer.config = 0;
        timer.comparator.fill(0xFFFFFFFF);
        timer.period.fill(0);
        timer.fsb_value = 0;
        timer.fsb_address = 0;
        timer.deadline = Infinity;
    });
};

/** Legacy replacement route: the PIT does not reach IRQ 0, the RTC not IRQ 8 */
HPET.prototype.legacy_replacement = function()
{
    return (this.config & LEG_RT_CNF) !== 0;
};

/**
 * The main counter
 * @param {number} now machine clock, ms
 * @return {number}
 */
HPET.prototype.counter = function(now)
{
    if(!(this.config & ENABLE_CNF))
    {
        return this.counter_base;
    }
    return this.counter_base + Math.floor((now - this.base_time) * TICKS_PER_MS);
};

/**
 * 2^64, or 2^32 for a timer in 32-bit mode
 * @param {Object} timer
 * @return {number}
 */
HPET.prototype.width = function(timer)
{
    return timer.config & TN_32MODE ? 0x100000000 : 0x10000000000000000;
};

/**
 * A 64-bit register's halves as a number (exact below 2^53)
 * @param {!Uint32Array} halves
 * @return {number}
 */
function value64(halves)
{
    return halves[1] * 0x100000000 + halves[0];
}

/**
 * @param {!Uint32Array} halves
 * @param {number} value below 2^64
 */
function set64(halves, value)
{
    halves[0] = value % 0x100000000;
    halves[1] = Math.floor(value / 0x100000000) % 0x100000000;
}

/**
 * The next counter value at which a timer matches: where the counter (in
 * the timer's width) reaches its comparator
 * @param {number} i
 * @param {number} counter
 */
HPET.prototype.arm = function(i, counter)
{
    const timer = this.timers[i];
    if(!(this.config & ENABLE_CNF))
    {
        timer.deadline = Infinity;
        return;
    }
    const width = this.width(timer);
    let delta = value64(timer.comparator) - counter % width;
    if(delta < 0)
    {
        delta += width;
    }
    timer.deadline = counter + delta;
};

/**
 * Comparator matches up to now: interrupts, periodic timers move their
 * comparator on (missed periods coalesce)
 * @param {number} now machine clock, ms
 * @return {number} ms until the next match (at most 100)
 */
HPET.prototype.timer = function(now)
{
    if(!(this.config & ENABLE_CNF))
    {
        return 100;
    }
    const counter = this.counter(now);
    let next = Infinity;
    for(let i = 0; i < TIMER_COUNT; i++)
    {
        const timer = this.timers[i];
        if(timer.deadline <= counter)
        {
            this.fire(i);
            const width = this.width(timer);
            const period = value64(timer.period);
            if(timer.config & TN_TYPE_PERIODIC && period)
            {
                const periods = Math.floor((counter - timer.deadline) / period) + 1;
                timer.deadline += periods * period;
                set64(timer.comparator, (value64(timer.comparator) + periods * period) % width);
            }
            else
            {
                // (one-shot: again when the counter comes round)
                timer.deadline += width;
            }
        }
        next = Math.min(next, timer.deadline);
    }
    return Math.min(100, Math.max(0, (next - counter) / TICKS_PER_MS));
};

/**
 * A comparator match: the timer's interrupt, if enabled
 * @param {number} i
 */
HPET.prototype.fire = function(i)
{
    const timer = this.timers[i];
    if(!(timer.config & TN_INT_ENB))
    {
        return;
    }
    if(timer.config & TN_INT_TYPE_LEVEL && !this.fsb(i))
    {
        this.isr |= 1 << i;
        this.set_line(i, true);
    }
    else
    {
        // an edge
        this.set_line(i, true);
        this.set_line(i, false);
    }
};

/**
 * @param {number} i
 * @return {boolean} whether the timer interrupts by FSB messages (also
 * timers 0 and 1 with the legacy replacement route)
 */
HPET.prototype.fsb = function(i)
{
    return (this.timers[i].config & TN_FSB_EN) !== 0;
};

/**
 * The line a timer interrupts on: legacy replacement (timers 0 and 1: IRQ 0
 * and 8, PIC and I/O APIC), or the I/O APIC input of its route; null for
 * FSB delivery or a route it does not have
 * @param {number} i
 * @return {?{irq: number, gsi: number}}
 */
HPET.prototype.route = function(i)
{
    if(this.fsb(i))
    {
        return null;
    }
    if(this.config & LEG_RT_CNF && i < 2)
    {
        return { irq: i === 0 ? 0 : 8, gsi: -1 };
    }
    const gsi = this.timers[i].config >> TN_INT_ROUTE_SHIFT & 0x1F;
    return TN_INT_ROUTE_CAP & 1 << gsi ? { irq: -1, gsi } : null;
};

/**
 * Drive a timer's interrupt: its line (released where it was asserted), or
 * for FSB delivery a message on the rising edge
 * @param {number} i
 * @param {boolean} level
 */
HPET.prototype.set_line = function(i, level)
{
    const timer = this.timers[i];
    if(level)
    {
        if(this.fsb(i))
        {
            this.cpu.apic_msi && this.cpu.apic_msi(timer.fsb_address | 0, timer.fsb_value | 0);
            return;
        }
        const line = this.route(i);
        if(!line)
        {
            return;
        }
        if(timer.line && timer.line.irq === line.irq && timer.line.gsi === line.gsi)
        {
            // (already asserted there)
            return;
        }
        if(timer.line)
        {
            this.set_line(i, false);
        }
        timer.line = line;
        if(line.irq >= 0)
        {
            this.cpu.device_raise_irq(line.irq);
        }
        else
        {
            this.cpu.set_shared_gsi_level(line.gsi, HPET_SOURCE + i, true);
        }
    }
    else if(timer.line)
    {
        const line = timer.line;
        timer.line = null;
        if(line.irq >= 0)
        {
            this.cpu.device_lower_irq(line.irq);
        }
        else
        {
            this.cpu.set_shared_gsi_level(line.gsi, HPET_SOURCE + i, false);
        }
    }
};

/**
 * Level-triggered interrupts follow the status and the configuration: an
 * active one moves with its route or ends when disabled
 * @param {number} i
 */
HPET.prototype.update_level = function(i)
{
    const timer = this.timers[i];
    const active = (this.isr & 1 << i) !== 0 && (timer.config & (TN_INT_ENB | TN_INT_TYPE_LEVEL)) === (TN_INT_ENB | TN_INT_TYPE_LEVEL) &&
        !this.fsb(i);
    if(!active)
    {
        this.set_line(i, false);
    }
    else
    {
        this.set_line(i, true);
    }
};

/**
 * @param {number} offset
 * @return {number}
 */
HPET.prototype.read32 = function(offset)
{
    offset >>>= 0;
    const high = (offset & 4) !== 0;
    let value = 0;

    if(offset >= TIMER_BASE && offset < TIMER_BASE + TIMER_COUNT * TIMER_STRIDE)
    {
        const timer = this.timers[offset - TIMER_BASE >> 5];
        switch(offset & (TIMER_STRIDE - 1) & ~4)
        {
            case TN_CONF:
                value = high ? TN_INT_ROUTE_CAP :
                    timer.config | TN_PER_INT_CAP | TN_SIZE_CAP | TN_FSB_INT_DEL_CAP;
                break;
            case TN_COMPARATOR:
                value = timer.comparator[high ? 1 : 0];
                break;
            case TN_FSB_ROUTE:
                value = high ? timer.fsb_address : timer.fsb_value;
                break;
        }
    }
    else
    {
        switch(offset & ~4)
        {
            case GCAP_ID:
                value = high ? PERIOD_FS : HPET_BLOCK_ID;
                break;
            case GEN_CONF:
                value = high ? 0 : this.config;
                break;
            case GINTR_STA:
                value = high ? 0 : this.isr;
                break;
            case MAIN_CNT:
            {
                const counter = this.counter(this.cpu.clock.now());
                value = high ? Math.floor(counter / 0x100000000) : counter % 0x100000000;
                break;
            }
        }
    }
    return value | 0;
};

/**
 * @param {number} offset
 * @param {number} value
 */
HPET.prototype.write32 = function(offset, value)
{
    offset >>>= 0;
    value >>>= 0;
    const high = (offset & 4) !== 0;
    const now = this.cpu.clock.now();
    const counter = this.counter(now);
    dbg_log("HPET write " + h(offset, 3) + " <- " + h(value, 8), LOG_PIT);

    if(offset >= TIMER_BASE && offset < TIMER_BASE + TIMER_COUNT * TIMER_STRIDE)
    {
        const i = offset - TIMER_BASE >> 5;
        const timer = this.timers[i];
        switch(offset & (TIMER_STRIDE - 1) & ~4)
        {
            case TN_CONF:
                if(!high)
                {
                    timer.config = value & TN_CONF_WRITABLE;
                    if(timer.config & TN_32MODE)
                    {
                        timer.comparator[1] = timer.period[1] = 0;
                    }
                    this.update_level(i);
                    this.arm(i, counter);
                }
                break;
            case TN_COMPARATOR:
            {
                if(high && timer.config & TN_32MODE)
                {
                    break;
                }
                const half = high ? 1 : 0;
                if(!(timer.config & TN_TYPE_PERIODIC) || timer.config & TN_VAL_SET)
                {
                    timer.comparator[half] = value;
                }
                if(timer.config & TN_TYPE_PERIODIC)
                {
                    timer.period[half] = value;
                }
                // (cleared by the write of the last half: the upper one in 64-bit mode)
                if(high || timer.config & TN_32MODE)
                {
                    timer.config &= ~TN_VAL_SET;
                }
                this.arm(i, counter);
                break;
            }
            case TN_FSB_ROUTE:
                if(high) timer.fsb_address = value;
                else timer.fsb_value = value;
                break;
        }
        return;
    }

    switch(offset & ~4)
    {
        case GEN_CONF:
            if(!high)
            {
                const old = this.config;
                this.config = value & (ENABLE_CNF | LEG_RT_CNF);
                if((old ^ this.config) & ENABLE_CNF)
                {
                    // the counter stops where it is, or goes on from there
                    this.counter_base = counter;
                    this.base_time = now;
                    for(let i = 0; i < TIMER_COUNT; i++) this.arm(i, counter);
                }
                if((old ^ this.config) & LEG_RT_CNF)
                {
                    dbg_log("HPET: legacy replacement route " + (this.config & LEG_RT_CNF ? "on" : "off"), LOG_PIT);
                    // timers 0 and 1 change lines; the PIT and the RTC lose
                    // or get back IRQ 0 and 8
                    this.set_line(0, false);
                    this.set_line(1, false);
                    this.cpu.device_lower_irq(0);
                    this.cpu.device_lower_irq(8);
                    this.update_level(0);
                    this.update_level(1);
                }
            }
            break;
        case GINTR_STA:
            if(!high)
            {
                // write one to clear (level-triggered interrupts)
                this.isr &= ~value;
                for(let i = 0; i < TIMER_COUNT; i++) this.update_level(i);
            }
            break;
        case MAIN_CNT:
            // (only while the counter is stopped)
            if(!(this.config & ENABLE_CNF))
            {
                this.counter_base = high ?
                    this.counter_base % 0x100000000 + value * 0x100000000 :
                    Math.floor(this.counter_base / 0x100000000) * 0x100000000 + value;
            }
            break;
    }
};

HPET.prototype.get_state = function()
{
    const state = [];
    state[0] = STATE_FORMAT;
    state[1] = this.config;
    state[2] = this.isr;
    state[3] = this.counter_base;
    state[4] = this.base_time;
    state[5] = this.timers.map(t => [t.config, t.comparator[0], t.comparator[1], t.period[0], t.period[1],
        t.fsb_value, t.fsb_address, t.deadline === Infinity ? -1 : t.deadline,
        t.line ? t.line.irq : -2, t.line ? t.line.gsi : -2]);
    return state;
};

HPET.prototype.set_state = function(state)
{
    this.config = state[1];
    this.isr = state[2];
    this.counter_base = state[3];
    this.base_time = state[4];
    state[5].forEach((s, i) => {
        const timer = this.timers[i];
        timer.config = s[0];
        timer.comparator.set([s[1], s[2]]);
        timer.period.set([s[3], s[4]]);
        timer.fsb_value = s[5];
        timer.fsb_address = s[6];
        timer.deadline = s[7] === -1 ? Infinity : s[7];
        // (the interrupt controllers restore the lines themselves)
        timer.line = s[8] === -2 ? null : { irq: s[8], gsi: s[9] };
    });
};
