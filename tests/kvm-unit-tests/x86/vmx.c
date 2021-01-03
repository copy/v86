/*
 * x86/vmx.c : Framework for testing nested virtualization
 *	This is a framework to test nested VMX for KVM, which
 * 	started as a project of GSoC 2013. All test cases should
 *	be located in x86/vmx_tests.c and framework related
 *	functions should be in this file.
 *
 * How to write test cases?
 *	Add callbacks of test suite in variant "vmx_tests". You can
 *	write:
 *		1. init function used for initializing test suite
 *		2. main function for codes running in L2 guest, 
 *		3. exit_handler to handle vmexit of L2 to L1
 *		4. syscall handler to handle L2 syscall vmexit
 *		5. vmenter fail handler to handle direct failure of vmenter
 *		6. guest_regs is loaded when vmenter and saved when
 *			vmexit, you can read and set it in exit_handler
 *	If no special function is needed for a test suite, use
 *	coressponding basic_* functions as callback. More handlers
 *	can be added to "vmx_tests", see details of "struct vmx_test"
 *	and function test_run().
 *
 * Currently, vmx test framework only set up one VCPU and one
 * concurrent guest test environment with same paging for L2 and
 * L1. For usage of EPT, only 1:1 mapped paging is used from VFN
 * to PFN.
 *
 * Author : Arthur Chunqi Li <yzt356@gmail.com>
 */

#include "libcflat.h"
#include "processor.h"
#include "vm.h"
#include "desc.h"
#include "vmx.h"
#include "msr.h"
#include "smp.h"

u64 *vmxon_region;
struct vmcs *vmcs_root;
u32 vpid_cnt;
void *guest_stack, *guest_syscall_stack;
u32 ctrl_pin, ctrl_enter, ctrl_exit, ctrl_cpu[2];
struct regs regs;

struct vmx_test *current;

#define MAX_TEST_TEARDOWN_STEPS 10

struct test_teardown_step {
	test_teardown_func func;
	void *data;
};

static int teardown_count;
static struct test_teardown_step teardown_steps[MAX_TEST_TEARDOWN_STEPS];

static test_guest_func v2_guest_main;

u64 hypercall_field;
bool launched;
static int matched;
static int guest_finished;
static int in_guest;

union vmx_basic basic;
union vmx_ctrl_msr ctrl_pin_rev;
union vmx_ctrl_msr ctrl_cpu_rev[2];
union vmx_ctrl_msr ctrl_exit_rev;
union vmx_ctrl_msr ctrl_enter_rev;
union vmx_ept_vpid  ept_vpid;

extern struct descriptor_table_ptr gdt64_desc;
extern struct descriptor_table_ptr idt_descr;
extern struct descriptor_table_ptr tss_descr;
extern void *vmx_return;
extern void *entry_sysenter;
extern void *guest_entry;

static volatile u32 stage;

static jmp_buf abort_target;

struct vmcs_field {
	u64 mask;
	u64 encoding;
};

#define MASK(_bits) GENMASK_ULL((_bits) - 1, 0)
#define MASK_NATURAL MASK(sizeof(unsigned long) * 8)

static struct vmcs_field vmcs_fields[] = {
	{ MASK(16), VPID },
	{ MASK(16), PINV },
	{ MASK(16), EPTP_IDX },

	{ MASK(16), GUEST_SEL_ES },
	{ MASK(16), GUEST_SEL_CS },
	{ MASK(16), GUEST_SEL_SS },
	{ MASK(16), GUEST_SEL_DS },
	{ MASK(16), GUEST_SEL_FS },
	{ MASK(16), GUEST_SEL_GS },
	{ MASK(16), GUEST_SEL_LDTR },
	{ MASK(16), GUEST_SEL_TR },
	{ MASK(16), GUEST_INT_STATUS },

	{ MASK(16), HOST_SEL_ES },
	{ MASK(16), HOST_SEL_CS },
	{ MASK(16), HOST_SEL_SS },
	{ MASK(16), HOST_SEL_DS },
	{ MASK(16), HOST_SEL_FS },
	{ MASK(16), HOST_SEL_GS },
	{ MASK(16), HOST_SEL_TR },

	{ MASK(64), IO_BITMAP_A },
	{ MASK(64), IO_BITMAP_B },
	{ MASK(64), MSR_BITMAP },
	{ MASK(64), EXIT_MSR_ST_ADDR },
	{ MASK(64), EXIT_MSR_LD_ADDR },
	{ MASK(64), ENTER_MSR_LD_ADDR },
	{ MASK(64), VMCS_EXEC_PTR },
	{ MASK(64), TSC_OFFSET },
	{ MASK(64), APIC_VIRT_ADDR },
	{ MASK(64), APIC_ACCS_ADDR },
	{ MASK(64), EPTP },

	{ 0 /* read-only */, INFO_PHYS_ADDR },

	{ MASK(64), VMCS_LINK_PTR },
	{ MASK(64), GUEST_DEBUGCTL },
	{ MASK(64), GUEST_EFER },
	{ MASK(64), GUEST_PAT },
	{ MASK(64), GUEST_PERF_GLOBAL_CTRL },
	{ MASK(64), GUEST_PDPTE },

	{ MASK(64), HOST_PAT },
	{ MASK(64), HOST_EFER },
	{ MASK(64), HOST_PERF_GLOBAL_CTRL },

	{ MASK(32), PIN_CONTROLS },
	{ MASK(32), CPU_EXEC_CTRL0 },
	{ MASK(32), EXC_BITMAP },
	{ MASK(32), PF_ERROR_MASK },
	{ MASK(32), PF_ERROR_MATCH },
	{ MASK(32), CR3_TARGET_COUNT },
	{ MASK(32), EXI_CONTROLS },
	{ MASK(32), EXI_MSR_ST_CNT },
	{ MASK(32), EXI_MSR_LD_CNT },
	{ MASK(32), ENT_CONTROLS },
	{ MASK(32), ENT_MSR_LD_CNT },
	{ MASK(32), ENT_INTR_INFO },
	{ MASK(32), ENT_INTR_ERROR },
	{ MASK(32), ENT_INST_LEN },
	{ MASK(32), TPR_THRESHOLD },
	{ MASK(32), CPU_EXEC_CTRL1 },

	{ 0 /* read-only */, VMX_INST_ERROR },
	{ 0 /* read-only */, EXI_REASON },
	{ 0 /* read-only */, EXI_INTR_INFO },
	{ 0 /* read-only */, EXI_INTR_ERROR },
	{ 0 /* read-only */, IDT_VECT_INFO },
	{ 0 /* read-only */, IDT_VECT_ERROR },
	{ 0 /* read-only */, EXI_INST_LEN },
	{ 0 /* read-only */, EXI_INST_INFO },

	{ MASK(32), GUEST_LIMIT_ES },
	{ MASK(32), GUEST_LIMIT_CS },
	{ MASK(32), GUEST_LIMIT_SS },
	{ MASK(32), GUEST_LIMIT_DS },
	{ MASK(32), GUEST_LIMIT_FS },
	{ MASK(32), GUEST_LIMIT_GS },
	{ MASK(32), GUEST_LIMIT_LDTR },
	{ MASK(32), GUEST_LIMIT_TR },
	{ MASK(32), GUEST_LIMIT_GDTR },
	{ MASK(32), GUEST_LIMIT_IDTR },
	{ 0x1d0ff, GUEST_AR_ES },
	{ 0x1f0ff, GUEST_AR_CS },
	{ 0x1d0ff, GUEST_AR_SS },
	{ 0x1d0ff, GUEST_AR_DS },
	{ 0x1d0ff, GUEST_AR_FS },
	{ 0x1d0ff, GUEST_AR_GS },
	{ 0x1d0ff, GUEST_AR_LDTR },
	{ 0x1d0ff, GUEST_AR_TR },
	{ MASK(32), GUEST_INTR_STATE },
	{ MASK(32), GUEST_ACTV_STATE },
	{ MASK(32), GUEST_SMBASE },
	{ MASK(32), GUEST_SYSENTER_CS },
	{ MASK(32), PREEMPT_TIMER_VALUE },

	{ MASK(32), HOST_SYSENTER_CS },

	{ MASK_NATURAL, CR0_MASK },
	{ MASK_NATURAL, CR4_MASK },
	{ MASK_NATURAL, CR0_READ_SHADOW },
	{ MASK_NATURAL, CR4_READ_SHADOW },
	{ MASK_NATURAL, CR3_TARGET_0 },
	{ MASK_NATURAL, CR3_TARGET_1 },
	{ MASK_NATURAL, CR3_TARGET_2 },
	{ MASK_NATURAL, CR3_TARGET_3 },

	{ 0 /* read-only */, EXI_QUALIFICATION },
	{ 0 /* read-only */, IO_RCX },
	{ 0 /* read-only */, IO_RSI },
	{ 0 /* read-only */, IO_RDI },
	{ 0 /* read-only */, IO_RIP },
	{ 0 /* read-only */, GUEST_LINEAR_ADDRESS },

	{ MASK_NATURAL, GUEST_CR0 },
	{ MASK_NATURAL, GUEST_CR3 },
	{ MASK_NATURAL, GUEST_CR4 },
	{ MASK_NATURAL, GUEST_BASE_ES },
	{ MASK_NATURAL, GUEST_BASE_CS },
	{ MASK_NATURAL, GUEST_BASE_SS },
	{ MASK_NATURAL, GUEST_BASE_DS },
	{ MASK_NATURAL, GUEST_BASE_FS },
	{ MASK_NATURAL, GUEST_BASE_GS },
	{ MASK_NATURAL, GUEST_BASE_LDTR },
	{ MASK_NATURAL, GUEST_BASE_TR },
	{ MASK_NATURAL, GUEST_BASE_GDTR },
	{ MASK_NATURAL, GUEST_BASE_IDTR },
	{ MASK_NATURAL, GUEST_DR7 },
	{ MASK_NATURAL, GUEST_RSP },
	{ MASK_NATURAL, GUEST_RIP },
	{ MASK_NATURAL, GUEST_RFLAGS },
	{ MASK_NATURAL, GUEST_PENDING_DEBUG },
	{ MASK_NATURAL, GUEST_SYSENTER_ESP },
	{ MASK_NATURAL, GUEST_SYSENTER_EIP },

	{ MASK_NATURAL, HOST_CR0 },
	{ MASK_NATURAL, HOST_CR3 },
	{ MASK_NATURAL, HOST_CR4 },
	{ MASK_NATURAL, HOST_BASE_FS },
	{ MASK_NATURAL, HOST_BASE_GS },
	{ MASK_NATURAL, HOST_BASE_TR },
	{ MASK_NATURAL, HOST_BASE_GDTR },
	{ MASK_NATURAL, HOST_BASE_IDTR },
	{ MASK_NATURAL, HOST_SYSENTER_ESP },
	{ MASK_NATURAL, HOST_SYSENTER_EIP },
	{ MASK_NATURAL, HOST_RSP },
	{ MASK_NATURAL, HOST_RIP },
};

static inline u64 vmcs_field_value(struct vmcs_field *f, u8 cookie)
{
	u64 value;

	/* Incorporate the cookie and the field encoding into the value. */
	value = cookie;
	value |= (f->encoding << 8);
	value |= 0xdeadbeefull << 32;

	return value & f->mask;
}

static void set_vmcs_field(struct vmcs_field *f, u8 cookie)
{
	vmcs_write(f->encoding, vmcs_field_value(f, cookie));
}

static bool check_vmcs_field(struct vmcs_field *f, u8 cookie)
{
	u64 expected;
	u64 actual;
	int ret;

	ret = vmcs_read_checking(f->encoding, &actual);
	assert(!(ret & X86_EFLAGS_CF));
	/* Skip VMCS fields that aren't recognized by the CPU */
	if (ret & X86_EFLAGS_ZF)
		return true;

	expected = vmcs_field_value(f, cookie);
	actual &= f->mask;

	if (expected == actual)
		return true;

	printf("FAIL: VMWRITE/VMREAD %lx (expected: %lx, actual: %lx)\n",
	       f->encoding, (unsigned long) expected, (unsigned long) actual);

	return false;
}

static void set_all_vmcs_fields(u8 cookie)
{
	int i;

	for (i = 0; i < ARRAY_SIZE(vmcs_fields); i++)
		set_vmcs_field(&vmcs_fields[i], cookie);
}

static bool check_all_vmcs_fields(u8 cookie)
{
	bool pass = true;
	int i;

	for (i = 0; i < ARRAY_SIZE(vmcs_fields); i++) {
		if (!check_vmcs_field(&vmcs_fields[i], cookie))
			pass = false;
	}

	return pass;
}

void test_vmwrite_vmread(void)
{
	struct vmcs *vmcs = alloc_page();

	memset(vmcs, 0, PAGE_SIZE);
	vmcs->revision_id = basic.revision;
	assert(!vmcs_clear(vmcs));
	assert(!make_vmcs_current(vmcs));

	set_all_vmcs_fields(0x42);
	report("VMWRITE/VMREAD", check_all_vmcs_fields(0x42));

	assert(!vmcs_clear(vmcs));
	free_page(vmcs);
}

void test_vmcs_lifecycle(void)
{
	struct vmcs *vmcs[2] = {};
	int i;

	for (i = 0; i < ARRAY_SIZE(vmcs); i++) {
		vmcs[i] = alloc_page();
		memset(vmcs[i], 0, PAGE_SIZE);
		vmcs[i]->revision_id = basic.revision;
	}

#define VMPTRLD(_i) do { \
	assert(_i < ARRAY_SIZE(vmcs)); \
	assert(!make_vmcs_current(vmcs[_i])); \
	printf("VMPTRLD VMCS%d\n", (_i)); \
} while (0)

#define VMCLEAR(_i) do { \
	assert(_i < ARRAY_SIZE(vmcs)); \
	assert(!vmcs_clear(vmcs[_i])); \
	printf("VMCLEAR VMCS%d\n", (_i)); \
} while (0)

	VMCLEAR(0);
	VMPTRLD(0);
	set_all_vmcs_fields(0);
	report("current:VMCS0 active:[VMCS0]", check_all_vmcs_fields(0));

	VMCLEAR(0);
	VMPTRLD(0);
	report("current:VMCS0 active:[VMCS0]", check_all_vmcs_fields(0));

	VMCLEAR(1);
	report("current:VMCS0 active:[VMCS0]", check_all_vmcs_fields(0));

	VMPTRLD(1);
	set_all_vmcs_fields(1);
	report("current:VMCS1 active:[VMCS0,VCMS1]", check_all_vmcs_fields(1));

	VMPTRLD(0);
	report("current:VMCS0 active:[VMCS0,VCMS1]", check_all_vmcs_fields(0));
	VMPTRLD(1);
	report("current:VMCS1 active:[VMCS0,VCMS1]", check_all_vmcs_fields(1));
	VMPTRLD(1);
	report("current:VMCS1 active:[VMCS0,VCMS1]", check_all_vmcs_fields(1));

	VMCLEAR(0);
	report("current:VMCS1 active:[VCMS1]", check_all_vmcs_fields(1));

	/* VMPTRLD should not erase VMWRITEs to the current VMCS */
	set_all_vmcs_fields(2);
	VMPTRLD(1);
	report("current:VMCS1 active:[VCMS1]", check_all_vmcs_fields(2));

	for (i = 0; i < ARRAY_SIZE(vmcs); i++) {
		VMCLEAR(i);
		free_page(vmcs[i]);
	}

#undef VMPTRLD
#undef VMCLEAR
}

void vmx_set_test_stage(u32 s)
{
	barrier();
	stage = s;
	barrier();
}

u32 vmx_get_test_stage(void)
{
	u32 s;

	barrier();
	s = stage;
	barrier();
	return s;
}

void vmx_inc_test_stage(void)
{
	barrier();
	stage++;
	barrier();
}

/* entry_sysenter */
asm(
	".align	4, 0x90\n\t"
	".globl	entry_sysenter\n\t"
	"entry_sysenter:\n\t"
	SAVE_GPR
	"	and	$0xf, %rax\n\t"
	"	mov	%rax, %rdi\n\t"
	"	call	syscall_handler\n\t"
	LOAD_GPR
	"	vmresume\n\t"
);

static void __attribute__((__used__)) syscall_handler(u64 syscall_no)
{
	if (current->syscall_handler)
		current->syscall_handler(syscall_no);
}

static const char * const exit_reason_descriptions[] = {
	[VMX_EXC_NMI]		= "VMX_EXC_NMI",
	[VMX_EXTINT]		= "VMX_EXTINT",
	[VMX_TRIPLE_FAULT]	= "VMX_TRIPLE_FAULT",
	[VMX_INIT]		= "VMX_INIT",
	[VMX_SIPI]		= "VMX_SIPI",
	[VMX_SMI_IO]		= "VMX_SMI_IO",
	[VMX_SMI_OTHER]		= "VMX_SMI_OTHER",
	[VMX_INTR_WINDOW]	= "VMX_INTR_WINDOW",
	[VMX_NMI_WINDOW]	= "VMX_NMI_WINDOW",
	[VMX_TASK_SWITCH]	= "VMX_TASK_SWITCH",
	[VMX_CPUID]		= "VMX_CPUID",
	[VMX_GETSEC]		= "VMX_GETSEC",
	[VMX_HLT]		= "VMX_HLT",
	[VMX_INVD]		= "VMX_INVD",
	[VMX_INVLPG]		= "VMX_INVLPG",
	[VMX_RDPMC]		= "VMX_RDPMC",
	[VMX_RDTSC]		= "VMX_RDTSC",
	[VMX_RSM]		= "VMX_RSM",
	[VMX_VMCALL]		= "VMX_VMCALL",
	[VMX_VMCLEAR]		= "VMX_VMCLEAR",
	[VMX_VMLAUNCH]		= "VMX_VMLAUNCH",
	[VMX_VMPTRLD]		= "VMX_VMPTRLD",
	[VMX_VMPTRST]		= "VMX_VMPTRST",
	[VMX_VMREAD]		= "VMX_VMREAD",
	[VMX_VMRESUME]		= "VMX_VMRESUME",
	[VMX_VMWRITE]		= "VMX_VMWRITE",
	[VMX_VMXOFF]		= "VMX_VMXOFF",
	[VMX_VMXON]		= "VMX_VMXON",
	[VMX_CR]		= "VMX_CR",
	[VMX_DR]		= "VMX_DR",
	[VMX_IO]		= "VMX_IO",
	[VMX_RDMSR]		= "VMX_RDMSR",
	[VMX_WRMSR]		= "VMX_WRMSR",
	[VMX_FAIL_STATE]	= "VMX_FAIL_STATE",
	[VMX_FAIL_MSR]		= "VMX_FAIL_MSR",
	[VMX_MWAIT]		= "VMX_MWAIT",
	[VMX_MTF]		= "VMX_MTF",
	[VMX_MONITOR]		= "VMX_MONITOR",
	[VMX_PAUSE]		= "VMX_PAUSE",
	[VMX_FAIL_MCHECK]	= "VMX_FAIL_MCHECK",
	[VMX_TPR_THRESHOLD]	= "VMX_TPR_THRESHOLD",
	[VMX_APIC_ACCESS]	= "VMX_APIC_ACCESS",
	[VMX_GDTR_IDTR]		= "VMX_GDTR_IDTR",
	[VMX_LDTR_TR]		= "VMX_LDTR_TR",
	[VMX_EPT_VIOLATION]	= "VMX_EPT_VIOLATION",
	[VMX_EPT_MISCONFIG]	= "VMX_EPT_MISCONFIG",
	[VMX_INVEPT]		= "VMX_INVEPT",
	[VMX_PREEMPT]		= "VMX_PREEMPT",
	[VMX_INVVPID]		= "VMX_INVVPID",
	[VMX_WBINVD]		= "VMX_WBINVD",
	[VMX_XSETBV]		= "VMX_XSETBV",
	[VMX_APIC_WRITE]	= "VMX_APIC_WRITE",
	[VMX_RDRAND]		= "VMX_RDRAND",
	[VMX_INVPCID]		= "VMX_INVPCID",
	[VMX_VMFUNC]		= "VMX_VMFUNC",
	[VMX_RDSEED]		= "VMX_RDSEED",
	[VMX_PML_FULL]		= "VMX_PML_FULL",
	[VMX_XSAVES]		= "VMX_XSAVES",
	[VMX_XRSTORS]		= "VMX_XRSTORS",
};

const char *exit_reason_description(u64 reason)
{
	if (reason >= ARRAY_SIZE(exit_reason_descriptions))
		return "(unknown)";
	return exit_reason_descriptions[reason] ? : "(unused)";
}

void print_vmexit_info()
{
	u64 guest_rip, guest_rsp;
	ulong reason = vmcs_read(EXI_REASON) & 0xff;
	ulong exit_qual = vmcs_read(EXI_QUALIFICATION);
	guest_rip = vmcs_read(GUEST_RIP);
	guest_rsp = vmcs_read(GUEST_RSP);
	printf("VMEXIT info:\n");
	printf("\tvmexit reason = %ld\n", reason);
	printf("\texit qualification = %#lx\n", exit_qual);
	printf("\tBit 31 of reason = %lx\n", (vmcs_read(EXI_REASON) >> 31) & 1);
	printf("\tguest_rip = %#lx\n", guest_rip);
	printf("\tRAX=%#lx    RBX=%#lx    RCX=%#lx    RDX=%#lx\n",
		regs.rax, regs.rbx, regs.rcx, regs.rdx);
	printf("\tRSP=%#lx    RBP=%#lx    RSI=%#lx    RDI=%#lx\n",
		guest_rsp, regs.rbp, regs.rsi, regs.rdi);
	printf("\tR8 =%#lx    R9 =%#lx    R10=%#lx    R11=%#lx\n",
		regs.r8, regs.r9, regs.r10, regs.r11);
	printf("\tR12=%#lx    R13=%#lx    R14=%#lx    R15=%#lx\n",
		regs.r12, regs.r13, regs.r14, regs.r15);
}

void
print_vmentry_failure_info(struct vmentry_failure *failure) {
	if (failure->early) {
		printf("Early %s failure: ", failure->instr);
		switch (failure->flags & VMX_ENTRY_FLAGS) {
		case X86_EFLAGS_CF:
			printf("current-VMCS pointer is not valid.\n");
			break;
		case X86_EFLAGS_ZF:
			printf("error number is %ld. See Intel 30.4.\n",
			       vmcs_read(VMX_INST_ERROR));
			break;
		default:
			printf("unexpected flags %lx!\n", failure->flags);
		}
	} else {
		u64 reason = vmcs_read(EXI_REASON);
		u64 qual = vmcs_read(EXI_QUALIFICATION);

		printf("Non-early %s failure (reason=%#lx, qual=%#lx): ",
			failure->instr, reason, qual);

		switch (reason & 0xff) {
		case VMX_FAIL_STATE:
			printf("invalid guest state\n");
			break;
		case VMX_FAIL_MSR:
			printf("MSR loading\n");
			break;
		case VMX_FAIL_MCHECK:
			printf("machine-check event\n");
			break;
		default:
			printf("unexpected basic exit reason %ld\n",
			       reason & 0xff);
		}

		if (!(reason & VMX_ENTRY_FAILURE))
			printf("\tVMX_ENTRY_FAILURE BIT NOT SET!\n");

		if (reason & 0x7fff0000)
			printf("\tRESERVED BITS SET!\n");
	}
}

/*
 * VMCLEAR should ensures all VMCS state is flushed to the VMCS
 * region in memory.
 */
static void test_vmclear_flushing(void)
{
	struct vmcs *vmcs[3] = {};
	int i;

	for (i = 0; i < ARRAY_SIZE(vmcs); i++) {
		vmcs[i] = alloc_page();
		memset(vmcs[i], 0, PAGE_SIZE);
	}

	vmcs[0]->revision_id = basic.revision;
	assert(!vmcs_clear(vmcs[0]));
	assert(!make_vmcs_current(vmcs[0]));
	set_all_vmcs_fields(0x86);

	assert(!vmcs_clear(vmcs[0]));
	memcpy(vmcs[1], vmcs[0], basic.size);
	assert(!make_vmcs_current(vmcs[1]));
	report("test vmclear flush (current VMCS)", check_all_vmcs_fields(0x86));

	set_all_vmcs_fields(0x87);
	assert(!make_vmcs_current(vmcs[0]));
	assert(!vmcs_clear(vmcs[1]));
	memcpy(vmcs[2], vmcs[1], basic.size);
	assert(!make_vmcs_current(vmcs[2]));
	report("test vmclear flush (!current VMCS)", check_all_vmcs_fields(0x87));

	for (i = 0; i < ARRAY_SIZE(vmcs); i++) {
		assert(!vmcs_clear(vmcs[i]));
		free_page(vmcs[i]);
	}
}

static void test_vmclear(void)
{
	struct vmcs *tmp_root;
	int width = cpuid_maxphyaddr();

	/*
	 * Note- The tests below do not necessarily have a
	 * valid VMCS, but that's ok since the invalid vmcs
	 * is only used for a specific test and is discarded
	 * without touching its contents
	 */

	/* Unaligned page access */
	tmp_root = (struct vmcs *)((intptr_t)vmcs_root + 1);
	report("test vmclear with unaligned vmcs",
	       vmcs_clear(tmp_root) == 1);

	/* gpa bits beyond physical address width are set*/
	tmp_root = (struct vmcs *)((intptr_t)vmcs_root |
				   ((u64)1 << (width+1)));
	report("test vmclear with vmcs address bits set beyond physical address width",
	       vmcs_clear(tmp_root) == 1);

	/* Pass VMXON region */
	tmp_root = (struct vmcs *)vmxon_region;
	report("test vmclear with vmxon region",
	       vmcs_clear(tmp_root) == 1);

	/* Valid VMCS */
	report("test vmclear with valid vmcs region", vmcs_clear(vmcs_root) == 0);

	test_vmclear_flushing();
}

static void __attribute__((__used__)) guest_main(void)
{
	if (current->v2)
		v2_guest_main();
	else
		current->guest_main();
}

/* guest_entry */
asm(
	".align	4, 0x90\n\t"
	".globl	entry_guest\n\t"
	"guest_entry:\n\t"
	"	call guest_main\n\t"
	"	mov $1, %edi\n\t"
	"	call hypercall\n\t"
);

/* EPT paging structure related functions */
/* split_large_ept_entry: Split a 2M/1G large page into 512 smaller PTEs.
		@ptep : large page table entry to split
		@level : level of ptep (2 or 3)
 */
static void split_large_ept_entry(unsigned long *ptep, int level)
{
	unsigned long *new_pt;
	unsigned long gpa;
	unsigned long pte;
	unsigned long prototype;
	int i;

	pte = *ptep;
	assert(pte & EPT_PRESENT);
	assert(pte & EPT_LARGE_PAGE);
	assert(level == 2 || level == 3);

	new_pt = alloc_page();
	assert(new_pt);
	memset(new_pt, 0, PAGE_SIZE);

	prototype = pte & ~EPT_ADDR_MASK;
	if (level == 2)
		prototype &= ~EPT_LARGE_PAGE;

	gpa = pte & EPT_ADDR_MASK;
	for (i = 0; i < EPT_PGDIR_ENTRIES; i++) {
		new_pt[i] = prototype | gpa;
		gpa += 1ul << EPT_LEVEL_SHIFT(level - 1);
	}

	pte &= ~EPT_LARGE_PAGE;
	pte &= ~EPT_ADDR_MASK;
	pte |= virt_to_phys(new_pt);

	*ptep = pte;
}

/* install_ept_entry : Install a page to a given level in EPT
		@pml4 : addr of pml4 table
		@pte_level : level of PTE to set
		@guest_addr : physical address of guest
		@pte : pte value to set
		@pt_page : address of page table, NULL for a new page
 */
void install_ept_entry(unsigned long *pml4,
		int pte_level,
		unsigned long guest_addr,
		unsigned long pte,
		unsigned long *pt_page)
{
	int level;
	unsigned long *pt = pml4;
	unsigned offset;

	/* EPT only uses 48 bits of GPA. */
	assert(guest_addr < (1ul << 48));

	for (level = EPT_PAGE_LEVEL; level > pte_level; --level) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(level))
				& EPT_PGDIR_MASK;
		if (!(pt[offset] & (EPT_PRESENT))) {
			unsigned long *new_pt = pt_page;
			if (!new_pt)
				new_pt = alloc_page();
			else
				pt_page = 0;
			memset(new_pt, 0, PAGE_SIZE);
			pt[offset] = virt_to_phys(new_pt)
					| EPT_RA | EPT_WA | EPT_EA;
		} else if (pt[offset] & EPT_LARGE_PAGE)
			split_large_ept_entry(&pt[offset], level);
		pt = phys_to_virt(pt[offset] & EPT_ADDR_MASK);
	}
	offset = (guest_addr >> EPT_LEVEL_SHIFT(level)) & EPT_PGDIR_MASK;
	pt[offset] = pte;
}

/* Map a page, @perm is the permission of the page */
void install_ept(unsigned long *pml4,
		unsigned long phys,
		unsigned long guest_addr,
		u64 perm)
{
	install_ept_entry(pml4, 1, guest_addr, (phys & PAGE_MASK) | perm, 0);
}

/* Map a 1G-size page */
void install_1g_ept(unsigned long *pml4,
		unsigned long phys,
		unsigned long guest_addr,
		u64 perm)
{
	install_ept_entry(pml4, 3, guest_addr,
			(phys & PAGE_MASK) | perm | EPT_LARGE_PAGE, 0);
}

/* Map a 2M-size page */
void install_2m_ept(unsigned long *pml4,
		unsigned long phys,
		unsigned long guest_addr,
		u64 perm)
{
	install_ept_entry(pml4, 2, guest_addr,
			(phys & PAGE_MASK) | perm | EPT_LARGE_PAGE, 0);
}

/* setup_ept_range : Setup a range of 1:1 mapped page to EPT paging structure.
		@start : start address of guest page
		@len : length of address to be mapped
		@map_1g : whether 1G page map is used
		@map_2m : whether 2M page map is used
		@perm : permission for every page
 */
void setup_ept_range(unsigned long *pml4, unsigned long start,
		     unsigned long len, int map_1g, int map_2m, u64 perm)
{
	u64 phys = start;
	u64 max = (u64)len + (u64)start;

	if (map_1g) {
		while (phys + PAGE_SIZE_1G <= max) {
			install_1g_ept(pml4, phys, phys, perm);
			phys += PAGE_SIZE_1G;
		}
	}
	if (map_2m) {
		while (phys + PAGE_SIZE_2M <= max) {
			install_2m_ept(pml4, phys, phys, perm);
			phys += PAGE_SIZE_2M;
		}
	}
	while (phys + PAGE_SIZE <= max) {
		install_ept(pml4, phys, phys, perm);
		phys += PAGE_SIZE;
	}
}

/* get_ept_pte : Get the PTE of a given level in EPT,
    @level == 1 means get the latest level*/
bool get_ept_pte(unsigned long *pml4, unsigned long guest_addr, int level,
		unsigned long *pte)
{
	int l;
	unsigned long *pt = pml4, iter_pte;
	unsigned offset;

	assert(level >= 1 && level <= 4);

	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
		iter_pte = pt[offset];
		if (l == level)
			break;
		if (l < 4 && (iter_pte & EPT_LARGE_PAGE))
			return false;
		if (!(iter_pte & (EPT_PRESENT)))
			return false;
		pt = (unsigned long *)(iter_pte & EPT_ADDR_MASK);
	}
	offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
	if (pte)
		*pte = pt[offset];
	return true;
}

static void clear_ept_ad_pte(unsigned long *pml4, unsigned long guest_addr)
{
	int l;
	unsigned long *pt = pml4;
	u64 pte;
	unsigned offset;

	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
		pt[offset] &= ~(EPT_ACCESS_FLAG|EPT_DIRTY_FLAG);
		pte = pt[offset];
		if (l == 1 || (l < 4 && (pte & EPT_LARGE_PAGE)))
			break;
		pt = (unsigned long *)(pte & EPT_ADDR_MASK);
	}
}

/* clear_ept_ad : Clear EPT A/D bits for the page table walk and the
   final GPA of a guest address.  */
void clear_ept_ad(unsigned long *pml4, u64 guest_cr3,
		  unsigned long guest_addr)
{
	int l;
	unsigned long *pt = (unsigned long *)guest_cr3, gpa;
	u64 pte, offset_in_page;
	unsigned offset;

	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;

		clear_ept_ad_pte(pml4, (u64) &pt[offset]);
		pte = pt[offset];
		if (l == 1 || (l < 4 && (pte & PT_PAGE_SIZE_MASK)))
			break;
		if (!(pte & PT_PRESENT_MASK))
			return;
		pt = (unsigned long *)(pte & PT_ADDR_MASK);
	}

	offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
	offset_in_page = guest_addr & ((1 << EPT_LEVEL_SHIFT(l)) - 1);
	gpa = (pt[offset] & PT_ADDR_MASK) | (guest_addr & offset_in_page);
	clear_ept_ad_pte(pml4, gpa);
}

/* check_ept_ad : Check the content of EPT A/D bits for the page table
   walk and the final GPA of a guest address.  */
void check_ept_ad(unsigned long *pml4, u64 guest_cr3,
		  unsigned long guest_addr, int expected_gpa_ad,
		  int expected_pt_ad)
{
	int l;
	unsigned long *pt = (unsigned long *)guest_cr3, gpa;
	u64 ept_pte, pte, offset_in_page;
	unsigned offset;
	bool bad_pt_ad = false;

	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;

		if (!get_ept_pte(pml4, (u64) &pt[offset], 1, &ept_pte)) {
			printf("EPT - guest level %d page table is not mapped.\n", l);
			return;
		}

		if (!bad_pt_ad) {
			bad_pt_ad |= (ept_pte & (EPT_ACCESS_FLAG|EPT_DIRTY_FLAG)) != expected_pt_ad;
			if (bad_pt_ad)
				report("EPT - guest level %d page table A=%d/D=%d",
				       false, l,
				       !!(expected_pt_ad & EPT_ACCESS_FLAG),
				       !!(expected_pt_ad & EPT_DIRTY_FLAG));
		}

		pte = pt[offset];
		if (l == 1 || (l < 4 && (pte & PT_PAGE_SIZE_MASK)))
			break;
		if (!(pte & PT_PRESENT_MASK))
			return;
		pt = (unsigned long *)(pte & PT_ADDR_MASK);
	}

	if (!bad_pt_ad)
		report("EPT - guest page table structures A=%d/D=%d",
		       true,
		       !!(expected_pt_ad & EPT_ACCESS_FLAG),
		       !!(expected_pt_ad & EPT_DIRTY_FLAG));

	offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
	offset_in_page = guest_addr & ((1 << EPT_LEVEL_SHIFT(l)) - 1);
	gpa = (pt[offset] & PT_ADDR_MASK) | (guest_addr & offset_in_page);

	if (!get_ept_pte(pml4, gpa, 1, &ept_pte)) {
		report("EPT - guest physical address is not mapped", false);
		return;
	}
	report("EPT - guest physical address A=%d/D=%d",
	       (ept_pte & (EPT_ACCESS_FLAG|EPT_DIRTY_FLAG)) == expected_gpa_ad,
	       !!(expected_gpa_ad & EPT_ACCESS_FLAG),
	       !!(expected_gpa_ad & EPT_DIRTY_FLAG));
}


void ept_sync(int type, u64 eptp)
{
	switch (type) {
	case INVEPT_SINGLE:
		if (ept_vpid.val & EPT_CAP_INVEPT_SINGLE) {
			invept(INVEPT_SINGLE, eptp);
			break;
		}
		/* else fall through */
	case INVEPT_GLOBAL:
		if (ept_vpid.val & EPT_CAP_INVEPT_ALL) {
			invept(INVEPT_GLOBAL, eptp);
			break;
		}
		/* else fall through */
	default:
		printf("WARNING: invept is not supported!\n");
	}
}

void set_ept_pte(unsigned long *pml4, unsigned long guest_addr,
		 int level, u64 pte_val)
{
	int l;
	unsigned long *pt = pml4;
	unsigned offset;

	assert(level >= 1 && level <= 4);

	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
		if (l == level)
			break;
		assert(pt[offset] & EPT_PRESENT);
		pt = (unsigned long *)(pt[offset] & EPT_ADDR_MASK);
	}
	offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
	pt[offset] = pte_val;
}

bool ept_2m_supported(void)
{
	return ept_vpid.val & EPT_CAP_2M_PAGE;
}

bool ept_1g_supported(void)
{
	return ept_vpid.val & EPT_CAP_1G_PAGE;
}

bool ept_huge_pages_supported(int level)
{
	if (level == 2)
		return ept_2m_supported();
	else if (level == 3)
		return ept_1g_supported();
	else
		return false;
}

bool ept_execute_only_supported(void)
{
	return ept_vpid.val & EPT_CAP_WT;
}

bool ept_ad_bits_supported(void)
{
	return ept_vpid.val & EPT_CAP_AD_FLAG;
}

void vpid_sync(int type, u16 vpid)
{
	switch(type) {
	case INVVPID_CONTEXT_GLOBAL:
		if (ept_vpid.val & VPID_CAP_INVVPID_CXTGLB) {
			invvpid(INVVPID_CONTEXT_GLOBAL, vpid, 0);
			break;
		}
	case INVVPID_ALL:
		if (ept_vpid.val & VPID_CAP_INVVPID_ALL) {
			invvpid(INVVPID_ALL, vpid, 0);
			break;
		}
	default:
		printf("WARNING: invvpid is not supported\n");
	}
}

static void init_vmcs_ctrl(void)
{
	/* 26.2 CHECKS ON VMX CONTROLS AND HOST-STATE AREA */
	/* 26.2.1.1 */
	vmcs_write(PIN_CONTROLS, ctrl_pin);
	/* Disable VMEXIT of IO instruction */
	vmcs_write(CPU_EXEC_CTRL0, ctrl_cpu[0]);
	if (ctrl_cpu_rev[0].set & CPU_SECONDARY) {
		ctrl_cpu[1] = (ctrl_cpu[1] | ctrl_cpu_rev[1].set) &
			ctrl_cpu_rev[1].clr;
		vmcs_write(CPU_EXEC_CTRL1, ctrl_cpu[1]);
	}
	vmcs_write(CR3_TARGET_COUNT, 0);
	vmcs_write(VPID, ++vpid_cnt);
}

static void init_vmcs_host(void)
{
	/* 26.2 CHECKS ON VMX CONTROLS AND HOST-STATE AREA */
	/* 26.2.1.2 */
	vmcs_write(HOST_EFER, rdmsr(MSR_EFER));

	/* 26.2.1.3 */
	vmcs_write(ENT_CONTROLS, ctrl_enter);
	vmcs_write(EXI_CONTROLS, ctrl_exit);

	/* 26.2.2 */
	vmcs_write(HOST_CR0, read_cr0());
	vmcs_write(HOST_CR3, read_cr3());
	vmcs_write(HOST_CR4, read_cr4());
	vmcs_write(HOST_SYSENTER_EIP, (u64)(&entry_sysenter));
	vmcs_write(HOST_SYSENTER_CS,  KERNEL_CS);

	/* 26.2.3 */
	vmcs_write(HOST_SEL_CS, KERNEL_CS);
	vmcs_write(HOST_SEL_SS, KERNEL_DS);
	vmcs_write(HOST_SEL_DS, KERNEL_DS);
	vmcs_write(HOST_SEL_ES, KERNEL_DS);
	vmcs_write(HOST_SEL_FS, KERNEL_DS);
	vmcs_write(HOST_SEL_GS, KERNEL_DS);
	vmcs_write(HOST_SEL_TR, TSS_MAIN);
	vmcs_write(HOST_BASE_TR, tss_descr.base);
	vmcs_write(HOST_BASE_GDTR, gdt64_desc.base);
	vmcs_write(HOST_BASE_IDTR, idt_descr.base);
	vmcs_write(HOST_BASE_FS, 0);
	vmcs_write(HOST_BASE_GS, 0);

	/* Set other vmcs area */
	vmcs_write(PF_ERROR_MASK, 0);
	vmcs_write(PF_ERROR_MATCH, 0);
	vmcs_write(VMCS_LINK_PTR, ~0ul);
	vmcs_write(VMCS_LINK_PTR_HI, ~0ul);
	vmcs_write(HOST_RIP, (u64)(&vmx_return));
}

static void init_vmcs_guest(void)
{
	/* 26.3 CHECKING AND LOADING GUEST STATE */
	ulong guest_cr0, guest_cr4, guest_cr3;
	/* 26.3.1.1 */
	guest_cr0 = read_cr0();
	guest_cr4 = read_cr4();
	guest_cr3 = read_cr3();
	if (ctrl_enter & ENT_GUEST_64) {
		guest_cr0 |= X86_CR0_PG;
		guest_cr4 |= X86_CR4_PAE;
	}
	if ((ctrl_enter & ENT_GUEST_64) == 0)
		guest_cr4 &= (~X86_CR4_PCIDE);
	if (guest_cr0 & X86_CR0_PG)
		guest_cr0 |= X86_CR0_PE;
	vmcs_write(GUEST_CR0, guest_cr0);
	vmcs_write(GUEST_CR3, guest_cr3);
	vmcs_write(GUEST_CR4, guest_cr4);
	vmcs_write(GUEST_SYSENTER_CS,  KERNEL_CS);
	vmcs_write(GUEST_SYSENTER_ESP,
		(u64)(guest_syscall_stack + PAGE_SIZE - 1));
	vmcs_write(GUEST_SYSENTER_EIP, (u64)(&entry_sysenter));
	vmcs_write(GUEST_DR7, 0);
	vmcs_write(GUEST_EFER, rdmsr(MSR_EFER));

	/* 26.3.1.2 */
	vmcs_write(GUEST_SEL_CS, KERNEL_CS);
	vmcs_write(GUEST_SEL_SS, KERNEL_DS);
	vmcs_write(GUEST_SEL_DS, KERNEL_DS);
	vmcs_write(GUEST_SEL_ES, KERNEL_DS);
	vmcs_write(GUEST_SEL_FS, KERNEL_DS);
	vmcs_write(GUEST_SEL_GS, KERNEL_DS);
	vmcs_write(GUEST_SEL_TR, TSS_MAIN);
	vmcs_write(GUEST_SEL_LDTR, 0);

	vmcs_write(GUEST_BASE_CS, 0);
	vmcs_write(GUEST_BASE_ES, 0);
	vmcs_write(GUEST_BASE_SS, 0);
	vmcs_write(GUEST_BASE_DS, 0);
	vmcs_write(GUEST_BASE_FS, 0);
	vmcs_write(GUEST_BASE_GS, 0);
	vmcs_write(GUEST_BASE_TR, tss_descr.base);
	vmcs_write(GUEST_BASE_LDTR, 0);

	vmcs_write(GUEST_LIMIT_CS, 0xFFFFFFFF);
	vmcs_write(GUEST_LIMIT_DS, 0xFFFFFFFF);
	vmcs_write(GUEST_LIMIT_ES, 0xFFFFFFFF);
	vmcs_write(GUEST_LIMIT_SS, 0xFFFFFFFF);
	vmcs_write(GUEST_LIMIT_FS, 0xFFFFFFFF);
	vmcs_write(GUEST_LIMIT_GS, 0xFFFFFFFF);
	vmcs_write(GUEST_LIMIT_LDTR, 0xffff);
	vmcs_write(GUEST_LIMIT_TR, tss_descr.limit);

	vmcs_write(GUEST_AR_CS, 0xa09b);
	vmcs_write(GUEST_AR_DS, 0xc093);
	vmcs_write(GUEST_AR_ES, 0xc093);
	vmcs_write(GUEST_AR_FS, 0xc093);
	vmcs_write(GUEST_AR_GS, 0xc093);
	vmcs_write(GUEST_AR_SS, 0xc093);
	vmcs_write(GUEST_AR_LDTR, 0x82);
	vmcs_write(GUEST_AR_TR, 0x8b);

	/* 26.3.1.3 */
	vmcs_write(GUEST_BASE_GDTR, gdt64_desc.base);
	vmcs_write(GUEST_BASE_IDTR, idt_descr.base);
	vmcs_write(GUEST_LIMIT_GDTR, gdt64_desc.limit);
	vmcs_write(GUEST_LIMIT_IDTR, idt_descr.limit);

	/* 26.3.1.4 */
	vmcs_write(GUEST_RIP, (u64)(&guest_entry));
	vmcs_write(GUEST_RSP, (u64)(guest_stack + PAGE_SIZE - 1));
	vmcs_write(GUEST_RFLAGS, 0x2);

	/* 26.3.1.5 */
	vmcs_write(GUEST_ACTV_STATE, ACTV_ACTIVE);
	vmcs_write(GUEST_INTR_STATE, 0);
}

static int init_vmcs(struct vmcs **vmcs)
{
	*vmcs = alloc_page();
	memset(*vmcs, 0, PAGE_SIZE);
	(*vmcs)->revision_id = basic.revision;
	/* vmclear first to init vmcs */
	if (vmcs_clear(*vmcs)) {
		printf("%s : vmcs_clear error\n", __func__);
		return 1;
	}

	if (make_vmcs_current(*vmcs)) {
		printf("%s : make_vmcs_current error\n", __func__);
		return 1;
	}

	/* All settings to pin/exit/enter/cpu
	   control fields should be placed here */
	ctrl_pin |= PIN_EXTINT | PIN_NMI | PIN_VIRT_NMI;
	ctrl_exit = EXI_LOAD_EFER | EXI_HOST_64;
	ctrl_enter = (ENT_LOAD_EFER | ENT_GUEST_64);
	/* DIsable IO instruction VMEXIT now */
	ctrl_cpu[0] &= (~(CPU_IO | CPU_IO_BITMAP));
	ctrl_cpu[1] = 0;

	ctrl_pin = (ctrl_pin | ctrl_pin_rev.set) & ctrl_pin_rev.clr;
	ctrl_enter = (ctrl_enter | ctrl_enter_rev.set) & ctrl_enter_rev.clr;
	ctrl_exit = (ctrl_exit | ctrl_exit_rev.set) & ctrl_exit_rev.clr;
	ctrl_cpu[0] = (ctrl_cpu[0] | ctrl_cpu_rev[0].set) & ctrl_cpu_rev[0].clr;

	init_vmcs_ctrl();
	init_vmcs_host();
	init_vmcs_guest();
	return 0;
}

static void init_vmx(void)
{
	ulong fix_cr0_set, fix_cr0_clr;
	ulong fix_cr4_set, fix_cr4_clr;

	vmxon_region = alloc_page();
	memset(vmxon_region, 0, PAGE_SIZE);

	fix_cr0_set =  rdmsr(MSR_IA32_VMX_CR0_FIXED0);
	fix_cr0_clr =  rdmsr(MSR_IA32_VMX_CR0_FIXED1);
	fix_cr4_set =  rdmsr(MSR_IA32_VMX_CR4_FIXED0);
	fix_cr4_clr = rdmsr(MSR_IA32_VMX_CR4_FIXED1);
	basic.val = rdmsr(MSR_IA32_VMX_BASIC);
	ctrl_pin_rev.val = rdmsr(basic.ctrl ? MSR_IA32_VMX_TRUE_PIN
			: MSR_IA32_VMX_PINBASED_CTLS);
	ctrl_exit_rev.val = rdmsr(basic.ctrl ? MSR_IA32_VMX_TRUE_EXIT
			: MSR_IA32_VMX_EXIT_CTLS);
	ctrl_enter_rev.val = rdmsr(basic.ctrl ? MSR_IA32_VMX_TRUE_ENTRY
			: MSR_IA32_VMX_ENTRY_CTLS);
	ctrl_cpu_rev[0].val = rdmsr(basic.ctrl ? MSR_IA32_VMX_TRUE_PROC
			: MSR_IA32_VMX_PROCBASED_CTLS);
	if ((ctrl_cpu_rev[0].clr & CPU_SECONDARY) != 0)
		ctrl_cpu_rev[1].val = rdmsr(MSR_IA32_VMX_PROCBASED_CTLS2);
	else
		ctrl_cpu_rev[1].val = 0;
	if ((ctrl_cpu_rev[1].clr & (CPU_EPT | CPU_VPID)) != 0)
		ept_vpid.val = rdmsr(MSR_IA32_VMX_EPT_VPID_CAP);
	else
		ept_vpid.val = 0;

	write_cr0((read_cr0() & fix_cr0_clr) | fix_cr0_set);
	write_cr4((read_cr4() & fix_cr4_clr) | fix_cr4_set | X86_CR4_VMXE);

	*vmxon_region = basic.revision;

	guest_stack = alloc_page();
	memset(guest_stack, 0, PAGE_SIZE);
	guest_syscall_stack = alloc_page();
	memset(guest_syscall_stack, 0, PAGE_SIZE);
}

static void do_vmxon_off(void *data)
{
	vmx_on();
	vmx_off();
}

static void do_write_feature_control(void *data)
{
	wrmsr(MSR_IA32_FEATURE_CONTROL, 0);
}

static int test_vmx_feature_control(void)
{
	u64 ia32_feature_control;
	bool vmx_enabled;

	ia32_feature_control = rdmsr(MSR_IA32_FEATURE_CONTROL);
	vmx_enabled = ((ia32_feature_control & 0x5) == 0x5);
	if ((ia32_feature_control & 0x5) == 0x5) {
		printf("VMX enabled and locked by BIOS\n");
		return 0;
	} else if (ia32_feature_control & 0x1) {
		printf("ERROR: VMX locked out by BIOS!?\n");
		return 1;
	}

	wrmsr(MSR_IA32_FEATURE_CONTROL, 0);
	report("test vmxon with FEATURE_CONTROL cleared",
	       test_for_exception(GP_VECTOR, &do_vmxon_off, NULL));

	wrmsr(MSR_IA32_FEATURE_CONTROL, 0x4);
	report("test vmxon without FEATURE_CONTROL lock",
	       test_for_exception(GP_VECTOR, &do_vmxon_off, NULL));

	wrmsr(MSR_IA32_FEATURE_CONTROL, 0x5);
	vmx_enabled = ((rdmsr(MSR_IA32_FEATURE_CONTROL) & 0x5) == 0x5);
	report("test enable VMX in FEATURE_CONTROL", vmx_enabled);

	report("test FEATURE_CONTROL lock bit",
	       test_for_exception(GP_VECTOR, &do_write_feature_control, NULL));

	return !vmx_enabled;
}

static int test_vmxon(void)
{
	int ret, ret1;
	u64 *tmp_region = vmxon_region;
	int width = cpuid_maxphyaddr();

	/* Unaligned page access */
	vmxon_region = (u64 *)((intptr_t)vmxon_region + 1);
	ret1 = vmx_on();
	report("test vmxon with unaligned vmxon region", ret1);
	if (!ret1) {
		ret = 1;
		goto out;
	}

	/* gpa bits beyond physical address width are set*/
	vmxon_region = (u64 *)((intptr_t)tmp_region | ((u64)1 << (width+1)));
	ret1 = vmx_on();
	report("test vmxon with bits set beyond physical address width", ret1);
	if (!ret1) {
		ret = 1;
		goto out;
	}

	/* invalid revision indentifier */
	vmxon_region = tmp_region;
	*vmxon_region = 0xba9da9;
	ret1 = vmx_on();
	report("test vmxon with invalid revision identifier", ret1);
	if (!ret1) {
		ret = 1;
		goto out;
	}

	/* and finally a valid region */
	*vmxon_region = basic.revision;
	ret = vmx_on();
	report("test vmxon with valid vmxon region", !ret);

out:
	return ret;
}

static void test_vmptrld(void)
{
	struct vmcs *vmcs, *tmp_root;
	int width = cpuid_maxphyaddr();

	vmcs = alloc_page();
	vmcs->revision_id = basic.revision;

	/* Unaligned page access */
	tmp_root = (struct vmcs *)((intptr_t)vmcs + 1);
	report("test vmptrld with unaligned vmcs",
	       make_vmcs_current(tmp_root) == 1);

	/* gpa bits beyond physical address width are set*/
	tmp_root = (struct vmcs *)((intptr_t)vmcs |
				   ((u64)1 << (width+1)));
	report("test vmptrld with vmcs address bits set beyond physical address width",
	       make_vmcs_current(tmp_root) == 1);

	/* Pass VMXON region */
	make_vmcs_current(vmcs);
	tmp_root = (struct vmcs *)vmxon_region;
	report("test vmptrld with vmxon region",
	       make_vmcs_current(tmp_root) == 1);
	report("test vmptrld with vmxon region vm-instruction error",
	       vmcs_read(VMX_INST_ERROR) == VMXERR_VMPTRLD_VMXON_POINTER);

	report("test vmptrld with valid vmcs region", make_vmcs_current(vmcs) == 0);
}

static void test_vmptrst(void)
{
	int ret;
	struct vmcs *vmcs1, *vmcs2;

	vmcs1 = alloc_page();
	memset(vmcs1, 0, PAGE_SIZE);
	init_vmcs(&vmcs1);
	ret = vmcs_save(&vmcs2);
	report("test vmptrst", (!ret) && (vmcs1 == vmcs2));
}

struct vmx_ctl_msr {
	const char *name;
	u32 index, true_index;
	u32 default1;
} vmx_ctl_msr[] = {
	{ "MSR_IA32_VMX_PINBASED_CTLS", MSR_IA32_VMX_PINBASED_CTLS,
	  MSR_IA32_VMX_TRUE_PIN, 0x16 },
	{ "MSR_IA32_VMX_PROCBASED_CTLS", MSR_IA32_VMX_PROCBASED_CTLS,
	  MSR_IA32_VMX_TRUE_PROC, 0x401e172 },
	{ "MSR_IA32_VMX_PROCBASED_CTLS2", MSR_IA32_VMX_PROCBASED_CTLS2,
	  MSR_IA32_VMX_PROCBASED_CTLS2, 0 },
	{ "MSR_IA32_VMX_EXIT_CTLS", MSR_IA32_VMX_EXIT_CTLS,
	  MSR_IA32_VMX_TRUE_EXIT, 0x36dff },
	{ "MSR_IA32_VMX_ENTRY_CTLS", MSR_IA32_VMX_ENTRY_CTLS,
	  MSR_IA32_VMX_TRUE_ENTRY, 0x11ff },
};

static void test_vmx_caps(void)
{
	u64 val, default1, fixed0, fixed1;
	union vmx_ctrl_msr ctrl, true_ctrl;
	unsigned int n;
	bool ok;

	printf("\nTest suite: VMX capability reporting\n");

	report("MSR_IA32_VMX_BASIC",
	       (basic.revision & (1ul << 31)) == 0 &&
	       basic.size > 0 && basic.size <= 4096 &&
	       (basic.type == 0 || basic.type == 6) &&
	       basic.reserved1 == 0 && basic.reserved2 == 0);

	val = rdmsr(MSR_IA32_VMX_MISC);
	report("MSR_IA32_VMX_MISC",
	       (!(ctrl_cpu_rev[1].clr & CPU_URG) || val & (1ul << 5)) &&
	       ((val >> 16) & 0x1ff) <= 256 &&
	       (val & 0xc0007e00) == 0);

	for (n = 0; n < ARRAY_SIZE(vmx_ctl_msr); n++) {
		ctrl.val = rdmsr(vmx_ctl_msr[n].index);
		default1 = vmx_ctl_msr[n].default1;
		ok = (ctrl.set & default1) == default1;
		ok = ok && (ctrl.set & ~ctrl.clr) == 0;
		if (ok && basic.ctrl) {
			true_ctrl.val = rdmsr(vmx_ctl_msr[n].true_index);
			ok = ctrl.clr == true_ctrl.clr;
			ok = ok && ctrl.set == (true_ctrl.set | default1);
		}
		report("%s", ok, vmx_ctl_msr[n].name);
	}

	fixed0 = rdmsr(MSR_IA32_VMX_CR0_FIXED0);
	fixed1 = rdmsr(MSR_IA32_VMX_CR0_FIXED1);
	report("MSR_IA32_VMX_IA32_VMX_CR0_FIXED0/1",
	       ((fixed0 ^ fixed1) & ~fixed1) == 0);

	fixed0 = rdmsr(MSR_IA32_VMX_CR4_FIXED0);
	fixed1 = rdmsr(MSR_IA32_VMX_CR4_FIXED1);
	report("MSR_IA32_VMX_IA32_VMX_CR4_FIXED0/1",
	       ((fixed0 ^ fixed1) & ~fixed1) == 0);

	val = rdmsr(MSR_IA32_VMX_VMCS_ENUM);
	report("MSR_IA32_VMX_VMCS_ENUM",
	       (val & 0x3e) >= 0x2a &&
	       (val & 0xfffffffffffffc01Ull) == 0);

	val = rdmsr(MSR_IA32_VMX_EPT_VPID_CAP);
	report("MSR_IA32_VMX_EPT_VPID_CAP",
	       (val & 0xfffff07ef98cbebeUll) == 0);
}

/* This function can only be called in guest */
static void __attribute__((__used__)) hypercall(u32 hypercall_no)
{
	u64 val = 0;
	val = (hypercall_no & HYPERCALL_MASK) | HYPERCALL_BIT;
	hypercall_field = val;
	asm volatile("vmcall\n\t");
}

static bool is_hypercall()
{
	ulong reason, hyper_bit;

	reason = vmcs_read(EXI_REASON) & 0xff;
	hyper_bit = hypercall_field & HYPERCALL_BIT;
	if (reason == VMX_VMCALL && hyper_bit)
		return true;
	return false;
}

static int handle_hypercall()
{
	ulong hypercall_no;

	hypercall_no = hypercall_field & HYPERCALL_MASK;
	hypercall_field = 0;
	switch (hypercall_no) {
	case HYPERCALL_VMEXIT:
		return VMX_TEST_VMEXIT;
	case HYPERCALL_VMABORT:
		return VMX_TEST_VMABORT;
	case HYPERCALL_VMSKIP:
		return VMX_TEST_VMSKIP;
	default:
		printf("ERROR : Invalid hypercall number : %ld\n", hypercall_no);
	}
	return VMX_TEST_EXIT;
}

static void continue_abort(void)
{
	assert(!in_guest);
	printf("Host was here when guest aborted:\n");
	dump_stack();
	longjmp(abort_target, 1);
	abort();
}

void __abort_test(void)
{
	if (in_guest)
		hypercall(HYPERCALL_VMABORT);
	else
		longjmp(abort_target, 1);
	abort();
}

static void continue_skip(void)
{
	assert(!in_guest);
	longjmp(abort_target, 1);
	abort();
}

void test_skip(const char *msg)
{
	printf("%s skipping test: %s\n", in_guest ? "Guest" : "Host", msg);
	if (in_guest)
		hypercall(HYPERCALL_VMABORT);
	else
		longjmp(abort_target, 1);
	abort();
}

static int exit_handler()
{
	int ret;

	current->exits++;
	regs.rflags = vmcs_read(GUEST_RFLAGS);
	if (is_hypercall())
		ret = handle_hypercall();
	else
		ret = current->exit_handler();
	vmcs_write(GUEST_RFLAGS, regs.rflags);

	return ret;
}

/*
 * Called if vmlaunch or vmresume fails.
 *	@early    - failure due to "VMX controls and host-state area" (26.2)
 *	@vmlaunch - was this a vmlaunch or vmresume
 *	@rflags   - host rflags
 */
static int
entry_failure_handler(struct vmentry_failure *failure)
{
	if (current->entry_failure_handler)
		return current->entry_failure_handler(failure);
	else
		return VMX_TEST_EXIT;
}

/*
 * Tries to enter the guest. Returns true iff entry succeeded. Otherwise,
 * populates @failure.
 */
static bool vmx_enter_guest(struct vmentry_failure *failure)
{
	failure->early = 0;

	in_guest = 1;
	asm volatile (
		"mov %[HOST_RSP], %%rdi\n\t"
		"vmwrite %%rsp, %%rdi\n\t"
		LOAD_GPR_C
		"cmpb $0, %[launched]\n\t"
		"jne 1f\n\t"
		"vmlaunch\n\t"
		"jmp 2f\n\t"
		"1: "
		"vmresume\n\t"
		"2: "
		SAVE_GPR_C
		"pushf\n\t"
		"pop %%rdi\n\t"
		"mov %%rdi, %[failure_flags]\n\t"
		"movl $1, %[failure_flags]\n\t"
		"jmp 3f\n\t"
		"vmx_return:\n\t"
		SAVE_GPR_C
		"3: \n\t"
		: [failure_early]"+m"(failure->early),
		  [failure_flags]"=m"(failure->flags)
		: [launched]"m"(launched), [HOST_RSP]"i"(HOST_RSP)
		: "rdi", "memory", "cc"
	);
	in_guest = 0;

	failure->vmlaunch = !launched;
	failure->instr = launched ? "vmresume" : "vmlaunch";

	return !failure->early && !(vmcs_read(EXI_REASON) & VMX_ENTRY_FAILURE);
}

static int vmx_run()
{
	while (1) {
		u32 ret;
		bool entered;
		struct vmentry_failure failure;

		entered = vmx_enter_guest(&failure);

		if (entered) {
			/*
			 * VMCS isn't in "launched" state if there's been any
			 * entry failure (early or otherwise).
			 */
			launched = 1;
			ret = exit_handler();
		} else {
			ret = entry_failure_handler(&failure);
		}

		switch (ret) {
		case VMX_TEST_RESUME:
			continue;
		case VMX_TEST_VMEXIT:
			guest_finished = 1;
			return 0;
		case VMX_TEST_EXIT:
			break;
		default:
			printf("ERROR : Invalid %s_handler return val %d.\n",
			       entered ? "exit" : "entry_failure",
			       ret);
			break;
		}

		if (entered)
			print_vmexit_info();
		else
			print_vmentry_failure_info(&failure);
		abort();
	}
}

static void run_teardown_step(struct test_teardown_step *step)
{
	step->func(step->data);
}

static int test_run(struct vmx_test *test)
{
	int r;

	/* Validate V2 interface. */
	if (test->v2) {
		int ret = 0;
		if (test->init || test->guest_main || test->exit_handler ||
		    test->syscall_handler) {
			report("V2 test cannot specify V1 callbacks.", 0);
			ret = 1;
		}
		if (ret)
			return ret;
	}

	if (test->name == NULL)
		test->name = "(no name)";
	if (vmx_on()) {
		printf("%s : vmxon failed.\n", __func__);
		return 1;
	}

	init_vmcs(&(test->vmcs));
	/* Directly call test->init is ok here, init_vmcs has done
	   vmcs init, vmclear and vmptrld*/
	if (test->init && test->init(test->vmcs) != VMX_TEST_START)
		goto out;
	teardown_count = 0;
	v2_guest_main = NULL;
	test->exits = 0;
	current = test;
	regs = test->guest_regs;
	vmcs_write(GUEST_RFLAGS, regs.rflags | 0x2);
	launched = 0;
	guest_finished = 0;
	printf("\nTest suite: %s\n", test->name);

	r = setjmp(abort_target);
	if (r) {
		assert(!in_guest);
		goto out;
	}


	if (test->v2)
		test->v2();
	else
		vmx_run();

	while (teardown_count > 0)
		run_teardown_step(&teardown_steps[--teardown_count]);

	if (launched && !guest_finished)
		report("Guest didn't run to completion.", 0);

out:
	if (vmx_off()) {
		printf("%s : vmxoff failed.\n", __func__);
		return 1;
	}
	return 0;
}

/*
 * Add a teardown step. Executed after the test's main function returns.
 * Teardown steps executed in reverse order.
 */
void test_add_teardown(test_teardown_func func, void *data)
{
	struct test_teardown_step *step;

	TEST_ASSERT_MSG(teardown_count < MAX_TEST_TEARDOWN_STEPS,
			"There are already %d teardown steps.",
			teardown_count);
	step = &teardown_steps[teardown_count++];
	step->func = func;
	step->data = data;
}

/*
 * Set the target of the first enter_guest call. Can only be called once per
 * test. Must be called before first enter_guest call.
 */
void test_set_guest(test_guest_func func)
{
	assert(current->v2);
	TEST_ASSERT_MSG(!v2_guest_main, "Already set guest func.");
	v2_guest_main = func;
}

/*
 * Enters the guest (or launches it for the first time). Error to call once the
 * guest has returned (i.e., run past the end of its guest() function). Also
 * aborts if guest entry fails.
 */
void enter_guest(void)
{
	struct vmentry_failure failure;

	TEST_ASSERT_MSG(v2_guest_main,
			"Never called test_set_guest_func!");

	TEST_ASSERT_MSG(!guest_finished,
			"Called enter_guest() after guest returned.");

	if (!vmx_enter_guest(&failure)) {
		print_vmentry_failure_info(&failure);
		abort();
	}

	launched = 1;

	if (is_hypercall()) {
		int ret;

		ret = handle_hypercall();
		switch (ret) {
		case VMX_TEST_VMEXIT:
			guest_finished = 1;
			break;
		case VMX_TEST_VMABORT:
			continue_abort();
			break;
		case VMX_TEST_VMSKIP:
			continue_skip();
			break;
		default:
			printf("ERROR : Invalid handle_hypercall return %d.\n",
			       ret);
			abort();
		}
	}
}

extern struct vmx_test vmx_tests[];

static bool
test_wanted(const char *name, const char *filters[], int filter_count)
{
	int i;
	bool positive = false;
	bool match = false;
	char clean_name[strlen(name) + 1];
	char *c;
	const char *n;

	/* Replace spaces with underscores. */
	n = name;
	c = &clean_name[0];
	do *c++ = (*n == ' ') ? '_' : *n;
	while (*n++);

	for (i = 0; i < filter_count; i++) {
		const char *filter = filters[i];

		if (filter[0] == '-') {
			if (simple_glob(clean_name, filter + 1))
				return false;
		} else {
			positive = true;
			match |= simple_glob(clean_name, filter);
		}
	}

	if (!positive || match) {
		matched++;
		return true;
	} else {
		return false;
	}
}

int main(int argc, const char *argv[])
{
	int i = 0;

	setup_vm();
	setup_idt();
	hypercall_field = 0;

	argv++;
	argc--;

	if (!(cpuid(1).c & (1 << 5))) {
		printf("WARNING: vmx not supported, add '-cpu host'\n");
		goto exit;
	}
	init_vmx();
	if (test_wanted("test_vmx_feature_control", argv, argc)) {
		/* Sets MSR_IA32_FEATURE_CONTROL to 0x5 */
		if (test_vmx_feature_control() != 0)
			goto exit;
	} else {
		if ((rdmsr(MSR_IA32_FEATURE_CONTROL) & 0x5) != 0x5)
			wrmsr(MSR_IA32_FEATURE_CONTROL, 0x5);
	}

	if (test_wanted("test_vmxon", argv, argc)) {
		/* Enables VMX */
		if (test_vmxon() != 0)
			goto exit;
	} else {
		if (vmx_on()) {
			report("vmxon", 0);
			goto exit;
		}
	}

	if (test_wanted("test_vmptrld", argv, argc))
		test_vmptrld();
	if (test_wanted("test_vmclear", argv, argc))
		test_vmclear();
	if (test_wanted("test_vmptrst", argv, argc))
		test_vmptrst();
	if (test_wanted("test_vmwrite_vmread", argv, argc))
		test_vmwrite_vmread();
	if (test_wanted("test_vmcs_lifecycle", argv, argc))
		test_vmcs_lifecycle();
	if (test_wanted("test_vmx_caps", argv, argc))
		test_vmx_caps();

	/* Balance vmxon from test_vmxon. */
	vmx_off();

	for (; vmx_tests[i].name != NULL; i++) {
		if (!test_wanted(vmx_tests[i].name, argv, argc))
			continue;
		if (test_run(&vmx_tests[i]))
			goto exit;
	}

	if (!matched)
		report("command line didn't match any tests!", matched);

exit:
	return report_summary();
}
