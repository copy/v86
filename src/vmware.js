import { REG_EAX, REG_EBX, REG_ECX, REG_EDX, LOG_OTHER } from "./const.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VMWARE_PORT = 0x5658;
const VMWARE_MAGIC = 0x564D5868;

const CMD_GETVERSION = 10;
const CMD_GETTIME = 23;
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

// Flag in the status dword marking a packet whose x/y are signed deltas
// rather than absolute positions (VMMOUSE_RELATIVE_PACKET in the guest
// drivers). Used while the host pointer is locked and no meaningful absolute
// position exists.
const RELATIVE_PACKET = 0x00010000;

const QUEUE_MAX = 1024;

/**
 * VMware backdoor (port 0x5658). Lets a guest driver read absolute pointer
 * position so the guest cursor can track the host cursor 1:1 without pointer
 * lock, and implements GETTIME (23) so a guest agent can keep the guest clock
 * in sync with the host (guests only read the RTC at boot, so a restored
 * state resumes with a stale clock). PS/2 still supplies the mouse IRQ; the
 * driver reads this port on each IRQ12. While the host pointer is locked
 * (e.g. for games), movement is reported as relative packets instead, since
 * no meaningful absolute position exists.
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

    /**
     * Whether the host pointer is currently locked (browser pointer lock).
     * While locked, the host cursor position is meaningless, so movement is
     * reported as relative packets instead of absolute ones.
     * @type {boolean}
     */
    this.host_pointer_locked = false;

    // sub-pixel remainders of relative movement
    this.rel_dx = 0;
    this.rel_dy = 0;

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
        this.push_absolute(0, true);
    }, this);

    this.bus.register("mouse-delta", function(data)
    {
        if(!this.host_pointer_locked)
        {
            return;
        }
        this.rel_dx += data[0];
        this.rel_dy += data[1];
        const dx = this.rel_dx | 0;
        const dy = this.rel_dy | 0;
        if(!dx && !dy)
        {
            return;
        }
        this.rel_dx -= dx;
        this.rel_dy -= dy;
        this.push_relative(dx, dy, 0, true);
    }, this);

    this.bus.register("mouse-pointer-lock", function(locked)
    {
        this.host_pointer_locked = locked;
        this.rel_dx = 0;
        this.rel_dy = 0;
    }, this);

    this.bus.register("mouse-click", function(data)
    {
        this.buttons =
            (data[0] ? BUTTON_LEFT : 0) |
            (data[1] ? BUTTON_MIDDLE : 0) |
            (data[2] ? BUTTON_RIGHT : 0);
        if(this.host_pointer_locked)
        {
            this.push_relative(0, 0, 0, false);
        }
        else
        {
            this.push_absolute(0, false);
        }
    }, this);

    this.bus.register("mouse-wheel", function(data)
    {
        if(this.host_pointer_locked)
        {
            this.push_relative(0, 0, -data[0] | 0, false);
        }
        else
        {
            this.push_absolute(-data[0] | 0, false);
        }
    }, this);

    // The backdoor protocol is 32-bit only, but guests probe the port at
    // narrower widths during detection — answer those as an empty port.
    const nop = function() {};
    cpu.io.register_read(VMWARE_PORT, this,
        function() { return 0xFF; }, function() { return 0xFFFF; }, this.port_read32);
    cpu.io.register_write(VMWARE_PORT, this, nop, nop, nop);
}

VMwareMouse.prototype.push_absolute = function(wheel, move_only)
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
    if(move_only && this.tail_is_move && this.queue.length >= 4 &&
        !(this.queue[this.queue.length - 4] & RELATIVE_PACKET))
    {
        this.queue[this.queue.length - 3] = this.last_x;
        this.queue[this.queue.length - 2] = this.last_y;
        return;
    }
    this.push_packet(this.buttons, this.last_x, this.last_y, wheel, move_only);
};

// Relative fallback, used while the host pointer is locked (e.g. for games).
// The sign convention follows the Linux vmmouse driver: positive x is right,
// positive y is up, like PS/2.
VMwareMouse.prototype.push_relative = function(dx, dy, wheel, move_only)
{
    if(!this.enabled)
    {
        return;
    }
    // Same idea as in push_absolute, but pending deltas accumulate instead of
    // being overwritten.
    if(move_only && this.tail_is_move && this.queue.length >= 4 &&
        (this.queue[this.queue.length - 4] & RELATIVE_PACKET))
    {
        this.queue[this.queue.length - 3] += dx;
        this.queue[this.queue.length - 2] += dy;
        return;
    }
    this.push_packet(this.buttons | RELATIVE_PACKET, dx, dy, wheel, move_only);
};

VMwareMouse.prototype.push_packet = function(status, x, y, wheel, move_only)
{
    if(this.queue.length + 4 > QUEUE_MAX)
    {
        this.enabled = false;
        this.queue.length = 0;
        dbg_log("vmware mouse: queue overflow, disabling", LOG_OTHER);
        return;
    }
    this.queue.push(status, x, y, wheel);
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

        case CMD_GETTIME:
        {
            // EAX = host time in seconds since the Unix epoch (UTC),
            // EBX = remaining microseconds, ECX = maximum time lag in
            // microseconds, EDX = host's offset from UTC in minutes (east
            // positive). Deprecated upstream in favour of GETTIMEFULL because
            // EAX overflows as a signed value in 2038, but it's the simplest
            // command a 32-bit guest agent can consume — read unsigned it's
            // good until 2106.
            const now = Date.now();
            reg32[REG_EBX] = now % 1000 * 1000;
            reg32[REG_ECX] = 1000000;
            reg32[REG_EDX] = -new Date(now).getTimezoneOffset();
            return now / 1000 >>> 0;
        }

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
