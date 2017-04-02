#include "libcflat.h"
#include "desc.h"
#include "apic-defs.h"
#include "apic.h"
#include "processor.h"
#include "vm.h"

#define MAIN_TSS_SEL (FIRST_SPARE_SEL + 0)
#define VM86_TSS_SEL (FIRST_SPARE_SEL + 8)
#define CONFORM_CS_SEL  (FIRST_SPARE_SEL + 16)

static volatile int test_count;
static volatile unsigned int test_divider;

static char *fault_addr;
static ulong fault_phys;

static inline void io_delay(void)
{
}

static void nmi_tss(void)
{
start:
	printf("NMI task is running\n");
	print_current_tss_info();
	test_count++;
	asm volatile ("iret");
	goto start;
}

static void de_tss(void)
{
start:
	printf("DE task is running\n");
	print_current_tss_info();
	test_divider = 10;
	test_count++;
	asm volatile ("iret");
	goto start;
}

static void of_tss(void)
{
start:
	printf("OF task is running\n");
	print_current_tss_info();
	test_count++;
	asm volatile ("iret");
	goto start;
}

static void bp_tss(void)
{
start:
	printf("BP task is running\n");
	print_current_tss_info();
	test_count++;
	asm volatile ("iret");
	goto start;
}

void do_pf_tss(ulong *error_code)
{
	printf("PF task is running %p %lx\n", error_code, *error_code);
	print_current_tss_info();
	if (*error_code == 0x2) /* write access, not present */
		test_count++;
	install_pte(phys_to_virt(read_cr3()), 1, fault_addr,
		    fault_phys | PT_PRESENT_MASK | PT_WRITABLE_MASK, 0);
}

extern void pf_tss(void);

asm (
	"pf_tss: \n\t"
	"push %esp \n\t"
	"call do_pf_tss \n\t"
	"add $4, %esp \n\t"
	"iret\n\t"
	"jmp pf_tss\n\t"
    );

static void jmp_tss(void)
{
start:
	printf("JMP to task succeeded\n");
	print_current_tss_info();
	test_count++;
	asm volatile ("ljmp $" xstr(TSS_MAIN) ", $0");
	goto start;
}

static void irq_tss(void)
{
start:
	printf("IRQ task is running\n");
	print_current_tss_info();
	test_count++;
	asm volatile ("iret");
	test_count++;
	printf("IRQ task restarts after iret.\n");
	goto start;
}

static void user_tss(void)
{
start:
	printf("Conforming task is running\n");
	print_current_tss_info();
	test_count++;
	asm volatile ("iret");
	goto start;
}

void test_kernel_mode_int()
{
	unsigned int res;

	/* test that int $2 triggers task gate */
	test_count = 0;
	set_intr_task_gate(2, nmi_tss);
	printf("Triggering nmi 2\n");
	asm volatile ("int $2");
	printf("Return from nmi %d\n", test_count);
	report("NMI int $2", test_count == 1);

	/* test that external NMI triggers task gate */
	test_count = 0;
	set_intr_task_gate(2, nmi_tss);
	printf("Triggering nmi through APIC\n");
	apic_icr_write(APIC_DEST_PHYSICAL | APIC_DM_NMI | APIC_INT_ASSERT, 0);
	io_delay();
	printf("Return from APIC nmi\n");
	report("NMI external", test_count == 1);

	/* test that external interrupt triggesr task gate */
	test_count = 0;
	printf("Trigger IRQ from APIC\n");
	set_intr_task_gate(0xf0, irq_tss);
	irq_enable();
	apic_icr_write(APIC_DEST_SELF | APIC_DEST_PHYSICAL | APIC_DM_FIXED | APIC_INT_ASSERT | 0xf0, 0);
	io_delay();
	irq_disable();
	printf("Return from APIC IRQ\n");
	report("IRQ external", test_count == 1);

	/* test that HW exception triggesr task gate */
	set_intr_task_gate(0, de_tss);
	printf("Try to devide by 0\n");
	asm volatile ("divl %3": "=a"(res)
		      : "d"(0), "a"(1500), "m"(test_divider));
	printf("Result is %d\n", res);
	report("DE exeption", res == 150);

	/* test if call HW exeption DE by int $0 triggers task gate */
	test_count = 0;
	set_intr_task_gate(0, de_tss);
	printf("Call int 0\n");
	asm volatile ("int $0");
	printf("Return from int 0\n");
	report("int $0", test_count == 1);

	/* test if HW exception OF triggers task gate */
	test_count = 0;
	set_intr_task_gate(4, of_tss);
	printf("Call into\n");
	asm volatile ("addb $127, %b0\ninto"::"a"(127));
	printf("Return from into\n");
	report("OF exeption", test_count);

	/* test if HW exception BP triggers task gate */
	test_count = 0;
	set_intr_task_gate(3, bp_tss);
	printf("Call int 3\n");
	asm volatile ("int $3");
	printf("Return from int 3\n");
	report("BP exeption", test_count == 1);

	/*
	 * test that PF triggers task gate and error code is placed on
	 * exception task's stack
	 */
	fault_addr = alloc_vpage();
	fault_phys = (ulong)virt_to_phys(alloc_page());
	test_count = 0;
	set_intr_task_gate(14, pf_tss);
	printf("Access unmapped page\n");
	*fault_addr = 0;
	printf("Return from pf tss\n");
	report("PF exeption", test_count == 1);
}

void test_gdt_task_gate(void)
{
	/* test that calling a task by lcall works */
	test_count = 0;
	tss_intr.eip = (u32)irq_tss;
	printf("Calling task by lcall\n");
	/* hlt opcode is 0xf4 I use destination IP 0xf4f4f4f4 to catch
	   incorrect instruction length calculation */
	asm volatile("lcall $" xstr(TSS_INTR) ", $0xf4f4f4f4");
	printf("Return from call\n");
	report("lcall", test_count == 1);

	/* call the same task again and check that it restarted after iret */
	test_count = 0;
	asm volatile("lcall $" xstr(TSS_INTR) ", $0xf4f4f4f4");
	report("lcall2", test_count == 2);

	/* test that calling a task by ljmp works */
	test_count = 0;
	tss_intr.eip = (u32)jmp_tss;
	printf("Jumping to a task by ljmp\n");
	asm volatile ("ljmp $" xstr(TSS_INTR) ", $0xf4f4f4f4");
	printf("Jump back succeeded\n");
	report("ljmp", test_count == 1);
}

void test_vm86_switch(void)
{
    static tss32_t main_tss;
    static tss32_t vm86_tss;

    u8 *vm86_start;

    /* Write a 'ud2' instruction somewhere below 1 MB */
    vm86_start = (void*) 0x42000;
    vm86_start[0] = 0x0f;
    vm86_start[1] = 0x0b;

    /* Main TSS */
    set_gdt_entry(MAIN_TSS_SEL, (u32)&main_tss, sizeof(tss32_t) - 1, 0x89, 0);
    ltr(MAIN_TSS_SEL);
    main_tss = (tss32_t) {
        .prev   = VM86_TSS_SEL,
        .cr3    = read_cr3(),
    };

    /* VM86 TSS (marked as busy, so we can iret to it) */
    set_gdt_entry(VM86_TSS_SEL, (u32)&vm86_tss, sizeof(tss32_t) - 1, 0x8b, 0);
    vm86_tss = (tss32_t) {
        .eflags = 0x20002,
        .cr3    = read_cr3(),
        .eip    = (u32) vm86_start & 0x0f,
        .cs     = (u32) vm86_start >> 4,
        .ds     = 0x1234,
        .es     = 0x2345,
    };

    /* Setup task gate to main TSS for #UD */
    set_idt_task_gate(6, MAIN_TSS_SEL);

    /* Jump into VM86 task with iret, #UD lets it come back immediately */
    printf("Switch to VM86 task and back\n");
    asm volatile(
        "pushf\n"
        "orw $0x4000, (%esp)\n"
        "popf\n"
        "iret\n"
    );
    report("VM86", 1);
}

#define IOPL_SHIFT 12

void test_conforming_switch(void)
{
	/* test lcall with conforming segment, cs.dpl != cs.rpl */
	test_count = 0;

	tss_intr.cs = CONFORM_CS_SEL | 3;
	tss_intr.eip = (u32)user_tss;
	tss_intr.ss = USER_DS;
	tss_intr.ds = tss_intr.gs = tss_intr.es = tss_intr.fs = tss_intr.ss;
	tss_intr.eflags |= 3 << IOPL_SHIFT;
	set_gdt_entry(CONFORM_CS_SEL, 0, 0xffffffff, 0x9f, 0xc0);
	asm volatile("lcall $" xstr(TSS_INTR) ", $0xf4f4f4f4");
	report("lcall with cs.rpl != cs.dpl", test_count == 1);
}

int main()
{
	setup_vm();
	setup_idt();
	setup_tss32();

	test_gdt_task_gate();
	test_kernel_mode_int();
	test_vm86_switch();
	test_conforming_switch();

	return report_summary();
}
