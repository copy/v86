"use strict";

/** @define {boolean} */
var DEBUG = true;

/** @const */
var LOG_TO_FILE = false;

/** @const */
var LOG_ALL_IO = false;


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
/** @const */ LOG_9P =     0x400000;


var LOG_LEVEL = LOG_ALL & ~LOG_PS2 & ~LOG_PIC & ~LOG_PIT & ~LOG_RTC & ~LOG_VIRTIO & ~LOG_9P &
                          ~LOG_DISK & ~LOG_DMA & ~LOG_VGA & ~LOG_SERIAL & ~LOG_NET;

/** @const */
var CPU_LOG_VERBOSE = false;


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
];

var
/** @const */ TLB_SYSTEM_READ = 1,
/** @const */ TLB_SYSTEM_WRITE = 2,
/** @const */ TLB_USER_READ = 4,
/** @const */ TLB_USER_WRITE = 8;


var
    /** @const */
    ENABLE_HPET = !DEBUG && false,

    /** @const */
    ENABLE_ACPI = !DEBUG && false;

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

/**
 * bitmask to select non-reserved flags bits
 * @const
 */
flags_mask =
    flag_carry | flag_parity | flag_adjust | flag_zero | flag_sign | flag_trap | flag_interrupt |
    flag_direction | flag_overflow | flag_iopl | flag_nt | flag_rf | flag_vm | flag_ac |
    flag_vif | flag_vip | flag_id,


/**
 * all arithmetic flags
 * @const
 */
flags_all = flag_carry | flag_parity | flag_adjust | flag_zero | flag_sign | flag_overflow,


/**
 * opsizes used by get flag functions
 *
 * @const
 */
OPSIZE_8 = 7,
/** @const */
OPSIZE_16 = 15,
/** @const */
OPSIZE_32 = 31,

/** @const */
PSE_ENABLED = 128,

/** @const */ reg_eax = 0,
/** @const */ reg_ecx = 1,
/** @const */ reg_edx = 2,
/** @const */ reg_ebx = 3,
/** @const */ reg_esp = 4,
/** @const */ reg_ebp = 5,
/** @const */ reg_esi = 6,
/** @const */ reg_edi = 7,

/** @const */ reg_ax = 0,
/** @const */ reg_cx = 2,
/** @const */ reg_dx = 4,
/** @const */ reg_bx = 6,
/** @const */ reg_sp = 8,
/** @const */ reg_bp = 10,
/** @const */ reg_si = 12,
/** @const */ reg_di = 14,

/** @const */ reg_al = 0,
/** @const */ reg_cl = 4,
/** @const */ reg_dl = 8,
/** @const */ reg_bl = 12,
/** @const */ reg_ah = 1,
/** @const */ reg_ch = 5,
/** @const */ reg_dh = 9,
/** @const */ reg_bh = 13,


/** @const */ reg_es = 0,
/** @const */ reg_cs = 1,
/** @const */ reg_ss = 2,
/** @const */ reg_ds = 3,
/** @const */ reg_fs = 4,
/** @const */ reg_gs = 5,


/** @const */ reg_tr = 6, // task register
/** @const */ reg_ldtr = 7, // local descriptor table register



/** @const */ LOOP_COUNTER = 11001,
/** @const */ TIME_PER_FRAME = 8;

/** @const */
var OP_TRANSLATION = false;


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
var MEM_PAGE_WRITTEN = 1;


/** @const */
var MAGIC_CPU_EXCEPTION = 0xDEADBEE;


var
    /** @const */
    REPEAT_STRING_PREFIX_NONE = 0,
    /** @const */
    REPEAT_STRING_PREFIX_NZ = 1,
    /** @const */
    REPEAT_STRING_PREFIX_Z = 2;

var
    /** @const */
    CR0_PE = 1,
    /** @const */
    CR0_MP = 1 << 1,
    /** @const */
    CR0_EM = 1 << 2,
    /** @const */
    CR0_TS = 1 << 3,
    /** @const */
    CR0_ET = 1 << 4,
    /** @const */
    CR0_WP = 1 << 16,
    /** @const */
    CR0_NW = 1 << 29,
    /** @const */
    CR0_CD = 1 << 30,
    /** @const */
    CR0_PG = 1 << 31;

var
    /** @const */
    CR4_VME = 1,
    /** @const */
    CR4_PVI = 1 << 1,
    /** @const */
    CR4_TSD = 1 << 2,
    /** @const */
    CR4_PSE = 1 << 4,
    /** @const */
    CR4_PAE = 1 << 5,
    /** @const */
    CR4_PGE = 1 << 7;


// Segment prefixes must not collide with reg_*s variables
// _ZERO is a special zero offset segment
var
    /** @const */
    SEG_PREFIX_NONE = -1,

    /** @const */
    SEG_PREFIX_ZERO = 9;


var
    /** @const */
    IA32_SYSENTER_CS = 0x174,

    // Note: These are wrong in Intel's manuals. Fuck Intel
    /** @const */
    IA32_SYSENTER_ESP = 0x175,

    /** @const */
    IA32_SYSENTER_EIP = 0x176;

/** @const */
var IA32_TIME_STAMP_COUNTER = 0x10;

/** @const */
var IA32_PLATFORM_ID = 0x17;

/** @const */
var IA32_APIC_BASE_MSR = 0x1B;

/** @const */
var IA32_BIOS_SIGN_ID = 0x8B;

/** @const */
var IA32_MISC_ENABLE = 0x1A0;

/** @const */
var IA32_RTIT_CTL = 0x570;

/** @const */
var MSR_SMI_COUNT = 0x34;

/** @const */
var IA32_MCG_CAP = 0x179;

/** @const */
var MSR_PKG_C2_RESIDENCY = 0x60D;



/** @const */
var TSC_RATE = 8 * 1024;



/** @const */ var TSR_BACKLINK = 0x00;
/** @const */ var TSR_CR3 = 0x1C;
/** @const */ var TSR_EIP = 0x20;
/** @const */ var TSR_EFLAGS = 0x24;

/** @const */ var TSR_EAX = 0x28;
/** @const */ var TSR_ECX = 0x2c;
/** @const */ var TSR_EDX = 0x30;
/** @const */ var TSR_EBX = 0x34;
/** @const */ var TSR_ESP = 0x38;
/** @const */ var TSR_EBP = 0x3c;
/** @const */ var TSR_ESI = 0x40;
/** @const */ var TSR_EDI = 0x44;

/** @const */ var TSR_ES = 0x48;
/** @const */ var TSR_CS = 0x4c;
/** @const */ var TSR_SS = 0x50;
/** @const */ var TSR_DS = 0x54;
/** @const */ var TSR_FS = 0x58;
/** @const */ var TSR_GS = 0x5c;
/** @const */ var TSR_LDT = 0x60;


