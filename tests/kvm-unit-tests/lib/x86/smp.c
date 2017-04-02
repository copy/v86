
#include <libcflat.h>
#include "smp.h"
#include "apic.h"
#include "fwcfg.h"
#include "desc.h"

#define IPI_VECTOR 0x20

typedef void (*ipi_function_type)(void *data);

static struct spinlock ipi_lock;
static volatile ipi_function_type ipi_function;
static void *volatile ipi_data;
static volatile int ipi_done;
static volatile bool ipi_wait;
static int _cpu_count;

static __attribute__((used)) void ipi()
{
    void (*function)(void *data) = ipi_function;
    void *data = ipi_data;
    bool wait = ipi_wait;

    if (!wait) {
	ipi_done = 1;
	apic_write(APIC_EOI, 0);
    }
    function(data);
    if (wait) {
	ipi_done = 1;
	apic_write(APIC_EOI, 0);
    }
}

asm (
     "ipi_entry: \n"
     "   call ipi \n"
#ifndef __x86_64__
     "   iret"
#else
     "   iretq"
#endif
     );

void spin_lock(struct spinlock *lock)
{
    int v = 1;

    do {
	asm volatile ("xchg %1, %0" : "+m"(lock->v), "+r"(v));
    } while (v);
    asm volatile ("" : : : "memory");
}

void spin_unlock(struct spinlock *lock)
{
    asm volatile ("" : : : "memory");
    lock->v = 0;
}

int cpu_count(void)
{
    return _cpu_count;
}

int smp_id(void)
{
    unsigned id;

    asm ("mov %%gs:0, %0" : "=r"(id));
    return id;
}

static void setup_smp_id(void *data)
{
    asm ("mov %0, %%gs:0" : : "r"(apic_id()) : "memory");
}

static void __on_cpu(int cpu, void (*function)(void *data), void *data,
                     int wait)
{
    spin_lock(&ipi_lock);
    if (cpu == smp_id())
	function(data);
    else {
	ipi_done = 0;
	ipi_function = function;
	ipi_data = data;
	ipi_wait = wait;
	apic_icr_write(APIC_INT_ASSERT | APIC_DEST_PHYSICAL | APIC_DM_FIXED
                       | IPI_VECTOR,
                       cpu);
	while (!ipi_done)
	    ;
    }
    spin_unlock(&ipi_lock);
}

void on_cpu(int cpu, void (*function)(void *data), void *data)
{
    __on_cpu(cpu, function, data, 1);
}

void on_cpu_async(int cpu, void (*function)(void *data), void *data)
{
    __on_cpu(cpu, function, data, 0);
}


void smp_init(void)
{
    int i;
    void ipi_entry(void);

    _cpu_count = fwcfg_get_nb_cpus();

    setup_idt();
    set_idt_entry(IPI_VECTOR, ipi_entry, 0);

    setup_smp_id(0);
    for (i = 1; i < cpu_count(); ++i)
        on_cpu(i, setup_smp_id, 0);

}
