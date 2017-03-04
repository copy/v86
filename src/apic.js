"use strict";


/** @const */
var APIC_ADDRESS = 0xFEE00000;

/** @const */
var IOAPIC_ADDRESS = 0xFEC00000;

/** @const */
var IOREGSEL = 0;

/** @const */
var IOWIN = 0x10;

/** @const */
var IOAPIC_IRQ_COUNT = 24;

/** @const */
var IOAPIC_ID = 0; // must match value in seabios

/** @const */
var APIC_TIMER_FREQ = 1 * 1024;

/** @const */
var APIC_TIMER_MODE_MASK = 3 << 17;

/** @const */
var APIC_TIMER_MODE_ONE_SHOT = 0;

/** @const */
var APIC_TIMER_MODE_PERIODIC = 1 << 17;

/** @const */
var APIC_TIMER_MODE_TSC = 2 << 17;


/**
 * @constructor
 * @param {CPU} cpu
 */
function APIC(cpu)
{
    this.cpu = cpu;

    var io = cpu.io;

    this.ioredtlb = new Int32Array(0x10 + IOAPIC_IRQ_COUNT * 2);

    for(var i = 0; i < this.ioredtlb.length; i += 2)
    {
        // disable interrupts
        this.ioredtlb[i] = 1 << 16;
    }

    this.timer_divider = 0;
    this.timer_divider_shift = 1;
    this.timer_initial_count = 0;
    this.timer_current_count = 0;
    this.lvt_timer = 0x10000;
    this.next_tick = v86.microtick();

    this.irqs = [];
    this.irqs_set = 0;
    this.ioapic_id = IOAPIC_ID;

    this.lapic_tpr = 0;
    this.lapic_icr = new Int32Array(2);

    io.mmap_register(APIC_ADDRESS, 0x100000,
        function(addr)
        {
            //dbg_trace();
            dbg_log("unsupported read8 from apic: " + h(addr >>> 0), LOG_APIC);
            var off = addr & 3;
            addr &= ~3;
            return read32(addr) >> (off * 8) & 0xFF;
        },
        function(addr, value)
        {
            dbg_trace();
            dbg_log("unsupported write8 from apic: " + h(addr) + " <- " + h(value), LOG_APIC);
        },
        read32,
        function(addr, value)
        {
            addr = addr - APIC_ADDRESS | 0;

            switch(addr)
            {
                case 0x80:
                    // tpr
                    me.lapic_tpr = value;
                    break;

                case 0xb0:
                    //dbg_log("APIC write eoi: " + h(value, 8), LOG_APIC);
                    break;

                case 0x300:
                    var vector = value & 0xFF;
                    var delivery_mode = value >> 8 & 7;
                    var destination_mode = value >> 11 & 1;
                    var destination_shorthand = value >> 18 & 3;
                    var destination = me.lapic_icr[1] >>> 24;
                    dbg_log("APIC write icr0: " + h(value, 8) + " vector=" + h(vector, 2) + " " +
                            "destination_mode=" + destination_mode + " delivery_mode=" + delivery_mode + " " +
                            "destination_shorthand=" + ["no", "self", "all with self", "all without self"][destination_shorthand], LOG_APIC);

                    //value |= 0x1000;
                    me.lapic_icr[0] = value;
                    if(delivery_mode === 0 || delivery_mode === 1)
                    {
                        me.do_irq(value);
                    }
                    break;

                case 0x310:
                    dbg_log("APIC write icr1: " + h(value, 8), LOG_APIC);
                    me.lapic_icr[1] = value;
                    break;

                case 0x320:
                    dbg_log("timer lvt: " + h(value >>> 0, 8), LOG_APIC);
                    me.lvt_timer = value;
                    break;

                case 0x3E0:
                    dbg_log("timer divider: " + h(value >>> 0, 8), LOG_APIC);
                    me.timer_divider = value;

                    var divide_shift = value & 0b11 | (value & 0b1000) >> 1;
                    me.timer_divider_shift = divide_shift === 7 ? 0 : divide_shift + 1;
                    break;

                case 0x380:
                    //dbg_log("timer initial: " + h(value >>> 0, 8), LOG_APIC);
                    me.timer_initial_count = value >>> 0;
                    me.timer_current_count = value >>> 0;
                    me.next_tick = v86.microtick();
                    break;

                case 0x390:
                    dbg_log("timer current: " + h(value >>> 0, 8), LOG_APIC);
                    me.timer_current_count = value >>> 0;
                    break;

                default:
                    dbg_log("APIC write32 " + h(addr) + " <- " + h(value >>> 0, 8), LOG_APIC);
            }
        });

    function read32(addr)
    {
        addr = addr - APIC_ADDRESS | 0;

        switch(addr)
        {
            case 0x30:
                // version
                dbg_log("APIC read version", LOG_APIC);
                return 0x50011

            case 0x80:
                // tpr
                //dbg_log("APIC read tpr", LOG_APIC);
                return me.lapic_tpr;

            case 0x300:
                dbg_log("APIC read icr0", LOG_APIC);
                return me.lapic_icr[0];

            case 0x310:
                dbg_log("APIC read icr1", LOG_APIC);
                return me.lapic_icr[1];

            case 0x320:
                dbg_log("read timer lvt", LOG_APIC);
                return me.lvt_timer;

            case 0x3E0:
                // divider
                dbg_log("read timer divider", LOG_APIC);
                return me.timer_divider;

            case 0x380:
                dbg_log("read timer initial count", LOG_APIC);
                return me.timer_initial_count;

            case 0x390:
                //dbg_log("read timer current count: " + h(me.timer_current_count >>> 0, 8), LOG_APIC);
                return me.timer_current_count;

            default:
                dbg_log("APIC read " + h(addr), LOG_APIC);
                return 0;
        }
    }

    this.iotable = new Int32Array(IOAPIC_IRQ_COUNT * 2);

    // IOAPIC register selection
    var ioregsel = 0;

    var me = this;

    dbg_assert(MMAP_BLOCK_SIZE >= 0x20);

    io.mmap_register(IOAPIC_ADDRESS, MMAP_BLOCK_SIZE,
        function(addr)
        {
            dbg_assert(false, "unsupported read8 from ioapic: " + h(addr));
            return 0;
        },
        function(addr, value)
        {
            dbg_assert(false, "unsupported write8 from ioapic: " + h(addr));
        },
        function(addr)
        {
            addr = addr - IOAPIC_ADDRESS | 0;

            if(addr === IOREGSEL)
            {
                dbg_log("Unexpected IOAPIC register read ioregsel", LOG_APIC);
            }
            else if(addr === IOWIN)
            {
                dbg_log("IOAPIC read32 " + h(ioregsel), LOG_APIC);
                return me.ioapic_read(ioregsel);
            }
            else
            {
                dbg_log("Unexpected IOAPIC register read: " + h(addr), LOG_APIC);
                return 0;
            }
        },
        function(addr, value)
        {
            addr = addr - IOAPIC_ADDRESS | 0;

            if(addr === IOREGSEL)
            {
                ioregsel = value;
            }
            else if(addr === IOWIN)
            {
                me.ioapic_write(ioregsel, value);
            }
            else
            {
                dbg_log("Unexpected IOAPIC register write: " + h(addr) + " <- " + h(value >>> 0, 8), LOG_APIC);
            }
        });
}

APIC.prototype.timer = function(now)
{
    if(this.timer_current_count === 0)
    {
        return;
    }
    //dbg_log(now + " " + this.next_tick, LOG_APIC);

    var steps = (now - this.next_tick) * APIC_TIMER_FREQ / (1 << this.timer_divider_shift) >>> 0;

    if(steps === 0)
    {
        return;
    }

    this.next_tick += steps / APIC_TIMER_FREQ * (1 << this.timer_divider_shift);

    this.timer_current_count -= steps;
    var mode = this.lvt_timer & APIC_TIMER_MODE_MASK;

    if(mode === APIC_TIMER_MODE_PERIODIC)
    {
        while(this.timer_current_count <= 0)
        {
            this.timer_current_count = this.timer_initial_count + this.timer_current_count % this.timer_initial_count;
        }

        this.do_irq(this.lvt_timer);
    }
    else if(mode === APIC_TIMER_MODE_ONE_SHOT)
    {
        if(this.timer_current_count < 0)
        {
            this.timer_current_count = 0;
            dbg_log("XXX one shot end");
        }
        this.do_irq(this.lvt_timer);
    }
};

APIC.prototype.check_irqs = function()
{
    if(!this.irqs.length)
    {
        return;
    }

    var irq_number = this.irqs.pop();
    this.irqs_set &= ~(1 << irq_number);

    //if(irq_number !== 0x30) // timer interrupt on linux
    //{
    //    dbg_log("Handle irq " + h(irq_number), LOG_APIC);
    //}

    this.cpu.previous_ip = this.cpu.instruction_pointer;
    this.cpu.call_interrupt_vector(irq_number, false, false);
};

APIC.prototype.set_irq = function(i)
{
    //dbg_log("apic raise irq " + h(i), LOG_APIC);

    var infos = this.ioredtlb[0x10 + (i << 1)]
    this.do_irq(infos);
};

APIC.prototype.clear_irq = function(i)
{
};

APIC.prototype.do_irq = function(infos)
{
    if(infos & (1 << 16))
    {
        //dbg_log("irq " + h(i, 2) + " disabled", LOG_APIC);
        return;
    }

    var irq = infos & 0xFF;

    this.irqs.push(irq);
    this.irqs_set |= 1 << irq;
    this.cpu.handle_irqs();
};

APIC.prototype.ioapic_read = function(reg)
{
    switch(reg)
    {
        case 0:
            return this.ioapic_id << 24;

        case 1:
            return 0x11 | IOAPIC_IRQ_COUNT - 1 << 16;

        case 2:
            //  Arbitration ID
            return 0;

        default:
            if(reg >= 0x10 && reg < 0x10 + 2 * IOAPIC_IRQ_COUNT)
            {
                var irq = reg - 0x10 >> 1;
                var index = reg & 1;

                var value = this.ioredtlb[reg];

                if(index)
                {
                    dbg_log("Read destination irq=" + h(irq) + " -> " + h(value, 8), LOG_APIC);
                }
                else
                {
                    dbg_log("Read config irq=" + h(irq) + " -> " + h(value, 8), LOG_APIC);
                }
                return value;
            }
            else
            {
                dbg_log("IOAPIC register read outside of range " + h(reg), LOG_APIC);
                return 0;
            }
    }
};

APIC.prototype.ioapic_write = function(reg, value)
{
    dbg_log("IOAPIC write " + h(reg) + " <- " + h(value, 8), LOG_APIC);

    switch(reg)
    {
        case 0:
            this.ioapic_id = value >>> 24;
            break;

        default:
            if(reg >= 0x10 && reg < 0x10 + 2 * IOAPIC_IRQ_COUNT)
            {
                this.ioredtlb[reg] = value;

                var irq = reg - 0x10 >> 1;
                var index = reg & 1;

                if(index)
                {
                    dbg_log("Write destination " + h(value >>> 0, 8) + " irq=" + h(irq) + " dest=" + h(value >>> 24, 2), LOG_APIC);
                }
                else
                {
                    var vector = value & 0xFF;
                    var delivery_mode = value >> 8 & 7;
                    var destination_mode = value >> 11 & 1;
                    var is_level = value >> 15 & 1;
                    var disabled = value >> 16 & 1;

                    dbg_log("Write config " + h(value >>> 0, 8) +
                            " irq=" + h(irq) +
                            " vector=" + h(vector, 2) +
                            " delivery=" + h(delivery_mode) +
                            " destmode=" + destination_mode +
                            " is_level=" + is_level +
                            " disabled=" + disabled, LOG_APIC);
                }
            }
            else
            {
                dbg_log("IOAPIC register write outside of range " + h(reg) + ": " + h(value >>> 0, 8), LOG_APIC);
            }
    }
};
