#include "libcflat.h"
#include "vm.h"
#include "desc.h"

#define KVM_HYPERCALL_INTEL ".byte 0x0f,0x01,0xc1"
#define KVM_HYPERCALL_AMD ".byte 0x0f,0x01,0xd9"

static inline long kvm_hypercall0_intel(unsigned int nr)
{
	long ret;
	asm volatile(KVM_HYPERCALL_INTEL
		     : "=a"(ret)
		     : "a"(nr));
	return ret;
}

static inline long kvm_hypercall0_amd(unsigned int nr)
{
	long ret;
	asm volatile(KVM_HYPERCALL_AMD
		     : "=a"(ret)
		     : "a"(nr));
	return ret;
}


volatile unsigned long test_rip;
#ifdef __x86_64__
extern void gp_tss(void);
asm ("gp_tss: \n\t"
	"add $8, %rsp\n\t"            // discard error code
	"popq test_rip(%rip)\n\t"     // pop return address
	"pushq %rsi\n\t"              // new return address
	"iretq\n\t"
	"jmp gp_tss\n\t"
    );

static inline int
test_edge(void)
{
	test_rip = 0;
	asm volatile ("movq $-1, %%rax\n\t"			// prepare for vmcall
		      "leaq 1f(%%rip), %%rsi\n\t"		// save return address for gp_tss
		      "movabsq $0x7ffffffffffd, %%rbx\n\t"
		      "jmp *%%rbx; 1:" : : : "rax", "rbx", "rsi");
	printf("Return from int 13, test_rip = %lx\n", test_rip);
	return test_rip == (1ul << 47);
}
#endif

int main(int ac, char **av)
{
	kvm_hypercall0_intel(-1u);
	printf("Hypercall via VMCALL: OK\n");
	kvm_hypercall0_amd(-1u);
	printf("Hypercall via VMMCALL: OK\n");

#ifdef __x86_64__
	setup_vm();
	setup_idt();
	setup_alt_stack();
	set_intr_alt_stack(13, gp_tss);

	u8 *data1 = alloc_page();
	u8 *topmost = (void *) ((1ul << 47) - PAGE_SIZE);

	install_pte(phys_to_virt(read_cr3()), 1, topmost,
		    virt_to_phys(data1) | PT_PRESENT_MASK | PT_WRITABLE_MASK, 0);
	memset(topmost, 0xcc, PAGE_SIZE);
	topmost[4093] = 0x0f;
	topmost[4094] = 0x01;
	topmost[4095] = 0xc1;
	report("VMCALL on edge of canonical address space (intel)", test_edge());

	topmost[4095] = 0xd9;
	report("VMMCALL on edge of canonical address space (AMD)", test_edge());
#endif

	return report_summary();
}
