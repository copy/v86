#include "libcflat.h"
#include "vm.h"
#include "smp.h"
#include "isr.h"
#include "atomic.h"
#include "hyperv.h"
#include "bitops.h"

#define MAX_CPUS 64

#define MSG_VEC 0xb0
#define EVT_VEC 0xb1
#define MSG_SINT 0x8
#define EVT_SINT 0x9
#define MSG_CONN_BASE 0x10
#define EVT_CONN_BASE 0x20
#define MSG_TYPE 0x12345678

#define WAIT_CYCLES 10000000

static atomic_t ncpus_done;

struct hv_vcpu {
	struct hv_message_page *msg_page;
	struct hv_event_flags_page *evt_page;
	struct hv_input_post_message *post_msg;
	u8 msg_conn;
	u8 evt_conn;
	u64 hvcall_status;
	atomic_t sint_received;
};

static struct hv_vcpu hv_vcpus[MAX_CPUS];

static void sint_isr(isr_regs_t *regs)
{
	atomic_inc(&hv_vcpus[smp_id()].sint_received);
}

static void *hypercall_page;

static void setup_hypercall(void)
{
	u64 guestid = (0x8f00ull << 48);

	hypercall_page = alloc_page();
	if (!hypercall_page)
		report_abort("failed to allocate hypercall page");
	memset(hypercall_page, 0, PAGE_SIZE);

	wrmsr(HV_X64_MSR_GUEST_OS_ID, guestid);

	wrmsr(HV_X64_MSR_HYPERCALL,
	      (u64)virt_to_phys(hypercall_page) | HV_X64_MSR_HYPERCALL_ENABLE);
}

static void teardown_hypercall(void)
{
	wrmsr(HV_X64_MSR_HYPERCALL, 0);
	wrmsr(HV_X64_MSR_GUEST_OS_ID, 0);
	free_page(hypercall_page);
}

static u64 do_hypercall(u16 code, u64 arg, bool fast)
{
	u64 ret;
	u64 ctl = code;
	if (fast)
		ctl |= HV_HYPERCALL_FAST;

	asm volatile ("call *%[hcall_page]"
#ifdef __x86_64__
		      "\n mov $0,%%r8"
		      : "=a"(ret)
		      : "c"(ctl), "d"(arg),
#else
		      : "=A"(ret)
		      : "A"(ctl),
			"b" ((u32)(arg >> 32)), "c" ((u32)arg),
			"D"(0), "S"(0),
#endif
		      [hcall_page] "m" (hypercall_page)
#ifdef __x86_64__
		      : "r8"
#endif
		     );

	return ret;
}

static void setup_cpu(void *ctx)
{
	int vcpu;
	struct hv_vcpu *hv;

	write_cr3((ulong)ctx);
	irq_enable();

	vcpu = smp_id();
	hv = &hv_vcpus[vcpu];

	hv->msg_page = alloc_page();
	hv->evt_page = alloc_page();
	hv->post_msg = alloc_page();
	if (!hv->msg_page || !hv->evt_page || !hv->post_msg)
		report_abort("failed to allocate synic pages for vcpu");
	memset(hv->msg_page, 0, sizeof(*hv->msg_page));
	memset(hv->evt_page, 0, sizeof(*hv->evt_page));
	memset(hv->post_msg, 0, sizeof(*hv->post_msg));
	hv->msg_conn = MSG_CONN_BASE + vcpu;
	hv->evt_conn = EVT_CONN_BASE + vcpu;

	wrmsr(HV_X64_MSR_SIMP,
	      (u64)virt_to_phys(hv->msg_page) | HV_SYNIC_SIMP_ENABLE);
	wrmsr(HV_X64_MSR_SIEFP,
	      (u64)virt_to_phys(hv->evt_page) | HV_SYNIC_SIEFP_ENABLE);
	wrmsr(HV_X64_MSR_SCONTROL, HV_SYNIC_CONTROL_ENABLE);

	msg_conn_create(MSG_SINT, MSG_VEC, hv->msg_conn);
	evt_conn_create(EVT_SINT, EVT_VEC, hv->evt_conn);

	hv->post_msg->connectionid = hv->msg_conn;
	hv->post_msg->message_type = MSG_TYPE;
	hv->post_msg->payload_size = 8;
	hv->post_msg->payload[0] = (u64)vcpu << 16;
}

static void teardown_cpu(void *ctx)
{
	int vcpu = smp_id();
	struct hv_vcpu *hv = &hv_vcpus[vcpu];

	evt_conn_destroy(EVT_SINT, hv->evt_conn);
	msg_conn_destroy(MSG_SINT, hv->msg_conn);

	wrmsr(HV_X64_MSR_SCONTROL, 0);
	wrmsr(HV_X64_MSR_SIEFP, 0);
	wrmsr(HV_X64_MSR_SIMP, 0);

	free_page(hv->post_msg);
	free_page(hv->evt_page);
	free_page(hv->msg_page);
}

static void do_msg(void *ctx)
{
	int vcpu = (ulong)ctx;
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	struct hv_input_post_message *msg = hv->post_msg;

	msg->payload[0]++;
	atomic_set(&hv->sint_received, 0);
	hv->hvcall_status = do_hypercall(HVCALL_POST_MESSAGE,
					 virt_to_phys(msg), 0);
	atomic_inc(&ncpus_done);
}

static void clear_msg(void *ctx)
{
	/* should only be done on the current vcpu */
	int vcpu = smp_id();
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	struct hv_message *msg = &hv->msg_page->sint_message[MSG_SINT];

	atomic_set(&hv->sint_received, 0);
	msg->header.message_type = 0;
	barrier();
	wrmsr(HV_X64_MSR_EOM, 0);
	atomic_inc(&ncpus_done);
}

static bool msg_ok(int vcpu)
{
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	struct hv_input_post_message *post_msg = hv->post_msg;
	struct hv_message *msg = &hv->msg_page->sint_message[MSG_SINT];

	return msg->header.message_type == post_msg->message_type &&
		msg->header.payload_size == post_msg->payload_size &&
		msg->header.message_flags.msg_pending == 0 &&
		msg->u.payload[0] == post_msg->payload[0] &&
		hv->hvcall_status == 0 &&
		atomic_read(&hv->sint_received) == 1;
}

static bool msg_busy(int vcpu)
{
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	struct hv_input_post_message *post_msg = hv->post_msg;
	struct hv_message *msg = &hv->msg_page->sint_message[MSG_SINT];

	return msg->header.message_type == post_msg->message_type &&
		msg->header.payload_size == post_msg->payload_size &&
		msg->header.message_flags.msg_pending == 1 &&
		msg->u.payload[0] == post_msg->payload[0] - 1 &&
		hv->hvcall_status == 0 &&
		atomic_read(&hv->sint_received) == 0;
}

static void do_evt(void *ctx)
{
	int vcpu = (ulong)ctx;
	struct hv_vcpu *hv = &hv_vcpus[vcpu];

	atomic_set(&hv->sint_received, 0);
	hv->hvcall_status = do_hypercall(HVCALL_SIGNAL_EVENT,
					 hv->evt_conn, 1);
	atomic_inc(&ncpus_done);
}

static void clear_evt(void *ctx)
{
	/* should only be done on the current vcpu */
	int vcpu = smp_id();
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	ulong *flags = hv->evt_page->slot[EVT_SINT].flags;

	atomic_set(&hv->sint_received, 0);
	flags[BIT_WORD(hv->evt_conn)] &= ~BIT_MASK(hv->evt_conn);
	barrier();
	atomic_inc(&ncpus_done);
}

static bool evt_ok(int vcpu)
{
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	ulong *flags = hv->evt_page->slot[EVT_SINT].flags;

	return flags[BIT_WORD(hv->evt_conn)] == BIT_MASK(hv->evt_conn) &&
		hv->hvcall_status == 0 &&
		atomic_read(&hv->sint_received) == 1;
}

static bool evt_busy(int vcpu)
{
	struct hv_vcpu *hv = &hv_vcpus[vcpu];
	ulong *flags = hv->evt_page->slot[EVT_SINT].flags;

	return flags[BIT_WORD(hv->evt_conn)] == BIT_MASK(hv->evt_conn) &&
		hv->hvcall_status == 0 &&
		atomic_read(&hv->sint_received) == 0;
}

static int run_test(int ncpus, int dst_add, ulong wait_cycles,
		    void (*func)(void *), bool (*is_ok)(int))
{
	int i, ret = 0;

	atomic_set(&ncpus_done, 0);
	for (i = 0; i < ncpus; i++) {
		ulong dst = (i + dst_add) % ncpus;
		on_cpu_async(i, func, (void *)dst);
	}
	while (atomic_read(&ncpus_done) != ncpus)
		pause();

	while (wait_cycles--)
		pause();

	if (is_ok)
		for (i = 0; i < ncpus; i++)
			ret += is_ok(i);
	return ret;
}

#define HV_STATUS_INVALID_HYPERCALL_CODE        2

int main(int ac, char **av)
{
	int ncpus, ncpus_ok, i;

	if (!synic_supported()) {
		report_skip("Hyper-V SynIC is not supported");
		goto summary;
	}

	setup_vm();
	smp_init();
	ncpus = cpu_count();
	if (ncpus > MAX_CPUS)
		report_abort("# cpus: %d > %d", ncpus, MAX_CPUS);

	handle_irq(MSG_VEC, sint_isr);
	handle_irq(EVT_VEC, sint_isr);

	setup_hypercall();

	if (do_hypercall(HVCALL_SIGNAL_EVENT, 0x1234, 1) ==
	    HV_STATUS_INVALID_HYPERCALL_CODE) {
		report_skip("Hyper-V SynIC connections are not supported");
		goto summary;
	}

	for (i = 0; i < ncpus; i++)
		on_cpu(i, setup_cpu, (void *)read_cr3());

	ncpus_ok = run_test(ncpus, 0, WAIT_CYCLES, do_msg, msg_ok);
	report("send message to self: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	run_test(ncpus, 0, 0, clear_msg, NULL);

	ncpus_ok = run_test(ncpus, 1, WAIT_CYCLES, do_msg, msg_ok);
	report("send message to another cpu: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	ncpus_ok = run_test(ncpus, 1, WAIT_CYCLES, do_msg, msg_busy);
	report("send message to busy slot: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	ncpus_ok = run_test(ncpus, 0, WAIT_CYCLES, clear_msg, msg_ok);
	report("receive pending message: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	ncpus_ok = run_test(ncpus, 0, WAIT_CYCLES, do_evt, evt_ok);
	report("signal event on self: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	run_test(ncpus, 0, 0, clear_evt, NULL);

	ncpus_ok = run_test(ncpus, 1, WAIT_CYCLES, do_evt, evt_ok);
	report("signal event on another cpu: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	ncpus_ok = run_test(ncpus, 1, WAIT_CYCLES, do_evt, evt_busy);
	report("signal event already set: %d/%d",
	       ncpus_ok == ncpus, ncpus_ok, ncpus);

	for (i = 0; i < ncpus; i++)
		on_cpu(i, teardown_cpu, NULL);

	teardown_hypercall();

summary:
	return report_summary();
}
