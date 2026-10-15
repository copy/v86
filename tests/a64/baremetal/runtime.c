// The bare-metal guests' C runtime: output into the result block's text,
// printf with glibc's formatting (the QEMU .ref files come from glibc), a
// bump allocator and the startup and finish of a run (include/a64.h).

#include <a64.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern char _end[];
static char *heap;
static volatile unsigned text_length;
void (*volatile a64_core_main)(unsigned core);

static void finish(uint32_t status)
{
    a64_result->length = text_length;
    a64_result->status = status;
    __asm__ volatile("dsb sy" ::: "memory");
    a64_result->magic = A64_DONE;
    __asm__ volatile("dsb sy" ::: "memory");
    for(;;) __asm__ volatile("wfi");
}

void a64_putc(char c)
{
    if(text_length >= A64_TEXT_SIZE) finish(A64_TEXT_OVERFLOW);
    ((volatile char *)A64_TEXT)[text_length++] = c;
}

void a64_fail(const char *why)
{
    printf("A64_FAIL %s\n", why);
    finish(A64_FAILED);
}

#ifdef A64_MMU
// (A64_MMU=1, tests/a64/guest_runner.mjs: the MMU on from the start, an
// identity map of 1 GiB blocks, devices below RAM and normal write-back
// RAM, so that the A64 page tier, which needs it, runs the guest's code)
static uint64_t identity[512] __attribute__((aligned(4096)));
static void mmu_on(void)
{
    if(!identity[1])
    {
        identity[0] = 0x00000000UL | 1 | 1 << 2 | 1 << 10;
        identity[1] = 0x40000000UL | 1 | 0 << 2 | 3 << 8 | 1 << 10;
        identity[2] = 0x80000000UL | 1 | 0 << 2 | 3 << 8 | 1 << 10;
        __asm__ volatile("dsb ish" ::: "memory");
    }
    a64_write(mair_el1, 0x00FF);
    a64_write(tcr_el1, 25 | 1 << 8 | 1 << 10 | 3 << 12 | 1 << 23 | 2UL << 32);
    a64_write(ttbr0_el1, (uint64_t)identity);
    __asm__ volatile("dsb ish\n tlbi vmalle1\n dsb ish\n isb" ::: "memory");
    a64_write(sctlr_el1, a64_read(sctlr_el1) | 1 | 1 << 2 | 1 << 12);
    __asm__ volatile("isb" ::: "memory");
}
#endif

void a64_start(uint64_t dtb)
{
#ifdef A64_MMU
    mmu_on();
#endif
    heap = (char *)(((uintptr_t)_end + 15) & ~(uintptr_t)15);
    a64_result->magic = 0;
    a64_result->status = 0;
    a64_result->length = 0;
    a64_result->cores = 1;
    a64_result->dtb = dtb;
    char *argv[] = { "a64", 0 };
    int status = main(1, argv);
    finish(status ? A64_FAILED : A64_OK);
}

void a64_secondary_start(unsigned core)
{
#ifdef A64_MMU
    mmu_on();
#endif
    __atomic_fetch_add((uint32_t *)&a64_result->cores, 1, __ATOMIC_SEQ_CST);
    if(a64_core_main) a64_core_main(core);
}

void exit(int status) { finish(status ? A64_FAILED : A64_OK); }
void abort(void) { a64_fail("abort"); for(;;); }

// (unexpected exceptions, called from a64_exception in exception.c)
void a64_unexpected(struct a64_frame *frame, uint64_t vector)
{
    a64_result->vector = vector;
    a64_result->esr = a64_read(esr_el1);
    a64_result->far = a64_read(far_el1);
    a64_result->elr = frame->elr;
    a64_result->spsr = frame->spsr;
    printf("A64_EXCEPTION vector=%lu esr=%#lx elr=%#lx far=%#lx\n", (unsigned long)vector,
        (unsigned long)a64_result->esr, (unsigned long)frame->elr, (unsigned long)a64_result->far);
    finish(A64_UNEXPECTED_EXCEPTION);
}

int64_t a64_hvc(uint64_t function, uint64_t a1, uint64_t a2, uint64_t a3)
{
    register uint64_t x0 __asm__("x0") = function, x1 __asm__("x1") = a1, x2 __asm__("x2") = a2, x3 __asm__("x3") = a3;
    __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) :: "memory");
    return x0;
}

int64_t a64_hvc_imm1(uint64_t function)
{
    register uint64_t x0 __asm__("x0") = function;
    __asm__ volatile("hvc #1" : "+r"(x0) :: "x1", "x2", "x3", "memory");
    return x0;
}

extern char a64_secondary[];
int64_t a64_cpu_on(unsigned core)
{
    return a64_hvc(0xC4000003, core, (uint64_t)a64_secondary, core); // PSCI CPU_ON (SMC64)
}

// -------- memory

void *malloc(size_t size)
{
    char *p = heap;
    if((uintptr_t)p + size > A64_HEAP_END) a64_fail("out of heap");
    heap = (char *)(((uintptr_t)p + size + 15) & ~(uintptr_t)15);
    return p;
}

void *calloc(size_t count, size_t size)
{
    void *p = malloc(count * size);
    memset(p, 0, count * size);
    return p;
}

void free(void *pointer) { (void)pointer; }

void *memcpy(void *to, const void *from, size_t n)
{
    char *t = to;
    const char *f = from;
    while(n--) *t++ = *f++;
    return to;
}

void *memset(void *to, int c, size_t n)
{
    char *t = to;
    while(n--) *t++ = c;
    return to;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const unsigned char *x = a, *y = b;
    for(; n; n--, x++, y++) if(*x != *y) return *x - *y;
    return 0;
}

size_t strlen(const char *s)
{
    size_t n = 0;
    while(s[n]) n++;
    return n;
}

int strcmp(const char *a, const char *b)
{
    while(*a && *a == *b) a++, b++;
    return (unsigned char)*a - (unsigned char)*b;
}

// -------- printf

struct sink
{
    char *out;
    size_t size, length;
    int to_text;
};

static void put(struct sink *s, char c)
{
    if(s->to_text) a64_putc(c);
    else if(s->length + 1 < s->size) s->out[s->length] = c;
    s->length++;
}

static void repeat(struct sink *s, char c, int n) { while(n-- > 0) put(s, c); }

enum { LEFT = 1, PLUS = 2, SPACE = 4, ALT = 8, ZERO = 16 };

// (prefix, then zero padding to `zeros`, then the digits, padded to `width`)
static void field(struct sink *s, int flags, int width, const char *prefix, int zeros, const char *digits, int n)
{
    int p = strlen(prefix), total = p + (zeros > n ? zeros : n);
    if(!(flags & LEFT)) repeat(s, ' ', width - total);
    for(int i = 0; i < p; i++) put(s, prefix[i]);
    repeat(s, '0', zeros - n);
    for(int i = 0; i < n; i++) put(s, digits[i]);
    if(flags & LEFT) repeat(s, ' ', width - total);
}

static void integer(struct sink *s, int flags, int width, int precision, char conversion, uint64_t value, int negative)
{
    char digits[24], prefix[4] = "";
    int n = 0, base = conversion == 'o' ? 8 : conversion == 'x' || conversion == 'X' ? 16 : 10;
    const char *alphabet = conversion == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
    char reversed[24];
    while(value) { reversed[n++] = alphabet[value % base]; value /= base; }
    for(int i = 0; i < n; i++) digits[i] = reversed[n - 1 - i];
    if(negative) prefix[0] = '-';
    else if(flags & PLUS && base == 10) prefix[0] = '+';
    else if(flags & SPACE && base == 10) prefix[0] = ' ';
    if(flags & ALT && n && base == 16) { prefix[0] = '0'; prefix[1] = conversion; prefix[2] = 0; }
    if(flags & ALT && base == 8 && (precision <= n)) precision = n + 1;
    int zeros = precision >= 0 ? precision : n ? n : 1;
    if(precision < 0 && flags & ZERO && !(flags & LEFT)) { int z = width - (int)strlen(prefix); if(z > zeros) zeros = z; }
    if(precision == 0 && n == 0) zeros = 0;
    field(s, flags, width, prefix, zeros, digits, n);
}

#ifndef A64_GENERAL_REGS_ONLY
// %a and %A of a double, as glibc: subnormals as 0x0.<digits>p-1022, "nan"
// and "inf" with the sign bit's '-'
static void hexfloat(struct sink *s, int flags, int width, int precision, char conversion, double value)
{
    uint64_t bits;
    memcpy(&bits, &value, 8);
    int upper = conversion == 'A', negative = bits >> 63, exponent = bits >> 52 & 0x7FF;
    uint64_t mantissa = bits & 0xFFFFFFFFFFFFFull;
    char prefix[4] = "", buffer[64];
    if(negative) prefix[0] = '-';
    else if(flags & PLUS) prefix[0] = '+';
    else if(flags & SPACE) prefix[0] = ' ';
    if(exponent == 0x7FF)
    {
        const char *text = mantissa ? (upper ? "NAN" : "nan") : (upper ? "INF" : "inf");
        field(s, flags & ~ZERO, width, prefix, 0, text, 3);
        return;
    }
    int lead = exponent != 0, e = mantissa == 0 && exponent == 0 ? 0 : exponent ? exponent - 1023 : -1022;
    // round to `precision` hex digits (to nearest, ties to even)
    if(precision >= 0 && precision < 13)
    {
        int drop = 4 * (13 - precision);
        uint64_t half = 1ull << (drop - 1), rest = mantissa & ((1ull << drop) - 1);
        mantissa >>= drop;
        if(rest > half || (rest == half && (mantissa & 1))) mantissa++;
        if(mantissa >> (4 * precision)) { mantissa &= (1ull << (4 * precision)) - 1; if(lead) e++; else lead = 1; }
        mantissa <<= drop;
    }
    const char *alphabet = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    int n = 0;
    buffer[n++] = '0' + lead;
    int digits = 13;
    if(precision < 0) while(digits && !(mantissa >> (4 * (13 - digits)) & 0xF)) digits--;
    int shown = precision < 0 ? digits : precision;
    if(shown || flags & ALT) buffer[n++] = '.';
    for(int i = 0; i < shown; i++) buffer[n++] = i < 13 ? alphabet[mantissa >> (4 * (12 - i)) & 0xF] : '0';
    buffer[n++] = upper ? 'P' : 'p';
    buffer[n++] = e < 0 ? '-' : '+';
    unsigned magnitude = e < 0 ? -e : e;
    char exp[8];
    int m = 0;
    do { exp[m++] = '0' + magnitude % 10; magnitude /= 10; } while(magnitude);
    while(m) buffer[n++] = exp[--m];
    int p = strlen(prefix);
    prefix[p++] = '0';
    prefix[p++] = upper ? 'X' : 'x';
    prefix[p] = 0;
    int zeros = flags & ZERO && !(flags & LEFT) ? width - p : 0;
    field(s, flags, width, prefix, zeros, buffer, n);
}

#endif

static void format(struct sink *s, const char *f, va_list args)
{
    for(; *f; f++)
    {
        if(*f != '%') { put(s, *f); continue; }
        int flags = 0, width = 0, precision = -1, length = 0;
        for(;; f++)
        {
            if(f[1] == '-') flags |= LEFT;
            else if(f[1] == '+') flags |= PLUS;
            else if(f[1] == ' ') flags |= SPACE;
            else if(f[1] == '#') flags |= ALT;
            else if(f[1] == '0') flags |= ZERO;
            else break;
        }
        f++;
        if(*f == '*') { width = va_arg(args, int); if(width < 0) { flags |= LEFT; width = -width; } f++; }
        else while(*f >= '0' && *f <= '9') width = width * 10 + *f++ - '0';
        if(*f == '.')
        {
            f++;
            precision = 0;
            if(*f == '*') { precision = va_arg(args, int); f++; }
            else while(*f >= '0' && *f <= '9') precision = precision * 10 + *f++ - '0';
        }
        while(*f == 'h' || *f == 'l' || *f == 'z' || *f == 'j' || *f == 't' || *f == 'L')
        {
            length += *f == 'h' ? -1 : 1;
            f++;
        }
        switch(*f)
        {
            case 'd':
            case 'i':
            {
                int64_t v = length > 0 ? va_arg(args, int64_t) : va_arg(args, int);
                if(length == -1) v = (short)v;
                if(length == -2) v = (signed char)v;
                integer(s, flags, width, precision, 'd', v < 0 ? -(uint64_t)v : (uint64_t)v, v < 0);
                break;
            }
            case 'u':
            case 'x':
            case 'X':
            case 'o':
            {
                uint64_t v = length > 0 ? va_arg(args, uint64_t) : va_arg(args, unsigned);
                if(length == -1) v = (unsigned short)v;
                if(length == -2) v = (unsigned char)v;
                integer(s, flags, width, precision, *f, v, 0);
                break;
            }
            case 'p':
                integer(s, flags | ALT, width, precision, 'x', (uintptr_t)va_arg(args, void *), 0);
                break;
            case 'c':
            {
                char c = va_arg(args, int);
                field(s, flags & ~ZERO, width, "", 0, &c, 1);
                break;
            }
            case 's':
            {
                const char *text = va_arg(args, const char *);
                if(!text) text = "(null)";
                int n = strlen(text);
                if(precision >= 0 && precision < n) n = precision;
                field(s, flags & ~ZERO, width, "", 0, text, n);
                break;
            }
#ifndef A64_GENERAL_REGS_ONLY
            case 'a':
            case 'A':
                hexfloat(s, flags, width, precision, *f, va_arg(args, double));
                break;
#endif
            case '%':
                put(s, '%');
                break;
            default:
                a64_fail("printf: unsupported conversion");
        }
    }
}

int vsnprintf(char *out, size_t size, const char *f, va_list args)
{
    struct sink s = { out, size, 0, 0 };
    format(&s, f, args);
    if(size) out[s.length < size ? s.length : size - 1] = 0;
    return s.length;
}

int vprintf(const char *f, va_list args)
{
    struct sink s = { 0, 0, 0, 1 };
    format(&s, f, args);
    return s.length;
}

int vasprintf(char **out, const char *f, va_list args)
{
    va_list copy;
    va_copy(copy, args);
    int n = vsnprintf(0, 0, f, copy);
    va_end(copy);
    *out = malloc(n + 1);
    return vsnprintf(*out, n + 1, f, args);
}

#define VARIADIC(call) ({ va_list args; va_start(args, f); int n = call; va_end(args); n; })
int printf(const char *f, ...) { return VARIADIC(vprintf(f, args)); }
int sprintf(char *out, const char *f, ...) { return VARIADIC(vsnprintf(out, (size_t)-1 >> 1, f, args)); }
int snprintf(char *out, size_t size, const char *f, ...) { return VARIADIC(vsnprintf(out, size, f, args)); }
int asprintf(char **out, const char *f, ...) { return VARIADIC(vasprintf(out, f, args)); }
int putchar(int c) { a64_putc(c); return c; }
int puts(const char *s) { while(*s) a64_putc(*s++); a64_putc('\n'); return 0; }

#ifndef A64_GENERAL_REGS_ONLY
// -------- math (the instructions themselves)

float fmaf(float a, float b, float c)
{
    float r;
    __asm__ volatile("fmadd %s0, %s1, %s2, %s3" : "=w"(r) : "w"(a), "w"(b), "w"(c));
    return r;
}

double fma(double a, double b, double c)
{
    double r;
    __asm__ volatile("fmadd %d0, %d1, %d2, %d3" : "=w"(r) : "w"(a), "w"(b), "w"(c));
    return r;
}
#endif
