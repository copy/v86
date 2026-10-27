// A USB device as the controllers see it (usb.js): an address, a
// configuration, endpoint 0's control transfers (setup, data and status
// stages, a new SETUP ending one that was under way) with the standard
// requests, and the other endpoints' transactions, which the device's kind
// (hid_tablet.js, mass_storage.js) answers. Halted endpoints STALL until
// CLEAR_FEATURE(ENDPOINT_HALT). Speeds are the device's: it runs at one of
// them, the port's (EHCI's high speed, a UHCI companion's full speed, an
// xHCI USB 3 port's SuperSpeed), and answers with that speed's
// configurations; a device of full and high speed describes the other in
// its device qualifier and other speed configuration; at SuperSpeed its
// device descriptor is USB 3's and it has a BOS.

import {
    DESCRIPTOR_CONFIGURATION, DESCRIPTOR_DEVICE, DESCRIPTOR_DEVICE_QUALIFIER, DESCRIPTOR_OTHER_SPEED, DESCRIPTOR_STRING,
    FEATURE_DEVICE_REMOTE_WAKEUP,
    FEATURE_ENDPOINT_HALT, LANGUAGES, PID_IN, PID_OUT, PID_SETUP, RECIPIENT_DEVICE, RECIPIENT_ENDPOINT,
    RECIPIENT_INTERFACE, REQUEST_CLEAR_FEATURE, SetupPacket, REQUEST_GET_CONFIGURATION, REQUEST_GET_DESCRIPTOR,
    REQUEST_GET_INTERFACE, REQUEST_GET_STATUS, REQUEST_SET_ADDRESS, REQUEST_SET_CONFIGURATION,
    REQUEST_SET_FEATURE, REQUEST_SET_INTERFACE, REQUEST_SET_ISOCH_DELAY, REQUEST_SET_SEL, SPEED_FULL, SPEED_HIGH, SPEED_SUPER,
    TYPE_STANDARD, USB_NAK, USB_STALL, parse_setup, DESCRIPTOR_BOS,
    string_descriptor,
} from "./usb.js";

// endpoint 0's stages
const STAGE_IDLE = 0, STAGE_DATA_IN = 1, STAGE_DATA_OUT = 2, STAGE_STATUS_IN = 3, STAGE_STALLED = 4;

/**
 * @constructor
 * @param {{name: string, speeds: (!Array<number>|undefined), device: !Array<number>, configurations: !Array<!Array<number>>,
 *     high_configurations: (!Array<!Array<number>>|undefined), super_device: (!Array<number>|undefined),
 *     super_configurations: (!Array<!Array<number>>|undefined), bos: (!Array<number>|undefined), strings: !Array<string>,
 *     endpoints: !Array<number>}} d
 *     the device's descriptors: the device descriptor, each configuration's (with its interfaces and
 *     endpoints) at full speed and, for a high-speed device, at high speed; for a SuperSpeed one its
 *     USB 3 device descriptor, configurations and BOS; the strings (index 1 on), the addresses of its
 *     endpoints other than 0
 */
export function USBDevice(d)
{
    this.name = d.name;
    /** The speeds the device runs at (full speed, and high), and the one it runs at */
    this.speeds = d.speeds || [SPEED_FULL];
    this.speed = this.speeds[0];
    this.descriptors = d;
    this.max_packet0 = d.device[7];
    this.set_speed(this.speed);
    this.endpoint_addresses = d.endpoints;
    this.reset();
}

/** A bus reset (the port's): the default state, address 0, not configured */
USBDevice.prototype.reset = function()
{
    this.address = 0;
    this.configuration = 0;
    this.alternates = [0];
    this.remote_wakeup = false;
    /** @type {!Set<number>} halted endpoint addresses */
    this.halted = new Set();
    this.stage = STAGE_IDLE;
    /** @type {?SetupPacket} */
    this.setup = null;
    this.control_data = new Uint8Array(0);
    this.control_offset = 0;
    this.out_data = [];
    this.out_length = 0;
    this.pending_address = -1;
};

/**
 * A transaction for this device (its address matched)
 * @param {number} pid PID_SETUP, PID_IN, PID_OUT
 * @param {number} endpoint 0 to 15
 * @param {Uint8Array} data SETUP's and OUT's bytes
 * @param {number} max_length IN: at most this many bytes
 * @return {!Uint8Array|number} IN: the bytes; SETUP, OUT: 0 (ACK); or USB_NAK, USB_STALL
 */
USBDevice.prototype.transaction = function(pid, endpoint, data, max_length)
{
    if(endpoint === 0) return this.control(pid, data, max_length);
    const address = endpoint | (pid === PID_IN ? 0x80 : 0);
    if(!this.configuration || !this.endpoint_addresses.includes(address) || pid === PID_SETUP) return USB_STALL;
    if(this.halted.has(address)) return USB_STALL;
    return pid === PID_IN ? this.data_in(endpoint, max_length) : this.data_out(endpoint, /** @type {!Uint8Array} */ (data));
};

/**
 * Endpoint 0
 * @param {number} pid
 * @param {Uint8Array} data
 * @param {number} max_length
 * @return {!Uint8Array|number}
 */
USBDevice.prototype.control = function(pid, data, max_length)
{
    if(pid === PID_SETUP)
    {
        // (a new SETUP ends any transfer under way)
        if(!data || data.length !== 8) return USB_STALL;
        const setup = this.setup = parse_setup(data);
        this.pending_address = -1;
        if(setup.type & 0x80)
        {
            const result = this.request(setup, null);
            if(result === USB_STALL)
            {
                this.stage = STAGE_STALLED;
            }
            else
            {
                this.control_data = /** @type {!Uint8Array} */ (result).subarray(0, setup.length);
                this.control_offset = 0;
                this.stage = STAGE_DATA_IN;
            }
        }
        else if(setup.length)
        {
            this.out_data = [];
            this.out_length = 0;
            this.stage = STAGE_DATA_OUT;
        }
        else
        {
            // (the request runs at its status stage: SET_ADDRESS takes effect after it)
            this.stage = STAGE_STATUS_IN;
        }
        return 0;
    }
    if(this.stage === STAGE_STALLED) return USB_STALL;
    if(pid === PID_IN)
    {
        if(this.stage === STAGE_DATA_IN)
        {
            const length = Math.min(max_length, this.max_packet0, this.control_data.length - this.control_offset);
            const chunk = this.control_data.slice(this.control_offset, this.control_offset + length);
            this.control_offset += length;
            return chunk;
        }
        if(this.stage === STAGE_STATUS_IN)
        {
            const result = this.request(/** @type {SetupPacket} */ (this.setup), concat(this.out_data, this.out_length));
            if(result === USB_STALL)
            {
                this.stage = STAGE_STALLED;
                return USB_STALL;
            }
            this.stage = STAGE_IDLE;
            if(this.pending_address >= 0)
            {
                this.address = this.pending_address;
                this.pending_address = -1;
            }
            return new Uint8Array(0);
        }
        return USB_STALL;
    }
    if(pid === PID_OUT)
    {
        if(this.stage === STAGE_DATA_OUT)
        {
            const bytes = /** @type {!Uint8Array} */ (data);
            this.out_data.push(bytes.slice());
            this.out_length += bytes.length;
            if(this.out_length >= this.setup.length) this.stage = STAGE_STATUS_IN;
            return 0;
        }
        if(this.stage === STAGE_DATA_IN)
        {
            // the status stage of a transfer to the host (also before all its data was read)
            this.stage = STAGE_IDLE;
            return 0;
        }
        return USB_STALL;
    }
    return USB_STALL;
};

/**
 * @param {!Array<!Uint8Array>} parts
 * @param {number} length
 * @return {!Uint8Array}
 */
function concat(parts, length)
{
    const bytes = new Uint8Array(length);
    let at = 0;
    for(const part of parts) { bytes.set(part, at); at += part.length; }
    return bytes;
}

/**
 * A control request: its data to the host, an empty array, or USB_STALL
 * @param {SetupPacket} setup
 * @param {Uint8Array} data the data stage's bytes, to the device
 * @return {!Uint8Array|number}
 */
USBDevice.prototype.request = function(setup, data)
{
    if((setup.type & 0x60) !== TYPE_STANDARD) return this.class_request(setup, data);
    const recipient = setup.type & 0x1F;
    switch(setup.request)
    {
        case REQUEST_GET_STATUS:
            if(recipient === RECIPIENT_DEVICE) return Uint8Array.of(this.self_powered() | (this.remote_wakeup ? 2 : 0), 0);
            if(recipient === RECIPIENT_ENDPOINT) return Uint8Array.of(this.halted.has(setup.index & 0x8F) ? 1 : 0, 0);
            return new Uint8Array(2);
        case REQUEST_CLEAR_FEATURE:
        case REQUEST_SET_FEATURE:
        {
            const set = setup.request === REQUEST_SET_FEATURE;
            if(recipient === RECIPIENT_DEVICE && setup.value === FEATURE_DEVICE_REMOTE_WAKEUP)
            {
                this.remote_wakeup = set;
                return new Uint8Array(0);
            }
            if(recipient === RECIPIENT_ENDPOINT && setup.value === FEATURE_ENDPOINT_HALT)
            {
                const endpoint = setup.index & 0x8F;
                if(endpoint & 0xF && !this.endpoint_addresses.includes(endpoint)) return USB_STALL;
                if(set && endpoint & 0xF) this.halted.add(endpoint);
                else
                {
                    this.halted.delete(endpoint);
                    this.halt_cleared(endpoint);
                }
                return new Uint8Array(0);
            }
            return USB_STALL;
        }
        case REQUEST_SET_ADDRESS:
            if(setup.value > 127) return USB_STALL;
            this.pending_address = setup.value;
            return new Uint8Array(0);
        case REQUEST_GET_DESCRIPTOR:
        {
            const bytes = recipient === RECIPIENT_INTERFACE ? this.interface_descriptor(setup.value >> 8, setup.value & 0xFF, setup.index) :
                this.descriptor(setup.value >> 8, setup.value & 0xFF, setup.index);
            return bytes ? Uint8Array.from(bytes) : USB_STALL;
        }
        case REQUEST_GET_CONFIGURATION:
            return Uint8Array.of(this.configuration);
        case REQUEST_SET_CONFIGURATION:
        {
            const value = setup.value & 0xFF;
            if(value && !this.configurations(this.speed).some(c => c[5] === value)) return USB_STALL;
            this.configuration = value;
            this.alternates = [0];
            this.halted.clear();
            this.configured(value);
            return new Uint8Array(0);
        }
        case REQUEST_GET_INTERFACE:
            if(!this.configuration) return USB_STALL;
            return Uint8Array.of(this.alternates[setup.index] || 0);
        case REQUEST_SET_INTERFACE:
            if(!this.configuration || setup.value !== 0) return USB_STALL;
            this.alternates[setup.index] = 0;
            return new Uint8Array(0);
        case REQUEST_SET_SEL:
        case REQUEST_SET_ISOCH_DELAY:
            // (USB 3's system exit latencies and isochronous delay: taken; the
            // device has no U1/U2 link states and no isochronous endpoints)
            return this.speed === SPEED_SUPER ? new Uint8Array(0) : USB_STALL;
    }
    return USB_STALL;
};

/**
 * A standard descriptor
 * @param {number} type
 * @param {number} index
 * @param {number} language
 * @return {Array<number>}
 */
USBDevice.prototype.descriptor = function(type, index, language)
{
    switch(type)
    {
        case DESCRIPTOR_DEVICE:
            return this.speed === SPEED_SUPER && this.descriptors.super_device || this.descriptors.device;
        case DESCRIPTOR_BOS:
            return this.descriptors.bos || null;
        case DESCRIPTOR_CONFIGURATION:
            return this.configurations(this.speed)[index] || null;
        case DESCRIPTOR_STRING:
            if(index === 0) return LANGUAGES;
            return index <= this.descriptors.strings.length ? string_descriptor(this.descriptors.strings[index - 1]) : null;
        case DESCRIPTOR_DEVICE_QUALIFIER:
        {
            // the device at the other speed (a full-speed only device STALLs
            // it, and so does one at SuperSpeed)
            if(!this.speeds.includes(SPEED_HIGH) || this.speed === SPEED_SUPER) return null;
            const d = this.descriptors.device;
            return [10, DESCRIPTOR_DEVICE_QUALIFIER, d[2], d[3], d[4], d[5], d[6], d[7], d[17], 0];
        }
        case DESCRIPTOR_OTHER_SPEED:
        {
            if(!this.speeds.includes(SPEED_HIGH) || this.speed === SPEED_SUPER) return null;
            const other = this.configurations(this.speed === SPEED_HIGH ? SPEED_FULL : SPEED_HIGH)[index];
            return other ? [other[0], DESCRIPTOR_OTHER_SPEED].concat(other.slice(2)) : null;
        }
    }
    return null;
};

/**
 * The configurations' descriptors at a speed
 * @param {number} speed
 * @return {!Array<!Array<number>>}
 */
USBDevice.prototype.configurations = function(speed)
{
    if(speed === SPEED_SUPER && this.descriptors.super_configurations) return this.descriptors.super_configurations;
    return speed >= SPEED_HIGH && this.descriptors.high_configurations ? this.descriptors.high_configurations : this.descriptors.configurations;
};

/**
 * The port's speed (EHCI's high speed, or a companion's full speed): the
 * device runs at it from its next bus reset on
 * @param {number} speed
 */
USBDevice.prototype.set_speed = function(speed)
{
    if(!this.speeds.includes(speed)) return;
    this.speed = speed;
    // (endpoint 0's packets: 512 bytes at SuperSpeed, its device descriptor's 2^9)
    this.max_packet0 = speed === SPEED_SUPER ? 512 : this.descriptors.device[7];
};

/**
 * A class descriptor of an interface (HID's): none by default
 * @param {number} type
 * @param {number} index
 * @param {number} interface_number
 * @return {Array<number>}
 */
USBDevice.prototype.interface_descriptor = function(type, index, interface_number)
{
    return null;
};

/** @return {number} GET_STATUS's self-powered bit */
USBDevice.prototype.self_powered = function()
{
    return 0;
};

/**
 * A class or vendor request: STALL by default
 * @param {SetupPacket} setup
 * @param {Uint8Array} data
 * @return {!Uint8Array|number}
 */
USBDevice.prototype.class_request = function(setup, data)
{
    return USB_STALL;
};

/**
 * SET_CONFIGURATION
 * @param {number} value 0: back to the address state
 */
USBDevice.prototype.configured = function(value) {};

/** @param {number} endpoint CLEAR_FEATURE(ENDPOINT_HALT) of this endpoint */
USBDevice.prototype.halt_cleared = function(endpoint) {};

/**
 * An IN transaction of an endpoint other than 0: NAK by default
 * @param {number} endpoint
 * @param {number} max_length
 * @return {!Uint8Array|number}
 */
USBDevice.prototype.data_in = function(endpoint, max_length)
{
    return USB_NAK;
};

/**
 * An OUT transaction of an endpoint other than 0
 * @param {number} endpoint
 * @param {!Uint8Array} data
 * @return {number} 0, or USB_NAK, USB_STALL
 */
USBDevice.prototype.data_out = function(endpoint, data)
{
    return USB_STALL;
};

/** The device's part of a snapshot (its kind adds its own) */
USBDevice.prototype.get_state = function()
{
    return [this.address, this.configuration, this.alternates.slice(), +this.remote_wakeup, Array.from(this.halted),
        this.stage, this.setup ? [this.setup.type, this.setup.request, this.setup.value, this.setup.index, this.setup.length] : null,
        this.control_data, this.control_offset, concat(this.out_data, this.out_length), this.pending_address, this.speed];
};

USBDevice.prototype.set_state = function(state)
{
    [this.address, this.configuration] = state;
    this.alternates = state[2].slice();
    this.remote_wakeup = !!state[3];
    this.halted = new Set(state[4]);
    this.stage = state[5];
    this.setup = state[6] ? { type: state[6][0], request: state[6][1], value: state[6][2], index: state[6][3], length: state[6][4] } : null;
    this.control_data = state[7];
    this.control_offset = state[8];
    this.out_data = state[9].length ? [state[9]] : [];
    this.out_length = state[9].length;
    this.pending_address = state[10];
    if(state[11] !== undefined) this.set_speed(state[11]);
};
