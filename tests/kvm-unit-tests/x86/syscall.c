/* msr tests */

#include "libcflat.h"
#include "processor.h"
#include "msr.h"
#include "desc.h"

static void test_syscall_lazy_load(void)
{
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
}

/*
 * test handling of TF in syscall/sysret: #DB is raised if TF
 * is 1 at the *end* of syscall/sysret.
 *
 * This uses 32-bit syscall/sysret because KVM emulates it on Intel processors.
 * However, the same bug happens with 64-bit syscall/sysret if two vCPUs
 * "race" to force the emulation of syscall/sysret.
 */

static uint16_t code_segment_upon_db;
static void handle_db(struct ex_regs *regs)
{
    code_segment_upon_db = regs->cs;
    regs->rflags &= ~(1 << 8);
}

/* expects desired ring 3 flags in rax */
asm("syscall32_target:\n"
    "   cmp $0, code_segment_upon_db(%rip)\n"
    "   jne back_to_test\n"
    "   mov %eax,%r11d\n"
    "   sysretl\n");

/* 32-bit, ring-3 part of test_syscall_tf */
asm("   .code32\n"
    "syscall_tf_user32:\n"
    "   pushf\n"
    "   pop %eax\n"
    "   or $(1<<8),%eax\n"
    "   push %eax\n"
    "   popf\n"
    "   syscall\n"  /* singlestep trap taken after syscall */
    "   syscall\n"  /* jumps back to test_syscall_tf's body */
    "   .code64\n");

static void test_syscall_tf(void)
{
    extern void syscall32_target();
    extern void syscall_tf_user32();
    ulong rcx;

    wrmsr(MSR_EFER, rdmsr(MSR_EFER) | EFER_SCE);
    wrmsr(MSR_CSTAR, (ulong)syscall32_target);
    wrmsr(MSR_STAR, ((uint64_t)USER_CS32 << 48) | ((uint64_t)KERNEL_CS64 << 32));
    wrmsr(MSR_SYSCALL_MASK, X86_EFLAGS_TF|X86_EFLAGS_DF|X86_EFLAGS_IF|X86_EFLAGS_NT);
    handle_exception(DB_VECTOR, handle_db);

    /* good:
     *   sysret to syscall_tf_user32
     *   popf sets TF (singlestep starts on the next instruction)
     *   syscall to syscall32_target -> TF cleared and no singlestep
     *   sysretl sets TF
     *   handle_db sets code_segment_upon_db to USER_CS32 and clears TF
     *   syscall to syscall32_target
     *   syscall32_target jumps to back_to_test
     *
     * bad:
     *   sysret to syscall_tf_user32
     *   popf sets TF (singlestep starts on the next instruction)
     *   syscall to syscall32_target, TF cleared and wrong singlestep exception
     *   handle_db sets code_segment_upon_db to KERNEL_CS64
     *   syscall32_target jumps to back_to_test
     */
    rcx = (ulong)syscall_tf_user32;
    asm volatile("  push %%rbp\n"
                 "  pushf; pop %%rax\n"   // expected by syscall32_target
                 "  sysret\n"
                 "back_to_test:\n"
                 "  pop %%rbp"
                 : "+c"(rcx) :
                 : "rax", "rbx", "rdx", "rsi", "rdi", "r8", "r9", "r10", "r11",
                   "r12", "r13", "r14", "r15");
    if (code_segment_upon_db != USER_CS32) {
        printf("wrong CS (%#04x)!\n", code_segment_upon_db);
    }
    report("syscall TF handling", code_segment_upon_db == USER_CS32);
}

int main(int ac, char **av)
{
    setup_idt();
    test_syscall_lazy_load();
    test_syscall_tf();

    return report_summary();
}
