/*
 * Async PF test. For the test to actually do anything it needs to be started
 * in memory cgroup with 512M of memory and with more then 1G memory provided
 * to the guest.
 *
 * To create cgroup do as root:
 * mkdir /dev/cgroup
 * mount -t cgroup none -omemory /dev/cgroup
 * chmod a+rxw /dev/cgroup/
 *
 * From a shell you will start qemu from:
 * mkdir /dev/cgroup/1
 * echo $$ >  /dev/cgroup/1/tasks
 * echo 512M > /dev/cgroup/1/memory.limit_in_bytes
 *
 */
#include "x86/msr.h"
#include "x86/processor.h"
#include "x86/apic-defs.h"
#include "x86/apic.h"
#include "x86/desc.h"
#include "x86/isr.h"
#include "x86/vm.h"

#include "libcflat.h"
#include <stdint.h>

#define KVM_PV_REASON_PAGE_NOT_PRESENT 1
#define KVM_PV_REASON_PAGE_READY 2

#define MSR_KVM_ASYNC_PF_EN 0x4b564d02

#define KVM_ASYNC_PF_ENABLED                    (1 << 0)
#define KVM_ASYNC_PF_SEND_ALWAYS                (1 << 1)

volatile uint32_t apf_reason __attribute__((aligned(64)));
char *buf;
volatile uint64_t  i;
volatile uint64_t phys;

static inline uint32_t get_apf_reason(void)
{
	uint32_t r = apf_reason;
	apf_reason = 0;
	return r;
}

static void pf_isr(struct ex_regs *r)
{
	void* virt = (void*)((ulong)(buf+i) & ~(PAGE_SIZE-1));
	uint32_t reason = get_apf_reason();

	switch (reason) {
		case 0:
			report("unexpected #PF at %p", false, read_cr2());
			break;
		case KVM_PV_REASON_PAGE_NOT_PRESENT:
			phys = virt_to_phys_cr3(virt);
			install_pte(phys_to_virt(read_cr3()), 1, virt, phys, 0);
			write_cr3(read_cr3());
			report("Got not present #PF token %x virt addr %p phys addr %p",
					true, read_cr2(), virt, phys);
			while(phys) {
				safe_halt(); /* enables irq */
				irq_disable();
			}
			break;
		case KVM_PV_REASON_PAGE_READY:
			report("Got present #PF token %x", true, read_cr2());
			if ((uint32_t)read_cr2() == ~0)
				break;
			install_pte(phys_to_virt(read_cr3()), 1, virt, phys | PT_PRESENT_MASK | PT_WRITABLE_MASK, 0);
			write_cr3(read_cr3());
			phys = 0;
			break;
		default:
			report("unexpected async pf reason %d", false, reason);
			break;
	}
}

#define MEM 1ull*1024*1024*1024

int main(int ac, char **av)
{
	int loop = 2;

	setup_vm();
	setup_idt();
	printf("install handler\n");
	handle_exception(14, pf_isr);
	apf_reason = 0;
	printf("enable async pf\n");
	wrmsr(MSR_KVM_ASYNC_PF_EN, virt_to_phys((void*)&apf_reason) |
			KVM_ASYNC_PF_SEND_ALWAYS | KVM_ASYNC_PF_ENABLED);
	printf("alloc memory\n");
	buf = vmalloc(MEM);
	irq_enable();
	while(loop--) {
		printf("start loop\n");
		/* access a lot of memory to make host swap it out */
		for (i=0; i < MEM; i+=4096)
			buf[i] = 1;
		printf("end loop\n");
	}
	irq_disable();

	return report_summary();
}
