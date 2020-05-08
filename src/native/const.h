#ifndef DEBUG
#define DEBUG true
#endif

#define FLAG_CARRY 1
#define FLAG_PARITY 4
#define FLAG_ADJUST 16
#define FLAG_ZERO 64
#define FLAG_SIGN 128
#define FLAG_TRAP 256
#define FLAG_INTERRUPT 512
#define FLAG_DIRECTION 1024
#define FLAG_OVERFLOW 2048
#define FLAG_IOPL (1 << 12 | 1 << 13)
#define FLAG_NT (1 << 14)
#define FLAG_RF (1 << 16)
#define FLAG_VM (1 << 17)
#define FLAG_AC (1 << 18)
#define FLAG_VIF (1 << 19)
#define FLAG_VIP (1 << 20)
#define FLAG_ID (1 << 21)
#define FLAGS_DEFAULT (1 << 1)

#define FLAGS_MASK ( \
    FLAG_CARRY | FLAG_PARITY | FLAG_ADJUST | FLAG_ZERO | FLAG_SIGN | FLAG_TRAP | FLAG_INTERRUPT | \
    FLAG_DIRECTION | FLAG_OVERFLOW | FLAG_IOPL | FLAG_NT | FLAG_RF | FLAG_VM | FLAG_AC | \
    FLAG_VIF | FLAG_VIP | FLAG_ID)

#define FLAGS_ALL (FLAG_CARRY | FLAG_PARITY | FLAG_ADJUST | FLAG_ZERO | FLAG_SIGN | FLAG_OVERFLOW)

#define OPSIZE_8 7
#define OPSIZE_16 15
#define OPSIZE_32 31

#define EAX 0
#define ECX 1
#define EDX 2
#define EBX 3
#define ESP 4
#define EBP 5
#define ESI 6
#define EDI 7

#define AX 0
#define CX 2
#define DX 4
#define BX 6
#define SP 8
#define BP 10
#define SI 12
#define DI 14

#define AL 0
#define CL 4
#define DL 8
#define BL 12
#define AH 1
#define CH 5
#define DH 9
#define BH 13

#define ES 0
#define CS 1
#define SS 2
#define DS 3
#define FS 4
#define GS 5

#define TR 6
#define LDTR 7


#define TLB_SYSTEM_READ 1
#define TLB_SYSTEM_WRITE 2
#define TLB_USER_READ 4
#define TLB_USER_WRITE 8


#define PSE_ENABLED 128

#define MMAP_BLOCK_BITS 17
#define MMAP_BLOCK_SIZE = (1 << MMAP_BLOCK_BITS)

#define CR0_PE 1
#define CR0_MP (1 << 1)
#define CR0_EM (1 << 2)
#define CR0_TS (1 << 3)
#define CR0_ET (1 << 4)
#define CR0_WP (1 << 16)
#define CR0_NW (1 << 29)
#define CR0_CD (1 << 30)
#define CR0_PG (1 << 31)

#define CR4_VME (1)
#define CR4_PVI (1 << 1)
#define CR4_TSD (1 << 2)
#define CR4_PSE (1 << 4)
#define CR4_DE (1 << 3)
#define CR4_PAE (1 << 5)
#define CR4_PGE (1 << 7)


#define IA32_SYSENTER_CS 0x174
#define IA32_SYSENTER_ESP 0x175
#define IA32_SYSENTER_EIP 0x176

#define IA32_TIME_STAMP_COUNTER 0x10
#define IA32_PLATFORM_ID 0x17
#define IA32_APIC_BASE_MSR 0x1B
#define IA32_BIOS_SIGN_ID 0x8B
#define IA32_MISC_ENABLE 0x1A0
#define IA32_RTIT_CTL 0x570
#define MSR_SMI_COUNT 0x34
#define IA32_MCG_CAP 0x179
#define IA32_KERNEL_GS_BASE 0xC0000101
#define MSR_PKG_C2_RESIDENCY 0x60D

#define IA32_APIC_BASE_BSP (1 << 8)
#define IA32_APIC_BASE_EXTD (1 << 10)
#define IA32_APIC_BASE_EN (1 << 11)


// Note: Duplicated in apic.js
#define APIC_ADDRESS ((int32_t)0xFEE00000)


// Segment prefixes must not collide with reg_*s variables
// _ZERO is a special zero offset segment
#define SEG_PREFIX_NONE (-1)
#define SEG_PREFIX_ZERO 7

#define PREFIX_MASK_REP 0b11000
#define PREFIX_REPZ 0b01000
#define PREFIX_REPNZ 0b10000

#define PREFIX_MASK_SEGMENT 0b111
#define PREFIX_MASK_OPSIZE 0b100000
#define PREFIX_MASK_ADDRSIZE 0b1000000

// aliases
#define PREFIX_F2 PREFIX_REPNZ
#define PREFIX_F3 PREFIX_REPZ
#define PREFIX_66 PREFIX_MASK_OPSIZE


/**
 * How many cycles the CPU does at a time before running hardware timers
 */
#define LOOP_COUNTER 20011

#define TSC_RATE (8 * 1024)

#define LOG_CPU    0x000002
#define CPU_LOG_VERBOSE    false
#define ENABLE_ACPI    false

#define A20_MASK (~(1 << 20))
#define A20_MASK16 (~(1 << (20 - 1)))
#define A20_MASK32 (~(1 << (20 - 2)))

#define USE_A20 false

#define MXCSR_MASK (0xFFFF & ~(1 << 6))

// Mask used to map physical address to index in cache array
#define JIT_PHYS_MASK 0xFFFF

#define CACHE_LEN 0x10000
#define HASH_PRIME 6151
#define JIT_THRESHOLD 10000
// XXX: Consider making this the same as page size (12) during perf testing
#define DIRTY_ARR_SHIFT 16
#define MAX_INSTR_LEN 15
#define MAX_BLOCK_LENGTH ((1 << DIRTY_ARR_SHIFT) - MAX_INSTR_LEN)

#define ENABLE_JIT 0
#define ENABLE_PROFILER 0
