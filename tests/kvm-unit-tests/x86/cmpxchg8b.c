#include "ioram.h"
#include "vm.h"
#include "libcflat.h"
#include "desc.h"
#include "types.h"
#include "processor.h"

static void test_cmpxchg8b(u32 *mem)
{
    mem[1] = 2;
    mem[0] = 1;
    asm("push %%ebx\n"
        "mov %[ebx_val], %%ebx\n"
        "lock cmpxchg8b (%0)\n"
        "pop %%ebx" : : "D" (mem),
        "d" (2), "a" (1), "c" (4), [ebx_val] "i" (3) : "memory");
    report("cmpxchg8b", mem[0] == 3 && mem[1] == 4);
}

int main()
{
	setup_vm();
	setup_idt();

	test_cmpxchg8b(phys_to_virt(read_cr3()) + 4088);
	return report_summary();
}
