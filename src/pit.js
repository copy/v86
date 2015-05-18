"use strict";

/** 
 * @const 
 * In kHz
 */
var OSCILLATOR_FREQ = 1193.1816666; // 1.193182 MHz


/**
 * @constructor
 *
 * Programmable Interval Timer
 */
function PIT(cpu)
{
    /** @const */
    this.cpu = cpu;

    this.next_tick = Date.now();

    this.counter_next_low = new Uint8Array(4);
    this.counter_enabled = new Uint8Array(4);
    this.counter_mode = new Uint8Array(4);
    this.counter_read_mode = new Uint8Array(4);

    // 2 = latch low, 1 = latch high, 0 = no latch
    this.counter_latch = new Uint8Array(4);
    this.counter_latch_value = new Uint16Array(3);

    this.counter_reload = new Uint16Array(3);
    this.counter_current = new Uint16Array(3);

    // only counter2 output can be read
    this.counter2_start = 0;


    // TODO:
    // - counter2 can be controlled by an input

    cpu.io.register_read(0x61, this, function()
    {
        var now = v86.microtick();
        var ref_toggle = (now * (1000 * 1000 / 15000)) & 1;
        var counter2_out = (now - this.counter2_start) >= (this.counter_reload[2] / OSCILLATOR_FREQ);

        return ref_toggle << 4 | counter2_out << 5;
    });

    cpu.io.register_read(0x40, this, function() { return this.counter_read(0); });
    cpu.io.register_read(0x41, this, function() { return this.counter_read(1); });
    cpu.io.register_read(0x42, this, function() { return this.counter_read(2); });

    cpu.io.register_write(0x40, this, function(data) { this.counter_write(0, data); });
    cpu.io.register_write(0x41, this, function(data) { this.counter_write(1, data); });
    cpu.io.register_write(0x42, this, function(data) { this.counter_write(2, data); });

    cpu.io.register_write(0x43, this, this.port43_write);
}

PIT.prototype.get_state = function()
{
    var state = [];

    state[0] = this.counter_next_low;
    state[1] = this.counter_enabled;
    state[2] = this.counter_mode;
    state[3] = this.counter_read_mode;
    state[4] = this.counter_latch;
    state[5] = this.counter_latch_value;
    state[6] = this.counter_reload;
    state[7] = this.counter_current;
    state[8] = this.counter2_start;

    return state;
};

PIT.prototype.set_state = function(state)
{
    this.counter_next_low = state[0];
    this.counter_enabled = state[1];
    this.counter_mode = state[2];
    this.counter_read_mode = state[3];
    this.counter_latch = state[4];
    this.counter_latch_value = state[5];
    this.counter_reload = state[6];
    this.counter_current = state[7];
    this.counter2_start = state[8];
};

PIT.prototype.timer = function(time, no_irq)
{
    dbg_assert(time >= this.next_tick);

    var current,
        mode,
        steps = (time - this.next_tick) * OSCILLATOR_FREQ >>> 0;

    if(!steps)
    {
        return 0;
    }

    this.next_tick += steps / OSCILLATOR_FREQ;

    var time_to_next_interrupt = 100;

    // counter 0 produces interrupts
    if(!no_irq && this.counter_enabled[0])
    {
        current = this.counter_current[0] -= steps;

        if(current <= 0)
        {
            time_to_next_interrupt = 0;

            this.cpu.device_raise_irq(0);
            mode = this.counter_mode[0];

            if(mode === 0)
            {
                this.counter_enabled[0] = 0;
                this.counter_current[0] = 0;
            }
            else if(mode === 3 || mode === 2)
            {
                this.counter_current[0] = this.counter_reload[0] + current % this.counter_reload[0];
            }
        }
        else
        {
            time_to_next_interrupt = current / OSCILLATOR_FREQ;
        }
    }

    return time_to_next_interrupt;
};

        
PIT.prototype.counter_read = function(i) 
{
    var latch = this.counter_latch[i];

    if(latch)
    {
        this.counter_latch[i]--;

        if(latch === 2)
        {
            return this.counter_latch_value[i] & 0xFF;
        }
        else
        {
            return this.counter_latch_value[i] >> 8;
        }
    }
    else
    {
        var next_low = this.counter_next_low[i];

        if(this.counter_mode[i] === 3)
        {
            this.counter_next_low[i] ^= 1;
        }

        if(next_low)
        {
            return this.counter_current[i] & 0xFF;
        }
        else
        {
            return this.counter_current[i] >> 8;
        }
    }
};
        
PIT.prototype.counter_write = function(i, value) 
{ 
    if(this.counter_next_low[i])
    {
        this.counter_reload[i] = this.counter_reload[i] & ~0xFF | value;
    }
    else
    {
        this.counter_reload[i] = this.counter_reload[i] & 0xFF | value << 8;
    }

    if(this.counter_read_mode[i] !== 3 || !this.counter_next_low[i])
    {
        if(!this.counter_reload[i])
        {
            this.counter_reload[i] = 0xFFFF;
        }

        // depends on the mode, should actually 
        // happen on the first tick
        this.counter_current[i] = this.counter_reload[i];

        this.counter_enabled[i] = true;

        dbg_log("counter" + i + " reload=" + h(this.counter_reload[i]) + 
            " tick=" + (this.counter_reload[i] || 0x10000) / OSCILLATOR_FREQ + "ms", LOG_PIT);
    }

    if(this.counter_read_mode[i] === 3)
    {
        this.counter_next_low[i] ^= 1;
    }
};

PIT.prototype.port43_write = function(reg_byte)
{
    var mode = reg_byte >> 1 & 7,
        binary_mode = reg_byte & 1,
        i = reg_byte >> 6 & 3,
        read_mode = reg_byte >> 4 & 3,
        next_low;

    if(i === 1)
    {
        dbg_log("Unimplemented timer1", LOG_PIT);
    }

    if(i === 3)
    {
        dbg_log("Unimplemented read back", LOG_PIT);
        return;
    }

    if(read_mode === 0)
    {
        // latch
        this.counter_latch[i] = 2;
        this.counter_latch_value[i] = this.counter_current[i];

        return;
    }

    if(mode >= 6)
    {
        // 6 and 7 are aliased to 2 and 3
        mode &= ~4;
    }

    dbg_log("Control: mode=" + mode + " ctr=" + i + 
            " read_mode=" + read_mode + " bcd=" + binary_mode, LOG_PIT);

    if(read_mode === 1)
    {
        // msb
        this.counter_next_low[i] = 0;
    }
    else if(read_mode === 2)
    {
        // lsb
        this.counter_next_low[i] = 1;
    }
    else
    {
        // first lsb then msb
        this.counter_next_low[i] = 1;
    }


    if(mode === 0)
    {
    }
    else if(mode === 3 || mode === 2)
    {
        // what is the difference
    }
    else
    {
        dbg_log("Unimplemented counter mode: " + h(mode), LOG_PIT);
    }

    this.counter_mode[i] = mode;
    this.counter_read_mode[i] = read_mode;

    if(i === 2)
    {
        this.counter2_start = v86.microtick();
    }
};
