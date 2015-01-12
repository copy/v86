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
    this.pic = cpu.devices.pic;
        
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
    this.counter2_out = 0;


    // TODO:
    // - counter2 can be controlled by an input

    cpu.io.register_read(0x61, this, function()
    {
        var ref_toggle = (v86.microtick() * (1000 * 1000 / 15000)) & 1;
        return ref_toggle << 4 | this.counter2_out << 5;
    });

    cpu.io.register_read(0x40, this, function() { return this.counter_read(0); });
    cpu.io.register_read(0x41, this, function() { return this.counter_read(1); });
    cpu.io.register_read(0x42, this, function() { return this.counter_read(2); });

    cpu.io.register_write(0x40, this, function(data) { this.counter_write(0, data); });
    cpu.io.register_write(0x41, this, function(data) { this.counter_write(1, data); });
    cpu.io.register_write(0x42, this, function(data) { this.counter_write(2, data); });

    cpu.io.register_write(0x43, this, this.port43_write);

    /** @const */
    this._state_skip = [
        this.pic,
    ];
}

PIT.prototype.get_timer2 = function()
{
    //dbg_log("timer2 read", LOG_PIT);
    return this.counter2_out;
};

PIT.prototype.timer = function(time, no_irq)
{
    dbg_assert(time >= this.next_tick);

    var current,
        mode,
        steps = (time - this.next_tick) * OSCILLATOR_FREQ >>> 0;

    if(!steps)
    {
        return;
    }

    this.next_tick += steps / OSCILLATOR_FREQ;

    // counter 0 produces interrupts
    if(!no_irq && this.counter_enabled[0])
    {
        current = this.counter_current[0] -= steps;

        if(current <= 0)
        {
            this.pic.push_irq(0);
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
    }

    // counter 2 has an output bit
    if(this.counter_enabled[2])
    {
        current = this.counter_current[2] -= steps;

        if(current <= 0)
        {
            mode = this.counter_mode[2];

            if(mode === 0)
            {
                this.counter2_out = 1;
                this.counter_enabled[2] = 0;
                this.counter_current[2] = 0;
            }
            else if(mode === 2)
            {
                this.counter2_out = 1;
                this.counter_current[2] = this.counter_reload[2] + current % this.counter_reload[2];
            }
            else if(mode === 3)
            {
                this.counter2_out ^= 1;
                this.counter_current[2] = this.counter_reload[2] + current % this.counter_reload[2];
            }
        }
        // cannot really happen, because the counter gets changed by big numbers
        //else if(current === 1)
        //{
        //    if(this.counter_mode[2] === 2)
        //    {
        //        this.counter2_out = 0;
        //    }
        //}
    }
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
        if(mode === 0)
        {
            this.counter2_out = 0;
        }
        else
        {
            // correct for mode 2 and 3
            this.counter2_out = 1;
        }
    }
};
