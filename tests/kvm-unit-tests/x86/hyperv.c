#include "hyperv.h"
#include "asm/io.h"
#include "smp.h"

enum {
    HV_TEST_DEV_SINT_ROUTE_CREATE = 1,
    HV_TEST_DEV_SINT_ROUTE_DESTROY,
    HV_TEST_DEV_SINT_ROUTE_SET_SINT,
    HV_TEST_DEV_MSG_CONN_CREATE,
    HV_TEST_DEV_MSG_CONN_DESTROY,
    HV_TEST_DEV_EVT_CONN_CREATE,
    HV_TEST_DEV_EVT_CONN_DESTROY,
};

static void synic_ctl(u32 ctl, u32 vcpu_id, u32 sint, u32 conn_id)
{
    outl((conn_id << 24) | (ctl << 16) | (vcpu_id << 8) | sint, 0x3000);
}

static void sint_enable(u8 sint, u8 vec, bool auto_eoi)
{
    wrmsr(HV_X64_MSR_SINT0 + sint,
          (u64)vec | (auto_eoi ? HV_SYNIC_SINT_AUTO_EOI : 0));
}

static void sint_disable(u8 sint)
{
    wrmsr(HV_X64_MSR_SINT0 + sint, 0xff | HV_SYNIC_SINT_MASKED);
}

void synic_sint_create(u8 sint, u8 vec, bool auto_eoi)
{
    synic_ctl(HV_TEST_DEV_SINT_ROUTE_CREATE, smp_id(), sint, 0);
    sint_enable(sint, vec, auto_eoi);
}

void synic_sint_set(u8 vcpu, u8 sint)
{
    synic_ctl(HV_TEST_DEV_SINT_ROUTE_SET_SINT, vcpu, sint, 0);
}

void synic_sint_destroy(u8 sint)
{
    sint_disable(sint);
    synic_ctl(HV_TEST_DEV_SINT_ROUTE_DESTROY, smp_id(), sint, 0);
}

void msg_conn_create(u8 sint, u8 vec, u8 conn_id)
{
    synic_ctl(HV_TEST_DEV_MSG_CONN_CREATE, smp_id(), sint, conn_id);
    sint_enable(sint, vec, true);
}

void msg_conn_destroy(u8 sint, u8 conn_id)
{
    sint_disable(sint);
    synic_ctl(HV_TEST_DEV_MSG_CONN_DESTROY, 0, 0, conn_id);
}

void evt_conn_create(u8 sint, u8 vec, u8 conn_id)
{
    synic_ctl(HV_TEST_DEV_EVT_CONN_CREATE, smp_id(), sint, conn_id);
    sint_enable(sint, vec, true);
}

void evt_conn_destroy(u8 sint, u8 conn_id)
{
    sint_disable(sint);
    synic_ctl(HV_TEST_DEV_EVT_CONN_DESTROY, 0, 0, conn_id);
}
