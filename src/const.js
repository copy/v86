"use strict";

var
/** @const */ LOG_ALL = -1,
/** @const */ LOG_NONE = 0,

/** @const */ LOG_OTHER =  0x0000001,
/** @const */ LOG_CPU =    0x0000002,
/** @const */ LOG_FPU =    0x0000004,
/** @const */ LOG_MEM =    0x0000008,
/** @const */ LOG_DMA =    0x0000010,
/** @const */ LOG_IO =     0x0000020,
/** @const */ LOG_PS2 =    0x0000040,
/** @const */ LOG_PIC =    0x0000080,
/** @const */ LOG_VGA =    0x0000100,
/** @const */ LOG_PIT =    0x0000200,
/** @const */ LOG_MOUSE =  0x0000400,
/** @const */ LOG_PCI =    0x0000800,
/** @const */ LOG_BIOS =   0x0001000,
/** @const */ LOG_FLOPPY = 0x0002000,
/** @const */ LOG_SERIAL = 0x0004000,
/** @const */ LOG_DISK =   0x0008000,
/** @const */ LOG_RTC =    0x0010000,
// unused                  0x0020000,
/** @const */ LOG_ACPI =   0x0040000,
/** @const */ LOG_APIC =   0x0080000,
/** @const */ LOG_NET =    0x0100000,
/** @const */ LOG_VIRTIO = 0x0200000,
/** @const */ LOG_9P =     0x0400000,
/** @const */ LOG_SB16 =   0x0800000,
/** @const */ LOG_FETCH =  0x1000000;


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
    [LOG_ACPI, "ACPI"],
    [LOG_APIC, "APIC"],
    [LOG_NET, "NET"],
    [LOG_VIRTIO, "VIO"],
    [LOG_9P, "9P"],
    [LOG_SB16, "SB16"],
    [LOG_FETCH, "FETC"],
];

var

// flags register bitflags
/** @const */ FLAG_CARRY = 1,
/** @const */ FLAG_PARITY = 4,
/** @const */ FLAG_ADJUST = 16,
/** @const */ FLAG_ZERO = 64,
/** @const */ FLAG_SIGN = 128,
/** @const */ FLAG_TRAP = 256,
/** @const */ FLAG_INTERRUPT = 512,
/** @const */ FLAG_DIRECTION = 1024,
/** @const */ FLAG_OVERFLOW = 2048,
/** @const */ FLAG_IOPL = 1 << 12 | 1 << 13,
/** @const */ FLAG_NT = 1 << 14,
/** @const */ FLAG_RF = 1 << 16,
/** @const */ FLAG_VM = 1 << 17,
/** @const */ FLAG_AC = 1 << 18,
/** @const */ FLAG_VIF = 1 << 19,
/** @const */ FLAG_VIP = 1 << 20,
/** @const */ FLAG_ID = 1 << 21,

/**
 * default values of reserved flags bits
 * @const
 */
FLAGS_DEFAULT = 1 << 1,


/** @const */ REG_EAX = 0,
/** @const */ REG_ECX = 1,
/** @const */ REG_EDX = 2,
/** @const */ REG_EBX = 3,
/** @const */ REG_ESP = 4,
/** @const */ REG_EBP = 5,
/** @const */ REG_ESI = 6,
/** @const */ REG_EDI = 7,

/** @const */ REG_ES = 0,
/** @const */ REG_CS = 1,
/** @const */ REG_SS = 2,
/** @const */ REG_DS = 3,
/** @const */ REG_FS = 4,
/** @const */ REG_GS = 5,

/** @const */ REG_LDTR = 7; // local descriptor table register

var
    /**
     * The minimum number of bytes that can be memory-mapped
     * by one device.
     *
     * @const
     */
    MMAP_BLOCK_BITS = 17,
    /** @const */
    MMAP_BLOCK_SIZE = 1 << MMAP_BLOCK_BITS,
    /** @const */
    MMAP_MAX = 0x100000000;

/** @const */
var CR0_PG = 1 << 31;
/** @const */
var CR4_PAE = 1 << 5;


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
