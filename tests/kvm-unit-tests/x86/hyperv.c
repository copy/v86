#include "hyperv.h"
#include "asm/io.h"

static void synic_ctl(u8 ctl, u8 vcpu_id, u8 sint)
{
    outl((ctl << 16)|((vcpu_id) << 8)|sint, 0x3000);
}

void synic_sint_create(int vcpu, int sint, int vec, bool auto_eoi)
{
    wrmsr(HV_X64_MSR_SINT0 + sint,
          (u64)vec | ((auto_eoi) ? HV_SYNIC_SINT_AUTO_EOI : 0));
    synic_ctl(HV_TEST_DEV_SINT_ROUTE_CREATE, vcpu, sint);
}

void synic_sint_set(int vcpu, int sint)
{
    synic_ctl(HV_TEST_DEV_SINT_ROUTE_SET_SINT, vcpu, sint);
}

void synic_sint_destroy(int vcpu, int sint)
{
    wrmsr(HV_X64_MSR_SINT0 + sint, 0xFF|HV_SYNIC_SINT_MASKED);
    synic_ctl(HV_TEST_DEV_SINT_ROUTE_DESTROY, vcpu, sint);
}
