"use strict";


/**
 * @constructor
 *
 * Programmable Interval Timer
 */
function PIT(dev)
{
    var 
        io = dev.io,
        pic = dev.pic,
        
        next_tick = Date.now(),

        me = this,

        /** 
         * @const 
         * In kHz
         */
        OSCILLATOR_FREQ = 1193.1816666, // 1.193182 MHz


        counter_next_low = new Uint8Array(3),
        counter_enabled = new Uint8Array(3),
        counter_mode = new Uint8Array(3),
        counter_read_mode = new Uint8Array(3),

        // 2 = latch low, 1 = latch high, 0 = no latch
        counter_latch = new Uint8Array(3), 
        counter_latch_value = new Uint16Array(3),

        counter_reload = new Uint16Array(3),
        counter_current = new Uint16Array(3),

        // only counter2 output can be read
        counter2_out = 0;


    // TODO:
    // - counter2 can be controlled by an input
        

    this.get_timer2 = function()
    {
        //dbg_log("timer2 read", LOG_PIT);
        return counter2_out;
    };

    var parity = 0;

    io.register_read(0x61, function()
    {
        // > xxx1 xxxx  0=RAM parity error enable
        // >            PS/2: Read:  This bit tiggles for each refresh request.
        // 
        // tiggles??
        
        parity ^= 0x10;
        return parity | counter2_out << 5;
    });

    this.timer = function(time, no_irq)
    {
        var current,
            mode,
            steps = (time - next_tick) * OSCILLATOR_FREQ >>> 0;

        if(!steps)
        {
            return;
        }
        dbg_assert(steps >= 0);

        next_tick += steps / OSCILLATOR_FREQ;

        // counter 0 produces interrupts
        if(!no_irq && counter_enabled[0])
        {
            current = counter_current[0] -= steps;

            if(current <= 0)
            {
                pic.push_irq(0);
                mode = counter_mode[0];

                if(mode === 0)
                {
                    counter_enabled[0] = 0;
                    counter_current[0] = 0;
                }
                else if(mode === 3 || mode === 2)
                {
                    counter_current[0] = counter_reload[0] + current % counter_reload[0];
                }
            }
        }

        // counter 2 has an output bit
        if(counter_enabled[2])
        {
            current = counter_current[2] -= steps;

            if(current <= 0)
            {
                mode = counter_mode[2];

                if(mode === 0)
                {
                    counter2_out = 1;
                    counter_enabled[2] = 0;
                    counter_current[2] = 0;
                }
                else if(mode === 2)
                {
                    counter2_out = 1;
                    counter_current[2] = counter_reload[2] + current % counter_reload[2];
                }
                else if(mode === 3)
                {
                    counter2_out ^= 1;
                    counter_current[2] = counter_reload[2] + current % counter_reload[2];
                }
            }
            // cannot really happen, because the counter gets changed by big numbers
            //else if(current === 1)
            //{
            //    if(counter_mode[2] === 2)
            //    {
            //        counter2_out = 0;
            //    }
            //}
        }
    }

    io.register_read(0x40, function() { return counter_read(0); });
    io.register_read(0x41, function() { return counter_read(1); });
    io.register_read(0x42, function() { return counter_read(2); });
            
    function counter_read(i) 
    { 
        var latch = counter_latch[i];

        if(latch)
        {
            counter_latch[i]--;

            if(latch === 2)
            {
                return counter_latch_value[i] & 0xFF;
            }
            else
            {
                return counter_latch_value[i] >> 8;
            }
        }
        else
        {
            var next_low = counter_next_low[i];

            if(counter_mode[i] === 3)
            {
                counter_next_low[i] ^= 1;
            }

            if(next_low)
            {
                return counter_current[i] & 0xFF;
            }
            else
            {
                return counter_current[i] >> 8;
            }
        }
    }

    io.register_write(0x40, function(value) { counter_write(0, value); });
    io.register_write(0x41, function(value) { counter_write(1, value); });
    io.register_write(0x42, function(value) { counter_write(2, value); });
            
    function counter_write(i, value) 
    { 
        if(counter_next_low[i])
        {
            counter_reload[i] = counter_reload[i] & ~0xFF | value;
        }
        else
        {
            counter_reload[i] = counter_reload[i] & 0xFF | value << 8;
        }

        if(counter_read_mode[i] !== 3 || !counter_next_low[i])
        {
            if(!counter_reload[i])
            {
                counter_reload[i] = 0xFFFF;
            }

            // depends on the mode, should actually 
            // happen on the first tick
            counter_current[i] = counter_reload[i];

            counter_enabled[i] = true;

            dbg_log("counter" + i + " reload=" + h(counter_reload[i]) + 
                " tick=" + (counter_reload[i] || 0x10000) / OSCILLATOR_FREQ + "ms", LOG_PIT);
        }

        if(counter_read_mode[i] === 3)
        {
            counter_next_low[i] ^= 1;
        }
    }

    io.register_write(0x43, port43_write);

    function port43_write(reg_byte)
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
            counter_latch[i] = 2;
            counter_latch_value[i] = counter_current[i];

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
            counter_next_low[i] = 0;
        }
        else if(read_mode === 2)
        {
            // lsb
            counter_next_low[i] = 1;
        }
        else
        {
            // first lsb then msb
            counter_next_low[i] = 1;
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

        counter_mode[i] = mode;
        counter_read_mode[i] = read_mode;

        if(i === 2)
        {
            if(mode === 0)
            {
                counter2_out = 0;
            }
            else
            {
                // correct for mode 2 and 3
                counter2_out = 1;
            }
        }
    };
}

