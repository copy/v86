import { REG_EAX, REG_EBX, REG_ECX, REG_EDX, LOG_OTHER } from "./const.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VMWARE_PORT = 0x5658;
const VMWARE_MAGIC = 0x564D5868;

const CMD_GETVERSION = 10;
const CMD_ABSPOINTER_DATA = 39;
const CMD_ABSPOINTER_STATUS = 40;
const CMD_ABSPOINTER_COMMAND = 41;

const ABSPOINTER_ENABLE = 0x45414552;
const ABSPOINTER_DISABLE = 0x000000F5;
const ABSPOINTER_RELATIVE = 0x4C455252;
const ABSPOINTER_ABSOLUTE = 0x53424152;

const READ_ID = 0x3442554A;

const BUTTON_LEFT = 0x20;
const BUTTON_RIGHT = 0x10;
const BUTTON_MIDDLE = 0x08;

const QUEUE_MAX = 1024;

/**
 * VMware mouse backdoor (port 0x5658). Lets a guest driver read absolute
 * pointer position so the guest cursor can track the host cursor 1:1 without
 * pointer lock. PS/2 still supplies the IRQ; the driver reads this port on
 * each IRQ12.
 *
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function VMwareMouse(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {BusConnector} */
    this.bus = bus;

    /** @type {boolean} */
    this.enabled = false;

    /** @type {boolean} */
    this.absolute = false;

    /** @type {!Array<number>} */
    this.queue = [];

    this.buttons = 0;
    this.last_x = -1;
    this.last_y = -1;
    this.tail_is_move = false;

    this.bus.register("mouse-absolute", function(data)
    {
        const x = Math.max(0, Math.min(0xFFFF, Math.round(data[0] / data[2] * 0xFFFF)));
        const y = Math.max(0, Math.min(0xFFFF, Math.round(data[1] / data[3] * 0xFFFF)));
        if(x === this.last_x && y === this.last_y)
        {
            return;
        }
        this.last_x = x;
        this.last_y = y;
        this.push_packet(0, true);
    }, this);

    this.bus.register("mouse-click", function(data)
    {
        this.buttons =
            (data[0] ? BUTTON_LEFT : 0) |
            (data[1] ? BUTTON_MIDDLE : 0) |
            (data[2] ? BUTTON_RIGHT : 0);
        this.push_packet(0, false);
    }, this);

    this.bus.register("mouse-wheel", function(data)
    {
        this.push_packet(-data[0] | 0, false);
    }, this);

    // The backdoor protocol is 32-bit only, but guests probe the port at
    // narrower widths during detection — answer those as an empty port.
    const nop = function() {};
    cpu.io.register_read(VMWARE_PORT, this,
        function() { return 0xFF; }, function() { return 0xFFFF; }, this.port_read32);
    cpu.io.register_write(VMWARE_PORT, this, nop, nop, nop);
}

VMwareMouse.prototype.push_packet = function(wheel, move_only)
{
    if(!this.enabled || !this.absolute || this.last_x < 0)
    {
        return;
    }
    // Absolute pointing has no use for move history — if the guest hasn't
    // drained the previous move yet, overwrite it in place. Clicks and wheel
    // are never coalesced. This keeps the guest cursor at most one frame
    // behind regardless of how slowly it drains, and makes overflow
    // unreachable in practice.
    if(move_only && this.tail_is_move && this.queue.length >= 4)
    {
        this.queue[this.queue.length - 3] = this.last_x;
        this.queue[this.queue.length - 2] = this.last_y;
        return;
    }
    if(this.queue.length + 4 > QUEUE_MAX)
    {
        this.enabled = false;
        this.queue.length = 0;
        dbg_log("vmware mouse: queue overflow, disabling", LOG_OTHER);
        return;
    }
    this.queue.push(this.buttons, this.last_x, this.last_y, wheel);
    this.tail_is_move = move_only;
};

VMwareMouse.prototype.port_read32 = function()
{
    const reg32 = this.cpu.reg32;
    if(reg32[REG_EAX] !== VMWARE_MAGIC)
    {
        return 0xFFFFFFFF | 0;
    }

    switch(reg32[REG_ECX] & 0xFFFF)
    {
        case CMD_GETVERSION:
            reg32[REG_EBX] = VMWARE_MAGIC;
            return 6;

        case CMD_ABSPOINTER_STATUS:
            return this.enabled ? this.queue.length : 0xFFFF0000 | 0;

        case CMD_ABSPOINTER_DATA:
        {
            const n = Math.min(reg32[REG_EBX] >>> 0, 4, this.queue.length);
            const v = [0, 0, 0, 0];
            for(let i = 0; i < n; i++)
            {
                v[i] = this.queue.shift();
            }
            reg32[REG_EBX] = v[1];
            reg32[REG_ECX] = v[2];
            reg32[REG_EDX] = v[3];
            return v[0];
        }

        case CMD_ABSPOINTER_COMMAND:
            switch(reg32[REG_EBX])
            {
                case ABSPOINTER_ENABLE:
                    this.enabled = true;
                    this.queue.length = 0;
                    this.tail_is_move = false;
                    this.queue.push(READ_ID);
                    break;
                case ABSPOINTER_DISABLE:
                    this.enabled = false;
                    this.absolute = false;
                    this.queue.length = 0;
                    this.bus.send("vmware-absolute-mouse", false);
                    break;
                case ABSPOINTER_ABSOLUTE:
                    this.absolute = true;
                    this.bus.send("vmware-absolute-mouse", true);
                    break;
                case ABSPOINTER_RELATIVE:
                    this.absolute = false;
                    this.bus.send("vmware-absolute-mouse", false);
                    break;
            }
            return 0;
    }

    return 0xFFFFFFFF | 0;
};

VMwareMouse.prototype.get_state = function()
{
    return [this.enabled, this.absolute];
};

VMwareMouse.prototype.set_state = function(state)
{
    this.enabled = state[0];
    this.absolute = state[1];
    this.bus.send("vmware-absolute-mouse", this.absolute);
};
