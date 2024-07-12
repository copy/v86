"use strict";

// https://www.isdaman.com/alsos/hardware/fdc/floppy.htm
// https://wiki.osdev.org/Floppy_Disk_Controller

const DIR_DOOR = 0x80;
const ST1_NID  = 1 << 0;
const ST1_NDAT = 1 << 2;

/**
 * @constructor
 *
 * @param {CPU} cpu
 */
function FloppyController(cpu, fda_image, fdb_image)
{
    /** @const @type {IO|undefined} */
    this.io = cpu.io;

    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {DMA} */
    this.dma = cpu.devices.dma;

    this.bytes_expecting = 0;
    this.receiving_command = new Uint8Array(10);
    this.receiving_index = 0;
    this.next_command = null;

    this.response_data = new Uint8Array(10);
    this.response_index = 0;
    this.response_length = 0;

    this.status_reg0 = 0;
    this.status_reg1 = 0;
    this.status_reg2 = 0;
    this.drive = 0;

    this.last_cylinder = 0;
    this.last_head = 0;
    this.last_sector = 1;

    // this should actually be write-only ... but people read it anyway
    this.dor = 0;
    this.dir = 0;
    this.fda_image = null;
    this.fdb_image = null;

    if(!fda_image)
    {
        this.eject_fda();
        this.cpu.devices.rtc.cmos_write(CMOS_FLOPPY_DRIVE_TYPE, 4 << 4);
    }
    else
    {
        this.set_fda(fda_image);
    }

    dbg_assert(!fdb_image, "FDB not supported");

    this.io.register_read(0x3F0, this, this.port3F0_read);
    this.io.register_read(0x3F2, this, this.port3F2_read);
    this.io.register_read(0x3F4, this, this.port3F4_read);
    this.io.register_read(0x3F5, this, this.port3F5_read);
    this.io.register_read(0x3F7, this, this.port3F7_read);

    this.io.register_write(0x3F2, this, this.port3F2_write);
    this.io.register_write(0x3F4, this, this.port3F4_write);
    this.io.register_write(0x3F5, this, this.port3F5_write);
}

FloppyController.prototype.eject_fda = function()
{
    this.fda_image = null;
    this.sectors_per_track = 0;
    this.number_of_heads = 0;
    this.number_of_cylinders = 0;
    this.dir = DIR_DOOR;
};

FloppyController.prototype.set_fda = function(fda_image)
{
    var floppy_types = {
        [160 * 1024]: { type: 1, tracks: 40, sectors: 8, heads: 1 },
        [180 * 1024]: { type: 1, tracks: 40, sectors: 9, heads: 1 },
        [200 * 1024]: { type: 1, tracks: 40, sectors: 10, heads: 1 },
        [320 * 1024]: { type: 1, tracks: 40, sectors: 8, heads: 2 },
        [360 * 1024]: { type: 1, tracks: 40, sectors: 9, heads: 2 },
        [400 * 1024]: { type: 1, tracks: 40, sectors: 10, heads: 2 },
        [720 * 1024]: { type: 3, tracks: 80, sectors: 9, heads: 2 },
        [1200 * 1024]: { type: 2, tracks: 80, sectors: 15, heads: 2 },
        [1440 * 1024]: { type: 4, tracks: 80, sectors: 18, heads: 2 },
        [1722 * 1024]: { type: 5, tracks: 82, sectors: 21, heads: 2 },
        [2880 * 1024]: { type: 5, tracks: 80, sectors: 36, heads: 2 },

        // not a real floppy type, used to support sectorlisp and friends
        512: { type: 1, tracks: 1, sectors: 1, heads: 1 },
    };

    let floppy_size = fda_image.byteLength;
    let floppy_type = floppy_types[floppy_size];

    if(!floppy_type)
    {
        floppy_size = fda_image.byteLength > 1440 * 1024 ? 2880 * 1024 : 1440 * 1024;
        floppy_type = floppy_types[floppy_size];

        // Note: this may prevent the "Get floppy image" functionality from working
        dbg_assert(fda_image.buffer && fda_image.buffer instanceof ArrayBuffer);
        const new_image = new Uint8Array(floppy_size);
        new_image.set(new Uint8Array(fda_image.buffer));
        fda_image = new v86util.SyncBuffer(new_image.buffer);

        dbg_log("Warning: Unkown floppy size: " + fda_image.byteLength + ", assuming " + floppy_size);
    }

    this.sectors_per_track = floppy_type.sectors;
    this.number_of_heads = floppy_type.heads;
    this.number_of_cylinders = floppy_type.tracks;
    this.fda_image = fda_image;
    this.dir = DIR_DOOR;

    // this is probably not supposed to change at runtime
    this.cpu.devices.rtc.cmos_write(CMOS_FLOPPY_DRIVE_TYPE, floppy_type.type << 4);
};


FloppyController.prototype.get_state = function()
{
    var state = [];

    state[0] = this.bytes_expecting;
    state[1] = this.receiving_command;
    state[2] = this.receiving_index;
    //state[3] = this.next_command;
    state[4] = this.response_data;
    state[5] = this.response_index;
    state[6] = this.response_length;

    state[8] = this.status_reg0;
    state[9] = this.status_reg1;
    state[10] = this.status_reg2;
    state[11] = this.drive;
    state[12] = this.last_cylinder;
    state[13] = this.last_head;
    state[14] = this.last_sector;
    state[15] = this.dor;
    state[16] = this.sectors_per_track;
    state[17] = this.number_of_heads;
    state[18] = this.number_of_cylinders;

    return state;
};

FloppyController.prototype.set_state = function(state)
{
    this.bytes_expecting = state[0];
    this.receiving_command = state[1];
    this.receiving_index = state[2];
    this.next_command = state[3];
    this.response_data = state[4];
    this.response_index = state[5];
    this.response_length = state[6];

    this.status_reg0 = state[8];
    this.status_reg1 = state[9];
    this.status_reg2 = state[10];
    this.drive = state[11];
    this.last_cylinder = state[12];
    this.last_head = state[13];
    this.last_sector = state[14];
    this.dor = state[15];
    this.sectors_per_track = state[16];
    this.number_of_heads = state[17];
    this.number_of_cylinders = state[18];
};

FloppyController.prototype.port3F0_read = function()
{
    dbg_log("3F0 read", LOG_FLOPPY);

    return 0;
};


FloppyController.prototype.port3F4_read = function()
{
    dbg_log("3F4 read", LOG_FLOPPY);

    var return_byte = 0x80;

    if(this.response_index < this.response_length)
    {
        return_byte |= 0x40 | 0x10;
    }

    if((this.dor & 8) === 0)
    {
        return_byte |= 0x20;
    }

    return return_byte;
};

FloppyController.prototype.port3F7_read = function()
{
    dbg_log("3F7 read", LOG_FLOPPY);
    return this.dir;
};

FloppyController.prototype.port3F5_read = function()
{
    if(this.response_index < this.response_length)
    {
        dbg_log("3F5 read: " + this.response_data[this.response_index], LOG_FLOPPY);
        this.cpu.device_lower_irq(6);
        return this.response_data[this.response_index++];
    }
    else
    {
        dbg_log("3F5 read, empty", LOG_FLOPPY);
        return 0xFF;
    }
};

FloppyController.prototype.port3F4_write = function(byte)
{
    dbg_log("3F4/data rate write: " + h(byte), LOG_FLOPPY);

    if(byte & 0x80)
    {
        dbg_log("dsr reset", LOG_FLOPPY);
        this.status_reg0 = 0xC0;
        this.cpu.device_raise_irq(6);
    }
};

FloppyController.prototype.port3F5_write = function(reg_byte)
{
    dbg_log("3F5 write " + h(reg_byte), LOG_FLOPPY);

    if(this.bytes_expecting > 0)
    {
        this.receiving_command[this.receiving_index++] = reg_byte;

        this.bytes_expecting--;

        if(this.bytes_expecting === 0)
        {
            if(DEBUG)
            {
                var log = "3F5 command received: ";
                for(var i = 0; i < this.receiving_index; i++)
                    log += h(this.receiving_command[i]) + " ";
                dbg_log(log, LOG_FLOPPY);
            }
            this.next_command.call(this, this.receiving_command);
        }
    }
    else
    {
        switch(reg_byte)
        {
            // TODO
            //case 2:
                //this.next_command = read_complete_track;
                //this.bytes_expecting = 8;
                //break;
            case 0x03:
                this.next_command = this.fix_drive_data;
                this.bytes_expecting = 2;
                break;
            case 0x13:
                this.next_command = this.configure;
                this.bytes_expecting = 3;
                break;
            case 0x04:
                this.next_command = this.check_drive_status;
                this.bytes_expecting = 1;
                break;
            // writes
            case 0x05:
            case 0x45:
            case 0xC5:
                this.next_command = function(args) { this.do_sector(true, args); };
                this.bytes_expecting = 8;
                break;
            case 0x06:
            case 0x46:
            case 0xC6:
            case 0xE6:
                this.next_command = function(args) { this.do_sector(false, args); };
                this.bytes_expecting = 8;
                break;
            case 0x07:
                this.next_command = this.calibrate;
                this.bytes_expecting = 1;
                break;
            case 0x08:
                this.check_interrupt_status();
                break;
            case 0x4A:
                this.next_command = this.read_sector_id;
                this.bytes_expecting = 1;
                break;
            case 0x0F:
                this.bytes_expecting = 2;
                this.next_command = this.seek;
                break;
            case 0x0E: // dump registers (not implemented)
            case 0x10: // determine controller version (winxp, not implemented)
                dbg_log(reg_byte === 0x0E ? "dump registers" : "determine controller version", LOG_FLOPPY);
                this.status_reg0 = 0x80;
                this.response_data[0] = this.status_reg0;
                this.response_index = 0;
                this.response_length = 1;
                this.bytes_expecting = 0;
                break;
            default:
                dbg_assert(false, "Unimplemented floppy command call " + h(reg_byte));
        }

        this.receiving_index = 0;
    }
};

FloppyController.prototype.port3F2_read = function()
{
    dbg_log("read 3F2: DOR", LOG_FLOPPY);
    return this.dor;
};

FloppyController.prototype.port3F2_write = function(value)
{
    if((value & 4) === 4 && (this.dor & 4) === 0)
    {
        // clear reset mode
        this.status_reg0 = 0xC0;
        this.cpu.device_raise_irq(6);
    }

    dbg_log("start motors: " + h(value >> 4), LOG_FLOPPY);
    dbg_log("enable dma/irq: " + !!(value & 8), LOG_FLOPPY);
    dbg_log("reset fdc: " + !!(value & 4), LOG_FLOPPY);
    dbg_log("drive select: " + (value & 3), LOG_FLOPPY);
    if((value & 3) !== 0)
    {
        dbg_log("guest: fdb not implemented", LOG_FLOPPY);
    }
    dbg_log("DOR = " + h(value), LOG_FLOPPY);

    this.dor = value;
};

FloppyController.prototype.check_drive_status = function(args)
{
    dbg_log("check drive status", LOG_FLOPPY);
    // do nothing if no fda
    if(this.fda_image)
    {
        this.status_reg1 = 0;
    }
    else
    {
        // TODO: is this right?
        this.status_reg1 = ST1_NDAT | ST1_NID;
    }

    this.response_index = 0;
    this.response_length = 1;
    this.response_data[0] = 0;
};

FloppyController.prototype.seek = function(args)
{
    dbg_log("seek", LOG_FLOPPY);
    if((args[0] & 3) !== 0)
    {
        dbg_log("seek on fdb", LOG_FLOPPY);
        this.raise_irq();
        return;
    }

    const new_cylinder = args[1];
    const new_head = args[0] >> 2 & 1;

    // clear eject flag if seek takes us to a new cylinder
    if(new_cylinder !== this.last_cylinder)
    {
        this.dir = 0x0;
    }
    // do nothing if no fda
    if(this.fda_image)
    {
        this.status_reg1 = 0;
    }
    else
    {
        // TODO: is this right?
        this.status_reg1 = ST1_NDAT | ST1_NID;
    }

    this.status_reg0 = 0x20;
    this.last_cylinder = new_cylinder;
    this.last_head = new_head;

    this.raise_irq();
};

FloppyController.prototype.calibrate = function(args)
{
    // TODO fdb support: args[0] indicates which drive
    dbg_log("floppy calibrate", LOG_FLOPPY);
    // This is implemented using seek to make sure last_cylinder, dir, etc are updated properly.
    this.seek([args[0], 0]);
};

FloppyController.prototype.check_interrupt_status = function()
{
    dbg_log("floppy check interrupt status", LOG_FLOPPY);

    this.response_index = 0;
    this.response_length = 2;

    this.response_data[0] = this.status_reg0;
    this.response_data[1] = this.last_cylinder;
};

FloppyController.prototype.do_sector = function(is_write, args)
{
    var head = args[2],
        cylinder = args[1],
        sector = args[3],
        sector_size = 128 << args[4],
        read_count = args[5] - args[3] + 1,

        read_offset = ((head + this.number_of_heads * cylinder) * this.sectors_per_track + sector - 1) * sector_size;

    dbg_log("Floppy " + (is_write ? "Write" : "Read"), LOG_FLOPPY);
    dbg_log("from " + h(read_offset) + " length " + h(read_count * sector_size), LOG_FLOPPY);
    dbg_log(cylinder + " / " + head + " / " + sector, LOG_FLOPPY);

    if(!args[4])
    {
        dbg_log("FDC: sector count is zero, use data length instead", LOG_FLOPPY);
    }

    if(!this.fda_image)
    {
        this.status_reg1 = ST1_NDAT | ST1_NID;
        return;
    }
    this.status_reg1 = 0;

    if(is_write)
    {
        this.dma.do_write(this.fda_image, read_offset, read_count * sector_size, 2, this.done.bind(this, args, cylinder, head, sector));
    }
    else
    {
        this.dma.do_read(this.fda_image, read_offset, read_count * sector_size, 2, this.done.bind(this, args, cylinder, head, sector));
    }
};

FloppyController.prototype.done = function(args, cylinder, head, sector, error)
{
    if(error)
    {
        // TODO: Set appropriate bits
        dbg_log("XXX: Unhandled floppy error", LOG_FLOPPY);
        return;
    }

    sector++;

    if(sector > this.sectors_per_track)
    {
        sector = 1;
        head++;

        if(head >= this.number_of_heads)
        {
            head = 0;
            cylinder++;
        }
    }

    // clear eject flag if seek or write has taken us to a new cylinder
    if(cylinder !== this.last_cylinder)
    {
        this.dir = 0x0;
    }

    this.status_reg0 = 0x20;
    this.last_cylinder = cylinder;
    this.last_head = head;
    this.last_sector = sector;

    this.response_index = 0;
    this.response_length = 7;

    this.response_data[0] = head << 2 | 0x20;
    this.response_data[1] = 0;
    this.response_data[2] = 0;
    this.response_data[3] = cylinder;
    this.response_data[4] = head;
    this.response_data[5] = sector;
    this.response_data[6] = args[4];

    this.raise_irq();
};

FloppyController.prototype.fix_drive_data = function(args)
{
    dbg_log("floppy fix drive data " + args.slice(0, this.bytes_expecting), LOG_FLOPPY);
};

FloppyController.prototype.configure = function(args)
{
    dbg_log("floppy configure " + args.slice(0, this.bytes_expecting), LOG_FLOPPY);
};

FloppyController.prototype.read_sector_id = function(args)
{
    dbg_log("floppy read sector id " + args, LOG_FLOPPY);

    this.response_index = 0;
    this.response_length = 7;

    this.response_data[0] = 0;
    this.response_data[1] = 0;
    this.response_data[2] = 0;
    this.response_data[3] = 0;
    this.response_data[4] = 0;
    this.response_data[5] = 0;
    this.response_data[6] = 0;

    this.raise_irq();
};

FloppyController.prototype.raise_irq = function()
{
    if(this.dor & 8)
    {
        this.cpu.device_raise_irq(6);
    }
};
