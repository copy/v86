// A USB disk: a disk image as a USB mass storage device, Bulk-Only Transport
// (USB Mass Storage Class BOT 1.0) with the SCSI transparent command set
// (SPC-3, SBC-3): one LUN of 512-byte sectors, removable (as USB sticks
// are), full or high speed (on EHCI), SuperSpeed (on an xHCI USB 3 port).
// The host sends a command block wrapper (CBW) on the bulk OUT
// endpoint, the data goes on bulk IN or OUT, and the device ends the command
// with a command status wrapper (CSW) on bulk IN. The image is the core's
// block backend (src/block_backend.js, through the plugin's handle): reads a
// reset cancels, a flush after the writes before it, I/O a snapshot waits
// for. An IN whose data was not read yet, or a CSW whose writes are not done,
// NAKs: the controller tries again in a later frame.

import { USBDevice } from "./usb_device.js";
import {
    DESCRIPTOR_BOS, DESCRIPTOR_DEVICE_CAPABILITY, DESCRIPTOR_SS_ENDPOINT_COMPANION, ENDPOINT_BULK, SPEED_FULL, SPEED_HIGH,
    SPEED_SUPER, USB_NAK, USB_STALL, configuration_descriptor, device_descriptor, endpoint_descriptor, interface_descriptor,
} from "./usb.js";

const CBW_SIGNATURE = 0x43425355, CSW_SIGNATURE = 0x53425355;
const CBW_LENGTH = 31, CSW_LENGTH = 13;
// BOT's class requests
const REQUEST_RESET = 0xFF, REQUEST_GET_MAX_LUN = 0xFE;
// where the device is: waiting for a CBW, in the data stage (to the host or
// from it), the CSW next; after an invalid CBW both bulk endpoints STALL
// until a reset recovery (BOT 6.6.1)
const PHASE_CBW = 0, PHASE_IN = 1, PHASE_OUT = 2, PHASE_CSW = 3, PHASE_STALLED = 4;
const STATUS_PASSED = 0, STATUS_FAILED = 1, STATUS_PHASE_ERROR = 2;
export const SECTOR_SIZE = 512;
// The image is read and written in pieces of at most this many bytes (a
// read ahead while the host takes the one before)
const CHUNK = 64 << 10;

// sense data: [sense key, additional sense code, its qualifier]
const NO_SENSE = [0, 0, 0], NOT_PRESENT = [2, 0x3A, 0], READ_ERROR = [3, 0x11, 0], WRITE_ERROR = [3, 0x0C, 0],
    INVALID_OPCODE = [5, 0x20, 0], OUT_OF_RANGE = [5, 0x21, 0], INVALID_FIELD = [5, 0x24, 0], NO_LUN = [5, 0x25, 0],
    NO_SAVING = [5, 0x39, 0], REMOVAL_PREVENTED = [5, 0x53, 0x02], MEDIUM_CHANGED = [6, 0x28, 0], WRITE_PROTECTED = [7, 0x27, 0];

// SCSI operation codes
const TEST_UNIT_READY = 0x00, REQUEST_SENSE = 0x03, READ_6 = 0x08, WRITE_6 = 0x0A, INQUIRY = 0x12, MODE_SELECT_6 = 0x15,
    MODE_SENSE_6 = 0x1A, START_STOP_UNIT = 0x1B, PREVENT_ALLOW = 0x1E, READ_FORMAT_CAPACITIES = 0x23, READ_CAPACITY_10 = 0x25,
    READ_10 = 0x28, WRITE_10 = 0x2A, VERIFY_10 = 0x2F, SYNCHRONIZE_CACHE_10 = 0x35, MODE_SELECT_10 = 0x55, MODE_SENSE_10 = 0x5A,
    READ_16 = 0x88, WRITE_16 = 0x8A, VERIFY_16 = 0x8F, SYNCHRONIZE_CACHE_16 = 0x91, SERVICE_ACTION_IN = 0x9E, REPORT_LUNS = 0xA0,
    READ_12 = 0xA8, WRITE_12 = 0xAA, VERIFY_12 = 0xAF;
const READ_CAPACITY_16 = 0x10;

// what the data stage carries
const DATA_IN = 1, DATA_OUT = 2;

// the commands that need the medium
const NEED_MEDIUM = new Set([READ_6, READ_10, READ_12, READ_16, WRITE_6, WRITE_10, WRITE_12, WRITE_16, VERIFY_10, VERIFY_12,
    VERIFY_16, READ_CAPACITY_10, SERVICE_ACTION_IN, SYNCHRONIZE_CACHE_10, SYNCHRONIZE_CACHE_16, MODE_SENSE_6, MODE_SENSE_10,
    TEST_UNIT_READY]);

/**
 * @param {!Uint8Array} bytes
 * @param {number} at
 * @return {number}
 */
function be32(bytes, at)
{
    return (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
}

/**
 * @param {!Uint8Array} bytes
 * @param {number} at
 * @param {number} value
 */
function put_be32(bytes, at, value)
{
    bytes[at] = value >>> 24;
    bytes[at + 1] = value >>> 16;
    bytes[at + 2] = value >>> 8;
    bytes[at + 3] = value;
}

/**
 * @param {!Uint8Array} bytes
 * @param {number} at
 * @param {string} text
 */
function put_ascii(bytes, at, text)
{
    for(let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
}

/**
 * A command's first sector and sector count (READ, WRITE, VERIFY and
 * SYNCHRONIZE CACHE: 6, 10, 12, 16 bytes)
 * @param {!Uint8Array} cb
 * @return {!Array<number>}
 */
function lba_and_count(cb)
{
    switch(cb[0])
    {
        case READ_6:
        case WRITE_6:
            // (0 sectors means 256)
            return [(cb[1] & 0x1F) << 16 | cb[2] << 8 | cb[3], cb[4] || 256];
        case READ_12:
        case WRITE_12:
        case VERIFY_12:
            return [be32(cb, 2), be32(cb, 6)];
        case READ_16:
        case WRITE_16:
        case VERIFY_16:
        case SYNCHRONIZE_CACHE_16:
            return [be32(cb, 2) * 0x100000000 + be32(cb, 6), be32(cb, 10)];
        default:
            return [be32(cb, 2), cb[7] << 8 | cb[8]];
    }
}

/**
 * The serial number from the disk's ID: hexadecimal (USB MSC requires 12
 * digits or more), the same for the same ID
 * @param {string} id
 * @return {string}
 */
export function serial_of(id)
{
    let hash = 0x811C9DC5, hash2 = 0x01000193;
    for(let i = 0; i < id.length; i++)
    {
        hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0;
        hash2 = Math.imul(hash2 ^ id.charCodeAt(i), 0x811C9DC5) >>> 0;
    }
    return (hash.toString(16).padStart(8, "0") + hash2.toString(16).padStart(8, "0")).toUpperCase();
}

/**
 * @constructor
 * @extends {USBDevice}
 * @param {!Object} backend the image: the handle's block backend ("read",
 *     "write", "flush", "reset", "byte_length")
 * @param {{id: string, read_only: boolean}} options
 */
export function MassStorage(backend, options)
{
    this.backend = backend;
    this.id = options.id;
    this.read_only = options.read_only;
    this.sectors = Math.floor(backend["byte_length"] / SECTOR_SIZE);
    this.serial = serial_of(options.id);
    /** @type {?function()} the guest ejected the medium (START STOP UNIT) */
    this.on_eject = null;
    /** a command's host I/O: what completes after a reset or another command does nothing */
    this.epoch = 0;
    // mass storage, SCSI transparent command set, Bulk-Only Transport; bulk
    // packets of 64 bytes at full speed, 512 at high speed
    const configuration = max_packet => configuration_descriptor({ value: 1, attributes: 0x80, max_power: 50, interfaces: 1 }, [
        interface_descriptor({ number: 0, alternate: 0, endpoints: 2, class: 8, subclass: 6, protocol: 0x50 }),
        endpoint_descriptor({ address: 0x81, type: ENDPOINT_BULK, max_packet, interval: 0 }),
        endpoint_descriptor({ address: 0x02, type: ENDPOINT_BULK, max_packet, interval: 0 }),
    ]);
    // at SuperSpeed: packets of 1024 bytes, each endpoint with its
    // SuperSpeed companion (no bursts, no streams: Bulk-Only, not UAS)
    const companion = [6, DESCRIPTOR_SS_ENDPOINT_COMPANION, 0, 0, 0, 0];
    const super_configuration = configuration_descriptor({ value: 1, attributes: 0x80, max_power: 12, interfaces: 1 }, [
        interface_descriptor({ number: 0, alternate: 0, endpoints: 2, class: 8, subclass: 6, protocol: 0x50 }),
        endpoint_descriptor({ address: 0x81, type: ENDPOINT_BULK, max_packet: 1024, interval: 0 }), companion,
        endpoint_descriptor({ address: 0x02, type: ENDPOINT_BULK, max_packet: 1024, interval: 0 }), companion,
    ]);
    // (QEMU's USB disk's IDs)
    const device = (usb, max_packet0) => device_descriptor({ usb, class: 0, subclass: 0, protocol: 0, max_packet0, vendor: 0x46F4,
        product: 0x0001, release: 0x0000, manufacturer: 1, product_string: 2, serial: 3, configurations: 1 });
    USBDevice.call(this, {
        name: options.id,
        speeds: [SPEED_FULL, SPEED_HIGH, SPEED_SUPER],
        device: device(0x0200, 64),
        configurations: [configuration(64)],
        high_configurations: [configuration(512)],
        // USB 3: endpoint 0's packets 2^9; the BOS: a USB 2.0 extension
        // without LPM, the SuperSpeed capability (full, high and SuperSpeed,
        // all of it from full speed on, no U1/U2 exit latencies: no U1/U2)
        super_device: device(0x0300, 9),
        super_configurations: [super_configuration],
        bos: [5, DESCRIPTOR_BOS, 22, 0, 2,
            7, DESCRIPTOR_DEVICE_CAPABILITY, 0x02, 0, 0, 0, 0,
            10, DESCRIPTOR_DEVICE_CAPABILITY, 0x03, 0, 0x0E, 0x00, 1, 0, 0, 0],
        strings: ["v86", "v86 USB Disk", this.serial],
        endpoints: [0x81, 0x02],
    });
}

MassStorage.prototype = Object.create(USBDevice.prototype);

/** A bus reset: also the disk's state (a medium the guest ejected is back) */
MassStorage.prototype.reset = function()
{
    USBDevice.prototype.reset.call(this);
    this.bot_reset();
    /** @type {!Array<number>} */
    this.sense = NO_SENSE;
    this.medium = true;
    /** PREVENT ALLOW MEDIUM REMOVAL */
    this.prevent = false;
    /** a medium loaded again: the next command fails with UNIT ATTENTION */
    this.unit_attention = false;
};

/**
 * BOT's reset (and the start of a bus reset): the command under way is
 * dropped. Reads are cancelled; writes issued are in the image or get there.
 */
MassStorage.prototype.bot_reset = function()
{
    this.epoch++;
    this.backend["reset"]();
    this.phase = PHASE_CBW;
    this.tag = 0;
    /** the CBW's: the bytes of the data stage, its direction */
    this.host_length = 0;
    this.host_in = false;
    /** bytes of the data stage done */
    this.done = 0;
    /** bytes of them that are the device's (the rest: padding to the host, or ignored) */
    this.device_length = 0;
    this.status = STATUS_PASSED;
    /** host I/O of the command not finished */
    this.io = 0;
    /** @type {!Array<!Uint8Array>} data to the host, read and not taken yet */
    this.queue = [];
    this.queued = 0;
    /** the image's bytes to read: where, how many not asked for yet, how many being read */
    this.read_at = 0;
    this.read_left = 0;
    this.reading = 0;
    /** writing: where the next piece goes; the piece being filled (null: the data is ignored) */
    this.write_at = 0;
    /** @type {Uint8Array} */
    this.chunk = null;
    this.fill = 0;
    this.received = 0;
    /** SYNCHRONIZE CACHE under way */
    this.flushing = false;
};

/**
 * GET_MAX_LUN and BOT's reset
 * @param {{type: number, request: number, value: number, index: number, length: number}} setup
 * @param {Uint8Array} data
 * @return {!Uint8Array|number}
 */
MassStorage.prototype.class_request = function(setup, data)
{
    if(setup.type === 0xA1 && setup.request === REQUEST_GET_MAX_LUN && setup.value === 0 && setup.length === 1)
    {
        return Uint8Array.of(0);
    }
    if(setup.type === 0x21 && setup.request === REQUEST_RESET && setup.value === 0 && setup.length === 0)
    {
        this.bot_reset();
        return new Uint8Array(0);
    }
    return USB_STALL;
};

/**
 * Bulk OUT: a CBW, or the data of a command
 * @param {number} endpoint
 * @param {!Uint8Array} data
 * @return {number}
 */
MassStorage.prototype.data_out = function(endpoint, data)
{
    if(this.phase === PHASE_CBW) return this.receive_cbw(data);
    if(this.phase !== PHASE_OUT) return USB_STALL;
    // (two pieces being written: the host waits)
    if(this.io >= 2) return USB_NAK;
    const length = Math.min(data.length, this.host_length - this.done);
    const device = Math.max(0, Math.min(length, this.device_length - this.done));
    if(device) this.accept(data.subarray(0, device));
    this.done += length;
    if(this.done === this.host_length) this.phase = PHASE_CSW;
    return 0;
};

/**
 * Bulk IN: the data of a command, or its CSW
 * @param {number} endpoint
 * @param {number} max_length
 * @return {!Uint8Array|number}
 */
MassStorage.prototype.data_in = function(endpoint, max_length)
{
    if(this.phase === PHASE_IN)
    {
        const length = Math.min(max_length, this.host_length - this.done);
        const device = Math.max(0, Math.min(length, this.device_length - this.done));
        if(device > this.queued) return USB_NAK;
        // (the device's bytes, then zeros up to the CBW's length: BOT's case Hi > Di)
        const packet = new Uint8Array(length);
        this.take(packet, device);
        this.done += length;
        if(this.done === this.host_length) this.phase = PHASE_CSW;
        return packet;
    }
    if(this.phase === PHASE_CSW)
    {
        if(this.io) return USB_NAK;
        const csw = new Uint8Array(CSW_LENGTH);
        put_le32(csw, 0, CSW_SIGNATURE);
        put_le32(csw, 4, this.tag);
        put_le32(csw, 8, this.host_length - this.device_length);
        csw[12] = this.status;
        this.phase = PHASE_CBW;
        return csw;
    }
    return this.phase === PHASE_STALLED ? USB_STALL : USB_NAK;
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} at
 * @param {number} value
 */
function put_le32(bytes, at, value)
{
    bytes[at] = value;
    bytes[at + 1] = value >>> 8;
    bytes[at + 2] = value >>> 16;
    bytes[at + 3] = value >>> 24;
}

/**
 * @param {!Uint8Array} bytes
 * @return {number}
 */
MassStorage.prototype.receive_cbw = function(bytes)
{
    const signature = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    if(bytes.length !== CBW_LENGTH || signature !== CBW_SIGNATURE || bytes[14] < 1 || bytes[14] > 16)
    {
        this.phase = PHASE_STALLED;
        this.halted.add(0x81);
        this.halted.add(0x02);
        return 0;
    }
    this.epoch++;
    this.io = 0;
    this.reading = 0;
    this.flushing = false;
    this.tag = (bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24) >>> 0;
    this.host_length = (bytes[8] | bytes[9] << 8 | bytes[10] << 16 | bytes[11] << 24) >>> 0;
    this.host_in = !!(bytes[12] & 0x80);
    this.done = 0;
    this.device_length = 0;
    this.status = STATUS_PASSED;
    this.queue = [];
    this.queued = 0;
    this.read_left = 0;
    this.chunk = null;
    this.fill = 0;
    this.received = 0;
    // (a LUN other than 0, which GET_MAX_LUN did not offer, fails the command)
    if(bytes[13] & 0xF) this.fail(NO_LUN);
    else this.execute(bytes.slice(15, 15 + bytes[14]));
    if(this.phase === PHASE_CBW) this.phase = this.host_length === 0 ? PHASE_CSW : this.host_in ? PHASE_IN : PHASE_OUT;
    return 0;
};

/**
 * The data stage the device means against the CBW's: the same direction,
 * as many bytes or fewer (BOT 6.7: otherwise a phase error, and the stage
 * carries nothing of the device's)
 * @param {number} direction DATA_IN, DATA_OUT (or 0: none)
 * @param {number} length
 * @return {boolean} whether the device's data goes
 */
MassStorage.prototype.begin = function(direction, length)
{
    if(length === 0) return false;
    if(this.host_length === 0 || this.host_in !== (direction === DATA_IN) || this.host_length < length)
    {
        this.status = STATUS_PHASE_ERROR;
        return false;
    }
    this.device_length = length;
    return true;
};

/**
 * The command failed: its sense, no data (the data stage is padded or ignored)
 * @param {!Array<number>} sense
 */
MassStorage.prototype.fail = function(sense)
{
    this.sense = sense;
    this.status = STATUS_FAILED;
};

/**
 * Data to the host (at most the command's allocation length)
 * @param {!Uint8Array} bytes
 * @param {number} allocation
 */
MassStorage.prototype.reply = function(bytes, allocation)
{
    bytes = bytes.subarray(0, Math.min(bytes.length, allocation));
    if(this.begin(DATA_IN, bytes.length))
    {
        this.queue.push(bytes);
        this.queued = bytes.length;
    }
};

/**
 * A SCSI command
 * @param {!Uint8Array} cb
 */
MassStorage.prototype.execute = function(cb)
{
    const op = cb[0];
    if(op !== REQUEST_SENSE) this.sense = NO_SENSE;
    if(this.unit_attention && op !== INQUIRY && op !== REQUEST_SENSE)
    {
        this.unit_attention = false;
        this.fail(MEDIUM_CHANGED);
        return;
    }
    if(!this.medium && NEED_MEDIUM.has(op))
    {
        this.fail(NOT_PRESENT);
        return;
    }
    switch(op)
    {
        case TEST_UNIT_READY:
            return;
        case REQUEST_SENSE:
        {
            // (fixed format; the sense is the last command's, and then gone)
            const sense = new Uint8Array(18);
            sense[0] = 0x70;
            sense[2] = this.sense[0];
            sense[7] = 10;
            sense[12] = this.sense[1];
            sense[13] = this.sense[2];
            this.sense = NO_SENSE;
            this.reply(sense, cb[4]);
            return;
        }
        case INQUIRY:
            this.inquiry(cb);
            return;
        case MODE_SENSE_6:
        case MODE_SENSE_10:
            this.mode_sense(cb);
            return;
        case MODE_SELECT_6:
        case MODE_SELECT_10:
            // (the parameters are taken and ignored: nothing is changeable)
            this.begin(DATA_OUT, op === MODE_SELECT_6 ? cb[4] : cb[7] << 8 | cb[8]);
            return;
        case START_STOP_UNIT:
            // LoEj: Start 0 ejects the medium, 1 loads it again
            if(cb[4] & 2)
            {
                if(!(cb[4] & 1))
                {
                    if(this.prevent) { this.fail(REMOVAL_PREVENTED); return; }
                    if(this.medium)
                    {
                        this.medium = false;
                        if(this.on_eject) this.on_eject();
                    }
                }
                else if(!this.medium)
                {
                    this.medium = true;
                    this.unit_attention = true;
                }
            }
            return;
        case PREVENT_ALLOW:
            this.prevent = (cb[4] & 3) !== 0;
            return;
        case READ_FORMAT_CAPACITIES:
        {
            const list = new Uint8Array(12);
            list[3] = 8;
            put_be32(list, 4, this.medium ? Math.min(this.sectors, 0xFFFFFFFF) : 0xFFFFFFFF);
            // (2: formatted media, 3: no media)
            list[8] = this.medium ? 2 : 3;
            list[10] = SECTOR_SIZE >> 8;
            list[11] = SECTOR_SIZE & 0xFF;
            this.reply(list, cb[7] << 8 | cb[8]);
            return;
        }
        case READ_CAPACITY_10:
        {
            const capacity = new Uint8Array(8);
            // (a disk too large for it says so: READ CAPACITY(16) then)
            put_be32(capacity, 0, Math.min(this.sectors - 1, 0xFFFFFFFF));
            put_be32(capacity, 4, SECTOR_SIZE);
            this.reply(capacity, 8);
            return;
        }
        case SERVICE_ACTION_IN:
        {
            if((cb[1] & 0x1F) !== READ_CAPACITY_16) { this.fail(INVALID_OPCODE); return; }
            const capacity = new Uint8Array(32);
            const last = this.sectors - 1;
            put_be32(capacity, 0, Math.floor(last / 0x100000000));
            put_be32(capacity, 4, last % 0x100000000);
            put_be32(capacity, 8, SECTOR_SIZE);
            this.reply(capacity, be32(cb, 10));
            return;
        }
        case READ_6:
        case READ_10:
        case READ_12:
        case READ_16:
        {
            const range = lba_and_count(cb), lba = range[0], count = range[1];
            if(lba + count > this.sectors) { this.fail(OUT_OF_RANGE); return; }
            if(this.begin(DATA_IN, count * SECTOR_SIZE))
            {
                this.read_at = lba * SECTOR_SIZE;
                this.read_left = count * SECTOR_SIZE;
                this.read_ahead();
            }
            return;
        }
        case WRITE_6:
        case WRITE_10:
        case WRITE_12:
        case WRITE_16:
        {
            const range = lba_and_count(cb), lba = range[0], count = range[1];
            if(this.read_only) { this.fail(WRITE_PROTECTED); return; }
            if(lba + count > this.sectors) { this.fail(OUT_OF_RANGE); return; }
            if(this.begin(DATA_OUT, count * SECTOR_SIZE))
            {
                this.write_at = lba * SECTOR_SIZE;
                this.chunk = new Uint8Array(Math.min(CHUNK, count * SECTOR_SIZE));
            }
            return;
        }
        case VERIFY_10:
        case VERIFY_12:
        case VERIFY_16:
        {
            const range = lba_and_count(cb), lba = range[0], count = range[1];
            if(lba + count > this.sectors) { this.fail(OUT_OF_RANGE); return; }
            // (BYTCHK: the host's data, taken and not compared)
            if(cb[1] & 2) this.begin(DATA_OUT, count * SECTOR_SIZE);
            return;
        }
        case SYNCHRONIZE_CACHE_10:
        case SYNCHRONIZE_CACHE_16:
            this.flush();
            return;
        case REPORT_LUNS:
        {
            const luns = new Uint8Array(16);
            luns[3] = 8;
            this.reply(luns, be32(cb, 6));
            return;
        }
    }
    this.fail(INVALID_OPCODE);
};

/** @param {!Uint8Array} cb */
MassStorage.prototype.inquiry = function(cb)
{
    const allocation = cb[3] << 8 | cb[4];
    if(cb[1] & 1)
    {
        // vital product data: the pages there are, the serial number
        if(cb[2] === 0x00)
        {
            this.reply(Uint8Array.of(0, 0x00, 0, 2, 0x00, 0x80), allocation);
        }
        else if(cb[2] === 0x80)
        {
            const page = new Uint8Array(4 + this.serial.length);
            page[1] = 0x80;
            page[3] = this.serial.length;
            put_ascii(page, 4, this.serial);
            this.reply(page, allocation);
        }
        else
        {
            this.fail(INVALID_FIELD);
        }
        return;
    }
    if(cb[2]) { this.fail(INVALID_FIELD); return; }
    const data = new Uint8Array(36);
    // a direct access block device, removable; SPC-3; response data format 2
    data[1] = 0x80;
    data[2] = 0x05;
    data[3] = 0x02;
    data[4] = data.length - 5;
    put_ascii(data, 8, "v86     ");
    put_ascii(data, 16, "USB Disk        ");
    put_ascii(data, 32, "1.0 ");
    this.reply(data, allocation);
};

/** @param {!Uint8Array} cb */
MassStorage.prototype.mode_sense = function(cb)
{
    const ten = cb[0] === MODE_SENSE_10;
    const control = cb[2] >> 6, code = cb[2] & 0x3F;
    if(control === 3) { this.fail(NO_SAVING); return; }
    // the caching page (write cache enabled: SYNCHRONIZE CACHE flushes the
    // writes before it), informational exceptions control; nothing changeable
    const caching = [0x08, 0x12, control === 1 ? 0 : 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const exceptions = [0x1C, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const pages = code === 0x08 ? caching : code === 0x1C ? exceptions : code === 0x3F ? caching.concat(exceptions) : null;
    if(!pages) { this.fail(INVALID_FIELD); return; }
    // (no block descriptors; the write protect bit)
    const protect = this.read_only ? 0x80 : 0;
    const header = ten ? [0, 0, 0, protect, 0, 0, 0, 0] : [0, 0, protect, 0];
    const data = Uint8Array.from(header.concat(pages));
    if(ten)
    {
        data[0] = data.length - 2 >> 8;
        data[1] = data.length - 2 & 0xFF;
    }
    else
    {
        data[0] = data.length - 1;
    }
    this.reply(data, ten ? cb[7] << 8 | cb[8] : cb[4]);
};

/** Read the next piece of the image while there is room for it */
MassStorage.prototype.read_ahead = function()
{
    if(this.reading || !this.read_left || this.queued >= CHUNK) return;
    const at = this.read_at, length = Math.min(CHUNK, this.read_left);
    this.read_at += length;
    this.read_left -= length;
    this.reading = length;
    this.io++;
    const epoch = this.epoch;
    this.backend["read"](at, length, bytes =>
    {
        if(epoch !== this.epoch) return;
        this.reading = 0;
        this.io--;
        // (a view the backend may reuse)
        this.queue.push(bytes.slice(0, length));
        this.queued += length;
        this.read_ahead();
    }, () =>
    {
        if(epoch !== this.epoch) return;
        // the backend's error (a disk whose policy reports them): what was
        // read goes, then padding
        this.reading = 0;
        this.io--;
        this.read_left = 0;
        this.device_length = this.done + this.queued;
        this.fail(READ_ERROR);
    });
};

/**
 * Data to the host from what was read
 * @param {!Uint8Array} packet
 * @param {number} length
 */
MassStorage.prototype.take = function(packet, length)
{
    let at = 0;
    while(at < length)
    {
        const head = this.queue[0];
        const n = Math.min(length - at, head.length);
        packet.set(head.subarray(0, n), at);
        at += n;
        if(n === head.length) this.queue.shift();
        else this.queue[0] = head.subarray(n);
    }
    this.queued -= length;
    this.read_ahead();
};

/**
 * Data from the host, into the piece being filled; a full piece (or the
 * last) goes to the image
 * @param {!Uint8Array} bytes
 */
MassStorage.prototype.accept = function(bytes)
{
    this.received += bytes.length;
    if(!this.chunk) return;
    let at = 0;
    while(at < bytes.length)
    {
        const n = Math.min(bytes.length - at, this.chunk.length - this.fill);
        this.chunk.set(bytes.subarray(at, at + n), this.fill);
        this.fill += n;
        at += n;
        if(this.fill === this.chunk.length || this.received === this.device_length) this.write_chunk();
    }
};

MassStorage.prototype.write_chunk = function()
{
    const data = this.chunk.slice(0, this.fill), at = this.write_at;
    this.write_at += this.fill;
    this.fill = 0;
    this.io++;
    const epoch = this.epoch;
    this.backend["write"](at, data, () =>
    {
        if(epoch === this.epoch) this.io--;
    }, () =>
    {
        if(epoch !== this.epoch) return;
        // (the rest of the data is taken and not written)
        this.io--;
        this.chunk = null;
        this.fail(WRITE_ERROR);
    });
};

/** SYNCHRONIZE CACHE: the CSW once the writes before it are in the image */
MassStorage.prototype.flush = function()
{
    this.flushing = true;
    this.io++;
    const epoch = this.epoch;
    const done = () =>
    {
        if(epoch !== this.epoch) return;
        this.flushing = false;
        this.io--;
    };
    this.backend["flush"](done, () =>
    {
        if(epoch !== this.epoch) return;
        this.fail(WRITE_ERROR);
        done();
    });
};

/** Taken out of its port: what is under way is dropped */
MassStorage.prototype.unplugged = function()
{
    this.bot_reset();
};

MassStorage.prototype.get_state = function()
{
    // (a snapshot waits for host I/O; a read still under way is read again)
    const queued = new Uint8Array(this.queued);
    let at = 0;
    for(const part of this.queue) { queued.set(part, at); at += part.length; }
    return [USBDevice.prototype.get_state.call(this), this.phase, this.tag, this.host_length, +this.host_in, this.done,
        this.device_length, this.status, this.sense.slice(), queued, this.read_at - this.reading, this.read_left + this.reading,
        this.chunk ? this.chunk.length : 0, this.chunk ? this.chunk.slice(0, this.fill) : null, this.write_at, this.received,
        +this.flushing, +this.medium, +this.prevent, +this.unit_attention];
};

MassStorage.prototype.set_state = function(state)
{
    this.bot_reset();
    USBDevice.prototype.set_state.call(this, state[0]);
    this.phase = state[1];
    this.tag = state[2];
    this.host_length = state[3];
    this.host_in = !!state[4];
    this.done = state[5];
    this.device_length = state[6];
    this.status = state[7];
    this.sense = state[8].slice();
    this.queue = state[9].length ? [state[9]] : [];
    this.queued = state[9].length;
    this.read_at = state[10];
    this.read_left = state[11];
    if(state[12])
    {
        this.chunk = new Uint8Array(state[12]);
        this.chunk.set(state[13]);
        this.fill = state[13].length;
    }
    this.write_at = state[14];
    this.received = state[15];
    this.medium = !!state[17];
    this.prevent = !!state[18];
    this.unit_attention = !!state[19];
    if(state[16]) this.flush();
    this.read_ahead();
};
