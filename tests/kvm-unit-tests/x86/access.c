
#include "libcflat.h"
#include "desc.h"
#include "processor.h"
#include "asm/page.h"

#define smp_id() 0

#define true 1
#define false 0

static _Bool verbose = false;

typedef unsigned long pt_element_t;
static int cpuid_7_ebx;
static int cpuid_7_ecx;
static int invalid_mask;

#define PT_BASE_ADDR_MASK ((pt_element_t)((((pt_element_t)1 << 40) - 1) & PAGE_MASK))
#define PT_PSE_BASE_ADDR_MASK (PT_BASE_ADDR_MASK & ~(1ull << 21))

#define CR0_WP_MASK (1UL << 16)
#define CR4_SMEP_MASK (1UL << 20)

#define PFERR_PRESENT_MASK (1U << 0)
#define PFERR_WRITE_MASK (1U << 1)
#define PFERR_USER_MASK (1U << 2)
#define PFERR_RESERVED_MASK (1U << 3)
#define PFERR_FETCH_MASK (1U << 4)
#define PFERR_PK_MASK (1U << 5)

#define MSR_EFER 0xc0000080
#define EFER_NX_MASK		(1ull << 11)

#define PT_INDEX(address, level)       \
       ((address) >> (12 + ((level)-1) * 9)) & 511

/*
 * page table access check tests
 */

enum {
    AC_PTE_PRESENT_BIT,
    AC_PTE_WRITABLE_BIT,
    AC_PTE_USER_BIT,
    AC_PTE_ACCESSED_BIT,
    AC_PTE_DIRTY_BIT,
    AC_PTE_NX_BIT,
    AC_PTE_BIT51_BIT,

    AC_PDE_PRESENT_BIT,
    AC_PDE_WRITABLE_BIT,
    AC_PDE_USER_BIT,
    AC_PDE_ACCESSED_BIT,
    AC_PDE_DIRTY_BIT,
    AC_PDE_PSE_BIT,
    AC_PDE_NX_BIT,
    AC_PDE_BIT51_BIT,
    AC_PDE_BIT13_BIT,

    AC_PKU_AD_BIT,
    AC_PKU_WD_BIT,
    AC_PKU_PKEY_BIT,

    AC_ACCESS_USER_BIT,
    AC_ACCESS_WRITE_BIT,
    AC_ACCESS_FETCH_BIT,
    AC_ACCESS_TWICE_BIT,

    AC_CPU_EFER_NX_BIT,
    AC_CPU_CR0_WP_BIT,
    AC_CPU_CR4_SMEP_BIT,
    AC_CPU_CR4_PKE_BIT,

    NR_AC_FLAGS
};

#define AC_PTE_PRESENT_MASK   (1 << AC_PTE_PRESENT_BIT)
#define AC_PTE_WRITABLE_MASK  (1 << AC_PTE_WRITABLE_BIT)
#define AC_PTE_USER_MASK      (1 << AC_PTE_USER_BIT)
#define AC_PTE_ACCESSED_MASK  (1 << AC_PTE_ACCESSED_BIT)
#define AC_PTE_DIRTY_MASK     (1 << AC_PTE_DIRTY_BIT)
#define AC_PTE_NX_MASK        (1 << AC_PTE_NX_BIT)
#define AC_PTE_BIT51_MASK     (1 << AC_PTE_BIT51_BIT)

#define AC_PDE_PRESENT_MASK   (1 << AC_PDE_PRESENT_BIT)
#define AC_PDE_WRITABLE_MASK  (1 << AC_PDE_WRITABLE_BIT)
#define AC_PDE_USER_MASK      (1 << AC_PDE_USER_BIT)
#define AC_PDE_ACCESSED_MASK  (1 << AC_PDE_ACCESSED_BIT)
#define AC_PDE_DIRTY_MASK     (1 << AC_PDE_DIRTY_BIT)
#define AC_PDE_PSE_MASK       (1 << AC_PDE_PSE_BIT)
#define AC_PDE_NX_MASK        (1 << AC_PDE_NX_BIT)
#define AC_PDE_BIT51_MASK     (1 << AC_PDE_BIT51_BIT)
#define AC_PDE_BIT13_MASK     (1 << AC_PDE_BIT13_BIT)

#define AC_PKU_AD_MASK        (1 << AC_PKU_AD_BIT)
#define AC_PKU_WD_MASK        (1 << AC_PKU_WD_BIT)
#define AC_PKU_PKEY_MASK      (1 << AC_PKU_PKEY_BIT)

#define AC_ACCESS_USER_MASK   (1 << AC_ACCESS_USER_BIT)
#define AC_ACCESS_WRITE_MASK  (1 << AC_ACCESS_WRITE_BIT)
#define AC_ACCESS_FETCH_MASK  (1 << AC_ACCESS_FETCH_BIT)
#define AC_ACCESS_TWICE_MASK  (1 << AC_ACCESS_TWICE_BIT)

#define AC_CPU_EFER_NX_MASK   (1 << AC_CPU_EFER_NX_BIT)
#define AC_CPU_CR0_WP_MASK    (1 << AC_CPU_CR0_WP_BIT)
#define AC_CPU_CR4_SMEP_MASK  (1 << AC_CPU_CR4_SMEP_BIT)
#define AC_CPU_CR4_PKE_MASK   (1 << AC_CPU_CR4_PKE_BIT)

const char *ac_names[] = {
    [AC_PTE_PRESENT_BIT] = "pte.p",
    [AC_PTE_ACCESSED_BIT] = "pte.a",
    [AC_PTE_WRITABLE_BIT] = "pte.rw",
    [AC_PTE_USER_BIT] = "pte.user",
    [AC_PTE_DIRTY_BIT] = "pte.d",
    [AC_PTE_NX_BIT] = "pte.nx",
    [AC_PTE_BIT51_BIT] = "pte.51",
    [AC_PDE_PRESENT_BIT] = "pde.p",
    [AC_PDE_ACCESSED_BIT] = "pde.a",
    [AC_PDE_WRITABLE_BIT] = "pde.rw",
    [AC_PDE_USER_BIT] = "pde.user",
    [AC_PDE_DIRTY_BIT] = "pde.d",
    [AC_PDE_PSE_BIT] = "pde.pse",
    [AC_PDE_NX_BIT] = "pde.nx",
    [AC_PDE_BIT51_BIT] = "pde.51",
    [AC_PDE_BIT13_BIT] = "pde.13",
    [AC_PKU_AD_BIT] = "pkru.ad",
    [AC_PKU_WD_BIT] = "pkru.wd",
    [AC_PKU_PKEY_BIT] = "pkey=1",
    [AC_ACCESS_WRITE_BIT] = "write",
    [AC_ACCESS_USER_BIT] = "user",
    [AC_ACCESS_FETCH_BIT] = "fetch",
    [AC_ACCESS_TWICE_BIT] = "twice",
    [AC_CPU_EFER_NX_BIT] = "efer.nx",
    [AC_CPU_CR0_WP_BIT] = "cr0.wp",
    [AC_CPU_CR4_SMEP_BIT] = "cr4.smep",
    [AC_CPU_CR4_PKE_BIT] = "cr4.pke",
};

static inline void *va(pt_element_t phys)
{
    return (void *)phys;
}

typedef struct {
    pt_element_t pt_pool;
    unsigned pt_pool_size;
    unsigned pt_pool_current;
} ac_pool_t;

typedef struct {
    unsigned flags;
    void *virt;
    pt_element_t phys;
    pt_element_t *ptep;
    pt_element_t expected_pte;
    pt_element_t *pdep;
    pt_element_t expected_pde;
    pt_element_t ignore_pde;
    int expected_fault;
    unsigned expected_error;
} ac_test_t;

typedef struct {
    unsigned short limit;
    unsigned long linear_addr;
} __attribute__((packed)) descriptor_table_t;


static void ac_test_show(ac_test_t *at);

int write_cr4_checking(unsigned long val)
{
    asm volatile(ASM_TRY("1f")
            "mov %0,%%cr4\n\t"
            "1:": : "r" (val));
    return exception_vector();
}

void set_cr0_wp(int wp)
{
    unsigned long cr0 = read_cr0();
    unsigned long old_cr0 = cr0;

    cr0 &= ~CR0_WP_MASK;
    if (wp)
	cr0 |= CR0_WP_MASK;
    if (old_cr0 != cr0)
        write_cr0(cr0);
}

void set_cr4_smep(int smep)
{
    unsigned long cr4 = read_cr4();
    unsigned long old_cr4 = cr4;
    extern u64 ptl2[];

    cr4 &= ~CR4_SMEP_MASK;
    if (smep)
	cr4 |= CR4_SMEP_MASK;
    if (old_cr4 == cr4)
        return;

    if (smep)
        ptl2[2] &= ~PT_USER_MASK;
    write_cr4(cr4);
    if (!smep)
        ptl2[2] |= PT_USER_MASK;
}

void set_cr4_pke(int pke)
{
    unsigned long cr4 = read_cr4();
    unsigned long old_cr4 = cr4;

    cr4 &= ~X86_CR4_PKE;
    if (pke)
	cr4 |= X86_CR4_PKE;
    if (old_cr4 == cr4)
        return;

    /* Check that protection keys do not affect accesses when CR4.PKE=0.  */
    if ((read_cr4() & X86_CR4_PKE) && !pke) {
        write_pkru(0xfffffffc);
    }
    write_cr4(cr4);
}

void set_efer_nx(int nx)
{
    unsigned long long efer = rdmsr(MSR_EFER);
    unsigned long long old_efer = efer;

    efer &= ~EFER_NX_MASK;
    if (nx)
	efer |= EFER_NX_MASK;
    if (old_efer != efer)
        wrmsr(MSR_EFER, efer);
}

static void ac_env_int(ac_pool_t *pool)
{
    extern char page_fault, kernel_entry;
    set_idt_entry(14, &page_fault, 0);
    set_idt_entry(0x20, &kernel_entry, 3);

    pool->pt_pool = 33 * 1024 * 1024;
    pool->pt_pool_size = 120 * 1024 * 1024 - pool->pt_pool;
    pool->pt_pool_current = 0;
}

void ac_test_init(ac_test_t *at, void *virt)
{
    wrmsr(MSR_EFER, rdmsr(MSR_EFER) | EFER_NX_MASK);
    set_cr0_wp(1);
    at->flags = 0;
    at->virt = virt;
    at->phys = 32 * 1024 * 1024;
}

int ac_test_bump_one(ac_test_t *at)
{
    at->flags = ((at->flags | invalid_mask) + 1) & ~invalid_mask;
    return at->flags < (1 << NR_AC_FLAGS);
}

#define F(x)  ((flags & x##_MASK) != 0)

_Bool ac_test_legal(ac_test_t *at)
{
    int flags = at->flags;

    if (F(AC_ACCESS_FETCH) && F(AC_ACCESS_WRITE))
	return false;

    /*
     * Since we convert current page to kernel page when cr4.smep=1,
     * we can't switch to user mode.
     */
    if (F(AC_ACCESS_USER) && F(AC_CPU_CR4_SMEP))
	return false;

    /*
     * Only test protection key faults if CR4.PKE=1.
     */
    if (!F(AC_CPU_CR4_PKE) &&
        (F(AC_PKU_AD) || F(AC_PKU_WD))) {
	return false;
    }

    /*
     * pde.bit13 checks handling of reserved bits in largepage PDEs.  It is
     * meaningless if there is a PTE.
     */
    if (!F(AC_PDE_PSE) && F(AC_PDE_BIT13))
        return false;

    return true;
}

int ac_test_bump(ac_test_t *at)
{
    int ret;

    ret = ac_test_bump_one(at);
    while (ret && !ac_test_legal(at))
	ret = ac_test_bump_one(at);
    return ret;
}

pt_element_t ac_test_alloc_pt(ac_pool_t *pool)
{
    pt_element_t ret = pool->pt_pool + pool->pt_pool_current;
    pool->pt_pool_current += PAGE_SIZE;
    return ret;
}

_Bool ac_test_enough_room(ac_pool_t *pool)
{
    return pool->pt_pool_current + 4 * PAGE_SIZE <= pool->pt_pool_size;
}

void ac_test_reset_pt_pool(ac_pool_t *pool)
{
    pool->pt_pool_current = 0;
}

pt_element_t ac_test_permissions(ac_test_t *at, unsigned flags, bool writable,
                                 bool user, bool executable)
{
    bool kwritable = !F(AC_CPU_CR0_WP) && !F(AC_ACCESS_USER);
    pt_element_t expected = 0;

    if (F(AC_ACCESS_USER) && !user)
	at->expected_fault = 1;

    if (F(AC_ACCESS_WRITE) && !writable && !kwritable)
	at->expected_fault = 1;

    if (F(AC_ACCESS_FETCH) && !executable)
	at->expected_fault = 1;

    if (F(AC_ACCESS_FETCH) && user && F(AC_CPU_CR4_SMEP))
        at->expected_fault = 1;

    if (user && !F(AC_ACCESS_FETCH) && F(AC_PKU_PKEY) && F(AC_CPU_CR4_PKE)) {
        if (F(AC_PKU_AD)) {
            at->expected_fault = 1;
            at->expected_error |= PFERR_PK_MASK;
        } else if (F(AC_ACCESS_WRITE) && F(AC_PKU_WD) && !kwritable) {
            at->expected_fault = 1;
            at->expected_error |= PFERR_PK_MASK;
        }
    }

    if (!at->expected_fault) {
        expected |= PT_ACCESSED_MASK;
        if (F(AC_ACCESS_WRITE))
            expected |= PT_DIRTY_MASK;
    }

    return expected;
}

void ac_emulate_access(ac_test_t *at, unsigned flags)
{
    bool pde_valid, pte_valid;
    bool user, writable, executable;

    if (F(AC_ACCESS_USER))
	at->expected_error |= PFERR_USER_MASK;

    if (F(AC_ACCESS_WRITE))
	at->expected_error |= PFERR_WRITE_MASK;

    if (F(AC_ACCESS_FETCH))
	at->expected_error |= PFERR_FETCH_MASK;

    if (!F(AC_PDE_ACCESSED))
        at->ignore_pde = PT_ACCESSED_MASK;

    pde_valid = F(AC_PDE_PRESENT)
        && !F(AC_PDE_BIT51) && !F(AC_PDE_BIT13)
        && !(F(AC_PDE_NX) && !F(AC_CPU_EFER_NX));

    if (!pde_valid) {
        at->expected_fault = 1;
	if (F(AC_PDE_PRESENT)) {
            at->expected_error |= PFERR_RESERVED_MASK;
        } else {
            at->expected_error &= ~PFERR_PRESENT_MASK;
        }
	goto fault;
    }

    writable = F(AC_PDE_WRITABLE);
    user = F(AC_PDE_USER);
    executable = !F(AC_PDE_NX);

    if (F(AC_PDE_PSE)) {
        at->expected_pde |= ac_test_permissions(at, flags, writable, user,
                                                executable);
	goto no_pte;
    }

    at->expected_pde |= PT_ACCESSED_MASK;

    pte_valid = F(AC_PTE_PRESENT)
        && !F(AC_PTE_BIT51)
        && !(F(AC_PTE_NX) && !F(AC_CPU_EFER_NX));

    if (!pte_valid) {
        at->expected_fault = 1;
	if (F(AC_PTE_PRESENT)) {
            at->expected_error |= PFERR_RESERVED_MASK;
        } else {
            at->expected_error &= ~PFERR_PRESENT_MASK;
        }
	goto fault;
    }

    writable &= F(AC_PTE_WRITABLE);
    user &= F(AC_PTE_USER);
    executable &= !F(AC_PTE_NX);

    at->expected_pte |= ac_test_permissions(at, flags, writable, user,
                                            executable);

no_pte:
fault:
    if (!at->expected_fault)
        at->ignore_pde = 0;
    if (!F(AC_CPU_EFER_NX) && !F(AC_CPU_CR4_SMEP))
        at->expected_error &= ~PFERR_FETCH_MASK;
}

void ac_set_expected_status(ac_test_t *at)
{
    invlpg(at->virt);

    if (at->ptep)
	at->expected_pte = *at->ptep;
    at->expected_pde = *at->pdep;
    at->ignore_pde = 0;
    at->expected_fault = 0;
    at->expected_error = PFERR_PRESENT_MASK;

    if (at->flags & AC_ACCESS_TWICE_MASK) {
        ac_emulate_access(at, at->flags & ~AC_ACCESS_WRITE_MASK
                          & ~AC_ACCESS_FETCH_MASK & ~AC_ACCESS_USER_MASK);
        at->expected_fault = 0;
	at->expected_error = PFERR_PRESENT_MASK;
        at->ignore_pde = 0;
    }

    ac_emulate_access(at, at->flags);
}

void __ac_setup_specific_pages(ac_test_t *at, ac_pool_t *pool, u64 pd_page,
			       u64 pt_page)

{
    unsigned long root = read_cr3();
    int flags = at->flags;

    if (!ac_test_enough_room(pool))
	ac_test_reset_pt_pool(pool);

    at->ptep = 0;
    for (int i = 4; i >= 1 && (i >= 2 || !F(AC_PDE_PSE)); --i) {
	pt_element_t *vroot = va(root & PT_BASE_ADDR_MASK);
	unsigned index = PT_INDEX((unsigned long)at->virt, i);
	pt_element_t pte = 0;
	switch (i) {
	case 4:
	case 3:
	    pte = pd_page ? pd_page : ac_test_alloc_pt(pool);
	    pte |= PT_PRESENT_MASK | PT_WRITABLE_MASK | PT_USER_MASK;
	    break;
	case 2:
	    if (!F(AC_PDE_PSE)) {
		pte = pt_page ? pt_page : ac_test_alloc_pt(pool);
		/* The protection key is ignored on non-leaf entries.  */
                if (F(AC_PKU_PKEY))
                    pte |= 2ull << 59;
	    } else {
		pte = at->phys & PT_PSE_BASE_ADDR_MASK;
		pte |= PT_PAGE_SIZE_MASK;
                if (F(AC_PKU_PKEY))
                    pte |= 1ull << 59;
	    }
	    if (F(AC_PDE_PRESENT))
		pte |= PT_PRESENT_MASK;
	    if (F(AC_PDE_WRITABLE))
		pte |= PT_WRITABLE_MASK;
	    if (F(AC_PDE_USER))
		pte |= PT_USER_MASK;
	    if (F(AC_PDE_ACCESSED))
		pte |= PT_ACCESSED_MASK;
	    if (F(AC_PDE_DIRTY))
		pte |= PT_DIRTY_MASK;
	    if (F(AC_PDE_NX))
		pte |= PT64_NX_MASK;
	    if (F(AC_PDE_BIT51))
		pte |= 1ull << 51;
	    if (F(AC_PDE_BIT13))
		pte |= 1ull << 13;
	    at->pdep = &vroot[index];
	    break;
	case 1:
	    pte = at->phys & PT_BASE_ADDR_MASK;
	    if (F(AC_PKU_PKEY))
		pte |= 1ull << 59;
	    if (F(AC_PTE_PRESENT))
		pte |= PT_PRESENT_MASK;
	    if (F(AC_PTE_WRITABLE))
		pte |= PT_WRITABLE_MASK;
	    if (F(AC_PTE_USER))
		pte |= PT_USER_MASK;
	    if (F(AC_PTE_ACCESSED))
		pte |= PT_ACCESSED_MASK;
	    if (F(AC_PTE_DIRTY))
		pte |= PT_DIRTY_MASK;
	    if (F(AC_PTE_NX))
		pte |= PT64_NX_MASK;
	    if (F(AC_PTE_BIT51))
		pte |= 1ull << 51;
	    at->ptep = &vroot[index];
	    break;
	}
	vroot[index] = pte;
	root = vroot[index];
    }
    ac_set_expected_status(at);
}

static void ac_test_setup_pte(ac_test_t *at, ac_pool_t *pool)
{
	__ac_setup_specific_pages(at, pool, 0, 0);
}

static void ac_setup_specific_pages(ac_test_t *at, ac_pool_t *pool,
				    u64 pd_page, u64 pt_page)
{
	return __ac_setup_specific_pages(at, pool, pd_page, pt_page);
}

static void dump_mapping(ac_test_t *at)
{
	unsigned long root = read_cr3();
        int flags = at->flags;
	int i;

	printf("Dump mapping: address: %p\n", at->virt);
	for (i = 4; i >= 1 && (i >= 2 || !F(AC_PDE_PSE)); --i) {
		pt_element_t *vroot = va(root & PT_BASE_ADDR_MASK);
		unsigned index = PT_INDEX((unsigned long)at->virt, i);
		pt_element_t pte = vroot[index];

		printf("------L%d: %lx\n", i, pte);
		root = vroot[index];
	}
}

static void ac_test_check(ac_test_t *at, _Bool *success_ret, _Bool cond,
                          const char *fmt, ...)
{
    va_list ap;
    char buf[500];

    if (!*success_ret) {
        return;
    }

    if (!cond) {
        return;
    }

    *success_ret = false;

    if (!verbose) {
        puts("\n");
        ac_test_show(at);
    }

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    printf("FAIL: %s\n", buf);
    dump_mapping(at);
}

static int pt_match(pt_element_t pte1, pt_element_t pte2, pt_element_t ignore)
{
    pte1 &= ~ignore;
    pte2 &= ~ignore;
    return pte1 == pte2;
}

int ac_test_do_access(ac_test_t *at)
{
    static unsigned unique = 42;
    int fault = 0;
    unsigned e;
    static unsigned char user_stack[4096];
    unsigned long rsp;
    _Bool success = true;
    int flags = at->flags;

    ++unique;
    if (!(unique & 65535)) {
        puts(".");
    }

    *((unsigned char *)at->phys) = 0xc3; /* ret */

    unsigned r = unique;
    set_cr0_wp(F(AC_CPU_CR0_WP));
    set_efer_nx(F(AC_CPU_EFER_NX));
    set_cr4_pke(F(AC_CPU_CR4_PKE));
    if (F(AC_CPU_CR4_PKE)) {
        /* WD2=AD2=1, WD1=F(AC_PKU_WD), AD1=F(AC_PKU_AD) */
        write_pkru(0x30 | (F(AC_PKU_WD) ? 8 : 0) |
                   (F(AC_PKU_AD) ? 4 : 0));
    }

    set_cr4_smep(F(AC_CPU_CR4_SMEP));

    if (F(AC_ACCESS_TWICE)) {
	asm volatile (
	    "mov $fixed2, %%rsi \n\t"
	    "mov (%[addr]), %[reg] \n\t"
	    "fixed2:"
	    : [reg]"=r"(r), [fault]"=a"(fault), "=b"(e)
	    : [addr]"r"(at->virt)
	    : "rsi"
	    );
	fault = 0;
    }

    asm volatile ("mov $fixed1, %%rsi \n\t"
		  "mov %%rsp, %%rdx \n\t"
		  "cmp $0, %[user] \n\t"
		  "jz do_access \n\t"
		  "push %%rax; mov %[user_ds], %%ax; mov %%ax, %%ds; pop %%rax  \n\t"
		  "pushq %[user_ds] \n\t"
		  "pushq %[user_stack_top] \n\t"
		  "pushfq \n\t"
		  "pushq %[user_cs] \n\t"
		  "pushq $do_access \n\t"
		  "iretq \n"
		  "do_access: \n\t"
		  "cmp $0, %[fetch] \n\t"
		  "jnz 2f \n\t"
		  "cmp $0, %[write] \n\t"
		  "jnz 1f \n\t"
		  "mov (%[addr]), %[reg] \n\t"
		  "jmp done \n\t"
		  "1: mov %[reg], (%[addr]) \n\t"
		  "jmp done \n\t"
		  "2: call *%[addr] \n\t"
		  "done: \n"
		  "fixed1: \n"
		  "int %[kernel_entry_vector] \n\t"
		  "back_to_kernel:"
		  : [reg]"+r"(r), "+a"(fault), "=b"(e), "=&d"(rsp)
		  : [addr]"r"(at->virt),
		    [write]"r"(F(AC_ACCESS_WRITE)),
		    [user]"r"(F(AC_ACCESS_USER)),
		    [fetch]"r"(F(AC_ACCESS_FETCH)),
		    [user_ds]"i"(USER_DS),
		    [user_cs]"i"(USER_CS),
		    [user_stack_top]"r"(user_stack + sizeof user_stack),
		    [kernel_entry_vector]"i"(0x20)
		  : "rsi");

    asm volatile (".section .text.pf \n\t"
		  "page_fault: \n\t"
		  "pop %rbx \n\t"
		  "mov %rsi, (%rsp) \n\t"
		  "movl $1, %eax \n\t"
		  "iretq \n\t"
		  ".section .text");

    asm volatile (".section .text.entry \n\t"
		  "kernel_entry: \n\t"
		  "mov %rdx, %rsp \n\t"
		  "jmp back_to_kernel \n\t"
		  ".section .text");

    ac_test_check(at, &success, fault && !at->expected_fault,
                  "unexpected fault");
    ac_test_check(at, &success, !fault && at->expected_fault,
                  "unexpected access");
    ac_test_check(at, &success, fault && e != at->expected_error,
                  "error code %x expected %x", e, at->expected_error);
    ac_test_check(at, &success, at->ptep && *at->ptep != at->expected_pte,
                  "pte %x expected %x", *at->ptep, at->expected_pte);
    ac_test_check(at, &success,
                  !pt_match(*at->pdep, at->expected_pde, at->ignore_pde),
                  "pde %x expected %x", *at->pdep, at->expected_pde);

    if (success && verbose) {
	if (at->expected_fault) {
            printf("PASS (%x)\n", at->expected_error);
	} else {
            printf("PASS\n");
	}
    }
    return success;
}

static void ac_test_show(ac_test_t *at)
{
    char line[5000];

    *line = 0;
    strcat(line, "test");
    for (int i = 0; i < NR_AC_FLAGS; ++i)
	if (at->flags & (1 << i)) {
	    strcat(line, " ");
	    strcat(line, ac_names[i]);
	}
    strcat(line, ": ");
    printf("%s", line);
}

/*
 * This test case is used to triger the bug which is fixed by
 * commit e09e90a5 in the kvm tree
 */
static int corrupt_hugepage_triger(ac_pool_t *pool)
{
    ac_test_t at1, at2;

    ac_test_init(&at1, (void *)(0x123400000000));
    ac_test_init(&at2, (void *)(0x666600000000));

    at2.flags = AC_CPU_CR0_WP_MASK | AC_PDE_PSE_MASK | AC_PDE_PRESENT_MASK;
    ac_test_setup_pte(&at2, pool);
    if (!ac_test_do_access(&at2))
        goto err;

    at1.flags = at2.flags | AC_PDE_WRITABLE_MASK;
    ac_test_setup_pte(&at1, pool);
    if (!ac_test_do_access(&at1))
        goto err;

    at1.flags |= AC_ACCESS_WRITE_MASK;
    ac_set_expected_status(&at1);
    if (!ac_test_do_access(&at1))
        goto err;

    at2.flags |= AC_ACCESS_WRITE_MASK;
    ac_set_expected_status(&at2);
    if (!ac_test_do_access(&at2))
        goto err;

    return 1;

err:
    printf("corrupt_hugepage_triger test fail\n");
    return 0;
}

/*
 * This test case is used to triger the bug which is fixed by
 * commit 3ddf6c06e13e in the kvm tree
 */
static int check_pfec_on_prefetch_pte(ac_pool_t *pool)
{
	ac_test_t at1, at2;

	ac_test_init(&at1, (void *)(0x123406001000));
	ac_test_init(&at2, (void *)(0x123406003000));

	at1.flags = AC_PDE_PRESENT_MASK | AC_PTE_PRESENT_MASK;
	ac_setup_specific_pages(&at1, pool, 30 * 1024 * 1024, 30 * 1024 * 1024);

        at2.flags = at1.flags | AC_PTE_NX_MASK;
	ac_setup_specific_pages(&at2, pool, 30 * 1024 * 1024, 30 * 1024 * 1024);

	if (!ac_test_do_access(&at1)) {
		printf("%s: prepare fail\n", __FUNCTION__);
		goto err;
	}

	if (!ac_test_do_access(&at2)) {
		printf("%s: check PFEC on prefetch pte path fail\n",
			__FUNCTION__);
		goto err;
	}

	return 1;

err:
    return 0;
}

/*
 * If the write-fault access is from supervisor and CR0.WP is not set on the
 * vcpu, kvm will fix it by adjusting pte access - it sets the W bit on pte
 * and clears U bit. This is the chance that kvm can change pte access from
 * readonly to writable.
 *
 * Unfortunately, the pte access is the access of 'direct' shadow page table,
 * means direct sp.role.access = pte_access, then we will create a writable
 * spte entry on the readonly shadow page table. It will cause Dirty bit is
 * not tracked when two guest ptes point to the same large page. Note, it
 * does not have other impact except Dirty bit since cr0.wp is encoded into
 * sp.role.
 *
 * Note: to trigger this bug, hugepage should be disabled on host.
 */
static int check_large_pte_dirty_for_nowp(ac_pool_t *pool)
{
	ac_test_t at1, at2;

	ac_test_init(&at1, (void *)(0x123403000000));
	ac_test_init(&at2, (void *)(0x666606000000));

        at2.flags = AC_PDE_PRESENT_MASK | AC_PDE_PSE_MASK;
	ac_test_setup_pte(&at2, pool);
	if (!ac_test_do_access(&at2)) {
		printf("%s: read on the first mapping fail.\n", __FUNCTION__);
		goto err;
	}

        at1.flags = at2.flags | AC_ACCESS_WRITE_MASK;
	ac_test_setup_pte(&at1, pool);
	if (!ac_test_do_access(&at1)) {
		printf("%s: write on the second mapping fail.\n", __FUNCTION__);
		goto err;
	}

	at2.flags |= AC_ACCESS_WRITE_MASK;
	ac_set_expected_status(&at2);
	if (!ac_test_do_access(&at2)) {
		printf("%s: write on the first mapping fail.\n", __FUNCTION__);
		goto err;
	}

	return 1;

err:
	return 0;
}

static int check_smep_andnot_wp(ac_pool_t *pool)
{
	ac_test_t at1;
	int err_prepare_andnot_wp, err_smep_andnot_wp;

	if (!(cpuid_7_ebx & (1 << 7))) {
	    return 1;
	}

	ac_test_init(&at1, (void *)(0x123406001000));

	at1.flags = AC_PDE_PRESENT_MASK | AC_PTE_PRESENT_MASK |
            AC_PDE_USER_MASK | AC_PTE_USER_MASK |
            AC_PDE_ACCESSED_MASK | AC_PTE_ACCESSED_MASK |
            AC_CPU_CR4_SMEP_MASK |
            AC_CPU_CR0_WP_MASK |
            AC_ACCESS_WRITE_MASK;
	ac_test_setup_pte(&at1, pool);

	/*
	 * Here we write the ro user page when
	 * cr0.wp=0, then we execute it and SMEP
	 * fault should happen.
	 */
	err_prepare_andnot_wp = ac_test_do_access(&at1);
	if (!err_prepare_andnot_wp) {
		printf("%s: SMEP prepare fail\n", __FUNCTION__);
		goto clean_up;
	}

        at1.flags &= ~AC_ACCESS_WRITE_MASK;
        at1.flags |= AC_ACCESS_FETCH_MASK;
        ac_set_expected_status(&at1);
        err_smep_andnot_wp = ac_test_do_access(&at1);

clean_up:
	set_cr4_smep(0);

	if (!err_prepare_andnot_wp)
		goto err;
	if (!err_smep_andnot_wp) {
		printf("%s: check SMEP without wp fail\n", __FUNCTION__);
		goto err;
	}
	return 1;

err:
	return 0;
}

int ac_test_exec(ac_test_t *at, ac_pool_t *pool)
{
    int r;

    if (verbose) {
        ac_test_show(at);
    }
    ac_test_setup_pte(at, pool);
    r = ac_test_do_access(at);
    return r;
}

typedef int (*ac_test_fn)(ac_pool_t *pool);
const ac_test_fn ac_test_cases[] =
{
	corrupt_hugepage_triger,
	check_pfec_on_prefetch_pte,
	check_large_pte_dirty_for_nowp,
	check_smep_andnot_wp
};

int ac_test_run(void)
{
    ac_test_t at;
    ac_pool_t pool;
    int i, tests, successes;

    printf("run\n");
    tests = successes = 0;

    if (cpuid_7_ecx & (1 << 3)) {
        set_cr4_pke(1);
        set_cr4_pke(0);
        /* Now PKRU = 0xFFFFFFFF.  */
    } else {
	unsigned long cr4 = read_cr4();
	tests++;
	if (write_cr4_checking(cr4 | X86_CR4_PKE) == GP_VECTOR) {
            successes++;
            invalid_mask |= AC_PKU_AD_MASK;
            invalid_mask |= AC_PKU_WD_MASK;
            invalid_mask |= AC_PKU_PKEY_MASK;
            invalid_mask |= AC_CPU_CR4_PKE_MASK;
            printf("CR4.PKE not available, disabling PKE tests\n");
	} else {
            printf("Set PKE in CR4 - expect #GP: FAIL!\n");
            set_cr4_pke(0);
	}
    }

    if (!(cpuid_7_ebx & (1 << 7))) {
	unsigned long cr4 = read_cr4();
	tests++;
	if (write_cr4_checking(cr4 | CR4_SMEP_MASK) == GP_VECTOR) {
            successes++;
            invalid_mask |= AC_CPU_CR4_SMEP_MASK;
            printf("CR4.SMEP not available, disabling SMEP tests\n");
	} else {
            printf("Set SMEP in CR4 - expect #GP: FAIL!\n");
            set_cr4_smep(0);
	}
    }

    ac_env_int(&pool);
    ac_test_init(&at, (void *)(0x123400000000 + 16 * smp_id()));
    do {
	++tests;
	successes += ac_test_exec(&at, &pool);
    } while (ac_test_bump(&at));

    for (i = 0; i < ARRAY_SIZE(ac_test_cases); i++) {
	++tests;
	successes += ac_test_cases[i](&pool);
    }

    printf("\n%d tests, %d failures\n", tests, tests - successes);

    return successes == tests;
}

int main()
{
    int r;

    setup_idt();

    cpuid_7_ebx = cpuid(7).b;
    cpuid_7_ecx = cpuid(7).c;

    printf("starting test\n\n");
    r = ac_test_run();
    return r ? 0 : 1;
}
