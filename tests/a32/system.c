// AArch32 at PL1 against QEMU's cortex-a15 (docs/aarch32-plan.md R2): the
// modes and their banked registers, CPSR and the SPSRs, the exceptions'
// entry (vectors at VBAR, modes, return addresses, fault status) and
// returns, LDM and STM of the User registers, User mode's view, CP15 at
// PL1, VFP's enables. Every line printed must be QEMU's.
#include <a32.h>
#include <stdio.h>

void banks(uint32_t *out);
void fiq_banks(uint32_t *out);
void spsrs(uint32_t *out, uint32_t value);
void user_lsm(uint32_t *out);
void exception_returns(uint32_t *out);
uint32_t run_user(void (*function)(void), uint32_t argument);
extern char user_returned[];
void user_cpsr(void), user_mrs_spsr(void), user_sctlr(void), user_tpidr(void), user_tpidrprw(void),
    user_cntvct(void), user_svc(void), user_vfp(void), user_fpexc(void), user_ldm_user(void), user_hvc(void);
void t32_svc(uint32_t *at), t32_udf16(uint32_t *at), t32_udf32(uint32_t *at), t32_cps(uint32_t *out);

static void print_words(const char *name, const uint32_t *w, int n)
{
    printf("%s:", name);
    for(int i = 0; i < n; i++) printf(" %x", (unsigned)w[i]);
    printf("\n");
}

// (SVC #0xFF from User mode: back to run_user's caller, in SVC mode)
static int hook(struct a32_frame *frame, int kind)
{
    if(kind != A32_SVC) return 0;
    uint32_t imm = frame->cpsr & 1 << 5 ? *(volatile uint16_t *)(frame->pc - 2) & 0xFF : *(volatile uint32_t *)(frame->pc - 4) & 0xFFFFFF;
    if(imm != 0xFF) return 0;
    frame->pc = (uint32_t)user_returned;
    frame->cpsr = 0x1D3;
    return 1;
}

static void report(const char *name, struct a32_fault *f, uint32_t at)
{
    if(!f->taken) { printf("%s: no exception\n", name); return; }
    printf("%s: kind %d spsr %#x pc-at %d lr-at %d fsr %#x far %#x mode %#x\n", name, f->kind, (unsigned)f->spsr,
        (int)(f->pc - at), (int)(f->lr - at), (unsigned)f->fsr, (unsigned)f->far, (unsigned)(a32_cpsr() & 0x1F));
}

static void exceptions(void)
{
    struct a32_fault f;
    uint32_t at, v;
    static uint32_t buffer[4] = { 0x11223344, 0x55667788, 0x99AABBCC, 0xDDEEFF00 };

    a32_expect(0);
    __asm__ volatile("adr %0, 1f\n1: svc #0x42" : "=r"(at) :: "lr", "memory");
    a32_caught(&f);
    report("svc a32", &f, at);

    a32_expect(0);
    t32_svc(&at);
    a32_caught(&f);
    report("svc t32", &f, at);

    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: udf #0" : "=r"(at) :: "memory");
    a32_caught(&f);
    report("udf a32", &f, at);

    a32_expect(2);
    t32_udf16(&at);
    a32_caught(&f);
    report("udf t32", &f, at);

    a32_expect(4);
    t32_udf32(&at);
    a32_caught(&f);
    report("udf.w t32", &f, at);

    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: bkpt #0x11" : "=r"(at) :: "memory");
    a32_caught(&f);
    report("bkpt a32", &f, at);

    // (alignment: SCTLR.A, the MMU off)
    a32_mcr(0, c1, c0, 0, a32_mrc(0, c1, c0, 0) | 2);
    a32_isb();
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: ldr %1, [%2]" : "=&r"(at), "=r"(v) : "r"((char *)buffer + 1) : "memory");
    a32_caught(&f);
    f.far -= (uint32_t)buffer;
    report("ldr unaligned, A", &f, at);
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: str %1, [%2]" : "=&r"(at) : "r"(0), "r"((char *)buffer + 2) : "memory");
    a32_caught(&f);
    f.far -= (uint32_t)buffer;
    report("str unaligned, A", &f, at);
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: ldrh %1, [%2]" : "=&r"(at), "=r"(v) : "r"((char *)buffer + 1) : "memory");
    a32_caught(&f);
    f.far -= (uint32_t)buffer;
    report("ldrh unaligned, A", &f, at);
    a32_mcr(0, c1, c0, 0, a32_mrc(0, c1, c0, 0) & ~2u);
    a32_isb();
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: ldr %1, [%2]" : "=&r"(at), "=r"(v) : "r"((char *)buffer + 1) : "memory");
    a32_caught(&f);
    f.far -= (uint32_t)buffer;
    report("ldr unaligned, MMU off", &f, at);
    uint64_t pair;
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: ldrd %1, %H1, [%2]" : "=&r"(at), "=r"(pair) : "r"((char *)buffer + 4) : "memory");
    a32_caught(&f);
    report("ldrd word-aligned", &f, at);
    printf("ldrd %#llx\n", (unsigned long long)pair);
}

static void cp15(void)
{
    printf("sctlr %#x ttbcr %#x dacr %#x contextidr %#x\n", (unsigned)a32_mrc(0, c1, c0, 0), (unsigned)a32_mrc(0, c2, c0, 2),
        (unsigned)a32_mrc(0, c3, c0, 0), (unsigned)a32_mrc(0, c13, c0, 1));
    printf("midr %#x mpidr %#x ctr %#x clidr %#x actlr %#x\n", (unsigned)a32_mrc(0, c0, c0, 0), (unsigned)a32_mrc(0, c0, c0, 5),
        (unsigned)a32_mrc(0, c0, c0, 1), (unsigned)a32_mrc(1, c0, c0, 1), (unsigned)a32_mrc(0, c1, c0, 1));
    printf("id_pfr1 timer %#x id_mmfr0 vmsa %#x\n", (unsigned)(a32_mrc(0, c0, c1, 1) >> 16 & 15), (unsigned)(a32_mrc(0, c0, c1, 4) & 15));
    // writes and reads back
    a32_mcr(0, c13, c0, 4, 0x12345678);
    a32_mcr(0, c13, c0, 2, 0x9ABCDEF0);
    a32_mcr(0, c13, c0, 3, 0x0F1E2D3C);
    a32_mcr(0, c13, c0, 1, 0x00000105);
    a32_mcr(0, c3, c0, 0, 0x55555555);
    a32_mcr(0, c2, c0, 2, 0x00000002);
    a32_mcr(0, c2, c0, 0, 0x4000406A);
    a32_mcr(0, c2, c0, 1, 0x40008000);
    a32_mcr(0, c10, c2, 0, 0xFF0A81A8);
    a32_mcr(0, c10, c2, 1, 0x40E040E0);
    a32_mcr(0, c5, c0, 0, 0x00000805);
    a32_mcr(0, c5, c0, 1, 0x0000000D);
    a32_mcr(0, c6, c0, 0, 0xDEADBEEF);
    a32_mcr(0, c6, c0, 2, 0xFEEDF00D);
    a32_mcr(0, c1, c0, 1, 0x00000040);
    a32_mcr(0, c1, c0, 2, 0xFFFFFFFF);
    a32_isb();
    uint32_t w[] = { a32_mrc(0, c13, c0, 4), a32_mrc(0, c13, c0, 2), a32_mrc(0, c13, c0, 3), a32_mrc(0, c13, c0, 1),
        a32_mrc(0, c3, c0, 0), a32_mrc(0, c2, c0, 2), a32_mrc(0, c2, c0, 0), a32_mrc(0, c2, c0, 1), a32_mrc(0, c10, c2, 0),
        a32_mrc(0, c10, c2, 1), a32_mrc(0, c5, c0, 0), a32_mrc(0, c5, c0, 1), a32_mrc(0, c6, c0, 0), a32_mrc(0, c6, c0, 2),
        a32_mrc(0, c1, c0, 1), a32_mrc(0, c1, c0, 2) };
    print_words("cp15 written", w, 16);
    // (the 64-bit TTBR0 view)
    uint64_t ttbr0 = a32_mrrc(0, c2);
    printf("ttbr0 64 %#llx\n", (unsigned long long)ttbr0);
    a32_mcr(0, c13, c0, 1, 0);
    a32_mcr(0, c3, c0, 0, 0);
    a32_mcr(0, c2, c0, 2, 0);
    a32_mcr(0, c1, c0, 2, 0xF << 20);
    // (maintenance: TLB, caches, barriers and the branch predictor, no faults)
    a32_mcr(0, c8, c7, 0, 0);
    a32_mcr(0, c8, c3, 0, 0);
    a32_mcr(0, c8, c7, 1, 0x40001000);
    a32_mcr(0, c8, c7, 2, 1);
    a32_mcr(0, c8, c7, 3, 0x40001000);
    a32_mcr(0, c7, c5, 0, 0);
    a32_mcr(0, c7, c5, 6, 0);
    a32_mcr(0, c7, c10, 1, 0x40001000);
    a32_mcr(0, c7, c14, 1, 0x40001000);
    a32_mcr(0, c7, c6, 1, 0x40001000);
    a32_mcr(0, c7, c10, 5, 0);
    a32_mcr(0, c7, c10, 4, 0);
    a32_mcr(0, c7, c5, 4, 0);
    a32_mcr(2, c0, c0, 0, 0);
    printf("csselr %#x\n", (unsigned)a32_mrc(2, c0, c0, 0));
    printf("maintenance done\n");
}

static void vfp(void)
{
    struct a32_fault f;
    uint32_t at, v;
    uint32_t fpsid, mvfr0, fpexc;
    __asm__ volatile("vmrs %0, fpsid\n vmrs %1, mvfr0\n vmrs %2, fpexc" : "=r"(fpsid), "=r"(mvfr0), "=r"(fpexc));
    printf("fpsid %#x mvfr0 %#x fpexc %#x\n", (unsigned)fpsid, (unsigned)mvfr0, (unsigned)fpexc);
    // FPEXC.EN 0: VFP instructions and VMRS FPSCR UNDEFINED, VMRS FPEXC not
    a32_expect(4);
    __asm__ volatile("vmsr fpexc, %2\n adr %0, 1f\n1: vadd.f32 s0, s0, s0\n vmrs %1, fpexc" : "=&r"(at), "=&r"(v) : "r"(0) : "memory");
    a32_caught(&f);
    report("vadd, fpexc.en 0", &f, at);
    printf("fpexc then %#x\n", (unsigned)v);
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: vmrs %1, fpscr" : "=&r"(at), "=r"(v) :: "memory");
    a32_caught(&f);
    report("vmrs fpscr, fpexc.en 0", &f, at);
    __asm__ volatile("vmsr fpexc, %0" :: "r"(1 << 30));
    // CPACR's cp10 and cp11 0: UNDEFINED
    a32_mcr(0, c1, c0, 2, 0);
    a32_isb();
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: vadd.f32 s0, s0, s0" : "=r"(at) :: "memory");
    a32_caught(&f);
    report("vadd, cpacr 0", &f, at);
    a32_expect(4);
    __asm__ volatile("adr %0, 1f\n1: vmrs %1, fpexc" : "=&r"(at), "=r"(v) :: "memory");
    a32_caught(&f);
    report("vmrs fpexc, cpacr 0", &f, at);
    a32_mcr(0, c1, c0, 2, 0xF << 20);
    a32_isb();
    __asm__ volatile("vmov s0, %1\n vadd.f32 s0, s0, s0\n vmov %0, s0" : "=r"(v) : "r"(0x3F800000));
    printf("vadd 1 + 1 = %#x\n", (unsigned)v);
}

static void user(void)
{
    struct a32_fault f;
    a32_mcr(0, c13, c0, 3, 0x300);
    a32_mcr(0, c13, c0, 2, 0x21);
    struct { const char *name; void (*function)(void); uint32_t argument; } probes[] = {
        { "cpsr", user_cpsr, 0 },
        { "mrs spsr", user_mrs_spsr, 0 },
        { "mrc sctlr", user_sctlr, 0 },
        { "tpidruro + tpidrurw", user_tpidr, 0 },
        { "mrc tpidrprw", user_tpidrprw, 0 },
        { "mrrc cntvct", user_cntvct, 0 },
        { "svc", user_svc, 0x55 },
        { "vadd", user_vfp, 0x40000000 },
        { "vmrs fpexc", user_fpexc, 0 },
        { "ldm user registers", user_ldm_user, 0 },
        { "hvc", user_hvc, 0 },
    };
    for(unsigned i = 0; i < sizeof probes / sizeof probes[0]; i++)
    {
        a32_expect(4);
        uint32_t r = run_user(probes[i].function, probes[i].argument);
        a32_caught(&f);
        if(f.taken)
            printf("user %s: kind %d spsr %#x\n", probes[i].name, f.kind, (unsigned)f.spsr);
        else
            printf("user %s: %#x\n", probes[i].name, (unsigned)r);
    }
    printf("back in mode %#x\n", (unsigned)(a32_cpsr() & 0x1F));
}

int main(int argc, char **argv)
{
    uint32_t out[64];
    a32_exception_hook = hook;
    printf("mode %#x cpsr %#x vbar ok %d\n", (unsigned)(a32_cpsr() & 0x1F), (unsigned)a32_cpsr(),
        a32_mrc(0, c12, c0, 0) != 0);

    banks(out);
    print_words("mode cpsrs", out, 5);
    print_words("banked sp lr", out + 5, 10);
    print_words("restored", out + 15, 10);
    fiq_banks(out);
    print_words("fiq banks", out, 10);
    spsrs(out, 0xF9FF0200);
    print_words("spsrs", out, 14);
    user_lsm(out);
    print_words("user lsm", out, 5);
    exception_returns(out);
    print_words("exception returns", out, 9);
    t32_cps(out);
    print_words("t32 cps, subs pc", out, 3);

    exceptions();
    cp15();
    vfp();
    user();
    return 0;
}
