"use strict";

/**
 * Programmable Interrupt Controller
 * http://stanislavs.org/helppc/8259.html
 *
 * @constructor
 * @param {CPU} cpu
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

    this.elcr = 0;

    if(this.is_master)
    {
        this.slave = new PIC(cpu, this);

        this.check_irqs = function()
        {
            var enabled_irr = this.irr & this.irq_mask;

            if(!enabled_irr)
            {
                dbg_log("master> no unmasked irrs. irr=" + h(this.irr, 2) + " mask=" + h(this.irq_mask & 0xff, 2), LOG_PIC);
                return this.slave.check_irqs();
            }

            var irq = enabled_irr & -enabled_irr;

            if(this.isr && (this.isr & -this.isr) <= irq)
            {
                // wait for eoi of higher or same priority interrupt
                dbg_log("master> higher prio: isr=" + h(this.isr, 2) + " irq=" + h(irq, 2), LOG_PIC);
                return false;
            }

            dbg_assert(irq !== 0);
            var irq_number = v86util.int_log2_byte(irq);
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

            dbg_log("master handling irq " + irq_number, LOG_PIC);
            //dbg_trace(LOG_PIC);

            // call_interrupt_vector can cause an exception in the CPU, so we
            // have to set previous_ip correctly here
            cpu.previous_ip = cpu.instruction_pointer;
            cpu.call_interrupt_vector(this.irq_map | irq_number, false, false);

            return true;
        };
    }
    else
    {
        // is slave
        this.check_irqs = function()
        {
            var enabled_irr = this.irr & this.irq_mask;

            if(!enabled_irr)
            {
                dbg_log("slave > no unmasked irrs. irr=" + h(this.irr, 2) + " mask=" + h(this.irq_mask & 0xff, 2), LOG_PIC);
                return false;
            }

            var irq = enabled_irr & -enabled_irr;

            if(this.isr && (this.isr & -this.isr) <= irq)
            {
                // wait for eoi of higher or same priority interrupt
                dbg_log("slave > higher prio: isr=" + h(this.isr, 2) + " irq=" + h(irq, 2), LOG_PIC);
                return false;
            }

            dbg_assert(irq !== 0);
            var irq_number = v86util.int_log2_byte(irq);
            irq = 1 << irq_number;

            this.irr &= ~irq;
            this.isr |= irq;

            dbg_log("slave > handling irq " + irq_number, LOG_PIC);
            cpu.previous_ip = cpu.instruction_pointer;
            cpu.call_interrupt_vector(this.irq_map | irq_number, false, false);

            if(this.irr)
            {
                // tell the master we have one more
                master.raise_irq(2);
            }

            if(!this.auto_eoi)
            {
                this.isr &= ~irq;
            }

            return true;
        };
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
    var iobase_high;
    if(this.is_master)
    {
        io_base = 0x20;
        iobase_high = 0x4D0;
    }
    else
    {
        io_base = 0xA0;
        iobase_high = 0x4D1;
    }

    cpu.io.register_write(io_base, this, port20_write);
    cpu.io.register_read(io_base, this, port20_read);

    cpu.io.register_write(io_base | 1, this, port21_write);
    cpu.io.register_read(io_base | 1, this, port21_read);

    cpu.io.register_write(iobase_high, this, port4D0_write);
    cpu.io.register_read(iobase_high, this, port4D0_read);


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

    function port4D0_read()
    {
        dbg_log("elcr read: " + h(this.elcr, 2), LOG_PIC);
        return this.elcr;
    }

    function port4D0_write(value)
    {
        dbg_log("elcr write: " + h(value, 2), LOG_PIC);
        // set by seabios to 00 0C (only set for pci interrupts)
        this.elcr = value;
    }

    if(this.is_master)
    {
        this.raise_irq = function(irq_number)
        {
            dbg_assert(irq_number >= 0 && irq_number < 16);

            if(irq_number >= 8)
            {
                this.slave.raise_irq(irq_number - 8);
                irq_number = 2;
            }

            this.irr |= 1 << irq_number;

            cpu.handle_irqs();
        };
    }
    else
    {
        this.raise_irq = function(irq_number)
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

PIC.prototype.get_state = function()
{
    var state = [];

    state[0] = this.irq_mask;
    state[1] = this.irq_map;
    state[2] = this.isr;
    state[3] = this.irr;
    state[4] = this.is_master;
    state[5] = this.slave;
    state[6] = this.expect_icw4;
    state[7] = this.state;
    state[8] = this.read_irr;
    state[9] = this.auto_eoi;

    return state;
};

PIC.prototype.set_state = function(state)
{
    this.irq_mask = state[0];
    this.irq_map = state[1];
    this.isr = state[2];
    this.irr = state[3];
    this.is_master = state[4];
    this.slave = state[5];
    this.expect_icw4 = state[6];
    this.state = state[7];
    this.read_irr = state[8];
    this.auto_eoi = state[9];
};

