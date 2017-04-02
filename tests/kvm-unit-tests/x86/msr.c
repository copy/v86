/* msr tests */

#include "libcflat.h"
#include "processor.h"
#include "msr.h"

struct msr_info {
    int index;
    char *name;
    struct tc {
        int valid;
        unsigned long long value;
        unsigned long long expected;
    } val_pairs[20];
};


#define addr_64 0x0000123456789abcULL

struct msr_info msr_info[] =
{
    { .index = 0x00000174, .name = "IA32_SYSENTER_CS",
      .val_pairs = {{ .valid = 1, .value = 0x1234, .expected = 0x1234}}
    },
    { .index = 0x00000175, .name = "MSR_IA32_SYSENTER_ESP",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
    { .index = 0x00000176, .name = "IA32_SYSENTER_EIP",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
    { .index = 0x000001a0, .name = "MSR_IA32_MISC_ENABLE",
      // reserved: 1:2, 4:6, 8:10, 13:15, 17, 19:21, 24:33, 35:63
      .val_pairs = {{ .valid = 1, .value = 0x400c51889, .expected = 0x400c51889}}
    },
    { .index = 0x00000277, .name = "MSR_IA32_CR_PAT",
      .val_pairs = {{ .valid = 1, .value = 0x07070707, .expected = 0x07070707}}
    },
    { .index = 0xc0000100, .name = "MSR_FS_BASE",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
    { .index = 0xc0000101, .name = "MSR_GS_BASE",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
    { .index = 0xc0000102, .name = "MSR_KERNEL_GS_BASE",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
#ifdef __x86_64__
    { .index = 0xc0000080, .name = "MSR_EFER",
      .val_pairs = {{ .valid = 1, .value = 0xD00, .expected = 0xD00}}
    },
#endif
    { .index = 0xc0000082, .name = "MSR_LSTAR",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
    { .index = 0xc0000083, .name = "MSR_CSTAR",
      .val_pairs = {{ .valid = 1, .value = addr_64, .expected = addr_64}}
    },
    { .index = 0xc0000084, .name = "MSR_SYSCALL_MASK",
      .val_pairs = {{ .valid = 1, .value = 0xffffffff, .expected = 0xffffffff}}
    },

//    MSR_IA32_DEBUGCTLMSR needs svm feature LBRV
//    MSR_VM_HSAVE_PA only AMD host
};

static int find_msr_info(int msr_index)
{
    int i;
    for (i = 0; i < sizeof(msr_info)/sizeof(msr_info[0]) ; i++) {
        if (msr_info[i].index == msr_index) {
            return i;
        }
    }
    return -1;
}

static void test_msr_rw(int msr_index, unsigned long long input, unsigned long long expected)
{
    unsigned long long r = 0;
    int index;
    char *sptr;
    if ((index = find_msr_info(msr_index)) != -1) {
        sptr = msr_info[index].name;
    } else {
        printf("couldn't find name for msr # 0x%x, skipping\n", msr_index);
        return;
    }
    wrmsr(msr_index, input);
    r = rdmsr(msr_index);
    if (expected != r) {
        printf("testing %s: output = 0x%x:0x%x expected = 0x%x:0x%x\n", sptr,
               (u32)(r >> 32), (u32)r, (u32)(expected >> 32), (u32)expected);
    }
    report(sptr, expected == r);
}

static void test_syscall_lazy_load(void)
{
#ifdef __x86_64__
    extern void syscall_target();
    u16 cs = read_cs(), ss = read_ss();
    ulong tmp;

    wrmsr(MSR_EFER, rdmsr(MSR_EFER) | EFER_SCE);
    wrmsr(MSR_LSTAR, (ulong)syscall_target);
    wrmsr(MSR_STAR, (uint64_t)cs << 32);
    asm volatile("pushf; syscall; syscall_target: popf" : "=c"(tmp) : : "r11");
    write_ss(ss);
    // will crash horribly if broken
    report("MSR_*STAR eager loading", true);
#endif
}

int main(int ac, char **av)
{
    int i, j;
    for (i = 0 ; i < sizeof(msr_info) / sizeof(msr_info[0]); i++) {
        for (j = 0; j < sizeof(msr_info[i].val_pairs) / sizeof(msr_info[i].val_pairs[0]); j++) {
            if (msr_info[i].val_pairs[j].valid) {
                test_msr_rw(msr_info[i].index, msr_info[i].val_pairs[j].value, msr_info[i].val_pairs[j].expected);
            } else {
                break;
            }
        }
    }

    test_syscall_lazy_load();

    return report_summary();
}

