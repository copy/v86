import { REG_EAX, REG_EBX, REG_ECX, REG_EDX, REG_ESI, REG_EDI, LOG_OTHER } from "./const.js";
import { dbg_log } from "./log.js";
import { STATE_OFFSETS } from "./state_layout.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

const VMWARE_PORT = 0x5658;
const VMWARE_MAGIC = 0x564D5868;

const CMD_GETSELLENGTH = 6;
const CMD_GETNEXTPIECE = 7;
const CMD_SETSELLENGTH = 8;
const CMD_SETNEXTPIECE = 9;
const CMD_GETVERSION = 10;
const CMD_GETHWVERSION = 17;
const CMD_GETTIME = 23;
const CMD_ABSPOINTER_DATA = 39;
const CMD_ABSPOINTER_STATUS = 40;
const CMD_ABSPOINTER_COMMAND = 41;
const CMD_MESSAGE = 30;
// The display adapter's capabilities before the driver has the device: VMware's
// Windows driver (vm3dmp) loads as a full WDDM driver only if subcommand 0
// shows SVGA_CAP_3D and either SVGA_CAP_GBOBJECTS or, from subcommand 2, a
// 3D hardware version of at least 0x20000; else as a display-only driver
const CMD_GET_SVGA_CAPABILITIES = 75;

// The message channel (open-vm-tools lib/message): ECX's high word is the
// step, the status comes back in ECX's high word, the channel in EDX's
const MESSAGE_OPEN = 0;
const MESSAGE_SENDSIZE = 1;
const MESSAGE_SENDPAYLOAD = 2;
const MESSAGE_RECVSIZE = 3;
const MESSAGE_RECVPAYLOAD = 4;
const MESSAGE_RECVSTATUS = 5;
const MESSAGE_CLOSE = 6;
const MESSAGE_STATUS_SUCCESS = 0x0001;
const MESSAGE_STATUS_DORECV = 0x0002;
const RPCI_PROTOCOL = 0x49435052;
const GUESTMSG_FLAG_COOKIE = 0x80000000;
const MESSAGE_CHANNELS = 8;
const MESSAGE_MAX = 0x10000;

const ABSPOINTER_ENABLE = 0x45414552;
const ABSPOINTER_DISABLE = 0x000000F5;
const ABSPOINTER_RELATIVE = 0x4C455252;
const ABSPOINTER_ABSOLUTE = 0x53424152;

const READ_ID = 0x3442554A;

/** GETVERSION's product type (VMX_TYPE_WORKSTATION in open-vm-tools' backdoor_def.h) */
const VMX_TYPE_WORKSTATION = 4;
/** What GETHWVERSION reports: Workstation 12.5's, the first with SVGA 3D on Windows 8.1 guests through WDDM 1.3 */
const VIRTUAL_HARDWARE_VERSION = 13;

const BUTTON_LEFT = 0x20;
const BUTTON_RIGHT = 0x10;
const BUTTON_MIDDLE = 0x08;

// Flag in the status dword marking a packet whose x/y are signed deltas
// rather than absolute positions (VMMOUSE_RELATIVE_PACKET in the guest
// drivers). Used while the host pointer is locked and no meaningful absolute
// position exists.
const RELATIVE_PACKET = 0x00010000;

const QUEUE_MAX = 1024;
const CLIP_MAX = 0x10000;

/**
 * VMware backdoor (port 0x5658). Lets a guest driver read absolute pointer
 * position so the guest cursor can track the host cursor 1:1 without pointer
 * lock, lets a guest agent sync the clipboard with the host using the legacy
 * text commands (6–9), and implements GETTIME (23) so a guest agent can keep
 * the guest clock in sync with the host (guests only read the RTC at boot, so
 * a restored state resumes with a stale clock). PS/2 still supplies the mouse
 * IRQ; the driver reads this port on each IRQ12. While the host pointer is
 * locked
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

    /** @type {!Array<?{send: Uint8Array, sent: number, reply: Uint8Array, read: number}>}
     *  RPCI channels (CMD_MESSAGE): guests' logs and guestinfo queries */
    this.channels = [];
    /** @type {!Map<string, string>} what "info-get guestinfo.<key>" answers */
    this.guestinfo = new Map();

    /** @type {Uint8Array} host→guest text staged for the guest to read */
    this.clip_out = new Uint8Array(0);
    this.clip_out_cursor = 0;
    this.clip_out_fresh = false;

    /** @type {Uint8Array} guest→host text being received */
    this.clip_in = new Uint8Array(0);
    this.clip_in_cursor = 0;

    this.bus.register("vmware-clipboard-host", function(data)
    {
        this.clip_out = data.length > CLIP_MAX ? data.subarray(0, CLIP_MAX) : data;
        this.clip_out_cursor = 0;
        this.clip_out_fresh = true;
    }, this);

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

    // (while the guest uses the USB tablet, the pointer is the tablet's)
    this.usb_tablet_active = false;
    this.bus.register("usb-tablet-active", function(active)
    {
        this.usb_tablet_active = !!active;
    }, this);

    this.bus.register("mouse-absolute", function(data)
    {
        if(this.usb_tablet_active)
        {
            return;
        }
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
        if(this.usb_tablet_active && !this.host_pointer_locked)
        {
            return;
        }
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
        if(this.usb_tablet_active && !this.host_pointer_locked)
        {
            return;
        }
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
            // EAX: the backdoor's version; ECX: the product. VMware Tools'
            // installer refuses a machine whose product it does not know
            this.set_reg(REG_EBX, VMWARE_MAGIC);
            this.set_reg(REG_ECX, VMX_TYPE_WORKSTATION);
            return 6;

        case CMD_GETHWVERSION:
            // the virtual hardware version (a VM's "hardware compatibility")
            this.set_reg(REG_EBX, VMWARE_MAGIC);
            return VIRTUAL_HARDWARE_VERSION;

        case CMD_GETSELLENGTH:
            if(!this.clip_out_fresh)
            {
                return 0xFFFFFFFF | 0;
            }
            this.clip_out_fresh = false;
            this.clip_out_cursor = 0;
            return this.clip_out.length;

        case CMD_GETNEXTPIECE:
        {
            const c = this.clip_out;
            let i = this.clip_out_cursor;
            const v = (c[i] | 0) | (c[i + 1] | 0) << 8 |
                      (c[i + 2] | 0) << 16 | (c[i + 3] | 0) << 24;
            this.clip_out_cursor = i + 4;
            return v;
        }

        case CMD_SETSELLENGTH:
        {
            const n = Math.min(reg32[REG_EBX] >>> 0, CLIP_MAX);
            this.clip_in = new Uint8Array(n);
            this.clip_in_cursor = 0;
            if(n === 0)
            {
                this.bus.send("vmware-clipboard-guest", this.clip_in);
            }
            return 0;
        }

        case CMD_SETNEXTPIECE:
        {
            const c = this.clip_in;
            const v = reg32[REG_EBX] >>> 0;
            let i = this.clip_in_cursor;
            if(i < c.length) c[i++] = v;
            if(i < c.length) c[i++] = v >>> 8;
            if(i < c.length) c[i++] = v >>> 16;
            if(i < c.length) c[i++] = v >>> 24;
            this.clip_in_cursor = i;
            if(i >= c.length)
            {
                this.bus.send("vmware-clipboard-guest", c);
                this.clip_in = new Uint8Array(0);
                this.clip_in_cursor = 0;
            }
            return 0;
        }

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

        case CMD_MESSAGE:
            return this.message(reg32);

        case CMD_GET_SVGA_CAPABILITIES:
        {
            const adapter = this.cpu.devices.graphics_adapter;
            const svga = adapter && adapter.svga_capabilities();
            if(!svga) break;
            this.set_reg(REG_EBX, VMWARE_MAGIC);
            const subcommand = reg32[REG_ECX] >>> 16;
            return (subcommand === 0 ? svga.capabilities : subcommand === 2 ? svga.hardware_version : 0) | 0;
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

    // (what guests ask that this does not know: for the harnesses' logs)
    this.bus.send("vmware-backdoor-unknown", reg32[REG_ECX] & 0xFFFF);
    return 0xFFFFFFFF | 0;
};

/**
 * Set a register from the backdoor: a 32-bit write, which in long mode
 * clears the upper half
 */
VMwareMouse.prototype.set_reg = function(reg, value)
{
    this.cpu.reg32[reg] = value;
    if(this.cpu.state_base !== undefined)
    {
        new Int32Array(this.cpu.wasm_memory.buffer, this.cpu.state_base + STATE_OFFSETS.x64_gpr_hi, 16)[reg] = 0;
    }
};

/**
 * CMD_MESSAGE: one step of the RPCI exchange, the low-bandwidth way (four
 * bytes per port access)
 * @return {number} EAX
 */
VMwareMouse.prototype.message = function(reg32)
{
    const step = reg32[REG_ECX] >>> 16, id = reg32[REG_EDX] >>> 16;
    // the status, and EAX
    const ok = status => { this.set_reg(REG_ECX, (status | MESSAGE_STATUS_SUCCESS) << 16); return 0; };
    const fail = () => { this.set_reg(REG_ECX, 0); return 0; };
    if(step === MESSAGE_OPEN)
    {
        if(((reg32[REG_EBX] >>> 0) & ~GUESTMSG_FLAG_COOKIE) !== RPCI_PROTOCOL) return fail();
        let free = this.channels.findIndex(channel => !channel);
        if(free < 0)
        {
            if(this.channels.length >= MESSAGE_CHANNELS) return fail();
            free = this.channels.length;
        }
        this.channels[free] = { send: null, sent: 0, reply: null, read: 0 };
        this.set_reg(REG_EDX, free << 16 | VMWARE_PORT);
        // (cookies: any values do, the guest gives them back)
        this.set_reg(REG_ESI, 0x56383601);
        this.set_reg(REG_EDI, 0x76383602);
        return ok(0);
    }
    const channel = this.channels[id];
    if(!channel) return fail();
    switch(step)
    {
        case MESSAGE_SENDSIZE:
        {
            const size = reg32[REG_EBX] >>> 0;
            if(size > MESSAGE_MAX) return fail();
            channel.send = new Uint8Array(size);
            channel.sent = 0;
            if(!size) this.rpci(channel);
            return ok(0);
        }
        case MESSAGE_SENDPAYLOAD:
        {
            const send = channel.send;
            if(!send) return fail();
            const v = reg32[REG_EBX];
            for(let i = 0; i < 4 && channel.sent < send.length; i++) send[channel.sent++] = v >>> 8 * i;
            if(channel.sent >= send.length) this.rpci(channel);
            return ok(0);
        }
        case MESSAGE_RECVSIZE:
            if(!channel.reply) return ok(0);
            this.set_reg(REG_EBX, channel.reply.length);
            // (EDX's high word: what the host sends next)
            this.set_reg(REG_EDX, MESSAGE_SENDSIZE << 16 | VMWARE_PORT);
            return ok(MESSAGE_STATUS_DORECV);
        case MESSAGE_RECVPAYLOAD:
        {
            const reply = channel.reply;
            if(!reply) return fail();
            let v = 0;
            for(let i = 0; i < 4; i++) v |= (reply[channel.read + i] | 0) << 8 * i;
            channel.read += 4;
            this.set_reg(REG_EBX, v);
            this.set_reg(REG_EDX, MESSAGE_SENDPAYLOAD << 16 | VMWARE_PORT);
            return ok(0);
        }
        case MESSAGE_RECVSTATUS:
            channel.reply = null;
            channel.read = 0;
            return ok(0);
        case MESSAGE_CLOSE:
            this.channels[id] = null;
            return ok(0);
    }
    return fail();
};

/**
 * A whole RPCI request has come: answer it ("1 <result>" or "0 <error>")
 */
VMwareMouse.prototype.rpci = function(channel)
{
    const request = new TextDecoder().decode(channel.send).replace(/\0+$/, "");
    channel.send = null;
    let reply = "0 Unknown command";
    if(!request.startsWith("log ")) this.bus.send("vmware-rpci", request);
    if(request.startsWith("log "))
    {
        // the drivers' logs (vmwgfx, VMware's WDDM driver): to whoever listens
        this.bus.send("vmware-log", request.slice(4));
        reply = "1 ";
    }
    else if(request.startsWith("info-get guestinfo."))
    {
        const value = this.guestinfo.get(request.slice(19));
        reply = value === undefined ? "0 No value found" : "1 " + value;
    }
    else if(request.startsWith("tools.capability.") || request.startsWith("tools.set.version"))
    {
        reply = "1 ";
    }
    channel.reply = new TextEncoder().encode(reply);
    channel.read = 0;
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
