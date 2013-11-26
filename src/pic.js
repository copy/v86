"use strict";

/** 
 * Programmable Interrupt Controller
 * http://stanislavs.org/helppc/8259.html
 *
 * @constructor
 * @param {PIC=} master
 */
function PIC(dev, call_interrupt_vector, handle_irqs, master)
{
    var 
        io = dev.io,

        /** 
         * all irqs off
         * @type {number}
         */
        irq_mask = 0,

        /**
         * @type {number}
         *
         * Bogus default value (both master and slave mapped to 0).
         * Will be initialized by the BIOS
         */
        irq_map = 0,

        /**
         * in-service register
         * Holds interrupts that are currently being serviced
         * @type {number}
         */
        isr = 0,

        /**
         * interrupt request register
         * Holds interrupts that have been requested
         * @type {number}
         */
        irr = 0,

        is_master = master === undefined,

        slave,

        me = this;

    if(is_master)
    {
        slave = new PIC(dev, call_interrupt_vector, handle_irqs, this);

        this.handle_irqs = function()
        {
            var enabled_irr = irr & irq_mask;

            if(!enabled_irr)
            {
                return slave.handle_irqs();
            }

            var irq = enabled_irr & -enabled_irr;

            if(isr && (isr & -isr) <= irq)
            {
                // wait for eoi of higher or same priority interrupt
                return false;
            }

            var irq_number = log2_table[irq];
            irq = 1 << irq_number;

            irr &= ~irq;

            if(irq === 4)
            {
                // this should always return true
                return slave.handle_irqs();
            }

            if(!auto_eoi)
            {
                isr |= irq;
            }

            call_interrupt_vector(irq_map | irq_number, false, false);

            return true;
        };
    }
    else
    {
        // is slave
        this.handle_irqs = function()
        {
            var enabled_irr = irr & irq_mask;

            if(!enabled_irr)
            {
                return false;
            }

            var irq = enabled_irr & -enabled_irr;

            if(isr && (isr & -isr) <= irq)
            {
                // wait for eoi of higher or same priority interrupt
                return false;
            }

            var irq_number = log2_table[irq];
            irq = 1 << irq_number;

            irr &= ~irq;
            isr |= irq;

            call_interrupt_vector(irq_map | irq_number, false, false);

            if(irr)
            {
                // tell the master we have one more
                master.push_irq(2);
            }

            if(!auto_eoi)
            {
                isr &= ~irq;
            }

            return true;
        };
    }

    this.dump = function()
    {
        dbg_log("mask: " + h(irq_mask & 0xFF), LOG_PIC);
        dbg_log("base: " + h(irq_map), LOG_PIC);
        dbg_log("requested: " + h(irr), LOG_PIC);
        dbg_log("serviced: " + h(isr), LOG_PIC);

        if(is_master)
        {
            slave.dump();
        }
    };


    var expect_icw4,
        state = 0,
        read_irr = 1,
        io_base,
        auto_eoi;


    if(is_master)
    {
        io_base = 0x20;
    }
    else
    {
        io_base = 0xA0;
    }

    io.register_write(io_base, port20_write);
    io.register_read(io_base, port20_read);

    io.register_write(io_base | 1, port21_write);
    io.register_read(io_base | 1, port21_read);

    function port20_write(data_byte)
    {
        //dbg_log("20 write: " + h(data_byte), LOG_PIC);
        if(data_byte & 0x10) // xxxx1xxx
        {
            // icw1
            dbg_log("icw1 = " + h(data_byte), LOG_PIC);
            expect_icw4 = data_byte & 1;
            state = 1;
        }
        else if(data_byte & 8) // xxx01xxx
        {
            // ocw3
            dbg_log("ocw3: " + h(data_byte), LOG_PIC);
            read_irr = data_byte & 1;
        }
        else // xxx00xxx
        {
            // ocw2
            // end of interrupt
            //dbg_log("eoi: " + h(data_byte), LOG_PIC);

            var eoi_type = data_byte >> 5;

            if(eoi_type === 1)
            {
                // non-specific eoi
                isr &= isr - 1;
            }
            else if(eoi_type === 3)
            {
                // specific eoi
                isr &= ~(1 << (data_byte & 7));
            }
            else
            {
                dbg_log("Unknown eoi: " + h(data_byte), LOG_PIC);
            }
        }
    };

    function port20_read()
    {
        if(read_irr)
        {
            return irr;
        }
        else
        {
            return isr;
        }
    }

    function port21_write(data_byte)
    {
        //dbg_log("21 write: " + h(data_byte), LOG_PIC);
        if(state === 0)
        {
            if(expect_icw4)
            {
                // icw4
                expect_icw4 = false;
                auto_eoi = data_byte & 2;
                dbg_log("icw4: " + h(data_byte), LOG_PIC);
            }
            else
            {
                // ocw1
                irq_mask = ~data_byte;
                //dbg_log("interrupt mask: " + (irq_mask & 0xFFFF).toString(2) + " / map " + h(irq_map), LOG_PIC);
            }
        }
        else if(state === 1)
        {
            // icw2
            irq_map = data_byte;
            dbg_log("interrupts are mapped to " + h(irq_map) +
                    " (" + (is_master ? "master" : "slave") + ")", LOG_PIC);
            state++;
        }
        else if(state === 2)
        {
            // icw3
            state = 0;
            dbg_log("icw3: " + h(data_byte), LOG_PIC);
        }
    };

    function port21_read()
    {
        //dbg_log("21h read (" + h(irq_map) + ")", LOG_PIC);
        return ~irq_mask;
    };

    if(is_master)
    {
        this.push_irq = function(irq_number)
        {
            dbg_assert(irq_number >= 0 && irq_number < 16);

            if(irq_number >= 8)
            {
                slave.push_irq(irq_number - 8);
                irq_number = 2;
            }

            irr |= 1 << irq_number;

            handle_irqs();
        };
    }
    else
    {
        this.push_irq = function(irq_number)
        {
            dbg_assert(irq_number >= 0 && irq_number < 8);

            irr |= 1 << irq_number;
        };
    }

    this.get_isr = function()
    {
        return isr;
    };
}
