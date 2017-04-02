#include "svm.h"
#include "libcflat.h"
#include "processor.h"
#include "desc.h"
#include "msr.h"
#include "vm.h"
#include "smp.h"
#include "types.h"

/* for the nested page table*/
u64 *pml4e;
u64 *pdpe;
u64 *pde[4];
u64 *pte[2048];
void *scratch_page;

#define LATENCY_RUNS 1000000

u64 tsc_start;
u64 tsc_end;

u64 vmrun_sum, vmexit_sum;
u64 vmsave_sum, vmload_sum;
u64 stgi_sum, clgi_sum;
u64 latvmrun_max;
u64 latvmrun_min;
u64 latvmexit_max;
u64 latvmexit_min;
u64 latvmload_max;
u64 latvmload_min;
u64 latvmsave_max;
u64 latvmsave_min;
u64 latstgi_max;
u64 latstgi_min;
u64 latclgi_max;
u64 latclgi_min;
u64 runs;

u8 *io_bitmap;
u8 io_bitmap_area[16384];

static bool npt_supported(void)
{
   return cpuid(0x8000000A).d & 1;
}

static void setup_svm(void)
{
    void *hsave = alloc_page();
    u64 *page, address;
    int i,j;

    wrmsr(MSR_VM_HSAVE_PA, virt_to_phys(hsave));
    wrmsr(MSR_EFER, rdmsr(MSR_EFER) | EFER_SVME);
    wrmsr(MSR_EFER, rdmsr(MSR_EFER) | EFER_NX);

    scratch_page = alloc_page();

    io_bitmap = (void *) (((ulong)io_bitmap_area + 4095) & ~4095);

    if (!npt_supported())
        return;

    printf("NPT detected - running all tests with NPT enabled\n");

    /*
     * Nested paging supported - Build a nested page table
     * Build the page-table bottom-up and map everything with 4k pages
     * to get enough granularity for the NPT unit-tests.
     */

    address = 0;

    /* PTE level */
    for (i = 0; i < 2048; ++i) {
        page = alloc_page();

        for (j = 0; j < 512; ++j, address += 4096)
            page[j] = address | 0x067ULL;

        pte[i] = page;
    }

    /* PDE level */
    for (i = 0; i < 4; ++i) {
        page = alloc_page();

        for (j = 0; j < 512; ++j)
            page[j] = (u64)pte[(i * 512) + j] | 0x027ULL;

        pde[i] = page;
    }

    /* PDPe level */
    pdpe   = alloc_page();
    for (i = 0; i < 4; ++i)
       pdpe[i] = ((u64)(pde[i])) | 0x27;

    /* PML4e level */
    pml4e    = alloc_page();
    pml4e[0] = ((u64)pdpe) | 0x27;
}

static u64 *npt_get_pde(u64 address)
{
    int i1, i2;

    address >>= 21;
    i1 = (address >> 9) & 0x3;
    i2 = address & 0x1ff;

    return &pde[i1][i2];
}

static u64 *npt_get_pte(u64 address)
{
    int i1, i2;

    address >>= 12;
    i1 = (address >> 9) & 0x7ff;
    i2 = address & 0x1ff;

    return &pte[i1][i2];
}

static void vmcb_set_seg(struct vmcb_seg *seg, u16 selector,
                         u64 base, u32 limit, u32 attr)
{
    seg->selector = selector;
    seg->attrib = attr;
    seg->limit = limit;
    seg->base = base;
}

static void vmcb_ident(struct vmcb *vmcb)
{
    u64 vmcb_phys = virt_to_phys(vmcb);
    struct vmcb_save_area *save = &vmcb->save;
    struct vmcb_control_area *ctrl = &vmcb->control;
    u32 data_seg_attr = 3 | SVM_SELECTOR_S_MASK | SVM_SELECTOR_P_MASK
        | SVM_SELECTOR_DB_MASK | SVM_SELECTOR_G_MASK;
    u32 code_seg_attr = 9 | SVM_SELECTOR_S_MASK | SVM_SELECTOR_P_MASK
        | SVM_SELECTOR_L_MASK | SVM_SELECTOR_G_MASK;
    struct descriptor_table_ptr desc_table_ptr;

    memset(vmcb, 0, sizeof(*vmcb));
    asm volatile ("vmsave" : : "a"(vmcb_phys) : "memory");
    vmcb_set_seg(&save->es, read_es(), 0, -1U, data_seg_attr);
    vmcb_set_seg(&save->cs, read_cs(), 0, -1U, code_seg_attr);
    vmcb_set_seg(&save->ss, read_ss(), 0, -1U, data_seg_attr);
    vmcb_set_seg(&save->ds, read_ds(), 0, -1U, data_seg_attr);
    sgdt(&desc_table_ptr);
    vmcb_set_seg(&save->gdtr, 0, desc_table_ptr.base, desc_table_ptr.limit, 0);
    sidt(&desc_table_ptr);
    vmcb_set_seg(&save->idtr, 0, desc_table_ptr.base, desc_table_ptr.limit, 0);
    ctrl->asid = 1;
    save->cpl = 0;
    save->efer = rdmsr(MSR_EFER);
    save->cr4 = read_cr4();
    save->cr3 = read_cr3();
    save->cr0 = read_cr0();
    save->dr7 = read_dr7();
    save->dr6 = read_dr6();
    save->cr2 = read_cr2();
    save->g_pat = rdmsr(MSR_IA32_CR_PAT);
    save->dbgctl = rdmsr(MSR_IA32_DEBUGCTLMSR);
    ctrl->intercept = (1ULL << INTERCEPT_VMRUN) | (1ULL << INTERCEPT_VMMCALL);
    ctrl->iopm_base_pa = virt_to_phys(io_bitmap);

    if (npt_supported()) {
        ctrl->nested_ctl = 1;
        ctrl->nested_cr3 = (u64)pml4e;
    }
}

struct test {
    const char *name;
    bool (*supported)(void);
    void (*prepare)(struct test *test);
    void (*guest_func)(struct test *test);
    bool (*finished)(struct test *test);
    bool (*succeeded)(struct test *test);
    struct vmcb *vmcb;
    int exits;
    ulong scratch;
};

static inline void vmmcall(void)
{
    asm volatile ("vmmcall" : : : "memory");
}

static void test_thunk(struct test *test)
{
    test->guest_func(test);
    vmmcall();
}

struct regs {
        u64 rax;
        u64 rcx;
        u64 rdx;
        u64 rbx;
        u64 cr2;
        u64 rbp;
        u64 rsi;
        u64 rdi;
        u64 r8;
        u64 r9;
        u64 r10;
        u64 r11;
        u64 r12;
        u64 r13;
        u64 r14;
        u64 r15;
        u64 rflags;
};

struct regs regs;

// rax handled specially below

#define SAVE_GPR_C                              \
        "xchg %%rbx, regs+0x8\n\t"              \
        "xchg %%rcx, regs+0x10\n\t"             \
        "xchg %%rdx, regs+0x18\n\t"             \
        "xchg %%rbp, regs+0x28\n\t"             \
        "xchg %%rsi, regs+0x30\n\t"             \
        "xchg %%rdi, regs+0x38\n\t"             \
        "xchg %%r8, regs+0x40\n\t"              \
        "xchg %%r9, regs+0x48\n\t"              \
        "xchg %%r10, regs+0x50\n\t"             \
        "xchg %%r11, regs+0x58\n\t"             \
        "xchg %%r12, regs+0x60\n\t"             \
        "xchg %%r13, regs+0x68\n\t"             \
        "xchg %%r14, regs+0x70\n\t"             \
        "xchg %%r15, regs+0x78\n\t"

#define LOAD_GPR_C      SAVE_GPR_C

static void test_run(struct test *test, struct vmcb *vmcb)
{
    u64 vmcb_phys = virt_to_phys(vmcb);
    u64 guest_stack[10000];

    test->vmcb = vmcb;
    test->prepare(test);
    vmcb->save.rip = (ulong)test_thunk;
    vmcb->save.rsp = (ulong)(guest_stack + ARRAY_SIZE(guest_stack));
    regs.rdi = (ulong)test;
    do {
        tsc_start = rdtsc();
        asm volatile (
            "clgi \n\t"
            "vmload \n\t"
            "mov regs+0x80, %%r15\n\t"  // rflags
            "mov %%r15, 0x170(%0)\n\t"
            "mov regs, %%r15\n\t"       // rax
            "mov %%r15, 0x1f8(%0)\n\t"
            LOAD_GPR_C
            "vmrun \n\t"
            SAVE_GPR_C
            "mov 0x170(%0), %%r15\n\t"  // rflags
            "mov %%r15, regs+0x80\n\t"
            "mov 0x1f8(%0), %%r15\n\t"  // rax
            "mov %%r15, regs\n\t"
            "vmsave \n\t"
            "stgi"
            : : "a"(vmcb_phys)
            : "rbx", "rcx", "rdx", "rsi",
              "r8", "r9", "r10", "r11" , "r12", "r13", "r14", "r15",
              "memory");
	tsc_end = rdtsc();
        ++test->exits;
    } while (!test->finished(test));

    report("%s", test->succeeded(test), test->name);
}

static bool smp_supported(void)
{
	return cpu_count() > 1;
}

static bool default_supported(void)
{
    return true;
}

static void default_prepare(struct test *test)
{
    vmcb_ident(test->vmcb);
    cli();
}

static bool default_finished(struct test *test)
{
    return true; /* one vmexit */
}

static void null_test(struct test *test)
{
}

static bool null_check(struct test *test)
{
    return test->vmcb->control.exit_code == SVM_EXIT_VMMCALL;
}

static void prepare_no_vmrun_int(struct test *test)
{
    test->vmcb->control.intercept &= ~(1ULL << INTERCEPT_VMRUN);
}

static bool check_no_vmrun_int(struct test *test)
{
    return test->vmcb->control.exit_code == SVM_EXIT_ERR;
}

static void test_vmrun(struct test *test)
{
    asm volatile ("vmrun" : : "a"(virt_to_phys(test->vmcb)));
}

static bool check_vmrun(struct test *test)
{
    return test->vmcb->control.exit_code == SVM_EXIT_VMRUN;
}

static void prepare_cr3_intercept(struct test *test)
{
    default_prepare(test);
    test->vmcb->control.intercept_cr_read |= 1 << 3;
}

static void test_cr3_intercept(struct test *test)
{
    asm volatile ("mov %%cr3, %0" : "=r"(test->scratch) : : "memory");
}

static bool check_cr3_intercept(struct test *test)
{
    return test->vmcb->control.exit_code == SVM_EXIT_READ_CR3;
}

static bool check_cr3_nointercept(struct test *test)
{
    return null_check(test) && test->scratch == read_cr3();
}

static void corrupt_cr3_intercept_bypass(void *_test)
{
    struct test *test = _test;
    extern volatile u32 mmio_insn;

    while (!__sync_bool_compare_and_swap(&test->scratch, 1, 2))
        pause();
    pause();
    pause();
    pause();
    mmio_insn = 0x90d8200f;  // mov %cr3, %rax; nop
}

static void prepare_cr3_intercept_bypass(struct test *test)
{
    default_prepare(test);
    test->vmcb->control.intercept_cr_read |= 1 << 3;
    on_cpu_async(1, corrupt_cr3_intercept_bypass, test);
}

static void test_cr3_intercept_bypass(struct test *test)
{
    ulong a = 0xa0000;

    test->scratch = 1;
    while (test->scratch != 2)
        barrier();

    asm volatile ("mmio_insn: mov %0, (%0); nop"
                  : "+a"(a) : : "memory");
    test->scratch = a;
}

static bool next_rip_supported(void)
{
    return (cpuid(SVM_CPUID_FUNC).d & 8);
}

static void prepare_next_rip(struct test *test)
{
    test->vmcb->control.intercept |= (1ULL << INTERCEPT_RDTSC);
}


static void test_next_rip(struct test *test)
{
    asm volatile ("rdtsc\n\t"
                  ".globl exp_next_rip\n\t"
                  "exp_next_rip:\n\t" ::: "eax", "edx");
}

static bool check_next_rip(struct test *test)
{
    extern char exp_next_rip;
    unsigned long address = (unsigned long)&exp_next_rip;

    return address == test->vmcb->control.next_rip;
}

static void prepare_mode_switch(struct test *test)
{
    test->vmcb->control.intercept_exceptions |= (1ULL << GP_VECTOR)
                                             |  (1ULL << UD_VECTOR)
                                             |  (1ULL << DF_VECTOR)
                                             |  (1ULL << PF_VECTOR);
    test->scratch = 0;
}

static void test_mode_switch(struct test *test)
{
    asm volatile("	cli\n"
		 "	ljmp *1f\n" /* jump to 32-bit code segment */
		 "1:\n"
		 "	.long 2f\n"
		 "	.long " xstr(KERNEL_CS32) "\n"
		 ".code32\n"
		 "2:\n"
		 "	movl %%cr0, %%eax\n"
		 "	btcl  $31, %%eax\n" /* clear PG */
		 "	movl %%eax, %%cr0\n"
		 "	movl $0xc0000080, %%ecx\n" /* EFER */
		 "	rdmsr\n"
		 "	btcl $8, %%eax\n" /* clear LME */
		 "	wrmsr\n"
		 "	movl %%cr4, %%eax\n"
		 "	btcl $5, %%eax\n" /* clear PAE */
		 "	movl %%eax, %%cr4\n"
		 "	movw %[ds16], %%ax\n"
		 "	movw %%ax, %%ds\n"
		 "	ljmpl %[cs16], $3f\n" /* jump to 16 bit protected-mode */
		 ".code16\n"
		 "3:\n"
		 "	movl %%cr0, %%eax\n"
		 "	btcl $0, %%eax\n" /* clear PE  */
		 "	movl %%eax, %%cr0\n"
		 "	ljmpl $0, $4f\n"   /* jump to real-mode */
		 "4:\n"
		 "	vmmcall\n"
		 "	movl %%cr0, %%eax\n"
		 "	btsl $0, %%eax\n" /* set PE  */
		 "	movl %%eax, %%cr0\n"
		 "	ljmpl %[cs32], $5f\n" /* back to protected mode */
		 ".code32\n"
		 "5:\n"
		 "	movl %%cr4, %%eax\n"
		 "	btsl $5, %%eax\n" /* set PAE */
		 "	movl %%eax, %%cr4\n"
		 "	movl $0xc0000080, %%ecx\n" /* EFER */
		 "	rdmsr\n"
		 "	btsl $8, %%eax\n" /* set LME */
		 "	wrmsr\n"
		 "	movl %%cr0, %%eax\n"
		 "	btsl  $31, %%eax\n" /* set PG */
		 "	movl %%eax, %%cr0\n"
		 "	ljmpl %[cs64], $6f\n"    /* back to long mode */
		 ".code64\n\t"
		 "6:\n"
		 "	vmmcall\n"
		 :: [cs16] "i"(KERNEL_CS16), [ds16] "i"(KERNEL_DS16),
		    [cs32] "i"(KERNEL_CS32), [cs64] "i"(KERNEL_CS64)
		 : "rax", "rbx", "rcx", "rdx", "memory");
}

static bool mode_switch_finished(struct test *test)
{
    u64 cr0, cr4, efer;

    cr0  = test->vmcb->save.cr0;
    cr4  = test->vmcb->save.cr4;
    efer = test->vmcb->save.efer;

    /* Only expect VMMCALL intercepts */
    if (test->vmcb->control.exit_code != SVM_EXIT_VMMCALL)
	    return true;

    /* Jump over VMMCALL instruction */
    test->vmcb->save.rip += 3;

    /* Do sanity checks */
    switch (test->scratch) {
    case 0:
        /* Test should be in real mode now - check for this */
        if ((cr0  & 0x80000001) || /* CR0.PG, CR0.PE */
            (cr4  & 0x00000020) || /* CR4.PAE */
            (efer & 0x00000500))   /* EFER.LMA, EFER.LME */
                return true;
        break;
    case 2:
        /* Test should be back in long-mode now - check for this */
        if (((cr0  & 0x80000001) != 0x80000001) || /* CR0.PG, CR0.PE */
            ((cr4  & 0x00000020) != 0x00000020) || /* CR4.PAE */
            ((efer & 0x00000500) != 0x00000500))   /* EFER.LMA, EFER.LME */
		    return true;
	break;
    }

    /* one step forward */
    test->scratch += 1;

    return test->scratch == 2;
}

static bool check_mode_switch(struct test *test)
{
	return test->scratch == 2;
}

static void prepare_ioio(struct test *test)
{
    test->vmcb->control.intercept |= (1ULL << INTERCEPT_IOIO_PROT);
    test->scratch = 0;
    memset(io_bitmap, 0, 8192);
    io_bitmap[8192] = 0xFF;
}

int get_test_stage(struct test *test)
{
    barrier();
    return test->scratch;
}

void inc_test_stage(struct test *test)
{
    barrier();
    test->scratch++;
    barrier();
}

static void test_ioio(struct test *test)
{
    // stage 0, test IO pass
    inb(0x5000);
    outb(0x0, 0x5000);
    if (get_test_stage(test) != 0)
        goto fail;

    // test IO width, in/out
    io_bitmap[0] = 0xFF;
    inc_test_stage(test);
    inb(0x0);
    if (get_test_stage(test) != 2)
        goto fail;

    outw(0x0, 0x0);
    if (get_test_stage(test) != 3)
        goto fail;

    inl(0x0);
    if (get_test_stage(test) != 4)
        goto fail;

    // test low/high IO port
    io_bitmap[0x5000 / 8] = (1 << (0x5000 % 8));
    inb(0x5000);
    if (get_test_stage(test) != 5)
        goto fail;

    io_bitmap[0x9000 / 8] = (1 << (0x9000 % 8));
    inw(0x9000);
    if (get_test_stage(test) != 6)
        goto fail;

    // test partial pass
    io_bitmap[0x5000 / 8] = (1 << (0x5000 % 8));
    inl(0x4FFF);
    if (get_test_stage(test) != 7)
        goto fail;

    // test across pages
    inc_test_stage(test);
    inl(0x7FFF);
    if (get_test_stage(test) != 8)
        goto fail;

    inc_test_stage(test);
    io_bitmap[0x8000 / 8] = 1 << (0x8000 % 8);
    inl(0x7FFF);
    if (get_test_stage(test) != 10)
        goto fail;

    io_bitmap[0] = 0;
    inl(0xFFFF);
    if (get_test_stage(test) != 11)
        goto fail;

    io_bitmap[0] = 0xFF;
    io_bitmap[8192] = 0;
    inl(0xFFFF);
    inc_test_stage(test);
    if (get_test_stage(test) != 12)
        goto fail;

    return;

fail:
    report("stage %d", false, get_test_stage(test));
    test->scratch = -1;
}

static bool ioio_finished(struct test *test)
{
    unsigned port, size;

    /* Only expect IOIO intercepts */
    if (test->vmcb->control.exit_code == SVM_EXIT_VMMCALL)
        return true;

    if (test->vmcb->control.exit_code != SVM_EXIT_IOIO)
        return true;

    /* one step forward */
    test->scratch += 1;

    port = test->vmcb->control.exit_info_1 >> 16;
    size = (test->vmcb->control.exit_info_1 >> SVM_IOIO_SIZE_SHIFT) & 7;

    while (size--) {
        io_bitmap[port / 8] &= ~(1 << (port & 7));
        port++;
    }

    return false;
}

static bool check_ioio(struct test *test)
{
    memset(io_bitmap, 0, 8193);
    return test->scratch != -1;
}

static void prepare_asid_zero(struct test *test)
{
    test->vmcb->control.asid = 0;
}

static void test_asid_zero(struct test *test)
{
    asm volatile ("vmmcall\n\t");
}

static bool check_asid_zero(struct test *test)
{
    return test->vmcb->control.exit_code == SVM_EXIT_ERR;
}

static void sel_cr0_bug_prepare(struct test *test)
{
    vmcb_ident(test->vmcb);
    test->vmcb->control.intercept |= (1ULL << INTERCEPT_SELECTIVE_CR0);
}

static bool sel_cr0_bug_finished(struct test *test)
{
	return true;
}

static void sel_cr0_bug_test(struct test *test)
{
    unsigned long cr0;

    /* read cr0, clear CD, and write back */
    cr0  = read_cr0();
    cr0 |= (1UL << 30);
    write_cr0(cr0);

    /*
     * If we are here the test failed, not sure what to do now because we
     * are not in guest-mode anymore so we can't trigger an intercept.
     * Trigger a tripple-fault for now.
     */
    report("sel_cr0 test. Can not recover from this - exiting", false);
    exit(report_summary());
}

static bool sel_cr0_bug_check(struct test *test)
{
    return test->vmcb->control.exit_code == SVM_EXIT_CR0_SEL_WRITE;
}

static void npt_nx_prepare(struct test *test)
{

    u64 *pte;

    vmcb_ident(test->vmcb);
    pte = npt_get_pte((u64)null_test);

    *pte |= (1ULL << 63);
}

static bool npt_nx_check(struct test *test)
{
    u64 *pte = npt_get_pte((u64)null_test);

    *pte &= ~(1ULL << 63);

    test->vmcb->save.efer |= (1 << 11);

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
           && (test->vmcb->control.exit_info_1 == 0x100000015ULL);
}

static void npt_us_prepare(struct test *test)
{
    u64 *pte;

    vmcb_ident(test->vmcb);
    pte = npt_get_pte((u64)scratch_page);

    *pte &= ~(1ULL << 2);
}

static void npt_us_test(struct test *test)
{
    (void) *(volatile u64 *)scratch_page;
}

static bool npt_us_check(struct test *test)
{
    u64 *pte = npt_get_pte((u64)scratch_page);

    *pte |= (1ULL << 2);

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
           && (test->vmcb->control.exit_info_1 == 0x100000005ULL);
}

u64 save_pde;

static void npt_rsvd_prepare(struct test *test)
{
    u64 *pde;

    vmcb_ident(test->vmcb);
    pde = npt_get_pde((u64) null_test);

    save_pde = *pde;
    *pde = (1ULL << 19) | (1ULL << 7) | 0x27;
}

static bool npt_rsvd_check(struct test *test)
{
    u64 *pde = npt_get_pde((u64) null_test);

    *pde = save_pde;

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
            && (test->vmcb->control.exit_info_1 == 0x10000001dULL);
}

static void npt_rw_prepare(struct test *test)
{

    u64 *pte;

    vmcb_ident(test->vmcb);
    pte = npt_get_pte(0x80000);

    *pte &= ~(1ULL << 1);
}

static void npt_rw_test(struct test *test)
{
    u64 *data = (void*)(0x80000);

    *data = 0;
}

static bool npt_rw_check(struct test *test)
{
    u64 *pte = npt_get_pte(0x80000);

    *pte |= (1ULL << 1);

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
           && (test->vmcb->control.exit_info_1 == 0x100000007ULL);
}

static void npt_rw_pfwalk_prepare(struct test *test)
{

    u64 *pte;

    vmcb_ident(test->vmcb);
    pte = npt_get_pte(read_cr3());

    *pte &= ~(1ULL << 1);
}

static bool npt_rw_pfwalk_check(struct test *test)
{
    u64 *pte = npt_get_pte(read_cr3());

    *pte |= (1ULL << 1);

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
           && (test->vmcb->control.exit_info_1 == 0x200000006ULL)
	   && (test->vmcb->control.exit_info_2 == read_cr3());
}

static void npt_rsvd_pfwalk_prepare(struct test *test)
{

    vmcb_ident(test->vmcb);

    pdpe[0] |= (1ULL << 8);
}

static bool npt_rsvd_pfwalk_check(struct test *test)
{
    pdpe[0] &= ~(1ULL << 8);

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
            && (test->vmcb->control.exit_info_1 == 0x200000006ULL);
}

static void npt_l1mmio_prepare(struct test *test)
{
    vmcb_ident(test->vmcb);
}

u32 nested_apic_version1;
u32 nested_apic_version2;

static void npt_l1mmio_test(struct test *test)
{
    volatile u32 *data = (volatile void*)(0xfee00030UL);

    nested_apic_version1 = *data;
    nested_apic_version2 = *data;
}

static bool npt_l1mmio_check(struct test *test)
{
    volatile u32 *data = (volatile void*)(0xfee00030);
    u32 lvr = *data;

    return nested_apic_version1 == lvr && nested_apic_version2 == lvr;
}

static void npt_rw_l1mmio_prepare(struct test *test)
{

    u64 *pte;

    vmcb_ident(test->vmcb);
    pte = npt_get_pte(0xfee00080);

    *pte &= ~(1ULL << 1);
}

static void npt_rw_l1mmio_test(struct test *test)
{
    volatile u32 *data = (volatile void*)(0xfee00080);

    *data = *data;
}

static bool npt_rw_l1mmio_check(struct test *test)
{
    u64 *pte = npt_get_pte(0xfee00080);

    *pte |= (1ULL << 1);

    return (test->vmcb->control.exit_code == SVM_EXIT_NPF)
           && (test->vmcb->control.exit_info_1 == 0x100000007ULL);
}

static void latency_prepare(struct test *test)
{
    default_prepare(test);
    runs = LATENCY_RUNS;
    latvmrun_min = latvmexit_min = -1ULL;
    latvmrun_max = latvmexit_max = 0;
    vmrun_sum = vmexit_sum = 0;
}

static void latency_test(struct test *test)
{
    u64 cycles;

start:
    tsc_end = rdtsc();

    cycles = tsc_end - tsc_start;

    if (cycles > latvmrun_max)
        latvmrun_max = cycles;

    if (cycles < latvmrun_min)
        latvmrun_min = cycles;

    vmrun_sum += cycles;

    tsc_start = rdtsc();

    asm volatile ("vmmcall" : : : "memory");
    goto start;
}

static bool latency_finished(struct test *test)
{
    u64 cycles;

    tsc_end = rdtsc();

    cycles = tsc_end - tsc_start;

    if (cycles > latvmexit_max)
        latvmexit_max = cycles;

    if (cycles < latvmexit_min)
        latvmexit_min = cycles;

    vmexit_sum += cycles;

    test->vmcb->save.rip += 3;

    runs -= 1;

    return runs == 0;
}

static bool latency_check(struct test *test)
{
    printf("    Latency VMRUN : max: %ld min: %ld avg: %ld\n", latvmrun_max,
            latvmrun_min, vmrun_sum / LATENCY_RUNS);
    printf("    Latency VMEXIT: max: %ld min: %ld avg: %ld\n", latvmexit_max,
            latvmexit_min, vmexit_sum / LATENCY_RUNS);
    return true;
}

static void lat_svm_insn_prepare(struct test *test)
{
    default_prepare(test);
    runs = LATENCY_RUNS;
    latvmload_min = latvmsave_min = latstgi_min = latclgi_min = -1ULL;
    latvmload_max = latvmsave_max = latstgi_max = latclgi_max = 0;
    vmload_sum = vmsave_sum = stgi_sum = clgi_sum;
}

static bool lat_svm_insn_finished(struct test *test)
{
    u64 vmcb_phys = virt_to_phys(test->vmcb);
    u64 cycles;

    for ( ; runs != 0; runs--) {
        tsc_start = rdtsc();
        asm volatile("vmload\n\t" : : "a"(vmcb_phys) : "memory");
        cycles = rdtsc() - tsc_start;
        if (cycles > latvmload_max)
            latvmload_max = cycles;
        if (cycles < latvmload_min)
            latvmload_min = cycles;
        vmload_sum += cycles;

        tsc_start = rdtsc();
        asm volatile("vmsave\n\t" : : "a"(vmcb_phys) : "memory");
        cycles = rdtsc() - tsc_start;
        if (cycles > latvmsave_max)
            latvmsave_max = cycles;
        if (cycles < latvmsave_min)
            latvmsave_min = cycles;
        vmsave_sum += cycles;

        tsc_start = rdtsc();
        asm volatile("stgi\n\t");
        cycles = rdtsc() - tsc_start;
        if (cycles > latstgi_max)
            latstgi_max = cycles;
        if (cycles < latstgi_min)
            latstgi_min = cycles;
        stgi_sum += cycles;

        tsc_start = rdtsc();
        asm volatile("clgi\n\t");
        cycles = rdtsc() - tsc_start;
        if (cycles > latclgi_max)
            latclgi_max = cycles;
        if (cycles < latclgi_min)
            latclgi_min = cycles;
        clgi_sum += cycles;
    }

    return true;
}

static bool lat_svm_insn_check(struct test *test)
{
    printf("    Latency VMLOAD: max: %ld min: %ld avg: %ld\n", latvmload_max,
            latvmload_min, vmload_sum / LATENCY_RUNS);
    printf("    Latency VMSAVE: max: %ld min: %ld avg: %ld\n", latvmsave_max,
            latvmsave_min, vmsave_sum / LATENCY_RUNS);
    printf("    Latency STGI:   max: %ld min: %ld avg: %ld\n", latstgi_max,
            latstgi_min, stgi_sum / LATENCY_RUNS);
    printf("    Latency CLGI:   max: %ld min: %ld avg: %ld\n", latclgi_max,
            latclgi_min, clgi_sum / LATENCY_RUNS);
    return true;
}
static struct test tests[] = {
    { "null", default_supported, default_prepare, null_test,
      default_finished, null_check },
    { "vmrun", default_supported, default_prepare, test_vmrun,
       default_finished, check_vmrun },
    { "ioio", default_supported, prepare_ioio, test_ioio,
       ioio_finished, check_ioio },
    { "vmrun intercept check", default_supported, prepare_no_vmrun_int,
      null_test, default_finished, check_no_vmrun_int },
    { "cr3 read intercept", default_supported, prepare_cr3_intercept,
      test_cr3_intercept, default_finished, check_cr3_intercept },
    { "cr3 read nointercept", default_supported, default_prepare,
      test_cr3_intercept, default_finished, check_cr3_nointercept },
    { "cr3 read intercept emulate", smp_supported,
      prepare_cr3_intercept_bypass, test_cr3_intercept_bypass,
      default_finished, check_cr3_intercept },
    { "next_rip", next_rip_supported, prepare_next_rip, test_next_rip,
      default_finished, check_next_rip },
    { "mode_switch", default_supported, prepare_mode_switch, test_mode_switch,
       mode_switch_finished, check_mode_switch },
    { "asid_zero", default_supported, prepare_asid_zero, test_asid_zero,
       default_finished, check_asid_zero },
    { "sel_cr0_bug", default_supported, sel_cr0_bug_prepare, sel_cr0_bug_test,
       sel_cr0_bug_finished, sel_cr0_bug_check },
    { "npt_nx", npt_supported, npt_nx_prepare, null_test,
	    default_finished, npt_nx_check },
    { "npt_us", npt_supported, npt_us_prepare, npt_us_test,
	    default_finished, npt_us_check },
    { "npt_rsvd", npt_supported, npt_rsvd_prepare, null_test,
	    default_finished, npt_rsvd_check },
    { "npt_rw", npt_supported, npt_rw_prepare, npt_rw_test,
	    default_finished, npt_rw_check },
    { "npt_rsvd_pfwalk", npt_supported, npt_rsvd_pfwalk_prepare, null_test,
	    default_finished, npt_rsvd_pfwalk_check },
    { "npt_rw_pfwalk", npt_supported, npt_rw_pfwalk_prepare, null_test,
	    default_finished, npt_rw_pfwalk_check },
    { "npt_l1mmio", npt_supported, npt_l1mmio_prepare, npt_l1mmio_test,
	    default_finished, npt_l1mmio_check },
    { "npt_rw_l1mmio", npt_supported, npt_rw_l1mmio_prepare, npt_rw_l1mmio_test,
	    default_finished, npt_rw_l1mmio_check },
    { "latency_run_exit", default_supported, latency_prepare, latency_test,
      latency_finished, latency_check },
    { "latency_svm_insn", default_supported, lat_svm_insn_prepare, null_test,
      lat_svm_insn_finished, lat_svm_insn_check },
};

int main(int ac, char **av)
{
    int i, nr;
    struct vmcb *vmcb;

    setup_vm();
    smp_init();

    if (!(cpuid(0x80000001).c & 4)) {
        printf("SVM not availble\n");
        return report_summary();
    }

    setup_svm();

    vmcb = alloc_page();

    nr = ARRAY_SIZE(tests);
    for (i = 0; i < nr; ++i) {
        if (!tests[i].supported())
            continue;
        test_run(&tests[i], vmcb);
    }

    return report_summary();
}
