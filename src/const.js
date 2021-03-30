"use strict";

var
/** @const */ LOG_ALL = -1,
/** @const */ LOG_NONE = 0,

/** @const */ LOG_OTHER =  0x000001,
/** @const */ LOG_CPU =    0x000002,
/** @const */ LOG_FPU =    0x000004,
/** @const */ LOG_MEM =    0x000008,
/** @const */ LOG_DMA =    0x000010,
/** @const */ LOG_IO =     0x000020,
/** @const */ LOG_PS2 =    0x000040,
/** @const */ LOG_PIC =    0x000080,
/** @const */ LOG_VGA =    0x000100,
/** @const */ LOG_PIT =    0x000200,
/** @const */ LOG_MOUSE =  0x000400,
/** @const */ LOG_PCI =    0x000800,
/** @const */ LOG_BIOS =   0x001000,
/** @const */ LOG_FLOPPY = 0x002000,
/** @const */ LOG_SERIAL = 0x004000,
/** @const */ LOG_DISK =   0x008000,
/** @const */ LOG_RTC =    0x010000,
/** @const */ LOG_HPET =   0x020000,
/** @const */ LOG_ACPI =   0x040000,
/** @const */ LOG_APIC =   0x080000,
/** @const */ LOG_NET =    0x100000,
/** @const */ LOG_VIRTIO = 0x200000,
/** @const */ LOG_9P =     0x400000,
/** @const */ LOG_SB16 =   0x800000;


/**
 * @const
 * @type {Array<Array<string|number>>}
 */
var LOG_NAMES = [
    [1, ""],
    [LOG_CPU, "CPU"],
    [LOG_DISK, "DISK"],
    [LOG_FPU, "FPU"],
    [LOG_MEM, "MEM"],
    [LOG_DMA, "DMA"],
    [LOG_IO, "IO"],
    [LOG_PS2, "PS2"],
    [LOG_PIC, "PIC"],
    [LOG_VGA, "VGA"],
    [LOG_PIT, "PIT"],
    [LOG_MOUSE, "MOUS"],
    [LOG_PCI, "PCI"],
    [LOG_BIOS, "BIOS"],
    [LOG_FLOPPY, "FLOP"],
    [LOG_SERIAL, "SERI"],
    [LOG_RTC, "RTC"],
    [LOG_HPET, "HPET"],
    [LOG_ACPI, "ACPI"],
    [LOG_APIC, "APIC"],
    [LOG_NET, "NET"],
    [LOG_VIRTIO, "VIO"],
    [LOG_9P, "9P"],
    [LOG_SB16, "SB16"]
];

var

// flags register bitflags
/** @const */ flag_carry = 1,
/** @const */ flag_parity = 4,
/** @const */ flag_adjust = 16,
/** @const */ flag_zero = 64,
/** @const */ flag_sign = 128,
/** @const */ flag_trap = 256,
/** @const */ flag_interrupt = 512,
/** @const */ flag_direction = 1024,
/** @const */ flag_overflow = 2048,
/** @const */ flag_iopl = 1 << 12 | 1 << 13,
/** @const */ flag_nt = 1 << 14,
/** @const */ flag_rf = 1 << 16,
/** @const */ flag_vm = 1 << 17,
/** @const */ flag_ac = 1 << 18,
/** @const */ flag_vif = 1 << 19,
/** @const */ flag_vip = 1 << 20,
/** @const */ flag_id = 1 << 21,

/**
 * default values of reserved flags bits
 * @const
 */
flags_default = 1 << 1,


/** @const */ reg_eax = 0,
/** @const */ reg_ecx = 1,
/** @const */ reg_edx = 2,
/** @const */ reg_ebx = 3,
/** @const */ reg_esp = 4,
/** @const */ reg_ebp = 5,
/** @const */ reg_esi = 6,
/** @const */ reg_edi = 7,

/** @const */ reg_es = 0,
/** @const */ reg_cs = 1,
/** @const */ reg_ss = 2,
/** @const */ reg_ds = 3,
/** @const */ reg_fs = 4,
/** @const */ reg_gs = 5,

/** @const */ reg_ldtr = 7; // local descriptor table register

var
    /**
     * The minimum number of bytes that can be memory-mapped
     * by one device.
     *
     * @const
     */
    MMAP_BLOCK_BITS = 17,
    /** @const */
    MMAP_BLOCK_SIZE = 1 << MMAP_BLOCK_BITS;

/** @const */
var CR0_PG = 1 << 31;


// https://github.com/qemu/seabios/blob/14221cd86eadba82255fdc55ed174d401c7a0a04/src/fw/paravirt.c#L205-L219

/** @const */ var FW_CFG_SIGNATURE = 0x00;
/** @const */ var FW_CFG_ID = 0x01;
/** @const */ var FW_CFG_RAM_SIZE = 0x03;
/** @const */ var FW_CFG_NB_CPUS = 0x05;
/** @const */ var FW_CFG_MAX_CPUS = 0x0F;
/** @const */ var FW_CFG_NUMA = 0x0D;
/** @const */ var FW_CFG_FILE_DIR = 0x19;

/** @const */ var FW_CFG_CUSTOM_START = 0x8000;
// This value is specific to v86, choosen to hopefully not collide with other indexes
/** @const */ var FW_CFG_FILE_START = 0xC000;

/** @const */ var FW_CFG_SIGNATURE_QEMU = 0x554D4551;


// See same constant in jit.rs
/** @const */
var WASM_TABLE_SIZE = 900;

/** @const */
var WASM_TABLE_OFFSET = 1024;


/** @const */
var MIXER_CHANNEL_LEFT = 0;
/** @const */
var MIXER_CHANNEL_RIGHT = 1;
/** @const */
var MIXER_CHANNEL_BOTH = 2;
/** @const */
var MIXER_SRC_MASTER = 0;
/** @const */
var MIXER_SRC_PCSPEAKER = 1;
/** @const */
var MIXER_SRC_DAC = 2;
