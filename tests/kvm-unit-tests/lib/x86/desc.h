#ifndef __IDT_TEST__
#define __IDT_TEST__

#include <setjmp.h>

void setup_idt(void);
void setup_alt_stack(void);

struct ex_regs {
    unsigned long rax, rcx, rdx, rbx;
    unsigned long dummy, rbp, rsi, rdi;
#ifdef __x86_64__
    unsigned long r8, r9, r10, r11;
    unsigned long r12, r13, r14, r15;
#endif
    unsigned long vector;
    unsigned long error_code;
    unsigned long rip;
    unsigned long cs;
    unsigned long rflags;
};

typedef void (*handler)(struct ex_regs *regs);

typedef struct {
	u16 prev;
	u16 res1;
	u32 esp0;
	u16 ss0;
	u16 res2;
	u32 esp1;
	u16 ss1;
	u16 res3;
	u32 esp2;
	u16 ss2;
	u16 res4;
	u32 cr3;
	u32 eip;
	u32 eflags;
	u32 eax, ecx, edx, ebx, esp, ebp, esi, edi;
	u16 es;
	u16 res5;
	u16 cs;
	u16 res6;
	u16 ss;
	u16 res7;
	u16 ds;
	u16 res8;
	u16 fs;
	u16 res9;
	u16 gs;
	u16 res10;
	u16 ldt;
	u16 res11;
	u16 t:1;
	u16 res12:15;
	u16 iomap_base;
} tss32_t;

typedef struct  __attribute__((packed)) {
	u32 res1;
	u64 rsp0;
	u64 rsp1;
	u64 rsp2;
	u64 res2;
	u64 ist1;
	u64 ist2;
	u64 ist3;
	u64 ist4;
	u64 ist5;
	u64 ist6;
	u64 ist7;
	u64 res3;
	u16 res4;
	u16 iomap_base;
} tss64_t;

#define ASM_TRY(catch)                                  \
    "movl $0, %%gs:4 \n\t"                              \
    ".pushsection .data.ex \n\t"                        \
    ".quad 1111f, " catch "\n\t"                        \
    ".popsection \n\t"                                  \
    "1111:"

#define DB_VECTOR   1
#define BP_VECTOR   3
#define UD_VECTOR   6
#define GP_VECTOR   13

/*
 * selector     32-bit                        64-bit
 * 0x00         NULL descriptor               NULL descriptor
 * 0x08         ring-0 code segment (32-bit)  ring-0 code segment (64-bit)
 * 0x10         ring-0 data segment (32-bit)  ring-0 data segment (32/64-bit)
 * 0x18         ring-0 code segment (P=0)     ring-0 code segment (64-bit, P=0)
 * 0x20         intr_alt_stack TSS            ring-0 code segment (32-bit)
 * 0x28         ring-0 code segment (16-bit)  same
 * 0x30         ring-0 data segment (16-bit)  same
 * 0x38 (0x3b)  ring-3 code segment (32-bit)  same
 * 0x40 (0x43)  ring-3 data segment (32-bit)  ring-3 data segment (32/64-bit)
 * 0x48 (0x4b)  **unused**                    ring-3 code segment (64-bit)
 * 0x50--0x78   free to use for test cases    same
 * 0x80         primary TSS (CPU 0)           same
 *
 * Note that the same segment can be used for 32-bit and 64-bit data segments
 * (the L bit is only defined for code segments)
 *
 * Selectors 0x08-0x10 and 0x3b-0x4b are set up for use with the SYSCALL
 * and SYSRET instructions.
 */

#define KERNEL_CS   0x08
#define KERNEL_DS   0x10
#define NP_SEL      0x18
#ifdef __x86_64__
#define KERNEL_CS32 0x20
#else
#define TSS_INTR    0x20
#endif
#define KERNEL_CS16 0x28
#define KERNEL_DS16 0x30
#define USER_CS32   0x3b
#define USER_DS     0x43
#ifdef __x86_64__
#define USER_CS64   0x4b
#endif

/* Synonyms */
#define KERNEL_DS32 KERNEL_DS
#define USER_DS32   USER_DS

#ifdef __x86_64__
#define KERNEL_CS64 KERNEL_CS
#define USER_CS     USER_CS64
#define KERNEL_DS64 KERNEL_DS
#define USER_DS64   USER_DS
#else
#define KERNEL_CS32 KERNEL_CS
#define USER_CS     USER_CS32
#endif

#define FIRST_SPARE_SEL 0x50
#define TSS_MAIN 0x80

typedef struct {
    unsigned short offset0;
    unsigned short selector;
    unsigned short ist : 3;
    unsigned short : 5;
    unsigned short type : 4;
    unsigned short : 1;
    unsigned short dpl : 2;
    unsigned short p : 1;
    unsigned short offset1;
#ifdef __x86_64__
    unsigned offset2;
    unsigned reserved;
#endif
} idt_entry_t;

typedef struct {
	u16 limit_low;
	u16 base_low;
	u8 base_middle;
	u8 access;
	u8 granularity;
	u8 base_high;
} gdt_entry_t;

extern idt_entry_t boot_idt[256];

#ifndef __x86_64__
extern gdt_entry_t gdt32[];
extern tss32_t tss;
extern tss32_t tss_intr;
void set_gdt_task_gate(u16 tss_sel, u16 sel);
void set_idt_task_gate(int vec, u16 sel);
void set_intr_task_gate(int vec, void *fn);
void setup_tss32(void);
#else
extern tss64_t tss;
#endif

unsigned exception_vector(void);
unsigned exception_error_code(void);
bool exception_rflags_rf(void);
void set_idt_entry(int vec, void *addr, int dpl);
void set_idt_sel(int vec, u16 sel);
void set_idt_dpl(int vec, u16 dpl);
void set_gdt_entry(int sel, u32 base,  u32 limit, u8 access, u8 gran);
void set_intr_alt_stack(int e, void *fn);
void print_current_tss_info(void);
handler handle_exception(u8 v, handler fn);

bool test_for_exception(unsigned int ex, void (*trigger_func)(void *data),
			void *data);
void __set_exception_jmpbuf(jmp_buf *addr);
#define set_exception_jmpbuf(jmpbuf) \
	(setjmp(jmpbuf) ? : (__set_exception_jmpbuf(&(jmpbuf)), 0))

#endif
