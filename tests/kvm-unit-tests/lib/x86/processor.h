#ifndef LIBCFLAT_PROCESSOR_H
#define LIBCFLAT_PROCESSOR_H

#include "libcflat.h"
#include "msr.h"
#include <stdint.h>

#ifdef __x86_64__
#  define R "r"
#  define W "q"
#  define S "8"
#else
#  define R "e"
#  define W "l"
#  define S "4"
#endif

#define X86_CR0_PE     0x00000001
#define X86_CR0_MP     0x00000002
#define X86_CR0_TS     0x00000008
#define X86_CR0_WP     0x00010000
#define X86_CR0_AM     0x00040000
#define X86_CR0_PG     0x80000000
#define X86_CR4_TSD    0x00000004
#define X86_CR4_DE     0x00000008
#define X86_CR4_PSE    0x00000010
#define X86_CR4_PAE    0x00000020
#define X86_CR4_VMXE   0x00002000
#define X86_CR4_PCIDE  0x00020000
#define X86_CR4_SMAP   0x00200000
#define X86_CR4_PKE    0x00400000

#define X86_EFLAGS_CF  0x00000001
#define X86_EFLAGS_PF  0x00000004
#define X86_EFLAGS_AF  0x00000010
#define X86_EFLAGS_ZF  0x00000040
#define X86_EFLAGS_SF  0x00000080
#define X86_EFLAGS_OF  0x00000800
#define X86_EFLAGS_AC  0x00040000

#define X86_IA32_EFER          0xc0000080
#define X86_EFER_LMA           (1UL << 8)

struct far_pointer32 {
	u32 offset;
	u16 selector;
} __attribute__((packed));

struct descriptor_table_ptr {
    u16 limit;
    ulong base;
} __attribute__((packed));

static inline void barrier(void)
{
    asm volatile ("" : : : "memory");
}

static inline void clac(void)
{
    asm volatile (".byte 0x0f, 0x01, 0xca" : : : "memory");
}

static inline void stac(void)
{
    asm volatile (".byte 0x0f, 0x01, 0xcb" : : : "memory");
}

static inline u16 read_cs(void)
{
    unsigned val;

    asm volatile ("mov %%cs, %0" : "=mr"(val));
    return val;
}

static inline u16 read_ds(void)
{
    unsigned val;

    asm volatile ("mov %%ds, %0" : "=mr"(val));
    return val;
}

static inline u16 read_es(void)
{
    unsigned val;

    asm volatile ("mov %%es, %0" : "=mr"(val));
    return val;
}

static inline u16 read_ss(void)
{
    unsigned val;

    asm volatile ("mov %%ss, %0" : "=mr"(val));
    return val;
}

static inline u16 read_fs(void)
{
    unsigned val;

    asm volatile ("mov %%fs, %0" : "=mr"(val));
    return val;
}

static inline u16 read_gs(void)
{
    unsigned val;

    asm volatile ("mov %%gs, %0" : "=mr"(val));
    return val;
}

static inline unsigned long read_rflags(void)
{
	unsigned long f;
	asm volatile ("pushf; pop %0\n\t" : "=rm"(f));
	return f;
}

static inline void write_ds(unsigned val)
{
    asm volatile ("mov %0, %%ds" : : "rm"(val) : "memory");
}

static inline void write_es(unsigned val)
{
    asm volatile ("mov %0, %%es" : : "rm"(val) : "memory");
}

static inline void write_ss(unsigned val)
{
    asm volatile ("mov %0, %%ss" : : "rm"(val) : "memory");
}

static inline void write_fs(unsigned val)
{
    asm volatile ("mov %0, %%fs" : : "rm"(val) : "memory");
}

static inline void write_gs(unsigned val)
{
    asm volatile ("mov %0, %%gs" : : "rm"(val) : "memory");
}

static inline void write_rflags(unsigned long f)
{
    asm volatile ("push %0; popf\n\t" : : "rm"(f));
}

static inline u64 rdmsr(u32 index)
{
    u32 a, d;
    asm volatile ("rdmsr" : "=a"(a), "=d"(d) : "c"(index) : "memory");
    return a | ((u64)d << 32);
}

static inline void wrmsr(u32 index, u64 val)
{
    u32 a = val, d = val >> 32;
    asm volatile ("wrmsr" : : "a"(a), "d"(d), "c"(index) : "memory");
}

static inline uint64_t rdpmc(uint32_t index)
{
    uint32_t a, d;
    asm volatile ("rdpmc" : "=a"(a), "=d"(d) : "c"(index));
    return a | ((uint64_t)d << 32);
}

static inline void write_cr0(ulong val)
{
    asm volatile ("mov %0, %%cr0" : : "r"(val) : "memory");
}

static inline ulong read_cr0(void)
{
    ulong val;
    asm volatile ("mov %%cr0, %0" : "=r"(val) : : "memory");
    return val;
}

static inline void write_cr2(ulong val)
{
    asm volatile ("mov %0, %%cr2" : : "r"(val) : "memory");
}

static inline ulong read_cr2(void)
{
    ulong val;
    asm volatile ("mov %%cr2, %0" : "=r"(val) : : "memory");
    return val;
}

static inline void write_cr3(ulong val)
{
    asm volatile ("mov %0, %%cr3" : : "r"(val) : "memory");
}

static inline ulong read_cr3(void)
{
    ulong val;
    asm volatile ("mov %%cr3, %0" : "=r"(val) : : "memory");
    return val;
}

static inline void write_cr4(ulong val)
{
    asm volatile ("mov %0, %%cr4" : : "r"(val) : "memory");
}

static inline ulong read_cr4(void)
{
    ulong val;
    asm volatile ("mov %%cr4, %0" : "=r"(val) : : "memory");
    return val;
}

static inline void write_cr8(ulong val)
{
    asm volatile ("mov %0, %%cr8" : : "r"(val) : "memory");
}

static inline ulong read_cr8(void)
{
    ulong val;
    asm volatile ("mov %%cr8, %0" : "=r"(val) : : "memory");
    return val;
}

static inline void lgdt(const struct descriptor_table_ptr *ptr)
{
    asm volatile ("lgdt %0" : : "m"(*ptr));
}

static inline void sgdt(struct descriptor_table_ptr *ptr)
{
    asm volatile ("sgdt %0" : "=m"(*ptr));
}

static inline void lidt(const struct descriptor_table_ptr *ptr)
{
    asm volatile ("lidt %0" : : "m"(*ptr));
}

static inline void sidt(struct descriptor_table_ptr *ptr)
{
    asm volatile ("sidt %0" : "=m"(*ptr));
}

static inline void lldt(unsigned val)
{
    asm volatile ("lldt %0" : : "rm"(val));
}

static inline u16 sldt(void)
{
    u16 val;
    asm volatile ("sldt %0" : "=rm"(val));
    return val;
}

static inline void ltr(u16 val)
{
    asm volatile ("ltr %0" : : "rm"(val));
}

static inline u16 str(void)
{
    u16 val;
    asm volatile ("str %0" : "=rm"(val));
    return val;
}

static inline void write_dr6(ulong val)
{
    asm volatile ("mov %0, %%dr6" : : "r"(val) : "memory");
}

static inline ulong read_dr6(void)
{
    ulong val;
    asm volatile ("mov %%dr6, %0" : "=r"(val));
    return val;
}

static inline void write_dr7(ulong val)
{
    asm volatile ("mov %0, %%dr7" : : "r"(val) : "memory");
}

static inline ulong read_dr7(void)
{
    ulong val;
    asm volatile ("mov %%dr7, %0" : "=r"(val));
    return val;
}

struct cpuid { u32 a, b, c, d; };

static inline struct cpuid raw_cpuid(u32 function, u32 index)
{
    struct cpuid r;
    asm volatile ("cpuid"
                  : "=a"(r.a), "=b"(r.b), "=c"(r.c), "=d"(r.d)
                  : "0"(function), "2"(index));
    return r;
}

static inline struct cpuid cpuid_indexed(u32 function, u32 index)
{
    u32 level = raw_cpuid(function & 0xf0000000, 0).a;
    if (level < function)
        return (struct cpuid) { 0, 0, 0, 0 };
    return raw_cpuid(function, index);
}

static inline struct cpuid cpuid(u32 function)
{
    return cpuid_indexed(function, 0);
}

static inline u8 cpuid_maxphyaddr(void)
{
    if (raw_cpuid(0x80000000, 0).a < 0x80000008)
        return 36;
    return raw_cpuid(0x80000008, 0).a & 0xff;
}


static inline void pause(void)
{
    asm volatile ("pause");
}

static inline void cli(void)
{
    asm volatile ("cli");
}

static inline void sti(void)
{
    asm volatile ("sti");
}

static inline unsigned long long rdtsc()
{
	long long r;

#ifdef __x86_64__
	unsigned a, d;

	asm volatile ("rdtsc" : "=a"(a), "=d"(d));
	r = a | ((long long)d << 32);
#else
	asm volatile ("rdtsc" : "=A"(r));
#endif
	return r;
}

static inline unsigned long long rdtscp(u32 *aux)
{
       long long r;

#ifdef __x86_64__
       unsigned a, d;

       asm volatile ("rdtscp" : "=a"(a), "=d"(d), "=c"(*aux));
       r = a | ((long long)d << 32);
#else
       asm volatile ("rdtscp" : "=A"(r), "=c"(*aux));
#endif
       return r;
}

static inline void wrtsc(u64 tsc)
{
	unsigned a = tsc, d = tsc >> 32;

	asm volatile("wrmsr" : : "a"(a), "d"(d), "c"(0x10));
}

static inline void irq_disable(void)
{
    asm volatile("cli");
}

/* Note that irq_enable() does not ensure an interrupt shadow due
 * to the vagaries of compiler optimizations.  If you need the
 * shadow, use a single asm with "sti" and the instruction after it.
 */
static inline void irq_enable(void)
{
    asm volatile("sti");
}

static inline void invlpg(volatile void *va)
{
	asm volatile("invlpg (%0)" ::"r" (va) : "memory");
}

static inline void safe_halt(void)
{
	asm volatile("sti; hlt");
}

static inline u32 read_pkru(void)
{
    unsigned int eax, edx;
    unsigned int ecx = 0;
    unsigned int pkru;

    asm volatile(".byte 0x0f,0x01,0xee\n\t"
                 : "=a" (eax), "=d" (edx)
                 : "c" (ecx));
    pkru = eax;
    return pkru;
}

static inline void write_pkru(u32 pkru)
{
    unsigned int eax = pkru;
    unsigned int ecx = 0;
    unsigned int edx = 0;

    asm volatile(".byte 0x0f,0x01,0xef\n\t"
        : : "a" (eax), "c" (ecx), "d" (edx));
}

#endif
