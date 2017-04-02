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
u64 hypercall_field;
bool launched;

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

static int make_vmcs_current(struct vmcs *vmcs)
{
	bool ret;
	u64 rflags = read_rflags() | X86_EFLAGS_CF | X86_EFLAGS_ZF;

	asm volatile ("push %1; popf; vmptrld %2; setbe %0"
		      : "=q" (ret) : "q" (rflags), "m" (vmcs) : "cc");
	return ret;
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

static inline int vmx_on()
{
	bool ret;
	u64 rflags = read_rflags() | X86_EFLAGS_CF | X86_EFLAGS_ZF;
	asm volatile ("push %1; popf; vmxon %2; setbe %0\n\t"
		      : "=q" (ret) : "q" (rflags), "m" (vmxon_region) : "cc");
	return ret;
}

static inline int vmx_off()
{
	bool ret;
	u64 rflags = read_rflags() | X86_EFLAGS_CF | X86_EFLAGS_ZF;

	asm volatile("push %1; popf; vmxoff; setbe %0\n\t"
		     : "=q"(ret) : "q" (rflags) : "cc");
	return ret;
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
	printf("\texit qualification = 0x%lx\n", exit_qual);
	printf("\tBit 31 of reason = %lx\n", (vmcs_read(EXI_REASON) >> 31) & 1);
	printf("\tguest_rip = 0x%lx\n", guest_rip);
	printf("\tRAX=0x%lx    RBX=0x%lx    RCX=0x%lx    RDX=0x%lx\n",
		regs.rax, regs.rbx, regs.rcx, regs.rdx);
	printf("\tRSP=0x%lx    RBP=0x%lx    RSI=0x%lx    RDI=0x%lx\n",
		guest_rsp, regs.rbp, regs.rsi, regs.rdi);
	printf("\tR8 =0x%lx    R9 =0x%lx    R10=0x%lx    R11=0x%lx\n",
		regs.r8, regs.r9, regs.r10, regs.r11);
	printf("\tR12=0x%lx    R13=0x%lx    R14=0x%lx    R15=0x%lx\n",
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

		printf("Non-early %s failure (reason=0x%lx, qual=0x%lx): ",
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

}

static void test_vmxoff(void)
{
	int ret;

	ret = vmx_off();
	report("test vmxoff", !ret);
}

static void __attribute__((__used__)) guest_main(void)
{
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
unsigned long get_ept_pte(unsigned long *pml4,
		unsigned long guest_addr, int level)
{
	int l;
	unsigned long *pt = pml4, pte;
	unsigned offset;

	if (level < 1 || level > 3)
		return -1;
	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
		pte = pt[offset];
		if (!(pte & (EPT_PRESENT)))
			return 0;
		if (l == level)
			break;
		if (l < 4 && (pte & EPT_LARGE_PAGE))
			return pte;
		pt = (unsigned long *)(pte & EPT_ADDR_MASK);
	}
	offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
	pte = pt[offset];
	return pte;
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

int set_ept_pte(unsigned long *pml4, unsigned long guest_addr,
		int level, u64 pte_val)
{
	int l;
	unsigned long *pt = pml4;
	unsigned offset;

	if (level < 1 || level > 3)
		return -1;
	for (l = EPT_PAGE_LEVEL; ; --l) {
		offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
		if (l == level)
			break;
		if (!(pt[offset] & (EPT_PRESENT)))
			return -1;
		pt = (unsigned long *)(pt[offset] & EPT_ADDR_MASK);
	}
	offset = (guest_addr >> EPT_LEVEL_SHIFT(l)) & EPT_PGDIR_MASK;
	pt[offset] = pte_val;
	return 0;
}

void vpid_sync(int type, u16 vpid)
{
	switch(type) {
	case INVVPID_SINGLE:
		if (ept_vpid.val & VPID_CAP_INVVPID_SINGLE) {
			invvpid(INVVPID_SINGLE, vpid, 0);
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
	tmp_root = (struct vmcs *)vmxon_region;
	report("test vmptrld with vmxon region",
	       make_vmcs_current(tmp_root) == 1);

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
		report(vmx_ctl_msr[n].name, ok);
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
	       (val & 0xfffff07ef9eebebeUll) == 0);
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
	default:
		printf("ERROR : Invalid hypercall number : %ld\n", hypercall_no);
	}
	return VMX_TEST_EXIT;
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

static int vmx_run()
{
	unsigned long host_rflags;

	while (1) {
		u32 ret;
		u32 fail = 0;
		bool entered;
		struct vmentry_failure failure;

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
			"mov %%rdi, %[host_rflags]\n\t"
			"movl $1, %[fail]\n\t"
			"jmp 3f\n\t"
			"vmx_return:\n\t"
			SAVE_GPR_C
			"3: \n\t"
			: [fail]"+m"(fail), [host_rflags]"=m"(host_rflags)
			: [launched]"m"(launched), [HOST_RSP]"i"(HOST_RSP)
			: "rdi", "memory", "cc"

		);

		entered = !fail && !(vmcs_read(EXI_REASON) & VMX_ENTRY_FAILURE);

		if (entered) {
			/*
			 * VMCS isn't in "launched" state if there's been any
			 * entry failure (early or otherwise).
			 */
			launched = 1;
			ret = exit_handler();
		} else {
			failure.flags = host_rflags;
			failure.vmlaunch = !launched;
			failure.instr = launched ? "vmresume" : "vmlaunch";
			failure.early = fail;
			ret = entry_failure_handler(&failure);
		}

		switch (ret) {
		case VMX_TEST_RESUME:
			continue;
		case VMX_TEST_VMEXIT:
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

static int test_run(struct vmx_test *test)
{
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
	test->exits = 0;
	current = test;
	regs = test->guest_regs;
	vmcs_write(GUEST_RFLAGS, regs.rflags | 0x2);
	launched = 0;
	printf("\nTest suite: %s\n", test->name);
	vmx_run();
out:
	if (vmx_off()) {
		printf("%s : vmxoff failed.\n", __func__);
		return 1;
	}
	return 0;
}

extern struct vmx_test vmx_tests[];

int main(void)
{
	int i = 0;

	setup_vm();
	setup_idt();
	hypercall_field = 0;

	if (!(cpuid(1).c & (1 << 5))) {
		printf("WARNING: vmx not supported, add '-cpu host'\n");
		goto exit;
	}
	init_vmx();
	if (test_vmx_feature_control() != 0)
		goto exit;
	/* Set basic test ctxt the same as "null" */
	current = &vmx_tests[0];
	if (test_vmxon() != 0)
		goto exit;
	test_vmptrld();
	test_vmclear();
	test_vmptrst();
	init_vmcs(&vmcs_root);
	if (vmx_run()) {
		report("test vmlaunch", 0);
		goto exit;
	}
	test_vmxoff();
	test_vmx_caps();

	while (vmx_tests[++i].name != NULL)
		if (test_run(&vmx_tests[i]))
			goto exit;

exit:
	return report_summary();
}
