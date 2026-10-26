// USB: what the controllers (uhci.js, later EHCI and xHCI) and the devices
// (usb_device.js and its kinds) share: the speeds, the packets and their
// outcomes, the standard requests and descriptors (USB 2.0, chapter 9). A
// controller hands a device packets (SETUP, IN, OUT) for an endpoint; the
// device answers with data, NAK or STALL. No electrical signalling: a
// transaction is the unit.

// Device speeds (a device's descriptors may differ by speed)
export const SPEED_LOW = 0, SPEED_FULL = 1, SPEED_HIGH = 2, SPEED_SUPER = 3;

// Token PIDs, as UHCI's TDs carry them
export const PID_SETUP = 0x2D, PID_IN = 0x69, PID_OUT = 0xE1;

// A transaction's outcome: data (an IN's) or none, or a handshake that is not ACK
export const USB_NAK = -2, USB_STALL = -3, USB_NODEV = -1, USB_BABBLE = -4;

// requests (bRequest) and request types
export const REQUEST_GET_STATUS = 0x00, REQUEST_CLEAR_FEATURE = 0x01, REQUEST_SET_FEATURE = 0x03,
    REQUEST_SET_ADDRESS = 0x05, REQUEST_GET_DESCRIPTOR = 0x06, REQUEST_SET_DESCRIPTOR = 0x07,
    REQUEST_GET_CONFIGURATION = 0x08, REQUEST_SET_CONFIGURATION = 0x09, REQUEST_GET_INTERFACE = 0x0A,
    REQUEST_SET_INTERFACE = 0x0B, REQUEST_SYNCH_FRAME = 0x0C, REQUEST_SET_SEL = 0x30, REQUEST_SET_ISOCH_DELAY = 0x31;
export const TYPE_STANDARD = 0x00, TYPE_CLASS = 0x20, TYPE_VENDOR = 0x40;
export const RECIPIENT_DEVICE = 0, RECIPIENT_INTERFACE = 1, RECIPIENT_ENDPOINT = 2;
export const FEATURE_ENDPOINT_HALT = 0, FEATURE_DEVICE_REMOTE_WAKEUP = 1;

// descriptor types
export const DESCRIPTOR_DEVICE = 1, DESCRIPTOR_CONFIGURATION = 2, DESCRIPTOR_STRING = 3, DESCRIPTOR_INTERFACE = 4,
    DESCRIPTOR_ENDPOINT = 5, DESCRIPTOR_DEVICE_QUALIFIER = 6, DESCRIPTOR_OTHER_SPEED = 7, DESCRIPTOR_BOS = 0x0F,
    DESCRIPTOR_DEVICE_CAPABILITY = 0x10, DESCRIPTOR_HID = 0x21, DESCRIPTOR_REPORT = 0x22, DESCRIPTOR_SS_ENDPOINT_COMPANION = 0x30;

// endpoint types (bmAttributes)
export const ENDPOINT_CONTROL = 0, ENDPOINT_ISOCHRONOUS = 1, ENDPOINT_BULK = 2, ENDPOINT_INTERRUPT = 3;

/**
 * A setup packet's fields
 * @typedef {{type: number, request: number, value: number, index: number, length: number}}
 */
export let SetupPacket;

/**
 * @param {!Uint8Array} bytes a setup packet's 8 bytes
 * @return {SetupPacket}
 */
export function parse_setup(bytes)
{
    return {
        type: bytes[0],
        request: bytes[1],
        value: bytes[2] | bytes[3] << 8,
        index: bytes[4] | bytes[5] << 8,
        length: bytes[6] | bytes[7] << 8,
    };
}

/**
 * A device descriptor
 * @param {{usb: number, class: number, subclass: number, protocol: number, max_packet0: number, vendor: number,
 *     product: number, release: number, manufacturer: number, product_string: number, serial: number, configurations: number}} d
 * @return {!Array<number>}
 */
export function device_descriptor(d)
{
    return [18, DESCRIPTOR_DEVICE, d.usb & 0xFF, d.usb >> 8, d.class, d.subclass, d.protocol, d.max_packet0,
        d.vendor & 0xFF, d.vendor >> 8, d.product & 0xFF, d.product >> 8, d.release & 0xFF, d.release >> 8,
        d.manufacturer, d.product_string, d.serial, d.configurations];
}

/**
 * A configuration descriptor with what follows it (interfaces, class
 * descriptors, endpoints), its total length filled in
 * @param {{value: number, attributes: number, max_power: number, interfaces: number}} c
 * @param {!Array<!Array<number>>} parts
 * @return {!Array<number>}
 */
export function configuration_descriptor(c, parts)
{
    const rest = [].concat(...parts);
    const total = 9 + rest.length;
    return [9, DESCRIPTOR_CONFIGURATION, total & 0xFF, total >> 8, c.interfaces, c.value, 0, c.attributes, c.max_power, ...rest];
}

/**
 * @param {{number: number, alternate: number, endpoints: number, class: number, subclass: number, protocol: number}} i
 * @return {!Array<number>}
 */
export function interface_descriptor(i)
{
    return [9, DESCRIPTOR_INTERFACE, i.number, i.alternate, i.endpoints, i.class, i.subclass, i.protocol, 0];
}

/**
 * @param {{address: number, type: number, max_packet: number, interval: number}} e
 * @return {!Array<number>}
 */
export function endpoint_descriptor(e)
{
    return [7, DESCRIPTOR_ENDPOINT, e.address, e.type, e.max_packet & 0xFF, e.max_packet >> 8, e.interval];
}

/**
 * A string descriptor (UTF-16LE); index 0 is the list of languages
 * @param {string} text
 * @return {!Array<number>}
 */
export function string_descriptor(text)
{
    const bytes = [2 + 2 * text.length, DESCRIPTOR_STRING];
    for(let i = 0; i < text.length; i++)
    {
        const code = text.charCodeAt(i);
        bytes.push(code & 0xFF, code >> 8);
    }
    return bytes;
}

/** The languages: US English */
export const LANGUAGES = [4, DESCRIPTOR_STRING, 0x09, 0x04];
