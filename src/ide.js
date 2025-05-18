import { LOG_DISK } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { CMOS_BIOS_DISKTRANSFLAG, CMOS_DISK_DATA, CMOS_DISK_DRIVE1_CYL, CMOS_DISK_DRIVE2_CYL } from "./rtc.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

// ATA/ATAPI-6 IDE Controller
//
// References
// - [ATA-6]
//   AT Attachment with Packet Interface - 6 (ATA/ATAPI-6) (Rev. 3a; Dec. 14, 2001)
//   https://technion-csl.github.io/ose/readings/hardware/ATA-d1410r3a.pdf
// - [CD-SCSI-2]
//   PROPOSAL FOR CD-ROM IN SCSI-2 (X3T9.2/87) (Rev. 0, Jun. 30, 1987)
//   https://www.t10.org/ftp/x3t9.2/document.87/87-106r0.txt
//   https://www.t10.org/ftp/x3t9.2/document.87/87-106r1.txt (errata to r0)
// - [MMC-2]
//   Packet Commands for C/DVD Devices (1997)
//   https://www.t10.org/ftp/t10/document.97/97-108r0.pdf

const CDROM_SECTOR_SIZE = 2048;
const HD_SECTOR_SIZE = 512;

// Per-channel PIO register offsets, legend:
//   (*1*) Control block register (BAR1/3), else: Command block register (BAR0/2)
//
// Read-only registers:
const ATA_REG_ERROR      = 0x01;  // Error register, see [ATA-6] 7.9
const ATA_REG_STATUS     = 0x07;  // Status register, see [ATA-6] 7.15
const ATA_REG_ALT_STATUS = 0x02;  // (*1*) Alternate Status register, see [ATA-6] 7.3
// Read-/writable registers:
const ATA_REG_DATA       = 0x00;  // Data register, see [ATA-6] 7.6
const ATA_REG_SECTOR     = 0x02;  // Sector Count register, see [ATA-6] 7.14
const ATA_REG_LBA_LOW    = 0x03;  // LBA Low register, see [ATA-6] 7.12
const ATA_REG_LBA_MID    = 0x04;  // LBA Mid register, see [ATA-6] 7.13
const ATA_REG_LBA_HIGH   = 0x05;  // LBA High register, see [ATA-6] 7.11
const ATA_REG_DEVICE     = 0x06;  // Device register, see [ATA-6] 7.7
// Write-only registers:
const ATA_REG_FEATURES   = 0x01;  // Features register, see [ATA-6] 7.10
const ATA_REG_COMMAND    = 0x07;  // Command register, see [ATA-6] 7.4
const ATA_REG_CONTROL    = 0x02;  // (*1*) Device Control register, see [ATA-6] 7.8

// Error register bits:
// All bits except for bit 0x04 are command dependent.
const ATA_ER_ABRT = 0x04;  // Command aborted

// Status register bits:
// Bits 0x02/0x04 are obsolete and 0x10/0x20 are command dependent.
// Bit 0x02 used to be called "Index" (IDX), bit 0x04 "Corrected data" (CORR),
// bit 0x10 "Drive seek complete" (DSC), and bit 0x20 "Drive write fault" (DF).
// NOTE:
//   This code uses ATA_SR_DSC in the old style, this is either unneccessary
//   or means that this code was originally not based on ATA/ATAPI-6 but an
//   older release (ATA/ATAPI-4 or even older).
const ATA_SR_ERR  = 0x01;  // Error
const ATA_SR_DRQ  = 0x08;  // Data request ready
const ATA_SR_DSC  = 0x10;  // Drive seek complete
const ATA_SR_DRDY = 0x40;  // Drive ready
const ATA_SR_BSY  = 0x80;  // Busy

// Device register bits:
// Bits 0x20/0x80 are obsolete and 0x01/0x02/0x04/0x08/0x40 are command dependent.
const ATA_DR_DEV  = 0x10;  // Device select; slave device if set, else master device

// Device Control register bits:
// Bits 0x08/0x10/0x20/0x40 are reserved and bit 0x01 is always zero.
const ATA_CR_nIEN = 0x02;  // Interrupt disable (not Interrupt ENable)
const ATA_CR_SRST = 0x04;  // Software reset
const ATA_CR_HOB  = 0x80;  // 48-bit Address feature set

// ATA commands
const ATA_CMD_DEVICE_RESET = 0x08;                    // see [ATA-6] 8.10 and 9.11
const ATA_CMD_EXECUTE_DEVICE_DIAGNOSTIC = 0x90;       // see [ATA-6] 8.11
const ATA_CMD_FLUSH_CACHE = 0xE7;                     // see [ATA-6] 8.12
const ATA_CMD_FLUSH_CACHE_EXT = 0xEA;                 // see [ATA-6] 8.13
const ATA_CMD_GET_MEDIA_STATUS = 0xDA;                // see [ATA-6] 8.14
const ATA_CMD_IDENTIFY_DEVICE = 0xEC;                 // see [ATA-6] 8.15
const ATA_CMD_IDENTIFY_PACKET_DEVICE = 0xA1;          // see [ATA-6] 8.16
const ATA_CMD_IDLE_IMMEDIATE = 0xE1;                  // see [ATA-6] 8.18
const ATA_CMD_INITIALIZE_DEVICE_PARAMETERS = 0x91;    // not mentioned in [ATA-6]
const ATA_CMD_MEDIA_LOCK = 0xDE;                      // see [ATA-6] 8.20
const ATA_CMD_PACKET = 0xA0;                          // see [ATA-6] 8.23
const ATA_CMD_READ_DMA = 0xC8;                        // see [ATA-6] 8.26
const ATA_CMD_READ_DMA_EXT = 0x25;                    // see [ATA-6] 8.25
const ATA_CMD_READ_MULTIPLE = 0x29;                   // see [ATA-6] 8.30
const ATA_CMD_READ_MULTIPLE_EXT = 0xC4;               // see [ATA-6] 8.31
const ATA_CMD_READ_NATIVE_MAX_ADDRESS = 0xF8;         // see [ATA-6] 8.32
const ATA_CMD_READ_NATIVE_MAX_ADDRESS_EXT = 0x27;     // see [ATA-6] 8.33
const ATA_CMD_READ_SECTORS = 0x20;                    // see [ATA-6] 8.34
const ATA_CMD_READ_SECTORS_EXT = 0x24;                // see [ATA-6] 8.35
const ATA_CMD_READ_VERIFY_SECTORS = 0x40;             // see [ATA-6] 8.36
const ATA_CMD_SECURITY_FREEZE_LOCK = 0xF5;            // see [ATA-6] 8.41
const ATA_CMD_SET_FEATURES = 0xEF;                    // see [ATA-6] 8.46
const ATA_CMD_SET_MAX = 0xF9;                         // see [ATA-6] 8.47
const ATA_CMD_SET_MULTIPLE_MODE = 0xC6;               // see [ATA-6] 8.49
const ATA_CMD_STANDBY_IMMEDIATE = 0xE0;               // see [ATA-6] 8.53
const ATA_CMD_WRITE_DMA = 0xCA;                       // see [ATA-6] 8.55
const ATA_CMD_WRITE_DMA_EXT = 0x35;                   // see [ATA-6] 8.56
const ATA_CMD_WRITE_MULTIPLE = 0x39;                  // see [ATA-6] 8.60
const ATA_CMD_WRITE_MULTIPLE_EXT = 0xC5;              // see [ATA-6] 8.61
const ATA_CMD_WRITE_SECTORS = 0x30;                   // see [ATA-6] 8.62
const ATA_CMD_WRITE_SECTORS_EXT = 0x34;               // see [ATA-6] 8.63
const ATA_CMD_10h = 0x10;                             // command obsolete/unknown, see [ATA-6] Table E.2

// ATAPI (SCSI-2/MMC-2) commands
const ATAPI_CMD_GET_CONFIGURATION = 0x46;             // see [CD-SCSI-2]
const ATAPI_CMD_GET_EVENT_STATUS_NOTIFICATION = 0x4A; // see [MMC-2] 9.1.2
const ATAPI_CMD_INQUIRY = 0x12;                       // see [MMC-2] 9.1.3
//const ATAPI_CMD_LOAD_UNLOAD_MEDIUM = 0xA6;          // see [MMC-2] 9.1.4 -- TODO: not implemented, might be useful
const ATAPI_CMD_MECHANISM_STATUS = 0xBD;              // see [MMC-2] 9.1.5
const ATAPI_CMD_MODE_SENSE_6 = 0x1A;                  // see [CD-SCSI-2]
const ATAPI_CMD_MODE_SENSE_10 = 0x5A;                 // see [MMC-2] 9.1.7
const ATAPI_CMD_PREVENT_ALLOW_MEDIUM_REMOVAL = 0x1E;  // see [MMC-2] 9.1.9
const ATAPI_CMD_READ = 0x28;                          // see [CD-SCSI-2]
const ATAPI_CMD_READ_CAPACITY = 0x25;                 // see [MMC-2] 9.1.12
const ATAPI_CMD_READ_CD = 0xBE;                       // see [CD-SCSI-2]
const ATAPI_CMD_READ_DISK_INFORMATION = 0x51;         // see [CD-SCSI-2]
const ATAPI_CMD_READ_SUBCHANNEL = 0x42;               // see [CD-SCSI-2]
const ATAPI_CMD_READ_TOC_PMA_ATIP = 0x43;             // see [CD-SCSI-2]
const ATAPI_CMD_READ_TRACK_INFORMATION = 0x52;        // see [CD-SCSI-2]
const ATAPI_CMD_REQUEST_SENSE = 0x03;                 // see [MMC-2] 9.1.18
const ATAPI_CMD_TEST_UNIT_READY = 0x00;               // see [MMC-2] 9.1.20

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 *
 * ide_config: [ [primary-master, primary-slave], [secondary-master, secondary-slave] ]
 *
 *   Each of the four arguments (primary-master, primary-slave, ...) is either
 *   undefined or an object of the form:
 *
 *       { buffer: Uint8Array, is_cdrom: bool }
 *
 *   If is_cdrom is defined and true:
 *   - If buffer is defined: create an ATAPI CD-ROM device using buffer as inserted disk
 *   - If buffer is undefined: create an ATAPI CD-ROM device with ejectd disk
 *   If is_cdrom is undefined or false:
 *   - If buffer is defined: create an ATA Hard-Disk device using buffer as disk image
 *   - If buffer is undefined: represents a missing device
 *
 *   A slave drive can only exist if a master drive also exists.
 * */
export function IDEController(cpu, bus, ide_config)
{
    this.cpu = cpu;
    this.bus = bus;
    this.primary = undefined;
    this.secondary = undefined;
    this.channels = [undefined, undefined];

    const has_primary = ide_config && ide_config[0][0];
    const has_secondary = ide_config && ide_config[1][0];
    if(has_primary || has_secondary)
    {
        const bus_master_base = 0xB400;
        if(has_primary)
        {
            this.primary = new IDEChannel(this, 0, ide_config[0], {
                command_base: 0x1f0, control_base: 0x3f4, bus_master_base: bus_master_base, irq: 14
            });
            this.channels[0] = this.primary;
        }
        if(has_secondary)
        {
            this.secondary = new IDEChannel(this, 1, ide_config[1], {
                command_base: 0x170, control_base: 0x374, bus_master_base: bus_master_base + 8, irq: 15
            });
            this.channels[1] = this.secondary;
        }

        const vendor_id = 0x8086;    // Intel Corporation
        const device_id = 0x7010;    // 82371SB PIIX3 IDE [Natoma/Triton II]
        const class_code = 0x01;     // Mass Storage Controller
        const subclass = 0x01;       // IDE Controller
        const prog_if = 0x80;        // ISA Compatibility mode-only controller, supports bus mastering
        const interrupt_line = 0x00; // IRQs 14 and 15 are predefined in Compatibility mode and this field is ignored
        const command_base0 = has_primary ? this.primary.command_base : 0;
        const control_base0 = has_primary ? this.primary.control_base : 0;
        const command_base1 = has_secondary ? this.secondary.command_base : 0;
        const control_base1 = has_secondary ? this.secondary.control_base : 0;

        this.pci_id = 0x1F << 3;
        this.pci_space = [
            vendor_id & 0xFF, vendor_id >> 8, device_id & 0xFF, device_id >> 8, 0x05, 0x00, 0xA0, 0x02,
            0x00, prog_if, subclass, class_code, 0x00, 0x00, 0x00, 0x00,
            command_base0 & 0xFF   | 1, command_base0 >> 8,   0x00, 0x00,
            control_base0 & 0xFF   | 1, control_base0 >> 8,   0x00, 0x00,
            command_base1 & 0xFF   | 1, command_base1 >> 8,   0x00, 0x00,
            control_base1 & 0xFF   | 1, control_base1 >> 8,   0x00, 0x00,
            bus_master_base & 0xFF | 1, bus_master_base >> 8, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x43, 0x10, 0xD4, 0x82,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, interrupt_line, 0x01, 0x00, 0x00,
            // 0x40
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            // 0x80
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        this.pci_bars = [
            has_primary ? { size: 8 } : undefined,   // BAR0: Command block register address of primary channel
            has_primary ? { size: 4 } : undefined,   // BAR1: Control block register address of primary channel
            has_secondary ? { size: 8 } : undefined, // BAR2: Command block register address of secondary channel
            has_secondary ? { size: 4 } : undefined, // BAR3: Control block register address of secondary channel
            { size: 16 }                             // BAR4: Bus Master I/O register address of both channels (8+8)
        ];
        cpu.devices.pci.register_device(this);
    }

    Object.seal(this);
}

/**
 * @constructor
 * @param {IDEController} controller
 * @param {number} channel_nr
 * */
function IDEChannel(controller, channel_nr, channel_config, hw_settings)
{
    this.controller = controller;
    this.cpu = controller.cpu;
    this.bus = controller.bus;
    this.command_base = hw_settings.command_base;
    this.control_base = hw_settings.control_base;
    this.irq = hw_settings.irq;
    this.name = "ide" + channel_nr;

    const create_interface = interface_nr => {
        const config = channel_config ? channel_config[interface_nr] : undefined;
        const buffer = config ? config.buffer : undefined;
        const is_cdrom = config ? !!config.is_cdrom : false;
        return new IDEInterface(this, this.cpu, buffer, is_cdrom, channel_nr, interface_nr, this.bus);
    };

    this.master = create_interface(0);
    this.slave = create_interface(1);
    this.interfaces = [this.master, this.slave];
    this.current_interface = this.master;

    this.master.init_interface();
    this.slave.init_interface();

    /** @type {number} */
    this.device_control_reg = ATA_CR_nIEN;

    /** @type {number} */
    this.prdt_addr = 0;

    /** @type {number} */
    this.dma_status = 0;

    /** @type {number} */
    this.dma_command = 0;

    const cpu = controller.cpu;

    //
    // Command Block Registers: command_base + 0...7 (BAR0: 1F0h, BAR2: 170h)
    //

    // read Data register
    cpu.io.register_read(this.command_base | ATA_REG_DATA, this, function()
    {
        return this.current_interface.read_data(1);
    }, function()
    {
        return this.current_interface.read_data(2);
    }, function()
    {
        return this.current_interface.read_data(4);
    });

    cpu.io.register_read(this.command_base | ATA_REG_ERROR, this, function()
    {
        dbg_log(this.current_interface.name + ": read Error register: " +
            h(this.current_interface.error_reg & 0xFF) + " slave=" +
            (this.current_interface === this.slave), LOG_DISK);
        return this.current_interface.error_reg & 0xFF;
    });

    cpu.io.register_read(this.command_base | ATA_REG_SECTOR, this, function()
    {
        dbg_log(this.current_interface.name + ": read Sector Count register: " +
            h(this.current_interface.sector_count_reg & 0xFF), LOG_DISK);
        return this.current_interface.sector_count_reg & 0xFF;
    });

    cpu.io.register_read(this.command_base | ATA_REG_LBA_LOW, this, function()
    {
        dbg_log(this.current_interface.name + ": read LBA Low register: " +
            h(this.current_interface.lba_low_reg & 0xFF), LOG_DISK);
        return this.current_interface.lba_low_reg & 0xFF;
    });

    cpu.io.register_read(this.command_base | ATA_REG_LBA_MID, this, function()
    {
        dbg_log(this.current_interface.name + ": read LBA Mid register: " +
            h(this.current_interface.lba_mid_reg & 0xFF), LOG_DISK);
        return this.current_interface.lba_mid_reg & 0xFF;
    });

    cpu.io.register_read(this.command_base | ATA_REG_LBA_HIGH, this, function()
    {
        dbg_log(this.current_interface.name + ": read LBA High register: " +
            h(this.current_interface.lba_high_reg & 0xFF), LOG_DISK);
        return this.current_interface.lba_high_reg & 0xFF;
    });

    cpu.io.register_read(this.command_base | ATA_REG_DEVICE, this, function()
    {
        dbg_log(this.current_interface.name + ": read Device register", LOG_DISK);
        return this.current_interface.device_reg & 0xFF;
    });

    cpu.io.register_read(this.command_base | ATA_REG_STATUS, this, function()
    {
        dbg_log(this.current_interface.name + ": read Status register", LOG_DISK);
        dbg_log(this.current_interface.name + ": lower IRQ " + this.irq, LOG_DISK);
        this.cpu.device_lower_irq(this.irq);
        return this.read_status();
    });

    cpu.io.register_write(this.command_base | ATA_REG_DATA, this, function(data)
    {
        this.current_interface.write_data_port8(data);
    }, function(data)
    {
        this.current_interface.write_data_port16(data);
    }, function(data)
    {
        this.current_interface.write_data_port32(data);
    });

    cpu.io.register_write(this.command_base | ATA_REG_FEATURES, this, function(data)
    {
        dbg_log(this.current_interface.name + ": write Features register: " + h(data), LOG_DISK);
        this.current_interface.features_reg = (this.current_interface.features_reg << 8 | data) & 0xFFFF;
    });

    cpu.io.register_write(this.command_base | ATA_REG_SECTOR, this, function(data)
    {
        dbg_log(this.current_interface.name + ": write Sector Count register: " + h(data), LOG_DISK);
        this.current_interface.sector_count_reg = (this.current_interface.sector_count_reg << 8 | data) & 0xFFFF;
    });

    cpu.io.register_write(this.command_base | ATA_REG_LBA_LOW, this, function(data)
    {
        dbg_log(this.current_interface.name + ": write LBA Low register: " + h(data), LOG_DISK);
        this.current_interface.lba_low_reg = (this.current_interface.lba_low_reg << 8 | data) & 0xFFFF;
    });

    cpu.io.register_write(this.command_base | ATA_REG_LBA_MID, this, function(data)
    {
        dbg_log(this.current_interface.name + ": write LBA Mid register: " + h(data), LOG_DISK);
        this.current_interface.lba_mid_reg = (this.current_interface.lba_mid_reg << 8 | data) & 0xFFFF;
    });

    cpu.io.register_write(this.command_base | ATA_REG_LBA_HIGH, this, function(data)
    {
        dbg_log(this.current_interface.name + ": write LBA High register: " + h(data), LOG_DISK);
        this.current_interface.lba_high_reg = (this.current_interface.lba_high_reg << 8 | data) & 0xFFFF;
    });

    cpu.io.register_write(this.command_base | ATA_REG_DEVICE, this, function(data)
    {
        const slave = data & 0x10;
        dbg_log(this.current_interface.name + ": write Device register: " + h(data, 2), LOG_DISK);
        if((slave && this.current_interface === this.master) || (!slave && this.current_interface === this.slave))
        {
            if(slave)
            {
                dbg_log(this.current_interface.name + ": select slave device", LOG_DISK);
                this.current_interface = this.slave;
            }
            else
            {
                dbg_log(this.current_interface.name + ": select master device", LOG_DISK);
                this.current_interface = this.master;
            }
        }
        this.current_interface.device_reg = data;
        this.current_interface.is_lba = data >> 6 & 1;
        this.current_interface.head = data & 0xF;
    });

    cpu.io.register_write(this.command_base | ATA_REG_COMMAND, this, function(data)
    {
        dbg_log(this.current_interface.name + ": write Command register", LOG_DISK);
        dbg_log(this.current_interface.name + ": lower IRQ " + this.irq, LOG_DISK);
        this.current_interface.status_reg &= ~(ATA_SR_ERR | 0x20);  // 0x20: command dependent, used to be Drive write fault (DF)
        this.current_interface.ata_command(data);
        this.cpu.device_lower_irq(this.irq);
    });

    //
    // Control Block Register: control_base + 0...3 (BAR1: 3F4h, BAR3: 374h)
    //

    // read Alternate Status register
    cpu.io.register_read(this.control_base | ATA_REG_ALT_STATUS, this, this.read_status);

    // write Device Control register
    cpu.io.register_write(this.control_base | ATA_REG_CONTROL, this, this.write_control);

    //
    // Bus Master Registers: bus_master_base + 0...15 (BAR4: B400h, lower 8 for primary and upper 8 for secondary channel)
    //

    const bus_master_base = hw_settings.bus_master_base;

    cpu.io.register_read(bus_master_base, this,
                         this.dma_read_command8, undefined, this.dma_read_command);
    cpu.io.register_write(bus_master_base, this,
                          this.dma_write_command8, undefined, this.dma_write_command);

    cpu.io.register_read(bus_master_base | 2, this, this.dma_read_status);
    cpu.io.register_write(bus_master_base | 2, this, this.dma_write_status);

    cpu.io.register_read(bus_master_base | 4, this, undefined, undefined, this.dma_read_addr);
    cpu.io.register_write(bus_master_base | 4, this, undefined, undefined, this.dma_set_addr);

    DEBUG && Object.seal(this);
}

IDEChannel.prototype.read_status = function()
{
    const ret = this.current_interface.drive_connected ? this.current_interface.status_reg : 0;
    dbg_log(this.current_interface.name + ": ATA read status: " + h(ret, 2), LOG_DISK);
    return ret;
};

IDEChannel.prototype.write_control = function(data)
{
    dbg_log(this.current_interface.name + ": write Device Control register: " +
        h(data, 2) + " interrupts " + ((data & ATA_CR_nIEN) ? "disabled" : "enabled"), LOG_DISK);
    if(data & ATA_CR_SRST)
    {
        dbg_log(this.current_interface.name + ": soft reset via control port", LOG_DISK);
        dbg_log(this.current_interface.name + ": lower IRQ " + this.irq, LOG_DISK);
        this.cpu.device_lower_irq(this.irq);
        this.master.device_reset();
        this.slave.device_reset();
    }
    this.device_control_reg = data;
};

IDEChannel.prototype.dma_read_addr = function()
{
    dbg_log(this.current_interface.name + ": DMA get address: " + h(this.prdt_addr, 8), LOG_DISK);
    return this.prdt_addr;
};

IDEChannel.prototype.dma_set_addr = function(data)
{
    dbg_log(this.current_interface.name + ": DMA set address: " + h(data, 8), LOG_DISK);
    this.prdt_addr = data;
};

IDEChannel.prototype.dma_read_status = function()
{
    dbg_log(this.current_interface.name + ": DMA read status: " + h(this.dma_status), LOG_DISK);
    return this.dma_status;
};

IDEChannel.prototype.dma_write_status = function(value)
{
    dbg_log(this.current_interface.name + ": DMA write status: " + h(value), LOG_DISK);
    this.dma_status &= ~(value & 6);
};

IDEChannel.prototype.dma_read_command = function()
{
    return this.dma_read_command8() | this.dma_read_status() << 16;
};

IDEChannel.prototype.dma_read_command8 = function()
{
    dbg_log(this.current_interface.name + ": DMA read command: " + h(this.dma_command), LOG_DISK);
    return this.dma_command;
};

IDEChannel.prototype.dma_write_command = function(value)
{
    dbg_log(this.current_interface.name + ": DMA write command: " + h(value), LOG_DISK);

    this.dma_write_command8(value & 0xFF);
    this.dma_write_status(value >> 16 & 0xFF);
};

IDEChannel.prototype.dma_write_command8 = function(value)
{
    dbg_log(this.current_interface.name + ": DMA write command8: " + h(value), LOG_DISK);

    const old_command = this.dma_command;
    this.dma_command = value & 0x09;

    if((old_command & 1) === (value & 1))
    {
        return;
    }

    if((value & 1) === 0)
    {
        this.dma_status &= ~1;
        return;
    }

    this.dma_status |= 1;

    switch(this.current_interface.current_command)
    {
        case ATA_CMD_READ_DMA:
        case ATA_CMD_READ_DMA_EXT:
            this.current_interface.do_ata_read_sectors_dma();
            break;
        case ATA_CMD_WRITE_DMA:
        case ATA_CMD_WRITE_DMA_EXT:
            this.current_interface.do_ata_write_sectors_dma();
            break;
        case ATA_CMD_PACKET:
            this.current_interface.do_atapi_dma();
            break;
        default:
            dbg_log(this.current_interface.name + ": spurious DMA command write, current command: " +
                    h(this.current_interface.current_command), LOG_DISK);
            dbg_log(this.current_interface.name + ": DMA clear status bit 1h, set status bit 2h", LOG_DISK);
            this.dma_status &= ~1;
            this.dma_status |= 2;
            this.push_irq();
            break;
    }
};

IDEChannel.prototype.push_irq = function()
{
    if((this.device_control_reg & ATA_CR_nIEN) === 0)
    {
        dbg_log(this.current_interface.name + ": push IRQ " + this.irq, LOG_DISK);
        this.dma_status |= 4;
        this.cpu.device_raise_irq(this.irq);
    }
};

IDEChannel.prototype.get_state = function()
{
    var state = [];
    state[0] = this.master;
    state[1] = this.slave;
    state[2] = this.command_base;
    state[3] = this.irq;
    // state[4] = this.pci_id;
    state[5] = this.control_base;
    // state[6] = this.bus_master_base;
    state[7] = this.name;
    state[8] = this.device_control_reg;
    state[9] = this.prdt_addr;
    state[10] = this.dma_status;
    state[11] = this.current_interface === this.master;
    state[12] = this.dma_command;
    return state;
};

IDEChannel.prototype.set_state = function(state)
{
    this.master.set_state(state[0]);
    this.slave.set_state(state[1]);
    this.command_base = state[2];
    this.irq = state[3];
    // this.pci_id = state[4];
    this.control_base = state[5];
    // this.bus_master_base = state[6];
    this.name = state[7];
    this.device_control_reg = state[8];
    this.prdt_addr = state[9];
    this.dma_status = state[10];
    this.current_interface = state[11] ? this.master : this.slave;
    this.dma_command = state[12];
};

/**
 * @constructor
 * @param {IDEChannel} channel
 * @param {CPU} cpu
 * @param {boolean} is_cd
 * @param {number} channel_nr
 * @param {number} interface_nr
 * @param {BusConnector} bus
 */
function IDEInterface(channel, cpu, buffer, is_cd, channel_nr, interface_nr, bus)
{
    this.channel = channel;
    this.name = channel.name + "." + interface_nr;

    /** @const @type {BusConnector} */
    this.bus = bus;

    /**
     * @const
     * @type {number}
     */
    this.channel_nr = channel_nr;

    /**
     * @const
     * @type {number}
     */
    this.interface_nr = interface_nr;

    /** @const @type {CPU} */
    this.cpu = cpu;

    this.buffer = null;

    /** @type {boolean} */
    this.drive_connected = is_cd || buffer;

    /** @type {boolean} */
    this.media_changed = false; // TODO

    /** @type {number} */
    this.sector_size = is_cd ? CDROM_SECTOR_SIZE : HD_SECTOR_SIZE;

    /** @type {boolean} */
    this.is_atapi = is_cd;

    /** @type {number} */
    this.sector_count = 0;

    /** @type {number} */
    this.head_count = this.is_atapi ? 1 : 0;

    /** @type {number} */
    this.sectors_per_track = 0;

    /** @type {number} */
    this.cylinder_count = 0;

    /** @type {number} */
    this.is_lba = 0;

    /** @type {number} */
    this.sector_count_reg = 0;

    /** @type {number} */
    this.lba_low_reg = 0;

    /** @type {number} */
    this.features_reg = 0;

    /** @type {number} */
    this.lba_mid_reg = 0;

    /** @type {number} */
    this.lba_high_reg = 0;

    /** @type {number} */
    this.head = 0;

    /** @type {number} */
    this.device_reg = 0;

    /** @type {number} */
    this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;

    /** @type {number} */
    this.sectors_per_drq = 0x80;

    /** @type {number} */
    this.error_reg = 0;

    /** @type {number} */
    this.data_pointer = 0;

    this.data = new Uint8Array(64 * 1024);
    this.data16 = new Uint16Array(this.data.buffer);
    this.data32 = new Int32Array(this.data.buffer);

    /** @type {number} */
    this.data_length = 0;

    /** @type {number} */
    this.data_end = 0;

    /** @type {number} */
    this.current_command = -1;

    /** @type {number} */
    this.current_atapi_command = -1;

    /** @type {number} */
    this.write_dest = 0;

    // cancellation support
    this.last_io_id = 0;
    this.in_progress_io_ids = new Set();
    this.cancelled_io_ids = new Set();

    // caller must call this.init_interface() to complete object initialization
    this.inital_buffer = buffer;
}

IDEInterface.prototype.init_interface = function()
{
    this.set_disk_buffer(this.inital_buffer);
    delete this.inital_buffer;
    Object.seal(this);
};

IDEInterface.prototype.eject = function()
{
    if(this.is_atapi && this.buffer)
    {
        this.media_changed = true;
        this.buffer = null;
        this.status_reg = 0x59; // TODO
        this.error_reg = 0x60;  // TODO
        this.push_irq();
    }
};

IDEInterface.prototype.set_cdrom = function(buffer)
{
    if(this.is_atapi && buffer)
    {
        this.set_disk_buffer(buffer);
        this.media_changed = true;
    }
};

IDEInterface.prototype.set_disk_buffer = function(buffer)
{
    if(!buffer)
    {
        return;
    }

    this.buffer = buffer;
    if(this.is_atapi)
    {
        this.status_reg = 0x59; // TODO
        this.error_reg = 0x60;  // TODO
    }
    this.sector_count = this.buffer.byteLength / this.sector_size;

    if(this.sector_count !== (this.sector_count | 0))
    {
        dbg_log(this.name + ": Warning: disk size not aligned with sector size", LOG_DISK);
        this.sector_count = Math.ceil(this.sector_count);
    }

    if(this.is_atapi)
    {
        // default values: 1/2048
        this.head_count = 1;
        this.sectors_per_track = 2048;
    }
    else
    {
        // "default" values: 16/63
        // common: 255, 63
        this.head_count = 16;
        this.sectors_per_track = 63;
    }

    this.cylinder_count = this.sector_count / this.head_count / this.sectors_per_track;

    if(this.cylinder_count !== (this.cylinder_count | 0))
    {
        dbg_log(this.name + ": Warning: rounding up cylinder count, choose different head number", LOG_DISK);
        this.cylinder_count = Math.floor(this.cylinder_count);
    }

    // for CMOS see:
    //   https://github.com/copy/v86/blob/master/src/rtc.js
    //   https://github.com/coreboot/seabios/blob/master/src/hw/rtc.h
    //   https://web.archive.org/web/20240119203005/http://www.bioscentral.com/misc/cmosmap.htm
    const rtc = this.cpu.devices.rtc;

    // master
    rtc.cmos_write(CMOS_BIOS_DISKTRANSFLAG,     // TODO: what is this doing, setting LBA translation?
                   rtc.cmos_read(CMOS_BIOS_DISKTRANSFLAG) | 1 << this.channel_nr * 4);

    // set hard disk type (CMOS_DISK_DATA = 0x12) of C: to 0b1111, keep type of D:
    //   bits 0-3: hard disk type of D:
    //   bits 4-7: hard disk type of C:
    // TODO: should this not also set CMOS_DISK_DRIVE1_TYPE to a hard disk type (see SeaBIOS rtc.h)?
    rtc.cmos_write(CMOS_DISK_DATA, rtc.cmos_read(CMOS_DISK_DATA) & 0x0F | 0xF0);

    const drive_reg = this.channel_nr === 0 ? CMOS_DISK_DRIVE1_CYL : CMOS_DISK_DRIVE2_CYL;  // 0x1B : 0x24 (drive C: or D:)
    rtc.cmos_write(drive_reg + 0, this.cylinder_count & 0xFF);        // number of cylinders least significant byte
    rtc.cmos_write(drive_reg + 1, this.cylinder_count >> 8 & 0xFF);   // number of cylinders most significant byte
    rtc.cmos_write(drive_reg + 2, this.head_count & 0xFF);            // number of heads
    rtc.cmos_write(drive_reg + 3, 0xFF);                              // write precomp cylinder least significant byte
    rtc.cmos_write(drive_reg + 4, 0xFF);                              // write precomp cylinder most significant byte
    rtc.cmos_write(drive_reg + 5, 0xC8);                              // control byte
    rtc.cmos_write(drive_reg + 6, this.cylinder_count & 0xFF);        // landing zone least significant byte
    rtc.cmos_write(drive_reg + 7, this.cylinder_count >> 8 & 0xFF);   // landing zone most significant byte
    rtc.cmos_write(drive_reg + 8, this.sectors_per_track & 0xFF);     // number of sectors

    if(this.channel.cpu)
    {
        this.push_irq();
    }
};

IDEInterface.prototype.device_reset = function()
{
    // for details, see [ATA-6] 9.11 "DEVICE RESET command protocol"
    if(this.is_atapi)
    {
        this.sector_count_reg = 1;
        this.lba_low_reg = 1;
        this.lba_mid_reg = 0x14;
        this.lba_high_reg = 0xEB;
        this.device_reg &= ATA_DR_DEV;
    }
    else
    {
        this.sector_count_reg = 1;
        this.lba_low_reg = 1;
        this.lba_mid_reg = 0;
        this.lba_high_reg = 0;
        this.device_reg = 0;
    }
    this.error_reg &= ~0x80;        // clear bit 7 only (explicitly)
    this.status_reg &= ~(ATA_SR_ERR|ATA_SR_BSY);
    this.cancel_io_operations();
};

IDEInterface.prototype.push_irq = function()
{
    this.channel.push_irq();
};

IDEInterface.prototype.ata_command = function(cmd)
{
    dbg_log(this.name + ": ATA Command: " + h(cmd), LOG_DISK);

    if(!this.drive_connected && cmd !== ATA_CMD_EXECUTE_DEVICE_DIAGNOSTIC)
    {
        dbg_log(this.name + ": ATA command ignored: No slave drive connected", LOG_DISK);
        return;
    }

    this.current_command = cmd;
    this.error_reg = 0;

    switch(cmd)
    {
        case ATA_CMD_DEVICE_RESET:
            dbg_log(this.name + ": ATA device reset", LOG_DISK);
            this.data_pointer = 0;
            this.data_end = 0;
            this.data_length = 0;
            this.device_reset();
            this.push_irq();
            break;

        case ATA_CMD_10h:
            dbg_log(this.name + ": ATA calibrate drive", LOG_DISK);
            this.lba_mid_reg = 0;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_READ_NATIVE_MAX_ADDRESS:
            dbg_log(this.name + ": ATA read native max address", LOG_DISK);
            var last_sector = this.sector_count - 1;
            this.lba_low_reg = last_sector & 0xFF;
            this.lba_mid_reg = last_sector >> 8 & 0xFF;
            this.lba_high_reg = last_sector >> 16 & 0xFF;
            this.device_reg = this.device_reg & ATA_DR_DEV | last_sector >> 24 & 0x0F;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_READ_NATIVE_MAX_ADDRESS_EXT:
            dbg_log(this.name + ": ATA read native max address ext", LOG_DISK);
            var last_sector = this.sector_count - 1;
            if(this.channel.device_control_reg & ATA_CR_HOB === 0)
            {
                this.lba_low_reg = last_sector & 0xFF;
                this.lba_mid_reg = last_sector >> 8 & 0xFF;
                this.lba_high_reg = last_sector >> 16 & 0xFF;
            }
            else
            {
                this.lba_low_reg = last_sector >> 24 & 0xFF;
                this.lba_mid_reg = last_sector >> 32 & 0xFF;
                this.lba_high_reg = last_sector >> 40 & 0xFF;
            }
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_READ_SECTORS:
        case ATA_CMD_READ_SECTORS_EXT:
        case ATA_CMD_READ_MULTIPLE:
        case ATA_CMD_READ_MULTIPLE_EXT:
            this.ata_read_sectors(cmd);
            break;

        case ATA_CMD_WRITE_SECTORS:
        case ATA_CMD_WRITE_SECTORS_EXT:
        case ATA_CMD_WRITE_MULTIPLE:
        case ATA_CMD_WRITE_MULTIPLE_EXT:
            this.ata_write_sectors(cmd);
            break;

        case ATA_CMD_EXECUTE_DEVICE_DIAGNOSTIC:
            dbg_log(this.name + ": ATA execute device diagnostic", LOG_DISK);
            // TODO: this code is completely wrong (master device replies if slave does not exist)
            // assign diagnostic code (used to be 0x101?) to error register
            if(this.interface_nr === 0)
            {
                if(this.channel.slave.drive_connected)
                {
                    this.error_reg = 0x01;  // Master drive passed, slave passed or not present
                }
                else
                {
                    this.error_reg = 0x81;  // Master drive passed, slave failed
                }
            }
            else
            {
                if(this.channel.slave.drive_connected)
                {
                    this.error_reg = 0x01;  // Slave drive passed
                }
                else
                {
                    this.error_reg = 0x00;  // Slave drive failed
                }
            }
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_INITIALIZE_DEVICE_PARAMETERS:
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_PACKET:
            if(this.is_atapi)
            {
                this.data_allocate(12);
                this.data_end = 12;
                this.sector_count_reg = 0x01;                           // 0x01: indicates transfer of a command packet (C/D)
                this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;    // 0x10: another command is ready to be serviced (SERV)
                this.push_irq();
            }
            break;

        case ATA_CMD_IDENTIFY_PACKET_DEVICE:
            dbg_log(this.name + ": ATA identify packet device", LOG_DISK);
            if(this.is_atapi)
            {
                this.create_identify_packet();
                this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            }
            else
            {
                this.error_reg = ATA_ER_ABRT;
                this.status_reg = ATA_SR_DRDY|ATA_SR_ERR;
            }
            this.push_irq();
            break;

        case ATA_CMD_SET_MULTIPLE_MODE:
            dbg_log(this.name + ": ATA set multiple mode", LOG_DISK);
            // Logical sectors per DRQ Block in word 1
            dbg_log(this.name + ": logical sectors per DRQ Block: " + h(this.sector_count_reg & 0xFF), LOG_DISK);
            this.sectors_per_drq = this.sector_count_reg & 0xFF;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_READ_DMA:
        case ATA_CMD_READ_DMA_EXT:
            this.ata_read_sectors_dma(cmd);
            break;

        case ATA_CMD_WRITE_DMA:
        case ATA_CMD_WRITE_DMA_EXT:
            this.ata_write_sectors_dma(cmd);
            break;

        case ATA_CMD_READ_VERIFY_SECTORS:
            dbg_log(this.name + ": ATA read verify sector(s)", LOG_DISK);
            // TODO: check that lba_low/mid/high and sector_count regs are within the bounds of the disk's size
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_GET_MEDIA_STATUS:
            dbg_log(this.name + ": ATA get media status", LOG_DISK);
            if(this.is_atapi)
            {
                if(!this.buffer)
                {
                    this.error_reg |= 0x02; // NM: No Media
                }
                if(this.media_changed)
                {
                    this.error_reg |= 0x20; // MC: Media Change
                    this.media_changed = false;
                }
                this.error_reg |= 0x40;     // WP: Write Protect
            }
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_STANDBY_IMMEDIATE:
            dbg_log(this.name + ": ATA standby immediate", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_IDLE_IMMEDIATE:
            dbg_log(this.name + ": ATA idle immediate", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_FLUSH_CACHE:
            dbg_log(this.name + ": ATA flush cache", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_FLUSH_CACHE_EXT:
            dbg_log(this.name + ": ATA flush cache ext", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_IDENTIFY_DEVICE:
            dbg_log(this.name + ": ATA identify device", LOG_DISK);
            if(this.is_atapi)
            {
                this.error_reg = ATA_ER_ABRT;
                this.status_reg = ATA_SR_DRDY|ATA_SR_ERR;
            }
            else
            {
                this.create_identify_packet();
                this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            }
            this.push_irq();
            break;

        case ATA_CMD_SET_FEATURES:
            dbg_log(this.name + ": ATA set features: " + h(this.sector_count_reg & 0xFF), LOG_DISK);
            // TODO: this one is important, accept/refuse requested device features
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_MEDIA_LOCK:
            dbg_log(this.name + ": ATA media lock", LOG_DISK);
            this.status_reg = ATA_SR_DRDY;
            this.push_irq();
            break;

        case ATA_CMD_SECURITY_FREEZE_LOCK:
            dbg_log(this.name + ": ATA security freeze lock", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.push_irq();
            break;

        case ATA_CMD_SET_MAX:
            dbg_log(this.name + ": ATA set max address (unimplemented)", LOG_DISK);
            this.error_reg = ATA_ER_ABRT;
            this.status_reg = ATA_SR_DRDY|ATA_SR_ERR;
            this.push_irq();
            break;

        default:
            dbg_assert(false, this.name + ": unhandled ATA command: " + h(cmd), LOG_DISK);
            this.error_reg = ATA_ER_ABRT;
            this.status_reg = ATA_SR_DRDY|ATA_SR_ERR;
            this.push_irq();
    }
};

IDEInterface.prototype.atapi_handle = function()
{
    dbg_log(this.name + ": ATAPI Command: " + h(this.data[0]), LOG_DISK);

    this.data_pointer = 0;
    this.current_atapi_command = this.data[0];
    if(!this.buffer && (this.current_atapi_command === ATAPI_CMD_READ_CAPACITY ||
                        this.current_atapi_command === ATAPI_CMD_READ ||
                        this.current_atapi_command === ATAPI_CMD_READ_SUBCHANNEL ||
                        this.current_atapi_command === ATAPI_CMD_READ_TOC_PMA_ATIP ||
                        this.current_atapi_command === ATAPI_CMD_READ_DISK_INFORMATION))
    {
        dbg_log(this.name + ": CD read-related action: no buffer", LOG_DISK);
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_ERR;
        this.error_reg = 0x21;  // TODO
        this.data_allocate(0);
        this.data_end = this.data_length;
        this.sector_count_reg = this.sector_count_reg & ~7 | 2 | 1;
        this.push_irq();
        return;
    }

    switch(this.current_atapi_command)
    {
        case ATAPI_CMD_TEST_UNIT_READY:
            dbg_log(this.name + ": ATAPI test unit ready", LOG_DISK);
            this.data_allocate(0);
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            break;

        case ATAPI_CMD_REQUEST_SENSE:
            dbg_log(this.name + ": ATAPI request sense", LOG_DISK);
            this.data_allocate(this.data[4]);
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.data[0] = 0x80 | 0x70;             // valid | SCSI error code
            this.data[2] = this.error_reg >> 4;     // SCSI sense key (TODO: always 0, which means no errors or warnings)
            this.data[7] = 8;                       // SCSI additional sense length (fixed 8 for this error code 0x70)
            this.data[12] = 0;                      // SCSI additional sense code
            this.data[13] = 0;                      // SCSI additional sense code qualifier
            break;

        case ATAPI_CMD_INQUIRY:
            var length = this.data[4];
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            dbg_log(this.name + ": ATAPI inquiry: " + h(this.data[1], 2) + " length=" + length, LOG_DISK);
            // for data layout see [CD-SCSI-2] "INQUIRY Command"
            this.data.set([
                // 0: Device-type, Removable, ANSI-Version, Response Format
                this.drive_connected ? 0x05 : 0x7F, 0x80, 0x01, 0x31,   // TODO: drive_connected likely not needed
                // 4: Additional length, Reserved, Reserved, Reserved
                0x31, 0, 0, 0,
                // 8: Vendor Identification "SONY    "
                0x53, 0x4F, 0x4E, 0x59,
                0x20, 0x20, 0x20, 0x20,
                // 16: Product Identification "CD-ROM CDU-1000 "
                0x43, 0x44, 0x2D, 0x52,
                0x4F, 0x4D, 0x20, 0x43,
                0x44, 0x55, 0x2D, 0x31,
                0x30, 0x30, 0x30, 0x20,
                // 32: Product Revision Level "1.1a"
                0x31, 0x2E, 0x31, 0x61,
            ]);
            this.data_end = this.data_length = Math.min(36, length);
            break;

        case ATAPI_CMD_MODE_SENSE_6:
            dbg_log(this.name + ": ATAPI mode sense (6)", LOG_DISK);
            this.data_allocate(this.data[4]);
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_PREVENT_ALLOW_MEDIUM_REMOVAL:
            dbg_log(this.name + ": ATAPI prevent allow medium removal", LOG_DISK);
            this.data_allocate(0);
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            break;

        case ATAPI_CMD_READ_CAPACITY:
            dbg_log(this.name + ": ATAPI read capacity", LOG_DISK);
            var count = this.sector_count - 1;
            this.data_set(new Uint8Array([
                count >> 24 & 0xFF,
                count >> 16 & 0xFF,
                count >> 8 & 0xFF,
                count & 0xFF,
                0,
                0,
                this.sector_size >> 8 & 0xFF,
                this.sector_size & 0xFF,
            ]));
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_READ:
            if(this.features_reg & 1)
            {
                this.atapi_read_dma(this.data);
            }
            else
            {
                this.atapi_read(this.data);
            }
            break;

        case ATAPI_CMD_READ_SUBCHANNEL:
            var length = this.data[8];
            dbg_log(this.name + ": ATAPI read subchannel: length=" + length, LOG_DISK);
            this.data_allocate(Math.min(8, length));
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_READ_TOC_PMA_ATIP:
            var length = this.data[8] | this.data[7] << 8;
            var format = this.data[9] >> 6;

            this.data_allocate(length);
            this.data_end = this.data_length;
            dbg_log(this.name + ": ATAPI read toc/pma/atip: " + h(format, 2) +
                    " length=" + length +
                    " " + (this.data[1] & 2) +
                    " " + h(this.data[6]), LOG_DISK);

            if(format === 0)
            {
                const sector_count = this.sector_count;
                this.data.set(new Uint8Array([
                    0, 18, // length
                    1, 1, // first and last session

                    0,
                    0x14,
                    1, // track number
                    0,
                    0, 0, 0, 0,

                    0,
                    0x16,
                    0xAA, // track number
                    0,
                    sector_count >> 24,
                    sector_count >> 16 & 0xFF,
                    sector_count >> 8 & 0xFF,
                    sector_count & 0xFF,
                ]));
            }
            else if(format === 1)
            {
                this.data.set(new Uint8Array([
                    0, 10, // length
                    1, 1, // first and last session
                    0, 0,
                    0, 0,
                    0, 0,
                    0, 0,
                ]));
            }
            else
            {
                dbg_assert(false, this.name + ": unimplemented format: " + format);
            }

            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_GET_CONFIGURATION:
            var length = Math.min(this.data[8] | this.data[7] << 8, 32);
            dbg_log(this.name + ": ATAPI get configuration: length=" + length, LOG_DISK);
            this.data_allocate(length);
            this.data_end = this.data_length;
            this.data[0] = length - 4 >> 24 & 0xFF;
            this.data[1] = length - 4 >> 16 & 0xFF;
            this.data[2] = length - 4 >> 8 & 0xFF;
            this.data[3] = length - 4 & 0xFF;
            this.data[6] = 0x08;
            this.data[10] = 3;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_READ_DISK_INFORMATION:
            dbg_log(this.name + ": ATAPI read disk information", LOG_DISK);
            this.data_allocate(0);
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            break;

        case ATAPI_CMD_READ_TRACK_INFORMATION:
            dbg_log(this.name + ": ATAPI read track information (unimplemented)", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_ERR;
            this.data_length = 0;
            this.error_reg = 5 << 4;
            break;

        case ATAPI_CMD_MODE_SENSE_10:
            var length = this.data[8] | this.data[7] << 8;
            var page_code = this.data[2];
            dbg_log(this.name + ": ATAPI mode sense (10): page_code=" + h(page_code) + " length=" + length, LOG_DISK);
            if(page_code === 0x2A)
            {
                this.data_allocate(Math.min(30, length));
            }
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_MECHANISM_STATUS:
            dbg_log(this.name + ": ATAPI mechanism status", LOG_DISK);
            this.data_allocate(this.data[9] | this.data[8] << 8);
            this.data_end = this.data_length;
            this.data[5] = 1;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            break;

        case ATAPI_CMD_GET_EVENT_STATUS_NOTIFICATION:
            dbg_log(this.name + ": ATAPI get event status notification (unimplemented)", LOG_DISK);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_ERR;
            this.data_length = 0;
            this.error_reg = 5 << 4;
            break;

        case ATAPI_CMD_READ_CD:
            dbg_log(this.name + ": ATAPI read cd (unimplemented)", LOG_DISK);
            this.data_allocate(0);
            this.data_end = this.data_length;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            break;

        default:
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_ERR;
            this.data_length = 0;
            this.error_reg = 5 << 4;
            dbg_log(this.name + ": unimplemented ATAPI command: " + h(this.data[0]), LOG_DISK);
            dbg_assert(false);
    }

    this.sector_count_reg = this.sector_count_reg & ~7 | 2;

    if((this.status_reg & ATA_SR_BSY) === 0)
    {
        this.push_irq();
    }

    if((this.status_reg & ATA_SR_BSY) === 0 && this.data_length === 0)
    {
        this.sector_count_reg |= 1;
        this.status_reg &= ~ATA_SR_DRQ;
    }
};

IDEInterface.prototype.do_write = function()
{
    this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;

    dbg_assert(this.data_length <= this.data.length);
    var data = this.data.subarray(0, this.data_length);

    //dbg_log(hex_dump(data), LOG_DISK);
    dbg_assert(this.data_length % 512 === 0);
    this.ata_advance(this.current_command, this.data_length / 512);
    this.push_irq();

    this.buffer.set(this.write_dest, data, function()
    {
    });

    this.report_write(this.data_length);
};

IDEInterface.prototype.atapi_read = function(cmd)
{
    // Note: Big Endian
    var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5];
    var count = cmd[7] << 8 | cmd[8];
    var flags = cmd[1];
    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_log(this.name + ": CD read lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count) +
            " flags=" + h(flags), LOG_DISK);

    this.data_length = 0;
    var req_length = this.lba_high_reg << 8 & 0xFF00 | this.lba_mid_reg & 0xFF;
    dbg_log(this.name + ": " + h(this.lba_high_reg, 2) + " " + h(this.lba_mid_reg, 2), LOG_DISK);
    this.lba_mid_reg = this.lba_high_reg = 0; // oak technology driver (windows 3.0)

    if(req_length === 0xFFFF)
        req_length--;

    if(req_length > byte_count)
    {
        req_length = byte_count;
    }

    if(!this.buffer)
    {
        dbg_assert(false, this.name + ": CD read: no buffer", LOG_DISK);
        this.status_reg = 0xFF;
        this.error_reg = 0x41;
        this.push_irq();
    }
    else if(start >= this.buffer.byteLength)
    {
        dbg_assert(false, this.name + ": CD read: Outside of disk  end=" + h(start + byte_count) +
                          " size=" + h(this.buffer.byteLength), LOG_DISK);

        this.status_reg = 0xFF;
        this.push_irq();
    }
    else if(byte_count === 0)
    {
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;

        this.data_pointer = 0;
        //this.push_irq();
    }
    else
    {
        byte_count = Math.min(byte_count, this.buffer.byteLength - start);
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC | 0x80;    // TODO: 0x80
        this.report_read_start();

        this.read_buffer(start, byte_count, (data) =>
        {
            //setTimeout(() => {
            dbg_log(this.name + ": CD read: data arrived", LOG_DISK);
            this.data_set(data);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.sector_count_reg = this.sector_count_reg & ~7 | 2;

            this.push_irq();

            req_length &= ~3;

            this.data_end = req_length;
            if(this.data_end > this.data_length)
            {
                this.data_end = this.data_length;
            }
            this.lba_mid_reg = this.data_end & 0xFF;
            this.lba_high_reg = this.data_end >> 8 & 0xFF;

            this.report_read_end(byte_count);
            //}, 10);
        });
    }
};

IDEInterface.prototype.atapi_read_dma = function(cmd)
{
    // Note: Big Endian
    var lba = cmd[2] << 24 | cmd[3] << 16 | cmd[4] << 8 | cmd[5];
    var count = cmd[7] << 8 | cmd[8];
    var flags = cmd[1];
    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_log(this.name + ": CD read DMA lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count) +
            " flags=" + h(flags), LOG_DISK);

    if(start >= this.buffer.byteLength)
    {
        dbg_assert(false, this.name + ": CD read: Outside of disk  end=" + h(start + byte_count) +
                          " size=" + h(this.buffer.byteLength), LOG_DISK);

        this.status_reg = 0xFF;
        this.push_irq();
    }
    else
    {
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC | 0x80;    // TODO: 0x80
        this.report_read_start();

        this.read_buffer(start, byte_count, (data) =>
        {
            dbg_log(this.name + ": atapi_read_dma: Data arrived");
            this.report_read_end(byte_count);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.sector_count_reg = this.sector_count_reg & ~7 | 2;
            this.data_set(data);

            this.do_atapi_dma();
        });
    }
};

IDEInterface.prototype.do_atapi_dma = function()
{
    if((this.channel.dma_status & 1) === 0)
    {
        dbg_log(this.name + ": do_atapi_dma: Status not set", LOG_DISK);
        return;
    }

    if((this.status_reg & ATA_SR_DRQ) === 0)
    {
        dbg_log(this.name + ": do_atapi_dma: DRQ not set", LOG_DISK);
        return;
    }

    dbg_log(this.name + ": ATAPI DMA transfer len=" + this.data_length, LOG_DISK);

    var prdt_start = this.channel.prdt_addr;
    var offset = 0;

    var data = this.data;

    do {
        var addr = this.cpu.read32s(prdt_start);
        var count = this.cpu.read16(prdt_start + 4);
        var end = this.cpu.read8(prdt_start + 7) & 0x80;

        if(!count)
        {
            count = 0x10000;
        }

        dbg_log(this.name + ": DMA read dest=" + h(addr) + " count=" + h(count) + " datalen=" + h(this.data_length), LOG_DISK);
        this.cpu.write_blob(data.subarray(offset, Math.min(offset + count, this.data_length)), addr);

        offset += count;
        prdt_start += 8;

        if(offset >= this.data_length && !end)
        {
            dbg_log(this.name + ": leave early end=" + (+end) +
                    " offset=" + h(offset) +
                    " data_length=" + h(this.data_length) +
                    " cmd=" + h(this.current_command), LOG_DISK);
            break;
        }
    }
    while(!end);

    dbg_log(this.name + ": end offset=" + offset, LOG_DISK);

    this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
    this.channel.dma_status &= ~1;
    this.sector_count_reg = this.sector_count_reg & ~7 | 3;
    this.push_irq();
};

IDEInterface.prototype.read_data = function(length)
{
    if(this.data_pointer < this.data_end)
    {
        dbg_assert(this.data_pointer + length - 1 < this.data_end);
        dbg_assert(this.data_pointer % length === 0, h(this.data_pointer) + " " + length);

        if(length === 1)
        {
            var result = this.data[this.data_pointer];
        }
        else if(length === 2)
        {
            var result = this.data16[this.data_pointer >>> 1];
        }
        else
        {
            var result = this.data32[this.data_pointer >>> 2];
        }

        this.data_pointer += length;

        var align = (this.data_end & 0xFFF) === 0 ? 0xFFF : 0xFF;
        if((this.data_pointer & align) === 0)
        {
            dbg_log(this.name + ": read 1F0: " + h(this.data[this.data_pointer], 2) +
                        " cur=" + h(this.data_pointer) +
                        " cnt=" + h(this.data_length), LOG_DISK);
        }

        if(this.data_pointer >= this.data_end)
        {
            this.read_end();
        }

        return result;
    }
    else
    {
        dbg_log(this.name + ": read 1F0: empty", LOG_DISK);

        this.data_pointer += length;
        return 0;
    }
};

IDEInterface.prototype.read_end = function()
{
    dbg_log(this.name + ": read_end cmd=" + h(this.current_command) +
            " data_pointer=" + h(this.data_pointer) + " end=" + h(this.data_end) +
            " length=" + h(this.data_length), LOG_DISK);

    if(this.current_command === ATA_CMD_PACKET)
    {
        if(this.data_end === this.data_length)
        {
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
            this.sector_count_reg = this.sector_count_reg & ~7 | 3;
            this.push_irq();
        }
        else
        {
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.sector_count_reg = this.sector_count_reg & ~7 | 2;
            this.push_irq();
            var byte_count = this.lba_high_reg << 8 & 0xFF00 | this.lba_mid_reg & 0xFF;

            if(this.data_end + byte_count > this.data_length)
            {
                this.lba_mid_reg = (this.data_length - this.data_end) & 0xFF;
                this.lba_high_reg = (this.data_length - this.data_end) >> 8 & 0xFF;
                this.data_end = this.data_length;
            }
            else
            {
                this.data_end += byte_count;
            }
            dbg_log(this.name + ": data_end=" + h(this.data_end), LOG_DISK);
        }
    }
    else
    {
        this.error_reg = 0;
        if(this.data_pointer >= this.data_length)
        {
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
        }
        else
        {
            if(this.current_command === ATA_CMD_READ_MULTIPLE || this.current_command === ATA_CMD_READ_MULTIPLE_EXT)
            {
                var sector_count = Math.min(this.sectors_per_drq,
                    (this.data_length - this.data_end) / 512);
                dbg_assert(sector_count % 1 === 0);
            }
            else
            {
                dbg_assert(this.current_command === ATA_CMD_READ_SECTORS || this.current_command === ATA_CMD_READ_SECTORS_EXT);
                var sector_count = 1;
            }
            this.ata_advance(this.current_command, sector_count);
            this.data_end += 512 * sector_count;
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.push_irq();
        }
    }
};

IDEInterface.prototype.write_data_port = function(data, length)
{
    dbg_assert(this.data_pointer % length === 0);

    if(this.data_pointer >= this.data_end)
    {
        dbg_log(this.name + ": redundant write to data port: " + h(data) + " count=" +
                h(this.data_end) + " cur=" + h(this.data_pointer), LOG_DISK);
    }
    else
    {
        var align = (this.data_end & 0xFFF) === 0 ? 0xFFF : 0xFF;
        if((this.data_pointer + length & align) === 0 || this.data_end < 20)
        {
            dbg_log(this.name + ": data port: " + h(data >>> 0) + " count=" +
                    h(this.data_end) + " cur=" + h(this.data_pointer), LOG_DISK);
        }

        if(length === 1)
        {
            this.data[this.data_pointer++] = data;
        }
        else if(length === 2)
        {
            this.data16[this.data_pointer >>> 1] = data;
            this.data_pointer += 2;
        }
        else
        {
            this.data32[this.data_pointer >>> 2] = data;
            this.data_pointer += 4;
        }

        dbg_assert(this.data_pointer <= this.data_end);
        if(this.data_pointer === this.data_end)
        {
            this.write_end();
        }
    }
};

IDEInterface.prototype.write_data_port8 = function(data)
{
    this.write_data_port(data, 1);
};

IDEInterface.prototype.write_data_port16 = function(data)
{
    this.write_data_port(data, 2);
};

IDEInterface.prototype.write_data_port32 = function(data)
{
    this.write_data_port(data, 4);
};

IDEInterface.prototype.write_end = function()
{
    if(this.current_command === ATA_CMD_PACKET)
    {
        this.atapi_handle();
    }
    else
    {
        dbg_log(this.name + ": write_end data_pointer=" + h(this.data_pointer) +
                " data_length=" + h(this.data_length), LOG_DISK);

        if(this.data_pointer >= this.data_length)
        {
            this.do_write();
        }
        else
        {
            dbg_assert(this.current_command === ATA_CMD_WRITE_SECTORS ||
                this.current_command === ATA_CMD_WRITE_SECTORS_EXT ||
                this.current_command === ATA_CMD_WRITE_MULTIPLE_EXT,
                "Unexpected command: " + h(this.current_command));

            // XXX: Should advance here, but do_write does all the advancing
            //this.ata_advance(this.current_command, 1);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.data_end += 512;
            this.push_irq();
        }
    }
};

IDEInterface.prototype.ata_advance = function(cmd, sectors)
{
    dbg_log(this.name + ": advance sectors=" + sectors + " old_sector_count_reg=" + this.sector_count_reg, LOG_DISK);
    this.sector_count_reg -= sectors;

    if(cmd === ATA_CMD_READ_SECTORS_EXT ||
            cmd === ATA_CMD_READ_MULTIPLE ||
            cmd === ATA_CMD_READ_DMA_EXT ||
            cmd === ATA_CMD_WRITE_SECTORS_EXT ||
            cmd === ATA_CMD_WRITE_MULTIPLE ||
            cmd === ATA_CMD_WRITE_DMA_EXT)
    {
        var new_sector = sectors + this.get_lba48();
        this.lba_low_reg = new_sector & 0xFF | new_sector >> 16 & 0xFF00;
        this.lba_mid_reg = new_sector >> 8 & 0xFF;
        this.lba_high_reg = new_sector >> 16 & 0xFF;
    }
    else if(this.is_lba)
    {
        var new_sector = sectors + this.get_lba28();
        this.lba_low_reg = new_sector & 0xFF;
        this.lba_mid_reg = new_sector >> 8 & 0xFF;
        this.lba_high_reg = new_sector >> 16 & 0xFF;
        this.head = this.head & ~0xF | new_sector & 0xF;
    }
    else // chs
    {
        var new_sector = sectors + this.get_chs();

        var c = new_sector / (this.head_count * this.sectors_per_track) | 0;
        this.lba_mid_reg = c & 0xFF;
        this.lba_high_reg = c >> 8 & 0xFF;
        this.head = (new_sector / this.sectors_per_track | 0) % this.head_count & 0xF;
        this.lba_low_reg = (new_sector % this.sectors_per_track + 1) & 0xFF;

        dbg_assert(new_sector === this.get_chs());
    }
};

IDEInterface.prototype.ata_read_sectors = function(cmd)
{
    var is_lba48 = cmd === ATA_CMD_READ_SECTORS_EXT || cmd === ATA_CMD_READ_MULTIPLE;
    var count = this.get_count(is_lba48);
    var lba = this.get_lba(is_lba48);

    var is_single = cmd === ATA_CMD_READ_SECTORS || cmd === ATA_CMD_READ_SECTORS_EXT;

    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_log(this.name + ": ATA read cmd=" + h(cmd) +
            " mode=" + (this.is_lba ? "lba" : "chs") +
            " lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_assert(false, this.name + ": ATA read: Outside of disk", LOG_DISK);

        this.status_reg = 0xFF;
        this.push_irq();
    }
    else
    {
        this.status_reg = 0x80 | 0x40;  // TODO
        this.report_read_start();

        this.read_buffer(start, byte_count, (data) =>
        {
            //setTimeout(() => {
            dbg_log(this.name + ": ata_read: Data arrived", LOG_DISK);

            this.data_set(data);
            this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
            this.data_end = is_single ? 512 : Math.min(byte_count, this.sectors_per_drq * 512);
            this.ata_advance(cmd, is_single ? 1 : Math.min(count, this.sectors_per_track));

            this.push_irq();
            this.report_read_end(byte_count);
            //}, 10);
        });
    }
};

IDEInterface.prototype.ata_read_sectors_dma = function(cmd)
{
    var is_lba48 = cmd === ATA_CMD_READ_DMA_EXT;
    var count = this.get_count(is_lba48);
    var lba = this.get_lba(is_lba48);

    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_log(this.name + ": ATA DMA read lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_assert(false, this.name + ": ATA read: Outside of disk", LOG_DISK);

        this.status_reg = 0xFF;
        this.push_irq();
        return;
    }

    this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
    this.channel.dma_status |= 1;
};

IDEInterface.prototype.do_ata_read_sectors_dma = function()
{
    var cmd = this.current_command;

    var is_lba48 = cmd === ATA_CMD_READ_DMA_EXT;
    var count = this.get_count(is_lba48);
    var lba = this.get_lba(is_lba48);

    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_assert(lba < this.buffer.byteLength);

    this.report_read_start();

    var orig_prdt_start = this.channel.prdt_addr;

    this.read_buffer(start, byte_count, (data) =>
    {
        //setTimeout(function() {
        dbg_log(this.name + ": do_ata_read_sectors_dma: Data arrived", LOG_DISK);
        var prdt_start = this.channel.prdt_addr;
        var offset = 0;

        dbg_assert(orig_prdt_start === prdt_start);

        do {
            var prd_addr = this.cpu.read32s(prdt_start);
            var prd_count = this.cpu.read16(prdt_start + 4);
            var end = this.cpu.read8(prdt_start + 7) & 0x80;

            if(!prd_count)
            {
                prd_count = 0x10000;
                dbg_log(this.name + ": DMA: prd count was 0", LOG_DISK);
            }

            dbg_log(this.name + ": DMA read transfer dest=" + h(prd_addr) +
                    " prd_count=" + h(prd_count), LOG_DISK);
            this.cpu.write_blob(data.subarray(offset, offset + prd_count), prd_addr);

            offset += prd_count;
            prdt_start += 8;
        }
        while(!end);

        dbg_assert(offset === byte_count);

        this.ata_advance(this.current_command, count);
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
        this.channel.dma_status &= ~1;
        this.current_command = -1;

        this.report_read_end(byte_count);

        this.push_irq();
    });
};

IDEInterface.prototype.ata_write_sectors = function(cmd)
{
    var is_lba48 = cmd === ATA_CMD_WRITE_SECTORS_EXT || cmd === ATA_CMD_WRITE_MULTIPLE;
    var count = this.get_count(is_lba48);
    var lba = this.get_lba(is_lba48);

    var is_single = cmd === ATA_CMD_WRITE_SECTORS || cmd === ATA_CMD_WRITE_SECTORS_EXT;

    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_log(this.name + ": ATA write lba=" + h(lba) +
            " mode=" + (this.is_lba ? "lba" : "chs") +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_assert(false, this.name + ": ATA write: Outside of disk", LOG_DISK);

        this.status_reg = 0xFF;
        this.push_irq();
    }
    else
    {
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
        this.data_allocate_noclear(byte_count);
        this.data_end = is_single ? 512 : Math.min(byte_count, this.sectors_per_drq * 512);
        this.write_dest = start;
    }
};

IDEInterface.prototype.ata_write_sectors_dma = function(cmd)
{
    var is_lba48 = cmd === ATA_CMD_WRITE_DMA_EXT;
    var count = this.get_count(is_lba48);
    var lba = this.get_lba(is_lba48);

    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    dbg_log(this.name + ": ATA DMA write lba=" + h(lba) +
            " lbacount=" + h(count) +
            " bytecount=" + h(byte_count), LOG_DISK);

    if(start + byte_count > this.buffer.byteLength)
    {
        dbg_assert(false, this.name + ": ATA DMA write: Outside of disk", LOG_DISK);

        this.status_reg = 0xFF;
        this.push_irq();
        return;
    }

    this.status_reg = ATA_SR_DRDY|ATA_SR_DSC|ATA_SR_DRQ;
    this.channel.dma_status |= 1;
};

IDEInterface.prototype.do_ata_write_sectors_dma = function()
{
    var cmd = this.current_command;

    var is_lba48 = cmd === ATA_CMD_WRITE_DMA_EXT;
    var count = this.get_count(is_lba48);
    var lba = this.get_lba(is_lba48);

    var byte_count = count * this.sector_size;
    var start = lba * this.sector_size;

    var prdt_start = this.channel.prdt_addr;
    var offset = 0;

    dbg_log(this.name + ": prdt addr: " + h(prdt_start, 8), LOG_DISK);

    const buffer = new Uint8Array(byte_count);

    do {
        var prd_addr = this.cpu.read32s(prdt_start);
        var prd_count = this.cpu.read16(prdt_start + 4);
        var end = this.cpu.read8(prdt_start + 7) & 0x80;

        if(!prd_count)
        {
            prd_count = 0x10000;
            dbg_log(this.name + ": DMA: prd count was 0", LOG_DISK);
        }

        dbg_log(this.name + ": DMA write transfer dest=" + h(prd_addr) + " prd_count=" + h(prd_count), LOG_DISK);

        var slice = this.cpu.mem8.subarray(prd_addr, prd_addr + prd_count);
        dbg_assert(slice.length === prd_count);

        buffer.set(slice, offset);

        //if(DEBUG)
        //{
        //    dbg_log(hex_dump(slice), LOG_DISK);
        //}

        offset += prd_count;
        prdt_start += 8;
    }
    while(!end);

    dbg_assert(offset === buffer.length);

    this.buffer.set(start, buffer, () =>
    {
        dbg_log(this.name + ": DMA write completed", LOG_DISK);
        this.ata_advance(this.current_command, count);
        this.status_reg = ATA_SR_DRDY|ATA_SR_DSC;
        this.push_irq();
        this.channel.dma_status &= ~1;
        this.current_command = -1;
    });

    this.report_write(byte_count);
};

IDEInterface.prototype.get_chs = function()
{
    var c = this.lba_mid_reg & 0xFF | this.lba_high_reg << 8 & 0xFF00;
    var h = this.head;
    var s = this.lba_low_reg & 0xFF;

    dbg_log(this.name + ": get_chs: c=" + c + " h=" + h + " s=" + s, LOG_DISK);

    return (c * this.head_count + h) * this.sectors_per_track + s - 1;
};

IDEInterface.prototype.get_lba28 = function()
{
    return this.lba_low_reg & 0xFF |
            this.lba_mid_reg << 8 & 0xFF00 |
            this.lba_high_reg << 16 & 0xFF0000 |
            (this.head & 0xF) << 24;
};

IDEInterface.prototype.get_lba48 = function()
{
    // Note: Bits over 32 missing
    return (this.lba_low_reg & 0xFF |
            this.lba_mid_reg << 8 & 0xFF00 |
            this.lba_high_reg << 16 & 0xFF0000 |
            (this.lba_low_reg >> 8) << 24 & 0xFF000000) >>> 0;
};

IDEInterface.prototype.get_lba = function(is_lba48)
{
    if(is_lba48)
    {
        return this.get_lba48();
    }
    else if(this.is_lba)
    {
        return this.get_lba28();
    }
    else
    {
        return this.get_chs();
    }
};

IDEInterface.prototype.get_count = function(is_lba48)
{
    if(is_lba48)
    {
        var count = this.sector_count_reg;
        if(count === 0) count = 0x10000;
        return count;
    }
    else
    {
        var count = this.sector_count_reg & 0xFF;
        if(count === 0) count = 0x100;
        return count;
    }
};

IDEInterface.prototype.create_identify_packet = function()
{
    // http://bochs.sourceforge.net/cgi-bin/lxr/source/iodev/harddrv.cc#L2821

    for(var i = 0; i < 512; i++)
    {
        this.data[i] = 0;
    }

    var cylinder_count = Math.min(16383, this.cylinder_count);

    this.data_set([
        0x40, this.is_atapi ? 0x85 : 0,
        // 1 cylinders
        cylinder_count, cylinder_count >> 8,
        0, 0,

        // 3 heads
        this.head_count, this.head_count >> 8,
        this.sectors_per_track / 512, this.sectors_per_track / 512 >> 8,
        // 5
        0, 512 >> 8,
        // sectors per track
        this.sectors_per_track, this.sectors_per_track >> 8,
        0, 0, 0, 0, 0, 0,
        // 10-19 serial number
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 15
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 20
        3, 0,
        0, 2,
        4, 0,
        // 23-26 firmware revision
        0, 0, 0, 0, 0, 0, 0, 0,

        // 27 model number
        56, 118, 32, 54, 68, 72, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
        32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,

        // 47 max value for set multiple mode
        0x80, 0,
        1, 0,
        //0, 3,  // capabilities, 2: Only LBA / 3: LBA and DMA
        0, 2,  // capabilities, 2: Only LBA / 3: LBA and DMA
        // 50
        0, 0,
        0, 2,
        0, 2,
        7, 0,

        // 54 cylinders
        cylinder_count, cylinder_count >> 8,
        // 55 heads
        this.head_count, this.head_count >> 8,
        // 56 sectors per track
        this.sectors_per_track, 0,
        // capacity in sectors
        this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF,
        this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF,

        0, 0,
        // 60
        this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF,
        this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF,

        0, 0,
        // 63, dma supported mode, dma selected mode
        this.current_command === ATA_CMD_PACKET ? 0 : 7, this.current_command === ATA_CMD_PACKET ? 0 : 4,
        //0, 0, // no DMA

        0, 0,
        // 65
        30, 0, 30, 0, 30, 0, 30, 0, 0, 0,
        // 70
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 75
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 80
        0x7E, 0, 0, 0, 0, 0, 0, 0x74, 0, 0x40,
        // 85
        0, 0x40, 0, 0x74, 0, 0x40, 0, 0, 0, 0,
        // 90
        0, 0, 0, 0, 0, 0, 1, 0x60, 0, 0,
        // 95
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        // 100
        this.sector_count & 0xFF, this.sector_count >> 8 & 0xFF,
        this.sector_count >> 16 & 0xFF, this.sector_count >> 24 & 0xFF,
    ]);

    this.data_length = 512;
    this.data_end = 512;
};

IDEInterface.prototype.data_allocate = function(len)
{
    this.data_allocate_noclear(len);
    this.data32.fill(0, 0, len + 3 >> 2);
};

IDEInterface.prototype.data_allocate_noclear = function(len)
{
    if(this.data.length < len)
    {
        this.data = new Uint8Array(len + 3 & ~3);
        this.data16 = new Uint16Array(this.data.buffer);
        this.data32 = new Int32Array(this.data.buffer);
    }

    this.data_length = len;
    this.data_pointer = 0;
};

IDEInterface.prototype.data_set = function(data)
{
    this.data_allocate_noclear(data.length);
    this.data.set(data);
};

IDEInterface.prototype.report_read_start = function()
{
    this.bus.send("ide-read-start");
};

IDEInterface.prototype.report_read_end = function(byte_count)
{
    const sector_count = byte_count / this.sector_size | 0;
    this.bus.send("ide-read-end", [this.channel_nr, byte_count, sector_count]);
};

IDEInterface.prototype.report_write = function(byte_count)
{
    const sector_count = byte_count / this.sector_size | 0;
    this.bus.send("ide-write-end", [this.channel_nr, byte_count, sector_count]);
};

IDEInterface.prototype.read_buffer = function(start, length, callback)
{
    const id = this.last_io_id++;
    this.in_progress_io_ids.add(id);

    this.buffer.get(start, length, data =>
    {
        if(this.cancelled_io_ids.delete(id))
        {
            dbg_assert(!this.in_progress_io_ids.has(id));
            return;
        }

        const removed = this.in_progress_io_ids.delete(id);
        dbg_assert(removed);

        callback(data);
    });
};

IDEInterface.prototype.cancel_io_operations = function()
{
    for(const id of this.in_progress_io_ids)
    {
        this.cancelled_io_ids.add(id);
    }
    this.in_progress_io_ids.clear();
};

IDEInterface.prototype.get_state = function()
{
    var state = [];
    state[0] = this.sector_count_reg;
    state[1] = this.cylinder_count;
    state[2] = this.lba_high_reg;
    state[3] = this.lba_mid_reg;
    state[4] = this.data_pointer;
    state[5] = 0;
    state[6] = 0;
    state[7] = 0;
    state[8] = 0;
    state[9] = this.device_reg;
    state[10] = this.error_reg;
    state[11] = this.head;
    state[12] = this.head_count;
    state[13] = this.is_atapi;
    state[14] = this.is_lba;
    state[15] = this.features_reg;
    state[16] = this.data;
    state[17] = this.data_length;
    state[18] = this.lba_low_reg;
    state[19] = this.sector_count;
    state[20] = this.sector_size;
    state[21] = this.sectors_per_drq;
    state[22] = this.sectors_per_track;
    state[23] = this.status_reg;
    state[24] = this.write_dest;
    state[25] = this.current_command;
    state[26] = this.data_end;
    state[27] = this.current_atapi_command;
    state[28] = this.buffer;
    state[29] = this.drive_connected;
    state[30] = this.media_changed;
    return state;
};

IDEInterface.prototype.set_state = function(state)
{
    this.sector_count_reg = state[0];
    this.cylinder_count = state[1];
    this.lba_high_reg = state[2];
    this.lba_mid_reg = state[3];
    this.data_pointer = state[4];

    this.device_reg = state[9];
    this.error_reg = state[10];
    this.head = state[11];
    this.head_count = state[12];
    this.is_atapi = state[13];
    this.is_lba = state[14];
    this.features_reg = state[15];
    this.data = state[16];
    this.data_length = state[17];
    this.lba_low_reg = state[18];
    this.sector_count = state[19];
    this.sector_size = state[20];
    this.sectors_per_drq = state[21];
    this.sectors_per_track = state[22];
    this.status_reg = state[23];
    this.write_dest = state[24];
    this.current_command = state[25];

    this.data_end = state[26];
    this.current_atapi_command = state[27];

    this.data16 = new Uint16Array(this.data.buffer);
    this.data32 = new Int32Array(this.data.buffer);

    this.buffer && this.buffer.set_state(state[28]);

    this.drive_connected = state[29] === undefined ? this.is_atapi || this.buffer : state[29];
    this.media_changed = state[30] === undefined ? false : state[30];
};
