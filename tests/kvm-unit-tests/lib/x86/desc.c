#include "libcflat.h"
#include "desc.h"
#include "processor.h"
#include <setjmp.h>

void set_idt_entry(int vec, void *addr, int dpl)
{
    idt_entry_t *e = &boot_idt[vec];
    memset(e, 0, sizeof *e);
    e->offset0 = (unsigned long)addr;
    e->selector = read_cs();
    e->ist = 0;
    e->type = 14;
    e->dpl = dpl;
    e->p = 1;
    e->offset1 = (unsigned long)addr >> 16;
#ifdef __x86_64__
    e->offset2 = (unsigned long)addr >> 32;
#endif
}

void set_idt_dpl(int vec, u16 dpl)
{
    idt_entry_t *e = &boot_idt[vec];
    e->dpl = dpl;
}

void set_idt_sel(int vec, u16 sel)
{
    idt_entry_t *e = &boot_idt[vec];
    e->selector = sel;
}

struct ex_record {
    unsigned long rip;
    unsigned long handler;
};

extern struct ex_record exception_table_start, exception_table_end;

static const char* exception_mnemonic(int vector)
{
	switch(vector) {
	case 0: return "#DE";
	case 1: return "#DB";
	case 2: return "#NMI";
	case 3: return "#BP";
	case 4: return "#OF";
	case 5: return "#BR";
	case 6: return "#UD";
	case 7: return "#NM";
	case 8: return "#DF";
	case 10: return "#TS";
	case 11: return "#NP";
	case 12: return "#SS";
	case 13: return "#GP";
	case 14: return "#PF";
	case 16: return "#MF";
	case 17: return "#AC";
	case 18: return "#MC";
	case 19: return "#XM";
	default: return "#??";
	}
}

static void unhandled_exception(struct ex_regs *regs, bool cpu)
{
	printf("Unhandled %sexception %ld %s at ip %016lx\n",
	       cpu ? "cpu " : "", regs->vector,
	       exception_mnemonic(regs->vector), regs->rip);
	if (regs->vector == 14)
		printf("PF at 0x%lx addr 0x%lx\n", regs->rip, read_cr2());

	printf("error_code=%04lx      rflags=%08lx      cs=%08lx\n"
	       "rax=%016lx rcx=%016lx rdx=%016lx rbx=%016lx\n"
	       "rbp=%016lx rsi=%016lx rdi=%016lx\n"
#ifdef __x86_64__
	       " r8=%016lx  r9=%016lx r10=%016lx r11=%016lx\n"
	       "r12=%016lx r13=%016lx r14=%016lx r15=%016lx\n"
#endif
	       "cr0=%016lx cr2=%016lx cr3=%016lx cr4=%016lx\n"
#ifdef __x86_64__
	       "cr8=%016lx\n"
#endif
	       ,
	       regs->error_code, regs->rflags, regs->cs,
	       regs->rax, regs->rcx, regs->rdx, regs->rbx,
	       regs->rbp, regs->rsi, regs->rdi,
#ifdef __x86_64__
	       regs->r8, regs->r9, regs->r10, regs->r11,
	       regs->r12, regs->r13, regs->r14, regs->r15,
#endif
	       read_cr0(), read_cr2(), read_cr3(), read_cr4()
#ifdef __x86_64__
	       , read_cr8()
#endif
	);
	dump_frame_stack((void*) regs->rip, (void*) regs->rbp);
	abort();
}

static void check_exception_table(struct ex_regs *regs)
{
    struct ex_record *ex;
    unsigned ex_val;

    ex_val = regs->vector | (regs->error_code << 16) |
		(((regs->rflags >> 16) & 1) << 8);
    asm("mov %0, %%gs:4" : : "r"(ex_val));

    for (ex = &exception_table_start; ex != &exception_table_end; ++ex) {
        if (ex->rip == regs->rip) {
            regs->rip = ex->handler;
            return;
        }
    }
    unhandled_exception(regs, false);
}

static void (*exception_handlers[32])(struct ex_regs *regs);


void handle_exception(u8 v, void (*func)(struct ex_regs *regs))
{
	if (v < 32)
		exception_handlers[v] = func;
}

#ifndef __x86_64__
__attribute__((regparm(1)))
#endif
void do_handle_exception(struct ex_regs *regs)
{
	if (regs->vector < 32 && exception_handlers[regs->vector]) {
		exception_handlers[regs->vector](regs);
		return;
	}
	unhandled_exception(regs, true);
}

#define EX(NAME, N) extern char NAME##_fault;	\
	asm (".pushsection .text \n\t"		\
	     #NAME"_fault: \n\t"		\
	     "push"W" $0 \n\t"			\
	     "push"W" $"#N" \n\t"		\
	     "jmp __handle_exception \n\t"	\
	     ".popsection")

#define EX_E(NAME, N) extern char NAME##_fault;	\
	asm (".pushsection .text \n\t"		\
	     #NAME"_fault: \n\t"		\
	     "push"W" $"#N" \n\t"		\
	     "jmp __handle_exception \n\t"	\
	     ".popsection")

EX(de, 0);
EX(db, 1);
EX(nmi, 2);
EX(bp, 3);
EX(of, 4);
EX(br, 5);
EX(ud, 6);
EX(nm, 7);
EX_E(df, 8);
EX_E(ts, 10);
EX_E(np, 11);
EX_E(ss, 12);
EX_E(gp, 13);
EX_E(pf, 14);
EX(mf, 16);
EX_E(ac, 17);
EX(mc, 18);
EX(xm, 19);

asm (".pushsection .text \n\t"
     "__handle_exception: \n\t"
#ifdef __x86_64__
     "push %r15; push %r14; push %r13; push %r12 \n\t"
     "push %r11; push %r10; push %r9; push %r8 \n\t"
#endif
     "push %"R "di; push %"R "si; push %"R "bp; sub $"S", %"R "sp \n\t"
     "push %"R "bx; push %"R "dx; push %"R "cx; push %"R "ax \n\t"
#ifdef __x86_64__
     "mov %"R "sp, %"R "di \n\t"
#else
     "mov %"R "sp, %"R "ax \n\t"
#endif
     "call do_handle_exception \n\t"
     "pop %"R "ax; pop %"R "cx; pop %"R "dx; pop %"R "bx \n\t"
     "add $"S", %"R "sp; pop %"R "bp; pop %"R "si; pop %"R "di \n\t"
#ifdef __x86_64__
     "pop %r8; pop %r9; pop %r10; pop %r11 \n\t"
     "pop %r12; pop %r13; pop %r14; pop %r15 \n\t"
#endif
     "add $"S", %"R "sp \n\t"
     "add $"S", %"R "sp \n\t"
     "iret"W" \n\t"
     ".popsection");

static void *idt_handlers[32] = {
	[0] = &de_fault,
	[1] = &db_fault,
	[2] = &nmi_fault,
	[3] = &bp_fault,
	[4] = &of_fault,
	[5] = &br_fault,
	[6] = &ud_fault,
	[7] = &nm_fault,
	[8] = &df_fault,
	[10] = &ts_fault,
	[11] = &np_fault,
	[12] = &ss_fault,
	[13] = &gp_fault,
	[14] = &pf_fault,
	[16] = &mf_fault,
	[17] = &ac_fault,
	[18] = &mc_fault,
	[19] = &xm_fault,
};

void setup_idt(void)
{
    int i;
    static bool idt_initialized = false;

    if (idt_initialized) {
        return;
    }
    idt_initialized = true;
    for (i = 0; i < 32; i++)
	    if (idt_handlers[i])
		    set_idt_entry(i, idt_handlers[i], 0);
    handle_exception(0, check_exception_table);
    handle_exception(6, check_exception_table);
    handle_exception(13, check_exception_table);
}

unsigned exception_vector(void)
{
    unsigned char vector;

    asm("movb %%gs:4, %0" : "=q"(vector));
    return vector;
}

unsigned exception_error_code(void)
{
    unsigned short error_code;

    asm("mov %%gs:6, %0" : "=rm"(error_code));
    return error_code;
}

bool exception_rflags_rf(void)
{
    unsigned char rf_flag;

    asm("movb %%gs:5, %b0" : "=q"(rf_flag));
    return rf_flag & 1;
}

static char intr_alt_stack[4096];

#ifndef __x86_64__
/*
 * GDT, with 6 entries:
 * 0x00 - NULL descriptor
 * 0x08 - Code segment (ring 0)
 * 0x10 - Data segment (ring 0)
 * 0x18 - Not present code segment (ring 0)
 * 0x20 - Code segment (ring 3)
 * 0x28 - Data segment (ring 3)
 * 0x30 - Interrupt task
 * 0x38 to 0x78 - Free to use for test cases
 * 0x80 - Primary task (CPU 0)
 */

void set_gdt_entry(int sel, u32 base,  u32 limit, u8 access, u8 gran)
{
	int num = sel >> 3;

	/* Setup the descriptor base address */
	gdt32[num].base_low = (base & 0xFFFF);
	gdt32[num].base_middle = (base >> 16) & 0xFF;
	gdt32[num].base_high = (base >> 24) & 0xFF;

	/* Setup the descriptor limits */
	gdt32[num].limit_low = (limit & 0xFFFF);
	gdt32[num].granularity = ((limit >> 16) & 0x0F);

	/* Finally, set up the granularity and access flags */
	gdt32[num].granularity |= (gran & 0xF0);
	gdt32[num].access = access;
}

void set_gdt_task_gate(u16 sel, u16 tss_sel)
{
    set_gdt_entry(sel, tss_sel, 0, 0x85, 0); // task, present
}

void set_idt_task_gate(int vec, u16 sel)
{
    idt_entry_t *e = &boot_idt[vec];

    memset(e, 0, sizeof *e);

    e->selector = sel;
    e->ist = 0;
    e->type = 5;
    e->dpl = 0;
    e->p = 1;
}

/*
 * 0 - main task
 * 1 - interrupt task
 */

tss32_t tss_intr;

void setup_tss32(void)
{
	u16 desc_size = sizeof(tss32_t);

	tss.cr3 = read_cr3();
	tss_intr.cr3 = read_cr3();
	tss_intr.ss0 = tss_intr.ss1 = tss_intr.ss2 = 0x10;
	tss_intr.esp = tss_intr.esp0 = tss_intr.esp1 = tss_intr.esp2 =
		(u32)intr_alt_stack + 4096;
	tss_intr.cs = 0x08;
	tss_intr.ds = tss_intr.es = tss_intr.fs = tss_intr.gs = tss_intr.ss = 0x10;
	tss_intr.iomap_base = (u16)desc_size;
	set_gdt_entry(TSS_INTR, (u32)&tss_intr, desc_size - 1, 0x89, 0x0f);
}

void set_intr_task_gate(int e, void *fn)
{
	tss_intr.eip = (u32)fn;
	set_idt_task_gate(e, TSS_INTR);
}

void setup_alt_stack(void)
{
	setup_tss32();
}

void set_intr_alt_stack(int e, void *fn)
{
	set_intr_task_gate(e, fn);
}

void print_current_tss_info(void)
{
	u16 tr = str();

	if (tr != TSS_MAIN && tr != TSS_INTR)
		printf("Unknown TSS %x\n", tr);
	else
		printf("TR=%x (%s) Main TSS back link %x. Intr TSS back link %x\n",
		       tr, tr ? "interrupt" : "main", tss.prev, tss_intr.prev);
}
#else
void set_intr_alt_stack(int e, void *addr)
{
	set_idt_entry(e, addr, 0);
	boot_idt[e].ist = 1;
}

void setup_alt_stack(void)
{
	tss.ist1 = (u64)intr_alt_stack + 4096;
}
#endif

static bool exception;
static jmp_buf *exception_jmpbuf;

static void exception_handler_longjmp(void)
{
	longjmp(*exception_jmpbuf, 1);
}

static void exception_handler(struct ex_regs *regs)
{
	/* longjmp must happen after iret, so do not do it now.  */
	exception = true;
	regs->rip = (unsigned long)&exception_handler_longjmp;
}

bool test_for_exception(unsigned int ex, void (*trigger_func)(void *data),
			void *data)
{
	jmp_buf jmpbuf;
	int ret;

	handle_exception(ex, exception_handler);
	ret = set_exception_jmpbuf(jmpbuf);
	if (ret == 0)
		trigger_func(data);
	handle_exception(ex, NULL);
	return ret;
}

void __set_exception_jmpbuf(jmp_buf *addr)
{
	exception_jmpbuf = addr;
}
