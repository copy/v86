// The TPM's Command Response Buffer interface (docs/tpm.md; TCG PC Client
// Platform TPM Profile (PTP) specification, the CRB registers): five
// localities of 4 KiB from 0xFED40000, each with its locality registers;
// the control area (request, status, cancel, start, the buffer's addresses
// and sizes) and the data buffer are the same in each. A command written
// into the data buffer runs when 1 is written to start, synchronously: the
// response is in the buffer and start reads 0 again at once. No interrupts
// (the ACPI tables give none: drivers poll). The TPM2 table's control area
// address is the base's + CTRL_REQ.

import { TPM_BUFFER_SIZE } from "./libtpms.js";

export const CRB_BASE = 0xFED40000;
export const CRB_LOCALITIES = 5;
export const CRB_SIZE = CRB_LOCALITIES * 0x1000;

const LOC_STATE = 0x00;
const LOC_CTRL = 0x08;
const LOC_STS = 0x0C;
const INTF_ID = 0x30;
const INTF_ID_HIGH = 0x34;
const CTRL_EXT = 0x38;
export const CTRL_REQ = 0x40;
const CTRL_STS = 0x44;
const CTRL_CANCEL = 0x48;
const CTRL_START = 0x4C;
const INT_ENABLE = 0x50;
const INT_STS = 0x54;
const CMD_SIZE = 0x58;
const CMD_LADDR = 0x5C;
const CMD_HADDR = 0x60;
const RSP_SIZE = 0x64;
const RSP_LADDR = 0x68;
const RSP_HADDR = 0x6C;
const DATA = 0x80;

// LOC_STATE
const STATE_ESTABLISHED = 1 << 0;
const STATE_ASSIGNED = 1 << 1;
const STATE_REG_VALID = 1 << 7;
// LOC_CTRL
const CTRL_REQUEST_ACCESS = 1 << 0;
const CTRL_RELINQUISH = 1 << 1;
const CTRL_SEIZE = 1 << 2;
const CTRL_RESET_ESTABLISHMENT = 1 << 3;
// LOC_STS
const STS_GRANTED = 1 << 0;
const STS_BEEN_SEIZED = 1 << 1;
// CTRL_REQ
const REQ_CMD_READY = 1 << 0;
const REQ_GO_IDLE = 1 << 1;
// CTRL_STS
const CTRL_STS_IDLE = 1 << 1;

/**
 * The interface identifier: CRB active (type 1, version 1), five localities,
 * 64-byte transfers, CRB only (the interface selector fixed); QEMU's vendor
 * and device ID (IBM's libtpms)
 */
const INTERFACE_ID = 1 | 1 << 4 | 1 << 8 | 3 << 11 | 1 << 14 | 1 << 17 | 1 << 19;
const INTERFACE_ID_HIGH = 0x1014 | 0x0001 << 16;

/**
 * @constructor
 * @param {function(!Uint8Array, number): !Uint8Array} process a command at a locality: its response
 */
export function TpmCrb(process)
{
    this.process = process;
    this.buffer = new Uint8Array(TPM_BUFFER_SIZE);
    this.reset();
}

/** Power-on values: no locality, idle */
TpmCrb.prototype.reset = function()
{
    /** The active locality, or -1 */
    this.locality = -1;
    this.established = true;
    this.seized = 0;
    this.idle = true;
    this.cancel = 0;
    this.interrupts = 0;
    this.buffer.fill(0);
};

/**
 * A 32-bit register's value (or the data buffer's bytes) at an offset of a
 * locality's window
 * @param {number} locality
 * @param {number} offset within the window, 4-byte aligned below DATA
 * @return {number}
 */
TpmCrb.prototype.read32 = function(locality, offset)
{
    if(offset >= DATA)
    {
        const at = offset - DATA;
        const b = this.buffer;
        return (b[at] | (b[at + 1] | 0) << 8 | (b[at + 2] | 0) << 16 | (b[at + 3] | 0) << 24) >>> 0;
    }
    switch(offset)
    {
        case LOC_STATE:
            return (this.established ? STATE_ESTABLISHED : 0) | (this.locality >= 0 ? STATE_ASSIGNED | this.locality << 2 : 0) | STATE_REG_VALID;
        case LOC_STS:
            return (this.locality === locality ? STS_GRANTED : 0) | (this.seized & 1 << locality ? STS_BEEN_SEIZED : 0);
        case INTF_ID:
            return INTERFACE_ID >>> 0;
        case INTF_ID_HIGH:
            return INTERFACE_ID_HIGH >>> 0;
        case CTRL_STS:
            return this.idle ? CTRL_STS_IDLE : 0;
        case CTRL_CANCEL:
            return this.cancel;
        case INT_ENABLE:
            return this.interrupts;
        case CMD_SIZE:
        case RSP_SIZE:
            return TPM_BUFFER_SIZE;
        case CMD_LADDR:
        case RSP_LADDR:
            return CRB_BASE + DATA;
        default:
            // (CTRL_EXT, CTRL_REQ and START, which the TPM has done with at
            // once, INT_STS, the high addresses, the reserved registers)
            return 0;
    }
};

/**
 * @param {number} locality
 * @param {number} offset
 * @param {number} value
 */
TpmCrb.prototype.write32 = function(locality, offset, value)
{
    if(offset >= DATA)
    {
        for(let i = 0; i < 4 && offset - DATA + i < TPM_BUFFER_SIZE; i++)
        {
            this.buffer[offset - DATA + i] = value >>> 8 * i & 0xFF;
        }
        return;
    }
    switch(offset)
    {
        case LOC_CTRL:
            if(value & CTRL_REQUEST_ACCESS && this.locality < 0) this.locality = locality;
            if(value & CTRL_SEIZE && locality > this.locality)
            {
                if(this.locality >= 0) this.seized |= 1 << this.locality;
                this.locality = locality;
            }
            if(value & CTRL_RELINQUISH && this.locality === locality) this.locality = -1;
            // (a dynamic launch's bit: the locality 3 and 4 software's)
            if(value & CTRL_RESET_ESTABLISHMENT && locality >= 3) this.established = false;
            if(value & (CTRL_REQUEST_ACCESS | CTRL_SEIZE) && this.locality === locality) this.seized &= ~(1 << locality);
            break;
        case CTRL_REQ:
            if(value & REQ_CMD_READY) this.idle = false;
            if(value & REQ_GO_IDLE) this.idle = true;
            break;
        case CTRL_CANCEL:
            this.cancel = value & 1;
            break;
        case CTRL_START:
            if(value & 1 && this.locality === locality) this.start(locality);
            break;
        case INT_ENABLE:
            this.interrupts = value & 0x80000000;
            break;
        case CTRL_EXT:
        case INT_STS:
        case CMD_SIZE:
        case CMD_LADDR:
        case CMD_HADDR:
        case RSP_SIZE:
        case RSP_LADDR:
        case RSP_HADDR:
            break;
    }
};

/**
 * Run the command in the buffer: its length from its header (bytes 2 to
 * 5), the response into the buffer
 * @param {number} locality
 */
TpmCrb.prototype.start = function(locality)
{
    this.idle = false;
    const length = (this.buffer[2] << 24 | this.buffer[3] << 16 | this.buffer[4] << 8 | this.buffer[5]) >>> 0;
    const response = this.process(this.buffer.slice(0, Math.min(Math.max(length, 10), TPM_BUFFER_SIZE)), locality);
    this.buffer.set(response.subarray(0, TPM_BUFFER_SIZE));
};

/**
 * A byte of the window of `address` (offset from the base)
 * @param {number} offset
 * @return {number}
 */
TpmCrb.prototype.read8 = function(offset)
{
    const locality = offset >>> 12, at = offset & 0xFFF;
    return this.read32(locality, at & ~3) >>> 8 * (at & 3) & 0xFF;
};

/**
 * @param {number} offset
 * @param {number} value
 */
TpmCrb.prototype.write8 = function(offset, value)
{
    const locality = offset >>> 12, at = offset & 0xFFF;
    if(at >= DATA)
    {
        if(at - DATA < TPM_BUFFER_SIZE) this.buffer[at - DATA] = value;
        return;
    }
    // (a register written a byte at a time: the other bytes as they read)
    const shift = 8 * (at & 3);
    const old = this.read32(locality, at & ~3);
    this.write32(locality, at & ~3, old & ~(0xFF << shift) | (value & 0xFF) << shift);
};

TpmCrb.prototype.get_state = function()
{
    return [this.locality, this.established, this.seized, this.idle, this.cancel, this.interrupts, this.buffer.slice()];
};

TpmCrb.prototype.set_state = function(state)
{
    this.locality = state[0];
    this.established = state[1];
    this.seized = state[2];
    this.idle = state[3];
    this.cancel = state[4];
    this.interrupts = state[5];
    this.buffer.set(state[6]);
};
