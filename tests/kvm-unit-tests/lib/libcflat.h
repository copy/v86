/*
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License, version 2, as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 *
 * Copyright IBM Corp. 2008
 *
 * Authors: Hollis Blanchard <hollisb@us.ibm.com>
 */

#ifndef __LIBCFLAT_H
#define __LIBCFLAT_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define __unused __attribute__((__unused__))

#define xstr(s...) xxstr(s)
#define xxstr(s...) #s

#define __ALIGN_MASK(x, mask)	(((x) + (mask)) & ~(mask))
#define __ALIGN(x, a)		__ALIGN_MASK(x, (typeof(x))(a) - 1)
#define ALIGN(x, a)		__ALIGN((x), (a))
#define IS_ALIGNED(x, a)	(((x) & ((typeof(x))(a) - 1)) == 0)

#define SZ_4K			(1 << 12)
#define SZ_64K			(1 << 16)
#define SZ_2M			(1 << 21)
#define SZ_1G			(1 << 30)

#define MIN(a, b)		((a) < (b) ? (a) : (b))
#define MAX(a, b)		((a) > (b) ? (a) : (b))

typedef uint8_t		u8;
typedef int8_t		s8;
typedef uint16_t	u16;
typedef int16_t		s16;
typedef uint32_t	u32;
typedef int32_t		s32;
typedef uint64_t	u64;
typedef int64_t		s64;
typedef unsigned long	ulong;

typedef _Bool		bool;
#define false 0
#define true  1

#if __SIZEOF_LONG__ == 8
#  define __PRI32_PREFIX
#  define __PRI64_PREFIX	"l"
#  define __PRIPTR_PREFIX	"l"
#else
#if defined(__U32_LONG_FMT__)
#  define __PRI32_PREFIX        "l"
#else
#  define __PRI32_PREFIX
#endif
#  define __PRI64_PREFIX	"ll"
#  define __PRIPTR_PREFIX
#endif
#define PRId32  __PRI32_PREFIX	"d"
#define PRIu32  __PRI32_PREFIX	"u"
#define PRIx32  __PRI32_PREFIX	"x"
#define PRId64  __PRI64_PREFIX	"d"
#define PRIu64  __PRI64_PREFIX	"u"
#define PRIx64  __PRI64_PREFIX	"x"
#define PRIxPTR __PRIPTR_PREFIX	"x"

typedef u64			phys_addr_t;
#define INVALID_PHYS_ADDR	(~(phys_addr_t)0)

extern void puts(const char *s);
extern void exit(int code);
extern void abort(void);
extern long atol(const char *ptr);
extern char *getenv(const char *name);

extern int printf(const char *fmt, ...)
					__attribute__((format(printf, 1, 2)));
extern int snprintf(char *buf, int size, const char *fmt, ...)
					__attribute__((format(printf, 3, 4)));
extern int vsnprintf(char *buf, int size, const char *fmt, va_list va)
					__attribute__((format(printf, 3, 0)));
extern int vprintf(const char *fmt, va_list va)
					__attribute__((format(printf, 1, 0)));

extern void report_prefix_push(const char *prefix);
extern void report_prefix_pop(void);
extern void report(const char *msg_fmt, bool pass, ...);
extern void report_xfail(const char *msg_fmt, bool xfail, bool pass, ...);
extern void report_abort(const char *msg_fmt, ...);
extern void report_skip(const char *msg_fmt, ...);
extern void report_info(const char *msg_fmt, ...);
extern int report_summary(void);

extern void dump_stack(void);
extern void dump_frame_stack(const void *instruction, const void *frame);

#define ARRAY_SIZE(_a) (sizeof(_a)/sizeof((_a)[0]))

#define container_of(ptr, type, member) ({				\
	const typeof( ((type *)0)->member ) *__mptr = (ptr);		\
	(type *)( (char *)__mptr - offsetof(type,member) );})

#define assert(cond)							\
do {									\
	if (!(cond)) {							\
		printf("%s:%d: assert failed: %s\n",			\
		       __FILE__, __LINE__, #cond);			\
		dump_stack();						\
		abort();						\
	}								\
} while (0)

static inline bool is_power_of_2(unsigned long n)
{
	return n && !(n & (n - 1));
}

#endif
