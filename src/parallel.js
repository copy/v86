// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

import { dbg_assert } from "./log.js";

const DATA_PORT = 0;
const STATUS_PORT = 1;
const CONTROL_PORT = 2;

const STATUS_ERROR = 0x08;
const STATUS_SELECT = 0x10;
const STATUS_ACK = 0x40;
const STATUS_NOT_BUSY = 0x80;

const CONTROL_IRQ_ENABLE = 0x10;
const CONTROL_MASK = 0x1F;
const STATUS_IDLE = STATUS_NOT_BUSY | STATUS_ACK | STATUS_SELECT | STATUS_ERROR;

/**
 * Parallel port.
 *
 * @constructor
 *
 * @param {CPU} cpu
 * @param {number} port
 * @param {number} irq
 * @param {number} lpt (zero-based)
 * @param {BusConnector} bus
 */
export function ParallelPort(cpu, port, irq, lpt, bus)
{
    /** @const */
    this.cpu = cpu;

    /** @const */
    this.bus = bus;

    this.data = 0;
    this.status = STATUS_IDLE;
    this.control = 0;
    this.status_latched = undefined;
    this.irq = irq;
    this.lpt = lpt;

    this.data_output_event = "parallel" + this.lpt + "-data-output";
    this.control_output_event = "parallel" + this.lpt + "-control-output";
    this.status_input_event = "parallel" + this.lpt + "-status-input";

    const io = cpu.io;

    this.bus.register(this.status_input_event, this.set_status, this);

    io.register_read(port + DATA_PORT, this, this.read_data, this.read_data_status);
    io.register_read(port + STATUS_PORT, this, this.read_status, this.read_status_control);
    io.register_read(port + CONTROL_PORT, this, this.read_control);

    io.register_write(port + DATA_PORT, this, this.write_data, this.write_data_status);
    io.register_write(port + STATUS_PORT, this, this.write_status, this.write_status_control);
    io.register_write(port + CONTROL_PORT, this, this.write_control);
}

ParallelPort.prototype.read_data = function()
{
    return this.data;
};

ParallelPort.prototype.read_data_status = function()
{
    return this.read_data() | this.read_status() << 8;
};

ParallelPort.prototype.read_status_control = function()
{
    return this.read_status() | this.read_control() << 8;
};

ParallelPort.prototype.read_control = function()
{
    return this.control;
};

ParallelPort.prototype.write_data = function(value)
{
    dbg_assert(value >= 0 && value <= 0xFF);

    this.data = value & 0xFF;
    this.bus.send(this.data_output_event, this.data);
};

ParallelPort.prototype.write_data_status = function(value)
{
    dbg_assert(value >= 0 && value <= 0xFFFF);

    this.write_data(value & 0xFF);
    this.write_status(value >> 8 & 0xFF);
};

ParallelPort.prototype.write_status = function(value)
{
    dbg_assert(value >= 0 && value <= 0xFF);
    /* no-op, status driven by peripheral side */
};

ParallelPort.prototype.write_status_control = function(value)
{
    dbg_assert(value >= 0 && value <= 0xFFFF);

    this.write_status(value & 0xFF);
    this.write_control(value >> 8 & 0xFF);
};

ParallelPort.prototype.set_status = function(value)
{
    dbg_assert(value >= 0 && value <= 0xFF);

    const status_next = value & 0xFF;
    const ack_prev = this.status & STATUS_ACK;
    const ack_next = status_next & STATUS_ACK;

    this.status = status_next;

    const ack_fell = ack_prev && !ack_next;
    if(ack_fell)
    {
        /*
           Both seabios and Boch's BIOS send data by latching
           the data lines, pulsing the strobe line, and then
           polling the status register until ACK goes low.

           A typical ACK low pulse is 5-10us.

           v86 doesn't have a precise scheduler for devices to pulse lines.
           The hack here is to let the peripheral go as fast as it
           wants, and latch ACK drops so the BIOS can detect them.
         */
        this.status_latched = status_next;
        if(this.control & CONTROL_IRQ_ENABLE)
        {
            this.cpu.device_lower_irq(this.irq);
            this.cpu.device_raise_irq(this.irq);
        }
    }
};

ParallelPort.prototype.read_status = function()
{
    if(this.status_latched !== undefined)
    {
        const status = this.status_latched;
        this.status_latched = undefined;
        return status;
    }

    return this.status;
};

ParallelPort.prototype.write_control = function(value)
{
    dbg_assert(value >= 0 && value <= 0xFF);

    this.control = value & CONTROL_MASK;
    this.bus.send(this.control_output_event, this.control);
};

ParallelPort.prototype.get_state = function()
{
    return [
        this.data,
        this.status,
        this.control,
        this.status_latched,
    ];
};

ParallelPort.prototype.set_state = function(state)
{
    if(!state)
    {
        return;
    }

    this.data = state[0];
    this.status = state[1];
    this.control = state[2];
    this.status_latched = state[3];
};
