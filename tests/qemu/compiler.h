/* compiler.h: macros to abstract away compiler specifics
 *
 * This work is licensed under the terms of the GNU GPL, version 2 or later.
 * See the COPYING file in the top-level directory.
 */

#ifndef COMPILER_H
#define COMPILER_H

#if defined __clang_analyzer__ || defined __COVERITY__
#define QEMU_STATIC_ANALYSIS 1
#endif

/*----------------------------------------------------------------------------
| The macro QEMU_GNUC_PREREQ tests for minimum version of the GNU C compiler.
| The code is a copy of SOFTFLOAT_GNUC_PREREQ, see softfloat-macros.h.
*----------------------------------------------------------------------------*/
#if defined(__GNUC__) && defined(__GNUC_MINOR__)
# define QEMU_GNUC_PREREQ(maj, min) \
         ((__GNUC__ << 16) + __GNUC_MINOR__ >= ((maj) << 16) + (min))
#else
# define QEMU_GNUC_PREREQ(maj, min) 0
#endif

#define QEMU_NORETURN __attribute__ ((__noreturn__))

#define QEMU_WARN_UNUSED_RESULT __attribute__((warn_unused_result))

#define QEMU_SENTINEL __attribute__((sentinel))

#if QEMU_GNUC_PREREQ(4, 3)
#define QEMU_ARTIFICIAL __attribute__((always_inline, artificial))
#else
#define QEMU_ARTIFICIAL
#endif

#if defined(_WIN32)
# define QEMU_PACKED __attribute__((gcc_struct, packed))
#else
# define QEMU_PACKED __attribute__((packed))
#endif

#define QEMU_ALIGNED(X) __attribute__((aligned(X)))

#ifndef glue
#define xglue(x, y) x ## y
#define glue(x, y) xglue(x, y)
#define stringify(s)	tostring(s)
#define tostring(s)	#s
#endif

#ifndef likely
#if __GNUC__ < 3
#define __builtin_expect(x, n) (x)
#endif

#define likely(x)   __builtin_expect(!!(x), 1)
#define unlikely(x)   __builtin_expect(!!(x), 0)
#endif

#ifndef container_of
#define container_of(ptr, type, member) ({                      \
        const typeof(((type *) 0)->member) *__mptr = (ptr);     \
        (type *) ((char *) __mptr - offsetof(type, member));})
#endif

/* Convert from a base type to a parent type, with compile time checking.  */
#ifdef __GNUC__
#define DO_UPCAST(type, field, dev) ( __extension__ ( { \
    char __attribute__((unused)) offset_must_be_zero[ \
        -offsetof(type, field)]; \
    container_of(dev, type, field);}))
#else
#define DO_UPCAST(type, field, dev) container_of(dev, type, field)
#endif

#define typeof_field(type, field) typeof(((type *)0)->field)
#define type_check(t1,t2) ((t1*)0 - (t2*)0)

#define QEMU_BUILD_BUG_ON_STRUCT(x) \
    struct { \
        int:(x) ? -1 : 1; \
    }

#if defined(CONFIG_STATIC_ASSERT)
#define QEMU_BUILD_BUG_ON(x) _Static_assert(!(x), "not expecting: " #x)
#elif defined(__COUNTER__)
#define QEMU_BUILD_BUG_ON(x) typedef QEMU_BUILD_BUG_ON_STRUCT(x) \
    glue(qemu_build_bug_on__, __COUNTER__) __attribute__((unused))
#else
#define QEMU_BUILD_BUG_ON(x)
#endif

#define QEMU_BUILD_BUG_ON_ZERO(x) (sizeof(QEMU_BUILD_BUG_ON_STRUCT(x)) - \
                                   sizeof(QEMU_BUILD_BUG_ON_STRUCT(x)))

#if defined __GNUC__
# if !QEMU_GNUC_PREREQ(4, 4)
   /* gcc versions before 4.4.x don't support gnu_printf, so use printf. */
#  define GCC_FMT_ATTR(n, m) __attribute__((format(printf, n, m)))
# else
   /* Use gnu_printf when supported (qemu uses standard format strings). */
#  define GCC_FMT_ATTR(n, m) __attribute__((format(gnu_printf, n, m)))
#  if defined(_WIN32)
    /* Map __printf__ to __gnu_printf__ because we want standard format strings
     * even when MinGW or GLib include files use __printf__. */
#   define __printf__ __gnu_printf__
#  endif
# endif
#else
#define GCC_FMT_ATTR(n, m)
#endif

#endif /* COMPILER_H */
