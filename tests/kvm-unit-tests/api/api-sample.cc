
#include "kvmxx.hh"
#include "identity.hh"
#include "exception.hh"
#include <stdio.h>

static int global = 0;

static void set_global()
{
    global = 1;
}

int test_main(int ac, char** av)
{
    kvm::system system;
    kvm::vm vm(system);
    mem_map memmap(vm);
    identity::vm ident_vm(vm, memmap);
    kvm::vcpu vcpu(vm, 0);
    identity::vcpu thread(vcpu, set_global);
    vcpu.run();
    printf("global %d\n", global);
    return global == 1 ? 0 : 1;
}

int main(int ac, char** av)
{
    return try_main(test_main, ac, av);
}
