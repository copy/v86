// v86 Floppy Disk Controller emulation
//
// This file is licensed under both BSD and MIT, see LICENSE and LICENSE.MIT.
//
// Links
// - Intel 82078 44 Pin CHMOS Single-Chip Floppy Disk Controller
//   https://wiki.qemu.org/images/f/f0/29047403.pdf
// - qemu: fdc.c
//   https://github.com/qemu/qemu/blob/master/hw/block/fdc.c
// - Programming Floppy Disk Controllers
//   https://www.isdaman.com/alsos/hardware/fdc/floppy.htm
// - OSDev: Floppy Disk Controller
//   https://wiki.osdev.org/Floppy_Disk_Controller

import { LOG_FLOPPY } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { CMOS_FLOPPY_DRIVE_TYPE } from "./rtc.js";
import { SyncBuffer } from "./buffer.js";

// For Types Only
import { CPU } from "./cpu.js";
import { DMA } from "./dma.js";
import { IO } from "./io.js";

// System resources
const FDC_IRQ_CHANNEL = 6;
const FDC_DMA_CHANNEL = 2;

/**
 * Floppy drive types
 * CMOS register 0x10 bits: upper nibble: fda, lower nibble: fdb
 * @see {@link https://wiki.osdev.org/CMOS#Register_0x10}
 */
const CMOS_FDD_TYPE_NO_DRIVE = 0x0; // no floppy drive
const CMOS_FDD_TYPE_360      = 0x1; // 360 KB 5"1/4 drive
const CMOS_FDD_TYPE_1200     = 0x2; // 1.2 MB 5"1/4 drive
const CMOS_FDD_TYPE_720      = 0x3; // 720 KB 3"1/2 drive
const CMOS_FDD_TYPE_1440     = 0x4; // 1.44 MB 3"1/2 drive
const CMOS_FDD_TYPE_2880     = 0x5; // 2.88 MB 3"1/2 drive

// Physical floppy disk size identifier of each drive type
const CMOS_FDD_TYPE_MEDIUM = {
    [CMOS_FDD_TYPE_NO_DRIVE]: 0,    // no disk
    [CMOS_FDD_TYPE_360]:      525,  // 5"1/4 disk
    [CMOS_FDD_TYPE_1200]:     525,  // 5"1/4 disk
    [CMOS_FDD_TYPE_720]:      350,  // 3"1/2 disk
    [CMOS_FDD_TYPE_1440]:     350,  // 3"1/2 disk
    [CMOS_FDD_TYPE_2880]:     350,  // 3"1/2 disk
};

// Floppy Controller PIO Register offsets (base: 0x3F0/0x370, offset 0x6 is reserved for ATA IDE)
const REG_SRA       = 0x0;  // R,  Status Register A (SRA)
const REG_SRB       = 0x1;  // R,  Status Register B (SRB)
const REG_DOR       = 0x2;  // RW, Digital Output Register (DOR)
const REG_TDR       = 0x3;  // RW, Tape Drive Register (TDR)
const REG_MSR       = 0x4;  // R,  Main Status Register (MSR)
const REG_DSR       = 0x4;  // W,  Datarate Select Register (DSR)
const REG_FIFO      = 0x5;  // RW, W: command bytes, R: response bytes (FIFO)
const REG_DIR       = 0x7;  // R,  Digital Input Register (DIR)
const REG_CCR       = 0x7;  // W,  Configuration Control Register (CCR)

// Status Register A (SRA) bits
const SRA_NDRV2     = 0x40; // true: second drive is not connected
const SRA_INTPEND   = 0x80; // true: interrupt pending

// Status Register B (SRB) bits
const SRB_MTR0      = 0x1;  // follows DOR.DOR_MOT0
const SRB_MTR1      = 0x2;  // follows DOR.DOR_MOT1
const SRB_DR0       = 0x20; // follows DOR.DOR_SEL_LO
const SRB_RESET     = 0xc0; // magic value after reset

// Digital Output Register (DOR) bits
const DOR_SEL_LO    = 0x1;  // lower bit of selected FDD number
const DOR_SEL_HI    = 0x2;  // upper bit of selected FDD number
const DOR_NRESET    = 0x4;  // true: normal controller mode, false: reset mode ("not RESET")
const DOR_DMAEN     = 0x8;  // true: use DMA
const DOR_MOTEN0    = 0x10; // true: enable motor of FDD0
const DOR_MOTEN1    = 0x20; // true: enable motor of FDD1
const DOR_MOTEN2    = 0x40; // true: enable motor of FDD2
const DOR_MOTEN3    = 0x80; // true: enable motor of FDD3
const DOR_SELMASK   = 0x01;

// Tape Drive Register (TDR) bits
const TDR_BOOTSEL   = 0x4;

// Main Status Register (MSR) bits
const MSR_FDD0      = 0x1;  // true: FDD0 is busy in seek mode
const MSR_FDD1      = 0x2;  // true: FDD1 is busy in seek mode
const MSR_FDD2      = 0x4;  // true: FDD2 is busy in seek mode
const MSR_FDD3      = 0x8;  // true: FDD3 is busy in seek mode
const MSR_CMDBUSY   = 0x10; // true: FDC busy, Read/Write command in progress, cleared at end of Result phase
const MSR_NDMA      = 0x20; // Non-DMA mode, set in Execution phase of PIO mode read/write commands only.
const MSR_DIO       = 0x40; // Data Input/Output, true: FDC has data for CPU, false: FDC expects data from CPU
const MSR_RQM       = 0x80; // true: DATA register is ready for I/O

// Datarate Select Register (DSR) bits
const DSR_DRATEMASK = 0x3;
const DSR_PWRDOWN   = 0x40;
const DSR_SWRESET   = 0x80;

// Digital Input Register (DIR) bits
const DIR_DOOR      = 0x80; // true: No disk or disk changed since last command

// Status Register 0 (SR0) bits
const SR0_DS0       = 0x1;  // Drive select 0..3 lower bit
const SR0_DS1       = 0x2;  // Drive select 0..3 upper bit
const SR0_HEAD      = 0x4;  // true: Use 2nd head
const SR0_EQPMT     = 0x10; // (?)
const SR0_SEEK      = 0x20; // (?)
const SR0_ABNTERM   = 0x40; // true: Command failed
const SR0_INVCMD    = 0x80; // true: Unknown/unimplemented command code
const SR0_RDYCHG    = SR0_ABNTERM | SR0_INVCMD; // 0xC0 (?)

// Status Register 1 (SR1) bits
const SR1_MA        = 0x1;  // true: Missing address mark error
const SR1_NW        = 0x2;  // true: Not writable error
const SR1_EC        = 0x80; // true: End of cylinder error

// Status Register 2 (SR2) bits
const SR2_SNS       = 0x4;  // true: Scan not satisfied (?)
const SR2_SEH       = 0x8;  // true: Scan equal hit (?)

/**
 * FDC command codes
 * We declare all known floppy commands but implement only the subset that
 * we actually observe in the field. See also build_cmd_lookup_table().
 * @see {@link https://github.com/qemu/qemu/blob/6e1571533fd92bec67e5ab9b1dd1e15032925757/hw/block/fdc.c#L619}
 */
const CMD_READ_TRACK             = 0x2; // unimplemented
const CMD_SPECIFY                = 0x3;
const CMD_SENSE_DRIVE_STATUS     = 0x4;
const CMD_WRITE                  = 0x5;
const CMD_READ                   = 0x6;
const CMD_RECALIBRATE            = 0x7;
const CMD_SENSE_INTERRUPT_STATUS = 0x8;
const CMD_WRITE_DELETED_DATA     = 0x9; // unimplemented
const CMD_READ_ID                = 0xa;
const CMD_READ_DELETED_DATA      = 0xc; // unimplemented
const CMD_FORMAT_TRACK           = 0xd;
const CMD_DUMP_REGS              = 0xe;
const CMD_SEEK                   = 0xf;
const CMD_VERSION                = 0x10;
const CMD_SCAN_EQUAL             = 0x11; // unimplemented
const CMD_PERPENDICULAR_MODE     = 0x12;
const CMD_CONFIGURE              = 0x13;
const CMD_LOCK                   = 0x14;
const CMD_VERIFY                 = 0x16; // unimplemented
const CMD_POWERDOWN_MODE         = 0x17; // unimplemented
const CMD_PART_ID                = 0x18;
const CMD_SCAN_LOW_OR_EQUAL      = 0x19; // unimplemented
const CMD_SCAN_HIGH_OR_EQUAL     = 0x1d; // unimplemented
const CMD_SAVE                   = 0x2e; // unimplemented
const CMD_OPTION                 = 0x33; // unimplemented
const CMD_RESTORE                = 0x4e; // unimplemented
const CMD_DRIVE_SPECIFICATION    = 0x8e; // unimplemented
const CMD_RELATIVE_SEEK_OUT      = 0x8f; // unimplemented
const CMD_FORMAT_AND_WRITE       = 0xcd; // unimplemented
const CMD_RELATIVE_SEEK_IN       = 0xcf; // unimplemented

// FDC command flags
const CMD_FLAG_MULTI_TRACK  = 0x1;  // MT: multi-track selector (use both heads) in READ/WRITE

// FDC command execution phases
const CMD_PHASE_COMMAND     = 1;
const CMD_PHASE_EXECUTION   = 2;
const CMD_PHASE_RESULT      = 3;

// FDC config bits
const CONFIG_PRETRK     = 0xff; // Pre-compensation set to track 0
const CONFIG_FIFOTHR    = 0x0f; // FIFO threshold set to 1 byte
const CONFIG_POLL       = 0x10; // Poll enabled
const CONFIG_EFIFO      = 0x20; // FIFO disabled
const CONFIG_EIS        = 0x40; // No implied seeks

// Number of CMD_SENSE_INTERRUPT_STATUS expected after reset
const RESET_SENSE_INT_MAX = 4;

// Sector size
const SECTOR_SIZE       = 512;  // fixed size of 512 bytes/sector
const SECTOR_SIZE_CODE  = 2;    // sector size code 2: 512 bytes/sector

// class FloppyController ----------------------------------------------------

/**
 * @constructor
 *
 * @param {CPU} cpu
 * @param {SyncBuffer|Uint8Array|null|undefined} fda_image
 * @param {SyncBuffer|Uint8Array|null|undefined} fdb_image
 * @param {Object=} fdc_config
 *
 * Structure and defaults of optional configuration object fdc_config:
 *
 *   fdc_config = {
 *       fda: { drive_type: undefined, read_only: false },
 *       fdb: { drive_type: undefined, read_only: false }
 *   }
 *
 * drive_type:
 *     Fixed drive type code whether or not a buffer is defined:
 *       0: no floppy drive
 *       1: 360 KB 5"1/4 drive
 *       2: 1.2 MB 5"1/4 drive
 *       3: 720 KB 3"1/2 drive
 *       4: 1.44 MB 3"1/2 drive (default)
 *       5: 2.88 MB 3"1/2 drive
 *     If undefined, the drive type is either derived from the given
 *     buffer or set to the default of 4 if no buffer is specified.
 * read_only:
 *     If true, treat the given disk image as write-protected.
 *     Ignored if no disk image is provided. Default: false.
 *
 * NOTE: To hide fdb from the guest set its drive_type to 0, i.e.:
 *
 *   fdc_config = { fdb: { drive_type: 0 } }
 */
export function FloppyController(cpu, fda_image, fdb_image, fdc_config)
{
    /** @const @type {IO|undefined} */
    this.io = cpu.io;

    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {DMA} */
    this.dma = cpu.devices.dma;

    /** @const */
    this.cmd_table = this.build_cmd_lookup_table();

    this.sra = 0;
    this.srb = SRB_RESET;
    this.dor = DOR_NRESET | DOR_DMAEN;
    this.tdr = 0;
    this.msr = MSR_RQM;
    this.dsr = 0;

    this.cmd_phase = CMD_PHASE_COMMAND;
    this.cmd_code = 0;
    this.cmd_flags = 0;
    this.cmd_buffer = new Uint8Array(17);    // CMD_RESTORE has 17 argument bytes
    this.cmd_cursor = 0;
    this.cmd_remaining = 0;

    this.response_data = new Uint8Array(15); // CMD_SAVE response size is 15 bytes
    this.response_cursor = 0;
    this.response_length = 0;
    this.status0 = 0;
    this.status1 = 0;

    this.curr_drive_no = 0;         // was: this.drive; qemu: fdctrl->cur_drv
    this.reset_sense_int_count = 0; // see SENSE INTERRUPT
    this.locked = false;            // see LOCK
    this.step_rate_interval = 0;    // see SPECIFY, qemu: timer0
    this.head_load_time = 0;        // see SPECIFY, qemu: timer1
    this.fdc_config = CONFIG_EIS | CONFIG_EFIFO;    // see CONFIGURE, qemu: config
    this.precomp_trk = 0;           // see CONFIGURE
    this.eot = 0;                   // see READ/WRITE

    this.drives = [
        new FloppyDrive("fda", fdc_config?.fda, fda_image, CMOS_FDD_TYPE_1440),
        new FloppyDrive("fdb", fdc_config?.fdb, fdb_image, CMOS_FDD_TYPE_1440)
    ];

    Object.seal(this);

    // To make the floppy drives visible to the guest OS we MUST write a
    // drive type other than 0 (CMOS_FDD_TYPE_NO_DRIVE) to either nibble of
    // CMOS register 0x10 before the guest is started (CMOS registers are
    // usually read only once at startup).
    this.cpu.devices.rtc.cmos_write(CMOS_FLOPPY_DRIVE_TYPE, (this.drives[0].drive_type << 4) | this.drives[1].drive_type);

    const fdc_io_base = 0x3F0;  // alt: 0x370

    this.io.register_read(fdc_io_base | REG_SRA, this, this.read_reg_sra);
    this.io.register_read(fdc_io_base | REG_SRB, this, this.read_reg_srb);
    this.io.register_read(fdc_io_base | REG_DOR, this, this.read_reg_dor);
    this.io.register_read(fdc_io_base | REG_TDR, this, this.read_reg_tdr);
    this.io.register_read(fdc_io_base | REG_MSR, this, this.read_reg_msr);
    this.io.register_read(fdc_io_base | REG_FIFO, this, this.read_reg_fifo);
    this.io.register_read(fdc_io_base | REG_DIR, this, this.read_reg_dir);

    this.io.register_write(fdc_io_base | REG_DOR, this, this.write_reg_dor);
    this.io.register_write(fdc_io_base | REG_TDR, this, this.write_reg_tdr);
    this.io.register_write(fdc_io_base | REG_DSR, this, this.write_reg_dsr);
    this.io.register_write(fdc_io_base | REG_FIFO, this, this.write_reg_fifo);
    this.io.register_write(fdc_io_base | REG_CCR, this, this.write_reg_ccr);

    dbg_log("floppy controller ready", LOG_FLOPPY);
}

FloppyController.prototype.build_cmd_lookup_table = function()
{
    /**
     * NOTE: The order of items in the table below is significant.
     * @see {@link https://github.com/qemu/qemu/blob/aec6836c73403cffa56b9a4c5556451ee16071fe/hw/block/fdc.c#L2160}
     */
    const CMD_DESCRIPTOR = [
        { code: CMD_READ, mask: 0x1f, argc: 8, name: "READ", handler: this.exec_read },
        { code: CMD_WRITE, mask: 0x3f, argc: 8, name: "WRITE", handler: this.exec_write },
        { code: CMD_SEEK, mask: 0xff, argc: 2, name: "SEEK", handler: this.exec_seek },
        { code: CMD_SENSE_INTERRUPT_STATUS, mask: 0xff, argc: 0, name: "SENSE INTERRUPT STATUS", handler: this.exec_sense_interrupt_status },
        { code: CMD_RECALIBRATE, mask: 0xff, argc: 1, name: "RECALIBRATE", handler: this.exec_recalibrate },
        { code: CMD_FORMAT_TRACK, mask: 0xbf, argc: 5, name: "FORMAT TRACK", handler: this.exec_format_track },
        { code: CMD_READ_TRACK, mask: 0xbf, argc: 8, name: "READ TRACK", handler: this.exec_unimplemented },
        { code: CMD_RESTORE, mask: 0xff, argc: 17, name: "RESTORE", handler: this.exec_unimplemented },
        { code: CMD_SAVE, mask: 0xff, argc: 0, name: "SAVE", handler: this.exec_unimplemented },
        { code: CMD_READ_DELETED_DATA, mask: 0x1f, argc: 8, name: "READ DELETED DATA", handler: this.exec_unimplemented },
        { code: CMD_SCAN_EQUAL, mask: 0x1f, argc: 8, name: "SCAN EQUAL", handler: this.exec_unimplemented },
        { code: CMD_VERIFY, mask: 0x1f, argc: 8, name: "VERIFY", handler: this.exec_unimplemented },
        { code: CMD_SCAN_LOW_OR_EQUAL, mask: 0x1f, argc: 8, name: "SCAN LOW OR EQUAL", handler: this.exec_unimplemented },
        { code: CMD_SCAN_HIGH_OR_EQUAL, mask: 0x1f, argc: 8, name: "SCAN HIGH OR EQUAL", handler: this.exec_unimplemented },
        { code: CMD_WRITE_DELETED_DATA, mask: 0x3f, argc: 8, name: "WRITE DELETED DATA", handler: this.exec_unimplemented },
        { code: CMD_READ_ID, mask: 0xbf, argc: 1, name: "READ ID", handler: this.exec_read_id },
        { code: CMD_SPECIFY, mask: 0xff, argc: 2, name: "SPECIFY", handler: this.exec_specify },
        { code: CMD_SENSE_DRIVE_STATUS, mask: 0xff, argc: 1, name: "SENSE DRIVE STATUS", handler: this.exec_sense_drive_status },
        { code: CMD_PERPENDICULAR_MODE, mask: 0xff, argc: 1, name: "PERPENDICULAR MODE", handler: this.exec_perpendicular_mode },
        { code: CMD_CONFIGURE, mask: 0xff, argc: 3, name: "CONFIGURE", handler: this.exec_configure },
        { code: CMD_POWERDOWN_MODE, mask: 0xff, argc: 2, name: "POWERDOWN MODE", handler: this.exec_unimplemented },
        { code: CMD_OPTION, mask: 0xff, argc: 1, name: "OPTION", handler: this.exec_unimplemented },
        { code: CMD_DRIVE_SPECIFICATION, mask: 0xff, argc: 5, name: "DRIVE SPECIFICATION", handler: this.exec_unimplemented },
        { code: CMD_RELATIVE_SEEK_OUT, mask: 0xff, argc: 2, name: "RELATIVE SEEK OUT", handler: this.exec_unimplemented },
        { code: CMD_FORMAT_AND_WRITE, mask: 0xff, argc: 10, name: "FORMAT AND WRITE", handler: this.exec_unimplemented },
        { code: CMD_RELATIVE_SEEK_IN, mask: 0xff, argc: 2, name: "RELATIVE SEEK IN", handler: this.exec_unimplemented },
        { code: CMD_LOCK, mask: 0x7f, argc: 0, name: "LOCK", handler: this.exec_lock },
        { code: CMD_DUMP_REGS, mask: 0xff, argc: 0, name: "DUMP REGISTERS", handler: this.exec_dump_regs },
        { code: CMD_VERSION, mask: 0xff, argc: 0, name: "VERSION", handler: this.exec_version },
        { code: CMD_PART_ID, mask: 0xff, argc: 0, name: "PART ID", handler: this.exec_part_id },

        { code: 0, mask: 0x00, argc: 0, name: "UNKNOWN COMMAND", handler: this.exec_unimplemented },    // default handler
    ];

    const cmd_table = new Array(256);
    for(let i = CMD_DESCRIPTOR.length-1; i >= 0; i--)
    {
        const cmd_desc = CMD_DESCRIPTOR[i];
        if(cmd_desc.mask === 0xff)
        {
            cmd_table[cmd_desc.code] = cmd_desc;
        }
        else
        {
            for(let j = 0; j < 256; j++)
            {
                if((j & cmd_desc.mask) === cmd_desc.code)
                {
                    cmd_table[j] = cmd_desc;
                }
            }
        }
    }
    return cmd_table;
};

FloppyController.prototype.raise_irq = function(reason)
{
    if(!(this.sra & SRA_INTPEND))
    {
        this.cpu.device_raise_irq(FDC_IRQ_CHANNEL);
        this.sra |= SRA_INTPEND;
        dbg_log("IRQ raised, reason: " + reason, LOG_FLOPPY);
    }
    this.reset_sense_int_count = 0;
};

FloppyController.prototype.lower_irq = function(reason)
{
    this.status0 = 0;
    if(this.sra & SRA_INTPEND)
    {
        this.cpu.device_lower_irq(FDC_IRQ_CHANNEL);
        this.sra &= ~SRA_INTPEND;
        dbg_log("IRQ lowered, reason: " + reason, LOG_FLOPPY);
    }
};

FloppyController.prototype.set_curr_drive_no = function(curr_drive_no)
{
    this.curr_drive_no = curr_drive_no & 1;
    return this.drives[this.curr_drive_no];
};

FloppyController.prototype.enter_command_phase = function()
{
    this.cmd_phase = CMD_PHASE_COMMAND;
    this.cmd_cursor = 0;
    this.cmd_remaining = 0;
    this.msr &= ~(MSR_CMDBUSY | MSR_DIO);
    this.msr |= MSR_RQM;
};

FloppyController.prototype.enter_result_phase = function(fifo_len)
{
    this.cmd_phase = CMD_PHASE_RESULT;
    this.response_cursor = 0;
    this.response_length = fifo_len;
    this.msr |= MSR_CMDBUSY | MSR_RQM | MSR_DIO;
};

FloppyController.prototype.reset_fdc = function()
{
    dbg_log("resetting controller", LOG_FLOPPY);
    this.lower_irq("controller reset");

    this.sra = 0;   // NOTE: set SRA to SRA_NDRV2 if fdb does not exist
    this.srb = SRB_RESET;
    this.dor = DOR_NRESET | DOR_DMAEN;
    this.msr = MSR_RQM;
    this.curr_drive_no = 0;
    this.status0 |= SR0_RDYCHG;

    this.response_cursor = 0;
    this.response_length = 0;

    this.drives[0].seek(0, 0, 1);
    this.drives[1].seek(0, 0, 1);

    // raise interrupt
    this.enter_command_phase();
    this.raise_irq("controller reset");
    this.reset_sense_int_count = RESET_SENSE_INT_MAX;
};

// Register I/O callbacks ----------------------------------------------------

FloppyController.prototype.read_reg_sra = function()
{
    dbg_log("SRA read: " + h(this.sra), LOG_FLOPPY);
    return this.sra;
};

FloppyController.prototype.read_reg_srb = function()
{
    dbg_log("SRB read: " + h(this.srb), LOG_FLOPPY);
    return this.srb;
};

FloppyController.prototype.read_reg_dor = function()
{
    const dor_byte = (this.dor & ~(DOR_SEL_LO|DOR_SEL_HI)) | this.curr_drive_no;
    dbg_log("DOR read: " + h(dor_byte), LOG_FLOPPY);
    return dor_byte;
};

FloppyController.prototype.read_reg_tdr = function()
{
    dbg_log("TDR read: " + h(this.tdr), LOG_FLOPPY);
    return this.tdr;
};

FloppyController.prototype.read_reg_msr = function()
{
    dbg_log("MSR read: " + h(this.msr), LOG_FLOPPY);
    this.dsr &= ~DSR_PWRDOWN;
    this.dor |= DOR_NRESET;
    return this.msr;
};

FloppyController.prototype.read_reg_fifo = function()
{
    this.dsr &= ~DSR_PWRDOWN;
    if(!(this.msr & MSR_RQM) || !(this.msr & MSR_DIO))
    {
        dbg_log("FIFO read rejected: controller not ready for reading", LOG_FLOPPY);
        return 0;
    }
    else if(this.cmd_phase !== CMD_PHASE_RESULT)
    {
        dbg_log("FIFO read rejected: floppy controller not in RESULT phase, phase: " + this.cmd_phase, LOG_FLOPPY);
        return 0;
    }

    if(this.response_cursor < this.response_length)
    {
        const fifo_byte = this.response_data[this.response_cursor++];
        if(this.response_cursor === this.response_length)
        {
            const lower_irq_reason = DEBUG ? "end of " + this.cmd_table[this.cmd_code].name + " response" : "";
            this.msr &= ~MSR_RQM;
            this.enter_command_phase();
            this.lower_irq(lower_irq_reason);
        }
        return fifo_byte;
    }
    else
    {
        dbg_log("FIFO read: empty", LOG_FLOPPY);
        return 0;
    }
};

FloppyController.prototype.read_reg_dir = function()
{
    const curr_drive = this.drives[this.curr_drive_no];
    const dir_byte = curr_drive.media_changed ? DIR_DOOR : 0;
    dbg_log("DIR read: " + h(dir_byte), LOG_FLOPPY);
    return dir_byte;
};

FloppyController.prototype.write_reg_dor = function(dor_byte)
{
    // update motor and drive bits in Status Register B
    this.srb = (this.srb & ~(SRB_MTR0 | SRB_MTR1 | SRB_DR0)) |
        (dor_byte & DOR_MOTEN0 ? SRB_MTR0 : 0) |
        (dor_byte & DOR_MOTEN1 ? SRB_MTR1 : 0) |
        (dor_byte & DOR_SEL_LO ? SRB_DR0 : 0);

    // RESET-state transitions
    if(this.dor & DOR_NRESET)
    {
        if(!(dor_byte & DOR_NRESET))
        {
            dbg_log("enter RESET state", LOG_FLOPPY);
        }
    }
    else
    {
        if(dor_byte & DOR_NRESET)
        {
            this.reset_fdc();
            this.dsr &= ~DSR_PWRDOWN;
            dbg_log("exit RESET state", LOG_FLOPPY);
        }
    }

    // select current drive
    const new_drive_no = dor_byte & (DOR_SEL_LO|DOR_SEL_HI);
    dbg_log("DOR write: " + h(dor_byte) + ", motors: " + h(dor_byte >> 4) +
        ", dma: " + !!(dor_byte & DOR_DMAEN) + ", reset: " + !(dor_byte & DOR_NRESET) +
        ", drive: " + new_drive_no, LOG_FLOPPY);
    if(new_drive_no > 1)
    {
        dbg_log("*** WARNING: floppy drive number " + new_drive_no + " not implemented!", LOG_FLOPPY);
    }
    this.curr_drive_no = new_drive_no & DOR_SEL_LO;

    this.dor = dor_byte;
};

FloppyController.prototype.write_reg_tdr = function(tdr_byte)
{
    if(!(this.dor & DOR_NRESET))
    {
        dbg_log("TDR write " + h(tdr_byte) + " rejected: Floppy controller in RESET mode!", LOG_FLOPPY);
        return;
    }

    dbg_log("TDR write: " + h(tdr_byte), LOG_FLOPPY);
    this.tdr = tdr_byte & TDR_BOOTSEL;  // Disk boot selection indicator
};

FloppyController.prototype.write_reg_dsr = function(dsr_byte)
{
    if(!(this.dor & DOR_NRESET))
    {
        dbg_log("DSR write: " + h(dsr_byte) + " rejected: Floppy controller in RESET mode!", LOG_FLOPPY);
        return;
    }

    dbg_log("DSR write: " + h(dsr_byte), LOG_FLOPPY);
    if(dsr_byte & DSR_SWRESET)
    {
        this.dor &= ~DOR_NRESET;
        this.reset_fdc();
        this.dor |= DOR_NRESET;
    }
    if(dsr_byte & DSR_PWRDOWN)
    {
        this.reset_fdc();
    }
    this.dsr = dsr_byte;
};

FloppyController.prototype.write_reg_fifo = function(fifo_byte)
{
    this.dsr &= ~DSR_PWRDOWN;
    if(!(this.dor & DOR_NRESET))
    {
        dbg_log("FIFO write " + h(fifo_byte) + " rejected: floppy controller in RESET mode!", LOG_FLOPPY);
        return;
    }
    else if(!(this.msr & MSR_RQM) || (this.msr & MSR_DIO))
    {
        dbg_log("FIFO write " + h(fifo_byte) + " rejected: controller not ready for writing", LOG_FLOPPY);
        return;
    }
    else if(this.cmd_phase !== CMD_PHASE_COMMAND)
    {
        dbg_log("FIFO write " + h(fifo_byte) + " rejected: floppy controller not in COMMAND phase, phase: " + this.cmd_phase, LOG_FLOPPY);
        return;
    }

    if(this.cmd_remaining === 0)
    {
        // start reading command, fifo_byte contains the command code
        const cmd_desc = this.cmd_table[fifo_byte];
        this.cmd_code = fifo_byte;
        this.cmd_remaining = cmd_desc.argc;
        this.cmd_cursor = 0;
        this.cmd_flags = 0;
        if((cmd_desc.code === CMD_READ || cmd_desc.code === CMD_WRITE) && (this.cmd_code & 0x80)) // 0x80: Multi-track (MT)
        {
            this.cmd_flags |= CMD_FLAG_MULTI_TRACK;
        }
        if(this.cmd_remaining)
        {
            this.msr |= MSR_RQM;
        }
        this.msr |= MSR_CMDBUSY;
    }
    else
    {
        // continue reading command, fifo_byte contains an argument value
        this.cmd_buffer[this.cmd_cursor++] = fifo_byte;
        this.cmd_remaining--;
    }

    if(this.cmd_remaining === 0)
    {
        // done reading command: execute
        this.cmd_phase = CMD_PHASE_EXECUTION;
        const cmd_desc = this.cmd_table[this.cmd_code];
        const args = this.cmd_buffer.slice(0, this.cmd_cursor);
        if(DEBUG)
        {
            const args_hex = [];
            for(const arg of args)
            {
                args_hex.push(h(arg, 2));
            }
            dbg_log("FD command " + h(this.cmd_code) + ": " + cmd_desc.name + "(" + args_hex.join(", ") + ")", LOG_FLOPPY);
        }
        cmd_desc.handler.call(this, args);
    }
};

FloppyController.prototype.write_reg_ccr = function(ccr_byte)
{
    if(!(this.dor & DOR_NRESET))
    {
        dbg_log("CCR write: " + h(ccr_byte) + " rejected: Floppy controller in RESET mode!", LOG_FLOPPY);
        return;
    }

    dbg_log("CCR write: " + h(ccr_byte), LOG_FLOPPY);
    // only the rate selection bits used in AT mode, and we store those in the DSR
    this.dsr = (this.dsr & ~DSR_DRATEMASK) | (ccr_byte & DSR_DRATEMASK);
};

// Floppy command handler ----------------------------------------------------

FloppyController.prototype.exec_unimplemented = function(args)
{
    dbg_assert(false, "Unimplemented floppy command code " + h(this.cmd_code) + "!");
    this.status0 = SR0_INVCMD;
    this.response_data[0] = this.status0;

    // no interrupt
    this.enter_result_phase(1);
};

FloppyController.prototype.exec_read = function(args)
{
    this.start_read_write(args, false);
};

FloppyController.prototype.exec_write = function(args)
{
    this.start_read_write(args, true);
};

FloppyController.prototype.exec_seek = function(args)
{
    const curr_drive = this.set_curr_drive_no(args[0] & DOR_SELMASK);
    const track = args[1];

    this.enter_command_phase();
    curr_drive.seek(curr_drive.curr_head, track, curr_drive.curr_sect);

    // raise interrupt without response
    this.status0 |= SR0_SEEK;
    this.raise_irq("SEEK command");
};

FloppyController.prototype.exec_sense_interrupt_status = function(args)
{
    const curr_drive = this.drives[this.curr_drive_no];

    let status0;
    if(this.reset_sense_int_count > 0)
    {
        const drv_nr = RESET_SENSE_INT_MAX - this.reset_sense_int_count--;
        status0 = SR0_RDYCHG | drv_nr;
    }
    else if(this.sra & SRA_INTPEND)
    {
        status0 = (this.status0 & ~(SR0_HEAD | SR0_DS1 | SR0_DS0)) | this.curr_drive_no;
    }
    else
    {
        dbg_log("No interrupt pending, aborting SENSE INTERRUPT command!", LOG_FLOPPY);
        this.response_data[0] = SR0_INVCMD;
        this.enter_result_phase(1);
        return;
    }

    this.response_data[0] = status0;
    this.response_data[1] = curr_drive.curr_track;

    // lower interrupt
    this.enter_result_phase(2);
    this.lower_irq("SENSE INTERRUPT command");
    this.status0 = SR0_RDYCHG;
};

FloppyController.prototype.exec_recalibrate = function(args)
{
    const curr_drive = this.set_curr_drive_no(args[0] & DOR_SELMASK);

    curr_drive.seek(0, 0, 1);

    // raise interrupt without response
    this.enter_command_phase();
    this.status0 |= SR0_SEEK;
    this.raise_irq("RECALIBRATE command");
};

FloppyController.prototype.exec_format_track = function(args)
{
    const curr_drive = this.set_curr_drive_no(args[0] & DOR_SELMASK);

    let status0 = 0, status1 = 0;
    if(curr_drive.read_only)
    {
        status0 = SR0_ABNTERM | SR0_SEEK;
        status1 = SR1_NW;
    }

    // raise interrupt
    this.end_read_write(status0, status1, 0);
};

FloppyController.prototype.exec_read_id = function(args)
{
    const head_sel = args[0];
    const curr_drive = this.drives[this.curr_drive_no];

    curr_drive.curr_head = (head_sel >> 2) & 1;
    if(curr_drive.max_sect !== 0)
    {
        curr_drive.curr_sect = (curr_drive.curr_sect % curr_drive.max_sect) + 1;
    }

    // raise interrupt
    this.end_read_write(0, 0, 0);
};

FloppyController.prototype.exec_specify = function(args)
{
    const hut_srt = args[0]; // 0..3: Head Unload Time (HUT), 4..7: Step Rate Interval (SRT)
    const nd_hlt = args[1];  // 0: Non-DMA mode flag (ND), 1..7: Head Load Time (HLT)

    this.step_rate_interval = hut_srt >> 4;
    this.head_load_time = nd_hlt >> 1;
    if(nd_hlt & 0x1)
    {
        this.dor &= ~DOR_DMAEN;
    }
    else
    {
        this.dor |= DOR_DMAEN;
    }

    // no interrupt or response
    this.enter_command_phase();
};

FloppyController.prototype.exec_sense_drive_status = function(args)
{
    const drv_sel = args[0];
    const curr_drive = this.set_curr_drive_no(drv_sel & DOR_SELMASK);
    curr_drive.curr_head = (drv_sel >> 2) & 1;

    this.response_data[0] = (curr_drive.read_only ? 0x40 : 0) |    // response byte is Status Register 3
        (curr_drive.curr_track === 0 ? 0x10 : 0) |
        (curr_drive.curr_head << 2) |
        this.curr_drive_no |
        0x28;   // bits 3 and 5 unused, always "1"

    // no interrupt
    this.enter_result_phase(1);
};

FloppyController.prototype.exec_perpendicular_mode = function(args)
{
    const perp_mode = args[0];

    if(perp_mode & 0x80)  // 0x80: OW, bits D0 and D1 can be overwritten
    {
        const curr_drive = this.drives[this.curr_drive_no];
        curr_drive.perpendicular = perp_mode & 0x7;
    }

    // no interrupt or response
    this.enter_command_phase();
};

FloppyController.prototype.exec_configure = function(args)
{
    // args[0] is always 0
    this.fdc_config = args[1];
    this.precomp_trk = args[2];

    // no interrupt or response
    this.enter_command_phase();
};

FloppyController.prototype.exec_lock = function(args)
{
    if(this.cmd_code & 0x80)
    {
        // LOCK command
        this.locked = true;
        this.response_data[0] = 0x10;
    }
    else
    {
        // UNLOCK command
        this.locked = false;
        this.response_data[0] = 0;
    }

    // no interrupt
    this.enter_result_phase(1);
};

FloppyController.prototype.exec_dump_regs = function(args)
{
    const curr_drive = this.drives[this.curr_drive_no];

    // drive positions
    this.response_data[0] = this.drives[0].curr_track;
    this.response_data[1] = this.drives[1].curr_track;
    this.response_data[2] = 0;
    this.response_data[3] = 0;
    // timers
    this.response_data[4] = this.step_rate_interval;
    this.response_data[5] = (this.head_load_time << 1) | ((this.dor & DOR_DMAEN) ? 1 : 0);
    this.response_data[6] = curr_drive.max_sect;
    this.response_data[7] = (this.locked ? 0x80 : 0) | (curr_drive.perpendicular << 2);
    this.response_data[8] = this.fdc_config;
    this.response_data[9] = this.precomp_trk;

    // no interrupt
    this.enter_result_phase(10);
};

FloppyController.prototype.exec_version = function(args)
{
    this.response_data[0] = 0x90;   // 0x80: Standard controller, 0x81: Intel 82077, 0x90: Intel 82078

    // no interrupt
    this.enter_result_phase(1);
};

FloppyController.prototype.exec_part_id = function(args)
{
    this.response_data[0] = 0x41;   // Stepping 1 (PS/2 mode)

    // no interrupt
    this.enter_result_phase(1);
};

// ---------------------------------------------------------------------------

FloppyController.prototype.start_read_write = function(args, do_write)
{
    const curr_drive = this.set_curr_drive_no(args[0] & DOR_SELMASK);
    const track = args[1];
    const head = args[2];
    const sect = args[3];
    const ssc = args[4];    // sector size code 0..7 (0:128, 1:256, 2:512, ..., 7:16384 bytes/sect)
    const eot = args[5];    // last sector number of current track
    const dtl = args[7] < 128 ? args[7] : 128;  // data length in bytes if ssc is 0, else unused

    switch(curr_drive.seek(head, track, sect))
    {
    case 2: // error: sect too big
        this.end_read_write(SR0_ABNTERM, 0, 0);
        this.response_data[3] = track;
        this.response_data[4] = head;
        this.response_data[5] = sect;
        return;
    case 3: // error: track too big
        this.end_read_write(SR0_ABNTERM, SR1_EC, 0);
        this.response_data[3] = track;
        this.response_data[4] = head;
        this.response_data[5] = sect;
        return;
    case 1: // track changed
        this.status0 |= SR0_SEEK;
        break;
    }

    const sect_size = 128 << (ssc > 7 ? 7 : ssc);               // sector size in bytes
    const sect_start = curr_drive.chs2lba(track, head, sect);   // linear start sector
    const data_offset = sect_start * sect_size;                 // data offset in bytes
    let data_length;                                            // data length in bytes
    if(sect_size === 128)
    {
        // if requested data length (dtl) is < 128:
        // - READ: return only dtl bytes, skipping the sector's remaining bytes (OK)
        // - WRITE: we must fill the sector's remaining bytes with 0 (TODO!)
        if(do_write && dtl < 128)
        {
            dbg_assert(false, "dtl=" + dtl + " is less than 128, zero-padding is still unimplemented!");
        }
        data_length = dtl;
    }
    else
    {
        if(this.cmd_flags & CMD_FLAG_MULTI_TRACK)
        {
            data_length = (2 * eot - sect + 1) * sect_size;
        }
        else
        {
            data_length = (eot - sect + 1) * sect_size;
        }
        if(data_length <= 0)
        {
            dbg_log("invalid data_length: " + data_length + " sect=" + sect + " eot=" + eot, LOG_FLOPPY);
            this.end_read_write(SR0_ABNTERM, SR1_MA, 0);
            this.response_data[3] = track;
            this.response_data[4] = head;
            this.response_data[5] = sect;
            return;
        }
    }
    this.eot = eot;

    if(DEBUG)
    {
        dbg_log("Floppy " + this.cmd_table[this.cmd_code].name +
            " from: " + h(data_offset) + ", length: " + h(data_length) +
            ", C/H/S: " + track + "/" + head + "/" + sect + ", ro: " + curr_drive.read_only +
            ", #S: " + curr_drive.max_sect + ", #H: " + curr_drive.max_head,
            LOG_FLOPPY);
    }

    if(do_write && curr_drive.read_only)
    {
        this.end_read_write(SR0_ABNTERM | SR0_SEEK, SR1_NW, 0);
        this.response_data[3] = track;
        this.response_data[4] = head;
        this.response_data[5] = sect;
        return;
    }

    if(this.dor & DOR_DMAEN)
    {
        // start DMA transfer
        this.msr &= ~MSR_RQM;
        const do_dma = do_write ? this.dma.do_write : this.dma.do_read;
        do_dma.call(this.dma,
            curr_drive.buffer,
            data_offset,
            data_length,
            FDC_DMA_CHANNEL,
            dma_error => {
                if(dma_error)
                {
                    dbg_log("DMA floppy error", LOG_FLOPPY);
                    this.end_read_write(SR0_ABNTERM, 0, 0);
                }
                else
                {
                    this.seek_next_sect();
                    this.end_read_write(0, 0, 0);
                }
            }
        );
    }
    else
    {
        // start PIO transfer
        dbg_assert(false, this.cmd_table[this.cmd_code].name + " in PIO mode not supported!");
    }
};

FloppyController.prototype.end_read_write = function(status0, status1, status2)
{
    const curr_drive = this.drives[this.curr_drive_no];

    this.status0 &= ~(SR0_DS0 | SR0_DS1 | SR0_HEAD);
    this.status0 |= this.curr_drive_no;
    if(curr_drive.curr_head)
    {
        this.status0 |= SR0_HEAD;
    }
    this.status0 |= status0;

    this.msr |= MSR_RQM | MSR_DIO;
    this.msr &= ~MSR_NDMA;

    this.response_data[0] = this.status0;
    this.response_data[1] = status1;
    this.response_data[2] = status2;
    this.response_data[3] = curr_drive.curr_track;
    this.response_data[4] = curr_drive.curr_head;
    this.response_data[5] = curr_drive.curr_sect;
    this.response_data[6] = SECTOR_SIZE_CODE;

    // raise interrupt
    this.enter_result_phase(7);
    this.raise_irq(this.cmd_table[this.cmd_code].name + " command");
};

FloppyController.prototype.seek_next_sect = function()
{
    // Seek to next sector
    // returns 0 when end of track reached (for DBL_SIDES on head 1). otherwise returns 1
    const curr_drive = this.drives[this.curr_drive_no];

    // XXX: curr_sect >= max_sect should be an error in fact (TODO: this comment comes from qemu, not sure what to make of it)
    let new_track = curr_drive.curr_track;
    let new_head = curr_drive.curr_head;
    let new_sect = curr_drive.curr_sect;
    let ret = 1;

    if(new_sect >= curr_drive.max_sect || new_sect === this.eot)
    {
        new_sect = 1;
        if(this.cmd_flags & CMD_FLAG_MULTI_TRACK)
        {
            if(new_head === 0 && curr_drive.max_head === 2)
            {
                new_head = 1;
            }
            else
            {
                new_head = 0;
                new_track++;
                this.status0 |= SR0_SEEK;
                if(curr_drive.max_head === 1)
                {
                    ret = 0;
                }
            }
        }
        else
        {
            this.status0 |= SR0_SEEK;
            new_track++;
            ret = 0;
        }
    }
    else
    {
        new_sect++;
    }

    curr_drive.seek(new_head, new_track, new_sect);
    return ret;
};

FloppyController.prototype.get_state = function()
{
    // NOTE: Old-style state snapshots (state indices 0..18) did not include
    // the disk image buffer, only a few register states, so a floppy drive
    // remained essentially unchangd when a state snapshot was applied.
    // The snapshotted registers can be safely ignored when restoring state,
    // hence the entire old-style state is now ignored and deprecated.
    const state = [];
    state[19] = this.sra;
    state[20] = this.srb;
    state[21] = this.dor;
    state[22] = this.tdr;
    state[23] = this.msr;
    state[24] = this.dsr;
    state[25] = this.cmd_phase;
    state[26] = this.cmd_code;
    state[27] = this.cmd_flags;
    state[28] = this.cmd_buffer;    // Uint8Array
    state[29] = this.cmd_cursor;
    state[30] = this.cmd_remaining;
    state[31] = this.response_data; // Uint8Array
    state[32] = this.response_cursor;
    state[33] = this.response_length;
    state[34] = this.status0;
    state[35] = this.status1;
    state[36] = this.curr_drive_no;
    state[37] = this.reset_sense_int_count;
    state[38] = this.locked;
    state[39] = this.step_rate_interval;
    state[40] = this.head_load_time;
    state[41] = this.fdc_config;
    state[42] = this.precomp_trk;
    state[43] = this.eot;
    state[44] = this.drives[0].get_state();
    state[45] = this.drives[1].get_state();
    return state;
};

FloppyController.prototype.set_state = function(state)
{
    if(typeof state[19] === "undefined")
    {
        // see comment above in get_state()
        return;
    }
    this.sra = state[19];
    this.srb = state[20];
    this.dor = state[21];
    this.tdr = state[22];
    this.msr = state[23];
    this.dsr = state[24];
    this.cmd_phase = state[25];
    this.cmd_code = state[26];
    this.cmd_flags = state[27];
    this.cmd_buffer.set(state[28]);     // Uint8Array
    this.cmd_cursor = state[29];
    this.cmd_remaining = state[30];
    this.response_data.set(state[31]);  // Uint8Array
    this.response_cursor = state[32];
    this.response_length = state[33];
    this.status0 = state[34];
    this.status1 = state[35];
    this.curr_drive_no = state[36];
    this.reset_sense_int_count = state[37];
    this.locked = state[38];
    this.step_rate_interval = state[39];
    this.head_load_time = state[40];
    this.fdc_config = state[41];
    this.precomp_trk = state[42];
    this.eot = state[43];
    this.drives[0].set_state(state[44]);
    this.drives[1].set_state(state[45]);
};

// class FloppyDrive ---------------------------------------------------------

/**
 * Floppy disk formats
 *
 * In many cases, the total sector count (sectors*tracks*heads) of a format
 * is enough to uniquely identify it. However, there are some total sector
 * collisions between formats of different physical size (drive_type), these
 * are highlighed below in the "collides" column.
 *
 * Matches that are higher up in the table take precedence over later matches.
 *
 * @see {@link https://github.com/qemu/qemu/blob/e240f6cc25917f3138d9e95e0343ae23b63a3f8c/hw/block/fdc.c#L99}
 * @see {@link https://en.wikipedia.org/wiki/List_of_floppy_disk_formats}
 */
const DISK_FORMATS = [
    //                                                                 ttl_sect     size     collides
    // 1.44 MB 3"1/2 floppy disks                                             |     |        |
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 18, tracks: 80, heads: 2 }, // 2880  1.44 MB  3.5"
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 20, tracks: 80, heads: 2 }, // 3200  1.6 MB   3.5"
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 21, tracks: 80, heads: 2 }, // 3360  1.68 MB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 21, tracks: 82, heads: 2 }, // 3444  1.72 MB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 21, tracks: 83, heads: 2 }, // 3486  1.74 MB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 22, tracks: 80, heads: 2 }, // 3520  1.76 MB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 23, tracks: 80, heads: 2 }, // 3680  1.84 MB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 24, tracks: 80, heads: 2 }, // 3840  1.92 MB
    // 2.88 MB 3"1/2 floppy disks
    { drive_type: CMOS_FDD_TYPE_2880, sectors: 36, tracks: 80, heads: 2 }, // 5760  2.88 MB
    { drive_type: CMOS_FDD_TYPE_2880, sectors: 39, tracks: 80, heads: 2 }, // 6240  3.12 MB
    { drive_type: CMOS_FDD_TYPE_2880, sectors: 40, tracks: 80, heads: 2 }, // 6400  3.2 MB
    { drive_type: CMOS_FDD_TYPE_2880, sectors: 44, tracks: 80, heads: 2 }, // 7040  3.52 MB
    { drive_type: CMOS_FDD_TYPE_2880, sectors: 48, tracks: 80, heads: 2 }, // 7680  3.84 MB
    // 720 kB 3"1/2 floppy disks
    { drive_type: CMOS_FDD_TYPE_1440, sectors:  8, tracks: 80, heads: 2 }, // 1280  640 kB
    { drive_type: CMOS_FDD_TYPE_1440, sectors:  9, tracks: 80, heads: 2 }, // 1440  720 kB   3.5"
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 10, tracks: 80, heads: 2 }, // 1600  800 kB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 10, tracks: 82, heads: 2 }, // 1640  820 kB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 10, tracks: 83, heads: 2 }, // 1660  830 kB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 13, tracks: 80, heads: 2 }, // 2080  1.04 MB
    { drive_type: CMOS_FDD_TYPE_1440, sectors: 14, tracks: 80, heads: 2 }, // 2240  1.12 MB
    // 1.2 MB 5"1/4 floppy disks
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 15, tracks: 80, heads: 2 }, // 2400  1.2 MB
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 18, tracks: 80, heads: 2 }, // 2880  1.44 MB  5.25"
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 18, tracks: 82, heads: 2 }, // 2952  1.48 MB
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 18, tracks: 83, heads: 2 }, // 2988  1.49 MB
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 20, tracks: 80, heads: 2 }, // 3200  1.6 MB   5.25"
    // 720 kB 5"1/4 floppy disks
    { drive_type: CMOS_FDD_TYPE_1200, sectors:  9, tracks: 80, heads: 2 }, // 1440  720 kB   5.25"
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 11, tracks: 80, heads: 2 }, // 1760  880 kB
    // 360 kB 5"1/4 floppy disks
    { drive_type: CMOS_FDD_TYPE_1200, sectors:  9, tracks: 40, heads: 2 }, // 720   360 kB   5.25"
    { drive_type: CMOS_FDD_TYPE_1200, sectors:  9, tracks: 40, heads: 1 }, // 360   180 kB
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 10, tracks: 41, heads: 2 }, // 820   410 kB
    { drive_type: CMOS_FDD_TYPE_1200, sectors: 10, tracks: 42, heads: 2 }, // 840   420 kB
    // 320 kB 5"1/4 floppy disks
    { drive_type: CMOS_FDD_TYPE_1200, sectors:  8, tracks: 40, heads: 2 }, // 640   320 kB
    { drive_type: CMOS_FDD_TYPE_1200, sectors:  8, tracks: 40, heads: 1 }, // 320   160 kB
    // 360 kB must match 5"1/4 better than 3"1/2...
    { drive_type: CMOS_FDD_TYPE_1440, sectors:  9, tracks: 80, heads: 1 }, // 720   360 kB   3.5"
    // types defined in earlier v86 releases (not defined in qemu)
    { drive_type: CMOS_FDD_TYPE_360,  sectors: 10, tracks: 40, heads: 1 }, // 400   200 kB
    { drive_type: CMOS_FDD_TYPE_360,  sectors: 10, tracks: 40, heads: 2 }, // 800   400 kB
];

/**
 * @constructor
 *
 * @param {string} name
 * @param {Object|undefined} fdd_config
 * @param {SyncBuffer|Uint8Array|null|undefined} buffer
 * @param {number} fallback_drive_type
 */
function FloppyDrive(name, fdd_config, buffer, fallback_drive_type)
{
    /** @const */
    this.name = name;

    // drive state
    this.drive_type = CMOS_FDD_TYPE_NO_DRIVE;

    // disk state
    this.max_track = 0;     // disk's max. track, was: FloppyController.number_of_cylinders (qemu: max_track)
    this.max_head = 0;      // disk's max. head (1 or 2), was: FloppyController.number_of_heads
    this.max_sect = 0;      // disk's max. sect, was: FloppyController.sectors_per_track (qemu: last_sect)
    this.curr_track = 0;    // >= 0, was: FloppyController.last_cylinder (qemu: track)
    this.curr_head = 0;     // 0 or 1, was: FloppyController.last_head (qemu: head)
    this.curr_sect = 1;     // > 0, was: FloppyController.last_sector (qemu: sect)
    this.perpendicular = 0;
    this.read_only = false;
    this.media_changed = true;
    this.buffer = null;

    Object.seal(this);

    // Drive type this.drive_type is either (in this order):
    // - specified in fdd_config.drive_type (if defined),
    // - derived from given image buffer (if provided), or
    // - specfied in fallback_drive_type.
    // If buffer is undefined and fdd_config.drive_type is
    // CMOS_FDD_TYPE_NO_DRIVE then the drive will be invisible to the guest.
    const cfg_drive_type = fdd_config?.drive_type;
    if(cfg_drive_type !== undefined && cfg_drive_type >= 0 && cfg_drive_type <= 5)
    {
        this.drive_type = cfg_drive_type;
    }

    this.insert_disk(buffer, !! fdd_config?.read_only);

    if(this.drive_type === CMOS_FDD_TYPE_NO_DRIVE && cfg_drive_type === undefined)
    {
        this.drive_type = fallback_drive_type;
    }

    dbg_log("floppy drive " + this.name + " ready, drive type: " + this.drive_type, LOG_FLOPPY);
}

/**
 * Insert disk image into floppy drive.
 *
 * @param {SyncBuffer|Uint8Array|null|undefined} buffer
 * @param {boolean=} read_only
 * @return {boolean} true if the given buffer was accepted
 */
FloppyDrive.prototype.insert_disk = function(buffer, read_only)
{
    if(!buffer)
    {
        return false;
    }

    if(buffer instanceof Uint8Array)
    {
        buffer = new SyncBuffer(buffer.buffer);
    }

    const [new_buffer, disk_format] = this.find_disk_format(buffer, this.drive_type);
    if(!new_buffer)
    {
        dbg_log("WARNING: disk rejected, no suitable disk format found for image of size " +
            buffer.byteLength + " bytes", LOG_FLOPPY);
        return false;
    }

    this.max_track = disk_format.tracks;
    this.max_head = disk_format.heads;
    this.max_sect = disk_format.sectors;
    this.read_only = !!read_only;
    this.media_changed = true;
    this.buffer = new_buffer;

    if(this.drive_type === CMOS_FDD_TYPE_NO_DRIVE)
    {
        // auto-select drive type once during construction
        this.drive_type = disk_format.drive_type;
    }

    if(DEBUG)
    {
        dbg_log("disk inserted into " + this.name + ": type: " + disk_format.drive_type +
            ", C/H/S: " + disk_format.tracks + "/" + disk_format.heads + "/" +
            disk_format.sectors + ", size: " + new_buffer.byteLength,
            LOG_FLOPPY);
    }
    return true;
};

/**
 * Eject disk from this floppy drive.
 */
FloppyDrive.prototype.eject_disk = function()
{
    this.max_track = 0;
    this.max_head = 0;
    this.max_sect = 0;
    this.media_changed = true;
    this.buffer = null;
};

/**
 * Returns this drive's current image buffer or null if no disk is inserted.
 * @return {Uint8Array|null}
 */
FloppyDrive.prototype.get_buffer = function()
{
    return this.buffer ? this.buffer.buffer : null;
};

/**
 * Map structured C/H/S address to linear block address (LBA).
 * @param {number} track
 * @param {number} head
 * @param {number} sect
 * @return {number} lba the linear block address
 */
FloppyDrive.prototype.chs2lba = function(track, head, sect)
{
    return (track * this.max_head + head) * this.max_sect + sect - 1;
};

/**
 * Find best-matching disk format for the given image buffer.
 *
 * If the given drive_type is CMOS_FDD_TYPE_NO_DRIVE then drive types are
 * ignored and the first matching disk format is selected (auto-detect).
 *
 * If the size of the given buffer does not match any known floppy disk
 * format then the smallest format larger than the image buffer is
 * selected, and buffer is copied into a new, format-sized buffer with
 * trailing zeroes.
 *
 * Returns [null, null] if the given buffer is larger than any known
 * floppy disk format.
 *
 * @param {SyncBuffer} buffer
 * @param {number} drive_type
 * @return [{SyncBuffer|null}, {Object|null}] [buffer, disk_format]
 */
FloppyDrive.prototype.find_disk_format = function(buffer, drive_type)
{
    const autodetect = drive_type === CMOS_FDD_TYPE_NO_DRIVE;
    const buffer_size = buffer.byteLength;

    let preferred_match=-1, medium_match=-1, size_match=-1, nearest_match=-1, nearest_size=-1;
    for(let i = 0; i < DISK_FORMATS.length; i++)
    {
        const disk_format = DISK_FORMATS[i];
        const disk_size = disk_format.sectors * disk_format.tracks * disk_format.heads * SECTOR_SIZE;
        if(buffer_size === disk_size)
        {
            if(autodetect || disk_format.drive_type === drive_type)
            {
                // (1) same size and CMOS drive type
                preferred_match = i;
                break;
            }
            else if(!autodetect && CMOS_FDD_TYPE_MEDIUM[disk_format.drive_type] === CMOS_FDD_TYPE_MEDIUM[drive_type])
            {
                // (2) same size and physical medium size (5"1/4 or 3"1/2)
                medium_match = (medium_match === -1) ? i : medium_match;
            }
            else
            {
                // (3) same size
                size_match = (size_match === -1) ? i : size_match;
            }
        }
        else if(buffer_size < disk_size)
        {
            if(nearest_size === -1 || disk_size < nearest_size)
            {
                // (4) nearest matching size
                nearest_match = i;
                nearest_size = disk_size;
            }
        }
    }

    if(preferred_match !== -1)
    {
        return [buffer, DISK_FORMATS[preferred_match]];
    }
    else if(medium_match !== -1)
    {
        return [buffer, DISK_FORMATS[medium_match]];
    }
    else if(size_match !== -1)
    {
        return [buffer, DISK_FORMATS[size_match]];
    }
    else if(nearest_match !== -1)
    {
        const tmp_buffer = new Uint8Array(nearest_size);
        tmp_buffer.set(new Uint8Array(buffer.buffer));
        return [new SyncBuffer(tmp_buffer.buffer), DISK_FORMATS[nearest_match]];
    }
    else
    {
        return [null, null];
    }
};

/**
 * Seek to a new position, returns:
 *   0 if already on right track
 *   1 if track changed
 *   2 if track is invalid
 *   3 if sector is invalid
 *
 * @param {number} head
 * @param {number} track
 * @param {number} sect
 * @return {number}
 */
FloppyDrive.prototype.seek = function(head, track, sect)
{
    if((track > this.max_track) || (head !== 0 && this.max_head === 1))
    {
        dbg_log("WARNING: attempt to seek to invalid track: head: " + head + ", track: " + track + ", sect: " + sect, LOG_FLOPPY);
        return 2;
    }
    if(sect > this.max_sect)
    {
        dbg_log("WARNING: attempt to seek beyond last sector: " + sect + " (max: " + this.max_sect + ")", LOG_FLOPPY);
        return 3;
    }

    let result = 0;
    const curr_lba = this.chs2lba(this.curr_track, this.curr_head, this.curr_sect);
    const new_lba = this.chs2lba(track, head, sect);
    if(curr_lba !== new_lba)
    {
        if(this.curr_track !== track)
        {
            if(this.buffer)
            {
                this.media_changed = false;
            }
            result = 1;
        }
        this.curr_head = head;
        this.curr_track = track;
        this.curr_sect = sect;
    }

    if(!this.buffer)
    {
        result = 2;
    }

    return result;
};

FloppyDrive.prototype.get_state = function()
{
    const state = [];
    state[0]  = this.drive_type;
    state[1]  = this.max_track;
    state[2]  = this.max_head;
    state[3]  = this.max_sect;
    state[4]  = this.curr_track;
    state[5]  = this.curr_head;
    state[6]  = this.curr_sect;
    state[7]  = this.perpendicular;
    state[8]  = this.read_only;
    state[9]  = this.media_changed;
    state[10] = this.buffer ? this.buffer.get_state() : null;   // SyncBuffer
    return state;
};

FloppyDrive.prototype.set_state = function(state)
{
    this.drive_type = state[0];
    this.max_track = state[1];
    this.max_head = state[2];
    this.max_sect = state[3];
    this.curr_track = state[4];
    this.curr_head = state[5];
    this.curr_sect = state[6];
    this.perpendicular = state[7];
    this.read_only = state[8];
    this.media_changed = state[9];
    if(state[10])
    {
        if(!this.buffer)
        {
            this.buffer = new SyncBuffer(new ArrayBuffer(0));
        }
        this.buffer.set_state(state[10]);
    }
    else
    {
        this.buffer = null;
    }
};
