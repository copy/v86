export const
    LOG_ALL = -1,
    LOG_NONE = 0,

    LOG_OTHER =  0x0000001,
    LOG_CPU =    0x0000002,
    LOG_FPU =    0x0000004,
    LOG_MEM =    0x0000008,
    LOG_DMA =    0x0000010,
    LOG_IO =     0x0000020,
    LOG_PS2 =    0x0000040,
    LOG_PIC =    0x0000080,
    LOG_VGA =    0x0000100,
    LOG_PIT =    0x0000200,
    LOG_MOUSE =  0x0000400,
    LOG_PCI =    0x0000800,
    LOG_BIOS =   0x0001000,
    LOG_FLOPPY = 0x0002000,
    LOG_SERIAL = 0x0004000,
    LOG_DISK =   0x0008000,
    LOG_RTC =    0x0010000,
    // unused    0x0020000,
    LOG_ACPI =   0x0040000,
    LOG_APIC =   0x0080000,
    LOG_NET =    0x0100000,
    LOG_VIRTIO = 0x0200000,
    LOG_9P =     0x0400000,
    LOG_SB16 =   0x0800000,
    LOG_FETCH =  0x1000000;


/**
 * @type {Array<Array<string|number>>}
 */
export const LOG_NAMES = [
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

export const
    // flags register bitflags
    FLAG_CARRY = 1,
    FLAG_PARITY = 4,
    FLAG_ADJUST = 16,
    FLAG_ZERO = 64,
    FLAG_SIGN = 128,
    FLAG_TRAP = 256,
    FLAG_INTERRUPT = 512,
    FLAG_DIRECTION = 1024,
    FLAG_OVERFLOW = 2048,
    FLAG_IOPL = 1 << 12 | 1 << 13,
    FLAG_NT = 1 << 14,
    FLAG_RF = 1 << 16,
    FLAG_VM = 1 << 17,
    FLAG_AC = 1 << 18,
    FLAG_VIF = 1 << 19,
    FLAG_VIP = 1 << 20,
    FLAG_ID = 1 << 21,

    // default values of reserved flags bits
    FLAGS_DEFAULT = 1 << 1,

    REG_EAX = 0,
    REG_ECX = 1,
    REG_EDX = 2,
    REG_EBX = 3,
    REG_ESP = 4,
    REG_EBP = 5,
    REG_ESI = 6,
    REG_EDI = 7,

    REG_ES = 0,
    REG_CS = 1,
    REG_SS = 2,
    REG_DS = 3,
    REG_FS = 4,
    REG_GS = 5,

    REG_LDTR = 7; // local descriptor table register

export const
    // The minimum number of bytes that can be memory-mapped by one device.
    MMAP_BLOCK_BITS = 17,
    MMAP_BLOCK_SIZE = 1 << MMAP_BLOCK_BITS,
    MMAP_MAX = 0x100000000;

export const CR0_PG = 1 << 31;
export const CR4_PAE = 1 << 5;


// https://github.com/qemu/seabios/blob/14221cd86eadba82255fdc55ed174d401c7a0a04/src/fw/paravirt.c#L205-L219

export const FW_CFG_SIGNATURE = 0x00;
export const FW_CFG_ID = 0x01;
export const FW_CFG_RAM_SIZE = 0x03;
export const FW_CFG_NB_CPUS = 0x05;
export const FW_CFG_MAX_CPUS = 0x0F;
export const FW_CFG_NUMA = 0x0D;
export const FW_CFG_FILE_DIR = 0x19;

export const FW_CFG_CUSTOM_START = 0x8000;
// This value is specific to v86, choosen to hopefully not collide with other indexes
export const FW_CFG_FILE_START = 0xC000;
export const FW_CFG_SIGNATURE_QEMU = 0x554D4551;


// See same constant in jit.rs
export const WASM_TABLE_SIZE = 900;

export const WASM_TABLE_OFFSET = 1024;

export const MIXER_CHANNEL_LEFT = 0;
export const MIXER_CHANNEL_RIGHT = 1;
export const MIXER_CHANNEL_BOTH = 2;
export const MIXER_SRC_MASTER = 0;
export const MIXER_SRC_PCSPEAKER = 1;
export const MIXER_SRC_DAC = 2;
