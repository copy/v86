"use strict";


var HPET_ADDR = 0xFED00000,
    HPET_PERIOD = 0x05F5E100, // in nano seconds
    HPET_FREQ_MS = 1e12 / HPET_PERIOD, // in kHZ
    HPET_SUPPORT_64 = 0,
    HPET_COUNTER_CONFIG = 1 << 4 | HPET_SUPPORT_64 << 5,
    HPET_COUNTER_CONFIG_MASK = 1 << 4 | 1 << 5 | 1 << 15,
    HPET_NUM_COUNTERS = 4;

/**
 * HPET - High Precision Event Timer
 * http://wiki.osdev.org/HPET
 *
 * @constructor
 * @param {CPU} cpu
 */
function HPET(cpu)
{
    var me = this,

        hpet_enabled = false,
        hpet_start = Date.now(),

        hpet_offset_low = 0,
        hpet_offset_high = 0,

        counter_read_acc_next = false,
        interrupt_status = 0,

        counter_config = new Int32Array(HPET_NUM_COUNTERS << 1),
        counter_comparator = new Int32Array(HPET_NUM_COUNTERS << 1),
        counter_accumulator = new Int32Array(HPET_NUM_COUNTERS << 1);

    //var counter_last_irq = new Int32Array(HPET_NUM_COUNTERS << 1);


    var last_check = 0;


    this.legacy_mode = false;

    this.timer = function(now)
    {
        if(!hpet_enabled)
        {
            return;
        }

        var
            counter_value = get_counter() >>> 0,
            config,
            //last_irq,
            comparator,
            do_irq;

        for(var i = 0; i < HPET_NUM_COUNTERS; i++)
        {
            config = counter_config[i << 1];
            //last_irq = counter_last_irq[i << 1] >>> 0;
            comparator = counter_comparator[i << 1] >>> 0;

            if(last_check <= counter_value ?
                    comparator > last_check && comparator <= counter_value :
                    comparator > last_check || comparator <= counter_value
            ) {
                do_irq = config & 4;
                //counter_last_irq[i << 1] = comparator;

                if(config & 2)
                {
                    // level triggered
                    do_irq = do_irq && !(interrupt_status & 1 << i);
                    interrupt_status |= 1 << i;
                }
                else
                {
                    // edge-triggered
                    interrupt_status &= ~(1 << i);
                }

                if(config & 1 << 3)
                {
                    // periodic mode
                    counter_comparator[i << 1] += counter_accumulator[i << 1];
                }

                //dbg_log("do_irq=" + do_irq, LOG_HPET);
                if(do_irq)
                {
                    if(me.legacy_mode && i === 0)
                    {
                        cpu.device_raise_irq(0);
                    }
                    else if(me.legacy_mode && i === 1)
                    {
                        cpu.device_raise_irq(0);
                    }
                    else
                    {
                        // TODO
                        cpu.device_raise_irq(0);
                    }
                }
            }
        }

        last_check = counter_value;
    };

    function get_counter()
    {
        if(hpet_enabled)
        {
            return (Date.now() - hpet_start) * HPET_FREQ_MS + hpet_offset_low | 0;
        }
        else
        {
            return hpet_offset_low;
        }
    }

    function get_counter_high()
    {
        if(HPET_SUPPORT_64)
        {
            if(hpet_enabled)
            {
                return (Date.now() - hpet_start) * (HPET_FREQ_MS / 0x100000000) + hpet_offset_high | 0;
            }
            else
            {
                return hpet_offset_high;
            }
        }
        else
        {
            return 0;
        }
    }

    cpu.io.mmap_register(HPET_ADDR, 0x4000, mmio_read, mmio_write);



    function mmio_read(addr)
    {
        dbg_log("Read " + h(addr, 4) + " (ctr=" + h(get_counter() >>> 0) + ")", LOG_HPET);

        switch(addr)
        {
            case 0:
                return 1 << 16 | HPET_NUM_COUNTERS - 1 << 8 | 0x8000 | 0x01 | HPET_SUPPORT_64 << 13;
            case 4:
                return HPET_PERIOD;

            case 0x10:
                return me.legacy_mode << 1 | hpet_enabled;

            case 0xF0:
                return get_counter();

            case 0xF4:
                return get_counter_high();
        }

        // read from counter register
        var register = addr >> 2 & 7,
            counter = addr - 0x100 >> 5;

        if(addr < 0x100 || counter >= HPET_NUM_COUNTERS || register > 5)
        {
            dbg_log("Read reserved address: " + h(addr), LOG_HPET);
            return 0;
        }

        dbg_log("Read counter: addr=" + h(addr) + " counter=" + h(counter, 2) +
                " reg=" + h(register), LOG_HPET);

        switch(register)
        {
            case 0:
                return counter_config[counter << 1] & ~HPET_COUNTER_CONFIG_MASK | HPET_COUNTER_CONFIG;
            case 1:
                return counter_config[counter << 1 | 1];

            case 2:
                return counter_comparator[counter << 1];
            case 3:
                return counter_comparator[counter << 1 | 1];

            case 4:
            case 5:
                // TODO interrupt route register
                return 0;
        }
    }

    function mmio_write(addr, data)
    {
        dbg_log("Write " + h(addr, 4) + ": " + h(data, 2), LOG_HPET);

        switch(addr)
        {
            case 0x10:
                dbg_log("conf: enabled=" + (data & 1) + " legacy=" + (data >> 1 & 1), LOG_HPET);

                if((hpet_enabled ^ data) & 1)
                {
                    if(data & 1)
                    {
                        // counter is enabled now, start counting now
                        hpet_start = Date.now();
                    }
                    else
                    {
                        // counter is disabled now, save current count
                        hpet_offset_low = get_counter();
                        hpet_offset_high = get_counter_high();
                    }
                }

                hpet_enabled = (data & 1) === 1;
                me.legacy_mode = (data & 2) === 2;

                return;

            case 0x20:
                // writing a 1 clears bits
                interrupt_status &= ~data;
                return;

            case 0xF0:
                hpet_offset_low = data;
                return;

            case 0xF4:
                hpet_offset_high = data;
                return;
        }

        // read from counter register
        var register = addr >> 2 & 7,
            counter = addr - 0x100 >> 5;

        if(addr < 0x100 || counter >= HPET_NUM_COUNTERS || register > 2)
        {
            dbg_log("Write reserved address: " + h(addr) + " data=" + h(data), LOG_HPET);
            return;
        }

        dbg_log("Write counter: addr=" + h(addr) + " counter=" + h(counter, 2) +
                " reg=" + h(register) + " data=" + h(data, 2), LOG_HPET);

        switch(register)
        {
            case 0:
                counter_config[counter << 1] = data;
                break;
            case 1:
                //counter_config[counter << 1 | 1] = data;
                break;

            case 2:
                if(counter_read_acc_next)
                {
                    counter_accumulator[counter << 1] = data;
                    counter_read_acc_next = false;
                    dbg_log("Accumulator acc=" + h(data >>> 0, 8) + " ctr=" + h(counter, 2), LOG_HPET);
                }
                else
                {
                    counter_comparator[counter << 1] = data;

                    if(counter_config[counter << 1] & 1 << 6)
                    {
                        counter_read_acc_next = true;
                        counter_config[counter << 1] &= ~(1 << 6);
                    }
                }
                break;
            case 3:
                counter_comparator[counter << 1 | 1] = data;
                break;

            case 4:
            case 5:
                // TODO interrupt route register

        }
    }
}
