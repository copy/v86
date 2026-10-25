// virtio-input (virtio 1.2 section 5.8; docs/arm64-virt-android16-plan.md
// P5.8, P7.4) as built-in devices of the virt machine: a keyboard, which
// takes the PS/2 set-1 scancodes of the bus's "keyboard-code"
// (src/browser/keyboard.js) and sends evdev EV_KEY events; a tablet, which
// takes "mouse-absolute", "mouse-click" and "mouse-wheel"
// (src/browser/mouse.js) and sends EV_ABS (0-0x7FFF), the buttons and
// REL_WHEEL; and a multi-touch screen, which takes "touch" (the touches on
// the screen) and sends the slots of the MT protocol (type B: ABS_MT_SLOT,
// ABS_MT_TRACKING_ID, ABS_MT_POSITION_X/Y) and BTN_TOUCH, and, with no
// tablet beside it, the mouse as one finger (as Android's emulator: the
// left button down touches, moves drag, up lifts it). Their
// configuration (the select/subsel window: name, IDs, properties, event
// bits, the axes' ranges) is that of QEMU v9.2.0's virtio-keyboard,
// virtio-tablet and virtio-multitouch (hw/input/virtio-input-hid.c,
// wheel-axis on), so a guest sees the reference's devices. Events go out a
// batch at a time, ended by SYN_REPORT, as the driver offers buffers on the
// event queue; LED events on the status queue are taken and dropped.

import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { dbg_assert } from "./log.js";

// configuration selectors
const CFG_ID_NAME = 0x01;
const CFG_ID_DEVIDS = 0x03;
const CFG_PROP_BITS = 0x10;
const CFG_EV_BITS = 0x11;
const CFG_ABS_INFO = 0x12;

// event types and codes (Linux include/uapi/linux/input-event-codes.h)
const EV_SYN = 0, EV_KEY = 1, EV_REL = 2, EV_ABS = 3, EV_LED = 0x11, EV_REP = 0x14;
const SYN_REPORT = 0;
const REL_WHEEL = 8;
const ABS_X = 0, ABS_Y = 1;
const ABS_MT_SLOT = 0x2F, ABS_MT_POSITION_X = 0x35, ABS_MT_POSITION_Y = 0x36, ABS_MT_TRACKING_ID = 0x39;
const INPUT_PROP_DIRECT = 0x01;
/** the multi-touch screen's slots: 0-10, as QEMU's (INPUT_EVENT_SLOTS_MAX) */
const MT_SLOTS = 11;
const BTN_LEFT = 0x110, BTN_RIGHT = 0x111, BTN_MIDDLE = 0x112, BTN_SIDE = 0x113, BTN_EXTRA = 0x114;
const BTN_TOUCH = 0x14A, BTN_GEAR_DOWN = 0x150, BTN_GEAR_UP = 0x151;
const LED_NUML = 0, LED_CAPSL = 1, LED_SCROLLL = 2;
const KEY_PAUSE = 119;
const BUS_VIRTUAL = 6;
const ABS_MAX = 0x7FFF;

/** Set-1 scancodes after 0xE0 and their evdev key codes */
const EXTENDED_KEYS = new Map([
    [0x10, 165], [0x19, 163], [0x1C, 96], [0x1D, 97], [0x20, 113], [0x22, 164], [0x24, 166], [0x2E, 114], [0x30, 115],
    [0x35, 98], [0x37, 99], [0x38, 100], [0x47, 102], [0x48, 103], [0x49, 104], [0x4B, 105], [0x4D, 106], [0x4F, 107],
    [0x50, 108], [0x51, 109], [0x52, 110], [0x53, 111], [0x5B, 125], [0x5C, 126], [0x5D, 127], [0x5E, 116], [0x5F, 142],
    [0x63, 143],
]);
/** (the make codes 0x01-0x58 are the key codes themselves, but 0x54 and 0x55) */
const plain_key = code => code >= 0x01 && code <= 0x58 && code !== 0x54 && code !== 0x55 ? code : 0;

const EVENT_BYTES = 8;
/** Events kept while the driver has no buffers for them */
const PENDING_LIMIT = 256;

/**
 * A bitmap of `bits`, as long as its highest set bit needs
 * @param {!Array<number>} bits
 * @return {!Uint8Array}
 */
function bitmap(bits)
{
    const bytes = new Uint8Array(bits.length ? (Math.max(...bits) >> 3) + 1 : 0);
    for(const bit of bits) bytes[bit >> 3] |= 1 << (bit & 7);
    return bytes;
}

/** @param {!Array<number>} words little-endian 16-bit values */
const u16s = words => new Uint8Array(new Uint16Array(words).buffer);

/**
 * @constructor
 * @param {?} cpu
 * @param {?} bus
 * @param {string} kind "keyboard", "tablet" or "multitouch"
 * @param {?} transport the device's transport (src/virtio_mmio.js), or null: on the PCIe host at `pci_id`
 * @param {number=} pci_id
 * @param {boolean=} mouse_as_touch (multitouch) the mouse as one finger: no tablet takes it
 */
export function VirtioInput(cpu, bus, kind, transport, pci_id, mouse_as_touch)
{
    dbg_assert(transport || pci_id !== undefined && cpu.devices.pci.generic, "virtio-input: on the virt machine's transports only");
    dbg_assert(kind === "keyboard" || kind === "tablet" || kind === "multitouch");
    this.kind = kind;
    /** @type {!Map<string, !Uint8Array>} the configuration by select and subsel ("select,subsel") */
    this.config = new Map();
    const name = { "keyboard": "QEMU Virtio Keyboard", "tablet": "QEMU Virtio Tablet", "multitouch": "QEMU Virtio MultiTouch" }[kind];
    this.config.set(CFG_ID_NAME + ",0", new TextEncoder().encode(name + "\0"));
    this.config.set(CFG_ID_DEVIDS + ",0", u16s([BUS_VIRTUAL, 0x0627, kind === "keyboard" ? 1 : 3, kind === "tablet" ? 2 : 1]));
    // (min, max, fuzz, flat, res)
    const axis = max => new Uint8Array(new Uint32Array([0, max, 0, 0, 0]).buffer);
    const buttons = [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA, BTN_TOUCH, BTN_GEAR_DOWN, BTN_GEAR_UP];
    if(kind === "keyboard")
    {
        const keys = [];
        for(let code = 1; code <= 0x58; code++) if(plain_key(code)) keys.push(code);
        keys.push(...EXTENDED_KEYS.values(), KEY_PAUSE);
        this.config.set(CFG_EV_BITS + "," + EV_KEY, bitmap(keys));
        this.config.set(CFG_EV_BITS + "," + EV_REP, new Uint8Array(1));
        this.config.set(CFG_EV_BITS + "," + EV_LED, bitmap([LED_NUML, LED_CAPSL, LED_SCROLLL]));
    }
    else if(kind === "tablet")
    {
        this.config.set(CFG_EV_BITS + "," + EV_KEY, bitmap(buttons));
        this.config.set(CFG_EV_BITS + "," + EV_ABS, bitmap([ABS_X, ABS_Y]));
        this.config.set(CFG_EV_BITS + "," + EV_REL, new Uint8Array([0, 1 << REL_WHEEL - 8]));
        this.config.set(CFG_ABS_INFO + "," + ABS_X, axis(ABS_MAX));
        this.config.set(CFG_ABS_INFO + "," + ABS_Y, axis(ABS_MAX));
    }
    else
    {
        this.config.set(CFG_PROP_BITS + ",0", bitmap([INPUT_PROP_DIRECT]));
        this.config.set(CFG_EV_BITS + "," + EV_KEY, bitmap(buttons));
        this.config.set(CFG_EV_BITS + "," + EV_ABS, bitmap([ABS_MT_SLOT, ABS_MT_TRACKING_ID, ABS_MT_POSITION_X, ABS_MT_POSITION_Y]));
        this.config.set(CFG_ABS_INFO + "," + ABS_MT_SLOT, axis(MT_SLOTS - 1));
        this.config.set(CFG_ABS_INFO + "," + ABS_MT_TRACKING_ID, axis(MT_SLOTS - 1));
        this.config.set(CFG_ABS_INFO + "," + ABS_MT_POSITION_X, axis(ABS_MAX));
        this.config.set(CFG_ABS_INFO + "," + ABS_MT_POSITION_Y, axis(ABS_MAX));
    }
    this.select = 0;
    this.subsel = 0;
    /** @type {!Array<!Array<number>>} [type, code, value] not yet in the guest's buffers */
    this.pending = [];
    // the host side's state: a scancode sequence in progress, buttons and position
    this.prefix = 0;
    this.pause_bytes = 0;
    this.buttons = [false, false, false];
    this.last_x = -1;
    this.last_y = -1;
    /** @type {!Array<?{id: *, x: number, y: number}>} the multi-touch slots: the touch in each (by the host's identifier) */
    this.slots = new Array(MT_SLOTS).fill(null);

    const selected = () => this.config.get(this.select + "," + this.subsel) || new Uint8Array(0);
    const struct = [
        { bytes: 1, name: "select", read: () => this.select, write: value => { this.select = value & 0xFF; } },
        { bytes: 1, name: "subsel", read: () => this.subsel, write: value => { this.subsel = value & 0xFF; } },
        { bytes: 1, name: "size", read: () => selected().length, write: () => {} },
        { bytes: 1, name: "reserved0", read: () => 0, write: () => {} },
        { bytes: 4, name: "reserved1", read: () => 0, write: () => {} },
    ];
    for(let i = 0; i < 128; i += 4)
    {
        struct.push({
            bytes: 4,
            name: "u" + i,
            read: () => { const b = selected(); return (b[i] | 0) | (b[i + 1] | 0) << 8 | (b[i + 2] | 0) << 16 | (b[i + 3] | 0) << 24; },
            write: () => {},
        });
    }

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-input-" + kind,
        device_id: 0x1052,
        subsystem_device_id: 18,
        // (on the PCIe host: a keyboard, or another input device, as QEMU's)
        class_code: kind === "keyboard" ? 0x090000 : 0x098000,
        common:
        {
            queues: [{ size_supported: 64, notify_offset: 0 }, { size_supported: 64, notify_offset: 1 }],
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok: () => this.flush(),
        },
        notification:
        {
            single_handler: false,
            handlers: [
                () => this.flush(),
                () => this.take_status(),
            ],
        },
        isr_status: {},
        device_specific: { struct },
        on_reset: () => { this.pending = []; },
        transport: transport || undefined,
        pci_id,
    });

    if(kind === "keyboard")
    {
        bus.register("keyboard-code", code => this.scancode(code), this);
    }
    else if(kind === "tablet")
    {
        bus.register("mouse-absolute", data => this.absolute(data), this);
        bus.register("mouse-click", data => this.click(data), this);
        bus.register("mouse-wheel", data => this.wheel(data), this);
    }
    else
    {
        bus.register("touch", data => this.touch({ touches: data["touches"], width: data["width"], height: data["height"] }), this);
        if(mouse_as_touch)
        {
            /** the mouse on the screen: x, y, the screen's width and height (mouse-absolute) */
            this.pointer = null;
            this.pointer_down = false;
            bus.register("mouse-absolute", data => { this.pointer = data; if(this.pointer_down) this.touch_pointer(); }, this);
            bus.register("mouse-click", data =>
            {
                if(!!data[0] === this.pointer_down) return;
                this.pointer_down = !!data[0];
                this.touch_pointer();
            }, this);
        }
    }
}

/** The mouse as a finger: touching while the left button is down, where the mouse is */
VirtioInput.prototype.touch_pointer = function()
{
    const p = this.pointer;
    if(!p) return;
    this.touch({ touches: this.pointer_down ? [["mouse", p[0], p[1]]] : [], width: p[2], height: p[3] });
};

/**
 * The touches on the screen now: [[identifier, x, y], ...], width, height.
 * A new touch takes a free slot and a tracking ID (its slot's number, as
 * QEMU's); one that ended frees its slot (tracking ID -1); BTN_TOUCH is
 * down while any touch is.
 * @param {{touches: !Array<!Array<?>>, width: number, height: number}} data
 */
VirtioInput.prototype.touch = function(data)
{
    const events = [];
    const scale = (value, size) => Math.max(0, Math.min(ABS_MAX, Math.round(value / size * ABS_MAX)));
    const was_down = this.slots.some(s => !!s);
    const ids = new Set(data.touches.map(t => t[0]));
    // (ABS_MT_SLOT only where the slot changes)
    let selected = -1;
    const select = i => { if(i !== selected) events.push([EV_ABS, ABS_MT_SLOT, i]); selected = i; };
    this.slots.forEach((slot, i) => {
        if(slot && !ids.has(slot.id))
        {
            select(i);
            events.push([EV_ABS, ABS_MT_TRACKING_ID, -1]);
            this.slots[i] = null;
        }
    });
    for(const [id, x, y] of data.touches)
    {
        const at_x = scale(x, data.width), at_y = scale(y, data.height);
        let i = this.slots.findIndex(s => !!s && s.id === id);
        if(i < 0)
        {
            i = this.slots.indexOf(null);
            if(i < 0) continue;
            this.slots[i] = { id, x: -1, y: -1 };
            select(i);
            events.push([EV_ABS, ABS_MT_TRACKING_ID, i]);
        }
        const slot = /** @type {{id: *, x: number, y: number}} */ (this.slots[i]);
        if(at_x === slot.x && at_y === slot.y) continue;
        select(i);
        if(at_x !== slot.x) events.push([EV_ABS, ABS_MT_POSITION_X, at_x]);
        if(at_y !== slot.y) events.push([EV_ABS, ABS_MT_POSITION_Y, at_y]);
        slot.x = at_x;
        slot.y = at_y;
    }
    const down = this.slots.some(s => !!s);
    if(down !== was_down) events.push([EV_KEY, BTN_TOUCH, down ? 1 : 0]);
    if(events.length) this.send(events);
};

/**
 * One byte of a set-1 scancode sequence: a key goes down (make) or up
 * (break, bit 7); 0xE0 prefixes the extended keys, 0xE1 1D 45 (and E1 9D C5)
 * is Pause; the fake shifts around extended keys (E0 2A, E0 36) are dropped
 * @param {number} code
 */
VirtioInput.prototype.scancode = function(code)
{
    code &= 0xFF;
    if(this.pause_bytes)
    {
        // (E1 1D 45: Pause down; E1 9D C5: up)
        if(--this.pause_bytes === 0) this.send([[EV_KEY, KEY_PAUSE, code & 0x80 ? 0 : 1]]);
        return;
    }
    if(code === 0xE1)
    {
        this.pause_bytes = 2;
        return;
    }
    if(code === 0xE0)
    {
        this.prefix = 0xE0;
        return;
    }
    const extended = this.prefix === 0xE0;
    this.prefix = 0;
    const make = code & 0x7F;
    const key = extended ? EXTENDED_KEYS.get(make) || 0 : plain_key(make);
    if(key)
    {
        this.send([[EV_KEY, key, code & 0x80 ? 0 : 1]]);
    }
};

/** @param {!Array<number>} data [x, y, width, height] of the pointer on the screen */
VirtioInput.prototype.absolute = function(data)
{
    const x = Math.max(0, Math.min(ABS_MAX, Math.round(data[0] / data[2] * ABS_MAX)));
    const y = Math.max(0, Math.min(ABS_MAX, Math.round(data[1] / data[3] * ABS_MAX)));
    const events = [];
    if(x !== this.last_x) events.push([EV_ABS, ABS_X, x]);
    if(y !== this.last_y) events.push([EV_ABS, ABS_Y, y]);
    this.last_x = x;
    this.last_y = y;
    if(events.length) this.send(events);
};

/** @param {!Array<boolean>} data [left, middle, right] */
VirtioInput.prototype.click = function(data)
{
    const codes = [BTN_LEFT, BTN_MIDDLE, BTN_RIGHT];
    const events = [];
    for(let i = 0; i < 3; i++)
    {
        if(!!data[i] !== this.buttons[i]) events.push([EV_KEY, codes[i], data[i] ? 1 : 0]);
        this.buttons[i] = !!data[i];
    }
    if(events.length) this.send(events);
};

/** @param {!Array<number>} data [vertical, horizontal]: positive is up */
VirtioInput.prototype.wheel = function(data)
{
    if(data[0]) this.send([[EV_REL, REL_WHEEL, data[0] | 0]]);
};

/**
 * A batch of events, then SYN_REPORT; while the driver is not ready, or
 * has no buffers, they wait (at most PENDING_LIMIT events: older batches go)
 * @param {!Array<!Array<number>>} events
 */
VirtioInput.prototype.send = function(events)
{
    this.pending.push(...events, [EV_SYN, SYN_REPORT, 0]);
    while(this.pending.length > PENDING_LIMIT)
    {
        // (drop the oldest batch, through its SYN_REPORT)
        const end = this.pending.findIndex(([type]) => type === EV_SYN);
        this.pending.splice(0, end + 1);
    }
    this.flush();
};

/** The pending events into the event queue's buffers */
VirtioInput.prototype.flush = function()
{
    const queue = this.virtio.queues[0];
    if(!this.pending.length || !queue.is_configured() || !this.virtio.present()) return;
    let sent = 0;
    while(sent < this.pending.length && queue.has_request())
    {
        const chain = queue.pop_request();
        const [type, code, value] = this.pending[sent++];
        const event = new Uint8Array(EVENT_BYTES);
        const view = new DataView(event.buffer);
        view.setUint16(0, type, true);
        view.setUint16(2, code, true);
        view.setInt32(4, value, true);
        chain.set_next_blob(event);
        queue.push_reply(chain);
    }
    this.pending.splice(0, sent);
    if(sent) queue.flush_replies();
};

/** The driver's events (LEDs) on the status queue: taken and dropped */
VirtioInput.prototype.take_status = function()
{
    const queue = this.virtio.queues[1];
    let taken = 0;
    while(queue.has_request())
    {
        queue.push_reply(queue.pop_request());
        taken++;
    }
    if(taken) queue.flush_replies();
};

VirtioInput.prototype.reset = function()
{
    this.virtio.reset();
};

VirtioInput.prototype.get_state = function()
{
    return [this.virtio, this.select, this.subsel, [].concat(...this.pending),
        this.slots.map(slot => slot && [slot.id, slot.x, slot.y])];
};

VirtioInput.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.select = state[1];
    this.subsel = state[2];
    this.pending = [];
    const flat = state[3] || [];
    for(let i = 0; i + 2 < flat.length; i += 3) this.pending.push([flat[i], flat[i + 1], flat[i + 2]]);
    this.slots = (state[4] || new Array(MT_SLOTS).fill(null)).map(slot => slot && { id: slot[0], x: slot[1], y: slot[2] });
};
