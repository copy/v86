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

    this.irqs = [];
    this.ioapic_id = IOAPIC_ID;

    this.lapic_tpr = 0;
    this.lapic_icr = new Int32Array(2);

    io.mmap_register(APIC_ADDRESS, 0x100000,
        function(addr)
        {
            dbg_trace();
            dbg_log("unsupported read8 from apic: " + h(addr), LOG_APIC);
            return 0;
        },
        function(addr, value)
        {
            dbg_trace();
            dbg_log("unsupported write8 from apic: " + h(addr) + " <- " + h(value), LOG_APIC);
        },
        function(addr)
        {
            addr = addr - APIC_ADDRESS | 0;

            switch(addr)
            {
                case 0x30:
                    // version
                    return 0x50011

                case 0x80:
                    // tpr
                    return me.lapic_tpr;

                case 0x300:
                    return me.lapic_icr[0];

                default:
                    dbg_log("APIC read32 " + h(addr), LOG_APIC);
                    return 0;
            }
        },
        function(addr, value)
        {
            addr = addr - APIC_ADDRESS | 0;

            switch(addr)
            {
                case 0x80:
                    // tpr
                    me.lapic_tpr = value;
                    break;

                case 0x300:
                    me.lapic_icr[0] = value;
                    break;

                default:
                    dbg_log("APIC write32 " + h(addr) + " <- " + h(value, 8), LOG_APIC);
            }
        });

    this.iotable = new Int32Array(IOAPIC_IRQ_COUNT * 2);

    // IOAPIC register selection
    var ioregsel = 0;

    var me = this;

    dbg_assert(MMAP_BLOCK_SIZE >= 0x20);
    io.mmap_register(IOAPIC_ADDRESS, MMAP_BLOCK_SIZE,
        function(addr)
        {
            throw "unsupported read8 from ioapic";
        },
        function(addr, value)
        {
            throw "unsupported write8 from ioapic";
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
                dbg_log("Unexpected IOAPIC register write: " + h(addr) + " <- " + h(value, 8), LOG_APIC);
            }
        });
}

APIC.prototype.check_irqs = function()
{
    if(!this.irqs.length)
    {
        return;
    }

    var irq_number = this.irqs.pop();
    dbg_log("Handle irq " + h(irq_number), LOG_APIC);

    this.cpu.previous_ip = this.cpu.instruction_pointer;
    this.cpu.call_interrupt_vector(irq_number, false, false);
};

APIC.prototype.raise_irq = function(i)
{
    //dbg_log("apic raise irq " + h(i), LOG_APIC);

    var infos = this.ioredtlb[0x10 + (i << 1)]

    if(infos & (1 << 16))
    {
        return;
    }

    this.irqs.push(infos & 0xFF);
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

                if(index)
                {
                    dbg_log("Read destination irq=" + h(irq), LOG_APIC);
                }
                else
                {
                    dbg_log("Read config irq=" + h(irq), LOG_APIC);
                }

                return this.ioredtlb[reg];
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
                    var disabled = value >> 16 & 1;

                    dbg_log("Write config " + h(value >>> 0, 8) +
                            " irq=" + h(irq) +
                            " vector=" + h(vector, 2) +
                            " delivery=" + h(delivery_mode) +
                            " dmode=" + destination_mode +
                            " disabled=" + disabled, LOG_APIC);
                }
            }
            else
            {
                dbg_log("IOAPIC register write outside of range " + h(reg) + ": " + h(value >>> 0, 8), LOG_APIC);
            }
    }
};

