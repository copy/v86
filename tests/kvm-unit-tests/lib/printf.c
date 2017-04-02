#include "libcflat.h"

#define BUFSZ 2000

typedef struct pstream {
    char *buffer;
    int remain;
    int added;
} pstream_t;

typedef struct strprops {
    char pad;
    int npad;
} strprops_t;

static void addchar(pstream_t *p, char c)
{
    if (p->remain) {
	*p->buffer++ = c;
	--p->remain;
    }
    ++p->added;
}

void print_str(pstream_t *p, const char *s, strprops_t props)
{
    const char *s_orig = s;
    int npad = props.npad;

    if (npad > 0) {
	npad -= strlen(s_orig);
	while (npad > 0) {
	    addchar(p, props.pad);
	    --npad;
	}
    }

    while (*s)
	addchar(p, *s++);

    if (npad < 0) {
	props.pad = ' '; /* ignore '0' flag with '-' flag */
	npad += strlen(s_orig);
	while (npad < 0) {
	    addchar(p, props.pad);
	    ++npad;
	}
    }
}

static char digits[16] = "0123456789abcdef";

void print_int(pstream_t *ps, long long n, int base, strprops_t props)
{
    char buf[sizeof(long) * 3 + 2], *p = buf;
    int s = 0, i;

    if (n < 0) {
	n = -n;
	s = 1;
    }

    while (n) {
	*p++ = digits[n % base];
	n /= base;
    }

    if (s)
	*p++ = '-';

    if (p == buf)
	*p++ = '0';

    for (i = 0; i < (p - buf) / 2; ++i) {
	char tmp;

	tmp = buf[i];
	buf[i] = p[-1-i];
	p[-1-i] = tmp;
    }

    *p = 0;

    print_str(ps, buf, props);
}

void print_unsigned(pstream_t *ps, unsigned long long n, int base,
		    strprops_t props)
{
    char buf[sizeof(long) * 3 + 1], *p = buf;
    int i;

    while (n) {
	*p++ = digits[n % base];
	n /= base;
    }

    if (p == buf)
	*p++ = '0';

    for (i = 0; i < (p - buf) / 2; ++i) {
	char tmp;

	tmp = buf[i];
	buf[i] = p[-1-i];
	p[-1-i] = tmp;
    }

    *p = 0;

    print_str(ps, buf, props);
}

static int fmtnum(const char **fmt)
{
    const char *f = *fmt;
    int len = 0, num;

    if (*f == '-')
	++f, ++len;

    while (*f >= '0' && *f <= '9')
	++f, ++len;

    num = atol(*fmt);
    *fmt += len;
    return num;
}

int vsnprintf(char *buf, int size, const char *fmt, va_list va)
{
    pstream_t s;

    s.buffer = buf;
    s.remain = size - 1;
    s.added = 0;
    while (*fmt) {
	char f = *fmt++;
	int nlong = 0;
	strprops_t props;
	memset(&props, 0, sizeof(props));
	props.pad = ' ';

	if (f != '%') {
	    addchar(&s, f);
	    continue;
	}
    morefmt:
	f = *fmt++;
	switch (f) {
	case '%':
	    addchar(&s, '%');
	    break;
	case 'c':
            addchar(&s, va_arg(va, int));
	    break;
	case '\0':
	    --fmt;
	    break;
	case '0':
	    props.pad = '0';
	    ++fmt;
	    /* fall through */
	case '1'...'9':
	case '-':
	    --fmt;
	    props.npad = fmtnum(&fmt);
	    goto morefmt;
	case 'l':
	    ++nlong;
	    goto morefmt;
	case 'd':
	    switch (nlong) {
	    case 0:
		print_int(&s, va_arg(va, int), 10, props);
		break;
	    case 1:
		print_int(&s, va_arg(va, long), 10, props);
		break;
	    default:
		print_int(&s, va_arg(va, long long), 10, props);
		break;
	    }
	    break;
	case 'u':
	    switch (nlong) {
	    case 0:
		print_unsigned(&s, va_arg(va, unsigned), 10, props);
		break;
	    case 1:
		print_unsigned(&s, va_arg(va, unsigned long), 10, props);
		break;
	    default:
		print_unsigned(&s, va_arg(va, unsigned long long), 10, props);
		break;
	    }
	    break;
	case 'x':
	    switch (nlong) {
	    case 0:
		print_unsigned(&s, va_arg(va, unsigned), 16, props);
		break;
	    case 1:
		print_unsigned(&s, va_arg(va, unsigned long), 16, props);
		break;
	    default:
		print_unsigned(&s, va_arg(va, unsigned long long), 16, props);
		break;
	    }
	    break;
	case 'p':
	    print_str(&s, "0x", props);
	    print_unsigned(&s, (unsigned long)va_arg(va, void *), 16, props);
	    break;
	case 's':
	    print_str(&s, va_arg(va, const char *), props);
	    break;
	default:
	    addchar(&s, f);
	    break;
	}
    }
    *s.buffer = 0;
    ++s.added;
    return s.added;
}


int snprintf(char *buf, int size, const char *fmt, ...)
{
    va_list va;
    int r;

    va_start(va, fmt);
    r = vsnprintf(buf, size, fmt, va);
    va_end(va);
    return r;
}

int vprintf(const char *fmt, va_list va)
{
    char buf[BUFSZ];
    int r;

    r = vsnprintf(buf, sizeof(buf), fmt, va);
    puts(buf);
    return r;
}

int printf(const char *fmt, ...)
{
    va_list va;
    char buf[BUFSZ];
    int r;

    va_start(va, fmt);
    r = vsnprintf(buf, sizeof buf, fmt, va);
    va_end(va);
    puts(buf);
    return r;
}
