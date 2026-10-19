// FEAT_PAN (profile v2; tests/a64/pan.mjs against QEMU's -cpu max): with
// PSTATE.PAN set, EL1's loads, stores, exclusives and DC ZVA to a page EL0
// may access (AP[1] set: read/write or read-only) take a permission fault,
// pages only EL1 may access do not; the unprivileged LDTR and STTR are
// checked as EL0's; AT S1E1R and S1E1W and instruction fetches ignore PAN.
// MSR PAN (immediate and register), SPSR_EL1's PAN bit, an exception with
// SCTLR_EL1.SPAN clear (PAN set) and set (PAN kept), and ERET restoring
// PAN. Each probe prints its value or the exception's ESR and FAR.
#include <a64.h>
#include <stdio.h>
#include <stdint.h>

#define TEST_VA 0x1000000000UL // (L1 index 64, L2 index 0, L3 index 0)
#define UNMAPPED_VA (TEST_VA + 0x100000)

static uint64_t l1[512] __attribute__((aligned(4096)));
static uint64_t l2[512] __attribute__((aligned(4096)));
static uint64_t l3[512] __attribute__((aligned(4096)));
static uint64_t data[4][512] __attribute__((aligned(4096)));
static uint32_t code[1024] __attribute__((aligned(4096)));

// the test pages: AP[2:1] 00 EL1 read/write, 01 EL1 and EL0 read/write,
// 10 EL1 read-only, 11 EL1 and EL0 read-only; and a page of code EL0 may
// read (AP 11, UXN), executable at EL1
enum { EL1_RW, BOTH_RW, EL1_RO, BOTH_RO, CODE };
#define PAGE_VA(k) (TEST_VA + (uint64_t)(k) * 0x1000)

// (MSR PAN, #1 and #0, encoded: the assembler takes them for Armv8.1 only)
static void set_pan(int on)
{
    if(on) __asm__ volatile(".inst 0xd500419f" ::: "memory");
    else __asm__ volatile(".inst 0xd500409f" ::: "memory");
}
static uint64_t read_pan(void) { uint64_t v; __asm__ volatile("mrs %0, S3_0_C4_C2_3" : "=r"(v)); return v; }

static void report(const char *what, int taken, struct a64_fault *f, uint64_t value)
{
    if(taken) printf("%s: fault esr %lx far %lx\n", what, f->esr, f->far);
    else printf("%s: %lx\n", what, value);
}

static void probe_load(const char *what, uint64_t va)
{
    struct a64_fault f;
    uint64_t v = 0;
    a64_expect();
    __asm__ volatile("ldr %0, [%1]" : "+r"(v) : "r"(va) : "memory");
    report(what, a64_caught(&f), &f, v);
}
// (a store to page k at offset 16: the value there afterwards, read through the identity map)
static void probe_store(const char *what, int k)
{
    struct a64_fault f;
    data[k][2] = 0;
    a64_expect();
    __asm__ volatile("str %0, [%1]" :: "r"(0x5A5A5A5A5A5A5A5AUL), "r"(PAGE_VA(k) + 16) : "memory");
    report(what, a64_caught(&f), &f, *(volatile uint64_t *)&data[k][2]);
}
static void probe_ldtr(const char *what, uint64_t va)
{
    struct a64_fault f;
    uint64_t v = 0;
    a64_expect();
    __asm__ volatile("ldtr %0, [%1]" : "+r"(v) : "r"(va) : "memory");
    report(what, a64_caught(&f), &f, v);
}
static void probe_sttr(const char *what, uint64_t va)
{
    struct a64_fault f;
    a64_expect();
    __asm__ volatile("sttr %0, [%1]" :: "r"(0x1234UL), "r"(va) : "memory");
    report(what, a64_caught(&f), &f, 0);
}
static void probe_ldxr(const char *what, uint64_t va)
{
    struct a64_fault f;
    uint64_t v = 0;
    a64_expect();
    __asm__ volatile("ldxr %0, [%1]\n clrex" : "+r"(v) : "r"(va) : "memory");
    report(what, a64_caught(&f), &f, v);
}
static void probe_zva(const char *what, uint64_t va)
{
    struct a64_fault f;
    a64_expect();
    __asm__ volatile("dc zva, %0" :: "r"(va) : "memory");
    report(what, a64_caught(&f), &f, 0);
}
static void probe_at(const char *what, uint64_t va, int write)
{
    if(write) __asm__ volatile("at s1e1w, %0\n isb" :: "r"(va) : "memory");
    else __asm__ volatile("at s1e1r, %0\n isb" :: "r"(va) : "memory");
    // (the fault bit and status, or success: the address and the attributes are the walk's)
    uint64_t par = a64_read(par_el1);
    printf("%s: par %lx\n", what, par & 1 ? par & 0x7F : par & 0xFFFFFFFFF001UL);
}
static void probe_fetch(const char *what, uint64_t va)
{
    struct a64_fault f;
    uint64_t v = 0;
    a64_expect();
    __asm__ volatile("mov x0, #0\n blr %1\n mov %0, x0" : "+r"(v) : "r"(va) : "x0", "x30", "memory");
    report(what, a64_caught(&f), &f, v);
}

static uint64_t pan_in_handler(void) { return read_pan(); }

// an exception (a translation fault) taken with PAN `pan` and SCTLR_EL1.SPAN
// `span`: PAN in the handler, SPSR_EL1's PAN, and PAN after the return
static void probe_exception(int pan, int span)
{
    uint64_t sctlr = a64_read(sctlr_el1);
    a64_write(sctlr_el1, span ? sctlr | 1UL << 23 : sctlr & ~(1UL << 23));
    __asm__ volatile("isb" ::: "memory");
    set_pan(pan);
    struct a64_fault f;
    uint64_t v = 0;
    a64_fault_probe = pan_in_handler;
    a64_expect();
    __asm__ volatile("ldr %0, [%1]" : "+r"(v) : "r"(UNMAPPED_VA) : "memory");
    int taken = a64_caught(&f);
    a64_fault_probe = 0;
    uint64_t after = read_pan();
    set_pan(0);
    a64_write(sctlr_el1, sctlr);
    __asm__ volatile("isb" ::: "memory");
    printf("exception with pan %d span %d: taken %d, pan in the handler %lx, spsr pan %lx, pan after %lx\n",
        pan, span, taken, f.probe, f.spsr & 1UL << 22, after);
}

// ERET to EL1h with SPSR_EL1.PAN `pan`
static void probe_eret(int pan)
{
    uint64_t spsr = 5 | (a64_read(daif) & 0xFUL << 6) | (pan ? 1UL << 22 : 0);
    __asm__ volatile(
        "adr x9, 1f\n"
        "msr elr_el1, x9\n"
        "msr spsr_el1, %0\n"
        "eret\n"
        "1:\n" :: "r"(spsr) : "x9", "memory");
    uint64_t after = read_pan();
    set_pan(0);
    printf("eret with spsr pan %d: pan %lx\n", pan, after);
}

int main(int argc, char **argv)
{
    uint64_t mmfr1 = 0;
    __asm__ volatile("mrs %0, S3_0_C0_C7_1" : "=r"(mmfr1));
    printf("FEAT_PAN: %s\n", (mmfr1 >> 20 & 15) ? "yes" : "no");
    if(!(mmfr1 >> 20 & 15)) return 1;

    for(int k = 0; k < 4; k++) for(int i = 0; i < 512; i++) data[k][i] = 0x1111111111111111UL * (k + 1) + i;
    for(int i = 0; i < 1024; i++) code[i] = 0xD65F03C0; // RET
    code[0] = 0xD2800540; // MOV X0, #42
    code[1] = 0xD65F03C0;
    __asm__ volatile("dc cvau, %0\n dsb ish\n ic ivau, %0\n dsb ish\n isb" :: "r"(code) : "memory");
    l1[0] = 0x00000000UL | 1 | 1 << 2 | 1 << 10;
    l1[1] = 0x40000000UL | 1 | 3 << 8 | 1 << 10;
    l1[2] = 0x80000000UL | 1 | 3 << 8 | 1 << 10;
    l1[64] = (uint64_t)l2 | 3;
    l2[0] = (uint64_t)l3 | 3;
    // (Normal, inner shareable, AF; EL0 never executes them)
    const uint64_t attr = 3 | 3 << 8 | 1 << 10 | 1UL << 54;
    l3[EL1_RW] = (uint64_t)data[0] | attr | 0UL << 6;
    l3[BOTH_RW] = (uint64_t)data[1] | attr | 1UL << 6;
    l3[EL1_RO] = (uint64_t)data[2] | attr | 2UL << 6;
    l3[BOTH_RO] = (uint64_t)data[3] | attr | 3UL << 6;
    l3[CODE] = (uint64_t)code | attr | 3UL << 6;
    __asm__ volatile("dsb ish" ::: "memory");
    a64_write(mair_el1, 0x00FF);
    // (T0SZ 25, write-back inner shareable walks, 4 KiB, no TTBR1 walks, 40-bit PA, 16-bit ASIDs)
    a64_write(tcr_el1, 25 | 1 << 8 | 1 << 10 | 3 << 12 | 1 << 23 | 2UL << 32 | 1UL << 36);
    a64_write(ttbr0_el1, (uint64_t)l1);
    __asm__ volatile("dsb ish\n tlbi vmalle1\n dsb ish\n isb" ::: "memory");
    // (MMU, caches, SPAN set: exceptions keep PAN until probe_exception says otherwise)
    a64_write(sctlr_el1, a64_read(sctlr_el1) | 1 | 1 << 2 | 1 << 12 | 1UL << 23);
    __asm__ volatile("isb" ::: "memory");

    static const char *const names[] = { "el1 rw", "both rw", "el1 ro", "both ro" };
    char what[64];
    for(int pan = 0; pan < 2; pan++)
    {
        set_pan(pan);
        printf("pan %d: PAN reads %lx\n", pan, read_pan());
        for(int k = 0; k < 4; k++)
        {
            snprintf(what, sizeof what, "pan %d load %s", pan, names[k]); probe_load(what, PAGE_VA(k) + 8);
            snprintf(what, sizeof what, "pan %d store %s", pan, names[k]); probe_store(what, k);
            snprintf(what, sizeof what, "pan %d ldtr %s", pan, names[k]); probe_ldtr(what, PAGE_VA(k) + 24);
            snprintf(what, sizeof what, "pan %d sttr %s", pan, names[k]); probe_sttr(what, PAGE_VA(k) + 32);
            snprintf(what, sizeof what, "pan %d ldxr %s", pan, names[k]); probe_ldxr(what, PAGE_VA(k) + 40);
            snprintf(what, sizeof what, "pan %d dc zva %s", pan, names[k]); probe_zva(what, PAGE_VA(k) + 0x800);
            snprintf(what, sizeof what, "pan %d at s1e1r %s", pan, names[k]); probe_at(what, PAGE_VA(k), 0);
            snprintf(what, sizeof what, "pan %d at s1e1w %s", pan, names[k]); probe_at(what, PAGE_VA(k), 1);
        }
        snprintf(what, sizeof what, "pan %d fetch from code EL0 may read", pan); probe_fetch(what, PAGE_VA(CODE));
    }
    set_pan(0);

    // MSR PAN with a register, SPSR_EL1's PAN bit
    __asm__ volatile("msr S3_0_C4_C2_3, %0" :: "r"(1UL << 22) : "memory");
    printf("msr pan (register) 1<<22: %lx\n", read_pan());
    __asm__ volatile("msr S3_0_C4_C2_3, %0" :: "r"(0UL) : "memory");
    printf("msr pan (register) 0: %lx\n", read_pan());
    a64_write(spsr_el1, 1UL << 22 | 5);
    printf("spsr_el1 keeps pan: %lx\n", a64_read(spsr_el1) & 1UL << 22);

    for(int pan = 0; pan < 2; pan++) for(int span = 0; span < 2; span++) probe_exception(pan, span);
    probe_eret(1);
    probe_eret(0);
    return 0;
}
