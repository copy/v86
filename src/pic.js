"use strict";

/** 
 * Programmable Interrupt Controller
 * http://stanislavs.org/helppc/8259.html
 *
 * @constructor
 * @param {PIC=} master
 */
function PIC(cpu, master)
{
    /** 
     * all irqs off
     * @type {number}
     */
    this.irq_mask = 0;

    /**
     * @type {number}
     *
     * Bogus default value (both master and slave mapped to 0).
     * Will be initialized by the BIOS
     */
    this.irq_map = 0;

    /**
     * in-service register
     * Holds interrupts that are currently being serviced
     * @type {number}
     */
    this.isr = 0;

    /**
     * interrupt request register
     * Holds interrupts that have been requested
     * @type {number}
     */
    this.irr = 0;

    this.is_master = master === undefined;
    this.slave = undefined;

    this.expect_icw4 = false;
    this.state = 0;
    this.read_irr = 1;
    this.auto_eoi = 1;

    if(this.is_master)
    {
        this.slave = new PIC(cpu, this);

        this.check_irqs = function()
        {
            var enabled_irr = this.irr & this.irq_mask;

            if(!enabled_irr)
            {
                return this.slave.check_irqs();
            }

            var irq = enabled_irr & -enabled_irr;

            if(this.isr && (this.isr & -this.isr) <= irq)
            {
                // wait for eoi of higher or same priority interrupt
                return false;
            }

            var irq_number = Math.int_log2(irq);
            irq = 1 << irq_number;

            this.irr &= ~irq;

            if(irq === 4)
            {
                // this should always return true
                return this.slave.check_irqs();
            }

            if(!this.auto_eoi)
            {
                this.isr |= irq;
            }

            //dbg_log("master handling irq " + irq_number, LOG_PIC);
            //dbg_trace(LOG_PIC);

            // call_interrupt_vector can cause an exception in the CPU, so we
            // have to set previous_ip correctly here
            cpu.previous_ip = cpu.instruction_pointer;
            cpu.call_interrupt_vector(this.irq_map | irq_number, false, false);

            return true;
        }.bind(this);
    }
    else
    {
        // is slave
        this.check_irqs = function()
        {
            var enabled_irr = this.irr & this.irq_mask;

            if(!enabled_irr)
            {
                return false;
            }

            var irq = enabled_irr & -enabled_irr;

            if(this.isr && (this.isr & -this.isr) <= irq)
            {
                // wait for eoi of higher or same priority interrupt
                return false;
            }

            var irq_number = Math.int_log2(irq);
            irq = 1 << irq_number;

            this.irr &= ~irq;
            this.isr |= irq;

            //dbg_log("slave handling irq " + irq_number, LOG_PIC);
            cpu.previous_ip = cpu.instruction_pointer;
            cpu.call_interrupt_vector(this.irq_map | irq_number, false, false);

            if(this.irr)
            {
                // tell the master we have one more
                master.push_irq(2);
            }

            if(!this.auto_eoi)
            {
                this.isr &= ~irq;
            }

            return true;
        }.bind(this);
    }

    this.dump = function()
    {
        dbg_log("mask: " + h(this.irq_mask & 0xFF), LOG_PIC);
        dbg_log("base: " + h(this.irq_map), LOG_PIC);
        dbg_log("requested: " + h(this.irr), LOG_PIC);
        dbg_log("serviced: " + h(this.isr), LOG_PIC);

        if(this.is_master)
        {
            this.slave.dump();
        }
    };

    var io_base;
    if(this.is_master)
    {
        io_base = 0x20;
    }
    else
    {
        io_base = 0xA0;
    }

    cpu.io.register_write(io_base, port20_write, this);
    cpu.io.register_read(io_base, port20_read, this);

    cpu.io.register_write(io_base | 1, port21_write, this);
    cpu.io.register_read(io_base | 1, port21_read, this);

    function port20_write(data_byte)
    {
        //dbg_log("20 write: " + h(data_byte), LOG_PIC);
        if(data_byte & 0x10) // xxxx1xxx
        {
            // icw1
            dbg_log("icw1 = " + h(data_byte), LOG_PIC);
            this.expect_icw4 = data_byte & 1;
            this.state = 1;
        }
        else if(data_byte & 8) // xxx01xxx
        {
            // ocw3
            dbg_log("ocw3: " + h(data_byte), LOG_PIC);
            this.read_irr = data_byte & 1;
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
                this.isr &= this.isr - 1;
            }
            else if(eoi_type === 3)
            {
                // specific eoi
                this.isr &= ~(1 << (data_byte & 7));
            }
            else
            {
                dbg_log("Unknown eoi: " + h(data_byte), LOG_PIC);
            }
        }
    };

    function port20_read()
    {
        if(this.read_irr)
        {
            return this.irr;
        }
        else
        {
            return this.isr;
        }
    }

    function port21_write(data_byte)
    {
        //dbg_log("21 write: " + h(data_byte), LOG_PIC);
        if(this.state === 0)
        {
            if(this.expect_icw4)
            {
                // icw4
                this.expect_icw4 = false;
                this.auto_eoi = data_byte & 2;
                dbg_log("icw4: " + h(data_byte), LOG_PIC);
            }
            else
            {
                // ocw1
                this.irq_mask = ~data_byte;

                //dbg_log("interrupt mask: " + (this.irq_mask & 0xFF).toString(2) +
                //        " (" + (this.is_master ? "master" : "slave") + ")", LOG_PIC);
            }
        }
        else if(this.state === 1)
        {
            // icw2
            this.irq_map = data_byte;
            dbg_log("interrupts are mapped to " + h(this.irq_map) +
                    " (" + (this.is_master ? "master" : "slave") + ")", LOG_PIC);
            this.state++;
        }
        else if(this.state === 2)
        {
            // icw3
            this.state = 0;
            dbg_log("icw3: " + h(data_byte), LOG_PIC);
        }
    };

    function port21_read()
    {
        //dbg_log("21h read " + h(~this.irq_mask & 0xff), LOG_PIC);
        return ~this.irq_mask & 0xFF;
    };

    if(this.is_master)
    {
        this.push_irq = function(irq_number)
        {
            dbg_assert(irq_number >= 0 && irq_number < 16);

            if(irq_number >= 8)
            {
                this.slave.push_irq(irq_number - 8);
                irq_number = 2;
            }

            this.irr |= 1 << irq_number;

            cpu.handle_irqs();
        };
    }
    else
    {
        this.push_irq = function(irq_number)
        {
            dbg_assert(irq_number >= 0 && irq_number < 8);

            this.irr |= 1 << irq_number;
        };
    }

    this.get_isr = function()
    {
        return this.isr;
    };
}
