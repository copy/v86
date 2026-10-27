// A USB HID tablet: an absolute pointer (X and Y from 0 to 32767 over the
// guest's screen), three buttons and a wheel, a full-speed device with one
// interrupt IN endpoint (as QEMU's usb-tablet; HID 1.11). Not a boot
// device (it does not claim the boot mouse protocol it could not keep).
// Reports go out when something changed, or after the idle time SET_IDLE
// asks for; otherwise the endpoint NAKs.

import { USBDevice } from "./usb_device.js";
import {
    DESCRIPTOR_HID, DESCRIPTOR_REPORT, ENDPOINT_INTERRUPT, SPEED_FULL, USB_NAK, USB_STALL,
    configuration_descriptor, device_descriptor, endpoint_descriptor, interface_descriptor,
} from "./usb.js";

/** The report: buttons, X, Y (16 bits each), the wheel */
const REPORT_DESCRIPTOR = [
    0x05, 0x01, // Usage Page (Generic Desktop)
    0x09, 0x02, // Usage (Mouse)
    0xA1, 0x01, // Collection (Application)
    0x09, 0x01, //   Usage (Pointer)
    0xA1, 0x00, //   Collection (Physical)
    0x05, 0x09, //     Usage Page (Button)
    0x19, 0x01, //     Usage Minimum (1)
    0x29, 0x03, //     Usage Maximum (3)
    0x15, 0x00, //     Logical Minimum (0)
    0x25, 0x01, //     Logical Maximum (1)
    0x95, 0x03, //     Report Count (3)
    0x75, 0x01, //     Report Size (1)
    0x81, 0x02, //     Input (Data, Variable, Absolute)
    0x95, 0x01, //     Report Count (1)
    0x75, 0x05, //     Report Size (5)
    0x81, 0x01, //     Input (Constant)
    0x05, 0x01, //     Usage Page (Generic Desktop)
    0x09, 0x30, //     Usage (X)
    0x09, 0x31, //     Usage (Y)
    0x15, 0x00, //     Logical Minimum (0)
    0x26, 0xFF, 0x7F, // Logical Maximum (32767)
    0x35, 0x00, //     Physical Minimum (0)
    0x46, 0xFF, 0x7F, // Physical Maximum (32767)
    0x75, 0x10, //     Report Size (16)
    0x95, 0x02, //     Report Count (2)
    0x81, 0x02, //     Input (Data, Variable, Absolute)
    0x05, 0x01, //     Usage Page (Generic Desktop)
    0x09, 0x38, //     Usage (Wheel)
    0x15, 0x81, //     Logical Minimum (-127)
    0x25, 0x7F, //     Logical Maximum (127)
    0x35, 0x00, //     Physical Minimum (0)
    0x45, 0x00, //     Physical Maximum (0)
    0x75, 0x08, //     Report Size (8)
    0x95, 0x01, //     Report Count (1)
    0x81, 0x06, //     Input (Data, Variable, Relative)
    0xC0,       //   End Collection
    0xC0,       // End Collection
];
const REPORT_SIZE = 6;
export const TABLET_MAX = 0x7FFF;

const HID_DESCRIPTOR = [9, DESCRIPTOR_HID, 0x11, 0x01, 0x00, 0x01, DESCRIPTOR_REPORT, REPORT_DESCRIPTOR.length & 0xFF, REPORT_DESCRIPTOR.length >> 8];

// HID class requests
const HID_GET_REPORT = 0x01, HID_GET_IDLE = 0x02, HID_GET_PROTOCOL = 0x03, HID_SET_REPORT = 0x09, HID_SET_IDLE = 0x0A,
    HID_SET_PROTOCOL = 0x0B;

/**
 * @constructor
 * @extends {USBDevice}
 * @param {function():number} now the machine clock (milliseconds), for the idle rate
 */
export function HIDTablet(now)
{
    this.now = now;
    /** @type {?function(boolean)} whether the guest has the tablet configured, when that changes */
    this.on_use = null;
    this.in_use = false;
    USBDevice.call(this, {
        name: "tablet",
        speeds: [SPEED_FULL],
        device: device_descriptor({ usb: 0x0110, class: 0, subclass: 0, protocol: 0, max_packet0: 8,
            // (QEMU's tablet's IDs, which drivers know)
            vendor: 0x0627, product: 0x0001, release: 0x0000, manufacturer: 1, product_string: 2, serial: 3, configurations: 1 }),
        configurations: [configuration_descriptor({ value: 1, attributes: 0x80, max_power: 50, interfaces: 1 }, [
            interface_descriptor({ number: 0, alternate: 0, endpoints: 1, class: 3, subclass: 0, protocol: 0 }),
            HID_DESCRIPTOR,
            endpoint_descriptor({ address: 0x81, type: ENDPOINT_INTERRUPT, max_packet: 8, interval: 10 }),
        ])],
        strings: ["v86", "v86 USB Tablet", "1"],
        endpoints: [0x81],
    });
    this.x = TABLET_MAX >> 1;
    this.y = TABLET_MAX >> 1;
    this.buttons = 0;
    this.wheel = 0;
    /** something to report */
    this.changed = false;
    this.last_report = 0;
}

HIDTablet.prototype = Object.create(USBDevice.prototype);

HIDTablet.prototype.reset = function()
{
    USBDevice.prototype.reset.call(this);
    /** SET_IDLE: in 4 ms units, 0 only on change */
    this.idle = 0;
    this.protocol = 1;
    this.update_use();
};

/** Tell on_use whether the guest has the tablet configured */
HIDTablet.prototype.update_use = function()
{
    const in_use = this.configuration !== 0;
    if(in_use === this.in_use) return;
    this.in_use = in_use;
    if(this.on_use) this.on_use(in_use);
};

/**
 * The pointer moved: the position over the screen, each from 0 to 1
 * @param {number} x
 * @param {number} y
 */
HIDTablet.prototype.move = function(x, y)
{
    const tx = Math.max(0, Math.min(TABLET_MAX, Math.round(x * TABLET_MAX)));
    const ty = Math.max(0, Math.min(TABLET_MAX, Math.round(y * TABLET_MAX)));
    if(tx === this.x && ty === this.y) return;
    this.x = tx;
    this.y = ty;
    this.changed = true;
};

/**
 * @param {boolean} left
 * @param {boolean} middle
 * @param {boolean} right
 */
HIDTablet.prototype.press = function(left, middle, right)
{
    const buttons = (left ? 1 : 0) | (right ? 2 : 0) | (middle ? 4 : 0);
    if(buttons === this.buttons) return;
    this.buttons = buttons;
    this.changed = true;
};

/** @param {number} delta the wheel's steps, positive away from the user */
HIDTablet.prototype.scroll = function(delta)
{
    if(!delta) return;
    this.wheel += delta;
    this.changed = true;
};

/** @return {!Uint8Array} the current report (the wheel's steps taken from it) */
HIDTablet.prototype.report = function()
{
    const wheel = Math.max(-127, Math.min(127, this.wheel));
    this.wheel -= wheel;
    return Uint8Array.of(this.buttons, this.x & 0xFF, this.x >> 8, this.y & 0xFF, this.y >> 8, wheel & 0xFF);
};

HIDTablet.prototype.data_in = function(endpoint, max_length)
{
    const now = this.now();
    if(!this.changed && !(this.idle && now - this.last_report >= this.idle * 4)) return USB_NAK;
    const report = this.report();
    this.changed = this.wheel !== 0;
    this.last_report = now;
    return report.subarray(0, Math.min(max_length, REPORT_SIZE));
};

HIDTablet.prototype.interface_descriptor = function(type, index, interface_number)
{
    if(interface_number !== 0) return null;
    if(type === DESCRIPTOR_HID) return HID_DESCRIPTOR;
    if(type === DESCRIPTOR_REPORT) return REPORT_DESCRIPTOR;
    return null;
};

HIDTablet.prototype.class_request = function(setup, data)
{
    // (requests to the interface)
    if((setup.type & 0x1F) !== 1 || (setup.index & 0xFF) !== 0) return USB_STALL;
    switch(setup.request)
    {
        case HID_GET_REPORT:
            return (setup.value >> 8) === 1 ? this.report() : USB_STALL;
        case HID_SET_REPORT:
            // (no output or feature reports)
            return USB_STALL;
        case HID_GET_IDLE:
            return Uint8Array.of(this.idle);
        case HID_SET_IDLE:
            this.idle = setup.value >> 8;
            return new Uint8Array(0);
        case HID_GET_PROTOCOL:
            return Uint8Array.of(this.protocol);
        case HID_SET_PROTOCOL:
            this.protocol = setup.value & 1;
            return new Uint8Array(0);
    }
    return USB_STALL;
};

HIDTablet.prototype.configured = function(value)
{
    // (the guest's driver takes the pointer from a fresh report)
    this.changed = true;
    this.update_use();
};

HIDTablet.prototype.get_state = function()
{
    return [USBDevice.prototype.get_state.call(this), this.x, this.y, this.buttons, this.wheel, +this.changed, this.idle, this.protocol];
};

HIDTablet.prototype.set_state = function(state)
{
    USBDevice.prototype.set_state.call(this, state[0]);
    [, this.x, this.y, this.buttons, this.wheel] = state;
    this.changed = !!state[5];
    this.idle = state[6];
    this.protocol = state[7];
    this.last_report = this.now();
    this.in_use = !this.configuration;
    this.update_use();
};
