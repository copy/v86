#pragma once

#include <stdint.h>

extern const int32_t FLAG_CARRY;
extern const int32_t FLAG_PARITY;
extern const int32_t FLAG_ADJUST;
extern const int32_t FLAG_ZERO;
extern const int32_t FLAG_SIGN;
extern const int32_t FLAG_TRAP;
extern const int32_t FLAG_INTERRUPT;
extern const int32_t FLAG_DIRECTION;
extern const int32_t FLAG_OVERFLOW;
extern const int32_t FLAG_IOPL;
extern const int32_t FLAG_NT;
extern const int32_t FLAG_RF;
extern const int32_t FLAG_VM;
extern const int32_t FLAG_AC;
extern const int32_t FLAG_VIF;
extern const int32_t FLAG_VIP;
extern const int32_t FLAG_ID;
extern const int32_t FLAGS_DEFAULT;

extern const int32_t FLAGS_MASK;

extern const int32_t FLAGS_ALL;

extern const int32_t OPSIZE_8;
extern const int32_t OPSIZE_16;
extern const int32_t OPSIZE_32;

extern const int32_t EAX;
extern const int32_t ECX;
extern const int32_t EDX;
extern const int32_t EBX;
extern const int32_t ESP;
extern const int32_t EBP;
extern const int32_t ESI;
extern const int32_t EDI;

extern const int32_t AX;
extern const int32_t CX;
extern const int32_t DX;
extern const int32_t BX;
extern const int32_t SP;
extern const int32_t BP;
extern const int32_t SI;
extern const int32_t DI;

extern const int32_t AL;
extern const int32_t CL;
extern const int32_t DL;
extern const int32_t BL;
extern const int32_t AH;
extern const int32_t CH;
extern const int32_t DH;
extern const int32_t BH;

extern const int32_t ES;
extern const int32_t CS;
extern const int32_t SS;
extern const int32_t DS;
extern const int32_t FS;
extern const int32_t GS;

extern const int32_t TR;
extern const int32_t LDTR;


extern const int32_t PAGE_TABLE_PRESENT_MASK;
extern const int32_t PAGE_TABLE_RW_MASK;
extern const int32_t PAGE_TABLE_USER_MASK;
extern const int32_t PAGE_TABLE_ACCESSED_MASK;
extern const int32_t PAGE_TABLE_DIRTY_MASK;
extern const int32_t PAGE_TABLE_PSE_MASK;
extern const int32_t PAGE_TABLE_GLOBAL_MASK;

extern const int32_t MMAP_BLOCK_BITS;
extern const int32_t MMAP_BLOCK_SIZE;

extern const int32_t CR0_PE;
extern const int32_t CR0_MP;
extern const int32_t CR0_EM;
extern const int32_t CR0_TS;
extern const int32_t CR0_ET;
extern const int32_t CR0_WP;
extern const int32_t CR0_NW;
extern const int32_t CR0_CD;
extern const int32_t CR0_PG;

extern const int32_t CR4_VME;
extern const int32_t CR4_PVI;
extern const int32_t CR4_TSD;
extern const int32_t CR4_PSE;
extern const int32_t CR4_DE;
extern const int32_t CR4_PAE;
extern const int32_t CR4_PGE;


extern const int32_t IA32_SYSENTER_CS;
extern const int32_t IA32_SYSENTER_ESP;
extern const int32_t IA32_SYSENTER_EIP;

extern const int32_t IA32_TIME_STAMP_COUNTER;
extern const int32_t IA32_PLATFORM_ID;
extern const int32_t IA32_APIC_BASE_MSR;
extern const int32_t IA32_BIOS_SIGN_ID;
extern const int32_t MSR_PLATFORM_INFO;
extern const int32_t MSR_MISC_FEATURE_ENABLES;
extern const int32_t IA32_MISC_ENABLE;
extern const int32_t IA32_RTIT_CTL;
extern const int32_t MSR_SMI_COUNT;
extern const int32_t IA32_MCG_CAP;
extern const int32_t IA32_KERNEL_GS_BASE;
extern const int32_t MSR_PKG_C2_RESIDENCY;

extern const int32_t IA32_APIC_BASE_BSP;
extern const int32_t IA32_APIC_BASE_EXTD;
extern const int32_t IA32_APIC_BASE_EN;


// Note: Duplicated in apic.js
extern const int32_t APIC_ADDRESS;


// Segment prefixes must not collide with reg_*s variables
// _ZERO is a special zero offset segment
extern const int32_t SEG_PREFIX_NONE;
extern const int32_t SEG_PREFIX_ZERO;

extern const int32_t PREFIX_MASK_REP;
extern const int32_t PREFIX_REPZ;
extern const int32_t PREFIX_REPNZ;

extern const int32_t PREFIX_MASK_SEGMENT;
extern const int32_t PREFIX_MASK_OPSIZE;
extern const int32_t PREFIX_MASK_ADDRSIZE;

// aliases
extern const int32_t PREFIX_F2;
extern const int32_t PREFIX_F3;
extern const int32_t PREFIX_66;

extern const int32_t LOG_CPU;

extern const int32_t A20_MASK;
extern const int32_t A20_MASK16;
extern const int32_t A20_MASK32;

extern const int32_t MXCSR_MASK;
