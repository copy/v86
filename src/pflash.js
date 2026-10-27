// The UEFI firmware's variable store as CFI flash (docs/uefi.md): QEMU's
// pflash unit 1 (hw/block/pflash_cfi01.c, as OVMF's QemuFlashFvbServices
// drives it: OvmfPkg/QemuFlashFvbServicesRuntimeDxe/QemuFlash.c). In read
// array mode it is device memory that reads at memory speed and leaves
// writes here (crate::cpu::mmio_ram, read-only); a command switches it out
// of the address space, so that reads return the status register, until
// "read array" puts it back.
//
// Commands (Intel/Sharp set): 0x10 or 0x40 program a byte (the next write
// is its data), 0x20 then 0xD0 erase a 4 KiB block, 0x50 clear the status
// register, 0x70 read it, 0x90 read the identifiers, 0xFF read array. The
// status register: 0x80 ready, 0x20 erase error, 0x10 program error.
//
// The bytes are kept in a buffer object (src/buffer.js's SyncBuffer, or a
// disk written back: src/disk_writeback.js, src/opfs_disk.js), which every
// program and erase also updates: a variable store written back outlives the
// machine as a disk does, and a snapshot has its reference, or its bytes.

import { dbg_assert, dbg_log } from "./log.js";
import { LOG_BIOS } from "./const.js";
import { h } from "./lib.js";
import { restore_disk_state } from "./disk_writeback.js";

// For Types Only
import { CPU } from "./cpu.js";

const BLOCK_SIZE = 4096;

const CMD_READ_ARRAY = 0xFF;
const CMD_PROGRAM = 0x10;
const CMD_PROGRAM_ALT = 0x40;
const CMD_ERASE = 0x20;
const CMD_ERASE_CONFIRM = 0xD0;
const CMD_CLEAR_STATUS = 0x50;
const CMD_READ_STATUS = 0x70;
const CMD_READ_ID = 0x90;

const STATUS_READY = 0x80;
const STATUS_ERASE_ERROR = 0x20;
const STATUS_PROGRAM_ERROR = 0x10;

/** (Intel's manufacturer code, QEMU's default device code for its x86 machines) */
const ID_MANUFACTURER = 0x89;
const ID_DEVICE = 0x18;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {number} region the mmio_ram region of the store
 * @param {number} base its guest physical address
 * @param {!Object} buffer its bytes: get, set (synchronous), byteLength
 */
export function PFlash(cpu, region, base, buffer)
{
    this.cpu = cpu;
    this.region = region;
    this.base = base;
    this.buffer = buffer;
    this.size = buffer.byteLength;
    dbg_assert(this.size % BLOCK_SIZE === 0);

    /** 0: read array; else the command whose cycle runs, or the read mode */
    this.command = 0;
    this.status = 0;

    this.load();
    cpu.mmio_ram_set_writable(region, false);
    this.read_array();
}

/** The buffer's bytes into the array */
PFlash.prototype.load = function()
{
    this.buffer.get(0, this.size, data => {
        dbg_assert(data, "the variable store cannot be read");
        // (a view of the moment: the wasm memory may grow)
        new Uint8Array(this.cpu.wasm_memory.buffer, this.cpu.mmio_ram_backing(this.region) >>> 0, this.size).set(data);
    });
};

/** The array in the address space again */
PFlash.prototype.read_array = function()
{
    this.command = 0;
    this.cpu.mmio_ram_map(this.region, this.base | 0);
};

/**
 * A mode whose reads are not the array's: out of the address space
 * @param {number} command
 */
PFlash.prototype.enter = function(command)
{
    if(this.command === 0)
    {
        this.cpu.mmio_ram_unmap(this.region);
    }
    this.command = command;
};

/**
 * A read outside read array mode
 * @param {number} offset
 * @return {number}
 */
PFlash.prototype.read = function(offset)
{
    switch(this.command)
    {
        case 0:
            return this.array_byte(offset);
        case CMD_READ_ID:
            return (offset & 0xFF) === 0 ? ID_MANUFACTURER : (offset & 0xFF) === 1 ? ID_DEVICE : 0;
        default:
            // (the program, erase, clear and read status cycles)
            return this.status;
    }
};

/** @param {number} offset */
PFlash.prototype.array_byte = function(offset)
{
    // (the wasm memory may have grown since: a view of the moment)
    return this.cpu.mmio_ram_read8(this.region, offset);
};

/**
 * A write anywhere in the store
 * @param {number} offset
 * @param {number} value
 */
PFlash.prototype.write = function(offset, value)
{
    value &= 0xFF;
    switch(this.command)
    {
        case CMD_PROGRAM:
        case CMD_PROGRAM_ALT:
            if(this.status & 0x7F)
            {
                // (an error not cleared: the device refuses the program)
                this.status |= STATUS_READY | STATUS_PROGRAM_ERROR;
            }
            else
            {
                this.store(offset, Uint8Array.of(value));
                this.status |= STATUS_READY;
            }
            // (the status register's read mode until "read array")
            this.command = CMD_READ_STATUS;
            return;
        case CMD_ERASE:
            if(value === CMD_ERASE_CONFIRM)
            {
                const start = offset & ~(BLOCK_SIZE - 1);
                this.store(start, new Uint8Array(BLOCK_SIZE).fill(0xFF));
                this.status |= STATUS_READY;
            }
            else
            {
                this.status |= STATUS_READY | STATUS_ERASE_ERROR | STATUS_PROGRAM_ERROR;
            }
            this.command = CMD_READ_STATUS;
            return;
    }
    switch(value)
    {
        case CMD_READ_ARRAY:
            this.read_array();
            break;
        case CMD_CLEAR_STATUS:
            this.status = 0;
            this.read_array();
            break;
        case CMD_PROGRAM:
        case CMD_PROGRAM_ALT:
        case CMD_ERASE:
        case CMD_READ_STATUS:
        case CMD_READ_ID:
            this.enter(value);
            break;
        default:
            dbg_log("pflash: unknown command " + h(value, 2) + " at " + h(offset, 5), LOG_BIOS);
            this.read_array();
    }
};

/**
 * Bytes into the array and the buffer
 * @param {number} offset
 * @param {!Uint8Array} data
 */
PFlash.prototype.store = function(offset, data)
{
    new Uint8Array(this.cpu.wasm_memory.buffer, this.cpu.mmio_ram_backing(this.region) >>> 0, this.size).set(data, offset);
    this.buffer.set(offset, data, error => {
        if(error)
        {
            // (the firmware sees a failed program or erase)
            dbg_log("pflash: the variable store could not be written: " + error.message, LOG_BIOS);
            this.status |= STATUS_PROGRAM_ERROR;
        }
    });
};

/** The machine's power-on: read array mode, the status clear; the array's bytes stay */
PFlash.prototype.reset = function()
{
    this.status = 0;
    this.read_array();
};

PFlash.prototype.get_state = function()
{
    return [this.command, this.status, this.buffer.get_state()];
};

PFlash.prototype.set_state = function(state)
{
    // (checked before: CPU.prototype.validate_state)
    restore_disk_state(this.buffer, state[2]);
    this.load();
    this.status = state[1];
    if(state[0] === 0)
    {
        this.read_array();
    }
    else
    {
        this.enter(state[0]);
    }
};
