// The Android emulator's goldfish devices, as the ranchu machine has them
// (docs/aarch32-plan.md R6.2; src/virt/ranchu.js): what its system images'
// kernels drive (Linux 3.10's drivers/video/goldfishfb.c,
// drivers/input/keyboard/goldfish_events.c, drivers/power/goldfish_battery.c,
// drivers/staging/goldfish/goldfish_audio.c, drivers/platform/goldfish/
// goldfish_pipe.c) with the emulator's register interfaces:
//
// - the framebuffer: RGB565, the size the machine gives, its base set by the
//   driver (a pan: the frame shown, and BASE_UPDATE_DONE); or, with
//   `scanout` (the ranchu machine's 32-bit kernel, whose goldfish_fb cannot
//   allocate its memory: LPAE without ZONE_DMA), a simple-framebuffer of the
//   device tree at a fixed place, shown at up to 20 frames a second when it changed;
// - the events: one device, "qwerty2" (the image's qwerty2.idc makes it a
//   touch screen and a keyboard): the bus's set-1 scancodes as EV_KEY, the
//   pointer and its left button as one touch (ABS_X/Y, MT slot 0, BTN_TOUCH);
//   one event per three reads of REG_READ, the interrupt up while any wait;
// - the battery: AC online, charging, full;
// - the audio output: two write buffers, each consumed in the time its
//   samples (16-bit stereo, 44.1 kHz) take, then BUFFER_EMPTY; nothing is
//   played; no input;
// - the pipe (version 1, no batch buffer: every command through the
//   registers): channels the guest opens, named by their first write
//   ("pipe:<service>\0"); the services are qemud's boot-properties (the
//   machine's properties, then an empty frame), hw-control and sensors
//   (accepted: no sensors, every control ignored), and those the machine
//   adds (the GLES host's "opengles" and "GLProcessPipe": src/gles/,
//   ranchu_gpu "host"); any other name is refused (the guest's open
//   fails, as for a service the emulator lacks).

/** Linux's input event types and codes (include/uapi/linux/input-event-codes.h) */
const EV_SYN = 0;
const EV_KEY = 1;
const EV_ABS = 3;
const SYN_REPORT = 0;
const ABS_X = 0;
const ABS_Y = 1;
const ABS_MT_SLOT = 0x2F;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const ABS_MT_TRACKING_ID = 0x39;
const BTN_TOUCH = 0x14A;
const ABS_RANGE = 0x7FFF;
/** Set-1 scancodes after 0xE0 and their evdev key codes (src/virtio_input.js's) */
const EXTENDED_KEYS = new Map([
    [0x10, 165], [0x19, 163], [0x1C, 96], [0x1D, 97], [0x20, 113], [0x22, 164], [0x24, 166], [0x2E, 114], [0x30, 115],
    [0x35, 98], [0x37, 99], [0x38, 100], [0x47, 102], [0x48, 103], [0x49, 104], [0x4B, 105], [0x4D, 106], [0x4F, 107],
    [0x50, 108], [0x51, 109], [0x52, 110], [0x53, 111], [0x5B, 125], [0x5C, 126], [0x5D, 127], [0x5E, 116],
    [0x5F, 142], [0x63, 143],
]);
const plain_key = code => code >= 0x01 && code <= 0x58 && code !== 0x54 && code !== 0x55 ? code : 0;
/** The keys besides the keyboard's: HOME, BACK, MENU, POWER, the volume, SEARCH, APPSELECT */
const ANDROID_KEYS = [102, 158, 139, 116, 114, 115, 217, 580];

/**
 * @param {!Array<number>} bits
 * @return {!Uint8Array} a bitmap of them
 */
function bitmap(bits)
{
    const bytes = new Uint8Array(bits.length ? (Math.max(...bits) >> 3) + 1 : 0);
    for(const bit of bits) bytes[bit >> 3] |= 1 << (bit & 7);
    return bytes;
}

// ---- the framebuffer

const FB_GET_WIDTH = 0x00;
const FB_GET_HEIGHT = 0x04;
const FB_INT_STATUS = 0x08;
const FB_INT_ENABLE = 0x0C;
const FB_SET_BASE = 0x10;
const FB_SET_ROTATION = 0x14;
const FB_SET_BLANK = 0x18;
const FB_GET_PHYS_WIDTH = 0x1C;
const FB_GET_PHYS_HEIGHT = 0x20;
const FB_INT_VSYNC = 1;
const FB_INT_BASE_UPDATE_DONE = 2;

/**
 * @constructor
 * @param {?} cpu the ARM CPU (src/arm/cpu.js)
 * @param {number} base
 * @param {number} intid
 * @param {{width: number, height: number, dpi: number}} display
 * @param {number=} scanout a simple-framebuffer's base, shown without the driver's pans
 */
export function GoldfishFb(cpu, base, intid, display, scanout = 0)
{
    this.scanout = scanout;
    /** (scanout) the frame last shown, and the vblanks since */
    this.shown = null;
    this.vblanks = 0;
    /** the frames drawn to the screen (diagnostics) */
    this.frames = 0;
    this.name = "goldfish-fb";
    this.cpu = cpu;
    this.intid = intid;
    this.width = display.width;
    this.height = display.height;
    this.dpi = display.dpi;
    this.rgba = new Uint8ClampedArray(this.width * this.height * 4);
    this.reset();
    cpu.io.register_mmio(base, 0x1000, {
        read: offset => this.read(offset),
        write: (offset, width, value) => this.write(offset, Number(value)),
        name: this.name,
    });
    /** @type {?} the display hub (src/display.js) */
    this.hub = cpu.devices.display;
    this.hub.add_source(this);
    this.hub.set_mode(true);
    this.hub.set_size_graphical(this.width, this.height, this.width, this.height, 32);
}

GoldfishFb.prototype.reset = function()
{
    this.base = this.scanout;
    this.int_status = 0;
    this.int_enable = 0;
    this.blank = 0;
    this.rotation = 0;
    this.dirty = true;
};

GoldfishFb.prototype.update_irq = function()
{
    this.cpu.set_irq(this.intid, (this.int_status & this.int_enable) !== 0);
};

GoldfishFb.prototype.read = function(offset)
{
    switch(offset)
    {
        case FB_GET_WIDTH: return this.width;
        case FB_GET_HEIGHT: return this.height;
        case FB_INT_STATUS:
        {
            const status = this.int_status & this.int_enable;
            this.int_status = 0;
            this.update_irq();
            return status;
        }
        case FB_INT_ENABLE: return this.int_enable;
        // (the screen's size in millimetres at its density)
        case FB_GET_PHYS_WIDTH: return Math.round(this.width * 25.4 / this.dpi);
        case FB_GET_PHYS_HEIGHT: return Math.round(this.height * 25.4 / this.dpi);
    }
    return 0;
};

GoldfishFb.prototype.write = function(offset, value)
{
    switch(offset)
    {
        case FB_INT_ENABLE:
            this.int_enable = value;
            this.update_irq();
            break;
        case FB_SET_BASE:
            // (a pan: this frame is the one shown)
            this.base = value >>> 0;
            this.dirty = true;
            this.render();
            this.int_status |= FB_INT_BASE_UPDATE_DONE;
            this.update_irq();
            break;
        case FB_SET_ROTATION: this.rotation = value; break;
        case FB_SET_BLANK: this.blank = value; this.dirty = true; break;
    }
};

// (DisplaySource: src/display.js)
GoldfishFb.prototype.vblank_period = function() { return 1000 / 60; };
GoldfishFb.prototype.on_vblank = function()
{
    // (a simple-framebuffer: every third retrace, if its bytes changed)
    if(this.scanout && ++this.vblanks % 3 === 0) this.render_changed();
    if(this.int_enable & FB_INT_VSYNC)
    {
        this.int_status |= FB_INT_VSYNC;
        this.update_irq();
    }
};
GoldfishFb.prototype.invalidate = function() { this.dirty = true; };

/** (scanout) the frame, if it is not the one shown */
GoldfishFb.prototype.render_changed = function()
{
    let bytes;
    try { bytes = this.cpu.read_blob_physical(this.base, this.width * this.height * 2); }
    catch(e) { return; }
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
    const shown = this.shown;
    if(shown && !this.dirty)
    {
        let same = true;
        for(let i = 0; i < words.length; i++) if(words[i] !== shown[i]) { same = false; break; }
        if(same) return;
    }
    this.shown = words;
    this.dirty = true;
    this.render(bytes);
};

/**
 * The frame at the base, RGB565, to the screen
 * @param {Uint8Array=} source its bytes, read already
 */
GoldfishFb.prototype.render = function(source)
{
    if(!this.dirty || !this.base) return;
    this.dirty = false;
    this.frames++;
    const pixels = this.width * this.height;
    const rgba = this.rgba;
    if(this.blank)
    {
        rgba.fill(0);
        for(let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    }
    else
    {
        if(!source)
        {
            try { source = this.cpu.read_blob_physical(this.base, pixels * 2); }
            catch(e) { return; }
        }
        const words = new Uint16Array(source.buffer, source.byteOffset, pixels);
        for(let i = 0, o = 0; i < pixels; i++, o += 4)
        {
            const p = words[i];
            const r = p >> 11, g = p >> 5 & 63, b = p & 31;
            rgba[o] = r << 3 | r >> 2;
            rgba[o + 1] = g << 2 | g >> 4;
            rgba[o + 2] = b << 3 | b >> 2;
            rgba[o + 3] = 255;
        }
    }
    this.hub.update_buffer([{ pixels: { data: rgba, width: this.width, height: this.height }, screen_x: 0, screen_y: 0,
        buffer_x: 0, buffer_y: 0, buffer_width: this.width, buffer_height: this.height }]);
};

/**
 * A frame from the GLES host (ranchu_gpu "host": SurfaceFlinger's posts,
 * read back from the page), RGBA rows from the top, shown in place of the
 * framebuffer's: its size the display's, or cut to it
 * @param {!Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
GoldfishFb.prototype.present = function(rgba, width, height)
{
    this.frames++;
    const w = Math.min(width, this.width), h = Math.min(height, this.height);
    if(w === this.width && h === this.height && width === this.width) this.rgba.set(rgba.subarray(0, this.rgba.length));
    else for(let y = 0; y < h; y++) this.rgba.set(rgba.subarray(y * width * 4, (y * width + w) * 4), y * this.width * 4);
    this.hub.update_buffer([{ pixels: { data: this.rgba, width: this.width, height: this.height }, screen_x: 0, screen_y: 0,
        buffer_x: 0, buffer_y: 0, buffer_width: this.width, buffer_height: this.height }]);
};

GoldfishFb.prototype.get_state = function()
{
    return [this.base, this.int_status, this.int_enable, this.blank, this.rotation];
};
GoldfishFb.prototype.set_state = function(state)
{
    [this.base, this.int_status, this.int_enable, this.blank, this.rotation] = state;
    this.dirty = true;
    this.update_irq();
};

// ---- the events

const REG_READ = 0x00;
const REG_SET_PAGE = 0x00;
const REG_LEN = 0x04;
const REG_DATA = 0x08;
const PAGE_NAME = 0x00000;
const PAGE_EVBITS = 0x10000;
const PAGE_ABSDATA = 0x20000 | EV_ABS;
const EVENTS_LIMIT = 1024;

/**
 * @constructor
 * @param {?} cpu
 * @param {?} bus the device bus (the host's keyboard and pointer)
 * @param {number} base
 * @param {number} intid
 */
export function GoldfishEvents(cpu, bus, base, intid)
{
    this.name = "goldfish-events";
    this.cpu = cpu;
    this.bus = bus;
    this.intid = intid;
    /** @type {boolean|undefined} a driver probed (mouse-enable said) */
    this.driver = undefined;
    const keys = [];
    for(let k = 1; k < 256; k++) keys.push(k);
    keys.push(...ANDROID_KEYS, BTN_TOUCH);
    const abs = [ABS_X, ABS_Y, ABS_MT_SLOT, ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_TRACKING_ID];
    /** the pages: the name, each event type's bits, the axes' ranges (min, max, fuzz, flat) */
    this.pages = new Map([
        [PAGE_NAME, new TextEncoder().encode("qwerty2")],
        [PAGE_EVBITS | EV_SYN, bitmap([EV_SYN, EV_KEY, EV_ABS])],
        [PAGE_EVBITS | EV_KEY, bitmap(keys)],
        [PAGE_EVBITS | EV_ABS, bitmap(abs)],
    ]);
    const ranges = new Uint32Array(4 * (ABS_MT_TRACKING_ID + 1));
    for(const axis of [ABS_X, ABS_Y, ABS_MT_POSITION_X, ABS_MT_POSITION_Y]) ranges.set([0, ABS_RANGE, 0, 0], 4 * axis);
    ranges.set([0, 0, 0, 0], 4 * ABS_MT_SLOT);
    ranges.set([0, 0xFFFF, 0, 0], 4 * ABS_MT_TRACKING_ID);
    this.pages.set(PAGE_ABSDATA, new Uint8Array(ranges.buffer));
    this.reset();
    cpu.io.register_mmio(base, 0x1000, {
        read: (offset, width) => this.read(offset, width),
        write: (offset, width, value) => this.write(offset, Number(value)),
        name: this.name,
    });
    bus.register("keyboard-code", code => this.scancode(code), this);
    bus.register("mouse-absolute", data => this.absolute(data), this);
    bus.register("mouse-click", data => this.click(data), this);
}

GoldfishEvents.prototype.reset = function()
{
    this.page = PAGE_NAME;
    /** @type {!Array<number>} type, code, value, ... */
    this.queue = [];
    this.read_index = 0;
    this.prefix = 0;
    this.touching = false;
    this.tracking_id = 0;
    this.x = 0;
    this.y = 0;
    this.update_irq();
    this.driver_ready(false);
};

/**
 * The guest's driver probes (it selects the pages: the name, the event bits,
 * the axes) or the machine resets: the page's mouse adapter takes the mouse
 * and touches over the screen only while a driver runs (src/browser/mouse.js:
 * "mouse-enable", as the PS/2 controller says for its mouse; ranchu has none).
 * A touch screen's positions are absolute and it has no cursor of its own
 * ("absolute-pointer"): the page locks no pointer and keeps the host's cursor.
 * @param {boolean} ready
 */
GoldfishEvents.prototype.driver_ready = function(ready)
{
    if(ready === this.driver) return;
    this.driver = ready;
    this.bus.send("mouse-enable", ready);
    this.bus.send("absolute-pointer", [ready, false]);
};

GoldfishEvents.prototype.update_irq = function()
{
    this.cpu.set_irq(this.intid, this.queue.length > 0);
};

GoldfishEvents.prototype.read = function(offset, width)
{
    if(offset === REG_READ)
    {
        if(!this.queue.length) return 0;
        const value = this.queue.shift();
        if(!this.queue.length) this.update_irq();
        return value >>> 0;
    }
    const page = this.pages.get(this.page) || new Uint8Array(0);
    if(offset === REG_LEN) return page.length;
    if(offset >= REG_DATA)
    {
        let value = 0;
        for(let i = 0; i < width; i++) value |= (page[offset - REG_DATA + i] || 0) << (8 * i);
        return value >>> 0;
    }
    return 0;
};

GoldfishEvents.prototype.write = function(offset, value)
{
    if(offset === REG_SET_PAGE)
    {
        this.page = value >>> 0;
        this.driver_ready(true);
    }
};

/** @param {!Array<!Array<number>>} events [type, code, value]..., SYN_REPORT after them */
GoldfishEvents.prototype.send = function(events)
{
    for(const [type, code, value] of events) this.queue.push(type, code, value);
    this.queue.push(EV_SYN, SYN_REPORT, 0);
    // (a guest that does not read them: the oldest go)
    if(this.queue.length > 3 * EVENTS_LIMIT) this.queue.splice(0, this.queue.length - 3 * EVENTS_LIMIT);
    this.update_irq();
};

/** @param {number} code a set-1 scancode byte */
GoldfishEvents.prototype.scancode = function(code)
{
    code &= 0xFF;
    if(code === 0xE0)
    {
        this.prefix = 0xE0;
        return;
    }
    const extended = this.prefix === 0xE0;
    this.prefix = 0;
    const make = code & 0x7F;
    const key = extended ? EXTENDED_KEYS.get(make) || 0 : plain_key(make);
    if(key) this.send([[EV_KEY, key, code & 0x80 ? 0 : 1]]);
};

/** @param {!Array<number>} data [x, y, width, height] of the pointer on the screen */
GoldfishEvents.prototype.absolute = function(data)
{
    this.x = Math.max(0, Math.min(ABS_RANGE, Math.round(data[0] / data[2] * ABS_RANGE)));
    this.y = Math.max(0, Math.min(ABS_RANGE, Math.round(data[1] / data[3] * ABS_RANGE)));
    if(this.touching)
    {
        this.send([[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_POSITION_X, this.x], [EV_ABS, ABS_MT_POSITION_Y, this.y],
            [EV_ABS, ABS_X, this.x], [EV_ABS, ABS_Y, this.y]]);
    }
};

/** @param {!Array<boolean>} data [left, middle, right]: the left button touches */
GoldfishEvents.prototype.click = function(data)
{
    const down = !!data[0];
    if(down === this.touching) return;
    this.touching = down;
    if(down)
    {
        this.tracking_id = this.tracking_id + 1 & 0xFFFF;
        this.send([[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_TRACKING_ID, this.tracking_id], [EV_ABS, ABS_MT_POSITION_X, this.x],
            [EV_ABS, ABS_MT_POSITION_Y, this.y], [EV_KEY, BTN_TOUCH, 1], [EV_ABS, ABS_X, this.x], [EV_ABS, ABS_Y, this.y]]);
    }
    else
    {
        this.send([[EV_ABS, ABS_MT_SLOT, 0], [EV_ABS, ABS_MT_TRACKING_ID, -1], [EV_KEY, BTN_TOUCH, 0]]);
    }
};

/**
 * A touch at (x, y) in the screen's pixels of width by height, down and up (tests)
 * @param {number} x @param {number} y @param {number} width @param {number} height
 */
GoldfishEvents.prototype.tap = function(x, y, width, height)
{
    this.absolute([x, y, width, height]);
    this.click([true]);
    this.click([false]);
};

GoldfishEvents.prototype.get_state = function() { return [this.page, this.queue.slice(), this.tracking_id, this.driver]; };
GoldfishEvents.prototype.set_state = function(state)
{
    [this.page, this.queue, this.tracking_id] = state;
    this.touching = false;
    this.update_irq();
    // (older states: a driver that probed left another page selected)
    this.driver = undefined;
    this.driver_ready(state[3] ?? this.page !== PAGE_NAME);
};

// ---- the battery

const BATTERY_INT_STATUS = 0x00;
const BATTERY_INT_ENABLE = 0x04;
const BATTERY_AC_ONLINE = 0x08;
const BATTERY_STATUS = 0x0C;
const BATTERY_HEALTH = 0x10;
const BATTERY_PRESENT = 0x14;
const BATTERY_CAPACITY = 0x18;

/**
 * @constructor
 * @param {?} cpu
 * @param {number} base
 */
export function GoldfishBattery(cpu, base)
{
    this.name = "goldfish-battery";
    this.int_enable = 0;
    cpu.io.register_mmio(base, 0x1000, {
        read: offset => this.read(offset),
        write: (offset, width, value) => { if(offset === BATTERY_INT_ENABLE) this.int_enable = Number(value); },
        name: this.name,
    });
}

GoldfishBattery.prototype.read = function(offset)
{
    switch(offset)
    {
        case BATTERY_INT_STATUS: return 0;
        case BATTERY_INT_ENABLE: return this.int_enable;
        case BATTERY_AC_ONLINE: return 1;
        // (POWER_SUPPLY_STATUS_CHARGING, POWER_SUPPLY_HEALTH_GOOD)
        case BATTERY_STATUS: return 1;
        case BATTERY_HEALTH: return 1;
        case BATTERY_PRESENT: return 1;
        case BATTERY_CAPACITY: return 100;
    }
    return 0;
};

GoldfishBattery.prototype.get_state = function() { return [this.int_enable]; };
GoldfishBattery.prototype.set_state = function(state) { [this.int_enable] = state; };

// ---- the audio output

const AUDIO_INT_STATUS = 0x00;
const AUDIO_INT_ENABLE = 0x04;
const AUDIO_SET_WRITE_BUFFER_1 = 0x08;
const AUDIO_SET_WRITE_BUFFER_2 = 0x0C;
const AUDIO_WRITE_BUFFER_1 = 0x10;
const AUDIO_WRITE_BUFFER_2 = 0x14;
const AUDIO_READ_SUPPORTED = 0x18;
const AUDIO_INT_WRITE_BUFFER_1_EMPTY = 1;
const AUDIO_INT_WRITE_BUFFER_2_EMPTY = 2;
/** 16-bit stereo at 44.1 kHz, in bytes a millisecond */
const AUDIO_BYTES_PER_MS = 44100 * 4 / 1000;

/**
 * @constructor
 * @param {?} cpu
 * @param {number} base
 * @param {number} intid
 */
export function GoldfishAudio(cpu, base, intid)
{
    this.name = "goldfish-audio";
    this.cpu = cpu;
    this.intid = intid;
    this.reset();
    cpu.io.register_mmio(base, 0x1000, {
        read: offset => this.read(offset),
        write: (offset, width, value) => this.write(offset, Number(value)),
        name: this.name,
    });
}

GoldfishAudio.prototype.reset = function()
{
    this.int_status = 0;
    this.int_enable = 0;
    /** when each buffer is consumed (machine milliseconds), or -1 */
    this.done = [-1, -1];
};

GoldfishAudio.prototype.update_irq = function()
{
    this.cpu.set_irq(this.intid, (this.int_status & this.int_enable) !== 0);
};

GoldfishAudio.prototype.read = function(offset)
{
    if(offset === AUDIO_INT_STATUS)
    {
        this.timer(this.cpu.clock.now());
        const status = this.int_status;
        this.int_status = 0;
        this.update_irq();
        return status;
    }
    if(offset === AUDIO_INT_ENABLE) return this.int_enable;
    if(offset === AUDIO_READ_SUPPORTED) return 0;
    return 0;
};

GoldfishAudio.prototype.write = function(offset, value)
{
    switch(offset)
    {
        case AUDIO_INT_ENABLE:
            this.int_enable = value;
            this.update_irq();
            break;
        case AUDIO_SET_WRITE_BUFFER_1:
        case AUDIO_SET_WRITE_BUFFER_2:
            break;
        case AUDIO_WRITE_BUFFER_1:
        case AUDIO_WRITE_BUFFER_2:
        {
            const which = offset === AUDIO_WRITE_BUFFER_1 ? 0 : 1;
            this.done[which] = this.cpu.clock.now() + (value >>> 0) / AUDIO_BYTES_PER_MS;
            break;
        }
    }
};

/**
 * (the machine's timers) the buffers whose samples have been played; milliseconds until the next
 * @param {number} now
 * @return {number}
 */
GoldfishAudio.prototype.timer = function(now)
{
    let next = Infinity;
    for(let i = 0; i < 2; i++)
    {
        if(this.done[i] < 0) continue;
        if(now >= this.done[i])
        {
            this.done[i] = -1;
            this.int_status |= i === 0 ? AUDIO_INT_WRITE_BUFFER_1_EMPTY : AUDIO_INT_WRITE_BUFFER_2_EMPTY;
            this.update_irq();
        }
        else next = Math.min(next, this.done[i] - now);
    }
    return next;
};

GoldfishAudio.prototype.get_state = function() { return [this.int_status, this.int_enable, this.done.slice()]; };
GoldfishAudio.prototype.set_state = function(state)
{
    [this.int_status, this.int_enable, this.done] = state;
    // (the clock's restored time: the buffers' times stay as they were)
    this.update_irq();
};

// ---- the pipe

const PIPE_REG_COMMAND = 0x00;
const PIPE_REG_STATUS = 0x04;
const PIPE_REG_CHANNEL = 0x08;
const PIPE_REG_SIZE = 0x0C;
const PIPE_REG_ADDRESS = 0x10;
const PIPE_REG_WAKES = 0x14;
const PIPE_REG_PARAMS_ADDR_LOW = 0x18;
const PIPE_REG_PARAMS_ADDR_HIGH = 0x1C;
const PIPE_REG_CHANNEL_HIGH = 0x30;
const PIPE_REG_ADDRESS_HIGH = 0x34;
const PIPE_REG_VERSION = 0x24;
const CMD_OPEN = 1;
const CMD_CLOSE = 2;
const CMD_POLL = 3;
const CMD_WRITE_BUFFER = 4;
const CMD_WAKE_ON_WRITE = 5;
const CMD_READ_BUFFER = 6;
const CMD_WAKE_ON_READ = 7;
const PIPE_POLL_IN = 1;
const PIPE_POLL_OUT = 2;
const PIPE_POLL_HUP = 4;
const PIPE_ERROR_INVAL = -1;
const PIPE_ERROR_AGAIN = -2;
const PIPE_ERROR_IO = -4;
const PIPE_WAKE_CLOSED = 1;
const PIPE_WAKE_READ = 2;
const PIPE_WAKE_WRITE = 4;

/**
 * A pipe's service: write(bytes) what the guest wrote, read(max) at most
 * max bytes for the guest (null: none now), available() whether there are
 * any, close() the guest closed the channel; get_state() what a snapshot
 * keeps of it (without one, its channel is closed at the restore)
 * @typedef {{write: function(!Uint8Array), read: function(number): ?Uint8Array, available: function(): boolean, close: function(),
 *     get_state: (function(): *|undefined)}}
 */
export let PipeService;

/**
 * A qemud service over a pipe: framed messages (four hex digits of length, then the bytes)
 * @param {function(string): (!Array<string>|undefined)} answer the frames to send back for one received
 * @param {*=} saved its state in a snapshot
 * @return {!PipeService}
 */
function qemud_service(answer, saved)
{
    let input = saved ? saved[0] : new Uint8Array(0);
    let output = saved ? saved[1] : new Uint8Array(0);
    return {
        get_state: () => [input.slice(), output.slice()],
        write(bytes)
        {
            const joined = new Uint8Array(input.length + bytes.length);
            joined.set(input);
            joined.set(bytes, input.length);
            input = joined;
            const frames = [];
            while(input.length >= 4)
            {
                const length = parseInt(new TextDecoder().decode(input.subarray(0, 4)), 16);
                if(!(length >= 0) || input.length < 4 + length) break;
                const message = new TextDecoder().decode(input.subarray(4, 4 + length));
                input = input.slice(4 + length);
                for(const frame of answer(message) || [])
                {
                    const body = new TextEncoder().encode(frame);
                    frames.push(...new TextEncoder().encode(body.length.toString(16).padStart(4, "0")), ...body);
                }
            }
            if(frames.length)
            {
                const joined_output = new Uint8Array(output.length + frames.length);
                joined_output.set(output);
                joined_output.set(frames, output.length);
                output = joined_output;
            }
        },
        read(max)
        {
            if(!output.length) return null;
            const bytes = output.subarray(0, max);
            output = output.subarray(bytes.length);
            return bytes;
        },
        available() { return output.length > 0; },
        close() {},
    };
}

/**
 * @constructor
 * @param {?} cpu
 * @param {number} base
 * @param {number} intid
 * @param {!Object<string, string>} properties the boot properties (qemu-props sets them)
 * @param {(function(string, function(), *=): ?PipeService)=} services the machine's
 *     other services: a name, the call that wakes the channel's reader
 *     (bytes became readable later) and at a restore the service's state,
 *     to the service, or null
 */
export function GoldfishPipe(cpu, base, intid, properties, services)
{
    this.name = "goldfish-pipe";
    this.cpu = cpu;
    this.intid = intid;
    this.properties = properties;
    this.services = services || (() => null);
    /** register accesses and the bytes moved, by command (diagnostics: the cost of pipe v1's traps) */
    this.stats = { mmio: 0, writes: 0, reads: 0, bytes_written: 0, bytes_read: 0 };
    this.reset();
    cpu.io.register_mmio(base, 0x2000, {
        read: offset => { this.stats.mmio++; return this.read(offset); },
        write: (offset, width, value) => { this.stats.mmio++; this.write(offset, Number(value)); },
        name: this.name,
    });
}

GoldfishPipe.prototype.reset = function()
{
    this.channel = 0;
    this.wake_channel = 0;
    this.size = 0;
    this.address = 0;
    this.status = 0;
    // (the guest's channels go: their services are closed)
    for(const pipe of this.pipes ? this.pipes.values() : []) if(pipe.service) pipe.service.close();
    /** @type {!Map<number, {name: string, pending: !Array<number>, service: ?PipeService, wake_read: boolean, wakes: number, closed: boolean}>} */
    this.pipes = new Map();
    this.update_irq();
};

GoldfishPipe.prototype.update_irq = function()
{
    let any = false;
    for(const pipe of this.pipes.values()) if(pipe.wakes) any = true;
    this.cpu.set_irq(this.intid, any);
};

/**
 * The service a pipe's name connects it to, or null
 * @param {string} name
 * @param {function()} wake
 * @param {*=} saved the service's state in a snapshot
 * @return {?PipeService}
 */
GoldfishPipe.prototype.connect = function(name, wake, saved)
{
    if(name === "qemud:boot-properties")
    {
        return qemud_service(message => message === "list" ?
            [...Object.entries(this.properties).map(([key, value]) => key + "=" + value), "\0"] : [], saved);
    }
    // (sensors.ranchu: no sensors; lights, vibrator and power: ignored)
    if(name === "qemud:sensors") return qemud_service(message => message === "list-sensors" ? ["0"] : [], saved);
    if(name === "qemud:hw-control") return qemud_service(() => [], saved);
    return this.services(name, wake, saved);
};

GoldfishPipe.prototype.read = function(offset)
{
    switch(offset)
    {
        case PIPE_REG_STATUS: return this.status >>> 0;
        case PIPE_REG_CHANNEL:
        {
            // (the next channel with wakes, which REG_WAKES then gives; 0: none)
            for(const [channel, pipe] of this.pipes)
            {
                if(pipe.wakes)
                {
                    this.wake_channel = channel;
                    return channel;
                }
            }
            this.update_irq();
            return 0;
        }
        case PIPE_REG_CHANNEL_HIGH: return 0;
        case PIPE_REG_WAKES:
        {
            const pipe = this.pipes.get(this.wake_channel);
            if(!pipe) return 0;
            const wakes = pipe.wakes;
            pipe.wakes = 0;
            if(pipe.closed) this.pipes.delete(this.wake_channel);
            this.update_irq();
            return wakes;
        }
        // (no batch buffer: the driver reads back what it wrote and finds it 0)
        case PIPE_REG_PARAMS_ADDR_LOW:
        case PIPE_REG_PARAMS_ADDR_HIGH: return 0;
        case PIPE_REG_VERSION: return 1;
    }
    return 0;
};

GoldfishPipe.prototype.write = function(offset, value)
{
    switch(offset)
    {
        case PIPE_REG_CHANNEL: this.channel = value >>> 0; break;
        case PIPE_REG_CHANNEL_HIGH: break;
        case PIPE_REG_SIZE: this.size = value >>> 0; break;
        case PIPE_REG_ADDRESS: this.address = value >>> 0; break;
        case PIPE_REG_ADDRESS_HIGH: break;
        case PIPE_REG_COMMAND: this.status = this.command(value); break;
    }
};

/**
 * @param {number} command
 * @return {number} the status
 */
GoldfishPipe.prototype.command = function(command)
{
    const channel = this.channel;
    if(command === CMD_OPEN)
    {
        const old = this.pipes.get(channel);
        if(old && old.service) old.service.close();
        this.pipes.set(channel, { name: "", pending: [], service: null, wake_read: false, wakes: 0, closed: false });
        return 0;
    }
    const pipe = this.pipes.get(channel);
    if(!pipe) return PIPE_ERROR_INVAL;
    switch(command)
    {
        case CMD_CLOSE:
            if(pipe.service) pipe.service.close();
            this.pipes.delete(channel);
            this.update_irq();
            return 0;
        case CMD_POLL:
            return (pipe.service && pipe.service.available() ? PIPE_POLL_IN : 0) | PIPE_POLL_OUT | (pipe.closed ? PIPE_POLL_HUP : 0);
        case CMD_WRITE_BUFFER:
        {
            if(pipe.closed) return PIPE_ERROR_IO;
            let bytes;
            try { bytes = this.cpu.read_blob_physical(this.address, this.size); }
            catch(e) { return PIPE_ERROR_INVAL; }
            if(!pipe.service)
            {
                // (the name: up to its NUL, "pipe:" first)
                const end = bytes.indexOf(0);
                pipe.pending.push(...(end < 0 ? bytes : bytes.subarray(0, end)));
                if(end < 0) return bytes.length;
                const name = new TextDecoder().decode(new Uint8Array(pipe.pending)).replace(/^pipe:/, "");
                pipe.name = name;
                pipe.service = this.connect(name, () => this.wake_reader(pipe));
                if(!pipe.service) return PIPE_ERROR_INVAL;
                if(end + 1 < bytes.length) pipe.service.write(bytes.subarray(end + 1));
                this.wake_reader(pipe);
                return bytes.length;
            }
            pipe.service.write(bytes);
            this.stats.writes++;
            this.stats.bytes_written += bytes.length;
            this.wake_reader(pipe);
            return bytes.length;
        }
        case CMD_READ_BUFFER:
        {
            const bytes = pipe.service && pipe.service.read(this.size);
            if(!bytes || !bytes.length) return pipe.closed ? 0 : PIPE_ERROR_AGAIN;
            this.cpu.write_blob_physical(bytes, this.address);
            this.stats.reads++;
            this.stats.bytes_read += bytes.length;
            return bytes.length;
        }
        case CMD_WAKE_ON_READ:
            pipe.wake_read = true;
            this.wake_reader(pipe);
            return 0;
        case CMD_WAKE_ON_WRITE:
            // (writes never wait)
            pipe.wakes |= PIPE_WAKE_WRITE;
            this.update_irq();
            return 0;
    }
    return PIPE_ERROR_INVAL;
};

/** A waiting reader woken when the service has bytes for it */
GoldfishPipe.prototype.wake_reader = function(pipe)
{
    if(pipe.wake_read && pipe.service && pipe.service.available())
    {
        pipe.wake_read = false;
        pipe.wakes |= PIPE_WAKE_READ;
        this.update_irq();
    }
};

// A snapshot keeps each channel with its service's state (docs/gles-proxy-plan.md
// E5); a channel whose service keeps none is closed at the restore (its client
// sees its pipe closed), as every channel was before (a list of channels)
const PIPE_STATE_VERSION = 2;

GoldfishPipe.prototype.get_state = function()
{
    return [PIPE_STATE_VERSION, [...this.pipes].map(([channel, p]) => [channel, p.name, new Uint8Array(p.pending), p.wake_read, p.wakes, p.closed,
        p.service && p.service.get_state ? p.service.get_state() : null])];
};

GoldfishPipe.prototype.set_state = function(state)
{
    this.reset();
    const saved = state && state[0] === PIPE_STATE_VERSION && Array.isArray(state[1]) ? state[1] :
        (state || []).map(channel => [channel, "", null, false, PIPE_WAKE_CLOSED, true, null]);
    for(const [channel, name, pending, wake_read, wakes, closed, service_state] of saved)
    {
        // (a channel whose name is not whole yet goes on with its bytes)
        const pipe = { name, pending: pending ? [...pending] : [], service: null, wake_read, wakes, closed };
        if(name && !closed)
        {
            pipe.service = service_state === null ? null : this.connect(name, () => this.wake_reader(pipe), service_state);
            if(!pipe.service)
            {
                pipe.closed = true;
                pipe.wakes |= PIPE_WAKE_CLOSED;
            }
        }
        this.pipes.set(channel, pipe);
    }
    this.update_irq();
};
