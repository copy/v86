"use strict";

// See Intel's System Programming Guide


/** @const */
var APIC_LOG_VERBOSE = false;

/** @const */
var APIC_ADDRESS = 0xFEE00000;

/** @const */
var APIC_TIMER_MODE_MASK = 3 << 17;

/** @const */
var APIC_TIMER_MODE_ONE_SHOT = 0;

/** @const */
var APIC_TIMER_MODE_PERIODIC = 1 << 17;

/** @const */
var APIC_TIMER_MODE_TSC = 2 << 17;


/** @const */
var DELIVERY_MODES = [
    "Fixed (0)",
    "Lowest Prio (1)",
    "SMI (2)",
    "Reserved (3)",
    "NMI (4)",
    "INIT (5)",
    "Reserved (6)",
    "ExtINT (7)",
];

/** @const */
var DESTINATION_MODES = ["physical", "logical"];


/**
 * @constructor
 * @param {CPU} cpu
 */
function APIC(cpu)
{
    /** @type {CPU} */
    this.cpu = cpu;

    this.apic_id = 0;

    this.timer_divider = 0;
    this.timer_divider_shift = 1;
    this.timer_initial_count = 0;
    this.timer_current_count = 0;

    this.next_tick = v86.microtick();

    this.lvt_timer = IOAPIC_CONFIG_MASKED;
    this.lvt_perf_counter = IOAPIC_CONFIG_MASKED;
    this.lvt_int0 = IOAPIC_CONFIG_MASKED;
    this.lvt_int1 = IOAPIC_CONFIG_MASKED;
    this.lvt_error = IOAPIC_CONFIG_MASKED;

    this.tpr = 0;
    this.icr0 = 0;
    this.icr1 = 0;

    this.irr = new Int32Array(8);
    this.isr = new Int32Array(8);
    this.tmr = new Int32Array(8);

    this.spurious_vector = 0xFE;
    this.destination_format = -1;
    this.local_destination = 0;

    this.error = 0;
    this.read_error = 0;

    cpu.io.mmap_register(APIC_ADDRESS, 0x100000,
        (addr) =>
        {
            dbg_log("Unsupported read8 from apic: " + h(addr >>> 0), LOG_APIC);
            var off = addr & 3;
            addr &= ~3;
            return this.read32(addr) >> (off * 8) & 0xFF;
        },
        (addr, value) =>
        {
            dbg_log("Unsupported write8 from apic: " + h(addr) + " <- " + h(value), LOG_APIC);
            dbg_trace();
            dbg_assert(false);
        },
        (addr) => this.read32(addr),
        (addr, value) => this.write32(addr, value)
    );
}

APIC.prototype.read32 = function(addr)
{
    addr = addr - APIC_ADDRESS | 0;

    switch(addr)
    {
        case 0x20:
            dbg_log("APIC read id", LOG_APIC);
            return this.apic_id;

        case 0x30:
            // version
            dbg_log("APIC read version", LOG_APIC);
            return 0x50014;

        case 0x80:
            APIC_LOG_VERBOSE && dbg_log("APIC read tpr", LOG_APIC);
            return this.tpr;

        case 0xD0:
            dbg_log("Read local destination", LOG_APIC);
            return this.local_destination;

        case 0xE0:
            dbg_log("Read destination format", LOG_APIC);
            return this.destination_format;

        case 0xF0:
            return this.spurious_vector;

        case 0x100:
        case 0x110:
        case 0x120:
        case 0x130:
        case 0x140:
        case 0x150:
        case 0x160:
        case 0x170:
            var index = addr - 0x100 >> 4;
            dbg_log("Read isr " + index + ": " + h(this.isr[index] >>> 0, 8), LOG_APIC);
            return this.isr[index];

        case 0x180:
        case 0x190:
        case 0x1A0:
        case 0x1B0:
        case 0x1C0:
        case 0x1D0:
        case 0x1E0:
        case 0x1F0:
            var index = addr - 0x180 >> 4;
            dbg_log("Read tmr " + index + ": " + h(this.tmr[index] >>> 0, 8), LOG_APIC);
            return this.tmr[index];

        case 0x200:
        case 0x210:
        case 0x220:
        case 0x230:
        case 0x240:
        case 0x250:
        case 0x260:
        case 0x270:
            var index = addr - 0x200 >> 4;
            dbg_log("Read irr " + index + ": " + h(this.irr[index] >>> 0, 8), LOG_APIC);
            return this.irr[index];

        case 0x280:
            dbg_log("Read error: " + h(this.read_error >>> 0, 8), LOG_APIC);
            return this.read_error;

        case 0x300:
            APIC_LOG_VERBOSE && dbg_log("APIC read icr0", LOG_APIC);
            return this.icr0;

        case 0x310:
            dbg_log("APIC read icr1", LOG_APIC);
            return this.icr1;

        case 0x320:
            dbg_log("read timer lvt", LOG_APIC);
            return this.lvt_timer;

        case 0x340:
            dbg_log("read lvt perf counter", LOG_APIC);
            return this.lvt_perf_counter;

        case 0x350:
            dbg_log("read lvt int0", LOG_APIC);
            return this.lvt_int0;

        case 0x360:
            dbg_log("read lvt int1", LOG_APIC);
            return this.lvt_int1;

        case 0x370:
            dbg_log("read lvt error", LOG_APIC);
            return this.lvt_error;

        case 0x3E0:
            // divider
            dbg_log("read timer divider", LOG_APIC);
            return this.timer_divider;

        case 0x380:
            dbg_log("read timer initial count", LOG_APIC);
            return this.timer_initial_count;

        case 0x390:
            dbg_log("read timer current count: " + h(this.timer_current_count >>> 0, 8), LOG_APIC);
            return this.timer_current_count;

        default:
            dbg_log("APIC read " + h(addr), LOG_APIC);
            dbg_assert(false);
            return 0;
    }
};

APIC.prototype.write32 = function(addr, value)
{
    addr = addr - APIC_ADDRESS | 0;

    switch(addr)
    {
        case 0x20:
            dbg_log("APIC write id: " + h(value >>> 8, 8), LOG_APIC);
            this.apic_id = value;
            break;

        case 0x30:
            // version
            dbg_log("APIC write version: " + h(value >>> 0, 8) + ", ignored", LOG_APIC);
            break;

        case 0x80:
            APIC_LOG_VERBOSE && dbg_log("Set tpr: " + h(value & 0xFF, 2), LOG_APIC);
            this.tpr = value & 0xFF;
            this.check_vector();
            break;

        case 0xB0:
            var highest_isr = this.highest_isr();
            if(highest_isr !== -1)
            {
                APIC_LOG_VERBOSE && dbg_log("eoi: " + h(value >>> 0, 8) + " for vector " + h(highest_isr), LOG_APIC);
                this.register_clear_bit(this.isr, highest_isr);
                if(this.register_get_bit(this.tmr, highest_isr))
                {
                    // Send eoi to all IO APICs
                    this.cpu.devices.ioapic.remote_eoi(highest_isr);
                }
                this.check_vector();
            }
            else
            {
                dbg_log("Bad eoi: No isr set", LOG_APIC);
            }
            break;

        case 0xD0:
            dbg_log("Set local destination: " + h(value >>> 0, 8), LOG_APIC);
            this.local_destination = value & 0xFF000000;
            break;

        case 0xE0:
            dbg_log("Set destination format: " + h(value >>> 0, 8), LOG_APIC);
            this.destination_format = value | 0xFFFFFF;
            break;

        case 0xF0:
            dbg_log("Set spurious vector: " + h(value >>> 0, 8), LOG_APIC);
            this.spurious_vector = value;
            break;

        case 0x280:
            // updated readable error register with real error
            dbg_log("Write error: " + h(value >>> 0, 8), LOG_APIC);
            this.read_error = this.error;
            this.error = 0;
            break;

        case 0x300:
            var vector = value & 0xFF;
            var delivery_mode = value >> 8 & 7;
            var destination_mode = value >> 11 & 1;
            var is_level = value >> 15 & 1;
            var destination_shorthand = value >> 18 & 3;
            var destination = this.icr1 >>> 24;
            dbg_log("APIC write icr0: " + h(value, 8) + " vector=" + h(vector, 2) + " " +
                    "destination_mode=" + DESTINATION_MODES[destination_mode] + " delivery_mode=" + DELIVERY_MODES[delivery_mode] + " " +
                    "destination_shorthand=" + ["no", "self", "all with self", "all without self"][destination_shorthand], LOG_APIC);

            value &= ~(1 << 12);
            this.icr0 = value;

            if(destination_shorthand === 0)
            {
                // no shorthand
                this.route(vector, delivery_mode, is_level, destination, destination_mode);
            }
            else if(destination_shorthand === 1)
            {
                // self
                this.deliver(vector, IOAPIC_DELIVERY_FIXED, is_level);
            }
            else if(destination_shorthand === 2)
            {
                // all including self
                this.deliver(vector, delivery_mode, is_level);
            }
            else if(destination_shorthand === 3)
            {
                // all but self
            }
            else
            {
                dbg_assert(false);
            }
            break;

        case 0x310:
            dbg_log("APIC write icr1: " + h(value >>> 0, 8), LOG_APIC);
            this.icr1 = value;
            break;

        case 0x320:
            dbg_log("timer lvt: " + h(value >>> 0, 8), LOG_APIC);
            this.lvt_timer = value;
            break;

        case 0x340:
            dbg_log("lvt perf counter: " + h(value >>> 0, 8), LOG_APIC);
            this.lvt_perf_counter = value;
            break;

        case 0x350:
            dbg_log("lvt int0: " + h(value >>> 0, 8), LOG_APIC);
            this.lvt_int0 = value;
            break;

        case 0x360:
            dbg_log("lvt int1: " + h(value >>> 0, 8), LOG_APIC);
            this.lvt_int1 = value;
            break;

        case 0x370:
            dbg_log("lvt error: " + h(value >>> 0, 8), LOG_APIC);
            this.lvt_error = value;
            break;

        case 0x3E0:
            dbg_log("timer divider: " + h(value >>> 0, 8), LOG_APIC);
            this.timer_divider = value;

            var divide_shift = value & 0b11 | (value & 0b1000) >> 1;
            this.timer_divider_shift = divide_shift === 0b111 ? 0 : divide_shift + 1;
            break;

        case 0x380:
            dbg_log("timer initial: " + h(value >>> 0, 8), LOG_APIC);
            this.timer_initial_count = value >>> 0;
            this.timer_current_count = value >>> 0;

            this.next_tick = v86.microtick();
            this.timer_active = true;
            break;

        case 0x390:
            dbg_log("timer current: " + h(value >>> 0, 8), LOG_APIC);
            dbg_assert(false, "read-only register");
            break;

        default:
            dbg_log("APIC write32 " + h(addr) + " <- " + h(value >>> 0, 8), LOG_APIC);
            dbg_assert(false);
    }
};

APIC.prototype.timer = function(now)
{
    if(this.timer_current_count === 0)
    {
        return 100;
    }

    const freq = APIC_TIMER_FREQ / (1 << this.timer_divider_shift);

    const steps = (now - this.next_tick) * freq >>> 0;

    this.next_tick += steps / freq;
    this.timer_current_count -= steps;

    if(this.timer_current_count <= 0)
    {
        var mode = this.lvt_timer & APIC_TIMER_MODE_MASK;

        if(mode === APIC_TIMER_MODE_PERIODIC)
        {
            this.timer_current_count = this.timer_current_count % this.timer_initial_count;

            if(this.timer_current_count <= 0)
            {
                this.timer_current_count += this.timer_initial_count;
            }
            dbg_assert(this.timer_current_count !== 0);

            if((this.lvt_timer & IOAPIC_CONFIG_MASKED) === 0)
            {
                this.deliver(this.lvt_timer & 0xFF, IOAPIC_DELIVERY_FIXED, false);
            }
        }
        else if(mode === APIC_TIMER_MODE_ONE_SHOT)
        {
            this.timer_current_count = 0;
            dbg_log("APIC timer one shot end", LOG_APIC);

            if((this.lvt_timer & IOAPIC_CONFIG_MASKED) === 0)
            {
                this.deliver(this.lvt_timer & 0xFF, IOAPIC_DELIVERY_FIXED, false);
            }
        }
    }

    return Math.max(0, this.timer_current_count / freq);
};

APIC.prototype.route = function(vector, mode, is_level, destination, destination_mode)
{
    // TODO
    this.deliver(vector, mode, is_level);
};

APIC.prototype.deliver = function(vector, mode, is_level)
{
    APIC_LOG_VERBOSE && dbg_log("Deliver " + h(vector, 2) + " mode=" + mode + " level=" + is_level, LOG_APIC);

    if(mode === IOAPIC_DELIVERY_INIT)
    {
        // TODO
        return;
    }

    if(mode === IOAPIC_DELIVERY_NMI)
    {
        // TODO
        return;
    }

    if(vector < 0x10 || vector === 0xFF)
    {
        dbg_assert(false, "TODO: Invalid vector");
    }

    if(this.register_get_bit(this.irr, vector))
    {
        dbg_log("Not delivered: irr already set, vector=" + h(vector, 2), LOG_APIC);
        return;
    }

    this.register_set_bit(this.irr, vector);

    if(is_level)
    {
        this.register_set_bit(this.tmr, vector);
    }
    else
    {
        this.register_clear_bit(this.tmr, vector);
    }

    this.check_vector();
};

APIC.prototype.highest_irr = function()
{
    var highest = this.register_get_highest_bit(this.irr);
    dbg_assert(highest !== 0xFF);
    dbg_assert(highest >= 0x10 || highest === -1);
    return highest;
};

APIC.prototype.highest_isr = function()
{
    var highest = this.register_get_highest_bit(this.isr);
    dbg_assert(highest !== 0xFF);
    dbg_assert(highest >= 0x10 || highest === -1);
    return highest;
};

APIC.prototype.check_vector = function()
{
    var highest_irr = this.highest_irr();

    if(highest_irr === -1)
    {
        return;
    }

    var highest_isr = this.highest_isr();

    if(highest_isr >= highest_irr)
    {
        APIC_LOG_VERBOSE && dbg_log("Higher isr, isr=" + h(highest_isr) + " irr=" + h(highest_irr), LOG_APIC);
        return;
    }

    if((highest_irr & 0xF0) <= (this.tpr & 0xF0))
    {
        APIC_LOG_VERBOSE && dbg_log("Higher tpr, tpr=" + h(this.tpr & 0xF0) + " irr=" + h(highest_irr), LOG_APIC);
        return;
    }

    this.cpu.handle_irqs();
};

APIC.prototype.acknowledge_irq = function()
{
    var highest_irr = this.highest_irr();

    if(highest_irr === -1)
    {
        //dbg_log("Spurious", LOG_APIC);
        return -1;
    }

    var highest_isr = this.highest_isr();

    if(highest_isr >= highest_irr)
    {
        APIC_LOG_VERBOSE && dbg_log("Higher isr, isr=" + h(highest_isr) + " irr=" + h(highest_irr), LOG_APIC);
        return -1;
    }

    if((highest_irr & 0xF0) <= (this.tpr & 0xF0))
    {
        APIC_LOG_VERBOSE && dbg_log("Higher tpr, tpr=" + h(this.tpr & 0xF0) + " irr=" + h(highest_irr), LOG_APIC);
        return -1;
    }

    this.register_clear_bit(this.irr, highest_irr);
    this.register_set_bit(this.isr, highest_irr);

    APIC_LOG_VERBOSE && dbg_log("Calling vector " + h(highest_irr), LOG_APIC);

    this.check_vector();

    return highest_irr;
};

APIC.prototype.get_state = function()
{
    var state = [];

    state[0] = this.apic_id;
    state[1] = this.timer_divider;
    state[2] = this.timer_divider_shift;
    state[3] = this.timer_initial_count;
    state[4] = this.timer_current_count;
    state[5] = this.next_tick;
    state[6] = this.lvt_timer;
    state[7] = this.lvt_perf_counter;
    state[8] = this.lvt_int0;
    state[9] = this.lvt_int1;
    state[10] = this.lvt_error;
    state[11] = this.tpr;
    state[12] = this.icr0;
    state[13] = this.icr1;
    state[14] = this.irr;
    state[15] = this.isr;
    state[16] = this.tmr;
    state[17] = this.spurious_vector;
    state[18] = this.destination_format;
    state[19] = this.local_destination;
    state[20] = this.error;
    state[21] = this.read_error;

    return state;
};

APIC.prototype.set_state = function(state)
{
    this.apic_id = state[0];
    this.timer_divider = state[1];
    this.timer_divider_shift = state[2];
    this.timer_initial_count = state[3];
    this.timer_current_count = state[4];
    this.next_tick = state[5];
    this.lvt_timer = state[6];
    this.lvt_perf_counter = state[7];
    this.lvt_int0 = state[8];
    this.lvt_int1 = state[9];
    this.lvt_error = state[10];
    this.tpr = state[11];
    this.icr0 = state[12];
    this.icr1 = state[13];
    this.irr = state[14];
    this.isr = state[15];
    this.tmr = state[16];
    this.spurious_vector = state[17];
    this.destination_format = state[18];
    this.local_destination = state[19];
    this.error = state[20];
    this.read_error = state[21];
};

// functions operating on 256-bit registers (for irr, isr, tmr)
APIC.prototype.register_get_bit = function(v, bit)
{
    dbg_assert(bit >= 0 && bit < 256);
    return v[bit >> 5] >> (bit & 31) & 1;
};

APIC.prototype.register_set_bit = function(v, bit)
{
    dbg_assert(bit >= 0 && bit < 256);
    v[bit >> 5] |= 1 << (bit & 31);
};

APIC.prototype.register_clear_bit = function(v, bit)
{
    dbg_assert(bit >= 0 && bit < 256);
    v[bit >> 5] &= ~(1 << (bit & 31));
};

APIC.prototype.register_get_highest_bit = function(v)
{
    for(var i = 7; i >= 0; i--)
    {
        var word = v[i];

        if(word)
        {
            return v86util.int_log2(word >>> 0) | i << 5;
        }
    }

    return -1;
};
