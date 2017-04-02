#ifndef __HYPERV_H
#define __HYPERV_H

#include "libcflat.h"
#include "processor.h"

#define HYPERV_CPUID_FEATURES                   0x40000003

#define HV_X64_MSR_TIME_REF_COUNT_AVAILABLE     (1 << 1)
#define HV_X64_MSR_SYNIC_AVAILABLE              (1 << 2)
#define HV_X64_MSR_SYNTIMER_AVAILABLE           (1 << 3)

#define HV_X64_MSR_TIME_REF_COUNT               0x40000020
#define HV_X64_MSR_REFERENCE_TSC                0x40000021

/* Define synthetic interrupt controller model specific registers. */
#define HV_X64_MSR_SCONTROL                     0x40000080
#define HV_X64_MSR_SVERSION                     0x40000081
#define HV_X64_MSR_SIEFP                        0x40000082
#define HV_X64_MSR_SIMP                         0x40000083
#define HV_X64_MSR_EOM                          0x40000084
#define HV_X64_MSR_SINT0                        0x40000090
#define HV_X64_MSR_SINT1                        0x40000091
#define HV_X64_MSR_SINT2                        0x40000092
#define HV_X64_MSR_SINT3                        0x40000093
#define HV_X64_MSR_SINT4                        0x40000094
#define HV_X64_MSR_SINT5                        0x40000095
#define HV_X64_MSR_SINT6                        0x40000096
#define HV_X64_MSR_SINT7                        0x40000097
#define HV_X64_MSR_SINT8                        0x40000098
#define HV_X64_MSR_SINT9                        0x40000099
#define HV_X64_MSR_SINT10                       0x4000009A
#define HV_X64_MSR_SINT11                       0x4000009B
#define HV_X64_MSR_SINT12                       0x4000009C
#define HV_X64_MSR_SINT13                       0x4000009D
#define HV_X64_MSR_SINT14                       0x4000009E
#define HV_X64_MSR_SINT15                       0x4000009F

/*
 * Synthetic Timer MSRs. Four timers per vcpu.
 */

#define HV_X64_MSR_STIMER0_CONFIG               0x400000B0
#define HV_X64_MSR_STIMER0_COUNT                0x400000B1
#define HV_X64_MSR_STIMER1_CONFIG               0x400000B2
#define HV_X64_MSR_STIMER1_COUNT                0x400000B3
#define HV_X64_MSR_STIMER2_CONFIG               0x400000B4
#define HV_X64_MSR_STIMER2_COUNT                0x400000B5
#define HV_X64_MSR_STIMER3_CONFIG               0x400000B6
#define HV_X64_MSR_STIMER3_COUNT                0x400000B7

#define HV_SYNIC_CONTROL_ENABLE                 (1ULL << 0)
#define HV_SYNIC_SIMP_ENABLE                    (1ULL << 0)
#define HV_SYNIC_SIEFP_ENABLE                   (1ULL << 0)
#define HV_SYNIC_SINT_MASKED                    (1ULL << 16)
#define HV_SYNIC_SINT_AUTO_EOI                  (1ULL << 17)
#define HV_SYNIC_SINT_VECTOR_MASK               (0xFF)
#define HV_SYNIC_SINT_COUNT                     16

#define HV_STIMER_ENABLE                (1ULL << 0)
#define HV_STIMER_PERIODIC              (1ULL << 1)
#define HV_STIMER_LAZY                  (1ULL << 2)
#define HV_STIMER_AUTOENABLE            (1ULL << 3)
#define HV_STIMER_SINT(config)          (__u8)(((config) >> 16) & 0x0F)

#define HV_SYNIC_STIMER_COUNT           (4)

/* Define synthetic interrupt controller message constants. */
#define HV_MESSAGE_SIZE                 (256)
#define HV_MESSAGE_PAYLOAD_BYTE_COUNT   (240)
#define HV_MESSAGE_PAYLOAD_QWORD_COUNT  (30)

/* Define hypervisor message types. */
enum hv_message_type {
        HVMSG_NONE                      = 0x00000000,

        /* Memory access messages. */
        HVMSG_UNMAPPED_GPA              = 0x80000000,
        HVMSG_GPA_INTERCEPT             = 0x80000001,

        /* Timer notification messages. */
        HVMSG_TIMER_EXPIRED                     = 0x80000010,

        /* Error messages. */
        HVMSG_INVALID_VP_REGISTER_VALUE = 0x80000020,
        HVMSG_UNRECOVERABLE_EXCEPTION   = 0x80000021,
        HVMSG_UNSUPPORTED_FEATURE               = 0x80000022,

        /* Trace buffer complete messages. */
        HVMSG_EVENTLOG_BUFFERCOMPLETE   = 0x80000040,

        /* Platform-specific processor intercept messages. */
        HVMSG_X64_IOPORT_INTERCEPT              = 0x80010000,
        HVMSG_X64_MSR_INTERCEPT         = 0x80010001,
        HVMSG_X64_CPUID_INTERCEPT               = 0x80010002,
        HVMSG_X64_EXCEPTION_INTERCEPT   = 0x80010003,
        HVMSG_X64_APIC_EOI                      = 0x80010004,
        HVMSG_X64_LEGACY_FP_ERROR               = 0x80010005
};

/* Define synthetic interrupt controller message flags. */
union hv_message_flags {
        uint8_t asu8;
        struct {
                uint8_t msg_pending:1;
                uint8_t reserved:7;
        };
};

union hv_port_id {
        uint32_t asu32;
        struct {
                uint32_t id:24;
                uint32_t reserved:8;
        } u;
};

/* Define port type. */
enum hv_port_type {
        HVPORT_MSG      = 1,
        HVPORT_EVENT            = 2,
        HVPORT_MONITOR  = 3
};

/* Define synthetic interrupt controller message header. */
struct hv_message_header {
        uint32_t message_type;
        uint8_t payload_size;
        union hv_message_flags message_flags;
        uint8_t reserved[2];
        union {
                uint64_t sender;
                union hv_port_id port;
        };
};

/* Define timer message payload structure. */
struct hv_timer_message_payload {
        uint32_t timer_index;
        uint32_t reserved;
        uint64_t expiration_time;       /* When the timer expired */
        uint64_t delivery_time; /* When the message was delivered */
};

/* Define synthetic interrupt controller message format. */
struct hv_message {
        struct hv_message_header header;
        union {
                uint64_t payload[HV_MESSAGE_PAYLOAD_QWORD_COUNT];
        } u;
};

/* Define the synthetic interrupt message page layout. */
struct hv_message_page {
        struct hv_message sint_message[HV_SYNIC_SINT_COUNT];
};

enum {
    HV_TEST_DEV_SINT_ROUTE_CREATE = 1,
    HV_TEST_DEV_SINT_ROUTE_DESTROY,
    HV_TEST_DEV_SINT_ROUTE_SET_SINT
};

static inline bool synic_supported(void)
{
   return cpuid(HYPERV_CPUID_FEATURES).a & HV_X64_MSR_SYNIC_AVAILABLE;
}

static inline bool stimer_supported(void)
{
    return cpuid(HYPERV_CPUID_FEATURES).a & HV_X64_MSR_SYNIC_AVAILABLE;
}

static inline bool hv_time_ref_counter_supported(void)
{
    return cpuid(HYPERV_CPUID_FEATURES).a & HV_X64_MSR_TIME_REF_COUNT_AVAILABLE;
}

void synic_sint_create(int vcpu, int sint, int vec, bool auto_eoi);
void synic_sint_set(int vcpu, int sint);
void synic_sint_destroy(int vcpu, int sint);

struct hv_reference_tsc_page {
        uint32_t tsc_sequence;
        uint32_t res1;
        uint64_t tsc_scale;
        int64_t tsc_offset;
};


#endif
