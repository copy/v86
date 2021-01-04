
#include "identity.hh"
#include "exception.hh"
#include <stdlib.h>
#include <stdio.h>

namespace identity {

typedef unsigned long ulong;

hole::hole()
    : address(), size()
{
}

hole::hole(void* address, size_t size)
    : address(address), size(size)
{
}

vm::vm(kvm::vm& vm, mem_map& mmap, hole h)
{
    int ret = posix_memalign(&tss, 4096, 4 * 4096);
    if (ret) {
        throw errno_exception(ret);
    }

    uint64_t hole_gpa = reinterpret_cast<uintptr_t>(h.address);
    char* hole_hva = static_cast<char*>(h.address);
    uint64_t tss_addr = reinterpret_cast<uintptr_t>(tss);
    uint64_t tss_end = tss_addr + 4 * 4096;
    uint64_t hole_end = hole_gpa + h.size;

    if (hole_gpa < tss_addr) {
        if (hole_gpa) {
            _slots.push_back(mem_slot_ptr(new mem_slot(mmap, 0, hole_gpa, NULL)));
        }
        _slots.push_back(mem_slot_ptr(new mem_slot(mmap, hole_end, tss_addr - hole_end,
						   hole_hva + h.size)));
        _slots.push_back(mem_slot_ptr(new mem_slot(mmap, tss_end, (uint32_t)-tss_end,
						   (char*)tss + 4 * 4096)));
    } else {
        _slots.push_back(mem_slot_ptr(new mem_slot(mmap, 0, tss_addr, NULL)));
        _slots.push_back(mem_slot_ptr(new mem_slot(mmap, tss_end, hole_gpa - tss_end,
						   (char*)tss + 4 * 4096)));
        _slots.push_back(mem_slot_ptr(new mem_slot(mmap, hole_end, (uint32_t)-hole_end,
						   hole_hva + h.size)));
    }

    vm.set_tss_addr(tss_addr);
    vm.set_ept_identity_map_addr(tss_addr + 3 * 4096);
}

vm::~vm()
{
    free(tss);
}

void vcpu::setup_sregs()
{
    kvm_sregs sregs = { };
    kvm_segment dseg = { };
    dseg.base = 0; dseg.limit = -1U; dseg.type = 3; dseg.present = 1;
    dseg.dpl = 3; dseg.db = 1; dseg.s = 1; dseg.l = 0; dseg.g = 1;
    kvm_segment cseg = dseg;
    cseg.type = 11;

    sregs.cs = cseg; asm ("mov %%cs, %0" : "=rm"(sregs.cs.selector));
    sregs.ds = dseg; asm ("mov %%ds, %0" : "=rm"(sregs.ds.selector));
    sregs.es = dseg; asm ("mov %%es, %0" : "=rm"(sregs.es.selector));
    sregs.fs = dseg; asm ("mov %%fs, %0" : "=rm"(sregs.fs.selector));
    sregs.gs = dseg; asm ("mov %%gs, %0" : "=rm"(sregs.gs.selector));
    sregs.ss = dseg; asm ("mov %%ss, %0" : "=rm"(sregs.ss.selector));

    uint32_t gsbase;
    asm ("mov %%gs:0, %0" : "=r"(gsbase));
    sregs.gs.base = gsbase;

    sregs.tr.base = reinterpret_cast<uintptr_t>(&*_stack.begin());
    sregs.tr.type = 11;
    sregs.tr.s = 0;
    sregs.tr.present = 1;

    sregs.cr0 = 0x11; /* PE, ET, !PG */
    sregs.cr4 = 0;
    sregs.efer = 0;
    sregs.apic_base = 0xfee00000;
    _vcpu.set_sregs(sregs);
}

void vcpu::thunk(vcpu* zis)
{
    zis->_guest_func();
    asm volatile("outb %%al, %%dx" : : "a"(0), "d"(0));
}

void vcpu::setup_regs()
{
    kvm_regs regs = {};
    regs.rflags = 0x3202;
    regs.rsp = reinterpret_cast<ulong>(&*_stack.end());
    regs.rsp &= ~15UL;
    ulong* sp = reinterpret_cast<ulong *>(regs.rsp);
    *--sp = reinterpret_cast<ulong>((char*)this);
    *--sp = 0;
    regs.rsp = reinterpret_cast<ulong>(sp);
    regs.rip = reinterpret_cast<ulong>(&vcpu::thunk);
    printf("rip %llx\n", regs.rip);
    _vcpu.set_regs(regs);
}

vcpu::vcpu(kvm::vcpu& vcpu, std::function<void ()> guest_func,
           unsigned long stack_size)
    : _vcpu(vcpu), _guest_func(guest_func), _stack(stack_size)
{
    setup_sregs();
    setup_regs();
}

}
