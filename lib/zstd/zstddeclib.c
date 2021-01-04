#define malloc v86_malloc
#define free v86_free
#include <stddef.h>
void *calloc(size_t nmemb, size_t size);
void *memset(void *s, int c, size_t n);
void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *malloc(size_t size);
void free(void *ptr);
/**
 * \file zstddeclib.c
 * Single-file Zstandard decompressor.
 *
 * Generate using:
 * \code
 *	combine.sh -r ../../lib -o zstddeclib.c zstddeclib-in.c
 * \endcode
 */
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */
/*
 * Settings to bake for the standalone decompressor.
 *
 * Note: It's important that none of these affects 'zstd.h' (only the
 * implementation files we're amalgamating).
 *
 * Note: MEM_MODULE stops xxhash redefining BYTE, U16, etc., which are also
 * defined in mem.h (breaking C99 compatibility).
 *
 * Note: the undefs for xxHash allow Zstd's implementation to coinside with with
 * standalone xxHash usage (with global defines).
 */
#define DEBUGLEVEL 0
#define MEM_MODULE
#undef  XXH_NAMESPACE
#define XXH_NAMESPACE ZSTD_
#undef  XXH_PRIVATE_API
#define XXH_PRIVATE_API
#undef  XXH_INLINE_ALL
#define XXH_INLINE_ALL
#define ZSTD_LEGACY_SUPPORT 0
#define ZSTD_LIB_COMPRESSION 0
#define ZSTD_LIB_DEPRECATED 0
#define ZSTD_NOBENCH
#define ZSTD_STRIP_ERROR_STRINGS

/**** start inlining common/debug.c ****/
/* ******************************************************************
 * debug
 * Part of FSE library
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 * You can contact the author at :
 * - Source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */


/*
 * This module only hosts one global variable
 * which can be used to dynamically influence the verbosity of traces,
 * such as DEBUGLOG and RAWLOG
 */

/**** start inlining debug.h ****/
/* ******************************************************************
 * debug
 * Part of FSE library
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 * You can contact the author at :
 * - Source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */


/*
 * The purpose of this header is to enable debug functions.
 * They regroup assert(), DEBUGLOG() and RAWLOG() for run-time,
 * and DEBUG_STATIC_ASSERT() for compile-time.
 *
 * By default, DEBUGLEVEL==0, which means run-time debug is disabled.
 *
 * Level 1 enables assert() only.
 * Starting level 2, traces can be generated and pushed to stderr.
 * The higher the level, the more verbose the traces.
 *
 * It's possible to dynamically adjust level using variable g_debug_level,
 * which is only declared if DEBUGLEVEL>=2,
 * and is a global variable, not multi-thread protected (use with care)
 */

#ifndef DEBUG_H_12987983217
#define DEBUG_H_12987983217

#if defined (__cplusplus)
extern "C" {
#endif


/* static assert is triggered at compile time, leaving no runtime artefact.
 * static assert only works with compile-time constants.
 * Also, this variant can only be used inside a function. */
#define DEBUG_STATIC_ASSERT(c) (void)sizeof(char[(c) ? 1 : -1])


/* DEBUGLEVEL is expected to be defined externally,
 * typically through compiler command line.
 * Value must be a number. */
#ifndef DEBUGLEVEL
#  define DEBUGLEVEL 0
#endif


/* DEBUGFILE can be defined externally,
 * typically through compiler command line.
 * note : currently useless.
 * Value must be stderr or stdout */
#ifndef DEBUGFILE
#  define DEBUGFILE stderr
#endif


/* recommended values for DEBUGLEVEL :
 * 0 : release mode, no debug, all run-time checks disabled
 * 1 : enables assert() only, no display
 * 2 : reserved, for currently active debug path
 * 3 : events once per object lifetime (CCtx, CDict, etc.)
 * 4 : events once per frame
 * 5 : events once per block
 * 6 : events once per sequence (verbose)
 * 7+: events at every position (*very* verbose)
 *
 * It's generally inconvenient to output traces > 5.
 * In which case, it's possible to selectively trigger high verbosity levels
 * by modifying g_debug_level.
 */

#if (DEBUGLEVEL>=1)
#  include <assert.h>
#else
#  ifndef assert   /* assert may be already defined, due to prior #include <assert.h> */
#    define assert(condition) ((void)0)   /* disable assert (default) */
#  endif
#endif

#if (DEBUGLEVEL>=2)
#  include <stdio.h>
extern int g_debuglevel; /* the variable is only declared,
                            it actually lives in debug.c,
                            and is shared by the whole process.
                            It's not thread-safe.
                            It's useful when enabling very verbose levels
                            on selective conditions (such as position in src) */

#  define RAWLOG(l, ...) {                                      \
                if (l<=g_debuglevel) {                          \
                    fprintf(stderr, __VA_ARGS__);               \
            }   }
#  define DEBUGLOG(l, ...) {                                    \
                if (l<=g_debuglevel) {                          \
                    fprintf(stderr, __FILE__ ": " __VA_ARGS__); \
                    fprintf(stderr, " \n");                     \
            }   }
#else
#  define RAWLOG(l, ...)      {}    /* disabled */
#  define DEBUGLOG(l, ...)    {}    /* disabled */
#endif


#if defined (__cplusplus)
}
#endif

#endif /* DEBUG_H_12987983217 */
/**** ended inlining debug.h ****/

int g_debuglevel = DEBUGLEVEL;
/**** ended inlining common/debug.c ****/
/**** start inlining common/entropy_common.c ****/
/* ******************************************************************
 * Common functions of New Generation Entropy library
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 *
 *  You can contact the author at :
 *  - FSE+HUF source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *  - Public forum : https://groups.google.com/forum/#!forum/lz4c
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */

/* *************************************
*  Dependencies
***************************************/
/**** start inlining mem.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef MEM_H_MODULE
#define MEM_H_MODULE

#if defined (__cplusplus)
extern "C" {
#endif

/*-****************************************
*  Dependencies
******************************************/
#include <stddef.h>     /* size_t, ptrdiff_t */


/*-****************************************
*  Compiler specifics
******************************************/
#if defined(_MSC_VER)   /* Visual Studio */
#   include <intrin.h>  /* _byteswap_* */
#endif
#if defined(__GNUC__)
#  define MEM_STATIC static __inline __attribute__((unused))
#elif defined (__cplusplus) || (defined (__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) /* C99 */)
#  define MEM_STATIC static inline
#elif defined(_MSC_VER)
#  define MEM_STATIC static __inline
#else
#  define MEM_STATIC static  /* this version may generate warnings for unused static functions; disable the relevant warning */
#endif

#ifndef __has_builtin
#  define __has_builtin(x) 0  /* compat. with non-clang compilers */
#endif

/* code only tested on 32 and 64 bits systems */
#define MEM_STATIC_ASSERT(c)   { enum { MEM_static_assert = 1/(int)(!!(c)) }; }
MEM_STATIC void MEM_check(void) { MEM_STATIC_ASSERT((sizeof(size_t)==4) || (sizeof(size_t)==8)); }

/* detects whether we are being compiled under msan */
#if defined (__has_feature)
#  if __has_feature(memory_sanitizer)
#    define MEMORY_SANITIZER 1
#  endif
#endif

#if defined (MEMORY_SANITIZER)
/* Not all platforms that support msan provide sanitizers/msan_interface.h.
 * We therefore declare the functions we need ourselves, rather than trying to
 * include the header file... */

#include <stdint.h> /* intptr_t */

/* Make memory region fully initialized (without changing its contents). */
void __msan_unpoison(const volatile void *a, size_t size);

/* Make memory region fully uninitialized (without changing its contents).
   This is a legacy interface that does not update origin information. Use
   __msan_allocated_memory() instead. */
void __msan_poison(const volatile void *a, size_t size);

/* Returns the offset of the first (at least partially) poisoned byte in the
   memory range, or -1 if the whole range is good. */
intptr_t __msan_test_shadow(const volatile void *x, size_t size);
#endif

/* detects whether we are being compiled under asan */
#if defined (__has_feature)
#  if __has_feature(address_sanitizer)
#    define ADDRESS_SANITIZER 1
#  endif
#elif defined(__SANITIZE_ADDRESS__)
#  define ADDRESS_SANITIZER 1
#endif

#if defined (ADDRESS_SANITIZER)
/* Not all platforms that support asan provide sanitizers/asan_interface.h.
 * We therefore declare the functions we need ourselves, rather than trying to
 * include the header file... */

/**
 * Marks a memory region (<c>[addr, addr+size)</c>) as unaddressable.
 *
 * This memory must be previously allocated by your program. Instrumented
 * code is forbidden from accessing addresses in this region until it is
 * unpoisoned. This function is not guaranteed to poison the entire region -
 * it could poison only a subregion of <c>[addr, addr+size)</c> due to ASan
 * alignment restrictions.
 *
 * \note This function is not thread-safe because no two threads can poison or
 * unpoison memory in the same memory region simultaneously.
 *
 * \param addr Start of memory region.
 * \param size Size of memory region. */
void __asan_poison_memory_region(void const volatile *addr, size_t size);

/**
 * Marks a memory region (<c>[addr, addr+size)</c>) as addressable.
 *
 * This memory must be previously allocated by your program. Accessing
 * addresses in this region is allowed until this region is poisoned again.
 * This function could unpoison a super-region of <c>[addr, addr+size)</c> due
 * to ASan alignment restrictions.
 *
 * \note This function is not thread-safe because no two threads can
 * poison or unpoison memory in the same memory region simultaneously.
 *
 * \param addr Start of memory region.
 * \param size Size of memory region. */
void __asan_unpoison_memory_region(void const volatile *addr, size_t size);
#endif


/*-**************************************************************
*  Basic Types
*****************************************************************/
#if  !defined (__VMS) && (defined (__cplusplus) || (defined (__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) /* C99 */) )
# include <stdint.h>
  typedef   uint8_t BYTE;
  typedef  uint16_t U16;
  typedef   int16_t S16;
  typedef  uint32_t U32;
  typedef   int32_t S32;
  typedef  uint64_t U64;
  typedef   int64_t S64;
#else
# include <limits.h>
#if CHAR_BIT != 8
#  error "this implementation requires char to be exactly 8-bit type"
#endif
  typedef unsigned char      BYTE;
#if USHRT_MAX != 65535
#  error "this implementation requires short to be exactly 16-bit type"
#endif
  typedef unsigned short      U16;
  typedef   signed short      S16;
#if UINT_MAX != 4294967295
#  error "this implementation requires int to be exactly 32-bit type"
#endif
  typedef unsigned int        U32;
  typedef   signed int        S32;
/* note : there are no limits defined for long long type in C90.
 * limits exist in C99, however, in such case, <stdint.h> is preferred */
  typedef unsigned long long  U64;
  typedef   signed long long  S64;
#endif


/*-**************************************************************
*  Memory I/O
*****************************************************************/
/* MEM_FORCE_MEMORY_ACCESS :
 * By default, access to unaligned memory is controlled by `memcpy()`, which is safe and portable.
 * Unfortunately, on some target/compiler combinations, the generated assembly is sub-optimal.
 * The below switch allow to select different access method for improved performance.
 * Method 0 (default) : use `memcpy()`. Safe and portable.
 * Method 1 : `__packed` statement. It depends on compiler extension (i.e., not portable).
 *            This method is safe if your compiler supports it, and *generally* as fast or faster than `memcpy`.
 * Method 2 : direct access. This method is portable but violate C standard.
 *            It can generate buggy code on targets depending on alignment.
 *            In some circumstances, it's the only known way to get the most performance (i.e. GCC + ARMv6)
 * See http://fastcompression.blogspot.fr/2015/08/accessing-unaligned-memory.html for details.
 * Prefer these methods in priority order (0 > 1 > 2)
 */
#ifndef MEM_FORCE_MEMORY_ACCESS   /* can be defined externally, on command line for example */
#  if defined(__GNUC__) && ( defined(__ARM_ARCH_6__) || defined(__ARM_ARCH_6J__) || defined(__ARM_ARCH_6K__) || defined(__ARM_ARCH_6Z__) || defined(__ARM_ARCH_6ZK__) || defined(__ARM_ARCH_6T2__) )
#    define MEM_FORCE_MEMORY_ACCESS 2
#  elif defined(__INTEL_COMPILER) || defined(__GNUC__) || defined(__ICCARM__)
#    define MEM_FORCE_MEMORY_ACCESS 1
#  endif
#endif

MEM_STATIC unsigned MEM_32bits(void) { return sizeof(size_t)==4; }
MEM_STATIC unsigned MEM_64bits(void) { return sizeof(size_t)==8; }

MEM_STATIC unsigned MEM_isLittleEndian(void)
{
    const union { U32 u; BYTE c[4]; } one = { 1 };   /* don't use static : performance detrimental  */
    return one.c[0];
}

#if defined(MEM_FORCE_MEMORY_ACCESS) && (MEM_FORCE_MEMORY_ACCESS==2)

/* violates C standard, by lying on structure alignment.
Only use if no other choice to achieve best performance on target platform */
MEM_STATIC U16 MEM_read16(const void* memPtr) { return *(const U16*) memPtr; }
MEM_STATIC U32 MEM_read32(const void* memPtr) { return *(const U32*) memPtr; }
MEM_STATIC U64 MEM_read64(const void* memPtr) { return *(const U64*) memPtr; }
MEM_STATIC size_t MEM_readST(const void* memPtr) { return *(const size_t*) memPtr; }

MEM_STATIC void MEM_write16(void* memPtr, U16 value) { *(U16*)memPtr = value; }
MEM_STATIC void MEM_write32(void* memPtr, U32 value) { *(U32*)memPtr = value; }
MEM_STATIC void MEM_write64(void* memPtr, U64 value) { *(U64*)memPtr = value; }

#elif defined(MEM_FORCE_MEMORY_ACCESS) && (MEM_FORCE_MEMORY_ACCESS==1)

/* __pack instructions are safer, but compiler specific, hence potentially problematic for some compilers */
/* currently only defined for gcc and icc */
#if defined(_MSC_VER) || (defined(__INTEL_COMPILER) && defined(WIN32))
    __pragma( pack(push, 1) )
    typedef struct { U16 v; } unalign16;
    typedef struct { U32 v; } unalign32;
    typedef struct { U64 v; } unalign64;
    typedef struct { size_t v; } unalignArch;
    __pragma( pack(pop) )
#else
    typedef struct { U16 v; } __attribute__((packed)) unalign16;
    typedef struct { U32 v; } __attribute__((packed)) unalign32;
    typedef struct { U64 v; } __attribute__((packed)) unalign64;
    typedef struct { size_t v; } __attribute__((packed)) unalignArch;
#endif

MEM_STATIC U16 MEM_read16(const void* ptr) { return ((const unalign16*)ptr)->v; }
MEM_STATIC U32 MEM_read32(const void* ptr) { return ((const unalign32*)ptr)->v; }
MEM_STATIC U64 MEM_read64(const void* ptr) { return ((const unalign64*)ptr)->v; }
MEM_STATIC size_t MEM_readST(const void* ptr) { return ((const unalignArch*)ptr)->v; }

MEM_STATIC void MEM_write16(void* memPtr, U16 value) { ((unalign16*)memPtr)->v = value; }
MEM_STATIC void MEM_write32(void* memPtr, U32 value) { ((unalign32*)memPtr)->v = value; }
MEM_STATIC void MEM_write64(void* memPtr, U64 value) { ((unalign64*)memPtr)->v = value; }

#else

/* default method, safe and standard.
   can sometimes prove slower */

MEM_STATIC U16 MEM_read16(const void* memPtr)
{
    U16 val; memcpy(&val, memPtr, sizeof(val)); return val;
}

MEM_STATIC U32 MEM_read32(const void* memPtr)
{
    U32 val; memcpy(&val, memPtr, sizeof(val)); return val;
}

MEM_STATIC U64 MEM_read64(const void* memPtr)
{
    U64 val; memcpy(&val, memPtr, sizeof(val)); return val;
}

MEM_STATIC size_t MEM_readST(const void* memPtr)
{
    size_t val; memcpy(&val, memPtr, sizeof(val)); return val;
}

MEM_STATIC void MEM_write16(void* memPtr, U16 value)
{
    memcpy(memPtr, &value, sizeof(value));
}

MEM_STATIC void MEM_write32(void* memPtr, U32 value)
{
    memcpy(memPtr, &value, sizeof(value));
}

MEM_STATIC void MEM_write64(void* memPtr, U64 value)
{
    memcpy(memPtr, &value, sizeof(value));
}

#endif /* MEM_FORCE_MEMORY_ACCESS */

MEM_STATIC U32 MEM_swap32(U32 in)
{
#if defined(_MSC_VER)     /* Visual Studio */
    return _byteswap_ulong(in);
#elif (defined (__GNUC__) && (__GNUC__ * 100 + __GNUC_MINOR__ >= 403)) \
  || (defined(__clang__) && __has_builtin(__builtin_bswap32))
    return __builtin_bswap32(in);
#else
    return  ((in << 24) & 0xff000000 ) |
            ((in <<  8) & 0x00ff0000 ) |
            ((in >>  8) & 0x0000ff00 ) |
            ((in >> 24) & 0x000000ff );
#endif
}

MEM_STATIC U64 MEM_swap64(U64 in)
{
#if defined(_MSC_VER)     /* Visual Studio */
    return _byteswap_uint64(in);
#elif (defined (__GNUC__) && (__GNUC__ * 100 + __GNUC_MINOR__ >= 403)) \
  || (defined(__clang__) && __has_builtin(__builtin_bswap64))
    return __builtin_bswap64(in);
#else
    return  ((in << 56) & 0xff00000000000000ULL) |
            ((in << 40) & 0x00ff000000000000ULL) |
            ((in << 24) & 0x0000ff0000000000ULL) |
            ((in << 8)  & 0x000000ff00000000ULL) |
            ((in >> 8)  & 0x00000000ff000000ULL) |
            ((in >> 24) & 0x0000000000ff0000ULL) |
            ((in >> 40) & 0x000000000000ff00ULL) |
            ((in >> 56) & 0x00000000000000ffULL);
#endif
}

MEM_STATIC size_t MEM_swapST(size_t in)
{
    if (MEM_32bits())
        return (size_t)MEM_swap32((U32)in);
    else
        return (size_t)MEM_swap64((U64)in);
}

/*=== Little endian r/w ===*/

MEM_STATIC U16 MEM_readLE16(const void* memPtr)
{
    if (MEM_isLittleEndian())
        return MEM_read16(memPtr);
    else {
        const BYTE* p = (const BYTE*)memPtr;
        return (U16)(p[0] + (p[1]<<8));
    }
}

MEM_STATIC void MEM_writeLE16(void* memPtr, U16 val)
{
    if (MEM_isLittleEndian()) {
        MEM_write16(memPtr, val);
    } else {
        BYTE* p = (BYTE*)memPtr;
        p[0] = (BYTE)val;
        p[1] = (BYTE)(val>>8);
    }
}

MEM_STATIC U32 MEM_readLE24(const void* memPtr)
{
    return MEM_readLE16(memPtr) + (((const BYTE*)memPtr)[2] << 16);
}

MEM_STATIC void MEM_writeLE24(void* memPtr, U32 val)
{
    MEM_writeLE16(memPtr, (U16)val);
    ((BYTE*)memPtr)[2] = (BYTE)(val>>16);
}

MEM_STATIC U32 MEM_readLE32(const void* memPtr)
{
    if (MEM_isLittleEndian())
        return MEM_read32(memPtr);
    else
        return MEM_swap32(MEM_read32(memPtr));
}

MEM_STATIC void MEM_writeLE32(void* memPtr, U32 val32)
{
    if (MEM_isLittleEndian())
        MEM_write32(memPtr, val32);
    else
        MEM_write32(memPtr, MEM_swap32(val32));
}

MEM_STATIC U64 MEM_readLE64(const void* memPtr)
{
    if (MEM_isLittleEndian())
        return MEM_read64(memPtr);
    else
        return MEM_swap64(MEM_read64(memPtr));
}

MEM_STATIC void MEM_writeLE64(void* memPtr, U64 val64)
{
    if (MEM_isLittleEndian())
        MEM_write64(memPtr, val64);
    else
        MEM_write64(memPtr, MEM_swap64(val64));
}

MEM_STATIC size_t MEM_readLEST(const void* memPtr)
{
    if (MEM_32bits())
        return (size_t)MEM_readLE32(memPtr);
    else
        return (size_t)MEM_readLE64(memPtr);
}

MEM_STATIC void MEM_writeLEST(void* memPtr, size_t val)
{
    if (MEM_32bits())
        MEM_writeLE32(memPtr, (U32)val);
    else
        MEM_writeLE64(memPtr, (U64)val);
}

/*=== Big endian r/w ===*/

MEM_STATIC U32 MEM_readBE32(const void* memPtr)
{
    if (MEM_isLittleEndian())
        return MEM_swap32(MEM_read32(memPtr));
    else
        return MEM_read32(memPtr);
}

MEM_STATIC void MEM_writeBE32(void* memPtr, U32 val32)
{
    if (MEM_isLittleEndian())
        MEM_write32(memPtr, MEM_swap32(val32));
    else
        MEM_write32(memPtr, val32);
}

MEM_STATIC U64 MEM_readBE64(const void* memPtr)
{
    if (MEM_isLittleEndian())
        return MEM_swap64(MEM_read64(memPtr));
    else
        return MEM_read64(memPtr);
}

MEM_STATIC void MEM_writeBE64(void* memPtr, U64 val64)
{
    if (MEM_isLittleEndian())
        MEM_write64(memPtr, MEM_swap64(val64));
    else
        MEM_write64(memPtr, val64);
}

MEM_STATIC size_t MEM_readBEST(const void* memPtr)
{
    if (MEM_32bits())
        return (size_t)MEM_readBE32(memPtr);
    else
        return (size_t)MEM_readBE64(memPtr);
}

MEM_STATIC void MEM_writeBEST(void* memPtr, size_t val)
{
    if (MEM_32bits())
        MEM_writeBE32(memPtr, (U32)val);
    else
        MEM_writeBE64(memPtr, (U64)val);
}


#if defined (__cplusplus)
}
#endif

#endif /* MEM_H_MODULE */
/**** ended inlining mem.h ****/
/**** start inlining error_private.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

/* Note : this module is expected to remain private, do not expose it */

#ifndef ERROR_H_MODULE
#define ERROR_H_MODULE

#if defined (__cplusplus)
extern "C" {
#endif


/* ****************************************
*  Dependencies
******************************************/
#include <stddef.h>        /* size_t */
/**** start inlining zstd_errors.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_ERRORS_H_398273423
#define ZSTD_ERRORS_H_398273423

#if defined (__cplusplus)
extern "C" {
#endif

/*===== dependency =====*/
#include <stddef.h>   /* size_t */


/* =====   ZSTDERRORLIB_API : control library symbols visibility   ===== */
#ifndef ZSTDERRORLIB_VISIBILITY
#  if defined(__GNUC__) && (__GNUC__ >= 4)
#    define ZSTDERRORLIB_VISIBILITY __attribute__ ((visibility ("default")))
#  else
#    define ZSTDERRORLIB_VISIBILITY
#  endif
#endif
#if defined(ZSTD_DLL_EXPORT) && (ZSTD_DLL_EXPORT==1)
#  define ZSTDERRORLIB_API __declspec(dllexport) ZSTDERRORLIB_VISIBILITY
#elif defined(ZSTD_DLL_IMPORT) && (ZSTD_DLL_IMPORT==1)
#  define ZSTDERRORLIB_API __declspec(dllimport) ZSTDERRORLIB_VISIBILITY /* It isn't required but allows to generate better code, saving a function pointer load from the IAT and an indirect jump.*/
#else
#  define ZSTDERRORLIB_API ZSTDERRORLIB_VISIBILITY
#endif

/*-*********************************************
 *  Error codes list
 *-*********************************************
 *  Error codes _values_ are pinned down since v1.3.1 only.
 *  Therefore, don't rely on values if you may link to any version < v1.3.1.
 *
 *  Only values < 100 are considered stable.
 *
 *  note 1 : this API shall be used with static linking only.
 *           dynamic linking is not yet officially supported.
 *  note 2 : Prefer relying on the enum than on its value whenever possible
 *           This is the only supported way to use the error list < v1.3.1
 *  note 3 : ZSTD_isError() is always correct, whatever the library version.
 **********************************************/
typedef enum {
  ZSTD_error_no_error = 0,
  ZSTD_error_GENERIC  = 1,
  ZSTD_error_prefix_unknown                = 10,
  ZSTD_error_version_unsupported           = 12,
  ZSTD_error_frameParameter_unsupported    = 14,
  ZSTD_error_frameParameter_windowTooLarge = 16,
  ZSTD_error_corruption_detected = 20,
  ZSTD_error_checksum_wrong      = 22,
  ZSTD_error_dictionary_corrupted      = 30,
  ZSTD_error_dictionary_wrong          = 32,
  ZSTD_error_dictionaryCreation_failed = 34,
  ZSTD_error_parameter_unsupported   = 40,
  ZSTD_error_parameter_outOfBound    = 42,
  ZSTD_error_tableLog_tooLarge       = 44,
  ZSTD_error_maxSymbolValue_tooLarge = 46,
  ZSTD_error_maxSymbolValue_tooSmall = 48,
  ZSTD_error_stage_wrong       = 60,
  ZSTD_error_init_missing      = 62,
  ZSTD_error_memory_allocation = 64,
  ZSTD_error_workSpace_tooSmall= 66,
  ZSTD_error_dstSize_tooSmall = 70,
  ZSTD_error_srcSize_wrong    = 72,
  ZSTD_error_dstBuffer_null   = 74,
  /* following error codes are __NOT STABLE__, they can be removed or changed in future versions */
  ZSTD_error_frameIndex_tooLarge = 100,
  ZSTD_error_seekableIO          = 102,
  ZSTD_error_dstBuffer_wrong     = 104,
  ZSTD_error_maxCode = 120  /* never EVER use this value directly, it can change in future versions! Use ZSTD_isError() instead */
} ZSTD_ErrorCode;

/*! ZSTD_getErrorCode() :
    convert a `size_t` function result into a `ZSTD_ErrorCode` enum type,
    which can be used to compare with enum list published above */
ZSTDERRORLIB_API ZSTD_ErrorCode ZSTD_getErrorCode(size_t functionResult);
ZSTDERRORLIB_API const char* ZSTD_getErrorString(ZSTD_ErrorCode code);   /**< Same as ZSTD_getErrorName, but using a `ZSTD_ErrorCode` enum argument */


#if defined (__cplusplus)
}
#endif

#endif /* ZSTD_ERRORS_H_398273423 */
/**** ended inlining zstd_errors.h ****/


/* ****************************************
*  Compiler-specific
******************************************/
#if defined(__GNUC__)
#  define ERR_STATIC static __attribute__((unused))
#elif defined (__cplusplus) || (defined (__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) /* C99 */)
#  define ERR_STATIC static inline
#elif defined(_MSC_VER)
#  define ERR_STATIC static __inline
#else
#  define ERR_STATIC static  /* this version may generate warnings for unused static functions; disable the relevant warning */
#endif


/*-****************************************
*  Customization (error_public.h)
******************************************/
typedef ZSTD_ErrorCode ERR_enum;
#define PREFIX(name) ZSTD_error_##name


/*-****************************************
*  Error codes handling
******************************************/
#undef ERROR   /* already defined on Visual Studio */
#define ERROR(name) ZSTD_ERROR(name)
#define ZSTD_ERROR(name) ((size_t)-PREFIX(name))

ERR_STATIC unsigned ERR_isError(size_t code) { return (code > ERROR(maxCode)); }

ERR_STATIC ERR_enum ERR_getErrorCode(size_t code) { if (!ERR_isError(code)) return (ERR_enum)0; return (ERR_enum) (0-code); }

/* check and forward error code */
#define CHECK_V_F(e, f) size_t const e = f; if (ERR_isError(e)) return e
#define CHECK_F(f)   { CHECK_V_F(_var_err__, f); }


/*-****************************************
*  Error Strings
******************************************/

const char* ERR_getErrorString(ERR_enum code);   /* error_private.c */

ERR_STATIC const char* ERR_getErrorName(size_t code)
{
    return ERR_getErrorString(ERR_getErrorCode(code));
}

#if defined (__cplusplus)
}
#endif

#endif /* ERROR_H_MODULE */
/**** ended inlining error_private.h ****/
#define FSE_STATIC_LINKING_ONLY  /* FSE_MIN_TABLELOG */
/**** start inlining fse.h ****/
/* ******************************************************************
 * FSE : Finite State Entropy codec
 * Public Prototypes declaration
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 * You can contact the author at :
 * - Source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */

#if defined (__cplusplus)
extern "C" {
#endif

#ifndef FSE_H
#define FSE_H


/*-*****************************************
*  Dependencies
******************************************/
#include <stddef.h>    /* size_t, ptrdiff_t */


/*-*****************************************
*  FSE_PUBLIC_API : control library symbols visibility
******************************************/
#if defined(FSE_DLL_EXPORT) && (FSE_DLL_EXPORT==1) && defined(__GNUC__) && (__GNUC__ >= 4)
#  define FSE_PUBLIC_API __attribute__ ((visibility ("default")))
#elif defined(FSE_DLL_EXPORT) && (FSE_DLL_EXPORT==1)   /* Visual expected */
#  define FSE_PUBLIC_API __declspec(dllexport)
#elif defined(FSE_DLL_IMPORT) && (FSE_DLL_IMPORT==1)
#  define FSE_PUBLIC_API __declspec(dllimport) /* It isn't required but allows to generate better code, saving a function pointer load from the IAT and an indirect jump.*/
#else
#  define FSE_PUBLIC_API
#endif

/*------   Version   ------*/
#define FSE_VERSION_MAJOR    0
#define FSE_VERSION_MINOR    9
#define FSE_VERSION_RELEASE  0

#define FSE_LIB_VERSION FSE_VERSION_MAJOR.FSE_VERSION_MINOR.FSE_VERSION_RELEASE
#define FSE_QUOTE(str) #str
#define FSE_EXPAND_AND_QUOTE(str) FSE_QUOTE(str)
#define FSE_VERSION_STRING FSE_EXPAND_AND_QUOTE(FSE_LIB_VERSION)

#define FSE_VERSION_NUMBER  (FSE_VERSION_MAJOR *100*100 + FSE_VERSION_MINOR *100 + FSE_VERSION_RELEASE)
FSE_PUBLIC_API unsigned FSE_versionNumber(void);   /**< library version number; to be used when checking dll version */


/*-****************************************
*  FSE simple functions
******************************************/
/*! FSE_compress() :
    Compress content of buffer 'src', of size 'srcSize', into destination buffer 'dst'.
    'dst' buffer must be already allocated. Compression runs faster is dstCapacity >= FSE_compressBound(srcSize).
    @return : size of compressed data (<= dstCapacity).
    Special values : if return == 0, srcData is not compressible => Nothing is stored within dst !!!
                     if return == 1, srcData is a single byte symbol * srcSize times. Use RLE compression instead.
                     if FSE_isError(return), compression failed (more details using FSE_getErrorName())
*/
FSE_PUBLIC_API size_t FSE_compress(void* dst, size_t dstCapacity,
                             const void* src, size_t srcSize);

/*! FSE_decompress():
    Decompress FSE data from buffer 'cSrc', of size 'cSrcSize',
    into already allocated destination buffer 'dst', of size 'dstCapacity'.
    @return : size of regenerated data (<= maxDstSize),
              or an error code, which can be tested using FSE_isError() .

    ** Important ** : FSE_decompress() does not decompress non-compressible nor RLE data !!!
    Why ? : making this distinction requires a header.
    Header management is intentionally delegated to the user layer, which can better manage special cases.
*/
FSE_PUBLIC_API size_t FSE_decompress(void* dst,  size_t dstCapacity,
                               const void* cSrc, size_t cSrcSize);


/*-*****************************************
*  Tool functions
******************************************/
FSE_PUBLIC_API size_t FSE_compressBound(size_t size);       /* maximum compressed size */

/* Error Management */
FSE_PUBLIC_API unsigned    FSE_isError(size_t code);        /* tells if a return value is an error code */
FSE_PUBLIC_API const char* FSE_getErrorName(size_t code);   /* provides error code string (useful for debugging) */


/*-*****************************************
*  FSE advanced functions
******************************************/
/*! FSE_compress2() :
    Same as FSE_compress(), but allows the selection of 'maxSymbolValue' and 'tableLog'
    Both parameters can be defined as '0' to mean : use default value
    @return : size of compressed data
    Special values : if return == 0, srcData is not compressible => Nothing is stored within cSrc !!!
                     if return == 1, srcData is a single byte symbol * srcSize times. Use RLE compression.
                     if FSE_isError(return), it's an error code.
*/
FSE_PUBLIC_API size_t FSE_compress2 (void* dst, size_t dstSize, const void* src, size_t srcSize, unsigned maxSymbolValue, unsigned tableLog);


/*-*****************************************
*  FSE detailed API
******************************************/
/*!
FSE_compress() does the following:
1. count symbol occurrence from source[] into table count[] (see hist.h)
2. normalize counters so that sum(count[]) == Power_of_2 (2^tableLog)
3. save normalized counters to memory buffer using writeNCount()
4. build encoding table 'CTable' from normalized counters
5. encode the data stream using encoding table 'CTable'

FSE_decompress() does the following:
1. read normalized counters with readNCount()
2. build decoding table 'DTable' from normalized counters
3. decode the data stream using decoding table 'DTable'

The following API allows targeting specific sub-functions for advanced tasks.
For example, it's possible to compress several blocks using the same 'CTable',
or to save and provide normalized distribution using external method.
*/

/* *** COMPRESSION *** */

/*! FSE_optimalTableLog():
    dynamically downsize 'tableLog' when conditions are met.
    It saves CPU time, by using smaller tables, while preserving or even improving compression ratio.
    @return : recommended tableLog (necessarily <= 'maxTableLog') */
FSE_PUBLIC_API unsigned FSE_optimalTableLog(unsigned maxTableLog, size_t srcSize, unsigned maxSymbolValue);

/*! FSE_normalizeCount():
    normalize counts so that sum(count[]) == Power_of_2 (2^tableLog)
    'normalizedCounter' is a table of short, of minimum size (maxSymbolValue+1).
    @return : tableLog,
              or an errorCode, which can be tested using FSE_isError() */
FSE_PUBLIC_API size_t FSE_normalizeCount(short* normalizedCounter, unsigned tableLog,
                    const unsigned* count, size_t srcSize, unsigned maxSymbolValue);

/*! FSE_NCountWriteBound():
    Provides the maximum possible size of an FSE normalized table, given 'maxSymbolValue' and 'tableLog'.
    Typically useful for allocation purpose. */
FSE_PUBLIC_API size_t FSE_NCountWriteBound(unsigned maxSymbolValue, unsigned tableLog);

/*! FSE_writeNCount():
    Compactly save 'normalizedCounter' into 'buffer'.
    @return : size of the compressed table,
              or an errorCode, which can be tested using FSE_isError(). */
FSE_PUBLIC_API size_t FSE_writeNCount (void* buffer, size_t bufferSize,
                                 const short* normalizedCounter,
                                 unsigned maxSymbolValue, unsigned tableLog);

/*! Constructor and Destructor of FSE_CTable.
    Note that FSE_CTable size depends on 'tableLog' and 'maxSymbolValue' */
typedef unsigned FSE_CTable;   /* don't allocate that. It's only meant to be more restrictive than void* */
FSE_PUBLIC_API FSE_CTable* FSE_createCTable (unsigned maxSymbolValue, unsigned tableLog);
FSE_PUBLIC_API void        FSE_freeCTable (FSE_CTable* ct);

/*! FSE_buildCTable():
    Builds `ct`, which must be already allocated, using FSE_createCTable().
    @return : 0, or an errorCode, which can be tested using FSE_isError() */
FSE_PUBLIC_API size_t FSE_buildCTable(FSE_CTable* ct, const short* normalizedCounter, unsigned maxSymbolValue, unsigned tableLog);

/*! FSE_compress_usingCTable():
    Compress `src` using `ct` into `dst` which must be already allocated.
    @return : size of compressed data (<= `dstCapacity`),
              or 0 if compressed data could not fit into `dst`,
              or an errorCode, which can be tested using FSE_isError() */
FSE_PUBLIC_API size_t FSE_compress_usingCTable (void* dst, size_t dstCapacity, const void* src, size_t srcSize, const FSE_CTable* ct);

/*!
Tutorial :
----------
The first step is to count all symbols. FSE_count() does this job very fast.
Result will be saved into 'count', a table of unsigned int, which must be already allocated, and have 'maxSymbolValuePtr[0]+1' cells.
'src' is a table of bytes of size 'srcSize'. All values within 'src' MUST be <= maxSymbolValuePtr[0]
maxSymbolValuePtr[0] will be updated, with its real value (necessarily <= original value)
FSE_count() will return the number of occurrence of the most frequent symbol.
This can be used to know if there is a single symbol within 'src', and to quickly evaluate its compressibility.
If there is an error, the function will return an ErrorCode (which can be tested using FSE_isError()).

The next step is to normalize the frequencies.
FSE_normalizeCount() will ensure that sum of frequencies is == 2 ^'tableLog'.
It also guarantees a minimum of 1 to any Symbol with frequency >= 1.
You can use 'tableLog'==0 to mean "use default tableLog value".
If you are unsure of which tableLog value to use, you can ask FSE_optimalTableLog(),
which will provide the optimal valid tableLog given sourceSize, maxSymbolValue, and a user-defined maximum (0 means "default").

The result of FSE_normalizeCount() will be saved into a table,
called 'normalizedCounter', which is a table of signed short.
'normalizedCounter' must be already allocated, and have at least 'maxSymbolValue+1' cells.
The return value is tableLog if everything proceeded as expected.
It is 0 if there is a single symbol within distribution.
If there is an error (ex: invalid tableLog value), the function will return an ErrorCode (which can be tested using FSE_isError()).

'normalizedCounter' can be saved in a compact manner to a memory area using FSE_writeNCount().
'buffer' must be already allocated.
For guaranteed success, buffer size must be at least FSE_headerBound().
The result of the function is the number of bytes written into 'buffer'.
If there is an error, the function will return an ErrorCode (which can be tested using FSE_isError(); ex : buffer size too small).

'normalizedCounter' can then be used to create the compression table 'CTable'.
The space required by 'CTable' must be already allocated, using FSE_createCTable().
You can then use FSE_buildCTable() to fill 'CTable'.
If there is an error, both functions will return an ErrorCode (which can be tested using FSE_isError()).

'CTable' can then be used to compress 'src', with FSE_compress_usingCTable().
Similar to FSE_count(), the convention is that 'src' is assumed to be a table of char of size 'srcSize'
The function returns the size of compressed data (without header), necessarily <= `dstCapacity`.
If it returns '0', compressed data could not fit into 'dst'.
If there is an error, the function will return an ErrorCode (which can be tested using FSE_isError()).
*/


/* *** DECOMPRESSION *** */

/*! FSE_readNCount():
    Read compactly saved 'normalizedCounter' from 'rBuffer'.
    @return : size read from 'rBuffer',
              or an errorCode, which can be tested using FSE_isError().
              maxSymbolValuePtr[0] and tableLogPtr[0] will also be updated with their respective values */
FSE_PUBLIC_API size_t FSE_readNCount (short* normalizedCounter,
                           unsigned* maxSymbolValuePtr, unsigned* tableLogPtr,
                           const void* rBuffer, size_t rBuffSize);

/*! Constructor and Destructor of FSE_DTable.
    Note that its size depends on 'tableLog' */
typedef unsigned FSE_DTable;   /* don't allocate that. It's just a way to be more restrictive than void* */
FSE_PUBLIC_API FSE_DTable* FSE_createDTable(unsigned tableLog);
FSE_PUBLIC_API void        FSE_freeDTable(FSE_DTable* dt);

/*! FSE_buildDTable():
    Builds 'dt', which must be already allocated, using FSE_createDTable().
    return : 0, or an errorCode, which can be tested using FSE_isError() */
FSE_PUBLIC_API size_t FSE_buildDTable (FSE_DTable* dt, const short* normalizedCounter, unsigned maxSymbolValue, unsigned tableLog);

/*! FSE_decompress_usingDTable():
    Decompress compressed source `cSrc` of size `cSrcSize` using `dt`
    into `dst` which must be already allocated.
    @return : size of regenerated data (necessarily <= `dstCapacity`),
              or an errorCode, which can be tested using FSE_isError() */
FSE_PUBLIC_API size_t FSE_decompress_usingDTable(void* dst, size_t dstCapacity, const void* cSrc, size_t cSrcSize, const FSE_DTable* dt);

/*!
Tutorial :
----------
(Note : these functions only decompress FSE-compressed blocks.
 If block is uncompressed, use memcpy() instead
 If block is a single repeated byte, use memset() instead )

The first step is to obtain the normalized frequencies of symbols.
This can be performed by FSE_readNCount() if it was saved using FSE_writeNCount().
'normalizedCounter' must be already allocated, and have at least 'maxSymbolValuePtr[0]+1' cells of signed short.
In practice, that means it's necessary to know 'maxSymbolValue' beforehand,
or size the table to handle worst case situations (typically 256).
FSE_readNCount() will provide 'tableLog' and 'maxSymbolValue'.
The result of FSE_readNCount() is the number of bytes read from 'rBuffer'.
Note that 'rBufferSize' must be at least 4 bytes, even if useful information is less than that.
If there is an error, the function will return an error code, which can be tested using FSE_isError().

The next step is to build the decompression tables 'FSE_DTable' from 'normalizedCounter'.
This is performed by the function FSE_buildDTable().
The space required by 'FSE_DTable' must be already allocated using FSE_createDTable().
If there is an error, the function will return an error code, which can be tested using FSE_isError().

`FSE_DTable` can then be used to decompress `cSrc`, with FSE_decompress_usingDTable().
`cSrcSize` must be strictly correct, otherwise decompression will fail.
FSE_decompress_usingDTable() result will tell how many bytes were regenerated (<=`dstCapacity`).
If there is an error, the function will return an error code, which can be tested using FSE_isError(). (ex: dst buffer too small)
*/

#endif  /* FSE_H */

#if defined(FSE_STATIC_LINKING_ONLY) && !defined(FSE_H_FSE_STATIC_LINKING_ONLY)
#define FSE_H_FSE_STATIC_LINKING_ONLY

/* *** Dependency *** */
/**** start inlining bitstream.h ****/
/* ******************************************************************
 * bitstream
 * Part of FSE library
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 * You can contact the author at :
 * - Source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */
#ifndef BITSTREAM_H_MODULE
#define BITSTREAM_H_MODULE

#if defined (__cplusplus)
extern "C" {
#endif

/*
*  This API consists of small unitary functions, which must be inlined for best performance.
*  Since link-time-optimization is not available for all compilers,
*  these functions are defined into a .h to be included.
*/

/*-****************************************
*  Dependencies
******************************************/
/**** skipping file: mem.h ****/
/**** start inlining compiler.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_COMPILER_H
#define ZSTD_COMPILER_H

/*-*******************************************************
*  Compiler specifics
*********************************************************/
/* force inlining */

#if !defined(ZSTD_NO_INLINE)
#if (defined(__GNUC__) && !defined(__STRICT_ANSI__)) || defined(__cplusplus) || defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L   /* C99 */
#  define INLINE_KEYWORD inline
#else
#  define INLINE_KEYWORD
#endif

#if defined(__GNUC__) || defined(__ICCARM__)
#  define FORCE_INLINE_ATTR __attribute__((always_inline))
#elif defined(_MSC_VER)
#  define FORCE_INLINE_ATTR __forceinline
#else
#  define FORCE_INLINE_ATTR
#endif

#else

#define INLINE_KEYWORD
#define FORCE_INLINE_ATTR

#endif

/**
  On MSVC qsort requires that functions passed into it use the __cdecl calling conversion(CC). 
  This explictly marks such functions as __cdecl so that the code will still compile 
  if a CC other than __cdecl has been made the default.
*/
#if  defined(_MSC_VER)
#  define WIN_CDECL __cdecl
#else
#  define WIN_CDECL 
#endif

/**
 * FORCE_INLINE_TEMPLATE is used to define C "templates", which take constant
 * parameters. They must be inlined for the compiler to eliminate the constant
 * branches.
 */
#define FORCE_INLINE_TEMPLATE static INLINE_KEYWORD FORCE_INLINE_ATTR
/**
 * HINT_INLINE is used to help the compiler generate better code. It is *not*
 * used for "templates", so it can be tweaked based on the compilers
 * performance.
 *
 * gcc-4.8 and gcc-4.9 have been shown to benefit from leaving off the
 * always_inline attribute.
 *
 * clang up to 5.0.0 (trunk) benefit tremendously from the always_inline
 * attribute.
 */
#if !defined(__clang__) && defined(__GNUC__) && __GNUC__ >= 4 && __GNUC_MINOR__ >= 8 && __GNUC__ < 5
#  define HINT_INLINE static INLINE_KEYWORD
#else
#  define HINT_INLINE static INLINE_KEYWORD FORCE_INLINE_ATTR
#endif

/* UNUSED_ATTR tells the compiler it is okay if the function is unused. */
#if defined(__GNUC__)
#  define UNUSED_ATTR __attribute__((unused))
#else
#  define UNUSED_ATTR
#endif

/* force no inlining */
#ifdef _MSC_VER
#  define FORCE_NOINLINE static __declspec(noinline)
#else
#  if defined(__GNUC__) || defined(__ICCARM__)
#    define FORCE_NOINLINE static __attribute__((__noinline__))
#  else
#    define FORCE_NOINLINE static
#  endif
#endif

/* target attribute */
#ifndef __has_attribute
  #define __has_attribute(x) 0  /* Compatibility with non-clang compilers. */
#endif
#if defined(__GNUC__) || defined(__ICCARM__)
#  define TARGET_ATTRIBUTE(target) __attribute__((__target__(target)))
#else
#  define TARGET_ATTRIBUTE(target)
#endif

/* Enable runtime BMI2 dispatch based on the CPU.
 * Enabled for clang & gcc >=4.8 on x86 when BMI2 isn't enabled by default.
 */
#ifndef DYNAMIC_BMI2
  #if ((defined(__clang__) && __has_attribute(__target__)) \
      || (defined(__GNUC__) \
          && (__GNUC__ >= 5 || (__GNUC__ == 4 && __GNUC_MINOR__ >= 8)))) \
      && (defined(__x86_64__) || defined(_M_X86)) \
      && !defined(__BMI2__)
  #  define DYNAMIC_BMI2 1
  #else
  #  define DYNAMIC_BMI2 0
  #endif
#endif

/* prefetch
 * can be disabled, by declaring NO_PREFETCH build macro */
#if defined(NO_PREFETCH)
#  define PREFETCH_L1(ptr)  (void)(ptr)  /* disabled */
#  define PREFETCH_L2(ptr)  (void)(ptr)  /* disabled */
#else
#  if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_I86))  /* _mm_prefetch() is not defined outside of x86/x64 */
#    include <mmintrin.h>   /* https://msdn.microsoft.com/fr-fr/library/84szxsww(v=vs.90).aspx */
#    define PREFETCH_L1(ptr)  _mm_prefetch((const char*)(ptr), _MM_HINT_T0)
#    define PREFETCH_L2(ptr)  _mm_prefetch((const char*)(ptr), _MM_HINT_T1)
#    elif defined(__aarch64__)
#     define PREFETCH_L1(ptr)  __asm__ __volatile__("prfm pldl1keep, %0" ::"Q"(*(ptr)))
#     define PREFETCH_L2(ptr)  __asm__ __volatile__("prfm pldl2keep, %0" ::"Q"(*(ptr)))
#  elif defined(__GNUC__) && ( (__GNUC__ >= 4) || ( (__GNUC__ == 3) && (__GNUC_MINOR__ >= 1) ) )
#    define PREFETCH_L1(ptr)  __builtin_prefetch((ptr), 0 /* rw==read */, 3 /* locality */)
#    define PREFETCH_L2(ptr)  __builtin_prefetch((ptr), 0 /* rw==read */, 2 /* locality */)
#  else
#    define PREFETCH_L1(ptr) (void)(ptr)  /* disabled */
#    define PREFETCH_L2(ptr) (void)(ptr)  /* disabled */
#  endif
#endif  /* NO_PREFETCH */

#define CACHELINE_SIZE 64

#define PREFETCH_AREA(p, s)  {            \
    const char* const _ptr = (const char*)(p);  \
    size_t const _size = (size_t)(s);     \
    size_t _pos;                          \
    for (_pos=0; _pos<_size; _pos+=CACHELINE_SIZE) {  \
        PREFETCH_L2(_ptr + _pos);         \
    }                                     \
}

/* vectorization
 * older GCC (pre gcc-4.3 picked as the cutoff) uses a different syntax */
#if !defined(__INTEL_COMPILER) && !defined(__clang__) && defined(__GNUC__)
#  if (__GNUC__ == 4 && __GNUC_MINOR__ > 3) || (__GNUC__ >= 5)
#    define DONT_VECTORIZE __attribute__((optimize("no-tree-vectorize")))
#  else
#    define DONT_VECTORIZE _Pragma("GCC optimize(\"no-tree-vectorize\")")
#  endif
#else
#  define DONT_VECTORIZE
#endif

/* Tell the compiler that a branch is likely or unlikely.
 * Only use these macros if it causes the compiler to generate better code.
 * If you can remove a LIKELY/UNLIKELY annotation without speed changes in gcc
 * and clang, please do.
 */
#if defined(__GNUC__)
#define LIKELY(x) (__builtin_expect((x), 1))
#define UNLIKELY(x) (__builtin_expect((x), 0))
#else
#define LIKELY(x) (x)
#define UNLIKELY(x) (x)
#endif

/* disable warnings */
#ifdef _MSC_VER    /* Visual Studio */
#  include <intrin.h>                    /* For Visual 2005 */
#  pragma warning(disable : 4100)        /* disable: C4100: unreferenced formal parameter */
#  pragma warning(disable : 4127)        /* disable: C4127: conditional expression is constant */
#  pragma warning(disable : 4204)        /* disable: C4204: non-constant aggregate initializer */
#  pragma warning(disable : 4214)        /* disable: C4214: non-int bitfields */
#  pragma warning(disable : 4324)        /* disable: C4324: padded structure */
#endif

#endif /* ZSTD_COMPILER_H */
/**** ended inlining compiler.h ****/
/**** skipping file: debug.h ****/
/**** skipping file: error_private.h ****/


/*=========================================
*  Target specific
=========================================*/
#if defined(__BMI__) && defined(__GNUC__)
#  include <immintrin.h>   /* support for bextr (experimental) */
#elif defined(__ICCARM__)
#  include <intrinsics.h>
#endif

#define STREAM_ACCUMULATOR_MIN_32  25
#define STREAM_ACCUMULATOR_MIN_64  57
#define STREAM_ACCUMULATOR_MIN    ((U32)(MEM_32bits() ? STREAM_ACCUMULATOR_MIN_32 : STREAM_ACCUMULATOR_MIN_64))


/*-******************************************
*  bitStream encoding API (write forward)
********************************************/
/* bitStream can mix input from multiple sources.
 * A critical property of these streams is that they encode and decode in **reverse** direction.
 * So the first bit sequence you add will be the last to be read, like a LIFO stack.
 */
typedef struct {
    size_t bitContainer;
    unsigned bitPos;
    char*  startPtr;
    char*  ptr;
    char*  endPtr;
} BIT_CStream_t;

MEM_STATIC size_t BIT_initCStream(BIT_CStream_t* bitC, void* dstBuffer, size_t dstCapacity);
MEM_STATIC void   BIT_addBits(BIT_CStream_t* bitC, size_t value, unsigned nbBits);
MEM_STATIC void   BIT_flushBits(BIT_CStream_t* bitC);
MEM_STATIC size_t BIT_closeCStream(BIT_CStream_t* bitC);

/* Start with initCStream, providing the size of buffer to write into.
*  bitStream will never write outside of this buffer.
*  `dstCapacity` must be >= sizeof(bitD->bitContainer), otherwise @return will be an error code.
*
*  bits are first added to a local register.
*  Local register is size_t, hence 64-bits on 64-bits systems, or 32-bits on 32-bits systems.
*  Writing data into memory is an explicit operation, performed by the flushBits function.
*  Hence keep track how many bits are potentially stored into local register to avoid register overflow.
*  After a flushBits, a maximum of 7 bits might still be stored into local register.
*
*  Avoid storing elements of more than 24 bits if you want compatibility with 32-bits bitstream readers.
*
*  Last operation is to close the bitStream.
*  The function returns the final size of CStream in bytes.
*  If data couldn't fit into `dstBuffer`, it will return a 0 ( == not storable)
*/


/*-********************************************
*  bitStream decoding API (read backward)
**********************************************/
typedef struct {
    size_t   bitContainer;
    unsigned bitsConsumed;
    const char* ptr;
    const char* start;
    const char* limitPtr;
} BIT_DStream_t;

typedef enum { BIT_DStream_unfinished = 0,
               BIT_DStream_endOfBuffer = 1,
               BIT_DStream_completed = 2,
               BIT_DStream_overflow = 3 } BIT_DStream_status;  /* result of BIT_reloadDStream() */
               /* 1,2,4,8 would be better for bitmap combinations, but slows down performance a bit ... :( */

MEM_STATIC size_t   BIT_initDStream(BIT_DStream_t* bitD, const void* srcBuffer, size_t srcSize);
MEM_STATIC size_t   BIT_readBits(BIT_DStream_t* bitD, unsigned nbBits);
MEM_STATIC BIT_DStream_status BIT_reloadDStream(BIT_DStream_t* bitD);
MEM_STATIC unsigned BIT_endOfDStream(const BIT_DStream_t* bitD);


/* Start by invoking BIT_initDStream().
*  A chunk of the bitStream is then stored into a local register.
*  Local register size is 64-bits on 64-bits systems, 32-bits on 32-bits systems (size_t).
*  You can then retrieve bitFields stored into the local register, **in reverse order**.
*  Local register is explicitly reloaded from memory by the BIT_reloadDStream() method.
*  A reload guarantee a minimum of ((8*sizeof(bitD->bitContainer))-7) bits when its result is BIT_DStream_unfinished.
*  Otherwise, it can be less than that, so proceed accordingly.
*  Checking if DStream has reached its end can be performed with BIT_endOfDStream().
*/


/*-****************************************
*  unsafe API
******************************************/
MEM_STATIC void BIT_addBitsFast(BIT_CStream_t* bitC, size_t value, unsigned nbBits);
/* faster, but works only if value is "clean", meaning all high bits above nbBits are 0 */

MEM_STATIC void BIT_flushBitsFast(BIT_CStream_t* bitC);
/* unsafe version; does not check buffer overflow */

MEM_STATIC size_t BIT_readBitsFast(BIT_DStream_t* bitD, unsigned nbBits);
/* faster, but works only if nbBits >= 1 */



/*-**************************************************************
*  Internal functions
****************************************************************/
MEM_STATIC unsigned BIT_highbit32 (U32 val)
{
    assert(val != 0);
    {
#   if defined(_MSC_VER)   /* Visual */
        unsigned long r=0;
        return _BitScanReverse ( &r, val ) ? (unsigned)r : 0;
#   elif defined(__GNUC__) && (__GNUC__ >= 3)   /* Use GCC Intrinsic */
        return __builtin_clz (val) ^ 31;
#   elif defined(__ICCARM__)    /* IAR Intrinsic */
        return 31 - __CLZ(val);
#   else   /* Software version */
        static const unsigned DeBruijnClz[32] = { 0,  9,  1, 10, 13, 21,  2, 29,
                                                 11, 14, 16, 18, 22, 25,  3, 30,
                                                  8, 12, 20, 28, 15, 17, 24,  7,
                                                 19, 27, 23,  6, 26,  5,  4, 31 };
        U32 v = val;
        v |= v >> 1;
        v |= v >> 2;
        v |= v >> 4;
        v |= v >> 8;
        v |= v >> 16;
        return DeBruijnClz[ (U32) (v * 0x07C4ACDDU) >> 27];
#   endif
    }
}

/*=====    Local Constants   =====*/
static const unsigned BIT_mask[] = {
    0,          1,         3,         7,         0xF,       0x1F,
    0x3F,       0x7F,      0xFF,      0x1FF,     0x3FF,     0x7FF,
    0xFFF,      0x1FFF,    0x3FFF,    0x7FFF,    0xFFFF,    0x1FFFF,
    0x3FFFF,    0x7FFFF,   0xFFFFF,   0x1FFFFF,  0x3FFFFF,  0x7FFFFF,
    0xFFFFFF,   0x1FFFFFF, 0x3FFFFFF, 0x7FFFFFF, 0xFFFFFFF, 0x1FFFFFFF,
    0x3FFFFFFF, 0x7FFFFFFF}; /* up to 31 bits */
#define BIT_MASK_SIZE (sizeof(BIT_mask) / sizeof(BIT_mask[0]))

/*-**************************************************************
*  bitStream encoding
****************************************************************/
/*! BIT_initCStream() :
 *  `dstCapacity` must be > sizeof(size_t)
 *  @return : 0 if success,
 *            otherwise an error code (can be tested using ERR_isError()) */
MEM_STATIC size_t BIT_initCStream(BIT_CStream_t* bitC,
                                  void* startPtr, size_t dstCapacity)
{
    bitC->bitContainer = 0;
    bitC->bitPos = 0;
    bitC->startPtr = (char*)startPtr;
    bitC->ptr = bitC->startPtr;
    bitC->endPtr = bitC->startPtr + dstCapacity - sizeof(bitC->bitContainer);
    if (dstCapacity <= sizeof(bitC->bitContainer)) return ERROR(dstSize_tooSmall);
    return 0;
}

/*! BIT_addBits() :
 *  can add up to 31 bits into `bitC`.
 *  Note : does not check for register overflow ! */
MEM_STATIC void BIT_addBits(BIT_CStream_t* bitC,
                            size_t value, unsigned nbBits)
{
    MEM_STATIC_ASSERT(BIT_MASK_SIZE == 32);
    assert(nbBits < BIT_MASK_SIZE);
    assert(nbBits + bitC->bitPos < sizeof(bitC->bitContainer) * 8);
    bitC->bitContainer |= (value & BIT_mask[nbBits]) << bitC->bitPos;
    bitC->bitPos += nbBits;
}

/*! BIT_addBitsFast() :
 *  works only if `value` is _clean_,
 *  meaning all high bits above nbBits are 0 */
MEM_STATIC void BIT_addBitsFast(BIT_CStream_t* bitC,
                                size_t value, unsigned nbBits)
{
    assert((value>>nbBits) == 0);
    assert(nbBits + bitC->bitPos < sizeof(bitC->bitContainer) * 8);
    bitC->bitContainer |= value << bitC->bitPos;
    bitC->bitPos += nbBits;
}

/*! BIT_flushBitsFast() :
 *  assumption : bitContainer has not overflowed
 *  unsafe version; does not check buffer overflow */
MEM_STATIC void BIT_flushBitsFast(BIT_CStream_t* bitC)
{
    size_t const nbBytes = bitC->bitPos >> 3;
    assert(bitC->bitPos < sizeof(bitC->bitContainer) * 8);
    assert(bitC->ptr <= bitC->endPtr);
    MEM_writeLEST(bitC->ptr, bitC->bitContainer);
    bitC->ptr += nbBytes;
    bitC->bitPos &= 7;
    bitC->bitContainer >>= nbBytes*8;
}

/*! BIT_flushBits() :
 *  assumption : bitContainer has not overflowed
 *  safe version; check for buffer overflow, and prevents it.
 *  note : does not signal buffer overflow.
 *  overflow will be revealed later on using BIT_closeCStream() */
MEM_STATIC void BIT_flushBits(BIT_CStream_t* bitC)
{
    size_t const nbBytes = bitC->bitPos >> 3;
    assert(bitC->bitPos < sizeof(bitC->bitContainer) * 8);
    assert(bitC->ptr <= bitC->endPtr);
    MEM_writeLEST(bitC->ptr, bitC->bitContainer);
    bitC->ptr += nbBytes;
    if (bitC->ptr > bitC->endPtr) bitC->ptr = bitC->endPtr;
    bitC->bitPos &= 7;
    bitC->bitContainer >>= nbBytes*8;
}

/*! BIT_closeCStream() :
 *  @return : size of CStream, in bytes,
 *            or 0 if it could not fit into dstBuffer */
MEM_STATIC size_t BIT_closeCStream(BIT_CStream_t* bitC)
{
    BIT_addBitsFast(bitC, 1, 1);   /* endMark */
    BIT_flushBits(bitC);
    if (bitC->ptr >= bitC->endPtr) return 0; /* overflow detected */
    return (bitC->ptr - bitC->startPtr) + (bitC->bitPos > 0);
}


/*-********************************************************
*  bitStream decoding
**********************************************************/
/*! BIT_initDStream() :
 *  Initialize a BIT_DStream_t.
 * `bitD` : a pointer to an already allocated BIT_DStream_t structure.
 * `srcSize` must be the *exact* size of the bitStream, in bytes.
 * @return : size of stream (== srcSize), or an errorCode if a problem is detected
 */
MEM_STATIC size_t BIT_initDStream(BIT_DStream_t* bitD, const void* srcBuffer, size_t srcSize)
{
    if (srcSize < 1) { memset(bitD, 0, sizeof(*bitD)); return ERROR(srcSize_wrong); }

    bitD->start = (const char*)srcBuffer;
    bitD->limitPtr = bitD->start + sizeof(bitD->bitContainer);

    if (srcSize >=  sizeof(bitD->bitContainer)) {  /* normal case */
        bitD->ptr   = (const char*)srcBuffer + srcSize - sizeof(bitD->bitContainer);
        bitD->bitContainer = MEM_readLEST(bitD->ptr);
        { BYTE const lastByte = ((const BYTE*)srcBuffer)[srcSize-1];
          bitD->bitsConsumed = lastByte ? 8 - BIT_highbit32(lastByte) : 0;  /* ensures bitsConsumed is always set */
          if (lastByte == 0) return ERROR(GENERIC); /* endMark not present */ }
    } else {
        bitD->ptr   = bitD->start;
        bitD->bitContainer = *(const BYTE*)(bitD->start);
        switch(srcSize)
        {
        case 7: bitD->bitContainer += (size_t)(((const BYTE*)(srcBuffer))[6]) << (sizeof(bitD->bitContainer)*8 - 16);
                /* fall-through */

        case 6: bitD->bitContainer += (size_t)(((const BYTE*)(srcBuffer))[5]) << (sizeof(bitD->bitContainer)*8 - 24);
                /* fall-through */

        case 5: bitD->bitContainer += (size_t)(((const BYTE*)(srcBuffer))[4]) << (sizeof(bitD->bitContainer)*8 - 32);
                /* fall-through */

        case 4: bitD->bitContainer += (size_t)(((const BYTE*)(srcBuffer))[3]) << 24;
                /* fall-through */

        case 3: bitD->bitContainer += (size_t)(((const BYTE*)(srcBuffer))[2]) << 16;
                /* fall-through */

        case 2: bitD->bitContainer += (size_t)(((const BYTE*)(srcBuffer))[1]) <<  8;
                /* fall-through */

        default: break;
        }
        {   BYTE const lastByte = ((const BYTE*)srcBuffer)[srcSize-1];
            bitD->bitsConsumed = lastByte ? 8 - BIT_highbit32(lastByte) : 0;
            if (lastByte == 0) return ERROR(corruption_detected);  /* endMark not present */
        }
        bitD->bitsConsumed += (U32)(sizeof(bitD->bitContainer) - srcSize)*8;
    }

    return srcSize;
}

MEM_STATIC size_t BIT_getUpperBits(size_t bitContainer, U32 const start)
{
    return bitContainer >> start;
}

MEM_STATIC size_t BIT_getMiddleBits(size_t bitContainer, U32 const start, U32 const nbBits)
{
    U32 const regMask = sizeof(bitContainer)*8 - 1;
    /* if start > regMask, bitstream is corrupted, and result is undefined */
    assert(nbBits < BIT_MASK_SIZE);
    return (bitContainer >> (start & regMask)) & BIT_mask[nbBits];
}

MEM_STATIC size_t BIT_getLowerBits(size_t bitContainer, U32 const nbBits)
{
    assert(nbBits < BIT_MASK_SIZE);
    return bitContainer & BIT_mask[nbBits];
}

/*! BIT_lookBits() :
 *  Provides next n bits from local register.
 *  local register is not modified.
 *  On 32-bits, maxNbBits==24.
 *  On 64-bits, maxNbBits==56.
 * @return : value extracted */
MEM_STATIC size_t BIT_lookBits(const BIT_DStream_t* bitD, U32 nbBits)
{
    /* arbitrate between double-shift and shift+mask */
#if 1
    /* if bitD->bitsConsumed + nbBits > sizeof(bitD->bitContainer)*8,
     * bitstream is likely corrupted, and result is undefined */
    return BIT_getMiddleBits(bitD->bitContainer, (sizeof(bitD->bitContainer)*8) - bitD->bitsConsumed - nbBits, nbBits);
#else
    /* this code path is slower on my os-x laptop */
    U32 const regMask = sizeof(bitD->bitContainer)*8 - 1;
    return ((bitD->bitContainer << (bitD->bitsConsumed & regMask)) >> 1) >> ((regMask-nbBits) & regMask);
#endif
}

/*! BIT_lookBitsFast() :
 *  unsafe version; only works if nbBits >= 1 */
MEM_STATIC size_t BIT_lookBitsFast(const BIT_DStream_t* bitD, U32 nbBits)
{
    U32 const regMask = sizeof(bitD->bitContainer)*8 - 1;
    assert(nbBits >= 1);
    return (bitD->bitContainer << (bitD->bitsConsumed & regMask)) >> (((regMask+1)-nbBits) & regMask);
}

MEM_STATIC void BIT_skipBits(BIT_DStream_t* bitD, U32 nbBits)
{
    bitD->bitsConsumed += nbBits;
}

/*! BIT_readBits() :
 *  Read (consume) next n bits from local register and update.
 *  Pay attention to not read more than nbBits contained into local register.
 * @return : extracted value. */
MEM_STATIC size_t BIT_readBits(BIT_DStream_t* bitD, unsigned nbBits)
{
    size_t const value = BIT_lookBits(bitD, nbBits);
    BIT_skipBits(bitD, nbBits);
    return value;
}

/*! BIT_readBitsFast() :
 *  unsafe version; only works only if nbBits >= 1 */
MEM_STATIC size_t BIT_readBitsFast(BIT_DStream_t* bitD, unsigned nbBits)
{
    size_t const value = BIT_lookBitsFast(bitD, nbBits);
    assert(nbBits >= 1);
    BIT_skipBits(bitD, nbBits);
    return value;
}

/*! BIT_reloadDStreamFast() :
 *  Similar to BIT_reloadDStream(), but with two differences:
 *  1. bitsConsumed <= sizeof(bitD->bitContainer)*8 must hold!
 *  2. Returns BIT_DStream_overflow when bitD->ptr < bitD->limitPtr, at this
 *     point you must use BIT_reloadDStream() to reload.
 */
MEM_STATIC BIT_DStream_status BIT_reloadDStreamFast(BIT_DStream_t* bitD)
{
    if (UNLIKELY(bitD->ptr < bitD->limitPtr))
        return BIT_DStream_overflow;
    assert(bitD->bitsConsumed <= sizeof(bitD->bitContainer)*8);
    bitD->ptr -= bitD->bitsConsumed >> 3;
    bitD->bitsConsumed &= 7;
    bitD->bitContainer = MEM_readLEST(bitD->ptr);
    return BIT_DStream_unfinished;
}

/*! BIT_reloadDStream() :
 *  Refill `bitD` from buffer previously set in BIT_initDStream() .
 *  This function is safe, it guarantees it will not read beyond src buffer.
 * @return : status of `BIT_DStream_t` internal register.
 *           when status == BIT_DStream_unfinished, internal register is filled with at least 25 or 57 bits */
MEM_STATIC BIT_DStream_status BIT_reloadDStream(BIT_DStream_t* bitD)
{
    if (bitD->bitsConsumed > (sizeof(bitD->bitContainer)*8))  /* overflow detected, like end of stream */
        return BIT_DStream_overflow;

    if (bitD->ptr >= bitD->limitPtr) {
        return BIT_reloadDStreamFast(bitD);
    }
    if (bitD->ptr == bitD->start) {
        if (bitD->bitsConsumed < sizeof(bitD->bitContainer)*8) return BIT_DStream_endOfBuffer;
        return BIT_DStream_completed;
    }
    /* start < ptr < limitPtr */
    {   U32 nbBytes = bitD->bitsConsumed >> 3;
        BIT_DStream_status result = BIT_DStream_unfinished;
        if (bitD->ptr - nbBytes < bitD->start) {
            nbBytes = (U32)(bitD->ptr - bitD->start);  /* ptr > start */
            result = BIT_DStream_endOfBuffer;
        }
        bitD->ptr -= nbBytes;
        bitD->bitsConsumed -= nbBytes*8;
        bitD->bitContainer = MEM_readLEST(bitD->ptr);   /* reminder : srcSize > sizeof(bitD->bitContainer), otherwise bitD->ptr == bitD->start */
        return result;
    }
}

/*! BIT_endOfDStream() :
 * @return : 1 if DStream has _exactly_ reached its end (all bits consumed).
 */
MEM_STATIC unsigned BIT_endOfDStream(const BIT_DStream_t* DStream)
{
    return ((DStream->ptr == DStream->start) && (DStream->bitsConsumed == sizeof(DStream->bitContainer)*8));
}

#if defined (__cplusplus)
}
#endif

#endif /* BITSTREAM_H_MODULE */
/**** ended inlining bitstream.h ****/


/* *****************************************
*  Static allocation
*******************************************/
/* FSE buffer bounds */
#define FSE_NCOUNTBOUND 512
#define FSE_BLOCKBOUND(size) (size + (size>>7) + 4 /* fse states */ + sizeof(size_t) /* bitContainer */)
#define FSE_COMPRESSBOUND(size) (FSE_NCOUNTBOUND + FSE_BLOCKBOUND(size))   /* Macro version, useful for static allocation */

/* It is possible to statically allocate FSE CTable/DTable as a table of FSE_CTable/FSE_DTable using below macros */
#define FSE_CTABLE_SIZE_U32(maxTableLog, maxSymbolValue)   (1 + (1<<(maxTableLog-1)) + ((maxSymbolValue+1)*2))
#define FSE_DTABLE_SIZE_U32(maxTableLog)                   (1 + (1<<maxTableLog))

/* or use the size to malloc() space directly. Pay attention to alignment restrictions though */
#define FSE_CTABLE_SIZE(maxTableLog, maxSymbolValue)   (FSE_CTABLE_SIZE_U32(maxTableLog, maxSymbolValue) * sizeof(FSE_CTable))
#define FSE_DTABLE_SIZE(maxTableLog)                   (FSE_DTABLE_SIZE_U32(maxTableLog) * sizeof(FSE_DTable))


/* *****************************************
 *  FSE advanced API
 ***************************************** */

unsigned FSE_optimalTableLog_internal(unsigned maxTableLog, size_t srcSize, unsigned maxSymbolValue, unsigned minus);
/**< same as FSE_optimalTableLog(), which used `minus==2` */

/* FSE_compress_wksp() :
 * Same as FSE_compress2(), but using an externally allocated scratch buffer (`workSpace`).
 * FSE_WKSP_SIZE_U32() provides the minimum size required for `workSpace` as a table of FSE_CTable.
 */
#define FSE_WKSP_SIZE_U32(maxTableLog, maxSymbolValue)   ( FSE_CTABLE_SIZE_U32(maxTableLog, maxSymbolValue) + ((maxTableLog > 12) ? (1 << (maxTableLog - 2)) : 1024) )
size_t FSE_compress_wksp (void* dst, size_t dstSize, const void* src, size_t srcSize, unsigned maxSymbolValue, unsigned tableLog, void* workSpace, size_t wkspSize);

size_t FSE_buildCTable_raw (FSE_CTable* ct, unsigned nbBits);
/**< build a fake FSE_CTable, designed for a flat distribution, where each symbol uses nbBits */

size_t FSE_buildCTable_rle (FSE_CTable* ct, unsigned char symbolValue);
/**< build a fake FSE_CTable, designed to compress always the same symbolValue */

/* FSE_buildCTable_wksp() :
 * Same as FSE_buildCTable(), but using an externally allocated scratch buffer (`workSpace`).
 * `wkspSize` must be >= `(1<<tableLog)`.
 */
size_t FSE_buildCTable_wksp(FSE_CTable* ct, const short* normalizedCounter, unsigned maxSymbolValue, unsigned tableLog, void* workSpace, size_t wkspSize);

size_t FSE_buildDTable_raw (FSE_DTable* dt, unsigned nbBits);
/**< build a fake FSE_DTable, designed to read a flat distribution where each symbol uses nbBits */

size_t FSE_buildDTable_rle (FSE_DTable* dt, unsigned char symbolValue);
/**< build a fake FSE_DTable, designed to always generate the same symbolValue */

size_t FSE_decompress_wksp(void* dst, size_t dstCapacity, const void* cSrc, size_t cSrcSize, FSE_DTable* workSpace, unsigned maxLog);
/**< same as FSE_decompress(), using an externally allocated `workSpace` produced with `FSE_DTABLE_SIZE_U32(maxLog)` */

typedef enum {
   FSE_repeat_none,  /**< Cannot use the previous table */
   FSE_repeat_check, /**< Can use the previous table but it must be checked */
   FSE_repeat_valid  /**< Can use the previous table and it is assumed to be valid */
 } FSE_repeat;

/* *****************************************
*  FSE symbol compression API
*******************************************/
/*!
   This API consists of small unitary functions, which highly benefit from being inlined.
   Hence their body are included in next section.
*/
typedef struct {
    ptrdiff_t   value;
    const void* stateTable;
    const void* symbolTT;
    unsigned    stateLog;
} FSE_CState_t;

static void FSE_initCState(FSE_CState_t* CStatePtr, const FSE_CTable* ct);

static void FSE_encodeSymbol(BIT_CStream_t* bitC, FSE_CState_t* CStatePtr, unsigned symbol);

static void FSE_flushCState(BIT_CStream_t* bitC, const FSE_CState_t* CStatePtr);

/**<
These functions are inner components of FSE_compress_usingCTable().
They allow the creation of custom streams, mixing multiple tables and bit sources.

A key property to keep in mind is that encoding and decoding are done **in reverse direction**.
So the first symbol you will encode is the last you will decode, like a LIFO stack.

You will need a few variables to track your CStream. They are :

FSE_CTable    ct;         // Provided by FSE_buildCTable()
BIT_CStream_t bitStream;  // bitStream tracking structure
FSE_CState_t  state;      // State tracking structure (can have several)


The first thing to do is to init bitStream and state.
    size_t errorCode = BIT_initCStream(&bitStream, dstBuffer, maxDstSize);
    FSE_initCState(&state, ct);

Note that BIT_initCStream() can produce an error code, so its result should be tested, using FSE_isError();
You can then encode your input data, byte after byte.
FSE_encodeSymbol() outputs a maximum of 'tableLog' bits at a time.
Remember decoding will be done in reverse direction.
    FSE_encodeByte(&bitStream, &state, symbol);

At any time, you can also add any bit sequence.
Note : maximum allowed nbBits is 25, for compatibility with 32-bits decoders
    BIT_addBits(&bitStream, bitField, nbBits);

The above methods don't commit data to memory, they just store it into local register, for speed.
Local register size is 64-bits on 64-bits systems, 32-bits on 32-bits systems (size_t).
Writing data to memory is a manual operation, performed by the flushBits function.
    BIT_flushBits(&bitStream);

Your last FSE encoding operation shall be to flush your last state value(s).
    FSE_flushState(&bitStream, &state);

Finally, you must close the bitStream.
The function returns the size of CStream in bytes.
If data couldn't fit into dstBuffer, it will return a 0 ( == not compressible)
If there is an error, it returns an errorCode (which can be tested using FSE_isError()).
    size_t size = BIT_closeCStream(&bitStream);
*/


/* *****************************************
*  FSE symbol decompression API
*******************************************/
typedef struct {
    size_t      state;
    const void* table;   /* precise table may vary, depending on U16 */
} FSE_DState_t;


static void     FSE_initDState(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD, const FSE_DTable* dt);

static unsigned char FSE_decodeSymbol(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD);

static unsigned FSE_endOfDState(const FSE_DState_t* DStatePtr);

/**<
Let's now decompose FSE_decompress_usingDTable() into its unitary components.
You will decode FSE-encoded symbols from the bitStream,
and also any other bitFields you put in, **in reverse order**.

You will need a few variables to track your bitStream. They are :

BIT_DStream_t DStream;    // Stream context
FSE_DState_t  DState;     // State context. Multiple ones are possible
FSE_DTable*   DTablePtr;  // Decoding table, provided by FSE_buildDTable()

The first thing to do is to init the bitStream.
    errorCode = BIT_initDStream(&DStream, srcBuffer, srcSize);

You should then retrieve your initial state(s)
(in reverse flushing order if you have several ones) :
    errorCode = FSE_initDState(&DState, &DStream, DTablePtr);

You can then decode your data, symbol after symbol.
For information the maximum number of bits read by FSE_decodeSymbol() is 'tableLog'.
Keep in mind that symbols are decoded in reverse order, like a LIFO stack (last in, first out).
    unsigned char symbol = FSE_decodeSymbol(&DState, &DStream);

You can retrieve any bitfield you eventually stored into the bitStream (in reverse order)
Note : maximum allowed nbBits is 25, for 32-bits compatibility
    size_t bitField = BIT_readBits(&DStream, nbBits);

All above operations only read from local register (which size depends on size_t).
Refueling the register from memory is manually performed by the reload method.
    endSignal = FSE_reloadDStream(&DStream);

BIT_reloadDStream() result tells if there is still some more data to read from DStream.
BIT_DStream_unfinished : there is still some data left into the DStream.
BIT_DStream_endOfBuffer : Dstream reached end of buffer. Its container may no longer be completely filled.
BIT_DStream_completed : Dstream reached its exact end, corresponding in general to decompression completed.
BIT_DStream_tooFar : Dstream went too far. Decompression result is corrupted.

When reaching end of buffer (BIT_DStream_endOfBuffer), progress slowly, notably if you decode multiple symbols per loop,
to properly detect the exact end of stream.
After each decoded symbol, check if DStream is fully consumed using this simple test :
    BIT_reloadDStream(&DStream) >= BIT_DStream_completed

When it's done, verify decompression is fully completed, by checking both DStream and the relevant states.
Checking if DStream has reached its end is performed by :
    BIT_endOfDStream(&DStream);
Check also the states. There might be some symbols left there, if some high probability ones (>50%) are possible.
    FSE_endOfDState(&DState);
*/


/* *****************************************
*  FSE unsafe API
*******************************************/
static unsigned char FSE_decodeSymbolFast(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD);
/* faster, but works only if nbBits is always >= 1 (otherwise, result will be corrupted) */


/* *****************************************
*  Implementation of inlined functions
*******************************************/
typedef struct {
    int deltaFindState;
    U32 deltaNbBits;
} FSE_symbolCompressionTransform; /* total 8 bytes */

MEM_STATIC void FSE_initCState(FSE_CState_t* statePtr, const FSE_CTable* ct)
{
    const void* ptr = ct;
    const U16* u16ptr = (const U16*) ptr;
    const U32 tableLog = MEM_read16(ptr);
    statePtr->value = (ptrdiff_t)1<<tableLog;
    statePtr->stateTable = u16ptr+2;
    statePtr->symbolTT = ct + 1 + (tableLog ? (1<<(tableLog-1)) : 1);
    statePtr->stateLog = tableLog;
}


/*! FSE_initCState2() :
*   Same as FSE_initCState(), but the first symbol to include (which will be the last to be read)
*   uses the smallest state value possible, saving the cost of this symbol */
MEM_STATIC void FSE_initCState2(FSE_CState_t* statePtr, const FSE_CTable* ct, U32 symbol)
{
    FSE_initCState(statePtr, ct);
    {   const FSE_symbolCompressionTransform symbolTT = ((const FSE_symbolCompressionTransform*)(statePtr->symbolTT))[symbol];
        const U16* stateTable = (const U16*)(statePtr->stateTable);
        U32 nbBitsOut  = (U32)((symbolTT.deltaNbBits + (1<<15)) >> 16);
        statePtr->value = (nbBitsOut << 16) - symbolTT.deltaNbBits;
        statePtr->value = stateTable[(statePtr->value >> nbBitsOut) + symbolTT.deltaFindState];
    }
}

MEM_STATIC void FSE_encodeSymbol(BIT_CStream_t* bitC, FSE_CState_t* statePtr, unsigned symbol)
{
    FSE_symbolCompressionTransform const symbolTT = ((const FSE_symbolCompressionTransform*)(statePtr->symbolTT))[symbol];
    const U16* const stateTable = (const U16*)(statePtr->stateTable);
    U32 const nbBitsOut  = (U32)((statePtr->value + symbolTT.deltaNbBits) >> 16);
    BIT_addBits(bitC, statePtr->value, nbBitsOut);
    statePtr->value = stateTable[ (statePtr->value >> nbBitsOut) + symbolTT.deltaFindState];
}

MEM_STATIC void FSE_flushCState(BIT_CStream_t* bitC, const FSE_CState_t* statePtr)
{
    BIT_addBits(bitC, statePtr->value, statePtr->stateLog);
    BIT_flushBits(bitC);
}


/* FSE_getMaxNbBits() :
 * Approximate maximum cost of a symbol, in bits.
 * Fractional get rounded up (i.e : a symbol with a normalized frequency of 3 gives the same result as a frequency of 2)
 * note 1 : assume symbolValue is valid (<= maxSymbolValue)
 * note 2 : if freq[symbolValue]==0, @return a fake cost of tableLog+1 bits */
MEM_STATIC U32 FSE_getMaxNbBits(const void* symbolTTPtr, U32 symbolValue)
{
    const FSE_symbolCompressionTransform* symbolTT = (const FSE_symbolCompressionTransform*) symbolTTPtr;
    return (symbolTT[symbolValue].deltaNbBits + ((1<<16)-1)) >> 16;
}

/* FSE_bitCost() :
 * Approximate symbol cost, as fractional value, using fixed-point format (accuracyLog fractional bits)
 * note 1 : assume symbolValue is valid (<= maxSymbolValue)
 * note 2 : if freq[symbolValue]==0, @return a fake cost of tableLog+1 bits */
MEM_STATIC U32 FSE_bitCost(const void* symbolTTPtr, U32 tableLog, U32 symbolValue, U32 accuracyLog)
{
    const FSE_symbolCompressionTransform* symbolTT = (const FSE_symbolCompressionTransform*) symbolTTPtr;
    U32 const minNbBits = symbolTT[symbolValue].deltaNbBits >> 16;
    U32 const threshold = (minNbBits+1) << 16;
    assert(tableLog < 16);
    assert(accuracyLog < 31-tableLog);  /* ensure enough room for renormalization double shift */
    {   U32 const tableSize = 1 << tableLog;
        U32 const deltaFromThreshold = threshold - (symbolTT[symbolValue].deltaNbBits + tableSize);
        U32 const normalizedDeltaFromThreshold = (deltaFromThreshold << accuracyLog) >> tableLog;   /* linear interpolation (very approximate) */
        U32 const bitMultiplier = 1 << accuracyLog;
        assert(symbolTT[symbolValue].deltaNbBits + tableSize <= threshold);
        assert(normalizedDeltaFromThreshold <= bitMultiplier);
        return (minNbBits+1)*bitMultiplier - normalizedDeltaFromThreshold;
    }
}


/* ======    Decompression    ====== */

typedef struct {
    U16 tableLog;
    U16 fastMode;
} FSE_DTableHeader;   /* sizeof U32 */

typedef struct
{
    unsigned short newState;
    unsigned char  symbol;
    unsigned char  nbBits;
} FSE_decode_t;   /* size == U32 */

MEM_STATIC void FSE_initDState(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD, const FSE_DTable* dt)
{
    const void* ptr = dt;
    const FSE_DTableHeader* const DTableH = (const FSE_DTableHeader*)ptr;
    DStatePtr->state = BIT_readBits(bitD, DTableH->tableLog);
    BIT_reloadDStream(bitD);
    DStatePtr->table = dt + 1;
}

MEM_STATIC BYTE FSE_peekSymbol(const FSE_DState_t* DStatePtr)
{
    FSE_decode_t const DInfo = ((const FSE_decode_t*)(DStatePtr->table))[DStatePtr->state];
    return DInfo.symbol;
}

MEM_STATIC void FSE_updateState(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD)
{
    FSE_decode_t const DInfo = ((const FSE_decode_t*)(DStatePtr->table))[DStatePtr->state];
    U32 const nbBits = DInfo.nbBits;
    size_t const lowBits = BIT_readBits(bitD, nbBits);
    DStatePtr->state = DInfo.newState + lowBits;
}

MEM_STATIC BYTE FSE_decodeSymbol(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD)
{
    FSE_decode_t const DInfo = ((const FSE_decode_t*)(DStatePtr->table))[DStatePtr->state];
    U32 const nbBits = DInfo.nbBits;
    BYTE const symbol = DInfo.symbol;
    size_t const lowBits = BIT_readBits(bitD, nbBits);

    DStatePtr->state = DInfo.newState + lowBits;
    return symbol;
}

/*! FSE_decodeSymbolFast() :
    unsafe, only works if no symbol has a probability > 50% */
MEM_STATIC BYTE FSE_decodeSymbolFast(FSE_DState_t* DStatePtr, BIT_DStream_t* bitD)
{
    FSE_decode_t const DInfo = ((const FSE_decode_t*)(DStatePtr->table))[DStatePtr->state];
    U32 const nbBits = DInfo.nbBits;
    BYTE const symbol = DInfo.symbol;
    size_t const lowBits = BIT_readBitsFast(bitD, nbBits);

    DStatePtr->state = DInfo.newState + lowBits;
    return symbol;
}

MEM_STATIC unsigned FSE_endOfDState(const FSE_DState_t* DStatePtr)
{
    return DStatePtr->state == 0;
}



#ifndef FSE_COMMONDEFS_ONLY

/* **************************************************************
*  Tuning parameters
****************************************************************/
/*!MEMORY_USAGE :
*  Memory usage formula : N->2^N Bytes (examples : 10 -> 1KB; 12 -> 4KB ; 16 -> 64KB; 20 -> 1MB; etc.)
*  Increasing memory usage improves compression ratio
*  Reduced memory usage can improve speed, due to cache effect
*  Recommended max value is 14, for 16KB, which nicely fits into Intel x86 L1 cache */
#ifndef FSE_MAX_MEMORY_USAGE
#  define FSE_MAX_MEMORY_USAGE 14
#endif
#ifndef FSE_DEFAULT_MEMORY_USAGE
#  define FSE_DEFAULT_MEMORY_USAGE 13
#endif

/*!FSE_MAX_SYMBOL_VALUE :
*  Maximum symbol value authorized.
*  Required for proper stack allocation */
#ifndef FSE_MAX_SYMBOL_VALUE
#  define FSE_MAX_SYMBOL_VALUE 255
#endif

/* **************************************************************
*  template functions type & suffix
****************************************************************/
#define FSE_FUNCTION_TYPE BYTE
#define FSE_FUNCTION_EXTENSION
#define FSE_DECODE_TYPE FSE_decode_t


#endif   /* !FSE_COMMONDEFS_ONLY */


/* ***************************************************************
*  Constants
*****************************************************************/
#define FSE_MAX_TABLELOG  (FSE_MAX_MEMORY_USAGE-2)
#define FSE_MAX_TABLESIZE (1U<<FSE_MAX_TABLELOG)
#define FSE_MAXTABLESIZE_MASK (FSE_MAX_TABLESIZE-1)
#define FSE_DEFAULT_TABLELOG (FSE_DEFAULT_MEMORY_USAGE-2)
#define FSE_MIN_TABLELOG 5

#define FSE_TABLELOG_ABSOLUTE_MAX 15
#if FSE_MAX_TABLELOG > FSE_TABLELOG_ABSOLUTE_MAX
#  error "FSE_MAX_TABLELOG > FSE_TABLELOG_ABSOLUTE_MAX is not supported"
#endif

#define FSE_TABLESTEP(tableSize) ((tableSize>>1) + (tableSize>>3) + 3)


#endif /* FSE_STATIC_LINKING_ONLY */


#if defined (__cplusplus)
}
#endif
/**** ended inlining fse.h ****/
#define HUF_STATIC_LINKING_ONLY  /* HUF_TABLELOG_ABSOLUTEMAX */
/**** start inlining huf.h ****/
/* ******************************************************************
 * huff0 huffman codec,
 * part of Finite State Entropy library
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 * You can contact the author at :
 * - Source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */

#if defined (__cplusplus)
extern "C" {
#endif

#ifndef HUF_H_298734234
#define HUF_H_298734234

/* *** Dependencies *** */
#include <stddef.h>    /* size_t */


/* *** library symbols visibility *** */
/* Note : when linking with -fvisibility=hidden on gcc, or by default on Visual,
 *        HUF symbols remain "private" (internal symbols for library only).
 *        Set macro FSE_DLL_EXPORT to 1 if you want HUF symbols visible on DLL interface */
#if defined(FSE_DLL_EXPORT) && (FSE_DLL_EXPORT==1) && defined(__GNUC__) && (__GNUC__ >= 4)
#  define HUF_PUBLIC_API __attribute__ ((visibility ("default")))
#elif defined(FSE_DLL_EXPORT) && (FSE_DLL_EXPORT==1)   /* Visual expected */
#  define HUF_PUBLIC_API __declspec(dllexport)
#elif defined(FSE_DLL_IMPORT) && (FSE_DLL_IMPORT==1)
#  define HUF_PUBLIC_API __declspec(dllimport)  /* not required, just to generate faster code (saves a function pointer load from IAT and an indirect jump) */
#else
#  define HUF_PUBLIC_API
#endif


/* ========================== */
/* ***  simple functions  *** */
/* ========================== */

/** HUF_compress() :
 *  Compress content from buffer 'src', of size 'srcSize', into buffer 'dst'.
 * 'dst' buffer must be already allocated.
 *  Compression runs faster if `dstCapacity` >= HUF_compressBound(srcSize).
 * `srcSize` must be <= `HUF_BLOCKSIZE_MAX` == 128 KB.
 * @return : size of compressed data (<= `dstCapacity`).
 *  Special values : if return == 0, srcData is not compressible => Nothing is stored within dst !!!
 *                   if HUF_isError(return), compression failed (more details using HUF_getErrorName())
 */
HUF_PUBLIC_API size_t HUF_compress(void* dst, size_t dstCapacity,
                             const void* src, size_t srcSize);

/** HUF_decompress() :
 *  Decompress HUF data from buffer 'cSrc', of size 'cSrcSize',
 *  into already allocated buffer 'dst', of minimum size 'dstSize'.
 * `originalSize` : **must** be the ***exact*** size of original (uncompressed) data.
 *  Note : in contrast with FSE, HUF_decompress can regenerate
 *         RLE (cSrcSize==1) and uncompressed (cSrcSize==dstSize) data,
 *         because it knows size to regenerate (originalSize).
 * @return : size of regenerated data (== originalSize),
 *           or an error code, which can be tested using HUF_isError()
 */
HUF_PUBLIC_API size_t HUF_decompress(void* dst,  size_t originalSize,
                               const void* cSrc, size_t cSrcSize);


/* ***   Tool functions *** */
#define HUF_BLOCKSIZE_MAX (128 * 1024)                  /**< maximum input size for a single block compressed with HUF_compress */
HUF_PUBLIC_API size_t HUF_compressBound(size_t size);   /**< maximum compressed size (worst case) */

/* Error Management */
HUF_PUBLIC_API unsigned    HUF_isError(size_t code);       /**< tells if a return value is an error code */
HUF_PUBLIC_API const char* HUF_getErrorName(size_t code);  /**< provides error code string (useful for debugging) */


/* ***   Advanced function   *** */

/** HUF_compress2() :
 *  Same as HUF_compress(), but offers control over `maxSymbolValue` and `tableLog`.
 * `maxSymbolValue` must be <= HUF_SYMBOLVALUE_MAX .
 * `tableLog` must be `<= HUF_TABLELOG_MAX` . */
HUF_PUBLIC_API size_t HUF_compress2 (void* dst, size_t dstCapacity,
                               const void* src, size_t srcSize,
                               unsigned maxSymbolValue, unsigned tableLog);

/** HUF_compress4X_wksp() :
 *  Same as HUF_compress2(), but uses externally allocated `workSpace`.
 * `workspace` must have minimum alignment of 4, and be at least as large as HUF_WORKSPACE_SIZE */
#define HUF_WORKSPACE_SIZE ((6 << 10) + 256)
#define HUF_WORKSPACE_SIZE_U32 (HUF_WORKSPACE_SIZE / sizeof(U32))
HUF_PUBLIC_API size_t HUF_compress4X_wksp (void* dst, size_t dstCapacity,
                                     const void* src, size_t srcSize,
                                     unsigned maxSymbolValue, unsigned tableLog,
                                     void* workSpace, size_t wkspSize);

#endif   /* HUF_H_298734234 */

/* ******************************************************************
 *  WARNING !!
 *  The following section contains advanced and experimental definitions
 *  which shall never be used in the context of a dynamic library,
 *  because they are not guaranteed to remain stable in the future.
 *  Only consider them in association with static linking.
 * *****************************************************************/
#if defined(HUF_STATIC_LINKING_ONLY) && !defined(HUF_H_HUF_STATIC_LINKING_ONLY)
#define HUF_H_HUF_STATIC_LINKING_ONLY

/* *** Dependencies *** */
/**** skipping file: mem.h ****/


/* *** Constants *** */
#define HUF_TABLELOG_MAX      12      /* max runtime value of tableLog (due to static allocation); can be modified up to HUF_ABSOLUTEMAX_TABLELOG */
#define HUF_TABLELOG_DEFAULT  11      /* default tableLog value when none specified */
#define HUF_SYMBOLVALUE_MAX  255

#define HUF_TABLELOG_ABSOLUTEMAX  15  /* absolute limit of HUF_MAX_TABLELOG. Beyond that value, code does not work */
#if (HUF_TABLELOG_MAX > HUF_TABLELOG_ABSOLUTEMAX)
#  error "HUF_TABLELOG_MAX is too large !"
#endif


/* ****************************************
*  Static allocation
******************************************/
/* HUF buffer bounds */
#define HUF_CTABLEBOUND 129
#define HUF_BLOCKBOUND(size) (size + (size>>8) + 8)   /* only true when incompressible is pre-filtered with fast heuristic */
#define HUF_COMPRESSBOUND(size) (HUF_CTABLEBOUND + HUF_BLOCKBOUND(size))   /* Macro version, useful for static allocation */

/* static allocation of HUF's Compression Table */
#define HUF_CTABLE_SIZE_U32(maxSymbolValue)   ((maxSymbolValue)+1)   /* Use tables of U32, for proper alignment */
#define HUF_CTABLE_SIZE(maxSymbolValue)       (HUF_CTABLE_SIZE_U32(maxSymbolValue) * sizeof(U32))
#define HUF_CREATE_STATIC_CTABLE(name, maxSymbolValue) \
    U32 name##hb[HUF_CTABLE_SIZE_U32(maxSymbolValue)]; \
    void* name##hv = &(name##hb); \
    HUF_CElt* name = (HUF_CElt*)(name##hv)   /* no final ; */

/* static allocation of HUF's DTable */
typedef U32 HUF_DTable;
#define HUF_DTABLE_SIZE(maxTableLog)   (1 + (1<<(maxTableLog)))
#define HUF_CREATE_STATIC_DTABLEX1(DTable, maxTableLog) \
        HUF_DTable DTable[HUF_DTABLE_SIZE((maxTableLog)-1)] = { ((U32)((maxTableLog)-1) * 0x01000001) }
#define HUF_CREATE_STATIC_DTABLEX2(DTable, maxTableLog) \
        HUF_DTable DTable[HUF_DTABLE_SIZE(maxTableLog)] = { ((U32)(maxTableLog) * 0x01000001) }


/* ****************************************
*  Advanced decompression functions
******************************************/
size_t HUF_decompress4X1 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< single-symbol decoder */
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_decompress4X2 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< double-symbols decoder */
#endif

size_t HUF_decompress4X_DCtx (HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< decodes RLE and uncompressed */
size_t HUF_decompress4X_hufOnly(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize); /**< considers RLE and uncompressed as errors */
size_t HUF_decompress4X_hufOnly_wksp(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize); /**< considers RLE and uncompressed as errors */
size_t HUF_decompress4X1_DCtx(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< single-symbol decoder */
size_t HUF_decompress4X1_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize);   /**< single-symbol decoder */
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_decompress4X2_DCtx(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< double-symbols decoder */
size_t HUF_decompress4X2_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize);   /**< double-symbols decoder */
#endif


/* ****************************************
 *  HUF detailed API
 * ****************************************/

/*! HUF_compress() does the following:
 *  1. count symbol occurrence from source[] into table count[] using FSE_count() (exposed within "fse.h")
 *  2. (optional) refine tableLog using HUF_optimalTableLog()
 *  3. build Huffman table from count using HUF_buildCTable()
 *  4. save Huffman table to memory buffer using HUF_writeCTable()
 *  5. encode the data stream using HUF_compress4X_usingCTable()
 *
 *  The following API allows targeting specific sub-functions for advanced tasks.
 *  For example, it's possible to compress several blocks using the same 'CTable',
 *  or to save and regenerate 'CTable' using external methods.
 */
unsigned HUF_optimalTableLog(unsigned maxTableLog, size_t srcSize, unsigned maxSymbolValue);
typedef struct HUF_CElt_s HUF_CElt;   /* incomplete type */
size_t HUF_buildCTable (HUF_CElt* CTable, const unsigned* count, unsigned maxSymbolValue, unsigned maxNbBits);   /* @return : maxNbBits; CTable and count can overlap. In which case, CTable will overwrite count content */
size_t HUF_writeCTable (void* dst, size_t maxDstSize, const HUF_CElt* CTable, unsigned maxSymbolValue, unsigned huffLog);
size_t HUF_compress4X_usingCTable(void* dst, size_t dstSize, const void* src, size_t srcSize, const HUF_CElt* CTable);
size_t HUF_estimateCompressedSize(const HUF_CElt* CTable, const unsigned* count, unsigned maxSymbolValue);
int HUF_validateCTable(const HUF_CElt* CTable, const unsigned* count, unsigned maxSymbolValue);

typedef enum {
   HUF_repeat_none,  /**< Cannot use the previous table */
   HUF_repeat_check, /**< Can use the previous table but it must be checked. Note : The previous table must have been constructed by HUF_compress{1, 4}X_repeat */
   HUF_repeat_valid  /**< Can use the previous table and it is assumed to be valid */
 } HUF_repeat;
/** HUF_compress4X_repeat() :
 *  Same as HUF_compress4X_wksp(), but considers using hufTable if *repeat != HUF_repeat_none.
 *  If it uses hufTable it does not modify hufTable or repeat.
 *  If it doesn't, it sets *repeat = HUF_repeat_none, and it sets hufTable to the table used.
 *  If preferRepeat then the old table will always be used if valid. */
size_t HUF_compress4X_repeat(void* dst, size_t dstSize,
                       const void* src, size_t srcSize,
                       unsigned maxSymbolValue, unsigned tableLog,
                       void* workSpace, size_t wkspSize,    /**< `workSpace` must be aligned on 4-bytes boundaries, `wkspSize` must be >= HUF_WORKSPACE_SIZE */
                       HUF_CElt* hufTable, HUF_repeat* repeat, int preferRepeat, int bmi2);

/** HUF_buildCTable_wksp() :
 *  Same as HUF_buildCTable(), but using externally allocated scratch buffer.
 * `workSpace` must be aligned on 4-bytes boundaries, and its size must be >= HUF_CTABLE_WORKSPACE_SIZE.
 */
#define HUF_CTABLE_WORKSPACE_SIZE_U32 (2*HUF_SYMBOLVALUE_MAX +1 +1)
#define HUF_CTABLE_WORKSPACE_SIZE (HUF_CTABLE_WORKSPACE_SIZE_U32 * sizeof(unsigned))
size_t HUF_buildCTable_wksp (HUF_CElt* tree,
                       const unsigned* count, U32 maxSymbolValue, U32 maxNbBits,
                             void* workSpace, size_t wkspSize);

/*! HUF_readStats() :
 *  Read compact Huffman tree, saved by HUF_writeCTable().
 * `huffWeight` is destination buffer.
 * @return : size read from `src` , or an error Code .
 *  Note : Needed by HUF_readCTable() and HUF_readDTableXn() . */
size_t HUF_readStats(BYTE* huffWeight, size_t hwSize,
                     U32* rankStats, U32* nbSymbolsPtr, U32* tableLogPtr,
                     const void* src, size_t srcSize);

/** HUF_readCTable() :
 *  Loading a CTable saved with HUF_writeCTable() */
size_t HUF_readCTable (HUF_CElt* CTable, unsigned* maxSymbolValuePtr, const void* src, size_t srcSize, unsigned *hasZeroWeights);

/** HUF_getNbBits() :
 *  Read nbBits from CTable symbolTable, for symbol `symbolValue` presumed <= HUF_SYMBOLVALUE_MAX
 *  Note 1 : is not inlined, as HUF_CElt definition is private
 *  Note 2 : const void* used, so that it can provide a statically allocated table as argument (which uses type U32) */
U32 HUF_getNbBits(const void* symbolTable, U32 symbolValue);

/*
 * HUF_decompress() does the following:
 * 1. select the decompression algorithm (X1, X2) based on pre-computed heuristics
 * 2. build Huffman table from save, using HUF_readDTableX?()
 * 3. decode 1 or 4 segments in parallel using HUF_decompress?X?_usingDTable()
 */

/** HUF_selectDecoder() :
 *  Tells which decoder is likely to decode faster,
 *  based on a set of pre-computed metrics.
 * @return : 0==HUF_decompress4X1, 1==HUF_decompress4X2 .
 *  Assumption : 0 < dstSize <= 128 KB */
U32 HUF_selectDecoder (size_t dstSize, size_t cSrcSize);

/**
 *  The minimum workspace size for the `workSpace` used in
 *  HUF_readDTableX1_wksp() and HUF_readDTableX2_wksp().
 *
 *  The space used depends on HUF_TABLELOG_MAX, ranging from ~1500 bytes when
 *  HUF_TABLE_LOG_MAX=12 to ~1850 bytes when HUF_TABLE_LOG_MAX=15.
 *  Buffer overflow errors may potentially occur if code modifications result in
 *  a required workspace size greater than that specified in the following
 *  macro.
 */
#define HUF_DECOMPRESS_WORKSPACE_SIZE (2 << 10)
#define HUF_DECOMPRESS_WORKSPACE_SIZE_U32 (HUF_DECOMPRESS_WORKSPACE_SIZE / sizeof(U32))

#ifndef HUF_FORCE_DECOMPRESS_X2
size_t HUF_readDTableX1 (HUF_DTable* DTable, const void* src, size_t srcSize);
size_t HUF_readDTableX1_wksp (HUF_DTable* DTable, const void* src, size_t srcSize, void* workSpace, size_t wkspSize);
#endif
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_readDTableX2 (HUF_DTable* DTable, const void* src, size_t srcSize);
size_t HUF_readDTableX2_wksp (HUF_DTable* DTable, const void* src, size_t srcSize, void* workSpace, size_t wkspSize);
#endif

size_t HUF_decompress4X_usingDTable(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable);
#ifndef HUF_FORCE_DECOMPRESS_X2
size_t HUF_decompress4X1_usingDTable(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable);
#endif
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_decompress4X2_usingDTable(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable);
#endif


/* ====================== */
/* single stream variants */
/* ====================== */

size_t HUF_compress1X (void* dst, size_t dstSize, const void* src, size_t srcSize, unsigned maxSymbolValue, unsigned tableLog);
size_t HUF_compress1X_wksp (void* dst, size_t dstSize, const void* src, size_t srcSize, unsigned maxSymbolValue, unsigned tableLog, void* workSpace, size_t wkspSize);  /**< `workSpace` must be a table of at least HUF_WORKSPACE_SIZE_U32 unsigned */
size_t HUF_compress1X_usingCTable(void* dst, size_t dstSize, const void* src, size_t srcSize, const HUF_CElt* CTable);
/** HUF_compress1X_repeat() :
 *  Same as HUF_compress1X_wksp(), but considers using hufTable if *repeat != HUF_repeat_none.
 *  If it uses hufTable it does not modify hufTable or repeat.
 *  If it doesn't, it sets *repeat = HUF_repeat_none, and it sets hufTable to the table used.
 *  If preferRepeat then the old table will always be used if valid. */
size_t HUF_compress1X_repeat(void* dst, size_t dstSize,
                       const void* src, size_t srcSize,
                       unsigned maxSymbolValue, unsigned tableLog,
                       void* workSpace, size_t wkspSize,   /**< `workSpace` must be aligned on 4-bytes boundaries, `wkspSize` must be >= HUF_WORKSPACE_SIZE */
                       HUF_CElt* hufTable, HUF_repeat* repeat, int preferRepeat, int bmi2);

size_t HUF_decompress1X1 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /* single-symbol decoder */
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_decompress1X2 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /* double-symbol decoder */
#endif

size_t HUF_decompress1X_DCtx (HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);
size_t HUF_decompress1X_DCtx_wksp (HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize);
#ifndef HUF_FORCE_DECOMPRESS_X2
size_t HUF_decompress1X1_DCtx(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< single-symbol decoder */
size_t HUF_decompress1X1_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize);   /**< single-symbol decoder */
#endif
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_decompress1X2_DCtx(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);   /**< double-symbols decoder */
size_t HUF_decompress1X2_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize);   /**< double-symbols decoder */
#endif

size_t HUF_decompress1X_usingDTable(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable);   /**< automatic selection of sing or double symbol decoder, based on DTable */
#ifndef HUF_FORCE_DECOMPRESS_X2
size_t HUF_decompress1X1_usingDTable(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable);
#endif
#ifndef HUF_FORCE_DECOMPRESS_X1
size_t HUF_decompress1X2_usingDTable(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable);
#endif

/* BMI2 variants.
 * If the CPU has BMI2 support, pass bmi2=1, otherwise pass bmi2=0.
 */
size_t HUF_decompress1X_usingDTable_bmi2(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable, int bmi2);
#ifndef HUF_FORCE_DECOMPRESS_X2
size_t HUF_decompress1X1_DCtx_wksp_bmi2(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize, int bmi2);
#endif
size_t HUF_decompress4X_usingDTable_bmi2(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable, int bmi2);
size_t HUF_decompress4X_hufOnly_wksp_bmi2(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize, int bmi2);

#endif /* HUF_STATIC_LINKING_ONLY */

#if defined (__cplusplus)
}
#endif
/**** ended inlining huf.h ****/


/*===   Version   ===*/
unsigned FSE_versionNumber(void) { return FSE_VERSION_NUMBER; }


/*===   Error Management   ===*/
unsigned FSE_isError(size_t code) { return ERR_isError(code); }
const char* FSE_getErrorName(size_t code) { return ERR_getErrorName(code); }

unsigned HUF_isError(size_t code) { return ERR_isError(code); }
const char* HUF_getErrorName(size_t code) { return ERR_getErrorName(code); }


/*-**************************************************************
*  FSE NCount encoding-decoding
****************************************************************/
size_t FSE_readNCount (short* normalizedCounter, unsigned* maxSVPtr, unsigned* tableLogPtr,
                 const void* headerBuffer, size_t hbSize)
{
    const BYTE* const istart = (const BYTE*) headerBuffer;
    const BYTE* const iend = istart + hbSize;
    const BYTE* ip = istart;
    int nbBits;
    int remaining;
    int threshold;
    U32 bitStream;
    int bitCount;
    unsigned charnum = 0;
    int previous0 = 0;

    if (hbSize < 4) {
        /* This function only works when hbSize >= 4 */
        char buffer[4];
        memset(buffer, 0, sizeof(buffer));
        memcpy(buffer, headerBuffer, hbSize);
        {   size_t const countSize = FSE_readNCount(normalizedCounter, maxSVPtr, tableLogPtr,
                                                    buffer, sizeof(buffer));
            if (FSE_isError(countSize)) return countSize;
            if (countSize > hbSize) return ERROR(corruption_detected);
            return countSize;
    }   }
    assert(hbSize >= 4);

    /* init */
    memset(normalizedCounter, 0, (*maxSVPtr+1) * sizeof(normalizedCounter[0]));   /* all symbols not present in NCount have a frequency of 0 */
    bitStream = MEM_readLE32(ip);
    nbBits = (bitStream & 0xF) + FSE_MIN_TABLELOG;   /* extract tableLog */
    if (nbBits > FSE_TABLELOG_ABSOLUTE_MAX) return ERROR(tableLog_tooLarge);
    bitStream >>= 4;
    bitCount = 4;
    *tableLogPtr = nbBits;
    remaining = (1<<nbBits)+1;
    threshold = 1<<nbBits;
    nbBits++;

    while ((remaining>1) & (charnum<=*maxSVPtr)) {
        if (previous0) {
            unsigned n0 = charnum;
            while ((bitStream & 0xFFFF) == 0xFFFF) {
                n0 += 24;
                if (ip < iend-5) {
                    ip += 2;
                    bitStream = MEM_readLE32(ip) >> bitCount;
                } else {
                    bitStream >>= 16;
                    bitCount   += 16;
            }   }
            while ((bitStream & 3) == 3) {
                n0 += 3;
                bitStream >>= 2;
                bitCount += 2;
            }
            n0 += bitStream & 3;
            bitCount += 2;
            if (n0 > *maxSVPtr) return ERROR(maxSymbolValue_tooSmall);
            while (charnum < n0) normalizedCounter[charnum++] = 0;
            if ((ip <= iend-7) || (ip + (bitCount>>3) <= iend-4)) {
                assert((bitCount >> 3) <= 3); /* For first condition to work */
                ip += bitCount>>3;
                bitCount &= 7;
                bitStream = MEM_readLE32(ip) >> bitCount;
            } else {
                bitStream >>= 2;
        }   }
        {   int const max = (2*threshold-1) - remaining;
            int count;

            if ((bitStream & (threshold-1)) < (U32)max) {
                count = bitStream & (threshold-1);
                bitCount += nbBits-1;
            } else {
                count = bitStream & (2*threshold-1);
                if (count >= threshold) count -= max;
                bitCount += nbBits;
            }

            count--;   /* extra accuracy */
            remaining -= count < 0 ? -count : count;   /* -1 means +1 */
            normalizedCounter[charnum++] = (short)count;
            previous0 = !count;
            while (remaining < threshold) {
                nbBits--;
                threshold >>= 1;
            }

            if ((ip <= iend-7) || (ip + (bitCount>>3) <= iend-4)) {
                ip += bitCount>>3;
                bitCount &= 7;
            } else {
                bitCount -= (int)(8 * (iend - 4 - ip));
                ip = iend - 4;
            }
            bitStream = MEM_readLE32(ip) >> (bitCount & 31);
    }   }   /* while ((remaining>1) & (charnum<=*maxSVPtr)) */
    if (remaining != 1) return ERROR(corruption_detected);
    if (bitCount > 32) return ERROR(corruption_detected);
    *maxSVPtr = charnum-1;

    ip += (bitCount+7)>>3;
    return ip-istart;
}


/*! HUF_readStats() :
    Read compact Huffman tree, saved by HUF_writeCTable().
    `huffWeight` is destination buffer.
    `rankStats` is assumed to be a table of at least HUF_TABLELOG_MAX U32.
    @return : size read from `src` , or an error Code .
    Note : Needed by HUF_readCTable() and HUF_readDTableX?() .
*/
size_t HUF_readStats(BYTE* huffWeight, size_t hwSize, U32* rankStats,
                     U32* nbSymbolsPtr, U32* tableLogPtr,
                     const void* src, size_t srcSize)
{
    U32 weightTotal;
    const BYTE* ip = (const BYTE*) src;
    size_t iSize;
    size_t oSize;

    if (!srcSize) return ERROR(srcSize_wrong);
    iSize = ip[0];
    /* memset(huffWeight, 0, hwSize);   *//* is not necessary, even though some analyzer complain ... */

    if (iSize >= 128) {  /* special header */
        oSize = iSize - 127;
        iSize = ((oSize+1)/2);
        if (iSize+1 > srcSize) return ERROR(srcSize_wrong);
        if (oSize >= hwSize) return ERROR(corruption_detected);
        ip += 1;
        {   U32 n;
            for (n=0; n<oSize; n+=2) {
                huffWeight[n]   = ip[n/2] >> 4;
                huffWeight[n+1] = ip[n/2] & 15;
    }   }   }
    else  {   /* header compressed with FSE (normal case) */
        FSE_DTable fseWorkspace[FSE_DTABLE_SIZE_U32(6)];  /* 6 is max possible tableLog for HUF header (maybe even 5, to be tested) */
        if (iSize+1 > srcSize) return ERROR(srcSize_wrong);
        oSize = FSE_decompress_wksp(huffWeight, hwSize-1, ip+1, iSize, fseWorkspace, 6);   /* max (hwSize-1) values decoded, as last one is implied */
        if (FSE_isError(oSize)) return oSize;
    }

    /* collect weight stats */
    memset(rankStats, 0, (HUF_TABLELOG_MAX + 1) * sizeof(U32));
    weightTotal = 0;
    {   U32 n; for (n=0; n<oSize; n++) {
            if (huffWeight[n] >= HUF_TABLELOG_MAX) return ERROR(corruption_detected);
            rankStats[huffWeight[n]]++;
            weightTotal += (1 << huffWeight[n]) >> 1;
    }   }
    if (weightTotal == 0) return ERROR(corruption_detected);

    /* get last non-null symbol weight (implied, total must be 2^n) */
    {   U32 const tableLog = BIT_highbit32(weightTotal) + 1;
        if (tableLog > HUF_TABLELOG_MAX) return ERROR(corruption_detected);
        *tableLogPtr = tableLog;
        /* determine last weight */
        {   U32 const total = 1 << tableLog;
            U32 const rest = total - weightTotal;
            U32 const verif = 1 << BIT_highbit32(rest);
            U32 const lastWeight = BIT_highbit32(rest) + 1;
            if (verif != rest) return ERROR(corruption_detected);    /* last value must be a clean power of 2 */
            huffWeight[oSize] = (BYTE)lastWeight;
            rankStats[lastWeight]++;
    }   }

    /* check tree construction validity */
    if ((rankStats[1] < 2) || (rankStats[1] & 1)) return ERROR(corruption_detected);   /* by construction : at least 2 elts of rank 1, must be even */

    /* results */
    *nbSymbolsPtr = (U32)(oSize+1);
    return iSize+1;
}
/**** ended inlining common/entropy_common.c ****/
/**** start inlining common/error_private.c ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

/* The purpose of this file is to have a single list of error strings embedded in binary */

/**** skipping file: error_private.h ****/

const char* ERR_getErrorString(ERR_enum code)
{
#ifdef ZSTD_STRIP_ERROR_STRINGS
    (void)code;
    return "Error strings stripped";
#else
    static const char* const notErrorCode = "Unspecified error code";
    switch( code )
    {
    case PREFIX(no_error): return "No error detected";
    case PREFIX(GENERIC):  return "Error (generic)";
    case PREFIX(prefix_unknown): return "Unknown frame descriptor";
    case PREFIX(version_unsupported): return "Version not supported";
    case PREFIX(frameParameter_unsupported): return "Unsupported frame parameter";
    case PREFIX(frameParameter_windowTooLarge): return "Frame requires too much memory for decoding";
    case PREFIX(corruption_detected): return "Corrupted block detected";
    case PREFIX(checksum_wrong): return "Restored data doesn't match checksum";
    case PREFIX(parameter_unsupported): return "Unsupported parameter";
    case PREFIX(parameter_outOfBound): return "Parameter is out of bound";
    case PREFIX(init_missing): return "Context should be init first";
    case PREFIX(memory_allocation): return "Allocation error : not enough memory";
    case PREFIX(workSpace_tooSmall): return "workSpace buffer is not large enough";
    case PREFIX(stage_wrong): return "Operation not authorized at current processing stage";
    case PREFIX(tableLog_tooLarge): return "tableLog requires too much memory : unsupported";
    case PREFIX(maxSymbolValue_tooLarge): return "Unsupported max Symbol Value : too large";
    case PREFIX(maxSymbolValue_tooSmall): return "Specified maxSymbolValue is too small";
    case PREFIX(dictionary_corrupted): return "Dictionary is corrupted";
    case PREFIX(dictionary_wrong): return "Dictionary mismatch";
    case PREFIX(dictionaryCreation_failed): return "Cannot create Dictionary from provided samples";
    case PREFIX(dstSize_tooSmall): return "Destination buffer is too small";
    case PREFIX(srcSize_wrong): return "Src size is incorrect";
    case PREFIX(dstBuffer_null): return "Operation on NULL destination buffer";
        /* following error codes are not stable and may be removed or changed in a future version */
    case PREFIX(frameIndex_tooLarge): return "Frame index is too large";
    case PREFIX(seekableIO): return "An I/O error occurred when reading/seeking";
    case PREFIX(dstBuffer_wrong): return "Destination buffer is wrong";
    case PREFIX(maxCode):
    default: return notErrorCode;
    }
#endif
}
/**** ended inlining common/error_private.c ****/
/**** start inlining common/fse_decompress.c ****/
/* ******************************************************************
 * FSE : Finite State Entropy decoder
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 *  You can contact the author at :
 *  - FSE source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *  - Public forum : https://groups.google.com/forum/#!forum/lz4c
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */


/* **************************************************************
*  Includes
****************************************************************/
/**** skipping file: bitstream.h ****/
/**** skipping file: compiler.h ****/
#define FSE_STATIC_LINKING_ONLY
/**** skipping file: fse.h ****/
/**** skipping file: error_private.h ****/


/* **************************************************************
*  Error Management
****************************************************************/
#define FSE_isError ERR_isError
#define FSE_STATIC_ASSERT(c) DEBUG_STATIC_ASSERT(c)   /* use only *after* variable declarations */


/* **************************************************************
*  Templates
****************************************************************/
/*
  designed to be included
  for type-specific functions (template emulation in C)
  Objective is to write these functions only once, for improved maintenance
*/

/* safety checks */
#ifndef FSE_FUNCTION_EXTENSION
#  error "FSE_FUNCTION_EXTENSION must be defined"
#endif
#ifndef FSE_FUNCTION_TYPE
#  error "FSE_FUNCTION_TYPE must be defined"
#endif

/* Function names */
#define FSE_CAT(X,Y) X##Y
#define FSE_FUNCTION_NAME(X,Y) FSE_CAT(X,Y)
#define FSE_TYPE_NAME(X,Y) FSE_CAT(X,Y)


/* Function templates */
FSE_DTable* FSE_createDTable (unsigned tableLog)
{
    if (tableLog > FSE_TABLELOG_ABSOLUTE_MAX) tableLog = FSE_TABLELOG_ABSOLUTE_MAX;
    return (FSE_DTable*)malloc( FSE_DTABLE_SIZE_U32(tableLog) * sizeof (U32) );
}

void FSE_freeDTable (FSE_DTable* dt)
{
    free(dt);
}

size_t FSE_buildDTable(FSE_DTable* dt, const short* normalizedCounter, unsigned maxSymbolValue, unsigned tableLog)
{
    void* const tdPtr = dt+1;   /* because *dt is unsigned, 32-bits aligned on 32-bits */
    FSE_DECODE_TYPE* const tableDecode = (FSE_DECODE_TYPE*) (tdPtr);
    U16 symbolNext[FSE_MAX_SYMBOL_VALUE+1];

    U32 const maxSV1 = maxSymbolValue + 1;
    U32 const tableSize = 1 << tableLog;
    U32 highThreshold = tableSize-1;

    /* Sanity Checks */
    if (maxSymbolValue > FSE_MAX_SYMBOL_VALUE) return ERROR(maxSymbolValue_tooLarge);
    if (tableLog > FSE_MAX_TABLELOG) return ERROR(tableLog_tooLarge);

    /* Init, lay down lowprob symbols */
    {   FSE_DTableHeader DTableH;
        DTableH.tableLog = (U16)tableLog;
        DTableH.fastMode = 1;
        {   S16 const largeLimit= (S16)(1 << (tableLog-1));
            U32 s;
            for (s=0; s<maxSV1; s++) {
                if (normalizedCounter[s]==-1) {
                    tableDecode[highThreshold--].symbol = (FSE_FUNCTION_TYPE)s;
                    symbolNext[s] = 1;
                } else {
                    if (normalizedCounter[s] >= largeLimit) DTableH.fastMode=0;
                    symbolNext[s] = normalizedCounter[s];
        }   }   }
        memcpy(dt, &DTableH, sizeof(DTableH));
    }

    /* Spread symbols */
    {   U32 const tableMask = tableSize-1;
        U32 const step = FSE_TABLESTEP(tableSize);
        U32 s, position = 0;
        for (s=0; s<maxSV1; s++) {
            int i;
            for (i=0; i<normalizedCounter[s]; i++) {
                tableDecode[position].symbol = (FSE_FUNCTION_TYPE)s;
                position = (position + step) & tableMask;
                while (position > highThreshold) position = (position + step) & tableMask;   /* lowprob area */
        }   }
        if (position!=0) return ERROR(GENERIC);   /* position must reach all cells once, otherwise normalizedCounter is incorrect */
    }

    /* Build Decoding table */
    {   U32 u;
        for (u=0; u<tableSize; u++) {
            FSE_FUNCTION_TYPE const symbol = (FSE_FUNCTION_TYPE)(tableDecode[u].symbol);
            U32 const nextState = symbolNext[symbol]++;
            tableDecode[u].nbBits = (BYTE) (tableLog - BIT_highbit32(nextState) );
            tableDecode[u].newState = (U16) ( (nextState << tableDecode[u].nbBits) - tableSize);
    }   }

    return 0;
}


#ifndef FSE_COMMONDEFS_ONLY

/*-*******************************************************
*  Decompression (Byte symbols)
*********************************************************/
size_t FSE_buildDTable_rle (FSE_DTable* dt, BYTE symbolValue)
{
    void* ptr = dt;
    FSE_DTableHeader* const DTableH = (FSE_DTableHeader*)ptr;
    void* dPtr = dt + 1;
    FSE_decode_t* const cell = (FSE_decode_t*)dPtr;

    DTableH->tableLog = 0;
    DTableH->fastMode = 0;

    cell->newState = 0;
    cell->symbol = symbolValue;
    cell->nbBits = 0;

    return 0;
}


size_t FSE_buildDTable_raw (FSE_DTable* dt, unsigned nbBits)
{
    void* ptr = dt;
    FSE_DTableHeader* const DTableH = (FSE_DTableHeader*)ptr;
    void* dPtr = dt + 1;
    FSE_decode_t* const dinfo = (FSE_decode_t*)dPtr;
    const unsigned tableSize = 1 << nbBits;
    const unsigned tableMask = tableSize - 1;
    const unsigned maxSV1 = tableMask+1;
    unsigned s;

    /* Sanity checks */
    if (nbBits < 1) return ERROR(GENERIC);         /* min size */

    /* Build Decoding Table */
    DTableH->tableLog = (U16)nbBits;
    DTableH->fastMode = 1;
    for (s=0; s<maxSV1; s++) {
        dinfo[s].newState = 0;
        dinfo[s].symbol = (BYTE)s;
        dinfo[s].nbBits = (BYTE)nbBits;
    }

    return 0;
}

FORCE_INLINE_TEMPLATE size_t FSE_decompress_usingDTable_generic(
          void* dst, size_t maxDstSize,
    const void* cSrc, size_t cSrcSize,
    const FSE_DTable* dt, const unsigned fast)
{
    BYTE* const ostart = (BYTE*) dst;
    BYTE* op = ostart;
    BYTE* const omax = op + maxDstSize;
    BYTE* const olimit = omax-3;

    BIT_DStream_t bitD;
    FSE_DState_t state1;
    FSE_DState_t state2;

    /* Init */
    CHECK_F(BIT_initDStream(&bitD, cSrc, cSrcSize));

    FSE_initDState(&state1, &bitD, dt);
    FSE_initDState(&state2, &bitD, dt);

#define FSE_GETSYMBOL(statePtr) fast ? FSE_decodeSymbolFast(statePtr, &bitD) : FSE_decodeSymbol(statePtr, &bitD)

    /* 4 symbols per loop */
    for ( ; (BIT_reloadDStream(&bitD)==BIT_DStream_unfinished) & (op<olimit) ; op+=4) {
        op[0] = FSE_GETSYMBOL(&state1);

        if (FSE_MAX_TABLELOG*2+7 > sizeof(bitD.bitContainer)*8)    /* This test must be static */
            BIT_reloadDStream(&bitD);

        op[1] = FSE_GETSYMBOL(&state2);

        if (FSE_MAX_TABLELOG*4+7 > sizeof(bitD.bitContainer)*8)    /* This test must be static */
            { if (BIT_reloadDStream(&bitD) > BIT_DStream_unfinished) { op+=2; break; } }

        op[2] = FSE_GETSYMBOL(&state1);

        if (FSE_MAX_TABLELOG*2+7 > sizeof(bitD.bitContainer)*8)    /* This test must be static */
            BIT_reloadDStream(&bitD);

        op[3] = FSE_GETSYMBOL(&state2);
    }

    /* tail */
    /* note : BIT_reloadDStream(&bitD) >= FSE_DStream_partiallyFilled; Ends at exactly BIT_DStream_completed */
    while (1) {
        if (op>(omax-2)) return ERROR(dstSize_tooSmall);
        *op++ = FSE_GETSYMBOL(&state1);
        if (BIT_reloadDStream(&bitD)==BIT_DStream_overflow) {
            *op++ = FSE_GETSYMBOL(&state2);
            break;
        }

        if (op>(omax-2)) return ERROR(dstSize_tooSmall);
        *op++ = FSE_GETSYMBOL(&state2);
        if (BIT_reloadDStream(&bitD)==BIT_DStream_overflow) {
            *op++ = FSE_GETSYMBOL(&state1);
            break;
    }   }

    return op-ostart;
}


size_t FSE_decompress_usingDTable(void* dst, size_t originalSize,
                            const void* cSrc, size_t cSrcSize,
                            const FSE_DTable* dt)
{
    const void* ptr = dt;
    const FSE_DTableHeader* DTableH = (const FSE_DTableHeader*)ptr;
    const U32 fastMode = DTableH->fastMode;

    /* select fast mode (static) */
    if (fastMode) return FSE_decompress_usingDTable_generic(dst, originalSize, cSrc, cSrcSize, dt, 1);
    return FSE_decompress_usingDTable_generic(dst, originalSize, cSrc, cSrcSize, dt, 0);
}


size_t FSE_decompress_wksp(void* dst, size_t dstCapacity, const void* cSrc, size_t cSrcSize, FSE_DTable* workSpace, unsigned maxLog)
{
    const BYTE* const istart = (const BYTE*)cSrc;
    const BYTE* ip = istart;
    short counting[FSE_MAX_SYMBOL_VALUE+1];
    unsigned tableLog;
    unsigned maxSymbolValue = FSE_MAX_SYMBOL_VALUE;

    /* normal FSE decoding mode */
    size_t const NCountLength = FSE_readNCount (counting, &maxSymbolValue, &tableLog, istart, cSrcSize);
    if (FSE_isError(NCountLength)) return NCountLength;
    /* if (NCountLength >= cSrcSize) return ERROR(srcSize_wrong); */  /* too small input size; supposed to be already checked in NCountLength, only remaining case : NCountLength==cSrcSize */
    if (tableLog > maxLog) return ERROR(tableLog_tooLarge);
    ip += NCountLength;
    cSrcSize -= NCountLength;

    CHECK_F( FSE_buildDTable (workSpace, counting, maxSymbolValue, tableLog) );

    return FSE_decompress_usingDTable (dst, dstCapacity, ip, cSrcSize, workSpace);   /* always return, even if it is an error code */
}


typedef FSE_DTable DTable_max_t[FSE_DTABLE_SIZE_U32(FSE_MAX_TABLELOG)];

size_t FSE_decompress(void* dst, size_t dstCapacity, const void* cSrc, size_t cSrcSize)
{
    DTable_max_t dt;   /* Static analyzer seems unable to understand this table will be properly initialized later */
    return FSE_decompress_wksp(dst, dstCapacity, cSrc, cSrcSize, dt, FSE_MAX_TABLELOG);
}



#endif   /* FSE_COMMONDEFS_ONLY */
/**** ended inlining common/fse_decompress.c ****/
/**** start inlining common/zstd_common.c ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */



/*-*************************************
*  Dependencies
***************************************/
/**** skipping file: error_private.h ****/
/**** start inlining zstd_internal.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_CCOMMON_H_MODULE
#define ZSTD_CCOMMON_H_MODULE

/* this module contains definitions which must be identical
 * across compression, decompression and dictBuilder.
 * It also contains a few functions useful to at least 2 of them
 * and which benefit from being inlined */

/*-*************************************
*  Dependencies
***************************************/
#ifdef __aarch64__
#include <arm_neon.h>
#endif
/**** skipping file: compiler.h ****/
/**** skipping file: mem.h ****/
/**** skipping file: debug.h ****/
/**** skipping file: error_private.h ****/
#define ZSTD_STATIC_LINKING_ONLY
/**** start inlining ../zstd.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */
#if defined (__cplusplus)
extern "C" {
#endif

#ifndef ZSTD_H_235446
#define ZSTD_H_235446

/* ======   Dependency   ======*/
#include <limits.h>   /* INT_MAX */
#include <stddef.h>   /* size_t */


/* =====   ZSTDLIB_API : control library symbols visibility   ===== */
#ifndef ZSTDLIB_VISIBILITY
#  if defined(__GNUC__) && (__GNUC__ >= 4)
#    define ZSTDLIB_VISIBILITY __attribute__ ((visibility ("default")))
#  else
#    define ZSTDLIB_VISIBILITY
#  endif
#endif
#if defined(ZSTD_DLL_EXPORT) && (ZSTD_DLL_EXPORT==1)
#  define ZSTDLIB_API __declspec(dllexport) ZSTDLIB_VISIBILITY
#elif defined(ZSTD_DLL_IMPORT) && (ZSTD_DLL_IMPORT==1)
#  define ZSTDLIB_API __declspec(dllimport) ZSTDLIB_VISIBILITY /* It isn't required but allows to generate better code, saving a function pointer load from the IAT and an indirect jump.*/
#else
#  define ZSTDLIB_API ZSTDLIB_VISIBILITY
#endif


/*******************************************************************************
  Introduction

  zstd, short for Zstandard, is a fast lossless compression algorithm, targeting
  real-time compression scenarios at zlib-level and better compression ratios.
  The zstd compression library provides in-memory compression and decompression
  functions.

  The library supports regular compression levels from 1 up to ZSTD_maxCLevel(),
  which is currently 22. Levels >= 20, labeled `--ultra`, should be used with
  caution, as they require more memory. The library also offers negative
  compression levels, which extend the range of speed vs. ratio preferences.
  The lower the level, the faster the speed (at the cost of compression).

  Compression can be done in:
    - a single step (described as Simple API)
    - a single step, reusing a context (described as Explicit context)
    - unbounded multiple steps (described as Streaming compression)

  The compression ratio achievable on small data can be highly improved using
  a dictionary. Dictionary compression can be performed in:
    - a single step (described as Simple dictionary API)
    - a single step, reusing a dictionary (described as Bulk-processing
      dictionary API)

  Advanced experimental functions can be accessed using
  `#define ZSTD_STATIC_LINKING_ONLY` before including zstd.h.

  Advanced experimental APIs should never be used with a dynamically-linked
  library. They are not "stable"; their definitions or signatures may change in
  the future. Only static linking is allowed.
*******************************************************************************/

/*------   Version   ------*/
#define ZSTD_VERSION_MAJOR    1
#define ZSTD_VERSION_MINOR    4
#define ZSTD_VERSION_RELEASE  5

#define ZSTD_VERSION_NUMBER  (ZSTD_VERSION_MAJOR *100*100 + ZSTD_VERSION_MINOR *100 + ZSTD_VERSION_RELEASE)
ZSTDLIB_API unsigned ZSTD_versionNumber(void);   /**< to check runtime library version */

#define ZSTD_LIB_VERSION ZSTD_VERSION_MAJOR.ZSTD_VERSION_MINOR.ZSTD_VERSION_RELEASE
#define ZSTD_QUOTE(str) #str
#define ZSTD_EXPAND_AND_QUOTE(str) ZSTD_QUOTE(str)
#define ZSTD_VERSION_STRING ZSTD_EXPAND_AND_QUOTE(ZSTD_LIB_VERSION)
ZSTDLIB_API const char* ZSTD_versionString(void);   /* requires v1.3.0+ */

/* *************************************
 *  Default constant
 ***************************************/
#ifndef ZSTD_CLEVEL_DEFAULT
#  define ZSTD_CLEVEL_DEFAULT 3
#endif

/* *************************************
 *  Constants
 ***************************************/

/* All magic numbers are supposed read/written to/from files/memory using little-endian convention */
#define ZSTD_MAGICNUMBER            0xFD2FB528    /* valid since v0.8.0 */
#define ZSTD_MAGIC_DICTIONARY       0xEC30A437    /* valid since v0.7.0 */
#define ZSTD_MAGIC_SKIPPABLE_START  0x184D2A50    /* all 16 values, from 0x184D2A50 to 0x184D2A5F, signal the beginning of a skippable frame */
#define ZSTD_MAGIC_SKIPPABLE_MASK   0xFFFFFFF0

#define ZSTD_BLOCKSIZELOG_MAX  17
#define ZSTD_BLOCKSIZE_MAX     (1<<ZSTD_BLOCKSIZELOG_MAX)



/***************************************
*  Simple API
***************************************/
/*! ZSTD_compress() :
 *  Compresses `src` content as a single zstd compressed frame into already allocated `dst`.
 *  Hint : compression runs faster if `dstCapacity` >=  `ZSTD_compressBound(srcSize)`.
 *  @return : compressed size written into `dst` (<= `dstCapacity),
 *            or an error code if it fails (which can be tested using ZSTD_isError()). */
ZSTDLIB_API size_t ZSTD_compress( void* dst, size_t dstCapacity,
                            const void* src, size_t srcSize,
                                  int compressionLevel);

/*! ZSTD_decompress() :
 *  `compressedSize` : must be the _exact_ size of some number of compressed and/or skippable frames.
 *  `dstCapacity` is an upper bound of originalSize to regenerate.
 *  If user cannot imply a maximum upper bound, it's better to use streaming mode to decompress data.
 *  @return : the number of bytes decompressed into `dst` (<= `dstCapacity`),
 *            or an errorCode if it fails (which can be tested using ZSTD_isError()). */
ZSTDLIB_API size_t ZSTD_decompress( void* dst, size_t dstCapacity,
                              const void* src, size_t compressedSize);

/*! ZSTD_getFrameContentSize() : requires v1.3.0+
 *  `src` should point to the start of a ZSTD encoded frame.
 *  `srcSize` must be at least as large as the frame header.
 *            hint : any size >= `ZSTD_frameHeaderSize_max` is large enough.
 *  @return : - decompressed size of `src` frame content, if known
 *            - ZSTD_CONTENTSIZE_UNKNOWN if the size cannot be determined
 *            - ZSTD_CONTENTSIZE_ERROR if an error occurred (e.g. invalid magic number, srcSize too small)
 *   note 1 : a 0 return value means the frame is valid but "empty".
 *   note 2 : decompressed size is an optional field, it may not be present, typically in streaming mode.
 *            When `return==ZSTD_CONTENTSIZE_UNKNOWN`, data to decompress could be any size.
 *            In which case, it's necessary to use streaming mode to decompress data.
 *            Optionally, application can rely on some implicit limit,
 *            as ZSTD_decompress() only needs an upper bound of decompressed size.
 *            (For example, data could be necessarily cut into blocks <= 16 KB).
 *   note 3 : decompressed size is always present when compression is completed using single-pass functions,
 *            such as ZSTD_compress(), ZSTD_compressCCtx() ZSTD_compress_usingDict() or ZSTD_compress_usingCDict().
 *   note 4 : decompressed size can be very large (64-bits value),
 *            potentially larger than what local system can handle as a single memory segment.
 *            In which case, it's necessary to use streaming mode to decompress data.
 *   note 5 : If source is untrusted, decompressed size could be wrong or intentionally modified.
 *            Always ensure return value fits within application's authorized limits.
 *            Each application can set its own limits.
 *   note 6 : This function replaces ZSTD_getDecompressedSize() */
#define ZSTD_CONTENTSIZE_UNKNOWN (0ULL - 1)
#define ZSTD_CONTENTSIZE_ERROR   (0ULL - 2)
ZSTDLIB_API unsigned long long ZSTD_getFrameContentSize(const void *src, size_t srcSize);

/*! ZSTD_getDecompressedSize() :
 *  NOTE: This function is now obsolete, in favor of ZSTD_getFrameContentSize().
 *  Both functions work the same way, but ZSTD_getDecompressedSize() blends
 *  "empty", "unknown" and "error" results to the same return value (0),
 *  while ZSTD_getFrameContentSize() gives them separate return values.
 * @return : decompressed size of `src` frame content _if known and not empty_, 0 otherwise. */
ZSTDLIB_API unsigned long long ZSTD_getDecompressedSize(const void* src, size_t srcSize);

/*! ZSTD_findFrameCompressedSize() :
 * `src` should point to the start of a ZSTD frame or skippable frame.
 * `srcSize` must be >= first frame size
 * @return : the compressed size of the first frame starting at `src`,
 *           suitable to pass as `srcSize` to `ZSTD_decompress` or similar,
 *        or an error code if input is invalid */
ZSTDLIB_API size_t ZSTD_findFrameCompressedSize(const void* src, size_t srcSize);


/*======  Helper functions  ======*/
#define ZSTD_COMPRESSBOUND(srcSize)   ((srcSize) + ((srcSize)>>8) + (((srcSize) < (128<<10)) ? (((128<<10) - (srcSize)) >> 11) /* margin, from 64 to 0 */ : 0))  /* this formula ensures that bound(A) + bound(B) <= bound(A+B) as long as A and B >= 128 KB */
ZSTDLIB_API size_t      ZSTD_compressBound(size_t srcSize); /*!< maximum compressed size in worst case single-pass scenario */
ZSTDLIB_API unsigned    ZSTD_isError(size_t code);          /*!< tells if a `size_t` function result is an error code */
ZSTDLIB_API const char* ZSTD_getErrorName(size_t code);     /*!< provides readable string from an error code */
ZSTDLIB_API int         ZSTD_minCLevel(void);               /*!< minimum negative compression level allowed */
ZSTDLIB_API int         ZSTD_maxCLevel(void);               /*!< maximum compression level available */


/***************************************
*  Explicit context
***************************************/
/*= Compression context
 *  When compressing many times,
 *  it is recommended to allocate a context just once,
 *  and re-use it for each successive compression operation.
 *  This will make workload friendlier for system's memory.
 *  Note : re-using context is just a speed / resource optimization.
 *         It doesn't change the compression ratio, which remains identical.
 *  Note 2 : In multi-threaded environments,
 *         use one different context per thread for parallel execution.
 */
typedef struct ZSTD_CCtx_s ZSTD_CCtx;
ZSTDLIB_API ZSTD_CCtx* ZSTD_createCCtx(void);
ZSTDLIB_API size_t     ZSTD_freeCCtx(ZSTD_CCtx* cctx);

/*! ZSTD_compressCCtx() :
 *  Same as ZSTD_compress(), using an explicit ZSTD_CCtx.
 *  Important : in order to behave similarly to `ZSTD_compress()`,
 *  this function compresses at requested compression level,
 *  __ignoring any other parameter__ .
 *  If any advanced parameter was set using the advanced API,
 *  they will all be reset. Only `compressionLevel` remains.
 */
ZSTDLIB_API size_t ZSTD_compressCCtx(ZSTD_CCtx* cctx,
                                     void* dst, size_t dstCapacity,
                               const void* src, size_t srcSize,
                                     int compressionLevel);

/*= Decompression context
 *  When decompressing many times,
 *  it is recommended to allocate a context only once,
 *  and re-use it for each successive compression operation.
 *  This will make workload friendlier for system's memory.
 *  Use one context per thread for parallel execution. */
typedef struct ZSTD_DCtx_s ZSTD_DCtx;
ZSTDLIB_API ZSTD_DCtx* ZSTD_createDCtx(void);
ZSTDLIB_API size_t     ZSTD_freeDCtx(ZSTD_DCtx* dctx);

/*! ZSTD_decompressDCtx() :
 *  Same as ZSTD_decompress(),
 *  requires an allocated ZSTD_DCtx.
 *  Compatible with sticky parameters.
 */
ZSTDLIB_API size_t ZSTD_decompressDCtx(ZSTD_DCtx* dctx,
                                       void* dst, size_t dstCapacity,
                                 const void* src, size_t srcSize);


/***************************************
*  Advanced compression API
***************************************/

/* API design :
 *   Parameters are pushed one by one into an existing context,
 *   using ZSTD_CCtx_set*() functions.
 *   Pushed parameters are sticky : they are valid for next compressed frame, and any subsequent frame.
 *   "sticky" parameters are applicable to `ZSTD_compress2()` and `ZSTD_compressStream*()` !
 *   __They do not apply to "simple" one-shot variants such as ZSTD_compressCCtx()__ .
 *
 *   It's possible to reset all parameters to "default" using ZSTD_CCtx_reset().
 *
 *   This API supercedes all other "advanced" API entry points in the experimental section.
 *   In the future, we expect to remove from experimental API entry points which are redundant with this API.
 */


/* Compression strategies, listed from fastest to strongest */
typedef enum { ZSTD_fast=1,
               ZSTD_dfast=2,
               ZSTD_greedy=3,
               ZSTD_lazy=4,
               ZSTD_lazy2=5,
               ZSTD_btlazy2=6,
               ZSTD_btopt=7,
               ZSTD_btultra=8,
               ZSTD_btultra2=9
               /* note : new strategies _might_ be added in the future.
                         Only the order (from fast to strong) is guaranteed */
} ZSTD_strategy;


typedef enum {

    /* compression parameters
     * Note: When compressing with a ZSTD_CDict these parameters are superseded
     * by the parameters used to construct the ZSTD_CDict.
     * See ZSTD_CCtx_refCDict() for more info (superseded-by-cdict). */
    ZSTD_c_compressionLevel=100, /* Set compression parameters according to pre-defined cLevel table.
                              * Note that exact compression parameters are dynamically determined,
                              * depending on both compression level and srcSize (when known).
                              * Default level is ZSTD_CLEVEL_DEFAULT==3.
                              * Special: value 0 means default, which is controlled by ZSTD_CLEVEL_DEFAULT.
                              * Note 1 : it's possible to pass a negative compression level.
                              * Note 2 : setting a level does not automatically set all other compression parameters
                              *   to default. Setting this will however eventually dynamically impact the compression
                              *   parameters which have not been manually set. The manually set
                              *   ones will 'stick'. */
    /* Advanced compression parameters :
     * It's possible to pin down compression parameters to some specific values.
     * In which case, these values are no longer dynamically selected by the compressor */
    ZSTD_c_windowLog=101,    /* Maximum allowed back-reference distance, expressed as power of 2.
                              * This will set a memory budget for streaming decompression,
                              * with larger values requiring more memory
                              * and typically compressing more.
                              * Must be clamped between ZSTD_WINDOWLOG_MIN and ZSTD_WINDOWLOG_MAX.
                              * Special: value 0 means "use default windowLog".
                              * Note: Using a windowLog greater than ZSTD_WINDOWLOG_LIMIT_DEFAULT
                              *       requires explicitly allowing such size at streaming decompression stage. */
    ZSTD_c_hashLog=102,      /* Size of the initial probe table, as a power of 2.
                              * Resulting memory usage is (1 << (hashLog+2)).
                              * Must be clamped between ZSTD_HASHLOG_MIN and ZSTD_HASHLOG_MAX.
                              * Larger tables improve compression ratio of strategies <= dFast,
                              * and improve speed of strategies > dFast.
                              * Special: value 0 means "use default hashLog". */
    ZSTD_c_chainLog=103,     /* Size of the multi-probe search table, as a power of 2.
                              * Resulting memory usage is (1 << (chainLog+2)).
                              * Must be clamped between ZSTD_CHAINLOG_MIN and ZSTD_CHAINLOG_MAX.
                              * Larger tables result in better and slower compression.
                              * This parameter is useless for "fast" strategy.
                              * It's still useful when using "dfast" strategy,
                              * in which case it defines a secondary probe table.
                              * Special: value 0 means "use default chainLog". */
    ZSTD_c_searchLog=104,    /* Number of search attempts, as a power of 2.
                              * More attempts result in better and slower compression.
                              * This parameter is useless for "fast" and "dFast" strategies.
                              * Special: value 0 means "use default searchLog". */
    ZSTD_c_minMatch=105,     /* Minimum size of searched matches.
                              * Note that Zstandard can still find matches of smaller size,
                              * it just tweaks its search algorithm to look for this size and larger.
                              * Larger values increase compression and decompression speed, but decrease ratio.
                              * Must be clamped between ZSTD_MINMATCH_MIN and ZSTD_MINMATCH_MAX.
                              * Note that currently, for all strategies < btopt, effective minimum is 4.
                              *                    , for all strategies > fast, effective maximum is 6.
                              * Special: value 0 means "use default minMatchLength". */
    ZSTD_c_targetLength=106, /* Impact of this field depends on strategy.
                              * For strategies btopt, btultra & btultra2:
                              *     Length of Match considered "good enough" to stop search.
                              *     Larger values make compression stronger, and slower.
                              * For strategy fast:
                              *     Distance between match sampling.
                              *     Larger values make compression faster, and weaker.
                              * Special: value 0 means "use default targetLength". */
    ZSTD_c_strategy=107,     /* See ZSTD_strategy enum definition.
                              * The higher the value of selected strategy, the more complex it is,
                              * resulting in stronger and slower compression.
                              * Special: value 0 means "use default strategy". */

    /* LDM mode parameters */
    ZSTD_c_enableLongDistanceMatching=160, /* Enable long distance matching.
                                     * This parameter is designed to improve compression ratio
                                     * for large inputs, by finding large matches at long distance.
                                     * It increases memory usage and window size.
                                     * Note: enabling this parameter increases default ZSTD_c_windowLog to 128 MB
                                     * except when expressly set to a different value. */
    ZSTD_c_ldmHashLog=161,   /* Size of the table for long distance matching, as a power of 2.
                              * Larger values increase memory usage and compression ratio,
                              * but decrease compression speed.
                              * Must be clamped between ZSTD_HASHLOG_MIN and ZSTD_HASHLOG_MAX
                              * default: windowlog - 7.
                              * Special: value 0 means "automatically determine hashlog". */
    ZSTD_c_ldmMinMatch=162,  /* Minimum match size for long distance matcher.
                              * Larger/too small values usually decrease compression ratio.
                              * Must be clamped between ZSTD_LDM_MINMATCH_MIN and ZSTD_LDM_MINMATCH_MAX.
                              * Special: value 0 means "use default value" (default: 64). */
    ZSTD_c_ldmBucketSizeLog=163, /* Log size of each bucket in the LDM hash table for collision resolution.
                              * Larger values improve collision resolution but decrease compression speed.
                              * The maximum value is ZSTD_LDM_BUCKETSIZELOG_MAX.
                              * Special: value 0 means "use default value" (default: 3). */
    ZSTD_c_ldmHashRateLog=164, /* Frequency of inserting/looking up entries into the LDM hash table.
                              * Must be clamped between 0 and (ZSTD_WINDOWLOG_MAX - ZSTD_HASHLOG_MIN).
                              * Default is MAX(0, (windowLog - ldmHashLog)), optimizing hash table usage.
                              * Larger values improve compression speed.
                              * Deviating far from default value will likely result in a compression ratio decrease.
                              * Special: value 0 means "automatically determine hashRateLog". */

    /* frame parameters */
    ZSTD_c_contentSizeFlag=200, /* Content size will be written into frame header _whenever known_ (default:1)
                              * Content size must be known at the beginning of compression.
                              * This is automatically the case when using ZSTD_compress2(),
                              * For streaming scenarios, content size must be provided with ZSTD_CCtx_setPledgedSrcSize() */
    ZSTD_c_checksumFlag=201, /* A 32-bits checksum of content is written at end of frame (default:0) */
    ZSTD_c_dictIDFlag=202,   /* When applicable, dictionary's ID is written into frame header (default:1) */

    /* multi-threading parameters */
    /* These parameters are only useful if multi-threading is enabled (compiled with build macro ZSTD_MULTITHREAD).
     * They return an error otherwise. */
    ZSTD_c_nbWorkers=400,    /* Select how many threads will be spawned to compress in parallel.
                              * When nbWorkers >= 1, triggers asynchronous mode when used with ZSTD_compressStream*() :
                              * ZSTD_compressStream*() consumes input and flush output if possible, but immediately gives back control to caller,
                              * while compression work is performed in parallel, within worker threads.
                              * (note : a strong exception to this rule is when first invocation of ZSTD_compressStream2() sets ZSTD_e_end :
                              *  in which case, ZSTD_compressStream2() delegates to ZSTD_compress2(), which is always a blocking call).
                              * More workers improve speed, but also increase memory usage.
                              * Default value is `0`, aka "single-threaded mode" : no worker is spawned, compression is performed inside Caller's thread, all invocations are blocking */
    ZSTD_c_jobSize=401,      /* Size of a compression job. This value is enforced only when nbWorkers >= 1.
                              * Each compression job is completed in parallel, so this value can indirectly impact the nb of active threads.
                              * 0 means default, which is dynamically determined based on compression parameters.
                              * Job size must be a minimum of overlap size, or 1 MB, whichever is largest.
                              * The minimum size is automatically and transparently enforced. */
    ZSTD_c_overlapLog=402,   /* Control the overlap size, as a fraction of window size.
                              * The overlap size is an amount of data reloaded from previous job at the beginning of a new job.
                              * It helps preserve compression ratio, while each job is compressed in parallel.
                              * This value is enforced only when nbWorkers >= 1.
                              * Larger values increase compression ratio, but decrease speed.
                              * Possible values range from 0 to 9 :
                              * - 0 means "default" : value will be determined by the library, depending on strategy
                              * - 1 means "no overlap"
                              * - 9 means "full overlap", using a full window size.
                              * Each intermediate rank increases/decreases load size by a factor 2 :
                              * 9: full window;  8: w/2;  7: w/4;  6: w/8;  5:w/16;  4: w/32;  3:w/64;  2:w/128;  1:no overlap;  0:default
                              * default value varies between 6 and 9, depending on strategy */

    /* note : additional experimental parameters are also available
     * within the experimental section of the API.
     * At the time of this writing, they include :
     * ZSTD_c_rsyncable
     * ZSTD_c_format
     * ZSTD_c_forceMaxWindow
     * ZSTD_c_forceAttachDict
     * ZSTD_c_literalCompressionMode
     * ZSTD_c_targetCBlockSize
     * ZSTD_c_srcSizeHint
     * Because they are not stable, it's necessary to define ZSTD_STATIC_LINKING_ONLY to access them.
     * note : never ever use experimentalParam? names directly;
     *        also, the enums values themselves are unstable and can still change.
     */
     ZSTD_c_experimentalParam1=500,
     ZSTD_c_experimentalParam2=10,
     ZSTD_c_experimentalParam3=1000,
     ZSTD_c_experimentalParam4=1001,
     ZSTD_c_experimentalParam5=1002,
     ZSTD_c_experimentalParam6=1003,
     ZSTD_c_experimentalParam7=1004
} ZSTD_cParameter;

typedef struct {
    size_t error;
    int lowerBound;
    int upperBound;
} ZSTD_bounds;

/*! ZSTD_cParam_getBounds() :
 *  All parameters must belong to an interval with lower and upper bounds,
 *  otherwise they will either trigger an error or be automatically clamped.
 * @return : a structure, ZSTD_bounds, which contains
 *         - an error status field, which must be tested using ZSTD_isError()
 *         - lower and upper bounds, both inclusive
 */
ZSTDLIB_API ZSTD_bounds ZSTD_cParam_getBounds(ZSTD_cParameter cParam);

/*! ZSTD_CCtx_setParameter() :
 *  Set one compression parameter, selected by enum ZSTD_cParameter.
 *  All parameters have valid bounds. Bounds can be queried using ZSTD_cParam_getBounds().
 *  Providing a value beyond bound will either clamp it, or trigger an error (depending on parameter).
 *  Setting a parameter is generally only possible during frame initialization (before starting compression).
 *  Exception : when using multi-threading mode (nbWorkers >= 1),
 *              the following parameters can be updated _during_ compression (within same frame):
 *              => compressionLevel, hashLog, chainLog, searchLog, minMatch, targetLength and strategy.
 *              new parameters will be active for next job only (after a flush()).
 * @return : an error code (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_CCtx_setParameter(ZSTD_CCtx* cctx, ZSTD_cParameter param, int value);

/*! ZSTD_CCtx_setPledgedSrcSize() :
 *  Total input data size to be compressed as a single frame.
 *  Value will be written in frame header, unless if explicitly forbidden using ZSTD_c_contentSizeFlag.
 *  This value will also be controlled at end of frame, and trigger an error if not respected.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Note 1 : pledgedSrcSize==0 actually means zero, aka an empty frame.
 *           In order to mean "unknown content size", pass constant ZSTD_CONTENTSIZE_UNKNOWN.
 *           ZSTD_CONTENTSIZE_UNKNOWN is default value for any new frame.
 *  Note 2 : pledgedSrcSize is only valid once, for the next frame.
 *           It's discarded at the end of the frame, and replaced by ZSTD_CONTENTSIZE_UNKNOWN.
 *  Note 3 : Whenever all input data is provided and consumed in a single round,
 *           for example with ZSTD_compress2(),
 *           or invoking immediately ZSTD_compressStream2(,,,ZSTD_e_end),
 *           this value is automatically overridden by srcSize instead.
 */
ZSTDLIB_API size_t ZSTD_CCtx_setPledgedSrcSize(ZSTD_CCtx* cctx, unsigned long long pledgedSrcSize);

typedef enum {
    ZSTD_reset_session_only = 1,
    ZSTD_reset_parameters = 2,
    ZSTD_reset_session_and_parameters = 3
} ZSTD_ResetDirective;

/*! ZSTD_CCtx_reset() :
 *  There are 2 different things that can be reset, independently or jointly :
 *  - The session : will stop compressing current frame, and make CCtx ready to start a new one.
 *                  Useful after an error, or to interrupt any ongoing compression.
 *                  Any internal data not yet flushed is cancelled.
 *                  Compression parameters and dictionary remain unchanged.
 *                  They will be used to compress next frame.
 *                  Resetting session never fails.
 *  - The parameters : changes all parameters back to "default".
 *                  This removes any reference to any dictionary too.
 *                  Parameters can only be changed between 2 sessions (i.e. no compression is currently ongoing)
 *                  otherwise the reset fails, and function returns an error value (which can be tested using ZSTD_isError())
 *  - Both : similar to resetting the session, followed by resetting parameters.
 */
ZSTDLIB_API size_t ZSTD_CCtx_reset(ZSTD_CCtx* cctx, ZSTD_ResetDirective reset);

/*! ZSTD_compress2() :
 *  Behave the same as ZSTD_compressCCtx(), but compression parameters are set using the advanced API.
 *  ZSTD_compress2() always starts a new frame.
 *  Should cctx hold data from a previously unfinished frame, everything about it is forgotten.
 *  - Compression parameters are pushed into CCtx before starting compression, using ZSTD_CCtx_set*()
 *  - The function is always blocking, returns when compression is completed.
 *  Hint : compression runs faster if `dstCapacity` >=  `ZSTD_compressBound(srcSize)`.
 * @return : compressed size written into `dst` (<= `dstCapacity),
 *           or an error code if it fails (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_compress2( ZSTD_CCtx* cctx,
                                   void* dst, size_t dstCapacity,
                             const void* src, size_t srcSize);


/***************************************
*  Advanced decompression API
***************************************/

/* The advanced API pushes parameters one by one into an existing DCtx context.
 * Parameters are sticky, and remain valid for all following frames
 * using the same DCtx context.
 * It's possible to reset parameters to default values using ZSTD_DCtx_reset().
 * Note : This API is compatible with existing ZSTD_decompressDCtx() and ZSTD_decompressStream().
 *        Therefore, no new decompression function is necessary.
 */

typedef enum {

    ZSTD_d_windowLogMax=100, /* Select a size limit (in power of 2) beyond which
                              * the streaming API will refuse to allocate memory buffer
                              * in order to protect the host from unreasonable memory requirements.
                              * This parameter is only useful in streaming mode, since no internal buffer is allocated in single-pass mode.
                              * By default, a decompression context accepts window sizes <= (1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT).
                              * Special: value 0 means "use default maximum windowLog". */

    /* note : additional experimental parameters are also available
     * within the experimental section of the API.
     * At the time of this writing, they include :
     * ZSTD_d_format
     * ZSTD_d_stableOutBuffer
     * Because they are not stable, it's necessary to define ZSTD_STATIC_LINKING_ONLY to access them.
     * note : never ever use experimentalParam? names directly
     */
     ZSTD_d_experimentalParam1=1000,
     ZSTD_d_experimentalParam2=1001

} ZSTD_dParameter;

/*! ZSTD_dParam_getBounds() :
 *  All parameters must belong to an interval with lower and upper bounds,
 *  otherwise they will either trigger an error or be automatically clamped.
 * @return : a structure, ZSTD_bounds, which contains
 *         - an error status field, which must be tested using ZSTD_isError()
 *         - both lower and upper bounds, inclusive
 */
ZSTDLIB_API ZSTD_bounds ZSTD_dParam_getBounds(ZSTD_dParameter dParam);

/*! ZSTD_DCtx_setParameter() :
 *  Set one compression parameter, selected by enum ZSTD_dParameter.
 *  All parameters have valid bounds. Bounds can be queried using ZSTD_dParam_getBounds().
 *  Providing a value beyond bound will either clamp it, or trigger an error (depending on parameter).
 *  Setting a parameter is only possible during frame initialization (before starting decompression).
 * @return : 0, or an error code (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_DCtx_setParameter(ZSTD_DCtx* dctx, ZSTD_dParameter param, int value);

/*! ZSTD_DCtx_reset() :
 *  Return a DCtx to clean state.
 *  Session and parameters can be reset jointly or separately.
 *  Parameters can only be reset when no active frame is being decompressed.
 * @return : 0, or an error code, which can be tested with ZSTD_isError()
 */
ZSTDLIB_API size_t ZSTD_DCtx_reset(ZSTD_DCtx* dctx, ZSTD_ResetDirective reset);


/****************************
*  Streaming
****************************/

typedef struct ZSTD_inBuffer_s {
  const void* src;    /**< start of input buffer */
  size_t size;        /**< size of input buffer */
  size_t pos;         /**< position where reading stopped. Will be updated. Necessarily 0 <= pos <= size */
} ZSTD_inBuffer;

typedef struct ZSTD_outBuffer_s {
  void*  dst;         /**< start of output buffer */
  size_t size;        /**< size of output buffer */
  size_t pos;         /**< position where writing stopped. Will be updated. Necessarily 0 <= pos <= size */
} ZSTD_outBuffer;



/*-***********************************************************************
*  Streaming compression - HowTo
*
*  A ZSTD_CStream object is required to track streaming operation.
*  Use ZSTD_createCStream() and ZSTD_freeCStream() to create/release resources.
*  ZSTD_CStream objects can be reused multiple times on consecutive compression operations.
*  It is recommended to re-use ZSTD_CStream since it will play nicer with system's memory, by re-using already allocated memory.
*
*  For parallel execution, use one separate ZSTD_CStream per thread.
*
*  note : since v1.3.0, ZSTD_CStream and ZSTD_CCtx are the same thing.
*
*  Parameters are sticky : when starting a new compression on the same context,
*  it will re-use the same sticky parameters as previous compression session.
*  When in doubt, it's recommended to fully initialize the context before usage.
*  Use ZSTD_CCtx_reset() to reset the context and ZSTD_CCtx_setParameter(),
*  ZSTD_CCtx_setPledgedSrcSize(), or ZSTD_CCtx_loadDictionary() and friends to
*  set more specific parameters, the pledged source size, or load a dictionary.
*
*  Use ZSTD_compressStream2() with ZSTD_e_continue as many times as necessary to
*  consume input stream. The function will automatically update both `pos`
*  fields within `input` and `output`.
*  Note that the function may not consume the entire input, for example, because
*  the output buffer is already full, in which case `input.pos < input.size`.
*  The caller must check if input has been entirely consumed.
*  If not, the caller must make some room to receive more compressed data,
*  and then present again remaining input data.
*  note: ZSTD_e_continue is guaranteed to make some forward progress when called,
*        but doesn't guarantee maximal forward progress. This is especially relevant
*        when compressing with multiple threads. The call won't block if it can
*        consume some input, but if it can't it will wait for some, but not all,
*        output to be flushed.
* @return : provides a minimum amount of data remaining to be flushed from internal buffers
*           or an error code, which can be tested using ZSTD_isError().
*
*  At any moment, it's possible to flush whatever data might remain stuck within internal buffer,
*  using ZSTD_compressStream2() with ZSTD_e_flush. `output->pos` will be updated.
*  Note that, if `output->size` is too small, a single invocation with ZSTD_e_flush might not be enough (return code > 0).
*  In which case, make some room to receive more compressed data, and call again ZSTD_compressStream2() with ZSTD_e_flush.
*  You must continue calling ZSTD_compressStream2() with ZSTD_e_flush until it returns 0, at which point you can change the
*  operation.
*  note: ZSTD_e_flush will flush as much output as possible, meaning when compressing with multiple threads, it will
*        block until the flush is complete or the output buffer is full.
*  @return : 0 if internal buffers are entirely flushed,
*            >0 if some data still present within internal buffer (the value is minimal estimation of remaining size),
*            or an error code, which can be tested using ZSTD_isError().
*
*  Calling ZSTD_compressStream2() with ZSTD_e_end instructs to finish a frame.
*  It will perform a flush and write frame epilogue.
*  The epilogue is required for decoders to consider a frame completed.
*  flush operation is the same, and follows same rules as calling ZSTD_compressStream2() with ZSTD_e_flush.
*  You must continue calling ZSTD_compressStream2() with ZSTD_e_end until it returns 0, at which point you are free to
*  start a new frame.
*  note: ZSTD_e_end will flush as much output as possible, meaning when compressing with multiple threads, it will
*        block until the flush is complete or the output buffer is full.
*  @return : 0 if frame fully completed and fully flushed,
*            >0 if some data still present within internal buffer (the value is minimal estimation of remaining size),
*            or an error code, which can be tested using ZSTD_isError().
*
* *******************************************************************/

typedef ZSTD_CCtx ZSTD_CStream;  /**< CCtx and CStream are now effectively same object (>= v1.3.0) */
                                 /* Continue to distinguish them for compatibility with older versions <= v1.2.0 */
/*===== ZSTD_CStream management functions =====*/
ZSTDLIB_API ZSTD_CStream* ZSTD_createCStream(void);
ZSTDLIB_API size_t ZSTD_freeCStream(ZSTD_CStream* zcs);

/*===== Streaming compression functions =====*/
typedef enum {
    ZSTD_e_continue=0, /* collect more data, encoder decides when to output compressed result, for optimal compression ratio */
    ZSTD_e_flush=1,    /* flush any data provided so far,
                        * it creates (at least) one new block, that can be decoded immediately on reception;
                        * frame will continue: any future data can still reference previously compressed data, improving compression.
                        * note : multithreaded compression will block to flush as much output as possible. */
    ZSTD_e_end=2       /* flush any remaining data _and_ close current frame.
                        * note that frame is only closed after compressed data is fully flushed (return value == 0).
                        * After that point, any additional data starts a new frame.
                        * note : each frame is independent (does not reference any content from previous frame).
                        : note : multithreaded compression will block to flush as much output as possible. */
} ZSTD_EndDirective;

/*! ZSTD_compressStream2() :
 *  Behaves about the same as ZSTD_compressStream, with additional control on end directive.
 *  - Compression parameters are pushed into CCtx before starting compression, using ZSTD_CCtx_set*()
 *  - Compression parameters cannot be changed once compression is started (save a list of exceptions in multi-threading mode)
 *  - output->pos must be <= dstCapacity, input->pos must be <= srcSize
 *  - output->pos and input->pos will be updated. They are guaranteed to remain below their respective limit.
 *  - When nbWorkers==0 (default), function is blocking : it completes its job before returning to caller.
 *  - When nbWorkers>=1, function is non-blocking : it just acquires a copy of input, and distributes jobs to internal worker threads, flush whatever is available,
 *                                                  and then immediately returns, just indicating that there is some data remaining to be flushed.
 *                                                  The function nonetheless guarantees forward progress : it will return only after it reads or write at least 1+ byte.
 *  - Exception : if the first call requests a ZSTD_e_end directive and provides enough dstCapacity, the function delegates to ZSTD_compress2() which is always blocking.
 *  - @return provides a minimum amount of data remaining to be flushed from internal buffers
 *            or an error code, which can be tested using ZSTD_isError().
 *            if @return != 0, flush is not fully completed, there is still some data left within internal buffers.
 *            This is useful for ZSTD_e_flush, since in this case more flushes are necessary to empty all buffers.
 *            For ZSTD_e_end, @return == 0 when internal buffers are fully flushed and frame is completed.
 *  - after a ZSTD_e_end directive, if internal buffer is not fully flushed (@return != 0),
 *            only ZSTD_e_end or ZSTD_e_flush operations are allowed.
 *            Before starting a new compression job, or changing compression parameters,
 *            it is required to fully flush internal buffers.
 */
ZSTDLIB_API size_t ZSTD_compressStream2( ZSTD_CCtx* cctx,
                                         ZSTD_outBuffer* output,
                                         ZSTD_inBuffer* input,
                                         ZSTD_EndDirective endOp);


/* These buffer sizes are softly recommended.
 * They are not required : ZSTD_compressStream*() happily accepts any buffer size, for both input and output.
 * Respecting the recommended size just makes it a bit easier for ZSTD_compressStream*(),
 * reducing the amount of memory shuffling and buffering, resulting in minor performance savings.
 *
 * However, note that these recommendations are from the perspective of a C caller program.
 * If the streaming interface is invoked from some other language,
 * especially managed ones such as Java or Go, through a foreign function interface such as jni or cgo,
 * a major performance rule is to reduce crossing such interface to an absolute minimum.
 * It's not rare that performance ends being spent more into the interface, rather than compression itself.
 * In which cases, prefer using large buffers, as large as practical,
 * for both input and output, to reduce the nb of roundtrips.
 */
ZSTDLIB_API size_t ZSTD_CStreamInSize(void);    /**< recommended size for input buffer */
ZSTDLIB_API size_t ZSTD_CStreamOutSize(void);   /**< recommended size for output buffer. Guarantee to successfully flush at least one complete compressed block. */


/* *****************************************************************************
 * This following is a legacy streaming API.
 * It can be replaced by ZSTD_CCtx_reset() and ZSTD_compressStream2().
 * It is redundant, but remains fully supported.
 * Advanced parameters and dictionary compression can only be used through the
 * new API.
 ******************************************************************************/

/*!
 * Equivalent to:
 *
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_refCDict(zcs, NULL); // clear the dictionary (if any)
 *     ZSTD_CCtx_setParameter(zcs, ZSTD_c_compressionLevel, compressionLevel);
 */
ZSTDLIB_API size_t ZSTD_initCStream(ZSTD_CStream* zcs, int compressionLevel);
/*!
 * Alternative for ZSTD_compressStream2(zcs, output, input, ZSTD_e_continue).
 * NOTE: The return value is different. ZSTD_compressStream() returns a hint for
 * the next read size (if non-zero and not an error). ZSTD_compressStream2()
 * returns the minimum nb of bytes left to flush (if non-zero and not an error).
 */
ZSTDLIB_API size_t ZSTD_compressStream(ZSTD_CStream* zcs, ZSTD_outBuffer* output, ZSTD_inBuffer* input);
/*! Equivalent to ZSTD_compressStream2(zcs, output, &emptyInput, ZSTD_e_flush). */
ZSTDLIB_API size_t ZSTD_flushStream(ZSTD_CStream* zcs, ZSTD_outBuffer* output);
/*! Equivalent to ZSTD_compressStream2(zcs, output, &emptyInput, ZSTD_e_end). */
ZSTDLIB_API size_t ZSTD_endStream(ZSTD_CStream* zcs, ZSTD_outBuffer* output);


/*-***************************************************************************
*  Streaming decompression - HowTo
*
*  A ZSTD_DStream object is required to track streaming operations.
*  Use ZSTD_createDStream() and ZSTD_freeDStream() to create/release resources.
*  ZSTD_DStream objects can be re-used multiple times.
*
*  Use ZSTD_initDStream() to start a new decompression operation.
* @return : recommended first input size
*  Alternatively, use advanced API to set specific properties.
*
*  Use ZSTD_decompressStream() repetitively to consume your input.
*  The function will update both `pos` fields.
*  If `input.pos < input.size`, some input has not been consumed.
*  It's up to the caller to present again remaining data.
*  The function tries to flush all data decoded immediately, respecting output buffer size.
*  If `output.pos < output.size`, decoder has flushed everything it could.
*  But if `output.pos == output.size`, there might be some data left within internal buffers.,
*  In which case, call ZSTD_decompressStream() again to flush whatever remains in the buffer.
*  Note : with no additional input provided, amount of data flushed is necessarily <= ZSTD_BLOCKSIZE_MAX.
* @return : 0 when a frame is completely decoded and fully flushed,
*        or an error code, which can be tested using ZSTD_isError(),
*        or any other value > 0, which means there is still some decoding or flushing to do to complete current frame :
*                                the return value is a suggested next input size (just a hint for better latency)
*                                that will never request more than the remaining frame size.
* *******************************************************************************/

typedef ZSTD_DCtx ZSTD_DStream;  /**< DCtx and DStream are now effectively same object (>= v1.3.0) */
                                 /* For compatibility with versions <= v1.2.0, prefer differentiating them. */
/*===== ZSTD_DStream management functions =====*/
ZSTDLIB_API ZSTD_DStream* ZSTD_createDStream(void);
ZSTDLIB_API size_t ZSTD_freeDStream(ZSTD_DStream* zds);

/*===== Streaming decompression functions =====*/

/* This function is redundant with the advanced API and equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *     ZSTD_DCtx_refDDict(zds, NULL);
 */
ZSTDLIB_API size_t ZSTD_initDStream(ZSTD_DStream* zds);

ZSTDLIB_API size_t ZSTD_decompressStream(ZSTD_DStream* zds, ZSTD_outBuffer* output, ZSTD_inBuffer* input);

ZSTDLIB_API size_t ZSTD_DStreamInSize(void);    /*!< recommended size for input buffer */
ZSTDLIB_API size_t ZSTD_DStreamOutSize(void);   /*!< recommended size for output buffer. Guarantee to successfully flush at least one complete block in all circumstances. */


/**************************
*  Simple dictionary API
***************************/
/*! ZSTD_compress_usingDict() :
 *  Compression at an explicit compression level using a Dictionary.
 *  A dictionary can be any arbitrary data segment (also called a prefix),
 *  or a buffer with specified information (see dictBuilder/zdict.h).
 *  Note : This function loads the dictionary, resulting in significant startup delay.
 *         It's intended for a dictionary used only once.
 *  Note 2 : When `dict == NULL || dictSize < 8` no dictionary is used. */
ZSTDLIB_API size_t ZSTD_compress_usingDict(ZSTD_CCtx* ctx,
                                           void* dst, size_t dstCapacity,
                                     const void* src, size_t srcSize,
                                     const void* dict,size_t dictSize,
                                           int compressionLevel);

/*! ZSTD_decompress_usingDict() :
 *  Decompression using a known Dictionary.
 *  Dictionary must be identical to the one used during compression.
 *  Note : This function loads the dictionary, resulting in significant startup delay.
 *         It's intended for a dictionary used only once.
 *  Note : When `dict == NULL || dictSize < 8` no dictionary is used. */
ZSTDLIB_API size_t ZSTD_decompress_usingDict(ZSTD_DCtx* dctx,
                                             void* dst, size_t dstCapacity,
                                       const void* src, size_t srcSize,
                                       const void* dict,size_t dictSize);


/***********************************
 *  Bulk processing dictionary API
 **********************************/
typedef struct ZSTD_CDict_s ZSTD_CDict;

/*! ZSTD_createCDict() :
 *  When compressing multiple messages or blocks using the same dictionary,
 *  it's recommended to digest the dictionary only once, since it's a costly operation.
 *  ZSTD_createCDict() will create a state from digesting a dictionary.
 *  The resulting state can be used for future compression operations with very limited startup cost.
 *  ZSTD_CDict can be created once and shared by multiple threads concurrently, since its usage is read-only.
 * @dictBuffer can be released after ZSTD_CDict creation, because its content is copied within CDict.
 *  Note 1 : Consider experimental function `ZSTD_createCDict_byReference()` if you prefer to not duplicate @dictBuffer content.
 *  Note 2 : A ZSTD_CDict can be created from an empty @dictBuffer,
 *      in which case the only thing that it transports is the @compressionLevel.
 *      This can be useful in a pipeline featuring ZSTD_compress_usingCDict() exclusively,
 *      expecting a ZSTD_CDict parameter with any data, including those without a known dictionary. */
ZSTDLIB_API ZSTD_CDict* ZSTD_createCDict(const void* dictBuffer, size_t dictSize,
                                         int compressionLevel);

/*! ZSTD_freeCDict() :
 *  Function frees memory allocated by ZSTD_createCDict(). */
ZSTDLIB_API size_t      ZSTD_freeCDict(ZSTD_CDict* CDict);

/*! ZSTD_compress_usingCDict() :
 *  Compression using a digested Dictionary.
 *  Recommended when same dictionary is used multiple times.
 *  Note : compression level is _decided at dictionary creation time_,
 *     and frame parameters are hardcoded (dictID=yes, contentSize=yes, checksum=no) */
ZSTDLIB_API size_t ZSTD_compress_usingCDict(ZSTD_CCtx* cctx,
                                            void* dst, size_t dstCapacity,
                                      const void* src, size_t srcSize,
                                      const ZSTD_CDict* cdict);


typedef struct ZSTD_DDict_s ZSTD_DDict;

/*! ZSTD_createDDict() :
 *  Create a digested dictionary, ready to start decompression operation without startup delay.
 *  dictBuffer can be released after DDict creation, as its content is copied inside DDict. */
ZSTDLIB_API ZSTD_DDict* ZSTD_createDDict(const void* dictBuffer, size_t dictSize);

/*! ZSTD_freeDDict() :
 *  Function frees memory allocated with ZSTD_createDDict() */
ZSTDLIB_API size_t      ZSTD_freeDDict(ZSTD_DDict* ddict);

/*! ZSTD_decompress_usingDDict() :
 *  Decompression using a digested Dictionary.
 *  Recommended when same dictionary is used multiple times. */
ZSTDLIB_API size_t ZSTD_decompress_usingDDict(ZSTD_DCtx* dctx,
                                              void* dst, size_t dstCapacity,
                                        const void* src, size_t srcSize,
                                        const ZSTD_DDict* ddict);


/********************************
 *  Dictionary helper functions
 *******************************/

/*! ZSTD_getDictID_fromDict() :
 *  Provides the dictID stored within dictionary.
 *  if @return == 0, the dictionary is not conformant with Zstandard specification.
 *  It can still be loaded, but as a content-only dictionary. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromDict(const void* dict, size_t dictSize);

/*! ZSTD_getDictID_fromDDict() :
 *  Provides the dictID of the dictionary loaded into `ddict`.
 *  If @return == 0, the dictionary is not conformant to Zstandard specification, or empty.
 *  Non-conformant dictionaries can still be loaded, but as content-only dictionaries. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromDDict(const ZSTD_DDict* ddict);

/*! ZSTD_getDictID_fromFrame() :
 *  Provides the dictID required to decompressed the frame stored within `src`.
 *  If @return == 0, the dictID could not be decoded.
 *  This could for one of the following reasons :
 *  - The frame does not require a dictionary to be decoded (most common case).
 *  - The frame was built with dictID intentionally removed. Whatever dictionary is necessary is a hidden information.
 *    Note : this use case also happens when using a non-conformant dictionary.
 *  - `srcSize` is too small, and as a result, the frame header could not be decoded (only possible if `srcSize < ZSTD_FRAMEHEADERSIZE_MAX`).
 *  - This is not a Zstandard frame.
 *  When identifying the exact failure cause, it's possible to use ZSTD_getFrameHeader(), which will provide a more precise error code. */
ZSTDLIB_API unsigned ZSTD_getDictID_fromFrame(const void* src, size_t srcSize);


/*******************************************************************************
 * Advanced dictionary and prefix API
 *
 * This API allows dictionaries to be used with ZSTD_compress2(),
 * ZSTD_compressStream2(), and ZSTD_decompress(). Dictionaries are sticky, and
 * only reset with the context is reset with ZSTD_reset_parameters or
 * ZSTD_reset_session_and_parameters. Prefixes are single-use.
 ******************************************************************************/


/*! ZSTD_CCtx_loadDictionary() :
 *  Create an internal CDict from `dict` buffer.
 *  Decompression will have to use same dictionary.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special: Loading a NULL (or 0-size) dictionary invalidates previous dictionary,
 *           meaning "return to no-dictionary mode".
 *  Note 1 : Dictionary is sticky, it will be used for all future compressed frames.
 *           To return to "no-dictionary" situation, load a NULL dictionary (or reset parameters).
 *  Note 2 : Loading a dictionary involves building tables.
 *           It's also a CPU consuming operation, with non-negligible impact on latency.
 *           Tables are dependent on compression parameters, and for this reason,
 *           compression parameters can no longer be changed after loading a dictionary.
 *  Note 3 :`dict` content will be copied internally.
 *           Use experimental ZSTD_CCtx_loadDictionary_byReference() to reference content instead.
 *           In such a case, dictionary buffer must outlive its users.
 *  Note 4 : Use ZSTD_CCtx_loadDictionary_advanced()
 *           to precisely select how dictionary content must be interpreted. */
ZSTDLIB_API size_t ZSTD_CCtx_loadDictionary(ZSTD_CCtx* cctx, const void* dict, size_t dictSize);

/*! ZSTD_CCtx_refCDict() :
 *  Reference a prepared dictionary, to be used for all next compressed frames.
 *  Note that compression parameters are enforced from within CDict,
 *  and supersede any compression parameter previously set within CCtx.
 *  The parameters ignored are labled as "superseded-by-cdict" in the ZSTD_cParameter enum docs.
 *  The ignored parameters will be used again if the CCtx is returned to no-dictionary mode.
 *  The dictionary will remain valid for future compressed frames using same CCtx.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special : Referencing a NULL CDict means "return to no-dictionary mode".
 *  Note 1 : Currently, only one dictionary can be managed.
 *           Referencing a new dictionary effectively "discards" any previous one.
 *  Note 2 : CDict is just referenced, its lifetime must outlive its usage within CCtx. */
ZSTDLIB_API size_t ZSTD_CCtx_refCDict(ZSTD_CCtx* cctx, const ZSTD_CDict* cdict);

/*! ZSTD_CCtx_refPrefix() :
 *  Reference a prefix (single-usage dictionary) for next compressed frame.
 *  A prefix is **only used once**. Tables are discarded at end of frame (ZSTD_e_end).
 *  Decompression will need same prefix to properly regenerate data.
 *  Compressing with a prefix is similar in outcome as performing a diff and compressing it,
 *  but performs much faster, especially during decompression (compression speed is tunable with compression level).
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special: Adding any prefix (including NULL) invalidates any previous prefix or dictionary
 *  Note 1 : Prefix buffer is referenced. It **must** outlive compression.
 *           Its content must remain unmodified during compression.
 *  Note 2 : If the intention is to diff some large src data blob with some prior version of itself,
 *           ensure that the window size is large enough to contain the entire source.
 *           See ZSTD_c_windowLog.
 *  Note 3 : Referencing a prefix involves building tables, which are dependent on compression parameters.
 *           It's a CPU consuming operation, with non-negligible impact on latency.
 *           If there is a need to use the same prefix multiple times, consider loadDictionary instead.
 *  Note 4 : By default, the prefix is interpreted as raw content (ZSTD_dct_rawContent).
 *           Use experimental ZSTD_CCtx_refPrefix_advanced() to alter dictionary interpretation. */
ZSTDLIB_API size_t ZSTD_CCtx_refPrefix(ZSTD_CCtx* cctx,
                                 const void* prefix, size_t prefixSize);

/*! ZSTD_DCtx_loadDictionary() :
 *  Create an internal DDict from dict buffer,
 *  to be used to decompress next frames.
 *  The dictionary remains valid for all future frames, until explicitly invalidated.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Special : Adding a NULL (or 0-size) dictionary invalidates any previous dictionary,
 *            meaning "return to no-dictionary mode".
 *  Note 1 : Loading a dictionary involves building tables,
 *           which has a non-negligible impact on CPU usage and latency.
 *           It's recommended to "load once, use many times", to amortize the cost
 *  Note 2 :`dict` content will be copied internally, so `dict` can be released after loading.
 *           Use ZSTD_DCtx_loadDictionary_byReference() to reference dictionary content instead.
 *  Note 3 : Use ZSTD_DCtx_loadDictionary_advanced() to take control of
 *           how dictionary content is loaded and interpreted.
 */
ZSTDLIB_API size_t ZSTD_DCtx_loadDictionary(ZSTD_DCtx* dctx, const void* dict, size_t dictSize);

/*! ZSTD_DCtx_refDDict() :
 *  Reference a prepared dictionary, to be used to decompress next frames.
 *  The dictionary remains active for decompression of future frames using same DCtx.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Note 1 : Currently, only one dictionary can be managed.
 *           Referencing a new dictionary effectively "discards" any previous one.
 *  Special: referencing a NULL DDict means "return to no-dictionary mode".
 *  Note 2 : DDict is just referenced, its lifetime must outlive its usage from DCtx.
 */
ZSTDLIB_API size_t ZSTD_DCtx_refDDict(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict);

/*! ZSTD_DCtx_refPrefix() :
 *  Reference a prefix (single-usage dictionary) to decompress next frame.
 *  This is the reverse operation of ZSTD_CCtx_refPrefix(),
 *  and must use the same prefix as the one used during compression.
 *  Prefix is **only used once**. Reference is discarded at end of frame.
 *  End of frame is reached when ZSTD_decompressStream() returns 0.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 *  Note 1 : Adding any prefix (including NULL) invalidates any previously set prefix or dictionary
 *  Note 2 : Prefix buffer is referenced. It **must** outlive decompression.
 *           Prefix buffer must remain unmodified up to the end of frame,
 *           reached when ZSTD_decompressStream() returns 0.
 *  Note 3 : By default, the prefix is treated as raw content (ZSTD_dct_rawContent).
 *           Use ZSTD_CCtx_refPrefix_advanced() to alter dictMode (Experimental section)
 *  Note 4 : Referencing a raw content prefix has almost no cpu nor memory cost.
 *           A full dictionary is more costly, as it requires building tables.
 */
ZSTDLIB_API size_t ZSTD_DCtx_refPrefix(ZSTD_DCtx* dctx,
                                 const void* prefix, size_t prefixSize);

/* ===   Memory management   === */

/*! ZSTD_sizeof_*() :
 *  These functions give the _current_ memory usage of selected object.
 *  Note that object memory usage can evolve (increase or decrease) over time. */
ZSTDLIB_API size_t ZSTD_sizeof_CCtx(const ZSTD_CCtx* cctx);
ZSTDLIB_API size_t ZSTD_sizeof_DCtx(const ZSTD_DCtx* dctx);
ZSTDLIB_API size_t ZSTD_sizeof_CStream(const ZSTD_CStream* zcs);
ZSTDLIB_API size_t ZSTD_sizeof_DStream(const ZSTD_DStream* zds);
ZSTDLIB_API size_t ZSTD_sizeof_CDict(const ZSTD_CDict* cdict);
ZSTDLIB_API size_t ZSTD_sizeof_DDict(const ZSTD_DDict* ddict);

#endif  /* ZSTD_H_235446 */


/* **************************************************************************************
 *   ADVANCED AND EXPERIMENTAL FUNCTIONS
 ****************************************************************************************
 * The definitions in the following section are considered experimental.
 * They are provided for advanced scenarios.
 * They should never be used with a dynamic library, as prototypes may change in the future.
 * Use them only in association with static linking.
 * ***************************************************************************************/

#if defined(ZSTD_STATIC_LINKING_ONLY) && !defined(ZSTD_H_ZSTD_STATIC_LINKING_ONLY)
#define ZSTD_H_ZSTD_STATIC_LINKING_ONLY

/****************************************************************************************
 *   experimental API (static linking only)
 ****************************************************************************************
 * The following symbols and constants
 * are not planned to join "stable API" status in the near future.
 * They can still change in future versions.
 * Some of them are planned to remain in the static_only section indefinitely.
 * Some of them might be removed in the future (especially when redundant with existing stable functions)
 * ***************************************************************************************/

#define ZSTD_FRAMEHEADERSIZE_PREFIX(format) ((format) == ZSTD_f_zstd1 ? 5 : 1)   /* minimum input size required to query frame header size */
#define ZSTD_FRAMEHEADERSIZE_MIN(format)    ((format) == ZSTD_f_zstd1 ? 6 : 2)
#define ZSTD_FRAMEHEADERSIZE_MAX   18   /* can be useful for static allocation */
#define ZSTD_SKIPPABLEHEADERSIZE    8

/* compression parameter bounds */
#define ZSTD_WINDOWLOG_MAX_32    30
#define ZSTD_WINDOWLOG_MAX_64    31
#define ZSTD_WINDOWLOG_MAX     ((int)(sizeof(size_t) == 4 ? ZSTD_WINDOWLOG_MAX_32 : ZSTD_WINDOWLOG_MAX_64))
#define ZSTD_WINDOWLOG_MIN       10
#define ZSTD_HASHLOG_MAX       ((ZSTD_WINDOWLOG_MAX < 30) ? ZSTD_WINDOWLOG_MAX : 30)
#define ZSTD_HASHLOG_MIN          6
#define ZSTD_CHAINLOG_MAX_32     29
#define ZSTD_CHAINLOG_MAX_64     30
#define ZSTD_CHAINLOG_MAX      ((int)(sizeof(size_t) == 4 ? ZSTD_CHAINLOG_MAX_32 : ZSTD_CHAINLOG_MAX_64))
#define ZSTD_CHAINLOG_MIN        ZSTD_HASHLOG_MIN
#define ZSTD_SEARCHLOG_MAX      (ZSTD_WINDOWLOG_MAX-1)
#define ZSTD_SEARCHLOG_MIN        1
#define ZSTD_MINMATCH_MAX         7   /* only for ZSTD_fast, other strategies are limited to 6 */
#define ZSTD_MINMATCH_MIN         3   /* only for ZSTD_btopt+, faster strategies are limited to 4 */
#define ZSTD_TARGETLENGTH_MAX    ZSTD_BLOCKSIZE_MAX
#define ZSTD_TARGETLENGTH_MIN     0   /* note : comparing this constant to an unsigned results in a tautological test */
#define ZSTD_STRATEGY_MIN        ZSTD_fast
#define ZSTD_STRATEGY_MAX        ZSTD_btultra2


#define ZSTD_OVERLAPLOG_MIN       0
#define ZSTD_OVERLAPLOG_MAX       9

#define ZSTD_WINDOWLOG_LIMIT_DEFAULT 27   /* by default, the streaming decoder will refuse any frame
                                           * requiring larger than (1<<ZSTD_WINDOWLOG_LIMIT_DEFAULT) window size,
                                           * to preserve host's memory from unreasonable requirements.
                                           * This limit can be overridden using ZSTD_DCtx_setParameter(,ZSTD_d_windowLogMax,).
                                           * The limit does not apply for one-pass decoders (such as ZSTD_decompress()), since no additional memory is allocated */


/* LDM parameter bounds */
#define ZSTD_LDM_HASHLOG_MIN      ZSTD_HASHLOG_MIN
#define ZSTD_LDM_HASHLOG_MAX      ZSTD_HASHLOG_MAX
#define ZSTD_LDM_MINMATCH_MIN        4
#define ZSTD_LDM_MINMATCH_MAX     4096
#define ZSTD_LDM_BUCKETSIZELOG_MIN   1
#define ZSTD_LDM_BUCKETSIZELOG_MAX   8
#define ZSTD_LDM_HASHRATELOG_MIN     0
#define ZSTD_LDM_HASHRATELOG_MAX (ZSTD_WINDOWLOG_MAX - ZSTD_HASHLOG_MIN)

/* Advanced parameter bounds */
#define ZSTD_TARGETCBLOCKSIZE_MIN   64
#define ZSTD_TARGETCBLOCKSIZE_MAX   ZSTD_BLOCKSIZE_MAX
#define ZSTD_SRCSIZEHINT_MIN        0
#define ZSTD_SRCSIZEHINT_MAX        INT_MAX

/* internal */
#define ZSTD_HASHLOG3_MAX           17


/* ---  Advanced types  --- */

typedef struct ZSTD_CCtx_params_s ZSTD_CCtx_params;

typedef struct {
    unsigned int matchPos; /* Match pos in dst */
    /* If seqDef.offset > 3, then this is seqDef.offset - 3
     * If seqDef.offset < 3, then this is the corresponding repeat offset
     * But if seqDef.offset < 3 and litLength == 0, this is the
     *   repeat offset before the corresponding repeat offset
     * And if seqDef.offset == 3 and litLength == 0, this is the
     *   most recent repeat offset - 1
     */
    unsigned int offset;
    unsigned int litLength; /* Literal length */
    unsigned int matchLength; /* Match length */
    /* 0 when seq not rep and seqDef.offset otherwise
     * when litLength == 0 this will be <= 4, otherwise <= 3 like normal
     */
    unsigned int rep;
} ZSTD_Sequence;

typedef struct {
    unsigned windowLog;       /**< largest match distance : larger == more compression, more memory needed during decompression */
    unsigned chainLog;        /**< fully searched segment : larger == more compression, slower, more memory (useless for fast) */
    unsigned hashLog;         /**< dispatch table : larger == faster, more memory */
    unsigned searchLog;       /**< nb of searches : larger == more compression, slower */
    unsigned minMatch;        /**< match length searched : larger == faster decompression, sometimes less compression */
    unsigned targetLength;    /**< acceptable match size for optimal parser (only) : larger == more compression, slower */
    ZSTD_strategy strategy;   /**< see ZSTD_strategy definition above */
} ZSTD_compressionParameters;

typedef struct {
    int contentSizeFlag; /**< 1: content size will be in frame header (when known) */
    int checksumFlag;    /**< 1: generate a 32-bits checksum using XXH64 algorithm at end of frame, for error detection */
    int noDictIDFlag;    /**< 1: no dictID will be saved into frame header (dictID is only useful for dictionary compression) */
} ZSTD_frameParameters;

typedef struct {
    ZSTD_compressionParameters cParams;
    ZSTD_frameParameters fParams;
} ZSTD_parameters;

typedef enum {
    ZSTD_dct_auto = 0,       /* dictionary is "full" when starting with ZSTD_MAGIC_DICTIONARY, otherwise it is "rawContent" */
    ZSTD_dct_rawContent = 1, /* ensures dictionary is always loaded as rawContent, even if it starts with ZSTD_MAGIC_DICTIONARY */
    ZSTD_dct_fullDict = 2    /* refuses to load a dictionary if it does not respect Zstandard's specification, starting with ZSTD_MAGIC_DICTIONARY */
} ZSTD_dictContentType_e;

typedef enum {
    ZSTD_dlm_byCopy = 0,  /**< Copy dictionary content internally */
    ZSTD_dlm_byRef = 1    /**< Reference dictionary content -- the dictionary buffer must outlive its users. */
} ZSTD_dictLoadMethod_e;

typedef enum {
    ZSTD_f_zstd1 = 0,           /* zstd frame format, specified in zstd_compression_format.md (default) */
    ZSTD_f_zstd1_magicless = 1  /* Variant of zstd frame format, without initial 4-bytes magic number.
                                 * Useful to save 4 bytes per generated frame.
                                 * Decoder cannot recognise automatically this format, requiring this instruction. */
} ZSTD_format_e;

typedef enum {
    /* Note: this enum and the behavior it controls are effectively internal
     * implementation details of the compressor. They are expected to continue
     * to evolve and should be considered only in the context of extremely
     * advanced performance tuning.
     *
     * Zstd currently supports the use of a CDict in three ways:
     *
     * - The contents of the CDict can be copied into the working context. This
     *   means that the compression can search both the dictionary and input
     *   while operating on a single set of internal tables. This makes
     *   the compression faster per-byte of input. However, the initial copy of
     *   the CDict's tables incurs a fixed cost at the beginning of the
     *   compression. For small compressions (< 8 KB), that copy can dominate
     *   the cost of the compression.
     *
     * - The CDict's tables can be used in-place. In this model, compression is
     *   slower per input byte, because the compressor has to search two sets of
     *   tables. However, this model incurs no start-up cost (as long as the
     *   working context's tables can be reused). For small inputs, this can be
     *   faster than copying the CDict's tables.
     *
     * - The CDict's tables are not used at all, and instead we use the working
     *   context alone to reload the dictionary and use params based on the source
     *   size. See ZSTD_compress_insertDictionary() and ZSTD_compress_usingDict().
     *   This method is effective when the dictionary sizes are very small relative
     *   to the input size, and the input size is fairly large to begin with.
     *
     * Zstd has a simple internal heuristic that selects which strategy to use
     * at the beginning of a compression. However, if experimentation shows that
     * Zstd is making poor choices, it is possible to override that choice with
     * this enum.
     */
    ZSTD_dictDefaultAttach = 0, /* Use the default heuristic. */
    ZSTD_dictForceAttach   = 1, /* Never copy the dictionary. */
    ZSTD_dictForceCopy     = 2, /* Always copy the dictionary. */
    ZSTD_dictForceLoad     = 3  /* Always reload the dictionary */
} ZSTD_dictAttachPref_e;

typedef enum {
  ZSTD_lcm_auto = 0,          /**< Automatically determine the compression mode based on the compression level.
                               *   Negative compression levels will be uncompressed, and positive compression
                               *   levels will be compressed. */
  ZSTD_lcm_huffman = 1,       /**< Always attempt Huffman compression. Uncompressed literals will still be
                               *   emitted if Huffman compression is not profitable. */
  ZSTD_lcm_uncompressed = 2   /**< Always emit uncompressed literals. */
} ZSTD_literalCompressionMode_e;


/***************************************
*  Frame size functions
***************************************/

/*! ZSTD_findDecompressedSize() :
 *  `src` should point to the start of a series of ZSTD encoded and/or skippable frames
 *  `srcSize` must be the _exact_ size of this series
 *       (i.e. there should be a frame boundary at `src + srcSize`)
 *  @return : - decompressed size of all data in all successive frames
 *            - if the decompressed size cannot be determined: ZSTD_CONTENTSIZE_UNKNOWN
 *            - if an error occurred: ZSTD_CONTENTSIZE_ERROR
 *
 *   note 1 : decompressed size is an optional field, that may not be present, especially in streaming mode.
 *            When `return==ZSTD_CONTENTSIZE_UNKNOWN`, data to decompress could be any size.
 *            In which case, it's necessary to use streaming mode to decompress data.
 *   note 2 : decompressed size is always present when compression is done with ZSTD_compress()
 *   note 3 : decompressed size can be very large (64-bits value),
 *            potentially larger than what local system can handle as a single memory segment.
 *            In which case, it's necessary to use streaming mode to decompress data.
 *   note 4 : If source is untrusted, decompressed size could be wrong or intentionally modified.
 *            Always ensure result fits within application's authorized limits.
 *            Each application can set its own limits.
 *   note 5 : ZSTD_findDecompressedSize handles multiple frames, and so it must traverse the input to
 *            read each contained frame header.  This is fast as most of the data is skipped,
 *            however it does mean that all frame data must be present and valid. */
ZSTDLIB_API unsigned long long ZSTD_findDecompressedSize(const void* src, size_t srcSize);

/*! ZSTD_decompressBound() :
 *  `src` should point to the start of a series of ZSTD encoded and/or skippable frames
 *  `srcSize` must be the _exact_ size of this series
 *       (i.e. there should be a frame boundary at `src + srcSize`)
 *  @return : - upper-bound for the decompressed size of all data in all successive frames
 *            - if an error occured: ZSTD_CONTENTSIZE_ERROR
 *
 *  note 1  : an error can occur if `src` contains an invalid or incorrectly formatted frame.
 *  note 2  : the upper-bound is exact when the decompressed size field is available in every ZSTD encoded frame of `src`.
 *            in this case, `ZSTD_findDecompressedSize` and `ZSTD_decompressBound` return the same value.
 *  note 3  : when the decompressed size field isn't available, the upper-bound for that frame is calculated by:
 *              upper-bound = # blocks * min(128 KB, Window_Size)
 */
ZSTDLIB_API unsigned long long ZSTD_decompressBound(const void* src, size_t srcSize);

/*! ZSTD_frameHeaderSize() :
 *  srcSize must be >= ZSTD_FRAMEHEADERSIZE_PREFIX.
 * @return : size of the Frame Header,
 *           or an error code (if srcSize is too small) */
ZSTDLIB_API size_t ZSTD_frameHeaderSize(const void* src, size_t srcSize);

/*! ZSTD_getSequences() :
 * Extract sequences from the sequence store
 * zc can be used to insert custom compression params.
 * This function invokes ZSTD_compress2
 * @return : number of sequences extracted
 */
ZSTDLIB_API size_t ZSTD_getSequences(ZSTD_CCtx* zc, ZSTD_Sequence* outSeqs,
    size_t outSeqsSize, const void* src, size_t srcSize);


/***************************************
*  Memory management
***************************************/

/*! ZSTD_estimate*() :
 *  These functions make it possible to estimate memory usage
 *  of a future {D,C}Ctx, before its creation.
 *
 *  ZSTD_estimateCCtxSize() will provide a memory budget large enough
 *  for any compression level up to selected one.
 *  Note : Unlike ZSTD_estimateCStreamSize*(), this estimate
 *         does not include space for a window buffer.
 *         Therefore, the estimation is only guaranteed for single-shot compressions, not streaming.
 *  The estimate will assume the input may be arbitrarily large,
 *  which is the worst case.
 *
 *  When srcSize can be bound by a known and rather "small" value,
 *  this fact can be used to provide a tighter estimation
 *  because the CCtx compression context will need less memory.
 *  This tighter estimation can be provided by more advanced functions
 *  ZSTD_estimateCCtxSize_usingCParams(), which can be used in tandem with ZSTD_getCParams(),
 *  and ZSTD_estimateCCtxSize_usingCCtxParams(), which can be used in tandem with ZSTD_CCtxParams_setParameter().
 *  Both can be used to estimate memory using custom compression parameters and arbitrary srcSize limits.
 *
 *  Note 2 : only single-threaded compression is supported.
 *  ZSTD_estimateCCtxSize_usingCCtxParams() will return an error code if ZSTD_c_nbWorkers is >= 1.
 */
ZSTDLIB_API size_t ZSTD_estimateCCtxSize(int compressionLevel);
ZSTDLIB_API size_t ZSTD_estimateCCtxSize_usingCParams(ZSTD_compressionParameters cParams);
ZSTDLIB_API size_t ZSTD_estimateCCtxSize_usingCCtxParams(const ZSTD_CCtx_params* params);
ZSTDLIB_API size_t ZSTD_estimateDCtxSize(void);

/*! ZSTD_estimateCStreamSize() :
 *  ZSTD_estimateCStreamSize() will provide a budget large enough for any compression level up to selected one.
 *  It will also consider src size to be arbitrarily "large", which is worst case.
 *  If srcSize is known to always be small, ZSTD_estimateCStreamSize_usingCParams() can provide a tighter estimation.
 *  ZSTD_estimateCStreamSize_usingCParams() can be used in tandem with ZSTD_getCParams() to create cParams from compressionLevel.
 *  ZSTD_estimateCStreamSize_usingCCtxParams() can be used in tandem with ZSTD_CCtxParams_setParameter(). Only single-threaded compression is supported. This function will return an error code if ZSTD_c_nbWorkers is >= 1.
 *  Note : CStream size estimation is only correct for single-threaded compression.
 *  ZSTD_DStream memory budget depends on window Size.
 *  This information can be passed manually, using ZSTD_estimateDStreamSize,
 *  or deducted from a valid frame Header, using ZSTD_estimateDStreamSize_fromFrame();
 *  Note : if streaming is init with function ZSTD_init?Stream_usingDict(),
 *         an internal ?Dict will be created, which additional size is not estimated here.
 *         In this case, get total size by adding ZSTD_estimate?DictSize */
ZSTDLIB_API size_t ZSTD_estimateCStreamSize(int compressionLevel);
ZSTDLIB_API size_t ZSTD_estimateCStreamSize_usingCParams(ZSTD_compressionParameters cParams);
ZSTDLIB_API size_t ZSTD_estimateCStreamSize_usingCCtxParams(const ZSTD_CCtx_params* params);
ZSTDLIB_API size_t ZSTD_estimateDStreamSize(size_t windowSize);
ZSTDLIB_API size_t ZSTD_estimateDStreamSize_fromFrame(const void* src, size_t srcSize);

/*! ZSTD_estimate?DictSize() :
 *  ZSTD_estimateCDictSize() will bet that src size is relatively "small", and content is copied, like ZSTD_createCDict().
 *  ZSTD_estimateCDictSize_advanced() makes it possible to control compression parameters precisely, like ZSTD_createCDict_advanced().
 *  Note : dictionaries created by reference (`ZSTD_dlm_byRef`) are logically smaller.
 */
ZSTDLIB_API size_t ZSTD_estimateCDictSize(size_t dictSize, int compressionLevel);
ZSTDLIB_API size_t ZSTD_estimateCDictSize_advanced(size_t dictSize, ZSTD_compressionParameters cParams, ZSTD_dictLoadMethod_e dictLoadMethod);
ZSTDLIB_API size_t ZSTD_estimateDDictSize(size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod);

/*! ZSTD_initStatic*() :
 *  Initialize an object using a pre-allocated fixed-size buffer.
 *  workspace: The memory area to emplace the object into.
 *             Provided pointer *must be 8-bytes aligned*.
 *             Buffer must outlive object.
 *  workspaceSize: Use ZSTD_estimate*Size() to determine
 *                 how large workspace must be to support target scenario.
 * @return : pointer to object (same address as workspace, just different type),
 *           or NULL if error (size too small, incorrect alignment, etc.)
 *  Note : zstd will never resize nor malloc() when using a static buffer.
 *         If the object requires more memory than available,
 *         zstd will just error out (typically ZSTD_error_memory_allocation).
 *  Note 2 : there is no corresponding "free" function.
 *           Since workspace is allocated externally, it must be freed externally too.
 *  Note 3 : cParams : use ZSTD_getCParams() to convert a compression level
 *           into its associated cParams.
 *  Limitation 1 : currently not compatible with internal dictionary creation, triggered by
 *                 ZSTD_CCtx_loadDictionary(), ZSTD_initCStream_usingDict() or ZSTD_initDStream_usingDict().
 *  Limitation 2 : static cctx currently not compatible with multi-threading.
 *  Limitation 3 : static dctx is incompatible with legacy support.
 */
ZSTDLIB_API ZSTD_CCtx*    ZSTD_initStaticCCtx(void* workspace, size_t workspaceSize);
ZSTDLIB_API ZSTD_CStream* ZSTD_initStaticCStream(void* workspace, size_t workspaceSize);    /**< same as ZSTD_initStaticCCtx() */

ZSTDLIB_API ZSTD_DCtx*    ZSTD_initStaticDCtx(void* workspace, size_t workspaceSize);
ZSTDLIB_API ZSTD_DStream* ZSTD_initStaticDStream(void* workspace, size_t workspaceSize);    /**< same as ZSTD_initStaticDCtx() */

ZSTDLIB_API const ZSTD_CDict* ZSTD_initStaticCDict(
                                        void* workspace, size_t workspaceSize,
                                        const void* dict, size_t dictSize,
                                        ZSTD_dictLoadMethod_e dictLoadMethod,
                                        ZSTD_dictContentType_e dictContentType,
                                        ZSTD_compressionParameters cParams);

ZSTDLIB_API const ZSTD_DDict* ZSTD_initStaticDDict(
                                        void* workspace, size_t workspaceSize,
                                        const void* dict, size_t dictSize,
                                        ZSTD_dictLoadMethod_e dictLoadMethod,
                                        ZSTD_dictContentType_e dictContentType);


/*! Custom memory allocation :
 *  These prototypes make it possible to pass your own allocation/free functions.
 *  ZSTD_customMem is provided at creation time, using ZSTD_create*_advanced() variants listed below.
 *  All allocation/free operations will be completed using these custom variants instead of regular <stdlib.h> ones.
 */
typedef void* (*ZSTD_allocFunction) (void* opaque, size_t size);
typedef void  (*ZSTD_freeFunction) (void* opaque, void* address);
typedef struct { ZSTD_allocFunction customAlloc; ZSTD_freeFunction customFree; void* opaque; } ZSTD_customMem;
static ZSTD_customMem const ZSTD_defaultCMem = { NULL, NULL, NULL };  /**< this constant defers to stdlib's functions */

ZSTDLIB_API ZSTD_CCtx*    ZSTD_createCCtx_advanced(ZSTD_customMem customMem);
ZSTDLIB_API ZSTD_CStream* ZSTD_createCStream_advanced(ZSTD_customMem customMem);
ZSTDLIB_API ZSTD_DCtx*    ZSTD_createDCtx_advanced(ZSTD_customMem customMem);
ZSTDLIB_API ZSTD_DStream* ZSTD_createDStream_advanced(ZSTD_customMem customMem);

ZSTDLIB_API ZSTD_CDict* ZSTD_createCDict_advanced(const void* dict, size_t dictSize,
                                                  ZSTD_dictLoadMethod_e dictLoadMethod,
                                                  ZSTD_dictContentType_e dictContentType,
                                                  ZSTD_compressionParameters cParams,
                                                  ZSTD_customMem customMem);

ZSTDLIB_API ZSTD_DDict* ZSTD_createDDict_advanced(const void* dict, size_t dictSize,
                                                  ZSTD_dictLoadMethod_e dictLoadMethod,
                                                  ZSTD_dictContentType_e dictContentType,
                                                  ZSTD_customMem customMem);



/***************************************
*  Advanced compression functions
***************************************/

/*! ZSTD_createCDict_byReference() :
 *  Create a digested dictionary for compression
 *  Dictionary content is just referenced, not duplicated.
 *  As a consequence, `dictBuffer` **must** outlive CDict,
 *  and its content must remain unmodified throughout the lifetime of CDict.
 *  note: equivalent to ZSTD_createCDict_advanced(), with dictLoadMethod==ZSTD_dlm_byRef */
ZSTDLIB_API ZSTD_CDict* ZSTD_createCDict_byReference(const void* dictBuffer, size_t dictSize, int compressionLevel);

/*! ZSTD_getCParams() :
 * @return ZSTD_compressionParameters structure for a selected compression level and estimated srcSize.
 * `estimatedSrcSize` value is optional, select 0 if not known */
ZSTDLIB_API ZSTD_compressionParameters ZSTD_getCParams(int compressionLevel, unsigned long long estimatedSrcSize, size_t dictSize);

/*! ZSTD_getParams() :
 *  same as ZSTD_getCParams(), but @return a full `ZSTD_parameters` object instead of sub-component `ZSTD_compressionParameters`.
 *  All fields of `ZSTD_frameParameters` are set to default : contentSize=1, checksum=0, noDictID=0 */
ZSTDLIB_API ZSTD_parameters ZSTD_getParams(int compressionLevel, unsigned long long estimatedSrcSize, size_t dictSize);

/*! ZSTD_checkCParams() :
 *  Ensure param values remain within authorized range.
 * @return 0 on success, or an error code (can be checked with ZSTD_isError()) */
ZSTDLIB_API size_t ZSTD_checkCParams(ZSTD_compressionParameters params);

/*! ZSTD_adjustCParams() :
 *  optimize params for a given `srcSize` and `dictSize`.
 * `srcSize` can be unknown, in which case use ZSTD_CONTENTSIZE_UNKNOWN.
 * `dictSize` must be `0` when there is no dictionary.
 *  cPar can be invalid : all parameters will be clamped within valid range in the @return struct.
 *  This function never fails (wide contract) */
ZSTDLIB_API ZSTD_compressionParameters ZSTD_adjustCParams(ZSTD_compressionParameters cPar, unsigned long long srcSize, size_t dictSize);

/*! ZSTD_compress_advanced() :
 *  Note : this function is now DEPRECATED.
 *         It can be replaced by ZSTD_compress2(), in combination with ZSTD_CCtx_setParameter() and other parameter setters.
 *  This prototype will be marked as deprecated and generate compilation warning on reaching v1.5.x */
ZSTDLIB_API size_t ZSTD_compress_advanced(ZSTD_CCtx* cctx,
                                          void* dst, size_t dstCapacity,
                                    const void* src, size_t srcSize,
                                    const void* dict,size_t dictSize,
                                          ZSTD_parameters params);

/*! ZSTD_compress_usingCDict_advanced() :
 *  Note : this function is now REDUNDANT.
 *         It can be replaced by ZSTD_compress2(), in combination with ZSTD_CCtx_loadDictionary() and other parameter setters.
 *  This prototype will be marked as deprecated and generate compilation warning in some future version */
ZSTDLIB_API size_t ZSTD_compress_usingCDict_advanced(ZSTD_CCtx* cctx,
                                              void* dst, size_t dstCapacity,
                                        const void* src, size_t srcSize,
                                        const ZSTD_CDict* cdict,
                                              ZSTD_frameParameters fParams);


/*! ZSTD_CCtx_loadDictionary_byReference() :
 *  Same as ZSTD_CCtx_loadDictionary(), but dictionary content is referenced, instead of being copied into CCtx.
 *  It saves some memory, but also requires that `dict` outlives its usage within `cctx` */
ZSTDLIB_API size_t ZSTD_CCtx_loadDictionary_byReference(ZSTD_CCtx* cctx, const void* dict, size_t dictSize);

/*! ZSTD_CCtx_loadDictionary_advanced() :
 *  Same as ZSTD_CCtx_loadDictionary(), but gives finer control over
 *  how to load the dictionary (by copy ? by reference ?)
 *  and how to interpret it (automatic ? force raw mode ? full mode only ?) */
ZSTDLIB_API size_t ZSTD_CCtx_loadDictionary_advanced(ZSTD_CCtx* cctx, const void* dict, size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod, ZSTD_dictContentType_e dictContentType);

/*! ZSTD_CCtx_refPrefix_advanced() :
 *  Same as ZSTD_CCtx_refPrefix(), but gives finer control over
 *  how to interpret prefix content (automatic ? force raw mode (default) ? full mode only ?) */
ZSTDLIB_API size_t ZSTD_CCtx_refPrefix_advanced(ZSTD_CCtx* cctx, const void* prefix, size_t prefixSize, ZSTD_dictContentType_e dictContentType);

/* ===   experimental parameters   === */
/* these parameters can be used with ZSTD_setParameter()
 * they are not guaranteed to remain supported in the future */

 /* Enables rsyncable mode,
  * which makes compressed files more rsync friendly
  * by adding periodic synchronization points to the compressed data.
  * The target average block size is ZSTD_c_jobSize / 2.
  * It's possible to modify the job size to increase or decrease
  * the granularity of the synchronization point.
  * Once the jobSize is smaller than the window size,
  * it will result in compression ratio degradation.
  * NOTE 1: rsyncable mode only works when multithreading is enabled.
  * NOTE 2: rsyncable performs poorly in combination with long range mode,
  * since it will decrease the effectiveness of synchronization points,
  * though mileage may vary.
  * NOTE 3: Rsyncable mode limits maximum compression speed to ~400 MB/s.
  * If the selected compression level is already running significantly slower,
  * the overall speed won't be significantly impacted.
  */
 #define ZSTD_c_rsyncable ZSTD_c_experimentalParam1

/* Select a compression format.
 * The value must be of type ZSTD_format_e.
 * See ZSTD_format_e enum definition for details */
#define ZSTD_c_format ZSTD_c_experimentalParam2

/* Force back-reference distances to remain < windowSize,
 * even when referencing into Dictionary content (default:0) */
#define ZSTD_c_forceMaxWindow ZSTD_c_experimentalParam3

/* Controls whether the contents of a CDict
 * are used in place, or copied into the working context.
 * Accepts values from the ZSTD_dictAttachPref_e enum.
 * See the comments on that enum for an explanation of the feature. */
#define ZSTD_c_forceAttachDict ZSTD_c_experimentalParam4

/* Controls how the literals are compressed (default is auto).
 * The value must be of type ZSTD_literalCompressionMode_e.
 * See ZSTD_literalCompressionMode_t enum definition for details.
 */
#define ZSTD_c_literalCompressionMode ZSTD_c_experimentalParam5

/* Tries to fit compressed block size to be around targetCBlockSize.
 * No target when targetCBlockSize == 0.
 * There is no guarantee on compressed block size (default:0) */
#define ZSTD_c_targetCBlockSize ZSTD_c_experimentalParam6

/* User's best guess of source size.
 * Hint is not valid when srcSizeHint == 0.
 * There is no guarantee that hint is close to actual source size,
 * but compression ratio may regress significantly if guess considerably underestimates */
#define ZSTD_c_srcSizeHint ZSTD_c_experimentalParam7

/*! ZSTD_CCtx_getParameter() :
 *  Get the requested compression parameter value, selected by enum ZSTD_cParameter,
 *  and store it into int* value.
 * @return : 0, or an error code (which can be tested with ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_CCtx_getParameter(ZSTD_CCtx* cctx, ZSTD_cParameter param, int* value);


/*! ZSTD_CCtx_params :
 *  Quick howto :
 *  - ZSTD_createCCtxParams() : Create a ZSTD_CCtx_params structure
 *  - ZSTD_CCtxParams_setParameter() : Push parameters one by one into
 *                                     an existing ZSTD_CCtx_params structure.
 *                                     This is similar to
 *                                     ZSTD_CCtx_setParameter().
 *  - ZSTD_CCtx_setParametersUsingCCtxParams() : Apply parameters to
 *                                    an existing CCtx.
 *                                    These parameters will be applied to
 *                                    all subsequent frames.
 *  - ZSTD_compressStream2() : Do compression using the CCtx.
 *  - ZSTD_freeCCtxParams() : Free the memory.
 *
 *  This can be used with ZSTD_estimateCCtxSize_advanced_usingCCtxParams()
 *  for static allocation of CCtx for single-threaded compression.
 */
ZSTDLIB_API ZSTD_CCtx_params* ZSTD_createCCtxParams(void);
ZSTDLIB_API size_t ZSTD_freeCCtxParams(ZSTD_CCtx_params* params);

/*! ZSTD_CCtxParams_reset() :
 *  Reset params to default values.
 */
ZSTDLIB_API size_t ZSTD_CCtxParams_reset(ZSTD_CCtx_params* params);

/*! ZSTD_CCtxParams_init() :
 *  Initializes the compression parameters of cctxParams according to
 *  compression level. All other parameters are reset to their default values.
 */
ZSTDLIB_API size_t ZSTD_CCtxParams_init(ZSTD_CCtx_params* cctxParams, int compressionLevel);

/*! ZSTD_CCtxParams_init_advanced() :
 *  Initializes the compression and frame parameters of cctxParams according to
 *  params. All other parameters are reset to their default values.
 */
ZSTDLIB_API size_t ZSTD_CCtxParams_init_advanced(ZSTD_CCtx_params* cctxParams, ZSTD_parameters params);

/*! ZSTD_CCtxParams_setParameter() :
 *  Similar to ZSTD_CCtx_setParameter.
 *  Set one compression parameter, selected by enum ZSTD_cParameter.
 *  Parameters must be applied to a ZSTD_CCtx using ZSTD_CCtx_setParametersUsingCCtxParams().
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_CCtxParams_setParameter(ZSTD_CCtx_params* params, ZSTD_cParameter param, int value);

/*! ZSTD_CCtxParams_getParameter() :
 * Similar to ZSTD_CCtx_getParameter.
 * Get the requested value of one compression parameter, selected by enum ZSTD_cParameter.
 * @result : 0, or an error code (which can be tested with ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_CCtxParams_getParameter(ZSTD_CCtx_params* params, ZSTD_cParameter param, int* value);

/*! ZSTD_CCtx_setParametersUsingCCtxParams() :
 *  Apply a set of ZSTD_CCtx_params to the compression context.
 *  This can be done even after compression is started,
 *    if nbWorkers==0, this will have no impact until a new compression is started.
 *    if nbWorkers>=1, new parameters will be picked up at next job,
 *       with a few restrictions (windowLog, pledgedSrcSize, nbWorkers, jobSize, and overlapLog are not updated).
 */
ZSTDLIB_API size_t ZSTD_CCtx_setParametersUsingCCtxParams(
        ZSTD_CCtx* cctx, const ZSTD_CCtx_params* params);

/*! ZSTD_compressStream2_simpleArgs() :
 *  Same as ZSTD_compressStream2(),
 *  but using only integral types as arguments.
 *  This variant might be helpful for binders from dynamic languages
 *  which have troubles handling structures containing memory pointers.
 */
ZSTDLIB_API size_t ZSTD_compressStream2_simpleArgs (
                            ZSTD_CCtx* cctx,
                            void* dst, size_t dstCapacity, size_t* dstPos,
                      const void* src, size_t srcSize, size_t* srcPos,
                            ZSTD_EndDirective endOp);


/***************************************
*  Advanced decompression functions
***************************************/

/*! ZSTD_isFrame() :
 *  Tells if the content of `buffer` starts with a valid Frame Identifier.
 *  Note : Frame Identifier is 4 bytes. If `size < 4`, @return will always be 0.
 *  Note 2 : Legacy Frame Identifiers are considered valid only if Legacy Support is enabled.
 *  Note 3 : Skippable Frame Identifiers are considered valid. */
ZSTDLIB_API unsigned ZSTD_isFrame(const void* buffer, size_t size);

/*! ZSTD_createDDict_byReference() :
 *  Create a digested dictionary, ready to start decompression operation without startup delay.
 *  Dictionary content is referenced, and therefore stays in dictBuffer.
 *  It is important that dictBuffer outlives DDict,
 *  it must remain read accessible throughout the lifetime of DDict */
ZSTDLIB_API ZSTD_DDict* ZSTD_createDDict_byReference(const void* dictBuffer, size_t dictSize);

/*! ZSTD_DCtx_loadDictionary_byReference() :
 *  Same as ZSTD_DCtx_loadDictionary(),
 *  but references `dict` content instead of copying it into `dctx`.
 *  This saves memory if `dict` remains around.,
 *  However, it's imperative that `dict` remains accessible (and unmodified) while being used, so it must outlive decompression. */
ZSTDLIB_API size_t ZSTD_DCtx_loadDictionary_byReference(ZSTD_DCtx* dctx, const void* dict, size_t dictSize);

/*! ZSTD_DCtx_loadDictionary_advanced() :
 *  Same as ZSTD_DCtx_loadDictionary(),
 *  but gives direct control over
 *  how to load the dictionary (by copy ? by reference ?)
 *  and how to interpret it (automatic ? force raw mode ? full mode only ?). */
ZSTDLIB_API size_t ZSTD_DCtx_loadDictionary_advanced(ZSTD_DCtx* dctx, const void* dict, size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod, ZSTD_dictContentType_e dictContentType);

/*! ZSTD_DCtx_refPrefix_advanced() :
 *  Same as ZSTD_DCtx_refPrefix(), but gives finer control over
 *  how to interpret prefix content (automatic ? force raw mode (default) ? full mode only ?) */
ZSTDLIB_API size_t ZSTD_DCtx_refPrefix_advanced(ZSTD_DCtx* dctx, const void* prefix, size_t prefixSize, ZSTD_dictContentType_e dictContentType);

/*! ZSTD_DCtx_setMaxWindowSize() :
 *  Refuses allocating internal buffers for frames requiring a window size larger than provided limit.
 *  This protects a decoder context from reserving too much memory for itself (potential attack scenario).
 *  This parameter is only useful in streaming mode, since no internal buffer is allocated in single-pass mode.
 *  By default, a decompression context accepts all window sizes <= (1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT)
 * @return : 0, or an error code (which can be tested using ZSTD_isError()).
 */
ZSTDLIB_API size_t ZSTD_DCtx_setMaxWindowSize(ZSTD_DCtx* dctx, size_t maxWindowSize);

/* ZSTD_d_format
 * experimental parameter,
 * allowing selection between ZSTD_format_e input compression formats
 */
#define ZSTD_d_format ZSTD_d_experimentalParam1
/* ZSTD_d_stableOutBuffer
 * Experimental parameter.
 * Default is 0 == disabled. Set to 1 to enable.
 *
 * Tells the decompressor that the ZSTD_outBuffer will ALWAYS be the same
 * between calls, except for the modifications that zstd makes to pos (the
 * caller must not modify pos). This is checked by the decompressor, and
 * decompression will fail if it ever changes. Therefore the ZSTD_outBuffer
 * MUST be large enough to fit the entire decompressed frame. This will be
 * checked when the frame content size is known. The data in the ZSTD_outBuffer
 * in the range [dst, dst + pos) MUST not be modified during decompression
 * or you will get data corruption.
 *
 * When this flags is enabled zstd won't allocate an output buffer, because
 * it can write directly to the ZSTD_outBuffer, but it will still allocate
 * an input buffer large enough to fit any compressed block. This will also
 * avoid the memcpy() from the internal output buffer to the ZSTD_outBuffer.
 * If you need to avoid the input buffer allocation use the buffer-less
 * streaming API.
 *
 * NOTE: So long as the ZSTD_outBuffer always points to valid memory, using
 * this flag is ALWAYS memory safe, and will never access out-of-bounds
 * memory. However, decompression WILL fail if you violate the preconditions.
 *
 * WARNING: The data in the ZSTD_outBuffer in the range [dst, dst + pos) MUST
 * not be modified during decompression or you will get data corruption. This
 * is because zstd needs to reference data in the ZSTD_outBuffer to regenerate
 * matches. Normally zstd maintains its own buffer for this purpose, but passing
 * this flag tells zstd to use the user provided buffer.
 */
#define ZSTD_d_stableOutBuffer ZSTD_d_experimentalParam2

/*! ZSTD_DCtx_setFormat() :
 *  Instruct the decoder context about what kind of data to decode next.
 *  This instruction is mandatory to decode data without a fully-formed header,
 *  such ZSTD_f_zstd1_magicless for example.
 * @return : 0, or an error code (which can be tested using ZSTD_isError()). */
ZSTDLIB_API size_t ZSTD_DCtx_setFormat(ZSTD_DCtx* dctx, ZSTD_format_e format);

/*! ZSTD_decompressStream_simpleArgs() :
 *  Same as ZSTD_decompressStream(),
 *  but using only integral types as arguments.
 *  This can be helpful for binders from dynamic languages
 *  which have troubles handling structures containing memory pointers.
 */
ZSTDLIB_API size_t ZSTD_decompressStream_simpleArgs (
                            ZSTD_DCtx* dctx,
                            void* dst, size_t dstCapacity, size_t* dstPos,
                      const void* src, size_t srcSize, size_t* srcPos);


/********************************************************************
*  Advanced streaming functions
*  Warning : most of these functions are now redundant with the Advanced API.
*  Once Advanced API reaches "stable" status,
*  redundant functions will be deprecated, and then at some point removed.
********************************************************************/

/*=====   Advanced Streaming compression functions  =====*/
/**! ZSTD_initCStream_srcSize() :
 * This function is deprecated, and equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_refCDict(zcs, NULL); // clear the dictionary (if any)
 *     ZSTD_CCtx_setParameter(zcs, ZSTD_c_compressionLevel, compressionLevel);
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *
 * pledgedSrcSize must be correct. If it is not known at init time, use
 * ZSTD_CONTENTSIZE_UNKNOWN. Note that, for compatibility with older programs,
 * "0" also disables frame content size field. It may be enabled in the future.
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t
ZSTD_initCStream_srcSize(ZSTD_CStream* zcs,
                         int compressionLevel,
                         unsigned long long pledgedSrcSize);

/**! ZSTD_initCStream_usingDict() :
 * This function is deprecated, and is equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_setParameter(zcs, ZSTD_c_compressionLevel, compressionLevel);
 *     ZSTD_CCtx_loadDictionary(zcs, dict, dictSize);
 *
 * Creates of an internal CDict (incompatible with static CCtx), except if
 * dict == NULL or dictSize < 8, in which case no dict is used.
 * Note: dict is loaded with ZSTD_dct_auto (treated as a full zstd dictionary if
 * it begins with ZSTD_MAGIC_DICTIONARY, else as raw content) and ZSTD_dlm_byCopy.
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t
ZSTD_initCStream_usingDict(ZSTD_CStream* zcs,
                     const void* dict, size_t dictSize,
                           int compressionLevel);

/**! ZSTD_initCStream_advanced() :
 * This function is deprecated, and is approximately equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     // Pseudocode: Set each zstd parameter and leave the rest as-is.
 *     for ((param, value) : params) {
 *         ZSTD_CCtx_setParameter(zcs, param, value);
 *     }
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *     ZSTD_CCtx_loadDictionary(zcs, dict, dictSize);
 *
 * dict is loaded with ZSTD_dct_auto and ZSTD_dlm_byCopy.
 * pledgedSrcSize must be correct.
 * If srcSize is not known at init time, use value ZSTD_CONTENTSIZE_UNKNOWN.
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t
ZSTD_initCStream_advanced(ZSTD_CStream* zcs,
                    const void* dict, size_t dictSize,
                          ZSTD_parameters params,
                          unsigned long long pledgedSrcSize);

/**! ZSTD_initCStream_usingCDict() :
 * This function is deprecated, and equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_refCDict(zcs, cdict);
 *
 * note : cdict will just be referenced, and must outlive compression session
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t ZSTD_initCStream_usingCDict(ZSTD_CStream* zcs, const ZSTD_CDict* cdict);

/**! ZSTD_initCStream_usingCDict_advanced() :
 *   This function is DEPRECATED, and is approximately equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     // Pseudocode: Set each zstd frame parameter and leave the rest as-is.
 *     for ((fParam, value) : fParams) {
 *         ZSTD_CCtx_setParameter(zcs, fParam, value);
 *     }
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *     ZSTD_CCtx_refCDict(zcs, cdict);
 *
 * same as ZSTD_initCStream_usingCDict(), with control over frame parameters.
 * pledgedSrcSize must be correct. If srcSize is not known at init time, use
 * value ZSTD_CONTENTSIZE_UNKNOWN.
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t
ZSTD_initCStream_usingCDict_advanced(ZSTD_CStream* zcs,
                               const ZSTD_CDict* cdict,
                                     ZSTD_frameParameters fParams,
                                     unsigned long long pledgedSrcSize);

/*! ZSTD_resetCStream() :
 * This function is deprecated, and is equivalent to:
 *     ZSTD_CCtx_reset(zcs, ZSTD_reset_session_only);
 *     ZSTD_CCtx_setPledgedSrcSize(zcs, pledgedSrcSize);
 *
 *  start a new frame, using same parameters from previous frame.
 *  This is typically useful to skip dictionary loading stage, since it will re-use it in-place.
 *  Note that zcs must be init at least once before using ZSTD_resetCStream().
 *  If pledgedSrcSize is not known at reset time, use macro ZSTD_CONTENTSIZE_UNKNOWN.
 *  If pledgedSrcSize > 0, its value must be correct, as it will be written in header, and controlled at the end.
 *  For the time being, pledgedSrcSize==0 is interpreted as "srcSize unknown" for compatibility with older programs,
 *  but it will change to mean "empty" in future version, so use macro ZSTD_CONTENTSIZE_UNKNOWN instead.
 * @return : 0, or an error code (which can be tested using ZSTD_isError())
 *  Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t ZSTD_resetCStream(ZSTD_CStream* zcs, unsigned long long pledgedSrcSize);


typedef struct {
    unsigned long long ingested;   /* nb input bytes read and buffered */
    unsigned long long consumed;   /* nb input bytes actually compressed */
    unsigned long long produced;   /* nb of compressed bytes generated and buffered */
    unsigned long long flushed;    /* nb of compressed bytes flushed : not provided; can be tracked from caller side */
    unsigned currentJobID;         /* MT only : latest started job nb */
    unsigned nbActiveWorkers;      /* MT only : nb of workers actively compressing at probe time */
} ZSTD_frameProgression;

/* ZSTD_getFrameProgression() :
 * tells how much data has been ingested (read from input)
 * consumed (input actually compressed) and produced (output) for current frame.
 * Note : (ingested - consumed) is amount of input data buffered internally, not yet compressed.
 * Aggregates progression inside active worker threads.
 */
ZSTDLIB_API ZSTD_frameProgression ZSTD_getFrameProgression(const ZSTD_CCtx* cctx);

/*! ZSTD_toFlushNow() :
 *  Tell how many bytes are ready to be flushed immediately.
 *  Useful for multithreading scenarios (nbWorkers >= 1).
 *  Probe the oldest active job, defined as oldest job not yet entirely flushed,
 *  and check its output buffer.
 * @return : amount of data stored in oldest job and ready to be flushed immediately.
 *  if @return == 0, it means either :
 *  + there is no active job (could be checked with ZSTD_frameProgression()), or
 *  + oldest job is still actively compressing data,
 *    but everything it has produced has also been flushed so far,
 *    therefore flush speed is limited by production speed of oldest job
 *    irrespective of the speed of concurrent (and newer) jobs.
 */
ZSTDLIB_API size_t ZSTD_toFlushNow(ZSTD_CCtx* cctx);


/*=====   Advanced Streaming decompression functions  =====*/
/**
 * This function is deprecated, and is equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *     ZSTD_DCtx_loadDictionary(zds, dict, dictSize);
 *
 * note: no dictionary will be used if dict == NULL or dictSize < 8
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t ZSTD_initDStream_usingDict(ZSTD_DStream* zds, const void* dict, size_t dictSize);

/**
 * This function is deprecated, and is equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *     ZSTD_DCtx_refDDict(zds, ddict);
 *
 * note : ddict is referenced, it must outlive decompression session
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t ZSTD_initDStream_usingDDict(ZSTD_DStream* zds, const ZSTD_DDict* ddict);

/**
 * This function is deprecated, and is equivalent to:
 *
 *     ZSTD_DCtx_reset(zds, ZSTD_reset_session_only);
 *
 * re-use decompression parameters from previous init; saves dictionary loading
 * Note : this prototype will be marked as deprecated and generate compilation warnings on reaching v1.5.x
 */
ZSTDLIB_API size_t ZSTD_resetDStream(ZSTD_DStream* zds);


/*********************************************************************
*  Buffer-less and synchronous inner streaming functions
*
*  This is an advanced API, giving full control over buffer management, for users which need direct control over memory.
*  But it's also a complex one, with several restrictions, documented below.
*  Prefer normal streaming API for an easier experience.
********************************************************************* */

/**
  Buffer-less streaming compression (synchronous mode)

  A ZSTD_CCtx object is required to track streaming operations.
  Use ZSTD_createCCtx() / ZSTD_freeCCtx() to manage resource.
  ZSTD_CCtx object can be re-used multiple times within successive compression operations.

  Start by initializing a context.
  Use ZSTD_compressBegin(), or ZSTD_compressBegin_usingDict() for dictionary compression,
  or ZSTD_compressBegin_advanced(), for finer parameter control.
  It's also possible to duplicate a reference context which has already been initialized, using ZSTD_copyCCtx()

  Then, consume your input using ZSTD_compressContinue().
  There are some important considerations to keep in mind when using this advanced function :
  - ZSTD_compressContinue() has no internal buffer. It uses externally provided buffers only.
  - Interface is synchronous : input is consumed entirely and produces 1+ compressed blocks.
  - Caller must ensure there is enough space in `dst` to store compressed data under worst case scenario.
    Worst case evaluation is provided by ZSTD_compressBound().
    ZSTD_compressContinue() doesn't guarantee recover after a failed compression.
  - ZSTD_compressContinue() presumes prior input ***is still accessible and unmodified*** (up to maximum distance size, see WindowLog).
    It remembers all previous contiguous blocks, plus one separated memory segment (which can itself consists of multiple contiguous blocks)
  - ZSTD_compressContinue() detects that prior input has been overwritten when `src` buffer overlaps.
    In which case, it will "discard" the relevant memory section from its history.

  Finish a frame with ZSTD_compressEnd(), which will write the last block(s) and optional checksum.
  It's possible to use srcSize==0, in which case, it will write a final empty block to end the frame.
  Without last block mark, frames are considered unfinished (hence corrupted) by compliant decoders.

  `ZSTD_CCtx` object can be re-used (ZSTD_compressBegin()) to compress again.
*/

/*=====   Buffer-less streaming compression functions  =====*/
ZSTDLIB_API size_t ZSTD_compressBegin(ZSTD_CCtx* cctx, int compressionLevel);
ZSTDLIB_API size_t ZSTD_compressBegin_usingDict(ZSTD_CCtx* cctx, const void* dict, size_t dictSize, int compressionLevel);
ZSTDLIB_API size_t ZSTD_compressBegin_advanced(ZSTD_CCtx* cctx, const void* dict, size_t dictSize, ZSTD_parameters params, unsigned long long pledgedSrcSize); /**< pledgedSrcSize : If srcSize is not known at init time, use ZSTD_CONTENTSIZE_UNKNOWN */
ZSTDLIB_API size_t ZSTD_compressBegin_usingCDict(ZSTD_CCtx* cctx, const ZSTD_CDict* cdict); /**< note: fails if cdict==NULL */
ZSTDLIB_API size_t ZSTD_compressBegin_usingCDict_advanced(ZSTD_CCtx* const cctx, const ZSTD_CDict* const cdict, ZSTD_frameParameters const fParams, unsigned long long const pledgedSrcSize);   /* compression parameters are already set within cdict. pledgedSrcSize must be correct. If srcSize is not known, use macro ZSTD_CONTENTSIZE_UNKNOWN */
ZSTDLIB_API size_t ZSTD_copyCCtx(ZSTD_CCtx* cctx, const ZSTD_CCtx* preparedCCtx, unsigned long long pledgedSrcSize); /**<  note: if pledgedSrcSize is not known, use ZSTD_CONTENTSIZE_UNKNOWN */

ZSTDLIB_API size_t ZSTD_compressContinue(ZSTD_CCtx* cctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);
ZSTDLIB_API size_t ZSTD_compressEnd(ZSTD_CCtx* cctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);


/*-
  Buffer-less streaming decompression (synchronous mode)

  A ZSTD_DCtx object is required to track streaming operations.
  Use ZSTD_createDCtx() / ZSTD_freeDCtx() to manage it.
  A ZSTD_DCtx object can be re-used multiple times.

  First typical operation is to retrieve frame parameters, using ZSTD_getFrameHeader().
  Frame header is extracted from the beginning of compressed frame, so providing only the frame's beginning is enough.
  Data fragment must be large enough to ensure successful decoding.
 `ZSTD_frameHeaderSize_max` bytes is guaranteed to always be large enough.
  @result : 0 : successful decoding, the `ZSTD_frameHeader` structure is correctly filled.
           >0 : `srcSize` is too small, please provide at least @result bytes on next attempt.
           errorCode, which can be tested using ZSTD_isError().

  It fills a ZSTD_frameHeader structure with important information to correctly decode the frame,
  such as the dictionary ID, content size, or maximum back-reference distance (`windowSize`).
  Note that these values could be wrong, either because of data corruption, or because a 3rd party deliberately spoofs false information.
  As a consequence, check that values remain within valid application range.
  For example, do not allocate memory blindly, check that `windowSize` is within expectation.
  Each application can set its own limits, depending on local restrictions.
  For extended interoperability, it is recommended to support `windowSize` of at least 8 MB.

  ZSTD_decompressContinue() needs previous data blocks during decompression, up to `windowSize` bytes.
  ZSTD_decompressContinue() is very sensitive to contiguity,
  if 2 blocks don't follow each other, make sure that either the compressor breaks contiguity at the same place,
  or that previous contiguous segment is large enough to properly handle maximum back-reference distance.
  There are multiple ways to guarantee this condition.

  The most memory efficient way is to use a round buffer of sufficient size.
  Sufficient size is determined by invoking ZSTD_decodingBufferSize_min(),
  which can @return an error code if required value is too large for current system (in 32-bits mode).
  In a round buffer methodology, ZSTD_decompressContinue() decompresses each block next to previous one,
  up to the moment there is not enough room left in the buffer to guarantee decoding another full block,
  which maximum size is provided in `ZSTD_frameHeader` structure, field `blockSizeMax`.
  At which point, decoding can resume from the beginning of the buffer.
  Note that already decoded data stored in the buffer should be flushed before being overwritten.

  There are alternatives possible, for example using two or more buffers of size `windowSize` each, though they consume more memory.

  Finally, if you control the compression process, you can also ignore all buffer size rules,
  as long as the encoder and decoder progress in "lock-step",
  aka use exactly the same buffer sizes, break contiguity at the same place, etc.

  Once buffers are setup, start decompression, with ZSTD_decompressBegin().
  If decompression requires a dictionary, use ZSTD_decompressBegin_usingDict() or ZSTD_decompressBegin_usingDDict().

  Then use ZSTD_nextSrcSizeToDecompress() and ZSTD_decompressContinue() alternatively.
  ZSTD_nextSrcSizeToDecompress() tells how many bytes to provide as 'srcSize' to ZSTD_decompressContinue().
  ZSTD_decompressContinue() requires this _exact_ amount of bytes, or it will fail.

 @result of ZSTD_decompressContinue() is the number of bytes regenerated within 'dst' (necessarily <= dstCapacity).
  It can be zero : it just means ZSTD_decompressContinue() has decoded some metadata item.
  It can also be an error code, which can be tested with ZSTD_isError().

  A frame is fully decoded when ZSTD_nextSrcSizeToDecompress() returns zero.
  Context can then be reset to start a new decompression.

  Note : it's possible to know if next input to present is a header or a block, using ZSTD_nextInputType().
  This information is not required to properly decode a frame.

  == Special case : skippable frames ==

  Skippable frames allow integration of user-defined data into a flow of concatenated frames.
  Skippable frames will be ignored (skipped) by decompressor.
  The format of skippable frames is as follows :
  a) Skippable frame ID - 4 Bytes, Little endian format, any value from 0x184D2A50 to 0x184D2A5F
  b) Frame Size - 4 Bytes, Little endian format, unsigned 32-bits
  c) Frame Content - any content (User Data) of length equal to Frame Size
  For skippable frames ZSTD_getFrameHeader() returns zfhPtr->frameType==ZSTD_skippableFrame.
  For skippable frames ZSTD_decompressContinue() always returns 0 : it only skips the content.
*/

/*=====   Buffer-less streaming decompression functions  =====*/
typedef enum { ZSTD_frame, ZSTD_skippableFrame } ZSTD_frameType_e;
typedef struct {
    unsigned long long frameContentSize; /* if == ZSTD_CONTENTSIZE_UNKNOWN, it means this field is not available. 0 means "empty" */
    unsigned long long windowSize;       /* can be very large, up to <= frameContentSize */
    unsigned blockSizeMax;
    ZSTD_frameType_e frameType;          /* if == ZSTD_skippableFrame, frameContentSize is the size of skippable content */
    unsigned headerSize;
    unsigned dictID;
    unsigned checksumFlag;
} ZSTD_frameHeader;

/*! ZSTD_getFrameHeader() :
 *  decode Frame Header, or requires larger `srcSize`.
 * @return : 0, `zfhPtr` is correctly filled,
 *          >0, `srcSize` is too small, value is wanted `srcSize` amount,
 *           or an error code, which can be tested using ZSTD_isError() */
ZSTDLIB_API size_t ZSTD_getFrameHeader(ZSTD_frameHeader* zfhPtr, const void* src, size_t srcSize);   /**< doesn't consume input */
/*! ZSTD_getFrameHeader_advanced() :
 *  same as ZSTD_getFrameHeader(),
 *  with added capability to select a format (like ZSTD_f_zstd1_magicless) */
ZSTDLIB_API size_t ZSTD_getFrameHeader_advanced(ZSTD_frameHeader* zfhPtr, const void* src, size_t srcSize, ZSTD_format_e format);
ZSTDLIB_API size_t ZSTD_decodingBufferSize_min(unsigned long long windowSize, unsigned long long frameContentSize);  /**< when frame content size is not known, pass in frameContentSize == ZSTD_CONTENTSIZE_UNKNOWN */

ZSTDLIB_API size_t ZSTD_decompressBegin(ZSTD_DCtx* dctx);
ZSTDLIB_API size_t ZSTD_decompressBegin_usingDict(ZSTD_DCtx* dctx, const void* dict, size_t dictSize);
ZSTDLIB_API size_t ZSTD_decompressBegin_usingDDict(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict);

ZSTDLIB_API size_t ZSTD_nextSrcSizeToDecompress(ZSTD_DCtx* dctx);
ZSTDLIB_API size_t ZSTD_decompressContinue(ZSTD_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);

/* misc */
ZSTDLIB_API void   ZSTD_copyDCtx(ZSTD_DCtx* dctx, const ZSTD_DCtx* preparedDCtx);
typedef enum { ZSTDnit_frameHeader, ZSTDnit_blockHeader, ZSTDnit_block, ZSTDnit_lastBlock, ZSTDnit_checksum, ZSTDnit_skippableFrame } ZSTD_nextInputType_e;
ZSTDLIB_API ZSTD_nextInputType_e ZSTD_nextInputType(ZSTD_DCtx* dctx);




/* ============================ */
/**       Block level API       */
/* ============================ */

/*!
    Block functions produce and decode raw zstd blocks, without frame metadata.
    Frame metadata cost is typically ~12 bytes, which can be non-negligible for very small blocks (< 100 bytes).
    But users will have to take in charge needed metadata to regenerate data, such as compressed and content sizes.

    A few rules to respect :
    - Compressing and decompressing require a context structure
      + Use ZSTD_createCCtx() and ZSTD_createDCtx()
    - It is necessary to init context before starting
      + compression : any ZSTD_compressBegin*() variant, including with dictionary
      + decompression : any ZSTD_decompressBegin*() variant, including with dictionary
      + copyCCtx() and copyDCtx() can be used too
    - Block size is limited, it must be <= ZSTD_getBlockSize() <= ZSTD_BLOCKSIZE_MAX == 128 KB
      + If input is larger than a block size, it's necessary to split input data into multiple blocks
      + For inputs larger than a single block, consider using regular ZSTD_compress() instead.
        Frame metadata is not that costly, and quickly becomes negligible as source size grows larger than a block.
    - When a block is considered not compressible enough, ZSTD_compressBlock() result will be 0 (zero) !
      ===> In which case, nothing is produced into `dst` !
      + User __must__ test for such outcome and deal directly with uncompressed data
      + A block cannot be declared incompressible if ZSTD_compressBlock() return value was != 0.
        Doing so would mess up with statistics history, leading to potential data corruption.
      + ZSTD_decompressBlock() _doesn't accept uncompressed data as input_ !!
      + In case of multiple successive blocks, should some of them be uncompressed,
        decoder must be informed of their existence in order to follow proper history.
        Use ZSTD_insertBlock() for such a case.
*/

/*=====   Raw zstd block functions  =====*/
ZSTDLIB_API size_t ZSTD_getBlockSize   (const ZSTD_CCtx* cctx);
ZSTDLIB_API size_t ZSTD_compressBlock  (ZSTD_CCtx* cctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);
ZSTDLIB_API size_t ZSTD_decompressBlock(ZSTD_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);
ZSTDLIB_API size_t ZSTD_insertBlock    (ZSTD_DCtx* dctx, const void* blockStart, size_t blockSize);  /**< insert uncompressed block into `dctx` history. Useful for multi-blocks decompression. */


#endif   /* ZSTD_H_ZSTD_STATIC_LINKING_ONLY */

#if defined (__cplusplus)
}
#endif
/**** ended inlining ../zstd.h ****/
#define FSE_STATIC_LINKING_ONLY
/**** skipping file: fse.h ****/
#define HUF_STATIC_LINKING_ONLY
/**** skipping file: huf.h ****/
#ifndef XXH_STATIC_LINKING_ONLY
#  define XXH_STATIC_LINKING_ONLY  /* XXH64_state_t */
#endif
/**** start inlining xxhash.h ****/
/*
 * xxHash - Extremely Fast Hash algorithm
 * Header File
 * Copyright (c) 2012-2020, Yann Collet, Facebook, Inc.
 *
 * You can contact the author at :
 * - xxHash source repository : https://github.com/Cyan4973/xxHash
 * 
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
*/

/* Notice extracted from xxHash homepage :

xxHash is an extremely fast Hash algorithm, running at RAM speed limits.
It also successfully passes all tests from the SMHasher suite.

Comparison (single thread, Windows Seven 32 bits, using SMHasher on a Core 2 Duo @3GHz)

Name            Speed       Q.Score   Author
xxHash          5.4 GB/s     10
CrapWow         3.2 GB/s      2       Andrew
MumurHash 3a    2.7 GB/s     10       Austin Appleby
SpookyHash      2.0 GB/s     10       Bob Jenkins
SBox            1.4 GB/s      9       Bret Mulvey
Lookup3         1.2 GB/s      9       Bob Jenkins
SuperFastHash   1.2 GB/s      1       Paul Hsieh
CityHash64      1.05 GB/s    10       Pike & Alakuijala
FNV             0.55 GB/s     5       Fowler, Noll, Vo
CRC32           0.43 GB/s     9
MD5-32          0.33 GB/s    10       Ronald L. Rivest
SHA1-32         0.28 GB/s    10

Q.Score is a measure of quality of the hash function.
It depends on successfully passing SMHasher test set.
10 is a perfect score.

A 64-bits version, named XXH64, is available since r35.
It offers much better speed, but for 64-bits applications only.
Name     Speed on 64 bits    Speed on 32 bits
XXH64       13.8 GB/s            1.9 GB/s
XXH32        6.8 GB/s            6.0 GB/s
*/

#if defined (__cplusplus)
extern "C" {
#endif

#ifndef XXHASH_H_5627135585666179
#define XXHASH_H_5627135585666179 1


/* ****************************
*  Definitions
******************************/
#include <stddef.h>   /* size_t */
typedef enum { XXH_OK=0, XXH_ERROR } XXH_errorcode;


/* ****************************
*  API modifier
******************************/
/** XXH_PRIVATE_API
*   This is useful if you want to include xxhash functions in `static` mode
*   in order to inline them, and remove their symbol from the public list.
*   Methodology :
*     #define XXH_PRIVATE_API
*     #include "xxhash.h"
*   `xxhash.c` is automatically included.
*   It's not useful to compile and link it as a separate module anymore.
*/
#ifdef XXH_PRIVATE_API
#  ifndef XXH_STATIC_LINKING_ONLY
#    define XXH_STATIC_LINKING_ONLY
#  endif
#  if defined(__GNUC__)
#    define XXH_PUBLIC_API static __inline __attribute__((unused))
#  elif defined (__cplusplus) || (defined (__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) /* C99 */)
#    define XXH_PUBLIC_API static inline
#  elif defined(_MSC_VER)
#    define XXH_PUBLIC_API static __inline
#  else
#    define XXH_PUBLIC_API static   /* this version may generate warnings for unused static functions; disable the relevant warning */
#  endif
#else
#  define XXH_PUBLIC_API   /* do nothing */
#endif /* XXH_PRIVATE_API */

/*!XXH_NAMESPACE, aka Namespace Emulation :

If you want to include _and expose_ xxHash functions from within your own library,
but also want to avoid symbol collisions with another library which also includes xxHash,

you can use XXH_NAMESPACE, to automatically prefix any public symbol from xxhash library
with the value of XXH_NAMESPACE (so avoid to keep it NULL and avoid numeric values).

Note that no change is required within the calling program as long as it includes `xxhash.h` :
regular symbol name will be automatically translated by this header.
*/
#ifdef XXH_NAMESPACE
#  define XXH_CAT(A,B) A##B
#  define XXH_NAME2(A,B) XXH_CAT(A,B)
#  define XXH32 XXH_NAME2(XXH_NAMESPACE, XXH32)
#  define XXH64 XXH_NAME2(XXH_NAMESPACE, XXH64)
#  define XXH_versionNumber XXH_NAME2(XXH_NAMESPACE, XXH_versionNumber)
#  define XXH32_createState XXH_NAME2(XXH_NAMESPACE, XXH32_createState)
#  define XXH64_createState XXH_NAME2(XXH_NAMESPACE, XXH64_createState)
#  define XXH32_freeState XXH_NAME2(XXH_NAMESPACE, XXH32_freeState)
#  define XXH64_freeState XXH_NAME2(XXH_NAMESPACE, XXH64_freeState)
#  define XXH32_reset XXH_NAME2(XXH_NAMESPACE, XXH32_reset)
#  define XXH64_reset XXH_NAME2(XXH_NAMESPACE, XXH64_reset)
#  define XXH32_update XXH_NAME2(XXH_NAMESPACE, XXH32_update)
#  define XXH64_update XXH_NAME2(XXH_NAMESPACE, XXH64_update)
#  define XXH32_digest XXH_NAME2(XXH_NAMESPACE, XXH32_digest)
#  define XXH64_digest XXH_NAME2(XXH_NAMESPACE, XXH64_digest)
#  define XXH32_copyState XXH_NAME2(XXH_NAMESPACE, XXH32_copyState)
#  define XXH64_copyState XXH_NAME2(XXH_NAMESPACE, XXH64_copyState)
#  define XXH32_canonicalFromHash XXH_NAME2(XXH_NAMESPACE, XXH32_canonicalFromHash)
#  define XXH64_canonicalFromHash XXH_NAME2(XXH_NAMESPACE, XXH64_canonicalFromHash)
#  define XXH32_hashFromCanonical XXH_NAME2(XXH_NAMESPACE, XXH32_hashFromCanonical)
#  define XXH64_hashFromCanonical XXH_NAME2(XXH_NAMESPACE, XXH64_hashFromCanonical)
#endif


/* *************************************
*  Version
***************************************/
#define XXH_VERSION_MAJOR    0
#define XXH_VERSION_MINOR    6
#define XXH_VERSION_RELEASE  2
#define XXH_VERSION_NUMBER  (XXH_VERSION_MAJOR *100*100 + XXH_VERSION_MINOR *100 + XXH_VERSION_RELEASE)
XXH_PUBLIC_API unsigned XXH_versionNumber (void);


/* ****************************
*  Simple Hash Functions
******************************/
typedef unsigned int       XXH32_hash_t;
typedef unsigned long long XXH64_hash_t;

XXH_PUBLIC_API XXH32_hash_t XXH32 (const void* input, size_t length, unsigned int seed);
XXH_PUBLIC_API XXH64_hash_t XXH64 (const void* input, size_t length, unsigned long long seed);

/*!
XXH32() :
    Calculate the 32-bits hash of sequence "length" bytes stored at memory address "input".
    The memory between input & input+length must be valid (allocated and read-accessible).
    "seed" can be used to alter the result predictably.
    Speed on Core 2 Duo @ 3 GHz (single thread, SMHasher benchmark) : 5.4 GB/s
XXH64() :
    Calculate the 64-bits hash of sequence of length "len" stored at memory address "input".
    "seed" can be used to alter the result predictably.
    This function runs 2x faster on 64-bits systems, but slower on 32-bits systems (see benchmark).
*/


/* ****************************
*  Streaming Hash Functions
******************************/
typedef struct XXH32_state_s XXH32_state_t;   /* incomplete type */
typedef struct XXH64_state_s XXH64_state_t;   /* incomplete type */

/*! State allocation, compatible with dynamic libraries */

XXH_PUBLIC_API XXH32_state_t* XXH32_createState(void);
XXH_PUBLIC_API XXH_errorcode  XXH32_freeState(XXH32_state_t* statePtr);

XXH_PUBLIC_API XXH64_state_t* XXH64_createState(void);
XXH_PUBLIC_API XXH_errorcode  XXH64_freeState(XXH64_state_t* statePtr);


/* hash streaming */

XXH_PUBLIC_API XXH_errorcode XXH32_reset  (XXH32_state_t* statePtr, unsigned int seed);
XXH_PUBLIC_API XXH_errorcode XXH32_update (XXH32_state_t* statePtr, const void* input, size_t length);
XXH_PUBLIC_API XXH32_hash_t  XXH32_digest (const XXH32_state_t* statePtr);

XXH_PUBLIC_API XXH_errorcode XXH64_reset  (XXH64_state_t* statePtr, unsigned long long seed);
XXH_PUBLIC_API XXH_errorcode XXH64_update (XXH64_state_t* statePtr, const void* input, size_t length);
XXH_PUBLIC_API XXH64_hash_t  XXH64_digest (const XXH64_state_t* statePtr);

/*
These functions generate the xxHash of an input provided in multiple segments.
Note that, for small input, they are slower than single-call functions, due to state management.
For small input, prefer `XXH32()` and `XXH64()` .

XXH state must first be allocated, using XXH*_createState() .

Start a new hash by initializing state with a seed, using XXH*_reset().

Then, feed the hash state by calling XXH*_update() as many times as necessary.
Obviously, input must be allocated and read accessible.
The function returns an error code, with 0 meaning OK, and any other value meaning there is an error.

Finally, a hash value can be produced anytime, by using XXH*_digest().
This function returns the nn-bits hash as an int or long long.

It's still possible to continue inserting input into the hash state after a digest,
and generate some new hashes later on, by calling again XXH*_digest().

When done, free XXH state space if it was allocated dynamically.
*/


/* **************************
*  Utils
****************************/
#if !(defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L))   /* ! C99 */
#  define restrict   /* disable restrict */
#endif

XXH_PUBLIC_API void XXH32_copyState(XXH32_state_t* restrict dst_state, const XXH32_state_t* restrict src_state);
XXH_PUBLIC_API void XXH64_copyState(XXH64_state_t* restrict dst_state, const XXH64_state_t* restrict src_state);


/* **************************
*  Canonical representation
****************************/
/* Default result type for XXH functions are primitive unsigned 32 and 64 bits.
*  The canonical representation uses human-readable write convention, aka big-endian (large digits first).
*  These functions allow transformation of hash result into and from its canonical format.
*  This way, hash values can be written into a file / memory, and remain comparable on different systems and programs.
*/
typedef struct { unsigned char digest[4]; } XXH32_canonical_t;
typedef struct { unsigned char digest[8]; } XXH64_canonical_t;

XXH_PUBLIC_API void XXH32_canonicalFromHash(XXH32_canonical_t* dst, XXH32_hash_t hash);
XXH_PUBLIC_API void XXH64_canonicalFromHash(XXH64_canonical_t* dst, XXH64_hash_t hash);

XXH_PUBLIC_API XXH32_hash_t XXH32_hashFromCanonical(const XXH32_canonical_t* src);
XXH_PUBLIC_API XXH64_hash_t XXH64_hashFromCanonical(const XXH64_canonical_t* src);

#endif /* XXHASH_H_5627135585666179 */



/* ================================================================================================
   This section contains definitions which are not guaranteed to remain stable.
   They may change in future versions, becoming incompatible with a different version of the library.
   They shall only be used with static linking.
   Never use these definitions in association with dynamic linking !
=================================================================================================== */
#if defined(XXH_STATIC_LINKING_ONLY) && !defined(XXH_STATIC_H_3543687687345)
#define XXH_STATIC_H_3543687687345

/* These definitions are only meant to allow allocation of XXH state
   statically, on stack, or in a struct for example.
   Do not use members directly. */

   struct XXH32_state_s {
       unsigned total_len_32;
       unsigned large_len;
       unsigned v1;
       unsigned v2;
       unsigned v3;
       unsigned v4;
       unsigned mem32[4];   /* buffer defined as U32 for alignment */
       unsigned memsize;
       unsigned reserved;   /* never read nor write, will be removed in a future version */
   };   /* typedef'd to XXH32_state_t */

   struct XXH64_state_s {
       unsigned long long total_len;
       unsigned long long v1;
       unsigned long long v2;
       unsigned long long v3;
       unsigned long long v4;
       unsigned long long mem64[4];   /* buffer defined as U64 for alignment */
       unsigned memsize;
       unsigned reserved[2];          /* never read nor write, will be removed in a future version */
   };   /* typedef'd to XXH64_state_t */


#  ifdef XXH_PRIVATE_API
/**** start inlining xxhash.c ****/
/*
 *  xxHash - Fast Hash algorithm
 *  Copyright (c) 2012-2020, Yann Collet, Facebook, Inc.
 *
 *  You can contact the author at :
 *  - xxHash homepage: http://www.xxhash.com
 *  - xxHash source repository : https://github.com/Cyan4973/xxHash
 * 
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
*/


/* *************************************
*  Tuning parameters
***************************************/
/*!XXH_FORCE_MEMORY_ACCESS :
 * By default, access to unaligned memory is controlled by `memcpy()`, which is safe and portable.
 * Unfortunately, on some target/compiler combinations, the generated assembly is sub-optimal.
 * The below switch allow to select different access method for improved performance.
 * Method 0 (default) : use `memcpy()`. Safe and portable.
 * Method 1 : `__packed` statement. It depends on compiler extension (ie, not portable).
 *            This method is safe if your compiler supports it, and *generally* as fast or faster than `memcpy`.
 * Method 2 : direct access. This method doesn't depend on compiler but violate C standard.
 *            It can generate buggy code on targets which do not support unaligned memory accesses.
 *            But in some circumstances, it's the only known way to get the most performance (ie GCC + ARMv6)
 * See http://stackoverflow.com/a/32095106/646947 for details.
 * Prefer these methods in priority order (0 > 1 > 2)
 */
#ifndef XXH_FORCE_MEMORY_ACCESS   /* can be defined externally, on command line for example */
#  if defined(__GNUC__) && ( defined(__ARM_ARCH_6__) || defined(__ARM_ARCH_6J__) || defined(__ARM_ARCH_6K__) || defined(__ARM_ARCH_6Z__) || defined(__ARM_ARCH_6ZK__) || defined(__ARM_ARCH_6T2__) )
#    define XXH_FORCE_MEMORY_ACCESS 2
#  elif (defined(__INTEL_COMPILER) && !defined(WIN32)) || \
  (defined(__GNUC__) && ( defined(__ARM_ARCH_7__) || defined(__ARM_ARCH_7A__) || defined(__ARM_ARCH_7R__) || defined(__ARM_ARCH_7M__) || defined(__ARM_ARCH_7S__) )) || \
  defined(__ICCARM__)
#    define XXH_FORCE_MEMORY_ACCESS 1
#  endif
#endif

/*!XXH_ACCEPT_NULL_INPUT_POINTER :
 * If the input pointer is a null pointer, xxHash default behavior is to trigger a memory access error, since it is a bad pointer.
 * When this option is enabled, xxHash output for null input pointers will be the same as a null-length input.
 * By default, this option is disabled. To enable it, uncomment below define :
 */
/* #define XXH_ACCEPT_NULL_INPUT_POINTER 1 */

/*!XXH_FORCE_NATIVE_FORMAT :
 * By default, xxHash library provides endian-independent Hash values, based on little-endian convention.
 * Results are therefore identical for little-endian and big-endian CPU.
 * This comes at a performance cost for big-endian CPU, since some swapping is required to emulate little-endian format.
 * Should endian-independence be of no importance for your application, you may set the #define below to 1,
 * to improve speed for Big-endian CPU.
 * This option has no impact on Little_Endian CPU.
 */
#ifndef XXH_FORCE_NATIVE_FORMAT   /* can be defined externally */
#  define XXH_FORCE_NATIVE_FORMAT 0
#endif

/*!XXH_FORCE_ALIGN_CHECK :
 * This is a minor performance trick, only useful with lots of very small keys.
 * It means : check for aligned/unaligned input.
 * The check costs one initial branch per hash; set to 0 when the input data
 * is guaranteed to be aligned.
 */
#ifndef XXH_FORCE_ALIGN_CHECK /* can be defined externally */
#  if defined(__i386) || defined(_M_IX86) || defined(__x86_64__) || defined(_M_X64)
#    define XXH_FORCE_ALIGN_CHECK 0
#  else
#    define XXH_FORCE_ALIGN_CHECK 1
#  endif
#endif


/* *************************************
*  Includes & Memory related functions
***************************************/
/* Modify the local functions below should you wish to use some other memory routines */
/* for malloc(), free() */
#include <stddef.h>     /* size_t */
static void* XXH_malloc(size_t s) { return malloc(s); }
static void  XXH_free  (void* p)  { free(p); }
/* for memcpy() */
static void* XXH_memcpy(void* dest, const void* src, size_t size) { return memcpy(dest,src,size); }

#ifndef XXH_STATIC_LINKING_ONLY
#  define XXH_STATIC_LINKING_ONLY
#endif
/**** skipping file: xxhash.h ****/


/* *************************************
*  Compiler Specific Options
***************************************/
#if (defined(__GNUC__) && !defined(__STRICT_ANSI__)) || defined(__cplusplus) || defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L   /* C99 */
#  define INLINE_KEYWORD inline
#else
#  define INLINE_KEYWORD
#endif

#if defined(__GNUC__) || defined(__ICCARM__)
#  define FORCE_INLINE_ATTR __attribute__((always_inline))
#elif defined(_MSC_VER)
#  define FORCE_INLINE_ATTR __forceinline
#else
#  define FORCE_INLINE_ATTR
#endif

#define FORCE_INLINE_TEMPLATE static INLINE_KEYWORD FORCE_INLINE_ATTR


#ifdef _MSC_VER
#  pragma warning(disable : 4127)      /* disable: C4127: conditional expression is constant */
#endif


/* *************************************
*  Basic Types
***************************************/
#ifndef MEM_MODULE
# define MEM_MODULE
# if !defined (__VMS) && (defined (__cplusplus) || (defined (__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) /* C99 */) )
#   include <stdint.h>
    typedef uint8_t  BYTE;
    typedef uint16_t U16;
    typedef uint32_t U32;
    typedef  int32_t S32;
    typedef uint64_t U64;
#  else
    typedef unsigned char      BYTE;
    typedef unsigned short     U16;
    typedef unsigned int       U32;
    typedef   signed int       S32;
    typedef unsigned long long U64;   /* if your compiler doesn't support unsigned long long, replace by another 64-bit type here. Note that xxhash.h will also need to be updated. */
#  endif
#endif


#if (defined(XXH_FORCE_MEMORY_ACCESS) && (XXH_FORCE_MEMORY_ACCESS==2))

/* Force direct memory access. Only works on CPU which support unaligned memory access in hardware */
static U32 XXH_read32(const void* memPtr) { return *(const U32*) memPtr; }
static U64 XXH_read64(const void* memPtr) { return *(const U64*) memPtr; }

#elif (defined(XXH_FORCE_MEMORY_ACCESS) && (XXH_FORCE_MEMORY_ACCESS==1))

/* __pack instructions are safer, but compiler specific, hence potentially problematic for some compilers */
/* currently only defined for gcc and icc */
typedef union { U32 u32; U64 u64; } __attribute__((packed)) unalign;

static U32 XXH_read32(const void* ptr) { return ((const unalign*)ptr)->u32; }
static U64 XXH_read64(const void* ptr) { return ((const unalign*)ptr)->u64; }

#else

/* portable and safe solution. Generally efficient.
 * see : http://stackoverflow.com/a/32095106/646947
 */

static U32 XXH_read32(const void* memPtr)
{
    U32 val;
    memcpy(&val, memPtr, sizeof(val));
    return val;
}

static U64 XXH_read64(const void* memPtr)
{
    U64 val;
    memcpy(&val, memPtr, sizeof(val));
    return val;
}

#endif   /* XXH_FORCE_DIRECT_MEMORY_ACCESS */


/* ****************************************
*  Compiler-specific Functions and Macros
******************************************/
#define GCC_VERSION (__GNUC__ * 100 + __GNUC_MINOR__)

/* Note : although _rotl exists for minGW (GCC under windows), performance seems poor */
#if defined(_MSC_VER)
#  define XXH_rotl32(x,r) _rotl(x,r)
#  define XXH_rotl64(x,r) _rotl64(x,r)
#else
#if defined(__ICCARM__)
#  include <intrinsics.h>
#  define XXH_rotl32(x,r) __ROR(x,(32 - r))
#else
#  define XXH_rotl32(x,r) ((x << r) | (x >> (32 - r)))
#endif
#  define XXH_rotl64(x,r) ((x << r) | (x >> (64 - r)))
#endif

#if defined(_MSC_VER)     /* Visual Studio */
#  define XXH_swap32 _byteswap_ulong
#  define XXH_swap64 _byteswap_uint64
#elif GCC_VERSION >= 403
#  define XXH_swap32 __builtin_bswap32
#  define XXH_swap64 __builtin_bswap64
#else
static U32 XXH_swap32 (U32 x)
{
    return  ((x << 24) & 0xff000000 ) |
            ((x <<  8) & 0x00ff0000 ) |
            ((x >>  8) & 0x0000ff00 ) |
            ((x >> 24) & 0x000000ff );
}
static U64 XXH_swap64 (U64 x)
{
    return  ((x << 56) & 0xff00000000000000ULL) |
            ((x << 40) & 0x00ff000000000000ULL) |
            ((x << 24) & 0x0000ff0000000000ULL) |
            ((x << 8)  & 0x000000ff00000000ULL) |
            ((x >> 8)  & 0x00000000ff000000ULL) |
            ((x >> 24) & 0x0000000000ff0000ULL) |
            ((x >> 40) & 0x000000000000ff00ULL) |
            ((x >> 56) & 0x00000000000000ffULL);
}
#endif


/* *************************************
*  Architecture Macros
***************************************/
typedef enum { XXH_bigEndian=0, XXH_littleEndian=1 } XXH_endianess;

/* XXH_CPU_LITTLE_ENDIAN can be defined externally, for example on the compiler command line */
#ifndef XXH_CPU_LITTLE_ENDIAN
    static const int g_one = 1;
#   define XXH_CPU_LITTLE_ENDIAN   (*(const char*)(&g_one))
#endif


/* ***************************
*  Memory reads
*****************************/
typedef enum { XXH_aligned, XXH_unaligned } XXH_alignment;

FORCE_INLINE_TEMPLATE U32 XXH_readLE32_align(const void* ptr, XXH_endianess endian, XXH_alignment align)
{
    if (align==XXH_unaligned)
        return endian==XXH_littleEndian ? XXH_read32(ptr) : XXH_swap32(XXH_read32(ptr));
    else
        return endian==XXH_littleEndian ? *(const U32*)ptr : XXH_swap32(*(const U32*)ptr);
}

FORCE_INLINE_TEMPLATE U32 XXH_readLE32(const void* ptr, XXH_endianess endian)
{
    return XXH_readLE32_align(ptr, endian, XXH_unaligned);
}

static U32 XXH_readBE32(const void* ptr)
{
    return XXH_CPU_LITTLE_ENDIAN ? XXH_swap32(XXH_read32(ptr)) : XXH_read32(ptr);
}

FORCE_INLINE_TEMPLATE U64 XXH_readLE64_align(const void* ptr, XXH_endianess endian, XXH_alignment align)
{
    if (align==XXH_unaligned)
        return endian==XXH_littleEndian ? XXH_read64(ptr) : XXH_swap64(XXH_read64(ptr));
    else
        return endian==XXH_littleEndian ? *(const U64*)ptr : XXH_swap64(*(const U64*)ptr);
}

FORCE_INLINE_TEMPLATE U64 XXH_readLE64(const void* ptr, XXH_endianess endian)
{
    return XXH_readLE64_align(ptr, endian, XXH_unaligned);
}

static U64 XXH_readBE64(const void* ptr)
{
    return XXH_CPU_LITTLE_ENDIAN ? XXH_swap64(XXH_read64(ptr)) : XXH_read64(ptr);
}


/* *************************************
*  Macros
***************************************/
#define XXH_STATIC_ASSERT(c)   { enum { XXH_static_assert = 1/(int)(!!(c)) }; }    /* use only *after* variable declarations */


/* *************************************
*  Constants
***************************************/
static const U32 PRIME32_1 = 2654435761U;
static const U32 PRIME32_2 = 2246822519U;
static const U32 PRIME32_3 = 3266489917U;
static const U32 PRIME32_4 =  668265263U;
static const U32 PRIME32_5 =  374761393U;

static const U64 PRIME64_1 = 11400714785074694791ULL;
static const U64 PRIME64_2 = 14029467366897019727ULL;
static const U64 PRIME64_3 =  1609587929392839161ULL;
static const U64 PRIME64_4 =  9650029242287828579ULL;
static const U64 PRIME64_5 =  2870177450012600261ULL;

XXH_PUBLIC_API unsigned XXH_versionNumber (void) { return XXH_VERSION_NUMBER; }


/* **************************
*  Utils
****************************/
XXH_PUBLIC_API void XXH32_copyState(XXH32_state_t* restrict dstState, const XXH32_state_t* restrict srcState)
{
    memcpy(dstState, srcState, sizeof(*dstState));
}

XXH_PUBLIC_API void XXH64_copyState(XXH64_state_t* restrict dstState, const XXH64_state_t* restrict srcState)
{
    memcpy(dstState, srcState, sizeof(*dstState));
}


/* ***************************
*  Simple Hash Functions
*****************************/

static U32 XXH32_round(U32 seed, U32 input)
{
    seed += input * PRIME32_2;
    seed  = XXH_rotl32(seed, 13);
    seed *= PRIME32_1;
    return seed;
}

FORCE_INLINE_TEMPLATE U32 XXH32_endian_align(const void* input, size_t len, U32 seed, XXH_endianess endian, XXH_alignment align)
{
    const BYTE* p = (const BYTE*)input;
    const BYTE* bEnd = p + len;
    U32 h32;
#define XXH_get32bits(p) XXH_readLE32_align(p, endian, align)

#ifdef XXH_ACCEPT_NULL_INPUT_POINTER
    if (p==NULL) {
        len=0;
        bEnd=p=(const BYTE*)(size_t)16;
    }
#endif

    if (len>=16) {
        const BYTE* const limit = bEnd - 16;
        U32 v1 = seed + PRIME32_1 + PRIME32_2;
        U32 v2 = seed + PRIME32_2;
        U32 v3 = seed + 0;
        U32 v4 = seed - PRIME32_1;

        do {
            v1 = XXH32_round(v1, XXH_get32bits(p)); p+=4;
            v2 = XXH32_round(v2, XXH_get32bits(p)); p+=4;
            v3 = XXH32_round(v3, XXH_get32bits(p)); p+=4;
            v4 = XXH32_round(v4, XXH_get32bits(p)); p+=4;
        } while (p<=limit);

        h32 = XXH_rotl32(v1, 1) + XXH_rotl32(v2, 7) + XXH_rotl32(v3, 12) + XXH_rotl32(v4, 18);
    } else {
        h32  = seed + PRIME32_5;
    }

    h32 += (U32) len;

    while (p+4<=bEnd) {
        h32 += XXH_get32bits(p) * PRIME32_3;
        h32  = XXH_rotl32(h32, 17) * PRIME32_4 ;
        p+=4;
    }

    while (p<bEnd) {
        h32 += (*p) * PRIME32_5;
        h32 = XXH_rotl32(h32, 11) * PRIME32_1 ;
        p++;
    }

    h32 ^= h32 >> 15;
    h32 *= PRIME32_2;
    h32 ^= h32 >> 13;
    h32 *= PRIME32_3;
    h32 ^= h32 >> 16;

    return h32;
}


XXH_PUBLIC_API unsigned int XXH32 (const void* input, size_t len, unsigned int seed)
{
#if 0
    /* Simple version, good for code maintenance, but unfortunately slow for small inputs */
    XXH32_CREATESTATE_STATIC(state);
    XXH32_reset(state, seed);
    XXH32_update(state, input, len);
    return XXH32_digest(state);
#else
    XXH_endianess endian_detected = (XXH_endianess)XXH_CPU_LITTLE_ENDIAN;

    if (XXH_FORCE_ALIGN_CHECK) {
        if ((((size_t)input) & 3) == 0) {   /* Input is 4-bytes aligned, leverage the speed benefit */
            if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
                return XXH32_endian_align(input, len, seed, XXH_littleEndian, XXH_aligned);
            else
                return XXH32_endian_align(input, len, seed, XXH_bigEndian, XXH_aligned);
    }   }

    if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
        return XXH32_endian_align(input, len, seed, XXH_littleEndian, XXH_unaligned);
    else
        return XXH32_endian_align(input, len, seed, XXH_bigEndian, XXH_unaligned);
#endif
}


static U64 XXH64_round(U64 acc, U64 input)
{
    acc += input * PRIME64_2;
    acc  = XXH_rotl64(acc, 31);
    acc *= PRIME64_1;
    return acc;
}

static U64 XXH64_mergeRound(U64 acc, U64 val)
{
    val  = XXH64_round(0, val);
    acc ^= val;
    acc  = acc * PRIME64_1 + PRIME64_4;
    return acc;
}

FORCE_INLINE_TEMPLATE U64 XXH64_endian_align(const void* input, size_t len, U64 seed, XXH_endianess endian, XXH_alignment align)
{
    const BYTE* p = (const BYTE*)input;
    const BYTE* const bEnd = p + len;
    U64 h64;
#define XXH_get64bits(p) XXH_readLE64_align(p, endian, align)

#ifdef XXH_ACCEPT_NULL_INPUT_POINTER
    if (p==NULL) {
        len=0;
        bEnd=p=(const BYTE*)(size_t)32;
    }
#endif

    if (len>=32) {
        const BYTE* const limit = bEnd - 32;
        U64 v1 = seed + PRIME64_1 + PRIME64_2;
        U64 v2 = seed + PRIME64_2;
        U64 v3 = seed + 0;
        U64 v4 = seed - PRIME64_1;

        do {
            v1 = XXH64_round(v1, XXH_get64bits(p)); p+=8;
            v2 = XXH64_round(v2, XXH_get64bits(p)); p+=8;
            v3 = XXH64_round(v3, XXH_get64bits(p)); p+=8;
            v4 = XXH64_round(v4, XXH_get64bits(p)); p+=8;
        } while (p<=limit);

        h64 = XXH_rotl64(v1, 1) + XXH_rotl64(v2, 7) + XXH_rotl64(v3, 12) + XXH_rotl64(v4, 18);
        h64 = XXH64_mergeRound(h64, v1);
        h64 = XXH64_mergeRound(h64, v2);
        h64 = XXH64_mergeRound(h64, v3);
        h64 = XXH64_mergeRound(h64, v4);

    } else {
        h64  = seed + PRIME64_5;
    }

    h64 += (U64) len;

    while (p+8<=bEnd) {
        U64 const k1 = XXH64_round(0, XXH_get64bits(p));
        h64 ^= k1;
        h64  = XXH_rotl64(h64,27) * PRIME64_1 + PRIME64_4;
        p+=8;
    }

    if (p+4<=bEnd) {
        h64 ^= (U64)(XXH_get32bits(p)) * PRIME64_1;
        h64 = XXH_rotl64(h64, 23) * PRIME64_2 + PRIME64_3;
        p+=4;
    }

    while (p<bEnd) {
        h64 ^= (*p) * PRIME64_5;
        h64 = XXH_rotl64(h64, 11) * PRIME64_1;
        p++;
    }

    h64 ^= h64 >> 33;
    h64 *= PRIME64_2;
    h64 ^= h64 >> 29;
    h64 *= PRIME64_3;
    h64 ^= h64 >> 32;

    return h64;
}


XXH_PUBLIC_API unsigned long long XXH64 (const void* input, size_t len, unsigned long long seed)
{
#if 0
    /* Simple version, good for code maintenance, but unfortunately slow for small inputs */
    XXH64_CREATESTATE_STATIC(state);
    XXH64_reset(state, seed);
    XXH64_update(state, input, len);
    return XXH64_digest(state);
#else
    XXH_endianess endian_detected = (XXH_endianess)XXH_CPU_LITTLE_ENDIAN;

    if (XXH_FORCE_ALIGN_CHECK) {
        if ((((size_t)input) & 7)==0) {  /* Input is aligned, let's leverage the speed advantage */
            if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
                return XXH64_endian_align(input, len, seed, XXH_littleEndian, XXH_aligned);
            else
                return XXH64_endian_align(input, len, seed, XXH_bigEndian, XXH_aligned);
    }   }

    if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
        return XXH64_endian_align(input, len, seed, XXH_littleEndian, XXH_unaligned);
    else
        return XXH64_endian_align(input, len, seed, XXH_bigEndian, XXH_unaligned);
#endif
}


/* **************************************************
*  Advanced Hash Functions
****************************************************/

XXH_PUBLIC_API XXH32_state_t* XXH32_createState(void)
{
    return (XXH32_state_t*)XXH_malloc(sizeof(XXH32_state_t));
}
XXH_PUBLIC_API XXH_errorcode XXH32_freeState(XXH32_state_t* statePtr)
{
    XXH_free(statePtr);
    return XXH_OK;
}

XXH_PUBLIC_API XXH64_state_t* XXH64_createState(void)
{
    return (XXH64_state_t*)XXH_malloc(sizeof(XXH64_state_t));
}
XXH_PUBLIC_API XXH_errorcode XXH64_freeState(XXH64_state_t* statePtr)
{
    XXH_free(statePtr);
    return XXH_OK;
}


/*** Hash feed ***/

XXH_PUBLIC_API XXH_errorcode XXH32_reset(XXH32_state_t* statePtr, unsigned int seed)
{
    XXH32_state_t state;   /* using a local state to memcpy() in order to avoid strict-aliasing warnings */
    memset(&state, 0, sizeof(state)-4);   /* do not write into reserved, for future removal */
    state.v1 = seed + PRIME32_1 + PRIME32_2;
    state.v2 = seed + PRIME32_2;
    state.v3 = seed + 0;
    state.v4 = seed - PRIME32_1;
    memcpy(statePtr, &state, sizeof(state));
    return XXH_OK;
}


XXH_PUBLIC_API XXH_errorcode XXH64_reset(XXH64_state_t* statePtr, unsigned long long seed)
{
    XXH64_state_t state;   /* using a local state to memcpy() in order to avoid strict-aliasing warnings */
    memset(&state, 0, sizeof(state)-8);   /* do not write into reserved, for future removal */
    state.v1 = seed + PRIME64_1 + PRIME64_2;
    state.v2 = seed + PRIME64_2;
    state.v3 = seed + 0;
    state.v4 = seed - PRIME64_1;
    memcpy(statePtr, &state, sizeof(state));
    return XXH_OK;
}


FORCE_INLINE_TEMPLATE XXH_errorcode XXH32_update_endian (XXH32_state_t* state, const void* input, size_t len, XXH_endianess endian)
{
    const BYTE* p = (const BYTE*)input;
    const BYTE* const bEnd = p + len;

#ifdef XXH_ACCEPT_NULL_INPUT_POINTER
    if (input==NULL) return XXH_ERROR;
#endif

    state->total_len_32 += (unsigned)len;
    state->large_len |= (len>=16) | (state->total_len_32>=16);

    if (state->memsize + len < 16)  {   /* fill in tmp buffer */
        XXH_memcpy((BYTE*)(state->mem32) + state->memsize, input, len);
        state->memsize += (unsigned)len;
        return XXH_OK;
    }

    if (state->memsize) {   /* some data left from previous update */
        XXH_memcpy((BYTE*)(state->mem32) + state->memsize, input, 16-state->memsize);
        {   const U32* p32 = state->mem32;
            state->v1 = XXH32_round(state->v1, XXH_readLE32(p32, endian)); p32++;
            state->v2 = XXH32_round(state->v2, XXH_readLE32(p32, endian)); p32++;
            state->v3 = XXH32_round(state->v3, XXH_readLE32(p32, endian)); p32++;
            state->v4 = XXH32_round(state->v4, XXH_readLE32(p32, endian)); p32++;
        }
        p += 16-state->memsize;
        state->memsize = 0;
    }

    if (p <= bEnd-16) {
        const BYTE* const limit = bEnd - 16;
        U32 v1 = state->v1;
        U32 v2 = state->v2;
        U32 v3 = state->v3;
        U32 v4 = state->v4;

        do {
            v1 = XXH32_round(v1, XXH_readLE32(p, endian)); p+=4;
            v2 = XXH32_round(v2, XXH_readLE32(p, endian)); p+=4;
            v3 = XXH32_round(v3, XXH_readLE32(p, endian)); p+=4;
            v4 = XXH32_round(v4, XXH_readLE32(p, endian)); p+=4;
        } while (p<=limit);

        state->v1 = v1;
        state->v2 = v2;
        state->v3 = v3;
        state->v4 = v4;
    }

    if (p < bEnd) {
        XXH_memcpy(state->mem32, p, (size_t)(bEnd-p));
        state->memsize = (unsigned)(bEnd-p);
    }

    return XXH_OK;
}

XXH_PUBLIC_API XXH_errorcode XXH32_update (XXH32_state_t* state_in, const void* input, size_t len)
{
    XXH_endianess endian_detected = (XXH_endianess)XXH_CPU_LITTLE_ENDIAN;

    if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
        return XXH32_update_endian(state_in, input, len, XXH_littleEndian);
    else
        return XXH32_update_endian(state_in, input, len, XXH_bigEndian);
}



FORCE_INLINE_TEMPLATE U32 XXH32_digest_endian (const XXH32_state_t* state, XXH_endianess endian)
{
    const BYTE * p = (const BYTE*)state->mem32;
    const BYTE* const bEnd = (const BYTE*)(state->mem32) + state->memsize;
    U32 h32;

    if (state->large_len) {
        h32 = XXH_rotl32(state->v1, 1) + XXH_rotl32(state->v2, 7) + XXH_rotl32(state->v3, 12) + XXH_rotl32(state->v4, 18);
    } else {
        h32 = state->v3 /* == seed */ + PRIME32_5;
    }

    h32 += state->total_len_32;

    while (p+4<=bEnd) {
        h32 += XXH_readLE32(p, endian) * PRIME32_3;
        h32  = XXH_rotl32(h32, 17) * PRIME32_4;
        p+=4;
    }

    while (p<bEnd) {
        h32 += (*p) * PRIME32_5;
        h32  = XXH_rotl32(h32, 11) * PRIME32_1;
        p++;
    }

    h32 ^= h32 >> 15;
    h32 *= PRIME32_2;
    h32 ^= h32 >> 13;
    h32 *= PRIME32_3;
    h32 ^= h32 >> 16;

    return h32;
}


XXH_PUBLIC_API unsigned int XXH32_digest (const XXH32_state_t* state_in)
{
    XXH_endianess endian_detected = (XXH_endianess)XXH_CPU_LITTLE_ENDIAN;

    if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
        return XXH32_digest_endian(state_in, XXH_littleEndian);
    else
        return XXH32_digest_endian(state_in, XXH_bigEndian);
}



/* **** XXH64 **** */

FORCE_INLINE_TEMPLATE XXH_errorcode XXH64_update_endian (XXH64_state_t* state, const void* input, size_t len, XXH_endianess endian)
{
    const BYTE* p = (const BYTE*)input;
    const BYTE* const bEnd = p + len;

#ifdef XXH_ACCEPT_NULL_INPUT_POINTER
    if (input==NULL) return XXH_ERROR;
#endif

    state->total_len += len;

    if (state->memsize + len < 32) {  /* fill in tmp buffer */
        if (input != NULL) {
            XXH_memcpy(((BYTE*)state->mem64) + state->memsize, input, len);
        }
        state->memsize += (U32)len;
        return XXH_OK;
    }

    if (state->memsize) {   /* tmp buffer is full */
        XXH_memcpy(((BYTE*)state->mem64) + state->memsize, input, 32-state->memsize);
        state->v1 = XXH64_round(state->v1, XXH_readLE64(state->mem64+0, endian));
        state->v2 = XXH64_round(state->v2, XXH_readLE64(state->mem64+1, endian));
        state->v3 = XXH64_round(state->v3, XXH_readLE64(state->mem64+2, endian));
        state->v4 = XXH64_round(state->v4, XXH_readLE64(state->mem64+3, endian));
        p += 32-state->memsize;
        state->memsize = 0;
    }

    if (p+32 <= bEnd) {
        const BYTE* const limit = bEnd - 32;
        U64 v1 = state->v1;
        U64 v2 = state->v2;
        U64 v3 = state->v3;
        U64 v4 = state->v4;

        do {
            v1 = XXH64_round(v1, XXH_readLE64(p, endian)); p+=8;
            v2 = XXH64_round(v2, XXH_readLE64(p, endian)); p+=8;
            v3 = XXH64_round(v3, XXH_readLE64(p, endian)); p+=8;
            v4 = XXH64_round(v4, XXH_readLE64(p, endian)); p+=8;
        } while (p<=limit);

        state->v1 = v1;
        state->v2 = v2;
        state->v3 = v3;
        state->v4 = v4;
    }

    if (p < bEnd) {
        XXH_memcpy(state->mem64, p, (size_t)(bEnd-p));
        state->memsize = (unsigned)(bEnd-p);
    }

    return XXH_OK;
}

XXH_PUBLIC_API XXH_errorcode XXH64_update (XXH64_state_t* state_in, const void* input, size_t len)
{
    XXH_endianess endian_detected = (XXH_endianess)XXH_CPU_LITTLE_ENDIAN;

    if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
        return XXH64_update_endian(state_in, input, len, XXH_littleEndian);
    else
        return XXH64_update_endian(state_in, input, len, XXH_bigEndian);
}



FORCE_INLINE_TEMPLATE U64 XXH64_digest_endian (const XXH64_state_t* state, XXH_endianess endian)
{
    const BYTE * p = (const BYTE*)state->mem64;
    const BYTE* const bEnd = (const BYTE*)state->mem64 + state->memsize;
    U64 h64;

    if (state->total_len >= 32) {
        U64 const v1 = state->v1;
        U64 const v2 = state->v2;
        U64 const v3 = state->v3;
        U64 const v4 = state->v4;

        h64 = XXH_rotl64(v1, 1) + XXH_rotl64(v2, 7) + XXH_rotl64(v3, 12) + XXH_rotl64(v4, 18);
        h64 = XXH64_mergeRound(h64, v1);
        h64 = XXH64_mergeRound(h64, v2);
        h64 = XXH64_mergeRound(h64, v3);
        h64 = XXH64_mergeRound(h64, v4);
    } else {
        h64  = state->v3 + PRIME64_5;
    }

    h64 += (U64) state->total_len;

    while (p+8<=bEnd) {
        U64 const k1 = XXH64_round(0, XXH_readLE64(p, endian));
        h64 ^= k1;
        h64  = XXH_rotl64(h64,27) * PRIME64_1 + PRIME64_4;
        p+=8;
    }

    if (p+4<=bEnd) {
        h64 ^= (U64)(XXH_readLE32(p, endian)) * PRIME64_1;
        h64  = XXH_rotl64(h64, 23) * PRIME64_2 + PRIME64_3;
        p+=4;
    }

    while (p<bEnd) {
        h64 ^= (*p) * PRIME64_5;
        h64  = XXH_rotl64(h64, 11) * PRIME64_1;
        p++;
    }

    h64 ^= h64 >> 33;
    h64 *= PRIME64_2;
    h64 ^= h64 >> 29;
    h64 *= PRIME64_3;
    h64 ^= h64 >> 32;

    return h64;
}


XXH_PUBLIC_API unsigned long long XXH64_digest (const XXH64_state_t* state_in)
{
    XXH_endianess endian_detected = (XXH_endianess)XXH_CPU_LITTLE_ENDIAN;

    if ((endian_detected==XXH_littleEndian) || XXH_FORCE_NATIVE_FORMAT)
        return XXH64_digest_endian(state_in, XXH_littleEndian);
    else
        return XXH64_digest_endian(state_in, XXH_bigEndian);
}


/* **************************
*  Canonical representation
****************************/

/*! Default XXH result types are basic unsigned 32 and 64 bits.
*   The canonical representation follows human-readable write convention, aka big-endian (large digits first).
*   These functions allow transformation of hash result into and from its canonical format.
*   This way, hash values can be written into a file or buffer, and remain comparable across different systems and programs.
*/

XXH_PUBLIC_API void XXH32_canonicalFromHash(XXH32_canonical_t* dst, XXH32_hash_t hash)
{
    XXH_STATIC_ASSERT(sizeof(XXH32_canonical_t) == sizeof(XXH32_hash_t));
    if (XXH_CPU_LITTLE_ENDIAN) hash = XXH_swap32(hash);
    memcpy(dst, &hash, sizeof(*dst));
}

XXH_PUBLIC_API void XXH64_canonicalFromHash(XXH64_canonical_t* dst, XXH64_hash_t hash)
{
    XXH_STATIC_ASSERT(sizeof(XXH64_canonical_t) == sizeof(XXH64_hash_t));
    if (XXH_CPU_LITTLE_ENDIAN) hash = XXH_swap64(hash);
    memcpy(dst, &hash, sizeof(*dst));
}

XXH_PUBLIC_API XXH32_hash_t XXH32_hashFromCanonical(const XXH32_canonical_t* src)
{
    return XXH_readBE32(src);
}

XXH_PUBLIC_API XXH64_hash_t XXH64_hashFromCanonical(const XXH64_canonical_t* src)
{
    return XXH_readBE64(src);
}
/**** ended inlining xxhash.c ****/
#  endif

#endif /* XXH_STATIC_LINKING_ONLY && XXH_STATIC_H_3543687687345 */


#if defined (__cplusplus)
}
#endif
/**** ended inlining xxhash.h ****/

#if defined (__cplusplus)
extern "C" {
#endif

/* ---- static assert (debug) --- */
#define ZSTD_STATIC_ASSERT(c) DEBUG_STATIC_ASSERT(c)
#define ZSTD_isError ERR_isError   /* for inlining */
#define FSE_isError  ERR_isError
#define HUF_isError  ERR_isError


/*-*************************************
*  shared macros
***************************************/
#undef MIN
#undef MAX
#define MIN(a,b) ((a)<(b) ? (a) : (b))
#define MAX(a,b) ((a)>(b) ? (a) : (b))

/**
 * Ignore: this is an internal helper.
 *
 * This is a helper function to help force C99-correctness during compilation.
 * Under strict compilation modes, variadic macro arguments can't be empty.
 * However, variadic function arguments can be. Using a function therefore lets
 * us statically check that at least one (string) argument was passed,
 * independent of the compilation flags.
 */
static INLINE_KEYWORD UNUSED_ATTR
void _force_has_format_string(const char *format, ...) {
  (void)format;
}

/**
 * Ignore: this is an internal helper.
 *
 * We want to force this function invocation to be syntactically correct, but
 * we don't want to force runtime evaluation of its arguments.
 */
#define _FORCE_HAS_FORMAT_STRING(...) \
  if (0) { \
    _force_has_format_string(__VA_ARGS__); \
  }

/**
 * Return the specified error if the condition evaluates to true.
 *
 * In debug modes, prints additional information.
 * In order to do that (particularly, printing the conditional that failed),
 * this can't just wrap RETURN_ERROR().
 */
#define RETURN_ERROR_IF(cond, err, ...) \
  if (cond) { \
    RAWLOG(3, "%s:%d: ERROR!: check %s failed, returning %s", \
           __FILE__, __LINE__, ZSTD_QUOTE(cond), ZSTD_QUOTE(ERROR(err))); \
    _FORCE_HAS_FORMAT_STRING(__VA_ARGS__); \
    RAWLOG(3, ": " __VA_ARGS__); \
    RAWLOG(3, "\n"); \
    return ERROR(err); \
  }

/**
 * Unconditionally return the specified error.
 *
 * In debug modes, prints additional information.
 */
#define RETURN_ERROR(err, ...) \
  do { \
    RAWLOG(3, "%s:%d: ERROR!: unconditional check failed, returning %s", \
           __FILE__, __LINE__, ZSTD_QUOTE(ERROR(err))); \
    _FORCE_HAS_FORMAT_STRING(__VA_ARGS__); \
    RAWLOG(3, ": " __VA_ARGS__); \
    RAWLOG(3, "\n"); \
    return ERROR(err); \
  } while(0);

/**
 * If the provided expression evaluates to an error code, returns that error code.
 *
 * In debug modes, prints additional information.
 */
#define FORWARD_IF_ERROR(err, ...) \
  do { \
    size_t const err_code = (err); \
    if (ERR_isError(err_code)) { \
      RAWLOG(3, "%s:%d: ERROR!: forwarding error in %s: %s", \
             __FILE__, __LINE__, ZSTD_QUOTE(err), ERR_getErrorName(err_code)); \
      _FORCE_HAS_FORMAT_STRING(__VA_ARGS__); \
      RAWLOG(3, ": " __VA_ARGS__); \
      RAWLOG(3, "\n"); \
      return err_code; \
    } \
  } while(0);


/*-*************************************
*  Common constants
***************************************/
#define ZSTD_OPT_NUM    (1<<12)

#define ZSTD_REP_NUM      3                 /* number of repcodes */
#define ZSTD_REP_MOVE     (ZSTD_REP_NUM-1)
static const U32 repStartValue[ZSTD_REP_NUM] = { 1, 4, 8 };

#define KB *(1 <<10)
#define MB *(1 <<20)
#define GB *(1U<<30)

#define BIT7 128
#define BIT6  64
#define BIT5  32
#define BIT4  16
#define BIT1   2
#define BIT0   1

#define ZSTD_WINDOWLOG_ABSOLUTEMIN 10
static const size_t ZSTD_fcs_fieldSize[4] = { 0, 2, 4, 8 };
static const size_t ZSTD_did_fieldSize[4] = { 0, 1, 2, 4 };

#define ZSTD_FRAMEIDSIZE 4   /* magic number size */

#define ZSTD_BLOCKHEADERSIZE 3   /* C standard doesn't allow `static const` variable to be init using another `static const` variable */
static const size_t ZSTD_blockHeaderSize = ZSTD_BLOCKHEADERSIZE;
typedef enum { bt_raw, bt_rle, bt_compressed, bt_reserved } blockType_e;

#define ZSTD_FRAMECHECKSUMSIZE 4

#define MIN_SEQUENCES_SIZE 1 /* nbSeq==0 */
#define MIN_CBLOCK_SIZE (1 /*litCSize*/ + 1 /* RLE or RAW */ + MIN_SEQUENCES_SIZE /* nbSeq==0 */)   /* for a non-null block */

#define HufLog 12
typedef enum { set_basic, set_rle, set_compressed, set_repeat } symbolEncodingType_e;

#define LONGNBSEQ 0x7F00

#define MINMATCH 3

#define Litbits  8
#define MaxLit ((1<<Litbits) - 1)
#define MaxML   52
#define MaxLL   35
#define DefaultMaxOff 28
#define MaxOff  31
#define MaxSeq MAX(MaxLL, MaxML)   /* Assumption : MaxOff < MaxLL,MaxML */
#define MLFSELog    9
#define LLFSELog    9
#define OffFSELog   8
#define MaxFSELog  MAX(MAX(MLFSELog, LLFSELog), OffFSELog)

static const U32 LL_bits[MaxLL+1] = { 0, 0, 0, 0, 0, 0, 0, 0,
                                      0, 0, 0, 0, 0, 0, 0, 0,
                                      1, 1, 1, 1, 2, 2, 3, 3,
                                      4, 6, 7, 8, 9,10,11,12,
                                     13,14,15,16 };
static const S16 LL_defaultNorm[MaxLL+1] = { 4, 3, 2, 2, 2, 2, 2, 2,
                                             2, 2, 2, 2, 2, 1, 1, 1,
                                             2, 2, 2, 2, 2, 2, 2, 2,
                                             2, 3, 2, 1, 1, 1, 1, 1,
                                            -1,-1,-1,-1 };
#define LL_DEFAULTNORMLOG 6  /* for static allocation */
static const U32 LL_defaultNormLog = LL_DEFAULTNORMLOG;

static const U32 ML_bits[MaxML+1] = { 0, 0, 0, 0, 0, 0, 0, 0,
                                      0, 0, 0, 0, 0, 0, 0, 0,
                                      0, 0, 0, 0, 0, 0, 0, 0,
                                      0, 0, 0, 0, 0, 0, 0, 0,
                                      1, 1, 1, 1, 2, 2, 3, 3,
                                      4, 4, 5, 7, 8, 9,10,11,
                                     12,13,14,15,16 };
static const S16 ML_defaultNorm[MaxML+1] = { 1, 4, 3, 2, 2, 2, 2, 2,
                                             2, 1, 1, 1, 1, 1, 1, 1,
                                             1, 1, 1, 1, 1, 1, 1, 1,
                                             1, 1, 1, 1, 1, 1, 1, 1,
                                             1, 1, 1, 1, 1, 1, 1, 1,
                                             1, 1, 1, 1, 1, 1,-1,-1,
                                            -1,-1,-1,-1,-1 };
#define ML_DEFAULTNORMLOG 6  /* for static allocation */
static const U32 ML_defaultNormLog = ML_DEFAULTNORMLOG;

static const S16 OF_defaultNorm[DefaultMaxOff+1] = { 1, 1, 1, 1, 1, 1, 2, 2,
                                                     2, 1, 1, 1, 1, 1, 1, 1,
                                                     1, 1, 1, 1, 1, 1, 1, 1,
                                                    -1,-1,-1,-1,-1 };
#define OF_DEFAULTNORMLOG 5  /* for static allocation */
static const U32 OF_defaultNormLog = OF_DEFAULTNORMLOG;


/*-*******************************************
*  Shared functions to include for inlining
*********************************************/
static void ZSTD_copy8(void* dst, const void* src) {
#ifdef __aarch64__
    vst1_u8((uint8_t*)dst, vld1_u8((const uint8_t*)src));
#else
    memcpy(dst, src, 8);
#endif
}

#define COPY8(d,s) { ZSTD_copy8(d,s); d+=8; s+=8; }
static void ZSTD_copy16(void* dst, const void* src) {
#ifdef __aarch64__
    vst1q_u8((uint8_t*)dst, vld1q_u8((const uint8_t*)src));
#else
    memcpy(dst, src, 16);
#endif
}
#define COPY16(d,s) { ZSTD_copy16(d,s); d+=16; s+=16; }

#define WILDCOPY_OVERLENGTH 32
#define WILDCOPY_VECLEN 16

typedef enum {
    ZSTD_no_overlap,
    ZSTD_overlap_src_before_dst
    /*  ZSTD_overlap_dst_before_src, */
} ZSTD_overlap_e;

/*! ZSTD_wildcopy() :
 *  Custom version of memcpy(), can over read/write up to WILDCOPY_OVERLENGTH bytes (if length==0)
 *  @param ovtype controls the overlap detection
 *         - ZSTD_no_overlap: The source and destination are guaranteed to be at least WILDCOPY_VECLEN bytes apart.
 *         - ZSTD_overlap_src_before_dst: The src and dst may overlap, but they MUST be at least 8 bytes apart.
 *           The src buffer must be before the dst buffer.
 */
MEM_STATIC FORCE_INLINE_ATTR 
void ZSTD_wildcopy(void* dst, const void* src, ptrdiff_t length, ZSTD_overlap_e const ovtype)
{
    ptrdiff_t diff = (BYTE*)dst - (const BYTE*)src;
    const BYTE* ip = (const BYTE*)src;
    BYTE* op = (BYTE*)dst;
    BYTE* const oend = op + length;

    assert(diff >= 8 || (ovtype == ZSTD_no_overlap && diff <= -WILDCOPY_VECLEN));

    if (ovtype == ZSTD_overlap_src_before_dst && diff < WILDCOPY_VECLEN) {
        /* Handle short offset copies. */
        do {
            COPY8(op, ip)
        } while (op < oend);
    } else {
        assert(diff >= WILDCOPY_VECLEN || diff <= -WILDCOPY_VECLEN);
        /* Separate out the first COPY16() call because the copy length is
         * almost certain to be short, so the branches have different
         * probabilities. Since it is almost certain to be short, only do
         * one COPY16() in the first call. Then, do two calls per loop since
         * at that point it is more likely to have a high trip count.
         */
#ifndef __aarch64__
        do {
            COPY16(op, ip);
        }
        while (op < oend);
#else
        COPY16(op, ip);
        if (op >= oend) return;
        do {
            COPY16(op, ip);
            COPY16(op, ip);
        }
        while (op < oend);
#endif
    }
}

MEM_STATIC size_t ZSTD_limitCopy(void* dst, size_t dstCapacity, const void* src, size_t srcSize)
{
    size_t const length = MIN(dstCapacity, srcSize);
    if (length > 0) {
        memcpy(dst, src, length);
    }
    return length;
}

/* define "workspace is too large" as this number of times larger than needed */
#define ZSTD_WORKSPACETOOLARGE_FACTOR 3

/* when workspace is continuously too large
 * during at least this number of times,
 * context's memory usage is considered wasteful,
 * because it's sized to handle a worst case scenario which rarely happens.
 * In which case, resize it down to free some memory */
#define ZSTD_WORKSPACETOOLARGE_MAXDURATION 128


/*-*******************************************
*  Private declarations
*********************************************/
typedef struct seqDef_s {
    U32 offset;
    U16 litLength;
    U16 matchLength;
} seqDef;

typedef struct {
    seqDef* sequencesStart;
    seqDef* sequences;
    BYTE* litStart;
    BYTE* lit;
    BYTE* llCode;
    BYTE* mlCode;
    BYTE* ofCode;
    size_t maxNbSeq;
    size_t maxNbLit;
    U32   longLengthID;   /* 0 == no longLength; 1 == Lit.longLength; 2 == Match.longLength; */
    U32   longLengthPos;
} seqStore_t;

typedef struct {
    U32 litLength;
    U32 matchLength;
} ZSTD_sequenceLength;

/**
 * Returns the ZSTD_sequenceLength for the given sequences. It handles the decoding of long sequences
 * indicated by longLengthPos and longLengthID, and adds MINMATCH back to matchLength.
 */
MEM_STATIC ZSTD_sequenceLength ZSTD_getSequenceLength(seqStore_t const* seqStore, seqDef const* seq)
{
    ZSTD_sequenceLength seqLen;
    seqLen.litLength = seq->litLength;
    seqLen.matchLength = seq->matchLength + MINMATCH;
    if (seqStore->longLengthPos == (U32)(seq - seqStore->sequencesStart)) {
        if (seqStore->longLengthID == 1) {
            seqLen.litLength += 0xFFFF;
        }
        if (seqStore->longLengthID == 2) {
            seqLen.matchLength += 0xFFFF;
        }
    }
    return seqLen;
}

/**
 * Contains the compressed frame size and an upper-bound for the decompressed frame size.
 * Note: before using `compressedSize`, check for errors using ZSTD_isError().
 *       similarly, before using `decompressedBound`, check for errors using:
 *          `decompressedBound != ZSTD_CONTENTSIZE_ERROR`
 */
typedef struct {
    size_t compressedSize;
    unsigned long long decompressedBound;
} ZSTD_frameSizeInfo;   /* decompress & legacy */

const seqStore_t* ZSTD_getSeqStore(const ZSTD_CCtx* ctx);   /* compress & dictBuilder */
void ZSTD_seqToCodes(const seqStore_t* seqStorePtr);   /* compress, dictBuilder, decodeCorpus (shouldn't get its definition from here) */

/* custom memory allocation functions */
void* ZSTD_malloc(size_t size, ZSTD_customMem customMem);
void* ZSTD_calloc(size_t size, ZSTD_customMem customMem);
void ZSTD_free(void* ptr, ZSTD_customMem customMem);


MEM_STATIC U32 ZSTD_highbit32(U32 val)   /* compress, dictBuilder, decodeCorpus */
{
    assert(val != 0);
    {
#   if defined(_MSC_VER)   /* Visual */
        unsigned long r=0;
        return _BitScanReverse(&r, val) ? (unsigned)r : 0;
#   elif defined(__GNUC__) && (__GNUC__ >= 3)   /* GCC Intrinsic */
        return __builtin_clz (val) ^ 31;
#   elif defined(__ICCARM__)    /* IAR Intrinsic */
        return 31 - __CLZ(val);
#   else   /* Software version */
        static const U32 DeBruijnClz[32] = { 0, 9, 1, 10, 13, 21, 2, 29, 11, 14, 16, 18, 22, 25, 3, 30, 8, 12, 20, 28, 15, 17, 24, 7, 19, 27, 23, 6, 26, 5, 4, 31 };
        U32 v = val;
        v |= v >> 1;
        v |= v >> 2;
        v |= v >> 4;
        v |= v >> 8;
        v |= v >> 16;
        return DeBruijnClz[(v * 0x07C4ACDDU) >> 27];
#   endif
    }
}


/* ZSTD_invalidateRepCodes() :
 * ensures next compression will not use repcodes from previous block.
 * Note : only works with regular variant;
 *        do not use with extDict variant ! */
void ZSTD_invalidateRepCodes(ZSTD_CCtx* cctx);   /* zstdmt, adaptive_compression (shouldn't get this definition from here) */


typedef struct {
    blockType_e blockType;
    U32 lastBlock;
    U32 origSize;
} blockProperties_t;   /* declared here for decompress and fullbench */

/*! ZSTD_getcBlockSize() :
 *  Provides the size of compressed block from block header `src` */
/* Used by: decompress, fullbench (does not get its definition from here) */
size_t ZSTD_getcBlockSize(const void* src, size_t srcSize,
                          blockProperties_t* bpPtr);

/*! ZSTD_decodeSeqHeaders() :
 *  decode sequence header from src */
/* Used by: decompress, fullbench (does not get its definition from here) */
size_t ZSTD_decodeSeqHeaders(ZSTD_DCtx* dctx, int* nbSeqPtr,
                       const void* src, size_t srcSize);


#if defined (__cplusplus)
}
#endif

#endif   /* ZSTD_CCOMMON_H_MODULE */
/**** ended inlining zstd_internal.h ****/


/*-****************************************
*  Version
******************************************/
unsigned ZSTD_versionNumber(void) { return ZSTD_VERSION_NUMBER; }

const char* ZSTD_versionString(void) { return ZSTD_VERSION_STRING; }


/*-****************************************
*  ZSTD Error Management
******************************************/
#undef ZSTD_isError   /* defined within zstd_internal.h */
/*! ZSTD_isError() :
 *  tells if a return value is an error code
 *  symbol is required for external callers */
unsigned ZSTD_isError(size_t code) { return ERR_isError(code); }

/*! ZSTD_getErrorName() :
 *  provides error code string from function result (useful for debugging) */
const char* ZSTD_getErrorName(size_t code) { return ERR_getErrorName(code); }

/*! ZSTD_getError() :
 *  convert a `size_t` function result into a proper ZSTD_errorCode enum */
ZSTD_ErrorCode ZSTD_getErrorCode(size_t code) { return ERR_getErrorCode(code); }

/*! ZSTD_getErrorString() :
 *  provides error code string from enum */
const char* ZSTD_getErrorString(ZSTD_ErrorCode code) { return ERR_getErrorString(code); }



/*=**************************************************************
*  Custom allocator
****************************************************************/
void* ZSTD_malloc(size_t size, ZSTD_customMem customMem)
{
    if (customMem.customAlloc)
        return customMem.customAlloc(customMem.opaque, size);
    return malloc(size);
}

void* ZSTD_calloc(size_t size, ZSTD_customMem customMem)
{
    if (customMem.customAlloc) {
        /* calloc implemented as malloc+memset;
         * not as efficient as calloc, but next best guess for custom malloc */
        void* const ptr = customMem.customAlloc(customMem.opaque, size);
        memset(ptr, 0, size);
        return ptr;
    }
    return calloc(1, size);
}

void ZSTD_free(void* ptr, ZSTD_customMem customMem)
{
    if (ptr!=NULL) {
        if (customMem.customFree)
            customMem.customFree(customMem.opaque, ptr);
        else
            free(ptr);
    }
}
/**** ended inlining common/zstd_common.c ****/

/**** start inlining decompress/huf_decompress.c ****/
/* ******************************************************************
 * huff0 huffman decoder,
 * part of Finite State Entropy library
 * Copyright (c) 2013-2020, Yann Collet, Facebook, Inc.
 *
 *  You can contact the author at :
 *  - FSE+HUF source repository : https://github.com/Cyan4973/FiniteStateEntropy
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
****************************************************************** */

/* **************************************************************
*  Dependencies
****************************************************************/
/**** skipping file: ../common/compiler.h ****/
/**** skipping file: ../common/bitstream.h ****/
/**** skipping file: ../common/fse.h ****/
#define HUF_STATIC_LINKING_ONLY
/**** skipping file: ../common/huf.h ****/
/**** skipping file: ../common/error_private.h ****/

/* **************************************************************
*  Macros
****************************************************************/

/* These two optional macros force the use one way or another of the two
 * Huffman decompression implementations. You can't force in both directions
 * at the same time.
 */
#if defined(HUF_FORCE_DECOMPRESS_X1) && \
    defined(HUF_FORCE_DECOMPRESS_X2)
#error "Cannot force the use of the X1 and X2 decoders at the same time!"
#endif


/* **************************************************************
*  Error Management
****************************************************************/
#define HUF_isError ERR_isError


/* **************************************************************
*  Byte alignment for workSpace management
****************************************************************/
#define HUF_ALIGN(x, a)         HUF_ALIGN_MASK((x), (a) - 1)
#define HUF_ALIGN_MASK(x, mask) (((x) + (mask)) & ~(mask))


/* **************************************************************
*  BMI2 Variant Wrappers
****************************************************************/
#if DYNAMIC_BMI2

#define HUF_DGEN(fn)                                                        \
                                                                            \
    static size_t fn##_default(                                             \
                  void* dst,  size_t dstSize,                               \
            const void* cSrc, size_t cSrcSize,                              \
            const HUF_DTable* DTable)                                       \
    {                                                                       \
        return fn##_body(dst, dstSize, cSrc, cSrcSize, DTable);             \
    }                                                                       \
                                                                            \
    static TARGET_ATTRIBUTE("bmi2") size_t fn##_bmi2(                       \
                  void* dst,  size_t dstSize,                               \
            const void* cSrc, size_t cSrcSize,                              \
            const HUF_DTable* DTable)                                       \
    {                                                                       \
        return fn##_body(dst, dstSize, cSrc, cSrcSize, DTable);             \
    }                                                                       \
                                                                            \
    static size_t fn(void* dst, size_t dstSize, void const* cSrc,           \
                     size_t cSrcSize, HUF_DTable const* DTable, int bmi2)   \
    {                                                                       \
        if (bmi2) {                                                         \
            return fn##_bmi2(dst, dstSize, cSrc, cSrcSize, DTable);         \
        }                                                                   \
        return fn##_default(dst, dstSize, cSrc, cSrcSize, DTable);          \
    }

#else

#define HUF_DGEN(fn)                                                        \
    static size_t fn(void* dst, size_t dstSize, void const* cSrc,           \
                     size_t cSrcSize, HUF_DTable const* DTable, int bmi2)   \
    {                                                                       \
        (void)bmi2;                                                         \
        return fn##_body(dst, dstSize, cSrc, cSrcSize, DTable);             \
    }

#endif


/*-***************************/
/*  generic DTableDesc       */
/*-***************************/
typedef struct { BYTE maxTableLog; BYTE tableType; BYTE tableLog; BYTE reserved; } DTableDesc;

static DTableDesc HUF_getDTableDesc(const HUF_DTable* table)
{
    DTableDesc dtd;
    memcpy(&dtd, table, sizeof(dtd));
    return dtd;
}


#ifndef HUF_FORCE_DECOMPRESS_X2

/*-***************************/
/*  single-symbol decoding   */
/*-***************************/
typedef struct { BYTE byte; BYTE nbBits; } HUF_DEltX1;   /* single-symbol decoding */

size_t HUF_readDTableX1_wksp(HUF_DTable* DTable, const void* src, size_t srcSize, void* workSpace, size_t wkspSize)
{
    U32 tableLog = 0;
    U32 nbSymbols = 0;
    size_t iSize;
    void* const dtPtr = DTable + 1;
    HUF_DEltX1* const dt = (HUF_DEltX1*)dtPtr;

    U32* rankVal;
    BYTE* huffWeight;
    size_t spaceUsed32 = 0;

    rankVal = (U32 *)workSpace + spaceUsed32;
    spaceUsed32 += HUF_TABLELOG_ABSOLUTEMAX + 1;
    huffWeight = (BYTE *)((U32 *)workSpace + spaceUsed32);
    spaceUsed32 += HUF_ALIGN(HUF_SYMBOLVALUE_MAX + 1, sizeof(U32)) >> 2;

    if ((spaceUsed32 << 2) > wkspSize) return ERROR(tableLog_tooLarge);

    DEBUG_STATIC_ASSERT(sizeof(DTableDesc) == sizeof(HUF_DTable));
    /* memset(huffWeight, 0, sizeof(huffWeight)); */   /* is not necessary, even though some analyzer complain ... */

    iSize = HUF_readStats(huffWeight, HUF_SYMBOLVALUE_MAX + 1, rankVal, &nbSymbols, &tableLog, src, srcSize);
    if (HUF_isError(iSize)) return iSize;

    /* Table header */
    {   DTableDesc dtd = HUF_getDTableDesc(DTable);
        if (tableLog > (U32)(dtd.maxTableLog+1)) return ERROR(tableLog_tooLarge);   /* DTable too small, Huffman tree cannot fit in */
        dtd.tableType = 0;
        dtd.tableLog = (BYTE)tableLog;
        memcpy(DTable, &dtd, sizeof(dtd));
    }

    /* Calculate starting value for each rank */
    {   U32 n, nextRankStart = 0;
        for (n=1; n<tableLog+1; n++) {
            U32 const current = nextRankStart;
            nextRankStart += (rankVal[n] << (n-1));
            rankVal[n] = current;
    }   }

    /* fill DTable */
    {   U32 n;
        size_t const nEnd = nbSymbols;
        for (n=0; n<nEnd; n++) {
            size_t const w = huffWeight[n];
            size_t const length = (1 << w) >> 1;
            size_t const uStart = rankVal[w];
            size_t const uEnd = uStart + length;
            size_t u;
            HUF_DEltX1 D;
            D.byte = (BYTE)n;
            D.nbBits = (BYTE)(tableLog + 1 - w);
            rankVal[w] = (U32)uEnd;
            if (length < 4) {
                /* Use length in the loop bound so the compiler knows it is short. */
                for (u = 0; u < length; ++u)
                    dt[uStart + u] = D;
            } else {
                /* Unroll the loop 4 times, we know it is a power of 2. */
                for (u = uStart; u < uEnd; u += 4) {
                    dt[u + 0] = D;
                    dt[u + 1] = D;
                    dt[u + 2] = D;
                    dt[u + 3] = D;
    }   }   }   }
    return iSize;
}

size_t HUF_readDTableX1(HUF_DTable* DTable, const void* src, size_t srcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_readDTableX1_wksp(DTable, src, srcSize,
                                 workSpace, sizeof(workSpace));
}

FORCE_INLINE_TEMPLATE BYTE
HUF_decodeSymbolX1(BIT_DStream_t* Dstream, const HUF_DEltX1* dt, const U32 dtLog)
{
    size_t const val = BIT_lookBitsFast(Dstream, dtLog); /* note : dtLog >= 1 */
    BYTE const c = dt[val].byte;
    BIT_skipBits(Dstream, dt[val].nbBits);
    return c;
}

#define HUF_DECODE_SYMBOLX1_0(ptr, DStreamPtr) \
    *ptr++ = HUF_decodeSymbolX1(DStreamPtr, dt, dtLog)

#define HUF_DECODE_SYMBOLX1_1(ptr, DStreamPtr)  \
    if (MEM_64bits() || (HUF_TABLELOG_MAX<=12)) \
        HUF_DECODE_SYMBOLX1_0(ptr, DStreamPtr)

#define HUF_DECODE_SYMBOLX1_2(ptr, DStreamPtr) \
    if (MEM_64bits()) \
        HUF_DECODE_SYMBOLX1_0(ptr, DStreamPtr)

HINT_INLINE size_t
HUF_decodeStreamX1(BYTE* p, BIT_DStream_t* const bitDPtr, BYTE* const pEnd, const HUF_DEltX1* const dt, const U32 dtLog)
{
    BYTE* const pStart = p;

    /* up to 4 symbols at a time */
    while ((BIT_reloadDStream(bitDPtr) == BIT_DStream_unfinished) & (p < pEnd-3)) {
        HUF_DECODE_SYMBOLX1_2(p, bitDPtr);
        HUF_DECODE_SYMBOLX1_1(p, bitDPtr);
        HUF_DECODE_SYMBOLX1_2(p, bitDPtr);
        HUF_DECODE_SYMBOLX1_0(p, bitDPtr);
    }

    /* [0-3] symbols remaining */
    if (MEM_32bits())
        while ((BIT_reloadDStream(bitDPtr) == BIT_DStream_unfinished) & (p < pEnd))
            HUF_DECODE_SYMBOLX1_0(p, bitDPtr);

    /* no more data to retrieve from bitstream, no need to reload */
    while (p < pEnd)
        HUF_DECODE_SYMBOLX1_0(p, bitDPtr);

    return pEnd-pStart;
}

FORCE_INLINE_TEMPLATE size_t
HUF_decompress1X1_usingDTable_internal_body(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    BYTE* op = (BYTE*)dst;
    BYTE* const oend = op + dstSize;
    const void* dtPtr = DTable + 1;
    const HUF_DEltX1* const dt = (const HUF_DEltX1*)dtPtr;
    BIT_DStream_t bitD;
    DTableDesc const dtd = HUF_getDTableDesc(DTable);
    U32 const dtLog = dtd.tableLog;

    CHECK_F( BIT_initDStream(&bitD, cSrc, cSrcSize) );

    HUF_decodeStreamX1(op, &bitD, oend, dt, dtLog);

    if (!BIT_endOfDStream(&bitD)) return ERROR(corruption_detected);

    return dstSize;
}

FORCE_INLINE_TEMPLATE size_t
HUF_decompress4X1_usingDTable_internal_body(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    /* Check */
    if (cSrcSize < 10) return ERROR(corruption_detected);  /* strict minimum : jump table + 1 byte per stream */

    {   const BYTE* const istart = (const BYTE*) cSrc;
        BYTE* const ostart = (BYTE*) dst;
        BYTE* const oend = ostart + dstSize;
        BYTE* const olimit = oend - 3;
        const void* const dtPtr = DTable + 1;
        const HUF_DEltX1* const dt = (const HUF_DEltX1*)dtPtr;

        /* Init */
        BIT_DStream_t bitD1;
        BIT_DStream_t bitD2;
        BIT_DStream_t bitD3;
        BIT_DStream_t bitD4;
        size_t const length1 = MEM_readLE16(istart);
        size_t const length2 = MEM_readLE16(istart+2);
        size_t const length3 = MEM_readLE16(istart+4);
        size_t const length4 = cSrcSize - (length1 + length2 + length3 + 6);
        const BYTE* const istart1 = istart + 6;  /* jumpTable */
        const BYTE* const istart2 = istart1 + length1;
        const BYTE* const istart3 = istart2 + length2;
        const BYTE* const istart4 = istart3 + length3;
        const size_t segmentSize = (dstSize+3) / 4;
        BYTE* const opStart2 = ostart + segmentSize;
        BYTE* const opStart3 = opStart2 + segmentSize;
        BYTE* const opStart4 = opStart3 + segmentSize;
        BYTE* op1 = ostart;
        BYTE* op2 = opStart2;
        BYTE* op3 = opStart3;
        BYTE* op4 = opStart4;
        DTableDesc const dtd = HUF_getDTableDesc(DTable);
        U32 const dtLog = dtd.tableLog;
        U32 endSignal = 1;

        if (length4 > cSrcSize) return ERROR(corruption_detected);   /* overflow */
        CHECK_F( BIT_initDStream(&bitD1, istart1, length1) );
        CHECK_F( BIT_initDStream(&bitD2, istart2, length2) );
        CHECK_F( BIT_initDStream(&bitD3, istart3, length3) );
        CHECK_F( BIT_initDStream(&bitD4, istart4, length4) );

        /* up to 16 symbols per loop (4 symbols per stream) in 64-bit mode */
        for ( ; (endSignal) & (op4 < olimit) ; ) {
            HUF_DECODE_SYMBOLX1_2(op1, &bitD1);
            HUF_DECODE_SYMBOLX1_2(op2, &bitD2);
            HUF_DECODE_SYMBOLX1_2(op3, &bitD3);
            HUF_DECODE_SYMBOLX1_2(op4, &bitD4);
            HUF_DECODE_SYMBOLX1_1(op1, &bitD1);
            HUF_DECODE_SYMBOLX1_1(op2, &bitD2);
            HUF_DECODE_SYMBOLX1_1(op3, &bitD3);
            HUF_DECODE_SYMBOLX1_1(op4, &bitD4);
            HUF_DECODE_SYMBOLX1_2(op1, &bitD1);
            HUF_DECODE_SYMBOLX1_2(op2, &bitD2);
            HUF_DECODE_SYMBOLX1_2(op3, &bitD3);
            HUF_DECODE_SYMBOLX1_2(op4, &bitD4);
            HUF_DECODE_SYMBOLX1_0(op1, &bitD1);
            HUF_DECODE_SYMBOLX1_0(op2, &bitD2);
            HUF_DECODE_SYMBOLX1_0(op3, &bitD3);
            HUF_DECODE_SYMBOLX1_0(op4, &bitD4);
            endSignal &= BIT_reloadDStreamFast(&bitD1) == BIT_DStream_unfinished;
            endSignal &= BIT_reloadDStreamFast(&bitD2) == BIT_DStream_unfinished;
            endSignal &= BIT_reloadDStreamFast(&bitD3) == BIT_DStream_unfinished;
            endSignal &= BIT_reloadDStreamFast(&bitD4) == BIT_DStream_unfinished;
        }

        /* check corruption */
        /* note : should not be necessary : op# advance in lock step, and we control op4.
         *        but curiously, binary generated by gcc 7.2 & 7.3 with -mbmi2 runs faster when >=1 test is present */
        if (op1 > opStart2) return ERROR(corruption_detected);
        if (op2 > opStart3) return ERROR(corruption_detected);
        if (op3 > opStart4) return ERROR(corruption_detected);
        /* note : op4 supposed already verified within main loop */

        /* finish bitStreams one by one */
        HUF_decodeStreamX1(op1, &bitD1, opStart2, dt, dtLog);
        HUF_decodeStreamX1(op2, &bitD2, opStart3, dt, dtLog);
        HUF_decodeStreamX1(op3, &bitD3, opStart4, dt, dtLog);
        HUF_decodeStreamX1(op4, &bitD4, oend,     dt, dtLog);

        /* check */
        { U32 const endCheck = BIT_endOfDStream(&bitD1) & BIT_endOfDStream(&bitD2) & BIT_endOfDStream(&bitD3) & BIT_endOfDStream(&bitD4);
          if (!endCheck) return ERROR(corruption_detected); }

        /* decoded size */
        return dstSize;
    }
}


typedef size_t (*HUF_decompress_usingDTable_t)(void *dst, size_t dstSize,
                                               const void *cSrc,
                                               size_t cSrcSize,
                                               const HUF_DTable *DTable);

HUF_DGEN(HUF_decompress1X1_usingDTable_internal)
HUF_DGEN(HUF_decompress4X1_usingDTable_internal)



size_t HUF_decompress1X1_usingDTable(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    DTableDesc dtd = HUF_getDTableDesc(DTable);
    if (dtd.tableType != 0) return ERROR(GENERIC);
    return HUF_decompress1X1_usingDTable_internal(dst, dstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
}

size_t HUF_decompress1X1_DCtx_wksp(HUF_DTable* DCtx, void* dst, size_t dstSize,
                                   const void* cSrc, size_t cSrcSize,
                                   void* workSpace, size_t wkspSize)
{
    const BYTE* ip = (const BYTE*) cSrc;

    size_t const hSize = HUF_readDTableX1_wksp(DCtx, cSrc, cSrcSize, workSpace, wkspSize);
    if (HUF_isError(hSize)) return hSize;
    if (hSize >= cSrcSize) return ERROR(srcSize_wrong);
    ip += hSize; cSrcSize -= hSize;

    return HUF_decompress1X1_usingDTable_internal(dst, dstSize, ip, cSrcSize, DCtx, /* bmi2 */ 0);
}


size_t HUF_decompress1X1_DCtx(HUF_DTable* DCtx, void* dst, size_t dstSize,
                              const void* cSrc, size_t cSrcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_decompress1X1_DCtx_wksp(DCtx, dst, dstSize, cSrc, cSrcSize,
                                       workSpace, sizeof(workSpace));
}

size_t HUF_decompress1X1 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    HUF_CREATE_STATIC_DTABLEX1(DTable, HUF_TABLELOG_MAX);
    return HUF_decompress1X1_DCtx (DTable, dst, dstSize, cSrc, cSrcSize);
}

size_t HUF_decompress4X1_usingDTable(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    DTableDesc dtd = HUF_getDTableDesc(DTable);
    if (dtd.tableType != 0) return ERROR(GENERIC);
    return HUF_decompress4X1_usingDTable_internal(dst, dstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
}

static size_t HUF_decompress4X1_DCtx_wksp_bmi2(HUF_DTable* dctx, void* dst, size_t dstSize,
                                   const void* cSrc, size_t cSrcSize,
                                   void* workSpace, size_t wkspSize, int bmi2)
{
    const BYTE* ip = (const BYTE*) cSrc;

    size_t const hSize = HUF_readDTableX1_wksp (dctx, cSrc, cSrcSize,
                                                workSpace, wkspSize);
    if (HUF_isError(hSize)) return hSize;
    if (hSize >= cSrcSize) return ERROR(srcSize_wrong);
    ip += hSize; cSrcSize -= hSize;

    return HUF_decompress4X1_usingDTable_internal(dst, dstSize, ip, cSrcSize, dctx, bmi2);
}

size_t HUF_decompress4X1_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize,
                                   const void* cSrc, size_t cSrcSize,
                                   void* workSpace, size_t wkspSize)
{
    return HUF_decompress4X1_DCtx_wksp_bmi2(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize, 0);
}


size_t HUF_decompress4X1_DCtx (HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_decompress4X1_DCtx_wksp(dctx, dst, dstSize, cSrc, cSrcSize,
                                       workSpace, sizeof(workSpace));
}
size_t HUF_decompress4X1 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    HUF_CREATE_STATIC_DTABLEX1(DTable, HUF_TABLELOG_MAX);
    return HUF_decompress4X1_DCtx(DTable, dst, dstSize, cSrc, cSrcSize);
}

#endif /* HUF_FORCE_DECOMPRESS_X2 */


#ifndef HUF_FORCE_DECOMPRESS_X1

/* *************************/
/* double-symbols decoding */
/* *************************/

typedef struct { U16 sequence; BYTE nbBits; BYTE length; } HUF_DEltX2;  /* double-symbols decoding */
typedef struct { BYTE symbol; BYTE weight; } sortedSymbol_t;
typedef U32 rankValCol_t[HUF_TABLELOG_MAX + 1];
typedef rankValCol_t rankVal_t[HUF_TABLELOG_MAX];


/* HUF_fillDTableX2Level2() :
 * `rankValOrigin` must be a table of at least (HUF_TABLELOG_MAX + 1) U32 */
static void HUF_fillDTableX2Level2(HUF_DEltX2* DTable, U32 sizeLog, const U32 consumed,
                           const U32* rankValOrigin, const int minWeight,
                           const sortedSymbol_t* sortedSymbols, const U32 sortedListSize,
                           U32 nbBitsBaseline, U16 baseSeq)
{
    HUF_DEltX2 DElt;
    U32 rankVal[HUF_TABLELOG_MAX + 1];

    /* get pre-calculated rankVal */
    memcpy(rankVal, rankValOrigin, sizeof(rankVal));

    /* fill skipped values */
    if (minWeight>1) {
        U32 i, skipSize = rankVal[minWeight];
        MEM_writeLE16(&(DElt.sequence), baseSeq);
        DElt.nbBits   = (BYTE)(consumed);
        DElt.length   = 1;
        for (i = 0; i < skipSize; i++)
            DTable[i] = DElt;
    }

    /* fill DTable */
    {   U32 s; for (s=0; s<sortedListSize; s++) {   /* note : sortedSymbols already skipped */
            const U32 symbol = sortedSymbols[s].symbol;
            const U32 weight = sortedSymbols[s].weight;
            const U32 nbBits = nbBitsBaseline - weight;
            const U32 length = 1 << (sizeLog-nbBits);
            const U32 start = rankVal[weight];
            U32 i = start;
            const U32 end = start + length;

            MEM_writeLE16(&(DElt.sequence), (U16)(baseSeq + (symbol << 8)));
            DElt.nbBits = (BYTE)(nbBits + consumed);
            DElt.length = 2;
            do { DTable[i++] = DElt; } while (i<end);   /* since length >= 1 */

            rankVal[weight] += length;
    }   }
}


static void HUF_fillDTableX2(HUF_DEltX2* DTable, const U32 targetLog,
                           const sortedSymbol_t* sortedList, const U32 sortedListSize,
                           const U32* rankStart, rankVal_t rankValOrigin, const U32 maxWeight,
                           const U32 nbBitsBaseline)
{
    U32 rankVal[HUF_TABLELOG_MAX + 1];
    const int scaleLog = nbBitsBaseline - targetLog;   /* note : targetLog >= srcLog, hence scaleLog <= 1 */
    const U32 minBits  = nbBitsBaseline - maxWeight;
    U32 s;

    memcpy(rankVal, rankValOrigin, sizeof(rankVal));

    /* fill DTable */
    for (s=0; s<sortedListSize; s++) {
        const U16 symbol = sortedList[s].symbol;
        const U32 weight = sortedList[s].weight;
        const U32 nbBits = nbBitsBaseline - weight;
        const U32 start = rankVal[weight];
        const U32 length = 1 << (targetLog-nbBits);

        if (targetLog-nbBits >= minBits) {   /* enough room for a second symbol */
            U32 sortedRank;
            int minWeight = nbBits + scaleLog;
            if (minWeight < 1) minWeight = 1;
            sortedRank = rankStart[minWeight];
            HUF_fillDTableX2Level2(DTable+start, targetLog-nbBits, nbBits,
                           rankValOrigin[nbBits], minWeight,
                           sortedList+sortedRank, sortedListSize-sortedRank,
                           nbBitsBaseline, symbol);
        } else {
            HUF_DEltX2 DElt;
            MEM_writeLE16(&(DElt.sequence), symbol);
            DElt.nbBits = (BYTE)(nbBits);
            DElt.length = 1;
            {   U32 const end = start + length;
                U32 u;
                for (u = start; u < end; u++) DTable[u] = DElt;
        }   }
        rankVal[weight] += length;
    }
}

size_t HUF_readDTableX2_wksp(HUF_DTable* DTable,
                       const void* src, size_t srcSize,
                             void* workSpace, size_t wkspSize)
{
    U32 tableLog, maxW, sizeOfSort, nbSymbols;
    DTableDesc dtd = HUF_getDTableDesc(DTable);
    U32 const maxTableLog = dtd.maxTableLog;
    size_t iSize;
    void* dtPtr = DTable+1;   /* force compiler to avoid strict-aliasing */
    HUF_DEltX2* const dt = (HUF_DEltX2*)dtPtr;
    U32 *rankStart;

    rankValCol_t* rankVal;
    U32* rankStats;
    U32* rankStart0;
    sortedSymbol_t* sortedSymbol;
    BYTE* weightList;
    size_t spaceUsed32 = 0;

    rankVal = (rankValCol_t *)((U32 *)workSpace + spaceUsed32);
    spaceUsed32 += (sizeof(rankValCol_t) * HUF_TABLELOG_MAX) >> 2;
    rankStats = (U32 *)workSpace + spaceUsed32;
    spaceUsed32 += HUF_TABLELOG_MAX + 1;
    rankStart0 = (U32 *)workSpace + spaceUsed32;
    spaceUsed32 += HUF_TABLELOG_MAX + 2;
    sortedSymbol = (sortedSymbol_t *)workSpace + (spaceUsed32 * sizeof(U32)) / sizeof(sortedSymbol_t);
    spaceUsed32 += HUF_ALIGN(sizeof(sortedSymbol_t) * (HUF_SYMBOLVALUE_MAX + 1), sizeof(U32)) >> 2;
    weightList = (BYTE *)((U32 *)workSpace + spaceUsed32);
    spaceUsed32 += HUF_ALIGN(HUF_SYMBOLVALUE_MAX + 1, sizeof(U32)) >> 2;

    if ((spaceUsed32 << 2) > wkspSize) return ERROR(tableLog_tooLarge);

    rankStart = rankStart0 + 1;
    memset(rankStats, 0, sizeof(U32) * (2 * HUF_TABLELOG_MAX + 2 + 1));

    DEBUG_STATIC_ASSERT(sizeof(HUF_DEltX2) == sizeof(HUF_DTable));   /* if compiler fails here, assertion is wrong */
    if (maxTableLog > HUF_TABLELOG_MAX) return ERROR(tableLog_tooLarge);
    /* memset(weightList, 0, sizeof(weightList)); */  /* is not necessary, even though some analyzer complain ... */

    iSize = HUF_readStats(weightList, HUF_SYMBOLVALUE_MAX + 1, rankStats, &nbSymbols, &tableLog, src, srcSize);
    if (HUF_isError(iSize)) return iSize;

    /* check result */
    if (tableLog > maxTableLog) return ERROR(tableLog_tooLarge);   /* DTable can't fit code depth */

    /* find maxWeight */
    for (maxW = tableLog; rankStats[maxW]==0; maxW--) {}  /* necessarily finds a solution before 0 */

    /* Get start index of each weight */
    {   U32 w, nextRankStart = 0;
        for (w=1; w<maxW+1; w++) {
            U32 current = nextRankStart;
            nextRankStart += rankStats[w];
            rankStart[w] = current;
        }
        rankStart[0] = nextRankStart;   /* put all 0w symbols at the end of sorted list*/
        sizeOfSort = nextRankStart;
    }

    /* sort symbols by weight */
    {   U32 s;
        for (s=0; s<nbSymbols; s++) {
            U32 const w = weightList[s];
            U32 const r = rankStart[w]++;
            sortedSymbol[r].symbol = (BYTE)s;
            sortedSymbol[r].weight = (BYTE)w;
        }
        rankStart[0] = 0;   /* forget 0w symbols; this is beginning of weight(1) */
    }

    /* Build rankVal */
    {   U32* const rankVal0 = rankVal[0];
        {   int const rescale = (maxTableLog-tableLog) - 1;   /* tableLog <= maxTableLog */
            U32 nextRankVal = 0;
            U32 w;
            for (w=1; w<maxW+1; w++) {
                U32 current = nextRankVal;
                nextRankVal += rankStats[w] << (w+rescale);
                rankVal0[w] = current;
        }   }
        {   U32 const minBits = tableLog+1 - maxW;
            U32 consumed;
            for (consumed = minBits; consumed < maxTableLog - minBits + 1; consumed++) {
                U32* const rankValPtr = rankVal[consumed];
                U32 w;
                for (w = 1; w < maxW+1; w++) {
                    rankValPtr[w] = rankVal0[w] >> consumed;
    }   }   }   }

    HUF_fillDTableX2(dt, maxTableLog,
                   sortedSymbol, sizeOfSort,
                   rankStart0, rankVal, maxW,
                   tableLog+1);

    dtd.tableLog = (BYTE)maxTableLog;
    dtd.tableType = 1;
    memcpy(DTable, &dtd, sizeof(dtd));
    return iSize;
}

size_t HUF_readDTableX2(HUF_DTable* DTable, const void* src, size_t srcSize)
{
  U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
  return HUF_readDTableX2_wksp(DTable, src, srcSize,
                               workSpace, sizeof(workSpace));
}


FORCE_INLINE_TEMPLATE U32
HUF_decodeSymbolX2(void* op, BIT_DStream_t* DStream, const HUF_DEltX2* dt, const U32 dtLog)
{
    size_t const val = BIT_lookBitsFast(DStream, dtLog);   /* note : dtLog >= 1 */
    memcpy(op, dt+val, 2);
    BIT_skipBits(DStream, dt[val].nbBits);
    return dt[val].length;
}

FORCE_INLINE_TEMPLATE U32
HUF_decodeLastSymbolX2(void* op, BIT_DStream_t* DStream, const HUF_DEltX2* dt, const U32 dtLog)
{
    size_t const val = BIT_lookBitsFast(DStream, dtLog);   /* note : dtLog >= 1 */
    memcpy(op, dt+val, 1);
    if (dt[val].length==1) BIT_skipBits(DStream, dt[val].nbBits);
    else {
        if (DStream->bitsConsumed < (sizeof(DStream->bitContainer)*8)) {
            BIT_skipBits(DStream, dt[val].nbBits);
            if (DStream->bitsConsumed > (sizeof(DStream->bitContainer)*8))
                /* ugly hack; works only because it's the last symbol. Note : can't easily extract nbBits from just this symbol */
                DStream->bitsConsumed = (sizeof(DStream->bitContainer)*8);
    }   }
    return 1;
}

#define HUF_DECODE_SYMBOLX2_0(ptr, DStreamPtr) \
    ptr += HUF_decodeSymbolX2(ptr, DStreamPtr, dt, dtLog)

#define HUF_DECODE_SYMBOLX2_1(ptr, DStreamPtr) \
    if (MEM_64bits() || (HUF_TABLELOG_MAX<=12)) \
        ptr += HUF_decodeSymbolX2(ptr, DStreamPtr, dt, dtLog)

#define HUF_DECODE_SYMBOLX2_2(ptr, DStreamPtr) \
    if (MEM_64bits()) \
        ptr += HUF_decodeSymbolX2(ptr, DStreamPtr, dt, dtLog)

HINT_INLINE size_t
HUF_decodeStreamX2(BYTE* p, BIT_DStream_t* bitDPtr, BYTE* const pEnd,
                const HUF_DEltX2* const dt, const U32 dtLog)
{
    BYTE* const pStart = p;

    /* up to 8 symbols at a time */
    while ((BIT_reloadDStream(bitDPtr) == BIT_DStream_unfinished) & (p < pEnd-(sizeof(bitDPtr->bitContainer)-1))) {
        HUF_DECODE_SYMBOLX2_2(p, bitDPtr);
        HUF_DECODE_SYMBOLX2_1(p, bitDPtr);
        HUF_DECODE_SYMBOLX2_2(p, bitDPtr);
        HUF_DECODE_SYMBOLX2_0(p, bitDPtr);
    }

    /* closer to end : up to 2 symbols at a time */
    while ((BIT_reloadDStream(bitDPtr) == BIT_DStream_unfinished) & (p <= pEnd-2))
        HUF_DECODE_SYMBOLX2_0(p, bitDPtr);

    while (p <= pEnd-2)
        HUF_DECODE_SYMBOLX2_0(p, bitDPtr);   /* no need to reload : reached the end of DStream */

    if (p < pEnd)
        p += HUF_decodeLastSymbolX2(p, bitDPtr, dt, dtLog);

    return p-pStart;
}

FORCE_INLINE_TEMPLATE size_t
HUF_decompress1X2_usingDTable_internal_body(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    BIT_DStream_t bitD;

    /* Init */
    CHECK_F( BIT_initDStream(&bitD, cSrc, cSrcSize) );

    /* decode */
    {   BYTE* const ostart = (BYTE*) dst;
        BYTE* const oend = ostart + dstSize;
        const void* const dtPtr = DTable+1;   /* force compiler to not use strict-aliasing */
        const HUF_DEltX2* const dt = (const HUF_DEltX2*)dtPtr;
        DTableDesc const dtd = HUF_getDTableDesc(DTable);
        HUF_decodeStreamX2(ostart, &bitD, oend, dt, dtd.tableLog);
    }

    /* check */
    if (!BIT_endOfDStream(&bitD)) return ERROR(corruption_detected);

    /* decoded size */
    return dstSize;
}

FORCE_INLINE_TEMPLATE size_t
HUF_decompress4X2_usingDTable_internal_body(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    if (cSrcSize < 10) return ERROR(corruption_detected);   /* strict minimum : jump table + 1 byte per stream */

    {   const BYTE* const istart = (const BYTE*) cSrc;
        BYTE* const ostart = (BYTE*) dst;
        BYTE* const oend = ostart + dstSize;
        BYTE* const olimit = oend - (sizeof(size_t)-1);
        const void* const dtPtr = DTable+1;
        const HUF_DEltX2* const dt = (const HUF_DEltX2*)dtPtr;

        /* Init */
        BIT_DStream_t bitD1;
        BIT_DStream_t bitD2;
        BIT_DStream_t bitD3;
        BIT_DStream_t bitD4;
        size_t const length1 = MEM_readLE16(istart);
        size_t const length2 = MEM_readLE16(istart+2);
        size_t const length3 = MEM_readLE16(istart+4);
        size_t const length4 = cSrcSize - (length1 + length2 + length3 + 6);
        const BYTE* const istart1 = istart + 6;  /* jumpTable */
        const BYTE* const istart2 = istart1 + length1;
        const BYTE* const istart3 = istart2 + length2;
        const BYTE* const istart4 = istart3 + length3;
        size_t const segmentSize = (dstSize+3) / 4;
        BYTE* const opStart2 = ostart + segmentSize;
        BYTE* const opStart3 = opStart2 + segmentSize;
        BYTE* const opStart4 = opStart3 + segmentSize;
        BYTE* op1 = ostart;
        BYTE* op2 = opStart2;
        BYTE* op3 = opStart3;
        BYTE* op4 = opStart4;
        U32 endSignal = 1;
        DTableDesc const dtd = HUF_getDTableDesc(DTable);
        U32 const dtLog = dtd.tableLog;

        if (length4 > cSrcSize) return ERROR(corruption_detected);   /* overflow */
        CHECK_F( BIT_initDStream(&bitD1, istart1, length1) );
        CHECK_F( BIT_initDStream(&bitD2, istart2, length2) );
        CHECK_F( BIT_initDStream(&bitD3, istart3, length3) );
        CHECK_F( BIT_initDStream(&bitD4, istart4, length4) );

        /* 16-32 symbols per loop (4-8 symbols per stream) */
        for ( ; (endSignal) & (op4 < olimit); ) {
#if defined(__clang__) && (defined(__x86_64__) || defined(__i386__))
            HUF_DECODE_SYMBOLX2_2(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_1(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_2(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_0(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_2(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_1(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_2(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_0(op2, &bitD2);
            endSignal &= BIT_reloadDStreamFast(&bitD1) == BIT_DStream_unfinished;
            endSignal &= BIT_reloadDStreamFast(&bitD2) == BIT_DStream_unfinished;
            HUF_DECODE_SYMBOLX2_2(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_1(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_2(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_0(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_2(op4, &bitD4);
            HUF_DECODE_SYMBOLX2_1(op4, &bitD4);
            HUF_DECODE_SYMBOLX2_2(op4, &bitD4);
            HUF_DECODE_SYMBOLX2_0(op4, &bitD4);
            endSignal &= BIT_reloadDStreamFast(&bitD3) == BIT_DStream_unfinished;
            endSignal &= BIT_reloadDStreamFast(&bitD4) == BIT_DStream_unfinished;
#else
            HUF_DECODE_SYMBOLX2_2(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_2(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_2(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_2(op4, &bitD4);
            HUF_DECODE_SYMBOLX2_1(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_1(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_1(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_1(op4, &bitD4);
            HUF_DECODE_SYMBOLX2_2(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_2(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_2(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_2(op4, &bitD4);
            HUF_DECODE_SYMBOLX2_0(op1, &bitD1);
            HUF_DECODE_SYMBOLX2_0(op2, &bitD2);
            HUF_DECODE_SYMBOLX2_0(op3, &bitD3);
            HUF_DECODE_SYMBOLX2_0(op4, &bitD4);
            endSignal = (U32)LIKELY(
                        (BIT_reloadDStreamFast(&bitD1) == BIT_DStream_unfinished)
                      & (BIT_reloadDStreamFast(&bitD2) == BIT_DStream_unfinished)
                      & (BIT_reloadDStreamFast(&bitD3) == BIT_DStream_unfinished)
                      & (BIT_reloadDStreamFast(&bitD4) == BIT_DStream_unfinished));
#endif
        }

        /* check corruption */
        if (op1 > opStart2) return ERROR(corruption_detected);
        if (op2 > opStart3) return ERROR(corruption_detected);
        if (op3 > opStart4) return ERROR(corruption_detected);
        /* note : op4 already verified within main loop */

        /* finish bitStreams one by one */
        HUF_decodeStreamX2(op1, &bitD1, opStart2, dt, dtLog);
        HUF_decodeStreamX2(op2, &bitD2, opStart3, dt, dtLog);
        HUF_decodeStreamX2(op3, &bitD3, opStart4, dt, dtLog);
        HUF_decodeStreamX2(op4, &bitD4, oend,     dt, dtLog);

        /* check */
        { U32 const endCheck = BIT_endOfDStream(&bitD1) & BIT_endOfDStream(&bitD2) & BIT_endOfDStream(&bitD3) & BIT_endOfDStream(&bitD4);
          if (!endCheck) return ERROR(corruption_detected); }

        /* decoded size */
        return dstSize;
    }
}

HUF_DGEN(HUF_decompress1X2_usingDTable_internal)
HUF_DGEN(HUF_decompress4X2_usingDTable_internal)

size_t HUF_decompress1X2_usingDTable(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    DTableDesc dtd = HUF_getDTableDesc(DTable);
    if (dtd.tableType != 1) return ERROR(GENERIC);
    return HUF_decompress1X2_usingDTable_internal(dst, dstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
}

size_t HUF_decompress1X2_DCtx_wksp(HUF_DTable* DCtx, void* dst, size_t dstSize,
                                   const void* cSrc, size_t cSrcSize,
                                   void* workSpace, size_t wkspSize)
{
    const BYTE* ip = (const BYTE*) cSrc;

    size_t const hSize = HUF_readDTableX2_wksp(DCtx, cSrc, cSrcSize,
                                               workSpace, wkspSize);
    if (HUF_isError(hSize)) return hSize;
    if (hSize >= cSrcSize) return ERROR(srcSize_wrong);
    ip += hSize; cSrcSize -= hSize;

    return HUF_decompress1X2_usingDTable_internal(dst, dstSize, ip, cSrcSize, DCtx, /* bmi2 */ 0);
}


size_t HUF_decompress1X2_DCtx(HUF_DTable* DCtx, void* dst, size_t dstSize,
                              const void* cSrc, size_t cSrcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_decompress1X2_DCtx_wksp(DCtx, dst, dstSize, cSrc, cSrcSize,
                                       workSpace, sizeof(workSpace));
}

size_t HUF_decompress1X2 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    HUF_CREATE_STATIC_DTABLEX2(DTable, HUF_TABLELOG_MAX);
    return HUF_decompress1X2_DCtx(DTable, dst, dstSize, cSrc, cSrcSize);
}

size_t HUF_decompress4X2_usingDTable(
          void* dst,  size_t dstSize,
    const void* cSrc, size_t cSrcSize,
    const HUF_DTable* DTable)
{
    DTableDesc dtd = HUF_getDTableDesc(DTable);
    if (dtd.tableType != 1) return ERROR(GENERIC);
    return HUF_decompress4X2_usingDTable_internal(dst, dstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
}

static size_t HUF_decompress4X2_DCtx_wksp_bmi2(HUF_DTable* dctx, void* dst, size_t dstSize,
                                   const void* cSrc, size_t cSrcSize,
                                   void* workSpace, size_t wkspSize, int bmi2)
{
    const BYTE* ip = (const BYTE*) cSrc;

    size_t hSize = HUF_readDTableX2_wksp(dctx, cSrc, cSrcSize,
                                         workSpace, wkspSize);
    if (HUF_isError(hSize)) return hSize;
    if (hSize >= cSrcSize) return ERROR(srcSize_wrong);
    ip += hSize; cSrcSize -= hSize;

    return HUF_decompress4X2_usingDTable_internal(dst, dstSize, ip, cSrcSize, dctx, bmi2);
}

size_t HUF_decompress4X2_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize,
                                   const void* cSrc, size_t cSrcSize,
                                   void* workSpace, size_t wkspSize)
{
    return HUF_decompress4X2_DCtx_wksp_bmi2(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize, /* bmi2 */ 0);
}


size_t HUF_decompress4X2_DCtx(HUF_DTable* dctx, void* dst, size_t dstSize,
                              const void* cSrc, size_t cSrcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_decompress4X2_DCtx_wksp(dctx, dst, dstSize, cSrc, cSrcSize,
                                       workSpace, sizeof(workSpace));
}

size_t HUF_decompress4X2 (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    HUF_CREATE_STATIC_DTABLEX2(DTable, HUF_TABLELOG_MAX);
    return HUF_decompress4X2_DCtx(DTable, dst, dstSize, cSrc, cSrcSize);
}

#endif /* HUF_FORCE_DECOMPRESS_X1 */


/* ***********************************/
/* Universal decompression selectors */
/* ***********************************/

size_t HUF_decompress1X_usingDTable(void* dst, size_t maxDstSize,
                                    const void* cSrc, size_t cSrcSize,
                                    const HUF_DTable* DTable)
{
    DTableDesc const dtd = HUF_getDTableDesc(DTable);
#if defined(HUF_FORCE_DECOMPRESS_X1)
    (void)dtd;
    assert(dtd.tableType == 0);
    return HUF_decompress1X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
    (void)dtd;
    assert(dtd.tableType == 1);
    return HUF_decompress1X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
#else
    return dtd.tableType ? HUF_decompress1X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0) :
                           HUF_decompress1X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
#endif
}

size_t HUF_decompress4X_usingDTable(void* dst, size_t maxDstSize,
                                    const void* cSrc, size_t cSrcSize,
                                    const HUF_DTable* DTable)
{
    DTableDesc const dtd = HUF_getDTableDesc(DTable);
#if defined(HUF_FORCE_DECOMPRESS_X1)
    (void)dtd;
    assert(dtd.tableType == 0);
    return HUF_decompress4X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
    (void)dtd;
    assert(dtd.tableType == 1);
    return HUF_decompress4X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
#else
    return dtd.tableType ? HUF_decompress4X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0) :
                           HUF_decompress4X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, /* bmi2 */ 0);
#endif
}


#if !defined(HUF_FORCE_DECOMPRESS_X1) && !defined(HUF_FORCE_DECOMPRESS_X2)
typedef struct { U32 tableTime; U32 decode256Time; } algo_time_t;
static const algo_time_t algoTime[16 /* Quantization */][3 /* single, double, quad */] =
{
    /* single, double, quad */
    {{0,0}, {1,1}, {2,2}},  /* Q==0 : impossible */
    {{0,0}, {1,1}, {2,2}},  /* Q==1 : impossible */
    {{  38,130}, {1313, 74}, {2151, 38}},   /* Q == 2 : 12-18% */
    {{ 448,128}, {1353, 74}, {2238, 41}},   /* Q == 3 : 18-25% */
    {{ 556,128}, {1353, 74}, {2238, 47}},   /* Q == 4 : 25-32% */
    {{ 714,128}, {1418, 74}, {2436, 53}},   /* Q == 5 : 32-38% */
    {{ 883,128}, {1437, 74}, {2464, 61}},   /* Q == 6 : 38-44% */
    {{ 897,128}, {1515, 75}, {2622, 68}},   /* Q == 7 : 44-50% */
    {{ 926,128}, {1613, 75}, {2730, 75}},   /* Q == 8 : 50-56% */
    {{ 947,128}, {1729, 77}, {3359, 77}},   /* Q == 9 : 56-62% */
    {{1107,128}, {2083, 81}, {4006, 84}},   /* Q ==10 : 62-69% */
    {{1177,128}, {2379, 87}, {4785, 88}},   /* Q ==11 : 69-75% */
    {{1242,128}, {2415, 93}, {5155, 84}},   /* Q ==12 : 75-81% */
    {{1349,128}, {2644,106}, {5260,106}},   /* Q ==13 : 81-87% */
    {{1455,128}, {2422,124}, {4174,124}},   /* Q ==14 : 87-93% */
    {{ 722,128}, {1891,145}, {1936,146}},   /* Q ==15 : 93-99% */
};
#endif

/** HUF_selectDecoder() :
 *  Tells which decoder is likely to decode faster,
 *  based on a set of pre-computed metrics.
 * @return : 0==HUF_decompress4X1, 1==HUF_decompress4X2 .
 *  Assumption : 0 < dstSize <= 128 KB */
U32 HUF_selectDecoder (size_t dstSize, size_t cSrcSize)
{
    assert(dstSize > 0);
    assert(dstSize <= 128*1024);
#if defined(HUF_FORCE_DECOMPRESS_X1)
    (void)dstSize;
    (void)cSrcSize;
    return 0;
#elif defined(HUF_FORCE_DECOMPRESS_X2)
    (void)dstSize;
    (void)cSrcSize;
    return 1;
#else
    /* decoder timing evaluation */
    {   U32 const Q = (cSrcSize >= dstSize) ? 15 : (U32)(cSrcSize * 16 / dstSize);   /* Q < 16 */
        U32 const D256 = (U32)(dstSize >> 8);
        U32 const DTime0 = algoTime[Q][0].tableTime + (algoTime[Q][0].decode256Time * D256);
        U32 DTime1 = algoTime[Q][1].tableTime + (algoTime[Q][1].decode256Time * D256);
        DTime1 += DTime1 >> 3;  /* advantage to algorithm using less memory, to reduce cache eviction */
        return DTime1 < DTime0;
    }
#endif
}


typedef size_t (*decompressionAlgo)(void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize);

size_t HUF_decompress (void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
#if !defined(HUF_FORCE_DECOMPRESS_X1) && !defined(HUF_FORCE_DECOMPRESS_X2)
    static const decompressionAlgo decompress[2] = { HUF_decompress4X1, HUF_decompress4X2 };
#endif

    /* validation checks */
    if (dstSize == 0) return ERROR(dstSize_tooSmall);
    if (cSrcSize > dstSize) return ERROR(corruption_detected);   /* invalid */
    if (cSrcSize == dstSize) { memcpy(dst, cSrc, dstSize); return dstSize; }   /* not compressed */
    if (cSrcSize == 1) { memset(dst, *(const BYTE*)cSrc, dstSize); return dstSize; }   /* RLE */

    {   U32 const algoNb = HUF_selectDecoder(dstSize, cSrcSize);
#if defined(HUF_FORCE_DECOMPRESS_X1)
        (void)algoNb;
        assert(algoNb == 0);
        return HUF_decompress4X1(dst, dstSize, cSrc, cSrcSize);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
        (void)algoNb;
        assert(algoNb == 1);
        return HUF_decompress4X2(dst, dstSize, cSrc, cSrcSize);
#else
        return decompress[algoNb](dst, dstSize, cSrc, cSrcSize);
#endif
    }
}

size_t HUF_decompress4X_DCtx (HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    /* validation checks */
    if (dstSize == 0) return ERROR(dstSize_tooSmall);
    if (cSrcSize > dstSize) return ERROR(corruption_detected);   /* invalid */
    if (cSrcSize == dstSize) { memcpy(dst, cSrc, dstSize); return dstSize; }   /* not compressed */
    if (cSrcSize == 1) { memset(dst, *(const BYTE*)cSrc, dstSize); return dstSize; }   /* RLE */

    {   U32 const algoNb = HUF_selectDecoder(dstSize, cSrcSize);
#if defined(HUF_FORCE_DECOMPRESS_X1)
        (void)algoNb;
        assert(algoNb == 0);
        return HUF_decompress4X1_DCtx(dctx, dst, dstSize, cSrc, cSrcSize);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
        (void)algoNb;
        assert(algoNb == 1);
        return HUF_decompress4X2_DCtx(dctx, dst, dstSize, cSrc, cSrcSize);
#else
        return algoNb ? HUF_decompress4X2_DCtx(dctx, dst, dstSize, cSrc, cSrcSize) :
                        HUF_decompress4X1_DCtx(dctx, dst, dstSize, cSrc, cSrcSize) ;
#endif
    }
}

size_t HUF_decompress4X_hufOnly(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_decompress4X_hufOnly_wksp(dctx, dst, dstSize, cSrc, cSrcSize,
                                         workSpace, sizeof(workSpace));
}


size_t HUF_decompress4X_hufOnly_wksp(HUF_DTable* dctx, void* dst,
                                     size_t dstSize, const void* cSrc,
                                     size_t cSrcSize, void* workSpace,
                                     size_t wkspSize)
{
    /* validation checks */
    if (dstSize == 0) return ERROR(dstSize_tooSmall);
    if (cSrcSize == 0) return ERROR(corruption_detected);

    {   U32 const algoNb = HUF_selectDecoder(dstSize, cSrcSize);
#if defined(HUF_FORCE_DECOMPRESS_X1)
        (void)algoNb;
        assert(algoNb == 0);
        return HUF_decompress4X1_DCtx_wksp(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
        (void)algoNb;
        assert(algoNb == 1);
        return HUF_decompress4X2_DCtx_wksp(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize);
#else
        return algoNb ? HUF_decompress4X2_DCtx_wksp(dctx, dst, dstSize, cSrc,
                            cSrcSize, workSpace, wkspSize):
                        HUF_decompress4X1_DCtx_wksp(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize);
#endif
    }
}

size_t HUF_decompress1X_DCtx_wksp(HUF_DTable* dctx, void* dst, size_t dstSize,
                                  const void* cSrc, size_t cSrcSize,
                                  void* workSpace, size_t wkspSize)
{
    /* validation checks */
    if (dstSize == 0) return ERROR(dstSize_tooSmall);
    if (cSrcSize > dstSize) return ERROR(corruption_detected);   /* invalid */
    if (cSrcSize == dstSize) { memcpy(dst, cSrc, dstSize); return dstSize; }   /* not compressed */
    if (cSrcSize == 1) { memset(dst, *(const BYTE*)cSrc, dstSize); return dstSize; }   /* RLE */

    {   U32 const algoNb = HUF_selectDecoder(dstSize, cSrcSize);
#if defined(HUF_FORCE_DECOMPRESS_X1)
        (void)algoNb;
        assert(algoNb == 0);
        return HUF_decompress1X1_DCtx_wksp(dctx, dst, dstSize, cSrc,
                                cSrcSize, workSpace, wkspSize);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
        (void)algoNb;
        assert(algoNb == 1);
        return HUF_decompress1X2_DCtx_wksp(dctx, dst, dstSize, cSrc,
                                cSrcSize, workSpace, wkspSize);
#else
        return algoNb ? HUF_decompress1X2_DCtx_wksp(dctx, dst, dstSize, cSrc,
                                cSrcSize, workSpace, wkspSize):
                        HUF_decompress1X1_DCtx_wksp(dctx, dst, dstSize, cSrc,
                                cSrcSize, workSpace, wkspSize);
#endif
    }
}

size_t HUF_decompress1X_DCtx(HUF_DTable* dctx, void* dst, size_t dstSize,
                             const void* cSrc, size_t cSrcSize)
{
    U32 workSpace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];
    return HUF_decompress1X_DCtx_wksp(dctx, dst, dstSize, cSrc, cSrcSize,
                                      workSpace, sizeof(workSpace));
}


size_t HUF_decompress1X_usingDTable_bmi2(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable, int bmi2)
{
    DTableDesc const dtd = HUF_getDTableDesc(DTable);
#if defined(HUF_FORCE_DECOMPRESS_X1)
    (void)dtd;
    assert(dtd.tableType == 0);
    return HUF_decompress1X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
    (void)dtd;
    assert(dtd.tableType == 1);
    return HUF_decompress1X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2);
#else
    return dtd.tableType ? HUF_decompress1X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2) :
                           HUF_decompress1X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2);
#endif
}

#ifndef HUF_FORCE_DECOMPRESS_X2
size_t HUF_decompress1X1_DCtx_wksp_bmi2(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize, int bmi2)
{
    const BYTE* ip = (const BYTE*) cSrc;

    size_t const hSize = HUF_readDTableX1_wksp(dctx, cSrc, cSrcSize, workSpace, wkspSize);
    if (HUF_isError(hSize)) return hSize;
    if (hSize >= cSrcSize) return ERROR(srcSize_wrong);
    ip += hSize; cSrcSize -= hSize;

    return HUF_decompress1X1_usingDTable_internal(dst, dstSize, ip, cSrcSize, dctx, bmi2);
}
#endif

size_t HUF_decompress4X_usingDTable_bmi2(void* dst, size_t maxDstSize, const void* cSrc, size_t cSrcSize, const HUF_DTable* DTable, int bmi2)
{
    DTableDesc const dtd = HUF_getDTableDesc(DTable);
#if defined(HUF_FORCE_DECOMPRESS_X1)
    (void)dtd;
    assert(dtd.tableType == 0);
    return HUF_decompress4X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
    (void)dtd;
    assert(dtd.tableType == 1);
    return HUF_decompress4X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2);
#else
    return dtd.tableType ? HUF_decompress4X2_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2) :
                           HUF_decompress4X1_usingDTable_internal(dst, maxDstSize, cSrc, cSrcSize, DTable, bmi2);
#endif
}

size_t HUF_decompress4X_hufOnly_wksp_bmi2(HUF_DTable* dctx, void* dst, size_t dstSize, const void* cSrc, size_t cSrcSize, void* workSpace, size_t wkspSize, int bmi2)
{
    /* validation checks */
    if (dstSize == 0) return ERROR(dstSize_tooSmall);
    if (cSrcSize == 0) return ERROR(corruption_detected);

    {   U32 const algoNb = HUF_selectDecoder(dstSize, cSrcSize);
#if defined(HUF_FORCE_DECOMPRESS_X1)
        (void)algoNb;
        assert(algoNb == 0);
        return HUF_decompress4X1_DCtx_wksp_bmi2(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize, bmi2);
#elif defined(HUF_FORCE_DECOMPRESS_X2)
        (void)algoNb;
        assert(algoNb == 1);
        return HUF_decompress4X2_DCtx_wksp_bmi2(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize, bmi2);
#else
        return algoNb ? HUF_decompress4X2_DCtx_wksp_bmi2(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize, bmi2) :
                        HUF_decompress4X1_DCtx_wksp_bmi2(dctx, dst, dstSize, cSrc, cSrcSize, workSpace, wkspSize, bmi2);
#endif
    }
}
/**** ended inlining decompress/huf_decompress.c ****/
/**** start inlining decompress/zstd_ddict.c ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

/* zstd_ddict.c :
 * concentrates all logic that needs to know the internals of ZSTD_DDict object */

/*-*******************************************************
*  Dependencies
*********************************************************/
/**** start inlining ../common/cpu.h ****/
/*
 * Copyright (c) 2018-2020, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_COMMON_CPU_H
#define ZSTD_COMMON_CPU_H

/**
 * Implementation taken from folly/CpuId.h
 * https://github.com/facebook/folly/blob/master/folly/CpuId.h
 */


/**** skipping file: mem.h ****/

#ifdef _MSC_VER
#include <intrin.h>
#endif

typedef struct {
    U32 f1c;
    U32 f1d;
    U32 f7b;
    U32 f7c;
} ZSTD_cpuid_t;

MEM_STATIC ZSTD_cpuid_t ZSTD_cpuid(void) {
    U32 f1c = 0;
    U32 f1d = 0;
    U32 f7b = 0;
    U32 f7c = 0;
#if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
    int reg[4];
    __cpuid((int*)reg, 0);
    {
        int const n = reg[0];
        if (n >= 1) {
            __cpuid((int*)reg, 1);
            f1c = (U32)reg[2];
            f1d = (U32)reg[3];
        }
        if (n >= 7) {
            __cpuidex((int*)reg, 7, 0);
            f7b = (U32)reg[1];
            f7c = (U32)reg[2];
        }
    }
#elif defined(__i386__) && defined(__PIC__) && !defined(__clang__) && defined(__GNUC__)
    /* The following block like the normal cpuid branch below, but gcc
     * reserves ebx for use of its pic register so we must specially
     * handle the save and restore to avoid clobbering the register
     */
    U32 n;
    __asm__(
        "pushl %%ebx\n\t"
        "cpuid\n\t"
        "popl %%ebx\n\t"
        : "=a"(n)
        : "a"(0)
        : "ecx", "edx");
    if (n >= 1) {
      U32 f1a;
      __asm__(
          "pushl %%ebx\n\t"
          "cpuid\n\t"
          "popl %%ebx\n\t"
          : "=a"(f1a), "=c"(f1c), "=d"(f1d)
          : "a"(1));
    }
    if (n >= 7) {
      __asm__(
          "pushl %%ebx\n\t"
          "cpuid\n\t"
          "movl %%ebx, %%eax\n\t"
          "popl %%ebx"
          : "=a"(f7b), "=c"(f7c)
          : "a"(7), "c"(0)
          : "edx");
    }
#elif defined(__x86_64__) || defined(_M_X64) || defined(__i386__)
    U32 n;
    __asm__("cpuid" : "=a"(n) : "a"(0) : "ebx", "ecx", "edx");
    if (n >= 1) {
      U32 f1a;
      __asm__("cpuid" : "=a"(f1a), "=c"(f1c), "=d"(f1d) : "a"(1) : "ebx");
    }
    if (n >= 7) {
      U32 f7a;
      __asm__("cpuid"
              : "=a"(f7a), "=b"(f7b), "=c"(f7c)
              : "a"(7), "c"(0)
              : "edx");
    }
#endif
    {
        ZSTD_cpuid_t cpuid;
        cpuid.f1c = f1c;
        cpuid.f1d = f1d;
        cpuid.f7b = f7b;
        cpuid.f7c = f7c;
        return cpuid;
    }
}

#define X(name, r, bit)                                                        \
  MEM_STATIC int ZSTD_cpuid_##name(ZSTD_cpuid_t const cpuid) {                 \
    return ((cpuid.r) & (1U << bit)) != 0;                                     \
  }

/* cpuid(1): Processor Info and Feature Bits. */
#define C(name, bit) X(name, f1c, bit)
  C(sse3, 0)
  C(pclmuldq, 1)
  C(dtes64, 2)
  C(monitor, 3)
  C(dscpl, 4)
  C(vmx, 5)
  C(smx, 6)
  C(eist, 7)
  C(tm2, 8)
  C(ssse3, 9)
  C(cnxtid, 10)
  C(fma, 12)
  C(cx16, 13)
  C(xtpr, 14)
  C(pdcm, 15)
  C(pcid, 17)
  C(dca, 18)
  C(sse41, 19)
  C(sse42, 20)
  C(x2apic, 21)
  C(movbe, 22)
  C(popcnt, 23)
  C(tscdeadline, 24)
  C(aes, 25)
  C(xsave, 26)
  C(osxsave, 27)
  C(avx, 28)
  C(f16c, 29)
  C(rdrand, 30)
#undef C
#define D(name, bit) X(name, f1d, bit)
  D(fpu, 0)
  D(vme, 1)
  D(de, 2)
  D(pse, 3)
  D(tsc, 4)
  D(msr, 5)
  D(pae, 6)
  D(mce, 7)
  D(cx8, 8)
  D(apic, 9)
  D(sep, 11)
  D(mtrr, 12)
  D(pge, 13)
  D(mca, 14)
  D(cmov, 15)
  D(pat, 16)
  D(pse36, 17)
  D(psn, 18)
  D(clfsh, 19)
  D(ds, 21)
  D(acpi, 22)
  D(mmx, 23)
  D(fxsr, 24)
  D(sse, 25)
  D(sse2, 26)
  D(ss, 27)
  D(htt, 28)
  D(tm, 29)
  D(pbe, 31)
#undef D

/* cpuid(7): Extended Features. */
#define B(name, bit) X(name, f7b, bit)
  B(bmi1, 3)
  B(hle, 4)
  B(avx2, 5)
  B(smep, 7)
  B(bmi2, 8)
  B(erms, 9)
  B(invpcid, 10)
  B(rtm, 11)
  B(mpx, 14)
  B(avx512f, 16)
  B(avx512dq, 17)
  B(rdseed, 18)
  B(adx, 19)
  B(smap, 20)
  B(avx512ifma, 21)
  B(pcommit, 22)
  B(clflushopt, 23)
  B(clwb, 24)
  B(avx512pf, 26)
  B(avx512er, 27)
  B(avx512cd, 28)
  B(sha, 29)
  B(avx512bw, 30)
  B(avx512vl, 31)
#undef B
#define C(name, bit) X(name, f7c, bit)
  C(prefetchwt1, 0)
  C(avx512vbmi, 1)
#undef C

#undef X

#endif /* ZSTD_COMMON_CPU_H */
/**** ended inlining ../common/cpu.h ****/
/**** skipping file: ../common/mem.h ****/
#define FSE_STATIC_LINKING_ONLY
/**** skipping file: ../common/fse.h ****/
#define HUF_STATIC_LINKING_ONLY
/**** skipping file: ../common/huf.h ****/
/**** start inlining zstd_decompress_internal.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */


/* zstd_decompress_internal:
 * objects and definitions shared within lib/decompress modules */

 #ifndef ZSTD_DECOMPRESS_INTERNAL_H
 #define ZSTD_DECOMPRESS_INTERNAL_H


/*-*******************************************************
 *  Dependencies
 *********************************************************/
/**** skipping file: ../common/mem.h ****/
/**** skipping file: ../common/zstd_internal.h ****/



/*-*******************************************************
 *  Constants
 *********************************************************/
static const U32 LL_base[MaxLL+1] = {
                 0,    1,    2,     3,     4,     5,     6,      7,
                 8,    9,   10,    11,    12,    13,    14,     15,
                16,   18,   20,    22,    24,    28,    32,     40,
                48,   64, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000,
                0x2000, 0x4000, 0x8000, 0x10000 };

static const U32 OF_base[MaxOff+1] = {
                 0,        1,       1,       5,     0xD,     0x1D,     0x3D,     0x7D,
                 0xFD,   0x1FD,   0x3FD,   0x7FD,   0xFFD,   0x1FFD,   0x3FFD,   0x7FFD,
                 0xFFFD, 0x1FFFD, 0x3FFFD, 0x7FFFD, 0xFFFFD, 0x1FFFFD, 0x3FFFFD, 0x7FFFFD,
                 0xFFFFFD, 0x1FFFFFD, 0x3FFFFFD, 0x7FFFFFD, 0xFFFFFFD, 0x1FFFFFFD, 0x3FFFFFFD, 0x7FFFFFFD };

static const U32 OF_bits[MaxOff+1] = {
                     0,  1,  2,  3,  4,  5,  6,  7,
                     8,  9, 10, 11, 12, 13, 14, 15,
                    16, 17, 18, 19, 20, 21, 22, 23,
                    24, 25, 26, 27, 28, 29, 30, 31 };

static const U32 ML_base[MaxML+1] = {
                     3,  4,  5,    6,     7,     8,     9,    10,
                    11, 12, 13,   14,    15,    16,    17,    18,
                    19, 20, 21,   22,    23,    24,    25,    26,
                    27, 28, 29,   30,    31,    32,    33,    34,
                    35, 37, 39,   41,    43,    47,    51,    59,
                    67, 83, 99, 0x83, 0x103, 0x203, 0x403, 0x803,
                    0x1003, 0x2003, 0x4003, 0x8003, 0x10003 };


/*-*******************************************************
 *  Decompression types
 *********************************************************/
 typedef struct {
     U32 fastMode;
     U32 tableLog;
 } ZSTD_seqSymbol_header;

 typedef struct {
     U16  nextState;
     BYTE nbAdditionalBits;
     BYTE nbBits;
     U32  baseValue;
 } ZSTD_seqSymbol;

 #define SEQSYMBOL_TABLE_SIZE(log)   (1 + (1 << (log)))

typedef struct {
    ZSTD_seqSymbol LLTable[SEQSYMBOL_TABLE_SIZE(LLFSELog)];    /* Note : Space reserved for FSE Tables */
    ZSTD_seqSymbol OFTable[SEQSYMBOL_TABLE_SIZE(OffFSELog)];   /* is also used as temporary workspace while building hufTable during DDict creation */
    ZSTD_seqSymbol MLTable[SEQSYMBOL_TABLE_SIZE(MLFSELog)];    /* and therefore must be at least HUF_DECOMPRESS_WORKSPACE_SIZE large */
    HUF_DTable hufTable[HUF_DTABLE_SIZE(HufLog)];  /* can accommodate HUF_decompress4X */
    U32 rep[ZSTD_REP_NUM];
} ZSTD_entropyDTables_t;

typedef enum { ZSTDds_getFrameHeaderSize, ZSTDds_decodeFrameHeader,
               ZSTDds_decodeBlockHeader, ZSTDds_decompressBlock,
               ZSTDds_decompressLastBlock, ZSTDds_checkChecksum,
               ZSTDds_decodeSkippableHeader, ZSTDds_skipFrame } ZSTD_dStage;

typedef enum { zdss_init=0, zdss_loadHeader,
               zdss_read, zdss_load, zdss_flush } ZSTD_dStreamStage;

typedef enum {
    ZSTD_use_indefinitely = -1,  /* Use the dictionary indefinitely */
    ZSTD_dont_use = 0,           /* Do not use the dictionary (if one exists free it) */
    ZSTD_use_once = 1            /* Use the dictionary once and set to ZSTD_dont_use */
} ZSTD_dictUses_e;

typedef enum {
    ZSTD_obm_buffered = 0,  /* Buffer the output */
    ZSTD_obm_stable = 1     /* ZSTD_outBuffer is stable */
} ZSTD_outBufferMode_e;

struct ZSTD_DCtx_s
{
    const ZSTD_seqSymbol* LLTptr;
    const ZSTD_seqSymbol* MLTptr;
    const ZSTD_seqSymbol* OFTptr;
    const HUF_DTable* HUFptr;
    ZSTD_entropyDTables_t entropy;
    U32 workspace[HUF_DECOMPRESS_WORKSPACE_SIZE_U32];   /* space needed when building huffman tables */
    const void* previousDstEnd;   /* detect continuity */
    const void* prefixStart;      /* start of current segment */
    const void* virtualStart;     /* virtual start of previous segment if it was just before current one */
    const void* dictEnd;          /* end of previous segment */
    size_t expected;
    ZSTD_frameHeader fParams;
    U64 decodedSize;
    blockType_e bType;            /* used in ZSTD_decompressContinue(), store blockType between block header decoding and block decompression stages */
    ZSTD_dStage stage;
    U32 litEntropy;
    U32 fseEntropy;
    XXH64_state_t xxhState;
    size_t headerSize;
    ZSTD_format_e format;
    const BYTE* litPtr;
    ZSTD_customMem customMem;
    size_t litSize;
    size_t rleSize;
    size_t staticSize;
    int bmi2;                     /* == 1 if the CPU supports BMI2 and 0 otherwise. CPU support is determined dynamically once per context lifetime. */

    /* dictionary */
    ZSTD_DDict* ddictLocal;
    const ZSTD_DDict* ddict;     /* set by ZSTD_initDStream_usingDDict(), or ZSTD_DCtx_refDDict() */
    U32 dictID;
    int ddictIsCold;             /* if == 1 : dictionary is "new" for working context, and presumed "cold" (not in cpu cache) */
    ZSTD_dictUses_e dictUses;

    /* streaming */
    ZSTD_dStreamStage streamStage;
    char*  inBuff;
    size_t inBuffSize;
    size_t inPos;
    size_t maxWindowSize;
    char*  outBuff;
    size_t outBuffSize;
    size_t outStart;
    size_t outEnd;
    size_t lhSize;
    void* legacyContext;
    U32 previousLegacyVersion;
    U32 legacyVersion;
    U32 hostageByte;
    int noForwardProgress;
    ZSTD_outBufferMode_e outBufferMode;
    ZSTD_outBuffer expectedOutBuffer;

    /* workspace */
    BYTE litBuffer[ZSTD_BLOCKSIZE_MAX + WILDCOPY_OVERLENGTH];
    BYTE headerBuffer[ZSTD_FRAMEHEADERSIZE_MAX];

    size_t oversizedDuration;

#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
    void const* dictContentBeginForFuzzing;
    void const* dictContentEndForFuzzing;
#endif
};  /* typedef'd to ZSTD_DCtx within "zstd.h" */


/*-*******************************************************
 *  Shared internal functions
 *********************************************************/

/*! ZSTD_loadDEntropy() :
 *  dict : must point at beginning of a valid zstd dictionary.
 * @return : size of dictionary header (size of magic number + dict ID + entropy tables) */
size_t ZSTD_loadDEntropy(ZSTD_entropyDTables_t* entropy,
                   const void* const dict, size_t const dictSize);

/*! ZSTD_checkContinuity() :
 *  check if next `dst` follows previous position, where decompression ended.
 *  If yes, do nothing (continue on current segment).
 *  If not, classify previous segment as "external dictionary", and start a new segment.
 *  This function cannot fail. */
void ZSTD_checkContinuity(ZSTD_DCtx* dctx, const void* dst);


#endif /* ZSTD_DECOMPRESS_INTERNAL_H */
/**** ended inlining zstd_decompress_internal.h ****/
/**** start inlining zstd_ddict.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */


#ifndef ZSTD_DDICT_H
#define ZSTD_DDICT_H

/*-*******************************************************
 *  Dependencies
 *********************************************************/
#include <stddef.h>   /* size_t */
/**** skipping file: ../zstd.h ****/


/*-*******************************************************
 *  Interface
 *********************************************************/

/* note: several prototypes are already published in `zstd.h` :
 * ZSTD_createDDict()
 * ZSTD_createDDict_byReference()
 * ZSTD_createDDict_advanced()
 * ZSTD_freeDDict()
 * ZSTD_initStaticDDict()
 * ZSTD_sizeof_DDict()
 * ZSTD_estimateDDictSize()
 * ZSTD_getDictID_fromDict()
 */

const void* ZSTD_DDict_dictContent(const ZSTD_DDict* ddict);
size_t ZSTD_DDict_dictSize(const ZSTD_DDict* ddict);

void ZSTD_copyDDictParameters(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict);



#endif /* ZSTD_DDICT_H */
/**** ended inlining zstd_ddict.h ****/

#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT>=1)
/**** start inlining ../legacy/zstd_legacy.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_LEGACY_H
#define ZSTD_LEGACY_H

#if defined (__cplusplus)
extern "C" {
#endif

/* *************************************
*  Includes
***************************************/
/**** skipping file: ../common/mem.h ****/
/**** skipping file: ../common/error_private.h ****/
/**** skipping file: ../common/zstd_internal.h ****/

#if !defined (ZSTD_LEGACY_SUPPORT) || (ZSTD_LEGACY_SUPPORT == 0)
#  undef ZSTD_LEGACY_SUPPORT
#  define ZSTD_LEGACY_SUPPORT 8
#endif

#if (ZSTD_LEGACY_SUPPORT <= 1)
/**** start inlining zstd_v01.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_V01_H_28739879432
#define ZSTD_V01_H_28739879432

#if defined (__cplusplus)
extern "C" {
#endif

/* *************************************
*  Includes
***************************************/
#include <stddef.h>   /* size_t */


/* *************************************
*  Simple one-step function
***************************************/
/**
ZSTDv01_decompress() : decompress ZSTD frames compliant with v0.1.x format
    compressedSize : is the exact source size
    maxOriginalSize : is the size of the 'dst' buffer, which must be already allocated.
                      It must be equal or larger than originalSize, otherwise decompression will fail.
    return : the number of bytes decompressed into destination buffer (originalSize)
             or an errorCode if it fails (which can be tested using ZSTDv01_isError())
*/
size_t ZSTDv01_decompress( void* dst, size_t maxOriginalSize,
                     const void* src, size_t compressedSize);

 /**
 ZSTDv01_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.1.x format
     srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
     cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                 or an error code if it fails (which can be tested using ZSTDv01_isError())
     dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                 or ZSTD_CONTENTSIZE_ERROR if an error occurs

     note : assumes `cSize` and `dBound` are _not_ NULL.
 */
void ZSTDv01_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                     size_t* cSize, unsigned long long* dBound);

/**
ZSTDv01_isError() : tells if the result of ZSTDv01_decompress() is an error
*/
unsigned ZSTDv01_isError(size_t code);


/* *************************************
*  Advanced functions
***************************************/
typedef struct ZSTDv01_Dctx_s ZSTDv01_Dctx;
ZSTDv01_Dctx* ZSTDv01_createDCtx(void);
size_t ZSTDv01_freeDCtx(ZSTDv01_Dctx* dctx);

size_t ZSTDv01_decompressDCtx(void* ctx,
                              void* dst, size_t maxOriginalSize,
                        const void* src, size_t compressedSize);

/* *************************************
*  Streaming functions
***************************************/
size_t ZSTDv01_resetDCtx(ZSTDv01_Dctx* dctx);

size_t ZSTDv01_nextSrcSizeToDecompress(ZSTDv01_Dctx* dctx);
size_t ZSTDv01_decompressContinue(ZSTDv01_Dctx* dctx, void* dst, size_t maxDstSize, const void* src, size_t srcSize);
/**
  Use above functions alternatively.
  ZSTD_nextSrcSizeToDecompress() tells how much bytes to provide as 'srcSize' to ZSTD_decompressContinue().
  ZSTD_decompressContinue() will use previous data blocks to improve compression if they are located prior to current block.
  Result is the number of bytes regenerated within 'dst'.
  It can be zero, which is not an error; it just means ZSTD_decompressContinue() has decoded some header.
*/

/* *************************************
*  Prefix - version detection
***************************************/
#define ZSTDv01_magicNumber   0xFD2FB51E   /* Big Endian version */
#define ZSTDv01_magicNumberLE 0x1EB52FFD   /* Little Endian version */


#if defined (__cplusplus)
}
#endif

#endif /* ZSTD_V01_H_28739879432 */
/**** ended inlining zstd_v01.h ****/
#endif
#if (ZSTD_LEGACY_SUPPORT <= 2)
/**** start inlining zstd_v02.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_V02_H_4174539423
#define ZSTD_V02_H_4174539423

#if defined (__cplusplus)
extern "C" {
#endif

/* *************************************
*  Includes
***************************************/
#include <stddef.h>   /* size_t */


/* *************************************
*  Simple one-step function
***************************************/
/**
ZSTDv02_decompress() : decompress ZSTD frames compliant with v0.2.x format
    compressedSize : is the exact source size
    maxOriginalSize : is the size of the 'dst' buffer, which must be already allocated.
                      It must be equal or larger than originalSize, otherwise decompression will fail.
    return : the number of bytes decompressed into destination buffer (originalSize)
             or an errorCode if it fails (which can be tested using ZSTDv01_isError())
*/
size_t ZSTDv02_decompress( void* dst, size_t maxOriginalSize,
                     const void* src, size_t compressedSize);

 /**
 ZSTDv02_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.2.x format
     srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
     cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                 or an error code if it fails (which can be tested using ZSTDv01_isError())
     dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                 or ZSTD_CONTENTSIZE_ERROR if an error occurs

    note : assumes `cSize` and `dBound` are _not_ NULL.
 */
void ZSTDv02_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                     size_t* cSize, unsigned long long* dBound);

/**
ZSTDv02_isError() : tells if the result of ZSTDv02_decompress() is an error
*/
unsigned ZSTDv02_isError(size_t code);


/* *************************************
*  Advanced functions
***************************************/
typedef struct ZSTDv02_Dctx_s ZSTDv02_Dctx;
ZSTDv02_Dctx* ZSTDv02_createDCtx(void);
size_t ZSTDv02_freeDCtx(ZSTDv02_Dctx* dctx);

size_t ZSTDv02_decompressDCtx(void* ctx,
                              void* dst, size_t maxOriginalSize,
                        const void* src, size_t compressedSize);

/* *************************************
*  Streaming functions
***************************************/
size_t ZSTDv02_resetDCtx(ZSTDv02_Dctx* dctx);

size_t ZSTDv02_nextSrcSizeToDecompress(ZSTDv02_Dctx* dctx);
size_t ZSTDv02_decompressContinue(ZSTDv02_Dctx* dctx, void* dst, size_t maxDstSize, const void* src, size_t srcSize);
/**
  Use above functions alternatively.
  ZSTD_nextSrcSizeToDecompress() tells how much bytes to provide as 'srcSize' to ZSTD_decompressContinue().
  ZSTD_decompressContinue() will use previous data blocks to improve compression if they are located prior to current block.
  Result is the number of bytes regenerated within 'dst'.
  It can be zero, which is not an error; it just means ZSTD_decompressContinue() has decoded some header.
*/

/* *************************************
*  Prefix - version detection
***************************************/
#define ZSTDv02_magicNumber 0xFD2FB522   /* v0.2 */


#if defined (__cplusplus)
}
#endif

#endif /* ZSTD_V02_H_4174539423 */
/**** ended inlining zstd_v02.h ****/
#endif
#if (ZSTD_LEGACY_SUPPORT <= 3)
/**** start inlining zstd_v03.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_V03_H_298734209782
#define ZSTD_V03_H_298734209782

#if defined (__cplusplus)
extern "C" {
#endif

/* *************************************
*  Includes
***************************************/
#include <stddef.h>   /* size_t */


/* *************************************
*  Simple one-step function
***************************************/
/**
ZSTDv03_decompress() : decompress ZSTD frames compliant with v0.3.x format
    compressedSize : is the exact source size
    maxOriginalSize : is the size of the 'dst' buffer, which must be already allocated.
                      It must be equal or larger than originalSize, otherwise decompression will fail.
    return : the number of bytes decompressed into destination buffer (originalSize)
             or an errorCode if it fails (which can be tested using ZSTDv01_isError())
*/
size_t ZSTDv03_decompress( void* dst, size_t maxOriginalSize,
                     const void* src, size_t compressedSize);

 /**
 ZSTDv03_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.3.x format
     srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
     cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                 or an error code if it fails (which can be tested using ZSTDv01_isError())
     dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                 or ZSTD_CONTENTSIZE_ERROR if an error occurs

    note : assumes `cSize` and `dBound` are _not_ NULL.
 */
 void ZSTDv03_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                      size_t* cSize, unsigned long long* dBound);

    /**
ZSTDv03_isError() : tells if the result of ZSTDv03_decompress() is an error
*/
unsigned ZSTDv03_isError(size_t code);


/* *************************************
*  Advanced functions
***************************************/
typedef struct ZSTDv03_Dctx_s ZSTDv03_Dctx;
ZSTDv03_Dctx* ZSTDv03_createDCtx(void);
size_t ZSTDv03_freeDCtx(ZSTDv03_Dctx* dctx);

size_t ZSTDv03_decompressDCtx(void* ctx,
                              void* dst, size_t maxOriginalSize,
                        const void* src, size_t compressedSize);

/* *************************************
*  Streaming functions
***************************************/
size_t ZSTDv03_resetDCtx(ZSTDv03_Dctx* dctx);

size_t ZSTDv03_nextSrcSizeToDecompress(ZSTDv03_Dctx* dctx);
size_t ZSTDv03_decompressContinue(ZSTDv03_Dctx* dctx, void* dst, size_t maxDstSize, const void* src, size_t srcSize);
/**
  Use above functions alternatively.
  ZSTD_nextSrcSizeToDecompress() tells how much bytes to provide as 'srcSize' to ZSTD_decompressContinue().
  ZSTD_decompressContinue() will use previous data blocks to improve compression if they are located prior to current block.
  Result is the number of bytes regenerated within 'dst'.
  It can be zero, which is not an error; it just means ZSTD_decompressContinue() has decoded some header.
*/

/* *************************************
*  Prefix - version detection
***************************************/
#define ZSTDv03_magicNumber 0xFD2FB523   /* v0.3 */


#if defined (__cplusplus)
}
#endif

#endif /* ZSTD_V03_H_298734209782 */
/**** ended inlining zstd_v03.h ****/
#endif
#if (ZSTD_LEGACY_SUPPORT <= 4)
/**** start inlining zstd_v04.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTD_V04_H_91868324769238
#define ZSTD_V04_H_91868324769238

#if defined (__cplusplus)
extern "C" {
#endif

/* *************************************
*  Includes
***************************************/
#include <stddef.h>   /* size_t */


/* *************************************
*  Simple one-step function
***************************************/
/**
ZSTDv04_decompress() : decompress ZSTD frames compliant with v0.4.x format
    compressedSize : is the exact source size
    maxOriginalSize : is the size of the 'dst' buffer, which must be already allocated.
                      It must be equal or larger than originalSize, otherwise decompression will fail.
    return : the number of bytes decompressed into destination buffer (originalSize)
             or an errorCode if it fails (which can be tested using ZSTDv01_isError())
*/
size_t ZSTDv04_decompress( void* dst, size_t maxOriginalSize,
                     const void* src, size_t compressedSize);

 /**
 ZSTDv04_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.4.x format
     srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
     cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                 or an error code if it fails (which can be tested using ZSTDv01_isError())
     dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                 or ZSTD_CONTENTSIZE_ERROR if an error occurs

    note : assumes `cSize` and `dBound` are _not_ NULL.
 */
 void ZSTDv04_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                      size_t* cSize, unsigned long long* dBound);

/**
ZSTDv04_isError() : tells if the result of ZSTDv04_decompress() is an error
*/
unsigned ZSTDv04_isError(size_t code);


/* *************************************
*  Advanced functions
***************************************/
typedef struct ZSTDv04_Dctx_s ZSTDv04_Dctx;
ZSTDv04_Dctx* ZSTDv04_createDCtx(void);
size_t ZSTDv04_freeDCtx(ZSTDv04_Dctx* dctx);

size_t ZSTDv04_decompressDCtx(ZSTDv04_Dctx* dctx,
                              void* dst, size_t maxOriginalSize,
                        const void* src, size_t compressedSize);


/* *************************************
*  Direct Streaming
***************************************/
size_t ZSTDv04_resetDCtx(ZSTDv04_Dctx* dctx);

size_t ZSTDv04_nextSrcSizeToDecompress(ZSTDv04_Dctx* dctx);
size_t ZSTDv04_decompressContinue(ZSTDv04_Dctx* dctx, void* dst, size_t maxDstSize, const void* src, size_t srcSize);
/**
  Use above functions alternatively.
  ZSTD_nextSrcSizeToDecompress() tells how much bytes to provide as 'srcSize' to ZSTD_decompressContinue().
  ZSTD_decompressContinue() will use previous data blocks to improve compression if they are located prior to current block.
  Result is the number of bytes regenerated within 'dst'.
  It can be zero, which is not an error; it just means ZSTD_decompressContinue() has decoded some header.
*/


/* *************************************
*  Buffered Streaming
***************************************/
typedef struct ZBUFFv04_DCtx_s ZBUFFv04_DCtx;
ZBUFFv04_DCtx* ZBUFFv04_createDCtx(void);
size_t         ZBUFFv04_freeDCtx(ZBUFFv04_DCtx* dctx);

size_t ZBUFFv04_decompressInit(ZBUFFv04_DCtx* dctx);
size_t ZBUFFv04_decompressWithDictionary(ZBUFFv04_DCtx* dctx, const void* dict, size_t dictSize);

size_t ZBUFFv04_decompressContinue(ZBUFFv04_DCtx* dctx, void* dst, size_t* maxDstSizePtr, const void* src, size_t* srcSizePtr);

/** ************************************************
*  Streaming decompression
*
*  A ZBUFF_DCtx object is required to track streaming operation.
*  Use ZBUFF_createDCtx() and ZBUFF_freeDCtx() to create/release resources.
*  Use ZBUFF_decompressInit() to start a new decompression operation.
*  ZBUFF_DCtx objects can be reused multiple times.
*
*  Optionally, a reference to a static dictionary can be set, using ZBUFF_decompressWithDictionary()
*  It must be the same content as the one set during compression phase.
*  Dictionary content must remain accessible during the decompression process.
*
*  Use ZBUFF_decompressContinue() repetitively to consume your input.
*  *srcSizePtr and *maxDstSizePtr can be any size.
*  The function will report how many bytes were read or written by modifying *srcSizePtr and *maxDstSizePtr.
*  Note that it may not consume the entire input, in which case it's up to the caller to present remaining input again.
*  The content of dst will be overwritten (up to *maxDstSizePtr) at each function call, so save its content if it matters or change dst.
*  @return : a hint to preferred nb of bytes to use as input for next function call (it's only a hint, to improve latency)
*            or 0 when a frame is completely decoded
*            or an error code, which can be tested using ZBUFF_isError().
*
*  Hint : recommended buffer sizes (not compulsory) : ZBUFF_recommendedDInSize / ZBUFF_recommendedDOutSize
*  output : ZBUFF_recommendedDOutSize==128 KB block size is the internal unit, it ensures it's always possible to write a full block when it's decoded.
*  input : ZBUFF_recommendedDInSize==128Kb+3; just follow indications from ZBUFF_decompressContinue() to minimize latency. It should always be <= 128 KB + 3 .
* **************************************************/
unsigned ZBUFFv04_isError(size_t errorCode);
const char* ZBUFFv04_getErrorName(size_t errorCode);


/** The below functions provide recommended buffer sizes for Compression or Decompression operations.
*   These sizes are not compulsory, they just tend to offer better latency */
size_t ZBUFFv04_recommendedDInSize(void);
size_t ZBUFFv04_recommendedDOutSize(void);


/* *************************************
*  Prefix - version detection
***************************************/
#define ZSTDv04_magicNumber 0xFD2FB524   /* v0.4 */


#if defined (__cplusplus)
}
#endif

#endif /* ZSTD_V04_H_91868324769238 */
/**** ended inlining zstd_v04.h ****/
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
/**** start inlining zstd_v05.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTDv05_H
#define ZSTDv05_H

#if defined (__cplusplus)
extern "C" {
#endif

/*-*************************************
*  Dependencies
***************************************/
#include <stddef.h>   /* size_t */
/**** skipping file: ../common/mem.h ****/


/* *************************************
*  Simple functions
***************************************/
/*! ZSTDv05_decompress() :
    `compressedSize` : is the _exact_ size of the compressed blob, otherwise decompression will fail.
    `dstCapacity` must be large enough, equal or larger than originalSize.
    @return : the number of bytes decompressed into `dst` (<= `dstCapacity`),
              or an errorCode if it fails (which can be tested using ZSTDv05_isError()) */
size_t ZSTDv05_decompress( void* dst, size_t dstCapacity,
                     const void* src, size_t compressedSize);

 /**
 ZSTDv05_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.5.x format
     srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
     cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                 or an error code if it fails (which can be tested using ZSTDv01_isError())
     dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                 or ZSTD_CONTENTSIZE_ERROR if an error occurs

    note : assumes `cSize` and `dBound` are _not_ NULL.
 */
void ZSTDv05_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                     size_t* cSize, unsigned long long* dBound);

/* *************************************
*  Helper functions
***************************************/
/* Error Management */
unsigned    ZSTDv05_isError(size_t code);          /*!< tells if a `size_t` function result is an error code */
const char* ZSTDv05_getErrorName(size_t code);     /*!< provides readable string for an error code */


/* *************************************
*  Explicit memory management
***************************************/
/** Decompression context */
typedef struct ZSTDv05_DCtx_s ZSTDv05_DCtx;
ZSTDv05_DCtx* ZSTDv05_createDCtx(void);
size_t ZSTDv05_freeDCtx(ZSTDv05_DCtx* dctx);      /*!< @return : errorCode */

/** ZSTDv05_decompressDCtx() :
*   Same as ZSTDv05_decompress(), but requires an already allocated ZSTDv05_DCtx (see ZSTDv05_createDCtx()) */
size_t ZSTDv05_decompressDCtx(ZSTDv05_DCtx* ctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);


/*-***********************
*  Simple Dictionary API
*************************/
/*! ZSTDv05_decompress_usingDict() :
*   Decompression using a pre-defined Dictionary content (see dictBuilder).
*   Dictionary must be identical to the one used during compression, otherwise regenerated data will be corrupted.
*   Note : dict can be NULL, in which case, it's equivalent to ZSTDv05_decompressDCtx() */
size_t ZSTDv05_decompress_usingDict(ZSTDv05_DCtx* dctx,
                                            void* dst, size_t dstCapacity,
                                      const void* src, size_t srcSize,
                                      const void* dict,size_t dictSize);

/*-************************
*  Advanced Streaming API
***************************/
typedef enum { ZSTDv05_fast, ZSTDv05_greedy, ZSTDv05_lazy, ZSTDv05_lazy2, ZSTDv05_btlazy2, ZSTDv05_opt, ZSTDv05_btopt } ZSTDv05_strategy;
typedef struct {
    U64 srcSize;
    U32 windowLog;     /* the only useful information to retrieve */
    U32 contentLog; U32 hashLog; U32 searchLog; U32 searchLength; U32 targetLength; ZSTDv05_strategy strategy;
} ZSTDv05_parameters;
size_t ZSTDv05_getFrameParams(ZSTDv05_parameters* params, const void* src, size_t srcSize);

size_t ZSTDv05_decompressBegin_usingDict(ZSTDv05_DCtx* dctx, const void* dict, size_t dictSize);
void   ZSTDv05_copyDCtx(ZSTDv05_DCtx* dstDCtx, const ZSTDv05_DCtx* srcDCtx);
size_t ZSTDv05_nextSrcSizeToDecompress(ZSTDv05_DCtx* dctx);
size_t ZSTDv05_decompressContinue(ZSTDv05_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);


/*-***********************
*  ZBUFF API
*************************/
typedef struct ZBUFFv05_DCtx_s ZBUFFv05_DCtx;
ZBUFFv05_DCtx* ZBUFFv05_createDCtx(void);
size_t         ZBUFFv05_freeDCtx(ZBUFFv05_DCtx* dctx);

size_t ZBUFFv05_decompressInit(ZBUFFv05_DCtx* dctx);
size_t ZBUFFv05_decompressInitDictionary(ZBUFFv05_DCtx* dctx, const void* dict, size_t dictSize);

size_t ZBUFFv05_decompressContinue(ZBUFFv05_DCtx* dctx,
                                            void* dst, size_t* dstCapacityPtr,
                                      const void* src, size_t* srcSizePtr);

/*-***************************************************************************
*  Streaming decompression
*
*  A ZBUFFv05_DCtx object is required to track streaming operations.
*  Use ZBUFFv05_createDCtx() and ZBUFFv05_freeDCtx() to create/release resources.
*  Use ZBUFFv05_decompressInit() to start a new decompression operation,
*   or ZBUFFv05_decompressInitDictionary() if decompression requires a dictionary.
*  Note that ZBUFFv05_DCtx objects can be reused multiple times.
*
*  Use ZBUFFv05_decompressContinue() repetitively to consume your input.
*  *srcSizePtr and *dstCapacityPtr can be any size.
*  The function will report how many bytes were read or written by modifying *srcSizePtr and *dstCapacityPtr.
*  Note that it may not consume the entire input, in which case it's up to the caller to present remaining input again.
*  The content of @dst will be overwritten (up to *dstCapacityPtr) at each function call, so save its content if it matters or change @dst.
*  @return : a hint to preferred nb of bytes to use as input for next function call (it's only a hint, to help latency)
*            or 0 when a frame is completely decoded
*            or an error code, which can be tested using ZBUFFv05_isError().
*
*  Hint : recommended buffer sizes (not compulsory) : ZBUFFv05_recommendedDInSize() / ZBUFFv05_recommendedDOutSize()
*  output : ZBUFFv05_recommendedDOutSize==128 KB block size is the internal unit, it ensures it's always possible to write a full block when decoded.
*  input  : ZBUFFv05_recommendedDInSize==128Kb+3; just follow indications from ZBUFFv05_decompressContinue() to minimize latency. It should always be <= 128 KB + 3 .
* *******************************************************************************/


/* *************************************
*  Tool functions
***************************************/
unsigned ZBUFFv05_isError(size_t errorCode);
const char* ZBUFFv05_getErrorName(size_t errorCode);

/** Functions below provide recommended buffer sizes for Compression or Decompression operations.
*   These sizes are just hints, and tend to offer better latency */
size_t ZBUFFv05_recommendedDInSize(void);
size_t ZBUFFv05_recommendedDOutSize(void);



/*-*************************************
*  Constants
***************************************/
#define ZSTDv05_MAGICNUMBER 0xFD2FB525   /* v0.5 */




#if defined (__cplusplus)
}
#endif

#endif  /* ZSTDv0505_H */
/**** ended inlining zstd_v05.h ****/
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
/**** start inlining zstd_v06.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTDv06_H
#define ZSTDv06_H

#if defined (__cplusplus)
extern "C" {
#endif

/*======  Dependency  ======*/
#include <stddef.h>   /* size_t */


/*======  Export for Windows  ======*/
/*!
*  ZSTDv06_DLL_EXPORT :
*  Enable exporting of functions when building a Windows DLL
*/
#if defined(_WIN32) && defined(ZSTDv06_DLL_EXPORT) && (ZSTDv06_DLL_EXPORT==1)
#  define ZSTDLIBv06_API __declspec(dllexport)
#else
#  define ZSTDLIBv06_API
#endif


/* *************************************
*  Simple functions
***************************************/
/*! ZSTDv06_decompress() :
    `compressedSize` : is the _exact_ size of the compressed blob, otherwise decompression will fail.
    `dstCapacity` must be large enough, equal or larger than originalSize.
    @return : the number of bytes decompressed into `dst` (<= `dstCapacity`),
              or an errorCode if it fails (which can be tested using ZSTDv06_isError()) */
ZSTDLIBv06_API size_t ZSTDv06_decompress( void* dst, size_t dstCapacity,
                                    const void* src, size_t compressedSize);

/**
ZSTDv06_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.6.x format
    srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
    cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                or an error code if it fails (which can be tested using ZSTDv01_isError())
    dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                or ZSTD_CONTENTSIZE_ERROR if an error occurs

    note : assumes `cSize` and `dBound` are _not_ NULL.
*/
void ZSTDv06_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                     size_t* cSize, unsigned long long* dBound);

/* *************************************
*  Helper functions
***************************************/
ZSTDLIBv06_API size_t      ZSTDv06_compressBound(size_t srcSize); /*!< maximum compressed size (worst case scenario) */

/* Error Management */
ZSTDLIBv06_API unsigned    ZSTDv06_isError(size_t code);          /*!< tells if a `size_t` function result is an error code */
ZSTDLIBv06_API const char* ZSTDv06_getErrorName(size_t code);     /*!< provides readable string for an error code */


/* *************************************
*  Explicit memory management
***************************************/
/** Decompression context */
typedef struct ZSTDv06_DCtx_s ZSTDv06_DCtx;
ZSTDLIBv06_API ZSTDv06_DCtx* ZSTDv06_createDCtx(void);
ZSTDLIBv06_API size_t     ZSTDv06_freeDCtx(ZSTDv06_DCtx* dctx);      /*!< @return : errorCode */

/** ZSTDv06_decompressDCtx() :
*   Same as ZSTDv06_decompress(), but requires an already allocated ZSTDv06_DCtx (see ZSTDv06_createDCtx()) */
ZSTDLIBv06_API size_t ZSTDv06_decompressDCtx(ZSTDv06_DCtx* ctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);


/*-***********************
*  Dictionary API
*************************/
/*! ZSTDv06_decompress_usingDict() :
*   Decompression using a pre-defined Dictionary content (see dictBuilder).
*   Dictionary must be identical to the one used during compression, otherwise regenerated data will be corrupted.
*   Note : dict can be NULL, in which case, it's equivalent to ZSTDv06_decompressDCtx() */
ZSTDLIBv06_API size_t ZSTDv06_decompress_usingDict(ZSTDv06_DCtx* dctx,
                                                   void* dst, size_t dstCapacity,
                                             const void* src, size_t srcSize,
                                             const void* dict,size_t dictSize);


/*-************************
*  Advanced Streaming API
***************************/
struct ZSTDv06_frameParams_s { unsigned long long frameContentSize; unsigned windowLog; };
typedef struct ZSTDv06_frameParams_s ZSTDv06_frameParams;

ZSTDLIBv06_API size_t ZSTDv06_getFrameParams(ZSTDv06_frameParams* fparamsPtr, const void* src, size_t srcSize);   /**< doesn't consume input */
ZSTDLIBv06_API size_t ZSTDv06_decompressBegin_usingDict(ZSTDv06_DCtx* dctx, const void* dict, size_t dictSize);
ZSTDLIBv06_API void   ZSTDv06_copyDCtx(ZSTDv06_DCtx* dctx, const ZSTDv06_DCtx* preparedDCtx);

ZSTDLIBv06_API size_t ZSTDv06_nextSrcSizeToDecompress(ZSTDv06_DCtx* dctx);
ZSTDLIBv06_API size_t ZSTDv06_decompressContinue(ZSTDv06_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);



/* *************************************
*  ZBUFF API
***************************************/

typedef struct ZBUFFv06_DCtx_s ZBUFFv06_DCtx;
ZSTDLIBv06_API ZBUFFv06_DCtx* ZBUFFv06_createDCtx(void);
ZSTDLIBv06_API size_t         ZBUFFv06_freeDCtx(ZBUFFv06_DCtx* dctx);

ZSTDLIBv06_API size_t ZBUFFv06_decompressInit(ZBUFFv06_DCtx* dctx);
ZSTDLIBv06_API size_t ZBUFFv06_decompressInitDictionary(ZBUFFv06_DCtx* dctx, const void* dict, size_t dictSize);

ZSTDLIBv06_API size_t ZBUFFv06_decompressContinue(ZBUFFv06_DCtx* dctx,
                                                  void* dst, size_t* dstCapacityPtr,
                                            const void* src, size_t* srcSizePtr);

/*-***************************************************************************
*  Streaming decompression howto
*
*  A ZBUFFv06_DCtx object is required to track streaming operations.
*  Use ZBUFFv06_createDCtx() and ZBUFFv06_freeDCtx() to create/release resources.
*  Use ZBUFFv06_decompressInit() to start a new decompression operation,
*   or ZBUFFv06_decompressInitDictionary() if decompression requires a dictionary.
*  Note that ZBUFFv06_DCtx objects can be re-init multiple times.
*
*  Use ZBUFFv06_decompressContinue() repetitively to consume your input.
*  *srcSizePtr and *dstCapacityPtr can be any size.
*  The function will report how many bytes were read or written by modifying *srcSizePtr and *dstCapacityPtr.
*  Note that it may not consume the entire input, in which case it's up to the caller to present remaining input again.
*  The content of `dst` will be overwritten (up to *dstCapacityPtr) at each function call, so save its content if it matters, or change `dst`.
*  @return : a hint to preferred nb of bytes to use as input for next function call (it's only a hint, to help latency),
*            or 0 when a frame is completely decoded,
*            or an error code, which can be tested using ZBUFFv06_isError().
*
*  Hint : recommended buffer sizes (not compulsory) : ZBUFFv06_recommendedDInSize() and ZBUFFv06_recommendedDOutSize()
*  output : ZBUFFv06_recommendedDOutSize== 128 KB block size is the internal unit, it ensures it's always possible to write a full block when decoded.
*  input  : ZBUFFv06_recommendedDInSize == 128KB + 3;
*           just follow indications from ZBUFFv06_decompressContinue() to minimize latency. It should always be <= 128 KB + 3 .
* *******************************************************************************/


/* *************************************
*  Tool functions
***************************************/
ZSTDLIBv06_API unsigned ZBUFFv06_isError(size_t errorCode);
ZSTDLIBv06_API const char* ZBUFFv06_getErrorName(size_t errorCode);

/** Functions below provide recommended buffer sizes for Compression or Decompression operations.
*   These sizes are just hints, they tend to offer better latency */
ZSTDLIBv06_API size_t ZBUFFv06_recommendedDInSize(void);
ZSTDLIBv06_API size_t ZBUFFv06_recommendedDOutSize(void);


/*-*************************************
*  Constants
***************************************/
#define ZSTDv06_MAGICNUMBER 0xFD2FB526   /* v0.6 */



#if defined (__cplusplus)
}
#endif

#endif  /* ZSTDv06_BUFFERED_H */
/**** ended inlining zstd_v06.h ****/
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
/**** start inlining zstd_v07.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

#ifndef ZSTDv07_H_235446
#define ZSTDv07_H_235446

#if defined (__cplusplus)
extern "C" {
#endif

/*======  Dependency  ======*/
#include <stddef.h>   /* size_t */


/*======  Export for Windows  ======*/
/*!
*  ZSTDv07_DLL_EXPORT :
*  Enable exporting of functions when building a Windows DLL
*/
#if defined(_WIN32) && defined(ZSTDv07_DLL_EXPORT) && (ZSTDv07_DLL_EXPORT==1)
#  define ZSTDLIBv07_API __declspec(dllexport)
#else
#  define ZSTDLIBv07_API
#endif


/* *************************************
*  Simple API
***************************************/
/*! ZSTDv07_getDecompressedSize() :
*   @return : decompressed size if known, 0 otherwise.
       note 1 : if `0`, follow up with ZSTDv07_getFrameParams() to know precise failure cause.
       note 2 : decompressed size could be wrong or intentionally modified !
                always ensure results fit within application's authorized limits */
unsigned long long ZSTDv07_getDecompressedSize(const void* src, size_t srcSize);

/*! ZSTDv07_decompress() :
    `compressedSize` : must be _exact_ size of compressed input, otherwise decompression will fail.
    `dstCapacity` must be equal or larger than originalSize.
    @return : the number of bytes decompressed into `dst` (<= `dstCapacity`),
              or an errorCode if it fails (which can be tested using ZSTDv07_isError()) */
ZSTDLIBv07_API size_t ZSTDv07_decompress( void* dst, size_t dstCapacity,
                                    const void* src, size_t compressedSize);

/**
ZSTDv07_findFrameSizeInfoLegacy() : get the source length and decompressed bound of a ZSTD frame compliant with v0.7.x format
    srcSize : The size of the 'src' buffer, at least as large as the frame pointed to by 'src'
    cSize (output parameter)  : the number of bytes that would be read to decompress this frame
                                or an error code if it fails (which can be tested using ZSTDv01_isError())
    dBound (output parameter) : an upper-bound for the decompressed size of the data in the frame
                                or ZSTD_CONTENTSIZE_ERROR if an error occurs

    note : assumes `cSize` and `dBound` are _not_ NULL.
*/
void ZSTDv07_findFrameSizeInfoLegacy(const void *src, size_t srcSize,
                                     size_t* cSize, unsigned long long* dBound);

/*======  Helper functions  ======*/
ZSTDLIBv07_API unsigned    ZSTDv07_isError(size_t code);          /*!< tells if a `size_t` function result is an error code */
ZSTDLIBv07_API const char* ZSTDv07_getErrorName(size_t code);     /*!< provides readable string from an error code */


/*-*************************************
*  Explicit memory management
***************************************/
/** Decompression context */
typedef struct ZSTDv07_DCtx_s ZSTDv07_DCtx;
ZSTDLIBv07_API ZSTDv07_DCtx* ZSTDv07_createDCtx(void);
ZSTDLIBv07_API size_t     ZSTDv07_freeDCtx(ZSTDv07_DCtx* dctx);      /*!< @return : errorCode */

/** ZSTDv07_decompressDCtx() :
*   Same as ZSTDv07_decompress(), requires an allocated ZSTDv07_DCtx (see ZSTDv07_createDCtx()) */
ZSTDLIBv07_API size_t ZSTDv07_decompressDCtx(ZSTDv07_DCtx* ctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize);


/*-************************
*  Simple dictionary API
***************************/
/*! ZSTDv07_decompress_usingDict() :
*   Decompression using a pre-defined Dictionary content (see dictBuilder).
*   Dictionary must be identical to the one used during compression.
*   Note : This function load the dictionary, resulting in a significant startup time */
ZSTDLIBv07_API size_t ZSTDv07_decompress_usingDict(ZSTDv07_DCtx* dctx,
                                                   void* dst, size_t dstCapacity,
                                             const void* src, size_t srcSize,
                                             const void* dict,size_t dictSize);


/*-**************************
*  Advanced Dictionary API
****************************/
/*! ZSTDv07_createDDict() :
*   Create a digested dictionary, ready to start decompression operation without startup delay.
*   `dict` can be released after creation */
typedef struct ZSTDv07_DDict_s ZSTDv07_DDict;
ZSTDLIBv07_API ZSTDv07_DDict* ZSTDv07_createDDict(const void* dict, size_t dictSize);
ZSTDLIBv07_API size_t      ZSTDv07_freeDDict(ZSTDv07_DDict* ddict);

/*! ZSTDv07_decompress_usingDDict() :
*   Decompression using a pre-digested Dictionary
*   Faster startup than ZSTDv07_decompress_usingDict(), recommended when same dictionary is used multiple times. */
ZSTDLIBv07_API size_t ZSTDv07_decompress_usingDDict(ZSTDv07_DCtx* dctx,
                                                    void* dst, size_t dstCapacity,
                                              const void* src, size_t srcSize,
                                              const ZSTDv07_DDict* ddict);

typedef struct {
    unsigned long long frameContentSize;
    unsigned windowSize;
    unsigned dictID;
    unsigned checksumFlag;
} ZSTDv07_frameParams;

ZSTDLIBv07_API size_t ZSTDv07_getFrameParams(ZSTDv07_frameParams* fparamsPtr, const void* src, size_t srcSize);   /**< doesn't consume input */




/* *************************************
*  Streaming functions
***************************************/
typedef struct ZBUFFv07_DCtx_s ZBUFFv07_DCtx;
ZSTDLIBv07_API ZBUFFv07_DCtx* ZBUFFv07_createDCtx(void);
ZSTDLIBv07_API size_t      ZBUFFv07_freeDCtx(ZBUFFv07_DCtx* dctx);

ZSTDLIBv07_API size_t ZBUFFv07_decompressInit(ZBUFFv07_DCtx* dctx);
ZSTDLIBv07_API size_t ZBUFFv07_decompressInitDictionary(ZBUFFv07_DCtx* dctx, const void* dict, size_t dictSize);

ZSTDLIBv07_API size_t ZBUFFv07_decompressContinue(ZBUFFv07_DCtx* dctx,
                                            void* dst, size_t* dstCapacityPtr,
                                      const void* src, size_t* srcSizePtr);

/*-***************************************************************************
*  Streaming decompression howto
*
*  A ZBUFFv07_DCtx object is required to track streaming operations.
*  Use ZBUFFv07_createDCtx() and ZBUFFv07_freeDCtx() to create/release resources.
*  Use ZBUFFv07_decompressInit() to start a new decompression operation,
*   or ZBUFFv07_decompressInitDictionary() if decompression requires a dictionary.
*  Note that ZBUFFv07_DCtx objects can be re-init multiple times.
*
*  Use ZBUFFv07_decompressContinue() repetitively to consume your input.
*  *srcSizePtr and *dstCapacityPtr can be any size.
*  The function will report how many bytes were read or written by modifying *srcSizePtr and *dstCapacityPtr.
*  Note that it may not consume the entire input, in which case it's up to the caller to present remaining input again.
*  The content of `dst` will be overwritten (up to *dstCapacityPtr) at each function call, so save its content if it matters, or change `dst`.
*  @return : a hint to preferred nb of bytes to use as input for next function call (it's only a hint, to help latency),
*            or 0 when a frame is completely decoded,
*            or an error code, which can be tested using ZBUFFv07_isError().
*
*  Hint : recommended buffer sizes (not compulsory) : ZBUFFv07_recommendedDInSize() and ZBUFFv07_recommendedDOutSize()
*  output : ZBUFFv07_recommendedDOutSize== 128 KB block size is the internal unit, it ensures it's always possible to write a full block when decoded.
*  input  : ZBUFFv07_recommendedDInSize == 128KB + 3;
*           just follow indications from ZBUFFv07_decompressContinue() to minimize latency. It should always be <= 128 KB + 3 .
* *******************************************************************************/


/* *************************************
*  Tool functions
***************************************/
ZSTDLIBv07_API unsigned ZBUFFv07_isError(size_t errorCode);
ZSTDLIBv07_API const char* ZBUFFv07_getErrorName(size_t errorCode);

/** Functions below provide recommended buffer sizes for Compression or Decompression operations.
*   These sizes are just hints, they tend to offer better latency */
ZSTDLIBv07_API size_t ZBUFFv07_recommendedDInSize(void);
ZSTDLIBv07_API size_t ZBUFFv07_recommendedDOutSize(void);


/*-*************************************
*  Constants
***************************************/
#define ZSTDv07_MAGICNUMBER            0xFD2FB527   /* v0.7 */


#if defined (__cplusplus)
}
#endif

#endif  /* ZSTDv07_H_235446 */
/**** ended inlining zstd_v07.h ****/
#endif

/** ZSTD_isLegacy() :
    @return : > 0 if supported by legacy decoder. 0 otherwise.
              return value is the version.
*/
MEM_STATIC unsigned ZSTD_isLegacy(const void* src, size_t srcSize)
{
    U32 magicNumberLE;
    if (srcSize<4) return 0;
    magicNumberLE = MEM_readLE32(src);
    switch(magicNumberLE)
    {
#if (ZSTD_LEGACY_SUPPORT <= 1)
        case ZSTDv01_magicNumberLE:return 1;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 2)
        case ZSTDv02_magicNumber : return 2;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 3)
        case ZSTDv03_magicNumber : return 3;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 4)
        case ZSTDv04_magicNumber : return 4;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
        case ZSTDv05_MAGICNUMBER : return 5;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
        case ZSTDv06_MAGICNUMBER : return 6;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
        case ZSTDv07_MAGICNUMBER : return 7;
#endif
        default : return 0;
    }
}


MEM_STATIC unsigned long long ZSTD_getDecompressedSize_legacy(const void* src, size_t srcSize)
{
    U32 const version = ZSTD_isLegacy(src, srcSize);
    if (version < 5) return 0;  /* no decompressed size in frame header, or not a legacy format */
#if (ZSTD_LEGACY_SUPPORT <= 5)
    if (version==5) {
        ZSTDv05_parameters fParams;
        size_t const frResult = ZSTDv05_getFrameParams(&fParams, src, srcSize);
        if (frResult != 0) return 0;
        return fParams.srcSize;
    }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
    if (version==6) {
        ZSTDv06_frameParams fParams;
        size_t const frResult = ZSTDv06_getFrameParams(&fParams, src, srcSize);
        if (frResult != 0) return 0;
        return fParams.frameContentSize;
    }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
    if (version==7) {
        ZSTDv07_frameParams fParams;
        size_t const frResult = ZSTDv07_getFrameParams(&fParams, src, srcSize);
        if (frResult != 0) return 0;
        return fParams.frameContentSize;
    }
#endif
    return 0;   /* should not be possible */
}


MEM_STATIC size_t ZSTD_decompressLegacy(
                     void* dst, size_t dstCapacity,
               const void* src, size_t compressedSize,
               const void* dict,size_t dictSize)
{
    U32 const version = ZSTD_isLegacy(src, compressedSize);
    (void)dst; (void)dstCapacity; (void)dict; (void)dictSize;  /* unused when ZSTD_LEGACY_SUPPORT >= 8 */
    switch(version)
    {
#if (ZSTD_LEGACY_SUPPORT <= 1)
        case 1 :
            return ZSTDv01_decompress(dst, dstCapacity, src, compressedSize);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 2)
        case 2 :
            return ZSTDv02_decompress(dst, dstCapacity, src, compressedSize);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 3)
        case 3 :
            return ZSTDv03_decompress(dst, dstCapacity, src, compressedSize);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 4)
        case 4 :
            return ZSTDv04_decompress(dst, dstCapacity, src, compressedSize);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
        case 5 :
            {   size_t result;
                ZSTDv05_DCtx* const zd = ZSTDv05_createDCtx();
                if (zd==NULL) return ERROR(memory_allocation);
                result = ZSTDv05_decompress_usingDict(zd, dst, dstCapacity, src, compressedSize, dict, dictSize);
                ZSTDv05_freeDCtx(zd);
                return result;
            }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
        case 6 :
            {   size_t result;
                ZSTDv06_DCtx* const zd = ZSTDv06_createDCtx();
                if (zd==NULL) return ERROR(memory_allocation);
                result = ZSTDv06_decompress_usingDict(zd, dst, dstCapacity, src, compressedSize, dict, dictSize);
                ZSTDv06_freeDCtx(zd);
                return result;
            }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
        case 7 :
            {   size_t result;
                ZSTDv07_DCtx* const zd = ZSTDv07_createDCtx();
                if (zd==NULL) return ERROR(memory_allocation);
                result = ZSTDv07_decompress_usingDict(zd, dst, dstCapacity, src, compressedSize, dict, dictSize);
                ZSTDv07_freeDCtx(zd);
                return result;
            }
#endif
        default :
            return ERROR(prefix_unknown);
    }
}

MEM_STATIC ZSTD_frameSizeInfo ZSTD_findFrameSizeInfoLegacy(const void *src, size_t srcSize)
{
    ZSTD_frameSizeInfo frameSizeInfo;
    U32 const version = ZSTD_isLegacy(src, srcSize);
    switch(version)
    {
#if (ZSTD_LEGACY_SUPPORT <= 1)
        case 1 :
            ZSTDv01_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 2)
        case 2 :
            ZSTDv02_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 3)
        case 3 :
            ZSTDv03_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 4)
        case 4 :
            ZSTDv04_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
        case 5 :
            ZSTDv05_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
        case 6 :
            ZSTDv06_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
        case 7 :
            ZSTDv07_findFrameSizeInfoLegacy(src, srcSize,
                &frameSizeInfo.compressedSize,
                &frameSizeInfo.decompressedBound);
            break;
#endif
        default :
            frameSizeInfo.compressedSize = ERROR(prefix_unknown);
            frameSizeInfo.decompressedBound = ZSTD_CONTENTSIZE_ERROR;
            break;
    }
    if (!ZSTD_isError(frameSizeInfo.compressedSize) && frameSizeInfo.compressedSize > srcSize) {
        frameSizeInfo.compressedSize = ERROR(srcSize_wrong);
        frameSizeInfo.decompressedBound = ZSTD_CONTENTSIZE_ERROR;
    }
    return frameSizeInfo;
}

MEM_STATIC size_t ZSTD_findFrameCompressedSizeLegacy(const void *src, size_t srcSize)
{
    ZSTD_frameSizeInfo frameSizeInfo = ZSTD_findFrameSizeInfoLegacy(src, srcSize);
    return frameSizeInfo.compressedSize;
}

MEM_STATIC size_t ZSTD_freeLegacyStreamContext(void* legacyContext, U32 version)
{
    switch(version)
    {
        default :
        case 1 :
        case 2 :
        case 3 :
            (void)legacyContext;
            return ERROR(version_unsupported);
#if (ZSTD_LEGACY_SUPPORT <= 4)
        case 4 : return ZBUFFv04_freeDCtx((ZBUFFv04_DCtx*)legacyContext);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
        case 5 : return ZBUFFv05_freeDCtx((ZBUFFv05_DCtx*)legacyContext);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
        case 6 : return ZBUFFv06_freeDCtx((ZBUFFv06_DCtx*)legacyContext);
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
        case 7 : return ZBUFFv07_freeDCtx((ZBUFFv07_DCtx*)legacyContext);
#endif
    }
}


MEM_STATIC size_t ZSTD_initLegacyStream(void** legacyContext, U32 prevVersion, U32 newVersion,
                                        const void* dict, size_t dictSize)
{
    DEBUGLOG(5, "ZSTD_initLegacyStream for v0.%u", newVersion);
    if (prevVersion != newVersion) ZSTD_freeLegacyStreamContext(*legacyContext, prevVersion);
    switch(newVersion)
    {
        default :
        case 1 :
        case 2 :
        case 3 :
            (void)dict; (void)dictSize;
            return 0;
#if (ZSTD_LEGACY_SUPPORT <= 4)
        case 4 :
        {
            ZBUFFv04_DCtx* dctx = (prevVersion != newVersion) ? ZBUFFv04_createDCtx() : (ZBUFFv04_DCtx*)*legacyContext;
            if (dctx==NULL) return ERROR(memory_allocation);
            ZBUFFv04_decompressInit(dctx);
            ZBUFFv04_decompressWithDictionary(dctx, dict, dictSize);
            *legacyContext = dctx;
            return 0;
        }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
        case 5 :
        {
            ZBUFFv05_DCtx* dctx = (prevVersion != newVersion) ? ZBUFFv05_createDCtx() : (ZBUFFv05_DCtx*)*legacyContext;
            if (dctx==NULL) return ERROR(memory_allocation);
            ZBUFFv05_decompressInitDictionary(dctx, dict, dictSize);
            *legacyContext = dctx;
            return 0;
        }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
        case 6 :
        {
            ZBUFFv06_DCtx* dctx = (prevVersion != newVersion) ? ZBUFFv06_createDCtx() : (ZBUFFv06_DCtx*)*legacyContext;
            if (dctx==NULL) return ERROR(memory_allocation);
            ZBUFFv06_decompressInitDictionary(dctx, dict, dictSize);
            *legacyContext = dctx;
            return 0;
        }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
        case 7 :
        {
            ZBUFFv07_DCtx* dctx = (prevVersion != newVersion) ? ZBUFFv07_createDCtx() : (ZBUFFv07_DCtx*)*legacyContext;
            if (dctx==NULL) return ERROR(memory_allocation);
            ZBUFFv07_decompressInitDictionary(dctx, dict, dictSize);
            *legacyContext = dctx;
            return 0;
        }
#endif
    }
}



MEM_STATIC size_t ZSTD_decompressLegacyStream(void* legacyContext, U32 version,
                                              ZSTD_outBuffer* output, ZSTD_inBuffer* input)
{
    DEBUGLOG(5, "ZSTD_decompressLegacyStream for v0.%u", version);
    switch(version)
    {
        default :
        case 1 :
        case 2 :
        case 3 :
            (void)legacyContext; (void)output; (void)input;
            return ERROR(version_unsupported);
#if (ZSTD_LEGACY_SUPPORT <= 4)
        case 4 :
            {
                ZBUFFv04_DCtx* dctx = (ZBUFFv04_DCtx*) legacyContext;
                const void* src = (const char*)input->src + input->pos;
                size_t readSize = input->size - input->pos;
                void* dst = (char*)output->dst + output->pos;
                size_t decodedSize = output->size - output->pos;
                size_t const hintSize = ZBUFFv04_decompressContinue(dctx, dst, &decodedSize, src, &readSize);
                output->pos += decodedSize;
                input->pos += readSize;
                return hintSize;
            }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 5)
        case 5 :
            {
                ZBUFFv05_DCtx* dctx = (ZBUFFv05_DCtx*) legacyContext;
                const void* src = (const char*)input->src + input->pos;
                size_t readSize = input->size - input->pos;
                void* dst = (char*)output->dst + output->pos;
                size_t decodedSize = output->size - output->pos;
                size_t const hintSize = ZBUFFv05_decompressContinue(dctx, dst, &decodedSize, src, &readSize);
                output->pos += decodedSize;
                input->pos += readSize;
                return hintSize;
            }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 6)
        case 6 :
            {
                ZBUFFv06_DCtx* dctx = (ZBUFFv06_DCtx*) legacyContext;
                const void* src = (const char*)input->src + input->pos;
                size_t readSize = input->size - input->pos;
                void* dst = (char*)output->dst + output->pos;
                size_t decodedSize = output->size - output->pos;
                size_t const hintSize = ZBUFFv06_decompressContinue(dctx, dst, &decodedSize, src, &readSize);
                output->pos += decodedSize;
                input->pos += readSize;
                return hintSize;
            }
#endif
#if (ZSTD_LEGACY_SUPPORT <= 7)
        case 7 :
            {
                ZBUFFv07_DCtx* dctx = (ZBUFFv07_DCtx*) legacyContext;
                const void* src = (const char*)input->src + input->pos;
                size_t readSize = input->size - input->pos;
                void* dst = (char*)output->dst + output->pos;
                size_t decodedSize = output->size - output->pos;
                size_t const hintSize = ZBUFFv07_decompressContinue(dctx, dst, &decodedSize, src, &readSize);
                output->pos += decodedSize;
                input->pos += readSize;
                return hintSize;
            }
#endif
    }
}


#if defined (__cplusplus)
}
#endif

#endif   /* ZSTD_LEGACY_H */
/**** ended inlining ../legacy/zstd_legacy.h ****/
#endif



/*-*******************************************************
*  Types
*********************************************************/
struct ZSTD_DDict_s {
    void* dictBuffer;
    const void* dictContent;
    size_t dictSize;
    ZSTD_entropyDTables_t entropy;
    U32 dictID;
    U32 entropyPresent;
    ZSTD_customMem cMem;
};  /* typedef'd to ZSTD_DDict within "zstd.h" */

const void* ZSTD_DDict_dictContent(const ZSTD_DDict* ddict)
{
    assert(ddict != NULL);
    return ddict->dictContent;
}

size_t ZSTD_DDict_dictSize(const ZSTD_DDict* ddict)
{
    assert(ddict != NULL);
    return ddict->dictSize;
}

void ZSTD_copyDDictParameters(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict)
{
    DEBUGLOG(4, "ZSTD_copyDDictParameters");
    assert(dctx != NULL);
    assert(ddict != NULL);
    dctx->dictID = ddict->dictID;
    dctx->prefixStart = ddict->dictContent;
    dctx->virtualStart = ddict->dictContent;
    dctx->dictEnd = (const BYTE*)ddict->dictContent + ddict->dictSize;
    dctx->previousDstEnd = dctx->dictEnd;
#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
    dctx->dictContentBeginForFuzzing = dctx->prefixStart;
    dctx->dictContentEndForFuzzing = dctx->previousDstEnd;
#endif
    if (ddict->entropyPresent) {
        dctx->litEntropy = 1;
        dctx->fseEntropy = 1;
        dctx->LLTptr = ddict->entropy.LLTable;
        dctx->MLTptr = ddict->entropy.MLTable;
        dctx->OFTptr = ddict->entropy.OFTable;
        dctx->HUFptr = ddict->entropy.hufTable;
        dctx->entropy.rep[0] = ddict->entropy.rep[0];
        dctx->entropy.rep[1] = ddict->entropy.rep[1];
        dctx->entropy.rep[2] = ddict->entropy.rep[2];
    } else {
        dctx->litEntropy = 0;
        dctx->fseEntropy = 0;
    }
}


static size_t
ZSTD_loadEntropy_intoDDict(ZSTD_DDict* ddict,
                           ZSTD_dictContentType_e dictContentType)
{
    ddict->dictID = 0;
    ddict->entropyPresent = 0;
    if (dictContentType == ZSTD_dct_rawContent) return 0;

    if (ddict->dictSize < 8) {
        if (dictContentType == ZSTD_dct_fullDict)
            return ERROR(dictionary_corrupted);   /* only accept specified dictionaries */
        return 0;   /* pure content mode */
    }
    {   U32 const magic = MEM_readLE32(ddict->dictContent);
        if (magic != ZSTD_MAGIC_DICTIONARY) {
            if (dictContentType == ZSTD_dct_fullDict)
                return ERROR(dictionary_corrupted);   /* only accept specified dictionaries */
            return 0;   /* pure content mode */
        }
    }
    ddict->dictID = MEM_readLE32((const char*)ddict->dictContent + ZSTD_FRAMEIDSIZE);

    /* load entropy tables */
    RETURN_ERROR_IF(ZSTD_isError(ZSTD_loadDEntropy(
            &ddict->entropy, ddict->dictContent, ddict->dictSize)),
        dictionary_corrupted, "");
    ddict->entropyPresent = 1;
    return 0;
}


static size_t ZSTD_initDDict_internal(ZSTD_DDict* ddict,
                                      const void* dict, size_t dictSize,
                                      ZSTD_dictLoadMethod_e dictLoadMethod,
                                      ZSTD_dictContentType_e dictContentType)
{
    if ((dictLoadMethod == ZSTD_dlm_byRef) || (!dict) || (!dictSize)) {
        ddict->dictBuffer = NULL;
        ddict->dictContent = dict;
        if (!dict) dictSize = 0;
    } else {
        void* const internalBuffer = ZSTD_malloc(dictSize, ddict->cMem);
        ddict->dictBuffer = internalBuffer;
        ddict->dictContent = internalBuffer;
        if (!internalBuffer) return ERROR(memory_allocation);
        memcpy(internalBuffer, dict, dictSize);
    }
    ddict->dictSize = dictSize;
    ddict->entropy.hufTable[0] = (HUF_DTable)((HufLog)*0x1000001);  /* cover both little and big endian */

    /* parse dictionary content */
    FORWARD_IF_ERROR( ZSTD_loadEntropy_intoDDict(ddict, dictContentType) , "");

    return 0;
}

ZSTD_DDict* ZSTD_createDDict_advanced(const void* dict, size_t dictSize,
                                      ZSTD_dictLoadMethod_e dictLoadMethod,
                                      ZSTD_dictContentType_e dictContentType,
                                      ZSTD_customMem customMem)
{
    if (!customMem.customAlloc ^ !customMem.customFree) return NULL;

    {   ZSTD_DDict* const ddict = (ZSTD_DDict*) ZSTD_malloc(sizeof(ZSTD_DDict), customMem);
        if (ddict == NULL) return NULL;
        ddict->cMem = customMem;
        {   size_t const initResult = ZSTD_initDDict_internal(ddict,
                                            dict, dictSize,
                                            dictLoadMethod, dictContentType);
            if (ZSTD_isError(initResult)) {
                ZSTD_freeDDict(ddict);
                return NULL;
        }   }
        return ddict;
    }
}

/*! ZSTD_createDDict() :
*   Create a digested dictionary, to start decompression without startup delay.
*   `dict` content is copied inside DDict.
*   Consequently, `dict` can be released after `ZSTD_DDict` creation */
ZSTD_DDict* ZSTD_createDDict(const void* dict, size_t dictSize)
{
    ZSTD_customMem const allocator = { NULL, NULL, NULL };
    return ZSTD_createDDict_advanced(dict, dictSize, ZSTD_dlm_byCopy, ZSTD_dct_auto, allocator);
}

/*! ZSTD_createDDict_byReference() :
 *  Create a digested dictionary, to start decompression without startup delay.
 *  Dictionary content is simply referenced, it will be accessed during decompression.
 *  Warning : dictBuffer must outlive DDict (DDict must be freed before dictBuffer) */
ZSTD_DDict* ZSTD_createDDict_byReference(const void* dictBuffer, size_t dictSize)
{
    ZSTD_customMem const allocator = { NULL, NULL, NULL };
    return ZSTD_createDDict_advanced(dictBuffer, dictSize, ZSTD_dlm_byRef, ZSTD_dct_auto, allocator);
}


const ZSTD_DDict* ZSTD_initStaticDDict(
                                void* sBuffer, size_t sBufferSize,
                                const void* dict, size_t dictSize,
                                ZSTD_dictLoadMethod_e dictLoadMethod,
                                ZSTD_dictContentType_e dictContentType)
{
    size_t const neededSpace = sizeof(ZSTD_DDict)
                             + (dictLoadMethod == ZSTD_dlm_byRef ? 0 : dictSize);
    ZSTD_DDict* const ddict = (ZSTD_DDict*)sBuffer;
    assert(sBuffer != NULL);
    assert(dict != NULL);
    if ((size_t)sBuffer & 7) return NULL;   /* 8-aligned */
    if (sBufferSize < neededSpace) return NULL;
    if (dictLoadMethod == ZSTD_dlm_byCopy) {
        memcpy(ddict+1, dict, dictSize);  /* local copy */
        dict = ddict+1;
    }
    if (ZSTD_isError( ZSTD_initDDict_internal(ddict,
                                              dict, dictSize,
                                              ZSTD_dlm_byRef, dictContentType) ))
        return NULL;
    return ddict;
}


size_t ZSTD_freeDDict(ZSTD_DDict* ddict)
{
    if (ddict==NULL) return 0;   /* support free on NULL */
    {   ZSTD_customMem const cMem = ddict->cMem;
        ZSTD_free(ddict->dictBuffer, cMem);
        ZSTD_free(ddict, cMem);
        return 0;
    }
}

/*! ZSTD_estimateDDictSize() :
 *  Estimate amount of memory that will be needed to create a dictionary for decompression.
 *  Note : dictionary created by reference using ZSTD_dlm_byRef are smaller */
size_t ZSTD_estimateDDictSize(size_t dictSize, ZSTD_dictLoadMethod_e dictLoadMethod)
{
    return sizeof(ZSTD_DDict) + (dictLoadMethod == ZSTD_dlm_byRef ? 0 : dictSize);
}

size_t ZSTD_sizeof_DDict(const ZSTD_DDict* ddict)
{
    if (ddict==NULL) return 0;   /* support sizeof on NULL */
    return sizeof(*ddict) + (ddict->dictBuffer ? ddict->dictSize : 0) ;
}

/*! ZSTD_getDictID_fromDDict() :
 *  Provides the dictID of the dictionary loaded into `ddict`.
 *  If @return == 0, the dictionary is not conformant to Zstandard specification, or empty.
 *  Non-conformant dictionaries can still be loaded, but as content-only dictionaries. */
unsigned ZSTD_getDictID_fromDDict(const ZSTD_DDict* ddict)
{
    if (ddict==NULL) return 0;
    return ZSTD_getDictID_fromDict(ddict->dictContent, ddict->dictSize);
}
/**** ended inlining decompress/zstd_ddict.c ****/
/**** start inlining decompress/zstd_decompress.c ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */


/* ***************************************************************
*  Tuning parameters
*****************************************************************/
/*!
 * HEAPMODE :
 * Select how default decompression function ZSTD_decompress() allocates its context,
 * on stack (0), or into heap (1, default; requires malloc()).
 * Note that functions with explicit context such as ZSTD_decompressDCtx() are unaffected.
 */
#ifndef ZSTD_HEAPMODE
#  define ZSTD_HEAPMODE 1
#endif

/*!
*  LEGACY_SUPPORT :
*  if set to 1+, ZSTD_decompress() can decode older formats (v0.1+)
*/
#ifndef ZSTD_LEGACY_SUPPORT
#  define ZSTD_LEGACY_SUPPORT 0
#endif

/*!
 *  MAXWINDOWSIZE_DEFAULT :
 *  maximum window size accepted by DStream __by default__.
 *  Frames requiring more memory will be rejected.
 *  It's possible to set a different limit using ZSTD_DCtx_setMaxWindowSize().
 */
#ifndef ZSTD_MAXWINDOWSIZE_DEFAULT
#  define ZSTD_MAXWINDOWSIZE_DEFAULT (((U32)1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT) + 1)
#endif

/*!
 *  NO_FORWARD_PROGRESS_MAX :
 *  maximum allowed nb of calls to ZSTD_decompressStream()
 *  without any forward progress
 *  (defined as: no byte read from input, and no byte flushed to output)
 *  before triggering an error.
 */
#ifndef ZSTD_NO_FORWARD_PROGRESS_MAX
#  define ZSTD_NO_FORWARD_PROGRESS_MAX 16
#endif


/*-*******************************************************
*  Dependencies
*********************************************************/
/**** skipping file: ../common/cpu.h ****/
/**** skipping file: ../common/mem.h ****/
#define FSE_STATIC_LINKING_ONLY
/**** skipping file: ../common/fse.h ****/
#define HUF_STATIC_LINKING_ONLY
/**** skipping file: ../common/huf.h ****/
/**** skipping file: ../common/zstd_internal.h ****/
/**** skipping file: zstd_decompress_internal.h ****/
/**** skipping file: zstd_ddict.h ****/
/**** start inlining zstd_decompress_block.h ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */


#ifndef ZSTD_DEC_BLOCK_H
#define ZSTD_DEC_BLOCK_H

/*-*******************************************************
 *  Dependencies
 *********************************************************/
#include <stddef.h>   /* size_t */
/**** skipping file: ../zstd.h ****/
/**** skipping file: ../common/zstd_internal.h ****/
/**** skipping file: zstd_decompress_internal.h ****/


/* ===   Prototypes   === */

/* note: prototypes already published within `zstd.h` :
 * ZSTD_decompressBlock()
 */

/* note: prototypes already published within `zstd_internal.h` :
 * ZSTD_getcBlockSize()
 * ZSTD_decodeSeqHeaders()
 */


/* ZSTD_decompressBlock_internal() :
 * decompress block, starting at `src`,
 * into destination buffer `dst`.
 * @return : decompressed block size,
 *           or an error code (which can be tested using ZSTD_isError())
 */
size_t ZSTD_decompressBlock_internal(ZSTD_DCtx* dctx,
                               void* dst, size_t dstCapacity,
                         const void* src, size_t srcSize, const int frame);

/* ZSTD_buildFSETable() :
 * generate FSE decoding table for one symbol (ll, ml or off)
 * this function must be called with valid parameters only
 * (dt is large enough, normalizedCounter distribution total is a power of 2, max is within range, etc.)
 * in which case it cannot fail.
 * Internal use only.
 */
void ZSTD_buildFSETable(ZSTD_seqSymbol* dt,
             const short* normalizedCounter, unsigned maxSymbolValue,
             const U32* baseValue, const U32* nbAdditionalBits,
                   unsigned tableLog);


#endif /* ZSTD_DEC_BLOCK_H */
/**** ended inlining zstd_decompress_block.h ****/

#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT>=1)
/**** skipping file: ../legacy/zstd_legacy.h ****/
#endif


/*-*************************************************************
*   Context management
***************************************************************/
size_t ZSTD_sizeof_DCtx (const ZSTD_DCtx* dctx)
{
    if (dctx==NULL) return 0;   /* support sizeof NULL */
    return sizeof(*dctx)
           + ZSTD_sizeof_DDict(dctx->ddictLocal)
           + dctx->inBuffSize + dctx->outBuffSize;
}

size_t ZSTD_estimateDCtxSize(void) { return sizeof(ZSTD_DCtx); }


static size_t ZSTD_startingInputLength(ZSTD_format_e format)
{
    size_t const startingInputLength = ZSTD_FRAMEHEADERSIZE_PREFIX(format);
    /* only supports formats ZSTD_f_zstd1 and ZSTD_f_zstd1_magicless */
    assert( (format == ZSTD_f_zstd1) || (format == ZSTD_f_zstd1_magicless) );
    return startingInputLength;
}

static void ZSTD_initDCtx_internal(ZSTD_DCtx* dctx)
{
    dctx->format = ZSTD_f_zstd1;  /* ZSTD_decompressBegin() invokes ZSTD_startingInputLength() with argument dctx->format */
    dctx->staticSize  = 0;
    dctx->maxWindowSize = ZSTD_MAXWINDOWSIZE_DEFAULT;
    dctx->ddict       = NULL;
    dctx->ddictLocal  = NULL;
    dctx->dictEnd     = NULL;
    dctx->ddictIsCold = 0;
    dctx->dictUses = ZSTD_dont_use;
    dctx->inBuff      = NULL;
    dctx->inBuffSize  = 0;
    dctx->outBuffSize = 0;
    dctx->streamStage = zdss_init;
    dctx->legacyContext = NULL;
    dctx->previousLegacyVersion = 0;
    dctx->noForwardProgress = 0;
    dctx->oversizedDuration = 0;
    dctx->bmi2 = ZSTD_cpuid_bmi2(ZSTD_cpuid());
    dctx->outBufferMode = ZSTD_obm_buffered;
#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
    dctx->dictContentEndForFuzzing = NULL;
#endif
}

ZSTD_DCtx* ZSTD_initStaticDCtx(void *workspace, size_t workspaceSize)
{
    ZSTD_DCtx* const dctx = (ZSTD_DCtx*) workspace;

    if ((size_t)workspace & 7) return NULL;  /* 8-aligned */
    if (workspaceSize < sizeof(ZSTD_DCtx)) return NULL;  /* minimum size */

    ZSTD_initDCtx_internal(dctx);
    dctx->staticSize = workspaceSize;
    dctx->inBuff = (char*)(dctx+1);
    return dctx;
}

ZSTD_DCtx* ZSTD_createDCtx_advanced(ZSTD_customMem customMem)
{
    if (!customMem.customAlloc ^ !customMem.customFree) return NULL;

    {   ZSTD_DCtx* const dctx = (ZSTD_DCtx*)ZSTD_malloc(sizeof(*dctx), customMem);
        if (!dctx) return NULL;
        dctx->customMem = customMem;
        ZSTD_initDCtx_internal(dctx);
        return dctx;
    }
}

ZSTD_DCtx* ZSTD_createDCtx(void)
{
    DEBUGLOG(3, "ZSTD_createDCtx");
    return ZSTD_createDCtx_advanced(ZSTD_defaultCMem);
}

static void ZSTD_clearDict(ZSTD_DCtx* dctx)
{
    ZSTD_freeDDict(dctx->ddictLocal);
    dctx->ddictLocal = NULL;
    dctx->ddict = NULL;
    dctx->dictUses = ZSTD_dont_use;
}

size_t ZSTD_freeDCtx(ZSTD_DCtx* dctx)
{
    if (dctx==NULL) return 0;   /* support free on NULL */
    RETURN_ERROR_IF(dctx->staticSize, memory_allocation, "not compatible with static DCtx");
    {   ZSTD_customMem const cMem = dctx->customMem;
        ZSTD_clearDict(dctx);
        ZSTD_free(dctx->inBuff, cMem);
        dctx->inBuff = NULL;
#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT >= 1)
        if (dctx->legacyContext)
            ZSTD_freeLegacyStreamContext(dctx->legacyContext, dctx->previousLegacyVersion);
#endif
        ZSTD_free(dctx, cMem);
        return 0;
    }
}

/* no longer useful */
void ZSTD_copyDCtx(ZSTD_DCtx* dstDCtx, const ZSTD_DCtx* srcDCtx)
{
    size_t const toCopy = (size_t)((char*)(&dstDCtx->inBuff) - (char*)dstDCtx);
    memcpy(dstDCtx, srcDCtx, toCopy);  /* no need to copy workspace */
}


/*-*************************************************************
 *   Frame header decoding
 ***************************************************************/

/*! ZSTD_isFrame() :
 *  Tells if the content of `buffer` starts with a valid Frame Identifier.
 *  Note : Frame Identifier is 4 bytes. If `size < 4`, @return will always be 0.
 *  Note 2 : Legacy Frame Identifiers are considered valid only if Legacy Support is enabled.
 *  Note 3 : Skippable Frame Identifiers are considered valid. */
unsigned ZSTD_isFrame(const void* buffer, size_t size)
{
    if (size < ZSTD_FRAMEIDSIZE) return 0;
    {   U32 const magic = MEM_readLE32(buffer);
        if (magic == ZSTD_MAGICNUMBER) return 1;
        if ((magic & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) return 1;
    }
#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT >= 1)
    if (ZSTD_isLegacy(buffer, size)) return 1;
#endif
    return 0;
}

/** ZSTD_frameHeaderSize_internal() :
 *  srcSize must be large enough to reach header size fields.
 *  note : only works for formats ZSTD_f_zstd1 and ZSTD_f_zstd1_magicless.
 * @return : size of the Frame Header
 *           or an error code, which can be tested with ZSTD_isError() */
static size_t ZSTD_frameHeaderSize_internal(const void* src, size_t srcSize, ZSTD_format_e format)
{
    size_t const minInputSize = ZSTD_startingInputLength(format);
    RETURN_ERROR_IF(srcSize < minInputSize, srcSize_wrong, "");

    {   BYTE const fhd = ((const BYTE*)src)[minInputSize-1];
        U32 const dictID= fhd & 3;
        U32 const singleSegment = (fhd >> 5) & 1;
        U32 const fcsId = fhd >> 6;
        return minInputSize + !singleSegment
             + ZSTD_did_fieldSize[dictID] + ZSTD_fcs_fieldSize[fcsId]
             + (singleSegment && !fcsId);
    }
}

/** ZSTD_frameHeaderSize() :
 *  srcSize must be >= ZSTD_frameHeaderSize_prefix.
 * @return : size of the Frame Header,
 *           or an error code (if srcSize is too small) */
size_t ZSTD_frameHeaderSize(const void* src, size_t srcSize)
{
    return ZSTD_frameHeaderSize_internal(src, srcSize, ZSTD_f_zstd1);
}


/** ZSTD_getFrameHeader_advanced() :
 *  decode Frame Header, or require larger `srcSize`.
 *  note : only works for formats ZSTD_f_zstd1 and ZSTD_f_zstd1_magicless
 * @return : 0, `zfhPtr` is correctly filled,
 *          >0, `srcSize` is too small, value is wanted `srcSize` amount,
 *           or an error code, which can be tested using ZSTD_isError() */
size_t ZSTD_getFrameHeader_advanced(ZSTD_frameHeader* zfhPtr, const void* src, size_t srcSize, ZSTD_format_e format)
{
    const BYTE* ip = (const BYTE*)src;
    size_t const minInputSize = ZSTD_startingInputLength(format);

    memset(zfhPtr, 0, sizeof(*zfhPtr));   /* not strictly necessary, but static analyzer do not understand that zfhPtr is only going to be read only if return value is zero, since they are 2 different signals */
    if (srcSize < minInputSize) return minInputSize;
    RETURN_ERROR_IF(src==NULL, GENERIC, "invalid parameter");

    if ( (format != ZSTD_f_zstd1_magicless)
      && (MEM_readLE32(src) != ZSTD_MAGICNUMBER) ) {
        if ((MEM_readLE32(src) & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
            /* skippable frame */
            if (srcSize < ZSTD_SKIPPABLEHEADERSIZE)
                return ZSTD_SKIPPABLEHEADERSIZE; /* magic number + frame length */
            memset(zfhPtr, 0, sizeof(*zfhPtr));
            zfhPtr->frameContentSize = MEM_readLE32((const char *)src + ZSTD_FRAMEIDSIZE);
            zfhPtr->frameType = ZSTD_skippableFrame;
            return 0;
        }
        RETURN_ERROR(prefix_unknown, "");
    }

    /* ensure there is enough `srcSize` to fully read/decode frame header */
    {   size_t const fhsize = ZSTD_frameHeaderSize_internal(src, srcSize, format);
        if (srcSize < fhsize) return fhsize;
        zfhPtr->headerSize = (U32)fhsize;
    }

    {   BYTE const fhdByte = ip[minInputSize-1];
        size_t pos = minInputSize;
        U32 const dictIDSizeCode = fhdByte&3;
        U32 const checksumFlag = (fhdByte>>2)&1;
        U32 const singleSegment = (fhdByte>>5)&1;
        U32 const fcsID = fhdByte>>6;
        U64 windowSize = 0;
        U32 dictID = 0;
        U64 frameContentSize = ZSTD_CONTENTSIZE_UNKNOWN;
        RETURN_ERROR_IF((fhdByte & 0x08) != 0, frameParameter_unsupported,
                        "reserved bits, must be zero");

        if (!singleSegment) {
            BYTE const wlByte = ip[pos++];
            U32 const windowLog = (wlByte >> 3) + ZSTD_WINDOWLOG_ABSOLUTEMIN;
            RETURN_ERROR_IF(windowLog > ZSTD_WINDOWLOG_MAX, frameParameter_windowTooLarge, "");
            windowSize = (1ULL << windowLog);
            windowSize += (windowSize >> 3) * (wlByte&7);
        }
        switch(dictIDSizeCode)
        {
            default: assert(0);  /* impossible */
            case 0 : break;
            case 1 : dictID = ip[pos]; pos++; break;
            case 2 : dictID = MEM_readLE16(ip+pos); pos+=2; break;
            case 3 : dictID = MEM_readLE32(ip+pos); pos+=4; break;
        }
        switch(fcsID)
        {
            default: assert(0);  /* impossible */
            case 0 : if (singleSegment) frameContentSize = ip[pos]; break;
            case 1 : frameContentSize = MEM_readLE16(ip+pos)+256; break;
            case 2 : frameContentSize = MEM_readLE32(ip+pos); break;
            case 3 : frameContentSize = MEM_readLE64(ip+pos); break;
        }
        if (singleSegment) windowSize = frameContentSize;

        zfhPtr->frameType = ZSTD_frame;
        zfhPtr->frameContentSize = frameContentSize;
        zfhPtr->windowSize = windowSize;
        zfhPtr->blockSizeMax = (unsigned) MIN(windowSize, ZSTD_BLOCKSIZE_MAX);
        zfhPtr->dictID = dictID;
        zfhPtr->checksumFlag = checksumFlag;
    }
    return 0;
}

/** ZSTD_getFrameHeader() :
 *  decode Frame Header, or require larger `srcSize`.
 *  note : this function does not consume input, it only reads it.
 * @return : 0, `zfhPtr` is correctly filled,
 *          >0, `srcSize` is too small, value is wanted `srcSize` amount,
 *           or an error code, which can be tested using ZSTD_isError() */
size_t ZSTD_getFrameHeader(ZSTD_frameHeader* zfhPtr, const void* src, size_t srcSize)
{
    return ZSTD_getFrameHeader_advanced(zfhPtr, src, srcSize, ZSTD_f_zstd1);
}


/** ZSTD_getFrameContentSize() :
 *  compatible with legacy mode
 * @return : decompressed size of the single frame pointed to be `src` if known, otherwise
 *         - ZSTD_CONTENTSIZE_UNKNOWN if the size cannot be determined
 *         - ZSTD_CONTENTSIZE_ERROR if an error occurred (e.g. invalid magic number, srcSize too small) */
unsigned long long ZSTD_getFrameContentSize(const void *src, size_t srcSize)
{
#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT >= 1)
    if (ZSTD_isLegacy(src, srcSize)) {
        unsigned long long const ret = ZSTD_getDecompressedSize_legacy(src, srcSize);
        return ret == 0 ? ZSTD_CONTENTSIZE_UNKNOWN : ret;
    }
#endif
    {   ZSTD_frameHeader zfh;
        if (ZSTD_getFrameHeader(&zfh, src, srcSize) != 0)
            return ZSTD_CONTENTSIZE_ERROR;
        if (zfh.frameType == ZSTD_skippableFrame) {
            return 0;
        } else {
            return zfh.frameContentSize;
    }   }
}

static size_t readSkippableFrameSize(void const* src, size_t srcSize)
{
    size_t const skippableHeaderSize = ZSTD_SKIPPABLEHEADERSIZE;
    U32 sizeU32;

    RETURN_ERROR_IF(srcSize < ZSTD_SKIPPABLEHEADERSIZE, srcSize_wrong, "");

    sizeU32 = MEM_readLE32((BYTE const*)src + ZSTD_FRAMEIDSIZE);
    RETURN_ERROR_IF((U32)(sizeU32 + ZSTD_SKIPPABLEHEADERSIZE) < sizeU32,
                    frameParameter_unsupported, "");
    {
        size_t const skippableSize = skippableHeaderSize + sizeU32;
        RETURN_ERROR_IF(skippableSize > srcSize, srcSize_wrong, "");
        return skippableSize;
    }
}

/** ZSTD_findDecompressedSize() :
 *  compatible with legacy mode
 *  `srcSize` must be the exact length of some number of ZSTD compressed and/or
 *      skippable frames
 *  @return : decompressed size of the frames contained */
unsigned long long ZSTD_findDecompressedSize(const void* src, size_t srcSize)
{
    unsigned long long totalDstSize = 0;

    while (srcSize >= ZSTD_startingInputLength(ZSTD_f_zstd1)) {
        U32 const magicNumber = MEM_readLE32(src);

        if ((magicNumber & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
            size_t const skippableSize = readSkippableFrameSize(src, srcSize);
            if (ZSTD_isError(skippableSize)) {
                return ZSTD_CONTENTSIZE_ERROR;
            }
            assert(skippableSize <= srcSize);

            src = (const BYTE *)src + skippableSize;
            srcSize -= skippableSize;
            continue;
        }

        {   unsigned long long const ret = ZSTD_getFrameContentSize(src, srcSize);
            if (ret >= ZSTD_CONTENTSIZE_ERROR) return ret;

            /* check for overflow */
            if (totalDstSize + ret < totalDstSize) return ZSTD_CONTENTSIZE_ERROR;
            totalDstSize += ret;
        }
        {   size_t const frameSrcSize = ZSTD_findFrameCompressedSize(src, srcSize);
            if (ZSTD_isError(frameSrcSize)) {
                return ZSTD_CONTENTSIZE_ERROR;
            }

            src = (const BYTE *)src + frameSrcSize;
            srcSize -= frameSrcSize;
        }
    }  /* while (srcSize >= ZSTD_frameHeaderSize_prefix) */

    if (srcSize) return ZSTD_CONTENTSIZE_ERROR;

    return totalDstSize;
}

/** ZSTD_getDecompressedSize() :
 *  compatible with legacy mode
 * @return : decompressed size if known, 0 otherwise
             note : 0 can mean any of the following :
                   - frame content is empty
                   - decompressed size field is not present in frame header
                   - frame header unknown / not supported
                   - frame header not complete (`srcSize` too small) */
unsigned long long ZSTD_getDecompressedSize(const void* src, size_t srcSize)
{
    unsigned long long const ret = ZSTD_getFrameContentSize(src, srcSize);
    ZSTD_STATIC_ASSERT(ZSTD_CONTENTSIZE_ERROR < ZSTD_CONTENTSIZE_UNKNOWN);
    return (ret >= ZSTD_CONTENTSIZE_ERROR) ? 0 : ret;
}


/** ZSTD_decodeFrameHeader() :
 * `headerSize` must be the size provided by ZSTD_frameHeaderSize().
 * @return : 0 if success, or an error code, which can be tested using ZSTD_isError() */
static size_t ZSTD_decodeFrameHeader(ZSTD_DCtx* dctx, const void* src, size_t headerSize)
{
    size_t const result = ZSTD_getFrameHeader_advanced(&(dctx->fParams), src, headerSize, dctx->format);
    if (ZSTD_isError(result)) return result;    /* invalid header */
    RETURN_ERROR_IF(result>0, srcSize_wrong, "headerSize too small");
#ifndef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
    /* Skip the dictID check in fuzzing mode, because it makes the search
     * harder.
     */
    RETURN_ERROR_IF(dctx->fParams.dictID && (dctx->dictID != dctx->fParams.dictID),
                    dictionary_wrong, "");
#endif
    if (dctx->fParams.checksumFlag) XXH64_reset(&dctx->xxhState, 0);
    return 0;
}

static ZSTD_frameSizeInfo ZSTD_errorFrameSizeInfo(size_t ret)
{
    ZSTD_frameSizeInfo frameSizeInfo;
    frameSizeInfo.compressedSize = ret;
    frameSizeInfo.decompressedBound = ZSTD_CONTENTSIZE_ERROR;
    return frameSizeInfo;
}

static ZSTD_frameSizeInfo ZSTD_findFrameSizeInfo(const void* src, size_t srcSize)
{
    ZSTD_frameSizeInfo frameSizeInfo;
    memset(&frameSizeInfo, 0, sizeof(ZSTD_frameSizeInfo));

#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT >= 1)
    if (ZSTD_isLegacy(src, srcSize))
        return ZSTD_findFrameSizeInfoLegacy(src, srcSize);
#endif

    if ((srcSize >= ZSTD_SKIPPABLEHEADERSIZE)
        && (MEM_readLE32(src) & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
        frameSizeInfo.compressedSize = readSkippableFrameSize(src, srcSize);
        assert(ZSTD_isError(frameSizeInfo.compressedSize) ||
               frameSizeInfo.compressedSize <= srcSize);
        return frameSizeInfo;
    } else {
        const BYTE* ip = (const BYTE*)src;
        const BYTE* const ipstart = ip;
        size_t remainingSize = srcSize;
        size_t nbBlocks = 0;
        ZSTD_frameHeader zfh;

        /* Extract Frame Header */
        {   size_t const ret = ZSTD_getFrameHeader(&zfh, src, srcSize);
            if (ZSTD_isError(ret))
                return ZSTD_errorFrameSizeInfo(ret);
            if (ret > 0)
                return ZSTD_errorFrameSizeInfo(ERROR(srcSize_wrong));
        }

        ip += zfh.headerSize;
        remainingSize -= zfh.headerSize;

        /* Iterate over each block */
        while (1) {
            blockProperties_t blockProperties;
            size_t const cBlockSize = ZSTD_getcBlockSize(ip, remainingSize, &blockProperties);
            if (ZSTD_isError(cBlockSize))
                return ZSTD_errorFrameSizeInfo(cBlockSize);

            if (ZSTD_blockHeaderSize + cBlockSize > remainingSize)
                return ZSTD_errorFrameSizeInfo(ERROR(srcSize_wrong));

            ip += ZSTD_blockHeaderSize + cBlockSize;
            remainingSize -= ZSTD_blockHeaderSize + cBlockSize;
            nbBlocks++;

            if (blockProperties.lastBlock) break;
        }

        /* Final frame content checksum */
        if (zfh.checksumFlag) {
            if (remainingSize < 4)
                return ZSTD_errorFrameSizeInfo(ERROR(srcSize_wrong));
            ip += 4;
        }

        frameSizeInfo.compressedSize = ip - ipstart;
        frameSizeInfo.decompressedBound = (zfh.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN)
                                        ? zfh.frameContentSize
                                        : nbBlocks * zfh.blockSizeMax;
        return frameSizeInfo;
    }
}

/** ZSTD_findFrameCompressedSize() :
 *  compatible with legacy mode
 *  `src` must point to the start of a ZSTD frame, ZSTD legacy frame, or skippable frame
 *  `srcSize` must be at least as large as the frame contained
 *  @return : the compressed size of the frame starting at `src` */
size_t ZSTD_findFrameCompressedSize(const void *src, size_t srcSize)
{
    ZSTD_frameSizeInfo const frameSizeInfo = ZSTD_findFrameSizeInfo(src, srcSize);
    return frameSizeInfo.compressedSize;
}

/** ZSTD_decompressBound() :
 *  compatible with legacy mode
 *  `src` must point to the start of a ZSTD frame or a skippeable frame
 *  `srcSize` must be at least as large as the frame contained
 *  @return : the maximum decompressed size of the compressed source
 */
unsigned long long ZSTD_decompressBound(const void* src, size_t srcSize)
{
    unsigned long long bound = 0;
    /* Iterate over each frame */
    while (srcSize > 0) {
        ZSTD_frameSizeInfo const frameSizeInfo = ZSTD_findFrameSizeInfo(src, srcSize);
        size_t const compressedSize = frameSizeInfo.compressedSize;
        unsigned long long const decompressedBound = frameSizeInfo.decompressedBound;
        if (ZSTD_isError(compressedSize) || decompressedBound == ZSTD_CONTENTSIZE_ERROR)
            return ZSTD_CONTENTSIZE_ERROR;
        assert(srcSize >= compressedSize);
        src = (const BYTE*)src + compressedSize;
        srcSize -= compressedSize;
        bound += decompressedBound;
    }
    return bound;
}


/*-*************************************************************
 *   Frame decoding
 ***************************************************************/

/** ZSTD_insertBlock() :
 *  insert `src` block into `dctx` history. Useful to track uncompressed blocks. */
size_t ZSTD_insertBlock(ZSTD_DCtx* dctx, const void* blockStart, size_t blockSize)
{
    DEBUGLOG(5, "ZSTD_insertBlock: %u bytes", (unsigned)blockSize);
    ZSTD_checkContinuity(dctx, blockStart);
    dctx->previousDstEnd = (const char*)blockStart + blockSize;
    return blockSize;
}


static size_t ZSTD_copyRawBlock(void* dst, size_t dstCapacity,
                          const void* src, size_t srcSize)
{
    DEBUGLOG(5, "ZSTD_copyRawBlock");
    if (dst == NULL) {
        if (srcSize == 0) return 0;
        RETURN_ERROR(dstBuffer_null, "");
    }
    RETURN_ERROR_IF(srcSize > dstCapacity, dstSize_tooSmall, "");
    memcpy(dst, src, srcSize);
    return srcSize;
}

static size_t ZSTD_setRleBlock(void* dst, size_t dstCapacity,
                               BYTE b,
                               size_t regenSize)
{
    if (dst == NULL) {
        if (regenSize == 0) return 0;
        RETURN_ERROR(dstBuffer_null, "");
    }
    RETURN_ERROR_IF(regenSize > dstCapacity, dstSize_tooSmall, "");
    memset(dst, b, regenSize);
    return regenSize;
}


/*! ZSTD_decompressFrame() :
 * @dctx must be properly initialized
 *  will update *srcPtr and *srcSizePtr,
 *  to make *srcPtr progress by one frame. */
static size_t ZSTD_decompressFrame(ZSTD_DCtx* dctx,
                                   void* dst, size_t dstCapacity,
                             const void** srcPtr, size_t *srcSizePtr)
{
    const BYTE* ip = (const BYTE*)(*srcPtr);
    BYTE* const ostart = (BYTE* const)dst;
    BYTE* const oend = dstCapacity != 0 ? ostart + dstCapacity : ostart;
    BYTE* op = ostart;
    size_t remainingSrcSize = *srcSizePtr;

    DEBUGLOG(4, "ZSTD_decompressFrame (srcSize:%i)", (int)*srcSizePtr);

    /* check */
    RETURN_ERROR_IF(
        remainingSrcSize < ZSTD_FRAMEHEADERSIZE_MIN(dctx->format)+ZSTD_blockHeaderSize,
        srcSize_wrong, "");

    /* Frame Header */
    {   size_t const frameHeaderSize = ZSTD_frameHeaderSize_internal(
                ip, ZSTD_FRAMEHEADERSIZE_PREFIX(dctx->format), dctx->format);
        if (ZSTD_isError(frameHeaderSize)) return frameHeaderSize;
        RETURN_ERROR_IF(remainingSrcSize < frameHeaderSize+ZSTD_blockHeaderSize,
                        srcSize_wrong, "");
        FORWARD_IF_ERROR( ZSTD_decodeFrameHeader(dctx, ip, frameHeaderSize) , "");
        ip += frameHeaderSize; remainingSrcSize -= frameHeaderSize;
    }

    /* Loop on each block */
    while (1) {
        size_t decodedSize;
        blockProperties_t blockProperties;
        size_t const cBlockSize = ZSTD_getcBlockSize(ip, remainingSrcSize, &blockProperties);
        if (ZSTD_isError(cBlockSize)) return cBlockSize;

        ip += ZSTD_blockHeaderSize;
        remainingSrcSize -= ZSTD_blockHeaderSize;
        RETURN_ERROR_IF(cBlockSize > remainingSrcSize, srcSize_wrong, "");

        switch(blockProperties.blockType)
        {
        case bt_compressed:
            decodedSize = ZSTD_decompressBlock_internal(dctx, op, oend-op, ip, cBlockSize, /* frame */ 1);
            break;
        case bt_raw :
            decodedSize = ZSTD_copyRawBlock(op, oend-op, ip, cBlockSize);
            break;
        case bt_rle :
            decodedSize = ZSTD_setRleBlock(op, oend-op, *ip, blockProperties.origSize);
            break;
        case bt_reserved :
        default:
            RETURN_ERROR(corruption_detected, "invalid block type");
        }

        if (ZSTD_isError(decodedSize)) return decodedSize;
        if (dctx->fParams.checksumFlag)
            XXH64_update(&dctx->xxhState, op, decodedSize);
        if (decodedSize != 0)
            op += decodedSize;
        assert(ip != NULL);
        ip += cBlockSize;
        remainingSrcSize -= cBlockSize;
        if (blockProperties.lastBlock) break;
    }

    if (dctx->fParams.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN) {
        RETURN_ERROR_IF((U64)(op-ostart) != dctx->fParams.frameContentSize,
                        corruption_detected, "");
    }
    if (dctx->fParams.checksumFlag) { /* Frame content checksum verification */
        U32 const checkCalc = (U32)XXH64_digest(&dctx->xxhState);
        U32 checkRead;
        RETURN_ERROR_IF(remainingSrcSize<4, checksum_wrong, "");
        checkRead = MEM_readLE32(ip);
        RETURN_ERROR_IF(checkRead != checkCalc, checksum_wrong, "");
        ip += 4;
        remainingSrcSize -= 4;
    }

    /* Allow caller to get size read */
    *srcPtr = ip;
    *srcSizePtr = remainingSrcSize;
    return op-ostart;
}

static size_t ZSTD_decompressMultiFrame(ZSTD_DCtx* dctx,
                                        void* dst, size_t dstCapacity,
                                  const void* src, size_t srcSize,
                                  const void* dict, size_t dictSize,
                                  const ZSTD_DDict* ddict)
{
    void* const dststart = dst;
    int moreThan1Frame = 0;

    DEBUGLOG(5, "ZSTD_decompressMultiFrame");
    assert(dict==NULL || ddict==NULL);  /* either dict or ddict set, not both */

    if (ddict) {
        dict = ZSTD_DDict_dictContent(ddict);
        dictSize = ZSTD_DDict_dictSize(ddict);
    }

    while (srcSize >= ZSTD_startingInputLength(dctx->format)) {

#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT >= 1)
        if (ZSTD_isLegacy(src, srcSize)) {
            size_t decodedSize;
            size_t const frameSize = ZSTD_findFrameCompressedSizeLegacy(src, srcSize);
            if (ZSTD_isError(frameSize)) return frameSize;
            RETURN_ERROR_IF(dctx->staticSize, memory_allocation,
                "legacy support is not compatible with static dctx");

            decodedSize = ZSTD_decompressLegacy(dst, dstCapacity, src, frameSize, dict, dictSize);
            if (ZSTD_isError(decodedSize)) return decodedSize;

            assert(decodedSize <=- dstCapacity);
            dst = (BYTE*)dst + decodedSize;
            dstCapacity -= decodedSize;

            src = (const BYTE*)src + frameSize;
            srcSize -= frameSize;

            continue;
        }
#endif

        {   U32 const magicNumber = MEM_readLE32(src);
            DEBUGLOG(4, "reading magic number %08X (expecting %08X)",
                        (unsigned)magicNumber, ZSTD_MAGICNUMBER);
            if ((magicNumber & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {
                size_t const skippableSize = readSkippableFrameSize(src, srcSize);
                FORWARD_IF_ERROR(skippableSize, "readSkippableFrameSize failed");
                assert(skippableSize <= srcSize);

                src = (const BYTE *)src + skippableSize;
                srcSize -= skippableSize;
                continue;
        }   }

        if (ddict) {
            /* we were called from ZSTD_decompress_usingDDict */
            FORWARD_IF_ERROR(ZSTD_decompressBegin_usingDDict(dctx, ddict), "");
        } else {
            /* this will initialize correctly with no dict if dict == NULL, so
             * use this in all cases but ddict */
            FORWARD_IF_ERROR(ZSTD_decompressBegin_usingDict(dctx, dict, dictSize), "");
        }
        ZSTD_checkContinuity(dctx, dst);

        {   const size_t res = ZSTD_decompressFrame(dctx, dst, dstCapacity,
                                                    &src, &srcSize);
            RETURN_ERROR_IF(
                (ZSTD_getErrorCode(res) == ZSTD_error_prefix_unknown)
             && (moreThan1Frame==1),
                srcSize_wrong,
                "at least one frame successfully completed, but following "
                "bytes are garbage: it's more likely to be a srcSize error, "
                "specifying more bytes than compressed size of frame(s). This "
                "error message replaces ERROR(prefix_unknown), which would be "
                "confusing, as the first header is actually correct. Note that "
                "one could be unlucky, it might be a corruption error instead, "
                "happening right at the place where we expect zstd magic "
                "bytes. But this is _much_ less likely than a srcSize field "
                "error.");
            if (ZSTD_isError(res)) return res;
            assert(res <= dstCapacity);
            if (res != 0)
                dst = (BYTE*)dst + res;
            dstCapacity -= res;
        }
        moreThan1Frame = 1;
    }  /* while (srcSize >= ZSTD_frameHeaderSize_prefix) */

    RETURN_ERROR_IF(srcSize, srcSize_wrong, "input not entirely consumed");

    return (BYTE*)dst - (BYTE*)dststart;
}

size_t ZSTD_decompress_usingDict(ZSTD_DCtx* dctx,
                                 void* dst, size_t dstCapacity,
                           const void* src, size_t srcSize,
                           const void* dict, size_t dictSize)
{
    return ZSTD_decompressMultiFrame(dctx, dst, dstCapacity, src, srcSize, dict, dictSize, NULL);
}


static ZSTD_DDict const* ZSTD_getDDict(ZSTD_DCtx* dctx)
{
    switch (dctx->dictUses) {
    default:
        assert(0 /* Impossible */);
        /* fall-through */
    case ZSTD_dont_use:
        ZSTD_clearDict(dctx);
        return NULL;
    case ZSTD_use_indefinitely:
        return dctx->ddict;
    case ZSTD_use_once:
        dctx->dictUses = ZSTD_dont_use;
        return dctx->ddict;
    }
}

size_t ZSTD_decompressDCtx(ZSTD_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize)
{
    return ZSTD_decompress_usingDDict(dctx, dst, dstCapacity, src, srcSize, ZSTD_getDDict(dctx));
}


size_t ZSTD_decompress(void* dst, size_t dstCapacity, const void* src, size_t srcSize)
{
#if defined(ZSTD_HEAPMODE) && (ZSTD_HEAPMODE>=1)
    size_t regenSize;
    ZSTD_DCtx* const dctx = ZSTD_createDCtx();
    RETURN_ERROR_IF(dctx==NULL, memory_allocation, "NULL pointer!");
    regenSize = ZSTD_decompressDCtx(dctx, dst, dstCapacity, src, srcSize);
    ZSTD_freeDCtx(dctx);
    return regenSize;
#else   /* stack mode */
    ZSTD_DCtx dctx;
    ZSTD_initDCtx_internal(&dctx);
    return ZSTD_decompressDCtx(&dctx, dst, dstCapacity, src, srcSize);
#endif
}


/*-**************************************
*   Advanced Streaming Decompression API
*   Bufferless and synchronous
****************************************/
size_t ZSTD_nextSrcSizeToDecompress(ZSTD_DCtx* dctx) { return dctx->expected; }

/**
 * Similar to ZSTD_nextSrcSizeToDecompress(), but when when a block input can be streamed,
 * we allow taking a partial block as the input. Currently only raw uncompressed blocks can
 * be streamed.
 *
 * For blocks that can be streamed, this allows us to reduce the latency until we produce
 * output, and avoid copying the input.
 *
 * @param inputSize - The total amount of input that the caller currently has.
 */
static size_t ZSTD_nextSrcSizeToDecompressWithInputSize(ZSTD_DCtx* dctx, size_t inputSize) {
    if (!(dctx->stage == ZSTDds_decompressBlock || dctx->stage == ZSTDds_decompressLastBlock))
        return dctx->expected;
    if (dctx->bType != bt_raw)
        return dctx->expected;
    return MIN(MAX(inputSize, 1), dctx->expected);
}

ZSTD_nextInputType_e ZSTD_nextInputType(ZSTD_DCtx* dctx) {
    switch(dctx->stage)
    {
    default:   /* should not happen */
        assert(0);
    case ZSTDds_getFrameHeaderSize:
    case ZSTDds_decodeFrameHeader:
        return ZSTDnit_frameHeader;
    case ZSTDds_decodeBlockHeader:
        return ZSTDnit_blockHeader;
    case ZSTDds_decompressBlock:
        return ZSTDnit_block;
    case ZSTDds_decompressLastBlock:
        return ZSTDnit_lastBlock;
    case ZSTDds_checkChecksum:
        return ZSTDnit_checksum;
    case ZSTDds_decodeSkippableHeader:
    case ZSTDds_skipFrame:
        return ZSTDnit_skippableFrame;
    }
}

static int ZSTD_isSkipFrame(ZSTD_DCtx* dctx) { return dctx->stage == ZSTDds_skipFrame; }

/** ZSTD_decompressContinue() :
 *  srcSize : must be the exact nb of bytes expected (see ZSTD_nextSrcSizeToDecompress())
 *  @return : nb of bytes generated into `dst` (necessarily <= `dstCapacity)
 *            or an error code, which can be tested using ZSTD_isError() */
size_t ZSTD_decompressContinue(ZSTD_DCtx* dctx, void* dst, size_t dstCapacity, const void* src, size_t srcSize)
{
    DEBUGLOG(5, "ZSTD_decompressContinue (srcSize:%u)", (unsigned)srcSize);
    /* Sanity check */
    RETURN_ERROR_IF(srcSize != ZSTD_nextSrcSizeToDecompressWithInputSize(dctx, srcSize), srcSize_wrong, "not allowed");
    if (dstCapacity) ZSTD_checkContinuity(dctx, dst);

    switch (dctx->stage)
    {
    case ZSTDds_getFrameHeaderSize :
        assert(src != NULL);
        if (dctx->format == ZSTD_f_zstd1) {  /* allows header */
            assert(srcSize >= ZSTD_FRAMEIDSIZE);  /* to read skippable magic number */
            if ((MEM_readLE32(src) & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {        /* skippable frame */
                memcpy(dctx->headerBuffer, src, srcSize);
                dctx->expected = ZSTD_SKIPPABLEHEADERSIZE - srcSize;  /* remaining to load to get full skippable frame header */
                dctx->stage = ZSTDds_decodeSkippableHeader;
                return 0;
        }   }
        dctx->headerSize = ZSTD_frameHeaderSize_internal(src, srcSize, dctx->format);
        if (ZSTD_isError(dctx->headerSize)) return dctx->headerSize;
        memcpy(dctx->headerBuffer, src, srcSize);
        dctx->expected = dctx->headerSize - srcSize;
        dctx->stage = ZSTDds_decodeFrameHeader;
        return 0;

    case ZSTDds_decodeFrameHeader:
        assert(src != NULL);
        memcpy(dctx->headerBuffer + (dctx->headerSize - srcSize), src, srcSize);
        FORWARD_IF_ERROR(ZSTD_decodeFrameHeader(dctx, dctx->headerBuffer, dctx->headerSize), "");
        dctx->expected = ZSTD_blockHeaderSize;
        dctx->stage = ZSTDds_decodeBlockHeader;
        return 0;

    case ZSTDds_decodeBlockHeader:
        {   blockProperties_t bp;
            size_t const cBlockSize = ZSTD_getcBlockSize(src, ZSTD_blockHeaderSize, &bp);
            if (ZSTD_isError(cBlockSize)) return cBlockSize;
            RETURN_ERROR_IF(cBlockSize > dctx->fParams.blockSizeMax, corruption_detected, "Block Size Exceeds Maximum");
            dctx->expected = cBlockSize;
            dctx->bType = bp.blockType;
            dctx->rleSize = bp.origSize;
            if (cBlockSize) {
                dctx->stage = bp.lastBlock ? ZSTDds_decompressLastBlock : ZSTDds_decompressBlock;
                return 0;
            }
            /* empty block */
            if (bp.lastBlock) {
                if (dctx->fParams.checksumFlag) {
                    dctx->expected = 4;
                    dctx->stage = ZSTDds_checkChecksum;
                } else {
                    dctx->expected = 0; /* end of frame */
                    dctx->stage = ZSTDds_getFrameHeaderSize;
                }
            } else {
                dctx->expected = ZSTD_blockHeaderSize;  /* jump to next header */
                dctx->stage = ZSTDds_decodeBlockHeader;
            }
            return 0;
        }

    case ZSTDds_decompressLastBlock:
    case ZSTDds_decompressBlock:
        DEBUGLOG(5, "ZSTD_decompressContinue: case ZSTDds_decompressBlock");
        {   size_t rSize;
            switch(dctx->bType)
            {
            case bt_compressed:
                DEBUGLOG(5, "ZSTD_decompressContinue: case bt_compressed");
                rSize = ZSTD_decompressBlock_internal(dctx, dst, dstCapacity, src, srcSize, /* frame */ 1);
                dctx->expected = 0;  /* Streaming not supported */
                break;
            case bt_raw :
                assert(srcSize <= dctx->expected);
                rSize = ZSTD_copyRawBlock(dst, dstCapacity, src, srcSize);
                FORWARD_IF_ERROR(rSize, "ZSTD_copyRawBlock failed");
                assert(rSize == srcSize);
                dctx->expected -= rSize;
                break;
            case bt_rle :
                rSize = ZSTD_setRleBlock(dst, dstCapacity, *(const BYTE*)src, dctx->rleSize);
                dctx->expected = 0;  /* Streaming not supported */
                break;
            case bt_reserved :   /* should never happen */
            default:
                RETURN_ERROR(corruption_detected, "invalid block type");
            }
            FORWARD_IF_ERROR(rSize, "");
            RETURN_ERROR_IF(rSize > dctx->fParams.blockSizeMax, corruption_detected, "Decompressed Block Size Exceeds Maximum");
            DEBUGLOG(5, "ZSTD_decompressContinue: decoded size from block : %u", (unsigned)rSize);
            dctx->decodedSize += rSize;
            if (dctx->fParams.checksumFlag) XXH64_update(&dctx->xxhState, dst, rSize);
            dctx->previousDstEnd = (char*)dst + rSize;

            /* Stay on the same stage until we are finished streaming the block. */
            if (dctx->expected > 0) {
                return rSize;
            }

            if (dctx->stage == ZSTDds_decompressLastBlock) {   /* end of frame */
                DEBUGLOG(4, "ZSTD_decompressContinue: decoded size from frame : %u", (unsigned)dctx->decodedSize);
                RETURN_ERROR_IF(
                    dctx->fParams.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN
                 && dctx->decodedSize != dctx->fParams.frameContentSize,
                    corruption_detected, "");
                if (dctx->fParams.checksumFlag) {  /* another round for frame checksum */
                    dctx->expected = 4;
                    dctx->stage = ZSTDds_checkChecksum;
                } else {
                    dctx->expected = 0;   /* ends here */
                    dctx->stage = ZSTDds_getFrameHeaderSize;
                }
            } else {
                dctx->stage = ZSTDds_decodeBlockHeader;
                dctx->expected = ZSTD_blockHeaderSize;
            }
            return rSize;
        }

    case ZSTDds_checkChecksum:
        assert(srcSize == 4);  /* guaranteed by dctx->expected */
        {   U32 const h32 = (U32)XXH64_digest(&dctx->xxhState);
            U32 const check32 = MEM_readLE32(src);
            DEBUGLOG(4, "ZSTD_decompressContinue: checksum : calculated %08X :: %08X read", (unsigned)h32, (unsigned)check32);
            RETURN_ERROR_IF(check32 != h32, checksum_wrong, "");
            dctx->expected = 0;
            dctx->stage = ZSTDds_getFrameHeaderSize;
            return 0;
        }

    case ZSTDds_decodeSkippableHeader:
        assert(src != NULL);
        assert(srcSize <= ZSTD_SKIPPABLEHEADERSIZE);
        memcpy(dctx->headerBuffer + (ZSTD_SKIPPABLEHEADERSIZE - srcSize), src, srcSize);   /* complete skippable header */
        dctx->expected = MEM_readLE32(dctx->headerBuffer + ZSTD_FRAMEIDSIZE);   /* note : dctx->expected can grow seriously large, beyond local buffer size */
        dctx->stage = ZSTDds_skipFrame;
        return 0;

    case ZSTDds_skipFrame:
        dctx->expected = 0;
        dctx->stage = ZSTDds_getFrameHeaderSize;
        return 0;

    default:
        assert(0);   /* impossible */
        RETURN_ERROR(GENERIC, "impossible to reach");   /* some compiler require default to do something */
    }
}


static size_t ZSTD_refDictContent(ZSTD_DCtx* dctx, const void* dict, size_t dictSize)
{
    dctx->dictEnd = dctx->previousDstEnd;
    dctx->virtualStart = (const char*)dict - ((const char*)(dctx->previousDstEnd) - (const char*)(dctx->prefixStart));
    dctx->prefixStart = dict;
    dctx->previousDstEnd = (const char*)dict + dictSize;
#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
    dctx->dictContentBeginForFuzzing = dctx->prefixStart;
    dctx->dictContentEndForFuzzing = dctx->previousDstEnd;
#endif
    return 0;
}

/*! ZSTD_loadDEntropy() :
 *  dict : must point at beginning of a valid zstd dictionary.
 * @return : size of entropy tables read */
size_t
ZSTD_loadDEntropy(ZSTD_entropyDTables_t* entropy,
                  const void* const dict, size_t const dictSize)
{
    const BYTE* dictPtr = (const BYTE*)dict;
    const BYTE* const dictEnd = dictPtr + dictSize;

    RETURN_ERROR_IF(dictSize <= 8, dictionary_corrupted, "dict is too small");
    assert(MEM_readLE32(dict) == ZSTD_MAGIC_DICTIONARY);   /* dict must be valid */
    dictPtr += 8;   /* skip header = magic + dictID */

    ZSTD_STATIC_ASSERT(offsetof(ZSTD_entropyDTables_t, OFTable) == offsetof(ZSTD_entropyDTables_t, LLTable) + sizeof(entropy->LLTable));
    ZSTD_STATIC_ASSERT(offsetof(ZSTD_entropyDTables_t, MLTable) == offsetof(ZSTD_entropyDTables_t, OFTable) + sizeof(entropy->OFTable));
    ZSTD_STATIC_ASSERT(sizeof(entropy->LLTable) + sizeof(entropy->OFTable) + sizeof(entropy->MLTable) >= HUF_DECOMPRESS_WORKSPACE_SIZE);
    {   void* const workspace = &entropy->LLTable;   /* use fse tables as temporary workspace; implies fse tables are grouped together */
        size_t const workspaceSize = sizeof(entropy->LLTable) + sizeof(entropy->OFTable) + sizeof(entropy->MLTable);
#ifdef HUF_FORCE_DECOMPRESS_X1
        /* in minimal huffman, we always use X1 variants */
        size_t const hSize = HUF_readDTableX1_wksp(entropy->hufTable,
                                                dictPtr, dictEnd - dictPtr,
                                                workspace, workspaceSize);
#else
        size_t const hSize = HUF_readDTableX2_wksp(entropy->hufTable,
                                                dictPtr, dictEnd - dictPtr,
                                                workspace, workspaceSize);
#endif
        RETURN_ERROR_IF(HUF_isError(hSize), dictionary_corrupted, "");
        dictPtr += hSize;
    }

    {   short offcodeNCount[MaxOff+1];
        unsigned offcodeMaxValue = MaxOff, offcodeLog;
        size_t const offcodeHeaderSize = FSE_readNCount(offcodeNCount, &offcodeMaxValue, &offcodeLog, dictPtr, dictEnd-dictPtr);
        RETURN_ERROR_IF(FSE_isError(offcodeHeaderSize), dictionary_corrupted, "");
        RETURN_ERROR_IF(offcodeMaxValue > MaxOff, dictionary_corrupted, "");
        RETURN_ERROR_IF(offcodeLog > OffFSELog, dictionary_corrupted, "");
        ZSTD_buildFSETable( entropy->OFTable,
                            offcodeNCount, offcodeMaxValue,
                            OF_base, OF_bits,
                            offcodeLog);
        dictPtr += offcodeHeaderSize;
    }

    {   short matchlengthNCount[MaxML+1];
        unsigned matchlengthMaxValue = MaxML, matchlengthLog;
        size_t const matchlengthHeaderSize = FSE_readNCount(matchlengthNCount, &matchlengthMaxValue, &matchlengthLog, dictPtr, dictEnd-dictPtr);
        RETURN_ERROR_IF(FSE_isError(matchlengthHeaderSize), dictionary_corrupted, "");
        RETURN_ERROR_IF(matchlengthMaxValue > MaxML, dictionary_corrupted, "");
        RETURN_ERROR_IF(matchlengthLog > MLFSELog, dictionary_corrupted, "");
        ZSTD_buildFSETable( entropy->MLTable,
                            matchlengthNCount, matchlengthMaxValue,
                            ML_base, ML_bits,
                            matchlengthLog);
        dictPtr += matchlengthHeaderSize;
    }

    {   short litlengthNCount[MaxLL+1];
        unsigned litlengthMaxValue = MaxLL, litlengthLog;
        size_t const litlengthHeaderSize = FSE_readNCount(litlengthNCount, &litlengthMaxValue, &litlengthLog, dictPtr, dictEnd-dictPtr);
        RETURN_ERROR_IF(FSE_isError(litlengthHeaderSize), dictionary_corrupted, "");
        RETURN_ERROR_IF(litlengthMaxValue > MaxLL, dictionary_corrupted, "");
        RETURN_ERROR_IF(litlengthLog > LLFSELog, dictionary_corrupted, "");
        ZSTD_buildFSETable( entropy->LLTable,
                            litlengthNCount, litlengthMaxValue,
                            LL_base, LL_bits,
                            litlengthLog);
        dictPtr += litlengthHeaderSize;
    }

    RETURN_ERROR_IF(dictPtr+12 > dictEnd, dictionary_corrupted, "");
    {   int i;
        size_t const dictContentSize = (size_t)(dictEnd - (dictPtr+12));
        for (i=0; i<3; i++) {
            U32 const rep = MEM_readLE32(dictPtr); dictPtr += 4;
            RETURN_ERROR_IF(rep==0 || rep > dictContentSize,
                            dictionary_corrupted, "");
            entropy->rep[i] = rep;
    }   }

    return dictPtr - (const BYTE*)dict;
}

static size_t ZSTD_decompress_insertDictionary(ZSTD_DCtx* dctx, const void* dict, size_t dictSize)
{
    if (dictSize < 8) return ZSTD_refDictContent(dctx, dict, dictSize);
    {   U32 const magic = MEM_readLE32(dict);
        if (magic != ZSTD_MAGIC_DICTIONARY) {
            return ZSTD_refDictContent(dctx, dict, dictSize);   /* pure content mode */
    }   }
    dctx->dictID = MEM_readLE32((const char*)dict + ZSTD_FRAMEIDSIZE);

    /* load entropy tables */
    {   size_t const eSize = ZSTD_loadDEntropy(&dctx->entropy, dict, dictSize);
        RETURN_ERROR_IF(ZSTD_isError(eSize), dictionary_corrupted, "");
        dict = (const char*)dict + eSize;
        dictSize -= eSize;
    }
    dctx->litEntropy = dctx->fseEntropy = 1;

    /* reference dictionary content */
    return ZSTD_refDictContent(dctx, dict, dictSize);
}

size_t ZSTD_decompressBegin(ZSTD_DCtx* dctx)
{
    assert(dctx != NULL);
    dctx->expected = ZSTD_startingInputLength(dctx->format);  /* dctx->format must be properly set */
    dctx->stage = ZSTDds_getFrameHeaderSize;
    dctx->decodedSize = 0;
    dctx->previousDstEnd = NULL;
    dctx->prefixStart = NULL;
    dctx->virtualStart = NULL;
    dctx->dictEnd = NULL;
    dctx->entropy.hufTable[0] = (HUF_DTable)((HufLog)*0x1000001);  /* cover both little and big endian */
    dctx->litEntropy = dctx->fseEntropy = 0;
    dctx->dictID = 0;
    dctx->bType = bt_reserved;
    ZSTD_STATIC_ASSERT(sizeof(dctx->entropy.rep) == sizeof(repStartValue));
    memcpy(dctx->entropy.rep, repStartValue, sizeof(repStartValue));  /* initial repcodes */
    dctx->LLTptr = dctx->entropy.LLTable;
    dctx->MLTptr = dctx->entropy.MLTable;
    dctx->OFTptr = dctx->entropy.OFTable;
    dctx->HUFptr = dctx->entropy.hufTable;
    return 0;
}

size_t ZSTD_decompressBegin_usingDict(ZSTD_DCtx* dctx, const void* dict, size_t dictSize)
{
    FORWARD_IF_ERROR( ZSTD_decompressBegin(dctx) , "");
    if (dict && dictSize)
        RETURN_ERROR_IF(
            ZSTD_isError(ZSTD_decompress_insertDictionary(dctx, dict, dictSize)),
            dictionary_corrupted, "");
    return 0;
}


/* ======   ZSTD_DDict   ====== */

size_t ZSTD_decompressBegin_usingDDict(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict)
{
    DEBUGLOG(4, "ZSTD_decompressBegin_usingDDict");
    assert(dctx != NULL);
    if (ddict) {
        const char* const dictStart = (const char*)ZSTD_DDict_dictContent(ddict);
        size_t const dictSize = ZSTD_DDict_dictSize(ddict);
        const void* const dictEnd = dictStart + dictSize;
        dctx->ddictIsCold = (dctx->dictEnd != dictEnd);
        DEBUGLOG(4, "DDict is %s",
                    dctx->ddictIsCold ? "~cold~" : "hot!");
    }
    FORWARD_IF_ERROR( ZSTD_decompressBegin(dctx) , "");
    if (ddict) {   /* NULL ddict is equivalent to no dictionary */
        ZSTD_copyDDictParameters(dctx, ddict);
    }
    return 0;
}

/*! ZSTD_getDictID_fromDict() :
 *  Provides the dictID stored within dictionary.
 *  if @return == 0, the dictionary is not conformant with Zstandard specification.
 *  It can still be loaded, but as a content-only dictionary. */
unsigned ZSTD_getDictID_fromDict(const void* dict, size_t dictSize)
{
    if (dictSize < 8) return 0;
    if (MEM_readLE32(dict) != ZSTD_MAGIC_DICTIONARY) return 0;
    return MEM_readLE32((const char*)dict + ZSTD_FRAMEIDSIZE);
}

/*! ZSTD_getDictID_fromFrame() :
 *  Provides the dictID required to decompress frame stored within `src`.
 *  If @return == 0, the dictID could not be decoded.
 *  This could for one of the following reasons :
 *  - The frame does not require a dictionary (most common case).
 *  - The frame was built with dictID intentionally removed.
 *    Needed dictionary is a hidden information.
 *    Note : this use case also happens when using a non-conformant dictionary.
 *  - `srcSize` is too small, and as a result, frame header could not be decoded.
 *    Note : possible if `srcSize < ZSTD_FRAMEHEADERSIZE_MAX`.
 *  - This is not a Zstandard frame.
 *  When identifying the exact failure cause, it's possible to use
 *  ZSTD_getFrameHeader(), which will provide a more precise error code. */
unsigned ZSTD_getDictID_fromFrame(const void* src, size_t srcSize)
{
    ZSTD_frameHeader zfp = { 0, 0, 0, ZSTD_frame, 0, 0, 0 };
    size_t const hError = ZSTD_getFrameHeader(&zfp, src, srcSize);
    if (ZSTD_isError(hError)) return 0;
    return zfp.dictID;
}


/*! ZSTD_decompress_usingDDict() :
*   Decompression using a pre-digested Dictionary
*   Use dictionary without significant overhead. */
size_t ZSTD_decompress_usingDDict(ZSTD_DCtx* dctx,
                                  void* dst, size_t dstCapacity,
                            const void* src, size_t srcSize,
                            const ZSTD_DDict* ddict)
{
    /* pass content and size in case legacy frames are encountered */
    return ZSTD_decompressMultiFrame(dctx, dst, dstCapacity, src, srcSize,
                                     NULL, 0,
                                     ddict);
}


/*=====================================
*   Streaming decompression
*====================================*/

ZSTD_DStream* ZSTD_createDStream(void)
{
    DEBUGLOG(3, "ZSTD_createDStream");
    return ZSTD_createDStream_advanced(ZSTD_defaultCMem);
}

ZSTD_DStream* ZSTD_initStaticDStream(void *workspace, size_t workspaceSize)
{
    return ZSTD_initStaticDCtx(workspace, workspaceSize);
}

ZSTD_DStream* ZSTD_createDStream_advanced(ZSTD_customMem customMem)
{
    return ZSTD_createDCtx_advanced(customMem);
}

size_t ZSTD_freeDStream(ZSTD_DStream* zds)
{
    return ZSTD_freeDCtx(zds);
}


/* ***  Initialization  *** */

size_t ZSTD_DStreamInSize(void)  { return ZSTD_BLOCKSIZE_MAX + ZSTD_blockHeaderSize; }
size_t ZSTD_DStreamOutSize(void) { return ZSTD_BLOCKSIZE_MAX; }

size_t ZSTD_DCtx_loadDictionary_advanced(ZSTD_DCtx* dctx,
                                   const void* dict, size_t dictSize,
                                         ZSTD_dictLoadMethod_e dictLoadMethod,
                                         ZSTD_dictContentType_e dictContentType)
{
    RETURN_ERROR_IF(dctx->streamStage != zdss_init, stage_wrong, "");
    ZSTD_clearDict(dctx);
    if (dict && dictSize != 0) {
        dctx->ddictLocal = ZSTD_createDDict_advanced(dict, dictSize, dictLoadMethod, dictContentType, dctx->customMem);
        RETURN_ERROR_IF(dctx->ddictLocal == NULL, memory_allocation, "NULL pointer!");
        dctx->ddict = dctx->ddictLocal;
        dctx->dictUses = ZSTD_use_indefinitely;
    }
    return 0;
}

size_t ZSTD_DCtx_loadDictionary_byReference(ZSTD_DCtx* dctx, const void* dict, size_t dictSize)
{
    return ZSTD_DCtx_loadDictionary_advanced(dctx, dict, dictSize, ZSTD_dlm_byRef, ZSTD_dct_auto);
}

size_t ZSTD_DCtx_loadDictionary(ZSTD_DCtx* dctx, const void* dict, size_t dictSize)
{
    return ZSTD_DCtx_loadDictionary_advanced(dctx, dict, dictSize, ZSTD_dlm_byCopy, ZSTD_dct_auto);
}

size_t ZSTD_DCtx_refPrefix_advanced(ZSTD_DCtx* dctx, const void* prefix, size_t prefixSize, ZSTD_dictContentType_e dictContentType)
{
    FORWARD_IF_ERROR(ZSTD_DCtx_loadDictionary_advanced(dctx, prefix, prefixSize, ZSTD_dlm_byRef, dictContentType), "");
    dctx->dictUses = ZSTD_use_once;
    return 0;
}

size_t ZSTD_DCtx_refPrefix(ZSTD_DCtx* dctx, const void* prefix, size_t prefixSize)
{
    return ZSTD_DCtx_refPrefix_advanced(dctx, prefix, prefixSize, ZSTD_dct_rawContent);
}


/* ZSTD_initDStream_usingDict() :
 * return : expected size, aka ZSTD_startingInputLength().
 * this function cannot fail */
size_t ZSTD_initDStream_usingDict(ZSTD_DStream* zds, const void* dict, size_t dictSize)
{
    DEBUGLOG(4, "ZSTD_initDStream_usingDict");
    FORWARD_IF_ERROR( ZSTD_DCtx_reset(zds, ZSTD_reset_session_only) , "");
    FORWARD_IF_ERROR( ZSTD_DCtx_loadDictionary(zds, dict, dictSize) , "");
    return ZSTD_startingInputLength(zds->format);
}

/* note : this variant can't fail */
size_t ZSTD_initDStream(ZSTD_DStream* zds)
{
    DEBUGLOG(4, "ZSTD_initDStream");
    return ZSTD_initDStream_usingDDict(zds, NULL);
}

/* ZSTD_initDStream_usingDDict() :
 * ddict will just be referenced, and must outlive decompression session
 * this function cannot fail */
size_t ZSTD_initDStream_usingDDict(ZSTD_DStream* dctx, const ZSTD_DDict* ddict)
{
    FORWARD_IF_ERROR( ZSTD_DCtx_reset(dctx, ZSTD_reset_session_only) , "");
    FORWARD_IF_ERROR( ZSTD_DCtx_refDDict(dctx, ddict) , "");
    return ZSTD_startingInputLength(dctx->format);
}

/* ZSTD_resetDStream() :
 * return : expected size, aka ZSTD_startingInputLength().
 * this function cannot fail */
size_t ZSTD_resetDStream(ZSTD_DStream* dctx)
{
    FORWARD_IF_ERROR(ZSTD_DCtx_reset(dctx, ZSTD_reset_session_only), "");
    return ZSTD_startingInputLength(dctx->format);
}


size_t ZSTD_DCtx_refDDict(ZSTD_DCtx* dctx, const ZSTD_DDict* ddict)
{
    RETURN_ERROR_IF(dctx->streamStage != zdss_init, stage_wrong, "");
    ZSTD_clearDict(dctx);
    if (ddict) {
        dctx->ddict = ddict;
        dctx->dictUses = ZSTD_use_indefinitely;
    }
    return 0;
}

/* ZSTD_DCtx_setMaxWindowSize() :
 * note : no direct equivalence in ZSTD_DCtx_setParameter,
 * since this version sets windowSize, and the other sets windowLog */
size_t ZSTD_DCtx_setMaxWindowSize(ZSTD_DCtx* dctx, size_t maxWindowSize)
{
    ZSTD_bounds const bounds = ZSTD_dParam_getBounds(ZSTD_d_windowLogMax);
    size_t const min = (size_t)1 << bounds.lowerBound;
    size_t const max = (size_t)1 << bounds.upperBound;
    RETURN_ERROR_IF(dctx->streamStage != zdss_init, stage_wrong, "");
    RETURN_ERROR_IF(maxWindowSize < min, parameter_outOfBound, "");
    RETURN_ERROR_IF(maxWindowSize > max, parameter_outOfBound, "");
    dctx->maxWindowSize = maxWindowSize;
    return 0;
}

size_t ZSTD_DCtx_setFormat(ZSTD_DCtx* dctx, ZSTD_format_e format)
{
    return ZSTD_DCtx_setParameter(dctx, ZSTD_d_format, format);
}

ZSTD_bounds ZSTD_dParam_getBounds(ZSTD_dParameter dParam)
{
    ZSTD_bounds bounds = { 0, 0, 0 };
    switch(dParam) {
        case ZSTD_d_windowLogMax:
            bounds.lowerBound = ZSTD_WINDOWLOG_ABSOLUTEMIN;
            bounds.upperBound = ZSTD_WINDOWLOG_MAX;
            return bounds;
        case ZSTD_d_format:
            bounds.lowerBound = (int)ZSTD_f_zstd1;
            bounds.upperBound = (int)ZSTD_f_zstd1_magicless;
            ZSTD_STATIC_ASSERT(ZSTD_f_zstd1 < ZSTD_f_zstd1_magicless);
            return bounds;
        case ZSTD_d_stableOutBuffer:
            bounds.lowerBound = (int)ZSTD_obm_buffered;
            bounds.upperBound = (int)ZSTD_obm_stable;
            return bounds;
        default:;
    }
    bounds.error = ERROR(parameter_unsupported);
    return bounds;
}

/* ZSTD_dParam_withinBounds:
 * @return 1 if value is within dParam bounds,
 * 0 otherwise */
static int ZSTD_dParam_withinBounds(ZSTD_dParameter dParam, int value)
{
    ZSTD_bounds const bounds = ZSTD_dParam_getBounds(dParam);
    if (ZSTD_isError(bounds.error)) return 0;
    if (value < bounds.lowerBound) return 0;
    if (value > bounds.upperBound) return 0;
    return 1;
}

#define CHECK_DBOUNDS(p,v) {                \
    RETURN_ERROR_IF(!ZSTD_dParam_withinBounds(p, v), parameter_outOfBound, ""); \
}

size_t ZSTD_DCtx_setParameter(ZSTD_DCtx* dctx, ZSTD_dParameter dParam, int value)
{
    RETURN_ERROR_IF(dctx->streamStage != zdss_init, stage_wrong, "");
    switch(dParam) {
        case ZSTD_d_windowLogMax:
            if (value == 0) value = ZSTD_WINDOWLOG_LIMIT_DEFAULT;
            CHECK_DBOUNDS(ZSTD_d_windowLogMax, value);
            dctx->maxWindowSize = ((size_t)1) << value;
            return 0;
        case ZSTD_d_format:
            CHECK_DBOUNDS(ZSTD_d_format, value);
            dctx->format = (ZSTD_format_e)value;
            return 0;
        case ZSTD_d_stableOutBuffer:
            CHECK_DBOUNDS(ZSTD_d_stableOutBuffer, value);
            dctx->outBufferMode = (ZSTD_outBufferMode_e)value;
            return 0;
        default:;
    }
    RETURN_ERROR(parameter_unsupported, "");
}

size_t ZSTD_DCtx_reset(ZSTD_DCtx* dctx, ZSTD_ResetDirective reset)
{
    if ( (reset == ZSTD_reset_session_only)
      || (reset == ZSTD_reset_session_and_parameters) ) {
        dctx->streamStage = zdss_init;
        dctx->noForwardProgress = 0;
    }
    if ( (reset == ZSTD_reset_parameters)
      || (reset == ZSTD_reset_session_and_parameters) ) {
        RETURN_ERROR_IF(dctx->streamStage != zdss_init, stage_wrong, "");
        ZSTD_clearDict(dctx);
        dctx->format = ZSTD_f_zstd1;
        dctx->maxWindowSize = ZSTD_MAXWINDOWSIZE_DEFAULT;
    }
    return 0;
}


size_t ZSTD_sizeof_DStream(const ZSTD_DStream* dctx)
{
    return ZSTD_sizeof_DCtx(dctx);
}

size_t ZSTD_decodingBufferSize_min(unsigned long long windowSize, unsigned long long frameContentSize)
{
    size_t const blockSize = (size_t) MIN(windowSize, ZSTD_BLOCKSIZE_MAX);
    unsigned long long const neededRBSize = windowSize + blockSize + (WILDCOPY_OVERLENGTH * 2);
    unsigned long long const neededSize = MIN(frameContentSize, neededRBSize);
    size_t const minRBSize = (size_t) neededSize;
    RETURN_ERROR_IF((unsigned long long)minRBSize != neededSize,
                    frameParameter_windowTooLarge, "");
    return minRBSize;
}

size_t ZSTD_estimateDStreamSize(size_t windowSize)
{
    size_t const blockSize = MIN(windowSize, ZSTD_BLOCKSIZE_MAX);
    size_t const inBuffSize = blockSize;  /* no block can be larger */
    size_t const outBuffSize = ZSTD_decodingBufferSize_min(windowSize, ZSTD_CONTENTSIZE_UNKNOWN);
    return ZSTD_estimateDCtxSize() + inBuffSize + outBuffSize;
}

size_t ZSTD_estimateDStreamSize_fromFrame(const void* src, size_t srcSize)
{
    U32 const windowSizeMax = 1U << ZSTD_WINDOWLOG_MAX;   /* note : should be user-selectable, but requires an additional parameter (or a dctx) */
    ZSTD_frameHeader zfh;
    size_t const err = ZSTD_getFrameHeader(&zfh, src, srcSize);
    if (ZSTD_isError(err)) return err;
    RETURN_ERROR_IF(err>0, srcSize_wrong, "");
    RETURN_ERROR_IF(zfh.windowSize > windowSizeMax,
                    frameParameter_windowTooLarge, "");
    return ZSTD_estimateDStreamSize((size_t)zfh.windowSize);
}


/* *****   Decompression   ***** */

static int ZSTD_DCtx_isOverflow(ZSTD_DStream* zds, size_t const neededInBuffSize, size_t const neededOutBuffSize)
{
    return (zds->inBuffSize + zds->outBuffSize) >= (neededInBuffSize + neededOutBuffSize) * ZSTD_WORKSPACETOOLARGE_FACTOR;
}

static void ZSTD_DCtx_updateOversizedDuration(ZSTD_DStream* zds, size_t const neededInBuffSize, size_t const neededOutBuffSize)
{
    if (ZSTD_DCtx_isOverflow(zds, neededInBuffSize, neededOutBuffSize))
        zds->oversizedDuration++;
    else 
        zds->oversizedDuration = 0;
}

static int ZSTD_DCtx_isOversizedTooLong(ZSTD_DStream* zds)
{
    return zds->oversizedDuration >= ZSTD_WORKSPACETOOLARGE_MAXDURATION;
}

/* Checks that the output buffer hasn't changed if ZSTD_obm_stable is used. */
static size_t ZSTD_checkOutBuffer(ZSTD_DStream const* zds, ZSTD_outBuffer const* output)
{
    ZSTD_outBuffer const expect = zds->expectedOutBuffer;
    /* No requirement when ZSTD_obm_stable is not enabled. */
    if (zds->outBufferMode != ZSTD_obm_stable)
        return 0;
    /* Any buffer is allowed in zdss_init, this must be the same for every other call until
     * the context is reset.
     */
    if (zds->streamStage == zdss_init)
        return 0;
    /* The buffer must match our expectation exactly. */
    if (expect.dst == output->dst && expect.pos == output->pos && expect.size == output->size)
        return 0;
    RETURN_ERROR(dstBuffer_wrong, "ZSTD_obm_stable enabled but output differs!");
}

/* Calls ZSTD_decompressContinue() with the right parameters for ZSTD_decompressStream()
 * and updates the stage and the output buffer state. This call is extracted so it can be
 * used both when reading directly from the ZSTD_inBuffer, and in buffered input mode.
 * NOTE: You must break after calling this function since the streamStage is modified.
 */
static size_t ZSTD_decompressContinueStream(
            ZSTD_DStream* zds, char** op, char* oend,
            void const* src, size_t srcSize) {
    int const isSkipFrame = ZSTD_isSkipFrame(zds);
    if (zds->outBufferMode == ZSTD_obm_buffered) {
        size_t const dstSize = isSkipFrame ? 0 : zds->outBuffSize - zds->outStart;
        size_t const decodedSize = ZSTD_decompressContinue(zds,
                zds->outBuff + zds->outStart, dstSize, src, srcSize);
        FORWARD_IF_ERROR(decodedSize, "");
        if (!decodedSize && !isSkipFrame) {
            zds->streamStage = zdss_read;
        } else {
            zds->outEnd = zds->outStart + decodedSize;
            zds->streamStage = zdss_flush;
        }
    } else {
        /* Write directly into the output buffer */
        size_t const dstSize = isSkipFrame ? 0 : oend - *op;
        size_t const decodedSize = ZSTD_decompressContinue(zds, *op, dstSize, src, srcSize);
        FORWARD_IF_ERROR(decodedSize, "");
        *op += decodedSize;
        /* Flushing is not needed. */
        zds->streamStage = zdss_read;
        assert(*op <= oend);
        assert(zds->outBufferMode == ZSTD_obm_stable);
    }
    return 0;
}

size_t ZSTD_decompressStream(ZSTD_DStream* zds, ZSTD_outBuffer* output, ZSTD_inBuffer* input)
{
    const char* const src = (const char*)input->src;
    const char* const istart = input->pos != 0 ? src + input->pos : src;
    const char* const iend = input->size != 0 ? src + input->size : src;
    const char* ip = istart;
    char* const dst = (char*)output->dst;
    char* const ostart = output->pos != 0 ? dst + output->pos : dst;
    char* const oend = output->size != 0 ? dst + output->size : dst;
    char* op = ostart;
    U32 someMoreWork = 1;

    DEBUGLOG(5, "ZSTD_decompressStream");
    RETURN_ERROR_IF(
        input->pos > input->size,
        srcSize_wrong,
        "forbidden. in: pos: %u   vs size: %u",
        (U32)input->pos, (U32)input->size);
    RETURN_ERROR_IF(
        output->pos > output->size,
        dstSize_tooSmall,
        "forbidden. out: pos: %u   vs size: %u",
        (U32)output->pos, (U32)output->size);
    DEBUGLOG(5, "input size : %u", (U32)(input->size - input->pos));
    FORWARD_IF_ERROR(ZSTD_checkOutBuffer(zds, output), "");

    while (someMoreWork) {
        switch(zds->streamStage)
        {
        case zdss_init :
            DEBUGLOG(5, "stage zdss_init => transparent reset ");
            zds->streamStage = zdss_loadHeader;
            zds->lhSize = zds->inPos = zds->outStart = zds->outEnd = 0;
            zds->legacyVersion = 0;
            zds->hostageByte = 0;
            zds->expectedOutBuffer = *output;
            /* fall-through */

        case zdss_loadHeader :
            DEBUGLOG(5, "stage zdss_loadHeader (srcSize : %u)", (U32)(iend - ip));
#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT>=1)
            if (zds->legacyVersion) {
                RETURN_ERROR_IF(zds->staticSize, memory_allocation,
                    "legacy support is incompatible with static dctx");
                {   size_t const hint = ZSTD_decompressLegacyStream(zds->legacyContext, zds->legacyVersion, output, input);
                    if (hint==0) zds->streamStage = zdss_init;
                    return hint;
            }   }
#endif
            {   size_t const hSize = ZSTD_getFrameHeader_advanced(&zds->fParams, zds->headerBuffer, zds->lhSize, zds->format);
                DEBUGLOG(5, "header size : %u", (U32)hSize);
                if (ZSTD_isError(hSize)) {
#if defined(ZSTD_LEGACY_SUPPORT) && (ZSTD_LEGACY_SUPPORT>=1)
                    U32 const legacyVersion = ZSTD_isLegacy(istart, iend-istart);
                    if (legacyVersion) {
                        ZSTD_DDict const* const ddict = ZSTD_getDDict(zds);
                        const void* const dict = ddict ? ZSTD_DDict_dictContent(ddict) : NULL;
                        size_t const dictSize = ddict ? ZSTD_DDict_dictSize(ddict) : 0;
                        DEBUGLOG(5, "ZSTD_decompressStream: detected legacy version v0.%u", legacyVersion);
                        RETURN_ERROR_IF(zds->staticSize, memory_allocation,
                            "legacy support is incompatible with static dctx");
                        FORWARD_IF_ERROR(ZSTD_initLegacyStream(&zds->legacyContext,
                                    zds->previousLegacyVersion, legacyVersion,
                                    dict, dictSize), "");
                        zds->legacyVersion = zds->previousLegacyVersion = legacyVersion;
                        {   size_t const hint = ZSTD_decompressLegacyStream(zds->legacyContext, legacyVersion, output, input);
                            if (hint==0) zds->streamStage = zdss_init;   /* or stay in stage zdss_loadHeader */
                            return hint;
                    }   }
#endif
                    return hSize;   /* error */
                }
                if (hSize != 0) {   /* need more input */
                    size_t const toLoad = hSize - zds->lhSize;   /* if hSize!=0, hSize > zds->lhSize */
                    size_t const remainingInput = (size_t)(iend-ip);
                    assert(iend >= ip);
                    if (toLoad > remainingInput) {   /* not enough input to load full header */
                        if (remainingInput > 0) {
                            memcpy(zds->headerBuffer + zds->lhSize, ip, remainingInput);
                            zds->lhSize += remainingInput;
                        }
                        input->pos = input->size;
                        return (MAX((size_t)ZSTD_FRAMEHEADERSIZE_MIN(zds->format), hSize) - zds->lhSize) + ZSTD_blockHeaderSize;   /* remaining header bytes + next block header */
                    }
                    assert(ip != NULL);
                    memcpy(zds->headerBuffer + zds->lhSize, ip, toLoad); zds->lhSize = hSize; ip += toLoad;
                    break;
            }   }

            /* check for single-pass mode opportunity */
            if (zds->fParams.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN
                && zds->fParams.frameType != ZSTD_skippableFrame
                && (U64)(size_t)(oend-op) >= zds->fParams.frameContentSize) {
                size_t const cSize = ZSTD_findFrameCompressedSize(istart, iend-istart);
                if (cSize <= (size_t)(iend-istart)) {
                    /* shortcut : using single-pass mode */
                    size_t const decompressedSize = ZSTD_decompress_usingDDict(zds, op, oend-op, istart, cSize, ZSTD_getDDict(zds));
                    if (ZSTD_isError(decompressedSize)) return decompressedSize;
                    DEBUGLOG(4, "shortcut to single-pass ZSTD_decompress_usingDDict()")
                    ip = istart + cSize;
                    op += decompressedSize;
                    zds->expected = 0;
                    zds->streamStage = zdss_init;
                    someMoreWork = 0;
                    break;
            }   }

            /* Check output buffer is large enough for ZSTD_odm_stable. */
            if (zds->outBufferMode == ZSTD_obm_stable
                && zds->fParams.frameType != ZSTD_skippableFrame
                && zds->fParams.frameContentSize != ZSTD_CONTENTSIZE_UNKNOWN
                && (U64)(size_t)(oend-op) < zds->fParams.frameContentSize) {
                RETURN_ERROR(dstSize_tooSmall, "ZSTD_obm_stable passed but ZSTD_outBuffer is too small");
            }

            /* Consume header (see ZSTDds_decodeFrameHeader) */
            DEBUGLOG(4, "Consume header");
            FORWARD_IF_ERROR(ZSTD_decompressBegin_usingDDict(zds, ZSTD_getDDict(zds)), "");

            if ((MEM_readLE32(zds->headerBuffer) & ZSTD_MAGIC_SKIPPABLE_MASK) == ZSTD_MAGIC_SKIPPABLE_START) {  /* skippable frame */
                zds->expected = MEM_readLE32(zds->headerBuffer + ZSTD_FRAMEIDSIZE);
                zds->stage = ZSTDds_skipFrame;
            } else {
                FORWARD_IF_ERROR(ZSTD_decodeFrameHeader(zds, zds->headerBuffer, zds->lhSize), "");
                zds->expected = ZSTD_blockHeaderSize;
                zds->stage = ZSTDds_decodeBlockHeader;
            }

            /* control buffer memory usage */
            DEBUGLOG(4, "Control max memory usage (%u KB <= max %u KB)",
                        (U32)(zds->fParams.windowSize >>10),
                        (U32)(zds->maxWindowSize >> 10) );
            zds->fParams.windowSize = MAX(zds->fParams.windowSize, 1U << ZSTD_WINDOWLOG_ABSOLUTEMIN);
            RETURN_ERROR_IF(zds->fParams.windowSize > zds->maxWindowSize,
                            frameParameter_windowTooLarge, "");

            /* Adapt buffer sizes to frame header instructions */
            {   size_t const neededInBuffSize = MAX(zds->fParams.blockSizeMax, 4 /* frame checksum */);
                size_t const neededOutBuffSize = zds->outBufferMode == ZSTD_obm_buffered
                        ? ZSTD_decodingBufferSize_min(zds->fParams.windowSize, zds->fParams.frameContentSize)
                        : 0;

                ZSTD_DCtx_updateOversizedDuration(zds, neededInBuffSize, neededOutBuffSize);

                {   int const tooSmall = (zds->inBuffSize < neededInBuffSize) || (zds->outBuffSize < neededOutBuffSize);
                    int const tooLarge = ZSTD_DCtx_isOversizedTooLong(zds);
                    
                    if (tooSmall || tooLarge) {
                        size_t const bufferSize = neededInBuffSize + neededOutBuffSize;
                        DEBUGLOG(4, "inBuff  : from %u to %u",
                                    (U32)zds->inBuffSize, (U32)neededInBuffSize);
                        DEBUGLOG(4, "outBuff : from %u to %u",
                                    (U32)zds->outBuffSize, (U32)neededOutBuffSize);
                        if (zds->staticSize) {  /* static DCtx */
                            DEBUGLOG(4, "staticSize : %u", (U32)zds->staticSize);
                            assert(zds->staticSize >= sizeof(ZSTD_DCtx));  /* controlled at init */
                            RETURN_ERROR_IF(
                                bufferSize > zds->staticSize - sizeof(ZSTD_DCtx),
                                memory_allocation, "");
                        } else {
                            ZSTD_free(zds->inBuff, zds->customMem);
                            zds->inBuffSize = 0;
                            zds->outBuffSize = 0;
                            zds->inBuff = (char*)ZSTD_malloc(bufferSize, zds->customMem);
                            RETURN_ERROR_IF(zds->inBuff == NULL, memory_allocation, "");
                        }
                        zds->inBuffSize = neededInBuffSize;
                        zds->outBuff = zds->inBuff + zds->inBuffSize;
                        zds->outBuffSize = neededOutBuffSize;
            }   }   }
            zds->streamStage = zdss_read;
            /* fall-through */

        case zdss_read:
            DEBUGLOG(5, "stage zdss_read");
            {   size_t const neededInSize = ZSTD_nextSrcSizeToDecompressWithInputSize(zds, iend - ip);
                DEBUGLOG(5, "neededInSize = %u", (U32)neededInSize);
                if (neededInSize==0) {  /* end of frame */
                    zds->streamStage = zdss_init;
                    someMoreWork = 0;
                    break;
                }
                if ((size_t)(iend-ip) >= neededInSize) {  /* decode directly from src */
                    FORWARD_IF_ERROR(ZSTD_decompressContinueStream(zds, &op, oend, ip, neededInSize), "");
                    ip += neededInSize;
                    /* Function modifies the stage so we must break */
                    break;
            }   }
            if (ip==iend) { someMoreWork = 0; break; }   /* no more input */
            zds->streamStage = zdss_load;
            /* fall-through */

        case zdss_load:
            {   size_t const neededInSize = ZSTD_nextSrcSizeToDecompress(zds);
                size_t const toLoad = neededInSize - zds->inPos;
                int const isSkipFrame = ZSTD_isSkipFrame(zds);
                size_t loadedSize;
                /* At this point we shouldn't be decompressing a block that we can stream. */
                assert(neededInSize == ZSTD_nextSrcSizeToDecompressWithInputSize(zds, iend - ip));
                if (isSkipFrame) {
                    loadedSize = MIN(toLoad, (size_t)(iend-ip));
                } else {
                    RETURN_ERROR_IF(toLoad > zds->inBuffSize - zds->inPos,
                                    corruption_detected,
                                    "should never happen");
                    loadedSize = ZSTD_limitCopy(zds->inBuff + zds->inPos, toLoad, ip, iend-ip);
                }
                ip += loadedSize;
                zds->inPos += loadedSize;
                if (loadedSize < toLoad) { someMoreWork = 0; break; }   /* not enough input, wait for more */

                /* decode loaded input */
                zds->inPos = 0;   /* input is consumed */
                FORWARD_IF_ERROR(ZSTD_decompressContinueStream(zds, &op, oend, zds->inBuff, neededInSize), "");
                /* Function modifies the stage so we must break */
                break;
            }
        case zdss_flush:
            {   size_t const toFlushSize = zds->outEnd - zds->outStart;
                size_t const flushedSize = ZSTD_limitCopy(op, oend-op, zds->outBuff + zds->outStart, toFlushSize);
                op += flushedSize;
                zds->outStart += flushedSize;
                if (flushedSize == toFlushSize) {  /* flush completed */
                    zds->streamStage = zdss_read;
                    if ( (zds->outBuffSize < zds->fParams.frameContentSize)
                      && (zds->outStart + zds->fParams.blockSizeMax > zds->outBuffSize) ) {
                        DEBUGLOG(5, "restart filling outBuff from beginning (left:%i, needed:%u)",
                                (int)(zds->outBuffSize - zds->outStart),
                                (U32)zds->fParams.blockSizeMax);
                        zds->outStart = zds->outEnd = 0;
                    }
                    break;
            }   }
            /* cannot complete flush */
            someMoreWork = 0;
            break;

        default:
            assert(0);    /* impossible */
            RETURN_ERROR(GENERIC, "impossible to reach");   /* some compiler require default to do something */
    }   }

    /* result */
    input->pos = (size_t)(ip - (const char*)(input->src));
    output->pos = (size_t)(op - (char*)(output->dst));

    /* Update the expected output buffer for ZSTD_obm_stable. */
    zds->expectedOutBuffer = *output;

    if ((ip==istart) && (op==ostart)) {  /* no forward progress */
        zds->noForwardProgress ++;
        if (zds->noForwardProgress >= ZSTD_NO_FORWARD_PROGRESS_MAX) {
            RETURN_ERROR_IF(op==oend, dstSize_tooSmall, "");
            RETURN_ERROR_IF(ip==iend, srcSize_wrong, "");
            assert(0);
        }
    } else {
        zds->noForwardProgress = 0;
    }
    {   size_t nextSrcSizeHint = ZSTD_nextSrcSizeToDecompress(zds);
        if (!nextSrcSizeHint) {   /* frame fully decoded */
            if (zds->outEnd == zds->outStart) {  /* output fully flushed */
                if (zds->hostageByte) {
                    if (input->pos >= input->size) {
                        /* can't release hostage (not present) */
                        zds->streamStage = zdss_read;
                        return 1;
                    }
                    input->pos++;  /* release hostage */
                }   /* zds->hostageByte */
                return 0;
            }  /* zds->outEnd == zds->outStart */
            if (!zds->hostageByte) { /* output not fully flushed; keep last byte as hostage; will be released when all output is flushed */
                input->pos--;   /* note : pos > 0, otherwise, impossible to finish reading last block */
                zds->hostageByte=1;
            }
            return 1;
        }  /* nextSrcSizeHint==0 */
        nextSrcSizeHint += ZSTD_blockHeaderSize * (ZSTD_nextInputType(zds) == ZSTDnit_block);   /* preload header of next block */
        assert(zds->inPos <= nextSrcSizeHint);
        nextSrcSizeHint -= zds->inPos;   /* part already loaded*/
        return nextSrcSizeHint;
    }
}

size_t ZSTD_decompressStream_simpleArgs (
                            ZSTD_DCtx* dctx,
                            void* dst, size_t dstCapacity, size_t* dstPos,
                      const void* src, size_t srcSize, size_t* srcPos)
{
    ZSTD_outBuffer output = { dst, dstCapacity, *dstPos };
    ZSTD_inBuffer  input  = { src, srcSize, *srcPos };
    /* ZSTD_compress_generic() will check validity of dstPos and srcPos */
    size_t const cErr = ZSTD_decompressStream(dctx, &output, &input);
    *dstPos = output.pos;
    *srcPos = input.pos;
    return cErr;
}
/**** ended inlining decompress/zstd_decompress.c ****/
/**** start inlining decompress/zstd_decompress_block.c ****/
/*
 * Copyright (c) 2016-2020, Yann Collet, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under both the BSD-style license (found in the
 * LICENSE file in the root directory of this source tree) and the GPLv2 (found
 * in the COPYING file in the root directory of this source tree).
 * You may select, at your option, one of the above-listed licenses.
 */

/* zstd_decompress_block :
 * this module takes care of decompressing _compressed_ block */

/*-*******************************************************
*  Dependencies
*********************************************************/
/**** skipping file: ../common/compiler.h ****/
/**** skipping file: ../common/cpu.h ****/
/**** skipping file: ../common/mem.h ****/
#define FSE_STATIC_LINKING_ONLY
/**** skipping file: ../common/fse.h ****/
#define HUF_STATIC_LINKING_ONLY
/**** skipping file: ../common/huf.h ****/
/**** skipping file: ../common/zstd_internal.h ****/
/**** skipping file: zstd_decompress_internal.h ****/
/**** skipping file: zstd_ddict.h ****/
/**** skipping file: zstd_decompress_block.h ****/

/*_*******************************************************
*  Macros
**********************************************************/

/* These two optional macros force the use one way or another of the two
 * ZSTD_decompressSequences implementations. You can't force in both directions
 * at the same time.
 */
#if defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT) && \
    defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG)
#error "Cannot force the use of the short and the long ZSTD_decompressSequences variants!"
#endif


/*_*******************************************************
*  Memory operations
**********************************************************/
static void ZSTD_copy4(void* dst, const void* src) { memcpy(dst, src, 4); }


/*-*************************************************************
 *   Block decoding
 ***************************************************************/

/*! ZSTD_getcBlockSize() :
 *  Provides the size of compressed block from block header `src` */
size_t ZSTD_getcBlockSize(const void* src, size_t srcSize,
                          blockProperties_t* bpPtr)
{
    RETURN_ERROR_IF(srcSize < ZSTD_blockHeaderSize, srcSize_wrong, "");

    {   U32 const cBlockHeader = MEM_readLE24(src);
        U32 const cSize = cBlockHeader >> 3;
        bpPtr->lastBlock = cBlockHeader & 1;
        bpPtr->blockType = (blockType_e)((cBlockHeader >> 1) & 3);
        bpPtr->origSize = cSize;   /* only useful for RLE */
        if (bpPtr->blockType == bt_rle) return 1;
        RETURN_ERROR_IF(bpPtr->blockType == bt_reserved, corruption_detected, "");
        return cSize;
    }
}


/* Hidden declaration for fullbench */
size_t ZSTD_decodeLiteralsBlock(ZSTD_DCtx* dctx,
                          const void* src, size_t srcSize);
/*! ZSTD_decodeLiteralsBlock() :
 * @return : nb of bytes read from src (< srcSize )
 *  note : symbol not declared but exposed for fullbench */
size_t ZSTD_decodeLiteralsBlock(ZSTD_DCtx* dctx,
                          const void* src, size_t srcSize)   /* note : srcSize < BLOCKSIZE */
{
    DEBUGLOG(5, "ZSTD_decodeLiteralsBlock");
    RETURN_ERROR_IF(srcSize < MIN_CBLOCK_SIZE, corruption_detected, "");

    {   const BYTE* const istart = (const BYTE*) src;
        symbolEncodingType_e const litEncType = (symbolEncodingType_e)(istart[0] & 3);

        switch(litEncType)
        {
        case set_repeat:
            DEBUGLOG(5, "set_repeat flag : re-using stats from previous compressed literals block");
            RETURN_ERROR_IF(dctx->litEntropy==0, dictionary_corrupted, "");
            /* fall-through */

        case set_compressed:
            RETURN_ERROR_IF(srcSize < 5, corruption_detected, "srcSize >= MIN_CBLOCK_SIZE == 3; here we need up to 5 for case 3");
            {   size_t lhSize, litSize, litCSize;
                U32 singleStream=0;
                U32 const lhlCode = (istart[0] >> 2) & 3;
                U32 const lhc = MEM_readLE32(istart);
                size_t hufSuccess;
                switch(lhlCode)
                {
                case 0: case 1: default:   /* note : default is impossible, since lhlCode into [0..3] */
                    /* 2 - 2 - 10 - 10 */
                    singleStream = !lhlCode;
                    lhSize = 3;
                    litSize  = (lhc >> 4) & 0x3FF;
                    litCSize = (lhc >> 14) & 0x3FF;
                    break;
                case 2:
                    /* 2 - 2 - 14 - 14 */
                    lhSize = 4;
                    litSize  = (lhc >> 4) & 0x3FFF;
                    litCSize = lhc >> 18;
                    break;
                case 3:
                    /* 2 - 2 - 18 - 18 */
                    lhSize = 5;
                    litSize  = (lhc >> 4) & 0x3FFFF;
                    litCSize = (lhc >> 22) + ((size_t)istart[4] << 10);
                    break;
                }
                RETURN_ERROR_IF(litSize > ZSTD_BLOCKSIZE_MAX, corruption_detected, "");
                RETURN_ERROR_IF(litCSize + lhSize > srcSize, corruption_detected, "");

                /* prefetch huffman table if cold */
                if (dctx->ddictIsCold && (litSize > 768 /* heuristic */)) {
                    PREFETCH_AREA(dctx->HUFptr, sizeof(dctx->entropy.hufTable));
                }

                if (litEncType==set_repeat) {
                    if (singleStream) {
                        hufSuccess = HUF_decompress1X_usingDTable_bmi2(
                            dctx->litBuffer, litSize, istart+lhSize, litCSize,
                            dctx->HUFptr, dctx->bmi2);
                    } else {
                        hufSuccess = HUF_decompress4X_usingDTable_bmi2(
                            dctx->litBuffer, litSize, istart+lhSize, litCSize,
                            dctx->HUFptr, dctx->bmi2);
                    }
                } else {
                    if (singleStream) {
#if defined(HUF_FORCE_DECOMPRESS_X2)
                        hufSuccess = HUF_decompress1X_DCtx_wksp(
                            dctx->entropy.hufTable, dctx->litBuffer, litSize,
                            istart+lhSize, litCSize, dctx->workspace,
                            sizeof(dctx->workspace));
#else
                        hufSuccess = HUF_decompress1X1_DCtx_wksp_bmi2(
                            dctx->entropy.hufTable, dctx->litBuffer, litSize,
                            istart+lhSize, litCSize, dctx->workspace,
                            sizeof(dctx->workspace), dctx->bmi2);
#endif
                    } else {
                        hufSuccess = HUF_decompress4X_hufOnly_wksp_bmi2(
                            dctx->entropy.hufTable, dctx->litBuffer, litSize,
                            istart+lhSize, litCSize, dctx->workspace,
                            sizeof(dctx->workspace), dctx->bmi2);
                    }
                }

                RETURN_ERROR_IF(HUF_isError(hufSuccess), corruption_detected, "");

                dctx->litPtr = dctx->litBuffer;
                dctx->litSize = litSize;
                dctx->litEntropy = 1;
                if (litEncType==set_compressed) dctx->HUFptr = dctx->entropy.hufTable;
                memset(dctx->litBuffer + dctx->litSize, 0, WILDCOPY_OVERLENGTH);
                return litCSize + lhSize;
            }

        case set_basic:
            {   size_t litSize, lhSize;
                U32 const lhlCode = ((istart[0]) >> 2) & 3;
                switch(lhlCode)
                {
                case 0: case 2: default:   /* note : default is impossible, since lhlCode into [0..3] */
                    lhSize = 1;
                    litSize = istart[0] >> 3;
                    break;
                case 1:
                    lhSize = 2;
                    litSize = MEM_readLE16(istart) >> 4;
                    break;
                case 3:
                    lhSize = 3;
                    litSize = MEM_readLE24(istart) >> 4;
                    break;
                }

                if (lhSize+litSize+WILDCOPY_OVERLENGTH > srcSize) {  /* risk reading beyond src buffer with wildcopy */
                    RETURN_ERROR_IF(litSize+lhSize > srcSize, corruption_detected, "");
                    memcpy(dctx->litBuffer, istart+lhSize, litSize);
                    dctx->litPtr = dctx->litBuffer;
                    dctx->litSize = litSize;
                    memset(dctx->litBuffer + dctx->litSize, 0, WILDCOPY_OVERLENGTH);
                    return lhSize+litSize;
                }
                /* direct reference into compressed stream */
                dctx->litPtr = istart+lhSize;
                dctx->litSize = litSize;
                return lhSize+litSize;
            }

        case set_rle:
            {   U32 const lhlCode = ((istart[0]) >> 2) & 3;
                size_t litSize, lhSize;
                switch(lhlCode)
                {
                case 0: case 2: default:   /* note : default is impossible, since lhlCode into [0..3] */
                    lhSize = 1;
                    litSize = istart[0] >> 3;
                    break;
                case 1:
                    lhSize = 2;
                    litSize = MEM_readLE16(istart) >> 4;
                    break;
                case 3:
                    lhSize = 3;
                    litSize = MEM_readLE24(istart) >> 4;
                    RETURN_ERROR_IF(srcSize<4, corruption_detected, "srcSize >= MIN_CBLOCK_SIZE == 3; here we need lhSize+1 = 4");
                    break;
                }
                RETURN_ERROR_IF(litSize > ZSTD_BLOCKSIZE_MAX, corruption_detected, "");
                memset(dctx->litBuffer, istart[lhSize], litSize + WILDCOPY_OVERLENGTH);
                dctx->litPtr = dctx->litBuffer;
                dctx->litSize = litSize;
                return lhSize+1;
            }
        default:
            RETURN_ERROR(corruption_detected, "impossible");
        }
    }
}

/* Default FSE distribution tables.
 * These are pre-calculated FSE decoding tables using default distributions as defined in specification :
 * https://github.com/facebook/zstd/blob/master/doc/zstd_compression_format.md#default-distributions
 * They were generated programmatically with following method :
 * - start from default distributions, present in /lib/common/zstd_internal.h
 * - generate tables normally, using ZSTD_buildFSETable()
 * - printout the content of tables
 * - pretify output, report below, test with fuzzer to ensure it's correct */

/* Default FSE distribution table for Literal Lengths */
static const ZSTD_seqSymbol LL_defaultDTable[(1<<LL_DEFAULTNORMLOG)+1] = {
     {  1,  1,  1, LL_DEFAULTNORMLOG},  /* header : fastMode, tableLog */
     /* nextState, nbAddBits, nbBits, baseVal */
     {  0,  0,  4,    0},  { 16,  0,  4,    0},
     { 32,  0,  5,    1},  {  0,  0,  5,    3},
     {  0,  0,  5,    4},  {  0,  0,  5,    6},
     {  0,  0,  5,    7},  {  0,  0,  5,    9},
     {  0,  0,  5,   10},  {  0,  0,  5,   12},
     {  0,  0,  6,   14},  {  0,  1,  5,   16},
     {  0,  1,  5,   20},  {  0,  1,  5,   22},
     {  0,  2,  5,   28},  {  0,  3,  5,   32},
     {  0,  4,  5,   48},  { 32,  6,  5,   64},
     {  0,  7,  5,  128},  {  0,  8,  6,  256},
     {  0, 10,  6, 1024},  {  0, 12,  6, 4096},
     { 32,  0,  4,    0},  {  0,  0,  4,    1},
     {  0,  0,  5,    2},  { 32,  0,  5,    4},
     {  0,  0,  5,    5},  { 32,  0,  5,    7},
     {  0,  0,  5,    8},  { 32,  0,  5,   10},
     {  0,  0,  5,   11},  {  0,  0,  6,   13},
     { 32,  1,  5,   16},  {  0,  1,  5,   18},
     { 32,  1,  5,   22},  {  0,  2,  5,   24},
     { 32,  3,  5,   32},  {  0,  3,  5,   40},
     {  0,  6,  4,   64},  { 16,  6,  4,   64},
     { 32,  7,  5,  128},  {  0,  9,  6,  512},
     {  0, 11,  6, 2048},  { 48,  0,  4,    0},
     { 16,  0,  4,    1},  { 32,  0,  5,    2},
     { 32,  0,  5,    3},  { 32,  0,  5,    5},
     { 32,  0,  5,    6},  { 32,  0,  5,    8},
     { 32,  0,  5,    9},  { 32,  0,  5,   11},
     { 32,  0,  5,   12},  {  0,  0,  6,   15},
     { 32,  1,  5,   18},  { 32,  1,  5,   20},
     { 32,  2,  5,   24},  { 32,  2,  5,   28},
     { 32,  3,  5,   40},  { 32,  4,  5,   48},
     {  0, 16,  6,65536},  {  0, 15,  6,32768},
     {  0, 14,  6,16384},  {  0, 13,  6, 8192},
};   /* LL_defaultDTable */

/* Default FSE distribution table for Offset Codes */
static const ZSTD_seqSymbol OF_defaultDTable[(1<<OF_DEFAULTNORMLOG)+1] = {
    {  1,  1,  1, OF_DEFAULTNORMLOG},  /* header : fastMode, tableLog */
    /* nextState, nbAddBits, nbBits, baseVal */
    {  0,  0,  5,    0},     {  0,  6,  4,   61},
    {  0,  9,  5,  509},     {  0, 15,  5,32765},
    {  0, 21,  5,2097149},   {  0,  3,  5,    5},
    {  0,  7,  4,  125},     {  0, 12,  5, 4093},
    {  0, 18,  5,262141},    {  0, 23,  5,8388605},
    {  0,  5,  5,   29},     {  0,  8,  4,  253},
    {  0, 14,  5,16381},     {  0, 20,  5,1048573},
    {  0,  2,  5,    1},     { 16,  7,  4,  125},
    {  0, 11,  5, 2045},     {  0, 17,  5,131069},
    {  0, 22,  5,4194301},   {  0,  4,  5,   13},
    { 16,  8,  4,  253},     {  0, 13,  5, 8189},
    {  0, 19,  5,524285},    {  0,  1,  5,    1},
    { 16,  6,  4,   61},     {  0, 10,  5, 1021},
    {  0, 16,  5,65533},     {  0, 28,  5,268435453},
    {  0, 27,  5,134217725}, {  0, 26,  5,67108861},
    {  0, 25,  5,33554429},  {  0, 24,  5,16777213},
};   /* OF_defaultDTable */


/* Default FSE distribution table for Match Lengths */
static const ZSTD_seqSymbol ML_defaultDTable[(1<<ML_DEFAULTNORMLOG)+1] = {
    {  1,  1,  1, ML_DEFAULTNORMLOG},  /* header : fastMode, tableLog */
    /* nextState, nbAddBits, nbBits, baseVal */
    {  0,  0,  6,    3},  {  0,  0,  4,    4},
    { 32,  0,  5,    5},  {  0,  0,  5,    6},
    {  0,  0,  5,    8},  {  0,  0,  5,    9},
    {  0,  0,  5,   11},  {  0,  0,  6,   13},
    {  0,  0,  6,   16},  {  0,  0,  6,   19},
    {  0,  0,  6,   22},  {  0,  0,  6,   25},
    {  0,  0,  6,   28},  {  0,  0,  6,   31},
    {  0,  0,  6,   34},  {  0,  1,  6,   37},
    {  0,  1,  6,   41},  {  0,  2,  6,   47},
    {  0,  3,  6,   59},  {  0,  4,  6,   83},
    {  0,  7,  6,  131},  {  0,  9,  6,  515},
    { 16,  0,  4,    4},  {  0,  0,  4,    5},
    { 32,  0,  5,    6},  {  0,  0,  5,    7},
    { 32,  0,  5,    9},  {  0,  0,  5,   10},
    {  0,  0,  6,   12},  {  0,  0,  6,   15},
    {  0,  0,  6,   18},  {  0,  0,  6,   21},
    {  0,  0,  6,   24},  {  0,  0,  6,   27},
    {  0,  0,  6,   30},  {  0,  0,  6,   33},
    {  0,  1,  6,   35},  {  0,  1,  6,   39},
    {  0,  2,  6,   43},  {  0,  3,  6,   51},
    {  0,  4,  6,   67},  {  0,  5,  6,   99},
    {  0,  8,  6,  259},  { 32,  0,  4,    4},
    { 48,  0,  4,    4},  { 16,  0,  4,    5},
    { 32,  0,  5,    7},  { 32,  0,  5,    8},
    { 32,  0,  5,   10},  { 32,  0,  5,   11},
    {  0,  0,  6,   14},  {  0,  0,  6,   17},
    {  0,  0,  6,   20},  {  0,  0,  6,   23},
    {  0,  0,  6,   26},  {  0,  0,  6,   29},
    {  0,  0,  6,   32},  {  0, 16,  6,65539},
    {  0, 15,  6,32771},  {  0, 14,  6,16387},
    {  0, 13,  6, 8195},  {  0, 12,  6, 4099},
    {  0, 11,  6, 2051},  {  0, 10,  6, 1027},
};   /* ML_defaultDTable */


static void ZSTD_buildSeqTable_rle(ZSTD_seqSymbol* dt, U32 baseValue, U32 nbAddBits)
{
    void* ptr = dt;
    ZSTD_seqSymbol_header* const DTableH = (ZSTD_seqSymbol_header*)ptr;
    ZSTD_seqSymbol* const cell = dt + 1;

    DTableH->tableLog = 0;
    DTableH->fastMode = 0;

    cell->nbBits = 0;
    cell->nextState = 0;
    assert(nbAddBits < 255);
    cell->nbAdditionalBits = (BYTE)nbAddBits;
    cell->baseValue = baseValue;
}


/* ZSTD_buildFSETable() :
 * generate FSE decoding table for one symbol (ll, ml or off)
 * cannot fail if input is valid =>
 * all inputs are presumed validated at this stage */
void
ZSTD_buildFSETable(ZSTD_seqSymbol* dt,
            const short* normalizedCounter, unsigned maxSymbolValue,
            const U32* baseValue, const U32* nbAdditionalBits,
            unsigned tableLog)
{
    ZSTD_seqSymbol* const tableDecode = dt+1;
    U16 symbolNext[MaxSeq+1];

    U32 const maxSV1 = maxSymbolValue + 1;
    U32 const tableSize = 1 << tableLog;
    U32 highThreshold = tableSize-1;

    /* Sanity Checks */
    assert(maxSymbolValue <= MaxSeq);
    assert(tableLog <= MaxFSELog);

    /* Init, lay down lowprob symbols */
    {   ZSTD_seqSymbol_header DTableH;
        DTableH.tableLog = tableLog;
        DTableH.fastMode = 1;
        {   S16 const largeLimit= (S16)(1 << (tableLog-1));
            U32 s;
            for (s=0; s<maxSV1; s++) {
                if (normalizedCounter[s]==-1) {
                    tableDecode[highThreshold--].baseValue = s;
                    symbolNext[s] = 1;
                } else {
                    if (normalizedCounter[s] >= largeLimit) DTableH.fastMode=0;
                    assert(normalizedCounter[s]>=0);
                    symbolNext[s] = (U16)normalizedCounter[s];
        }   }   }
        memcpy(dt, &DTableH, sizeof(DTableH));
    }

    /* Spread symbols */
    {   U32 const tableMask = tableSize-1;
        U32 const step = FSE_TABLESTEP(tableSize);
        U32 s, position = 0;
        for (s=0; s<maxSV1; s++) {
            int i;
            for (i=0; i<normalizedCounter[s]; i++) {
                tableDecode[position].baseValue = s;
                position = (position + step) & tableMask;
                while (position > highThreshold) position = (position + step) & tableMask;   /* lowprob area */
        }   }
        assert(position == 0); /* position must reach all cells once, otherwise normalizedCounter is incorrect */
    }

    /* Build Decoding table */
    {   U32 u;
        for (u=0; u<tableSize; u++) {
            U32 const symbol = tableDecode[u].baseValue;
            U32 const nextState = symbolNext[symbol]++;
            tableDecode[u].nbBits = (BYTE) (tableLog - BIT_highbit32(nextState) );
            tableDecode[u].nextState = (U16) ( (nextState << tableDecode[u].nbBits) - tableSize);
            assert(nbAdditionalBits[symbol] < 255);
            tableDecode[u].nbAdditionalBits = (BYTE)nbAdditionalBits[symbol];
            tableDecode[u].baseValue = baseValue[symbol];
    }   }
}


/*! ZSTD_buildSeqTable() :
 * @return : nb bytes read from src,
 *           or an error code if it fails */
static size_t ZSTD_buildSeqTable(ZSTD_seqSymbol* DTableSpace, const ZSTD_seqSymbol** DTablePtr,
                                 symbolEncodingType_e type, unsigned max, U32 maxLog,
                                 const void* src, size_t srcSize,
                                 const U32* baseValue, const U32* nbAdditionalBits,
                                 const ZSTD_seqSymbol* defaultTable, U32 flagRepeatTable,
                                 int ddictIsCold, int nbSeq)
{
    switch(type)
    {
    case set_rle :
        RETURN_ERROR_IF(!srcSize, srcSize_wrong, "");
        RETURN_ERROR_IF((*(const BYTE*)src) > max, corruption_detected, "");
        {   U32 const symbol = *(const BYTE*)src;
            U32 const baseline = baseValue[symbol];
            U32 const nbBits = nbAdditionalBits[symbol];
            ZSTD_buildSeqTable_rle(DTableSpace, baseline, nbBits);
        }
        *DTablePtr = DTableSpace;
        return 1;
    case set_basic :
        *DTablePtr = defaultTable;
        return 0;
    case set_repeat:
        RETURN_ERROR_IF(!flagRepeatTable, corruption_detected, "");
        /* prefetch FSE table if used */
        if (ddictIsCold && (nbSeq > 24 /* heuristic */)) {
            const void* const pStart = *DTablePtr;
            size_t const pSize = sizeof(ZSTD_seqSymbol) * (SEQSYMBOL_TABLE_SIZE(maxLog));
            PREFETCH_AREA(pStart, pSize);
        }
        return 0;
    case set_compressed :
        {   unsigned tableLog;
            S16 norm[MaxSeq+1];
            size_t const headerSize = FSE_readNCount(norm, &max, &tableLog, src, srcSize);
            RETURN_ERROR_IF(FSE_isError(headerSize), corruption_detected, "");
            RETURN_ERROR_IF(tableLog > maxLog, corruption_detected, "");
            ZSTD_buildFSETable(DTableSpace, norm, max, baseValue, nbAdditionalBits, tableLog);
            *DTablePtr = DTableSpace;
            return headerSize;
        }
    default :
        assert(0);
        RETURN_ERROR(GENERIC, "impossible");
    }
}

size_t ZSTD_decodeSeqHeaders(ZSTD_DCtx* dctx, int* nbSeqPtr,
                             const void* src, size_t srcSize)
{
    const BYTE* const istart = (const BYTE* const)src;
    const BYTE* const iend = istart + srcSize;
    const BYTE* ip = istart;
    int nbSeq;
    DEBUGLOG(5, "ZSTD_decodeSeqHeaders");

    /* check */
    RETURN_ERROR_IF(srcSize < MIN_SEQUENCES_SIZE, srcSize_wrong, "");

    /* SeqHead */
    nbSeq = *ip++;
    if (!nbSeq) {
        *nbSeqPtr=0;
        RETURN_ERROR_IF(srcSize != 1, srcSize_wrong, "");
        return 1;
    }
    if (nbSeq > 0x7F) {
        if (nbSeq == 0xFF) {
            RETURN_ERROR_IF(ip+2 > iend, srcSize_wrong, "");
            nbSeq = MEM_readLE16(ip) + LONGNBSEQ, ip+=2;
        } else {
            RETURN_ERROR_IF(ip >= iend, srcSize_wrong, "");
            nbSeq = ((nbSeq-0x80)<<8) + *ip++;
        }
    }
    *nbSeqPtr = nbSeq;

    /* FSE table descriptors */
    RETURN_ERROR_IF(ip+1 > iend, srcSize_wrong, ""); /* minimum possible size: 1 byte for symbol encoding types */
    {   symbolEncodingType_e const LLtype = (symbolEncodingType_e)(*ip >> 6);
        symbolEncodingType_e const OFtype = (symbolEncodingType_e)((*ip >> 4) & 3);
        symbolEncodingType_e const MLtype = (symbolEncodingType_e)((*ip >> 2) & 3);
        ip++;

        /* Build DTables */
        {   size_t const llhSize = ZSTD_buildSeqTable(dctx->entropy.LLTable, &dctx->LLTptr,
                                                      LLtype, MaxLL, LLFSELog,
                                                      ip, iend-ip,
                                                      LL_base, LL_bits,
                                                      LL_defaultDTable, dctx->fseEntropy,
                                                      dctx->ddictIsCold, nbSeq);
            RETURN_ERROR_IF(ZSTD_isError(llhSize), corruption_detected, "ZSTD_buildSeqTable failed");
            ip += llhSize;
        }

        {   size_t const ofhSize = ZSTD_buildSeqTable(dctx->entropy.OFTable, &dctx->OFTptr,
                                                      OFtype, MaxOff, OffFSELog,
                                                      ip, iend-ip,
                                                      OF_base, OF_bits,
                                                      OF_defaultDTable, dctx->fseEntropy,
                                                      dctx->ddictIsCold, nbSeq);
            RETURN_ERROR_IF(ZSTD_isError(ofhSize), corruption_detected, "ZSTD_buildSeqTable failed");
            ip += ofhSize;
        }

        {   size_t const mlhSize = ZSTD_buildSeqTable(dctx->entropy.MLTable, &dctx->MLTptr,
                                                      MLtype, MaxML, MLFSELog,
                                                      ip, iend-ip,
                                                      ML_base, ML_bits,
                                                      ML_defaultDTable, dctx->fseEntropy,
                                                      dctx->ddictIsCold, nbSeq);
            RETURN_ERROR_IF(ZSTD_isError(mlhSize), corruption_detected, "ZSTD_buildSeqTable failed");
            ip += mlhSize;
        }
    }

    return ip-istart;
}


typedef struct {
    size_t litLength;
    size_t matchLength;
    size_t offset;
    const BYTE* match;
} seq_t;

typedef struct {
    size_t state;
    const ZSTD_seqSymbol* table;
} ZSTD_fseState;

typedef struct {
    BIT_DStream_t DStream;
    ZSTD_fseState stateLL;
    ZSTD_fseState stateOffb;
    ZSTD_fseState stateML;
    size_t prevOffset[ZSTD_REP_NUM];
    const BYTE* prefixStart;
    const BYTE* dictEnd;
    size_t pos;
} seqState_t;

/*! ZSTD_overlapCopy8() :
 *  Copies 8 bytes from ip to op and updates op and ip where ip <= op.
 *  If the offset is < 8 then the offset is spread to at least 8 bytes.
 *
 *  Precondition: *ip <= *op
 *  Postcondition: *op - *op >= 8
 */
HINT_INLINE void ZSTD_overlapCopy8(BYTE** op, BYTE const** ip, size_t offset) {
    assert(*ip <= *op);
    if (offset < 8) {
        /* close range match, overlap */
        static const U32 dec32table[] = { 0, 1, 2, 1, 4, 4, 4, 4 };   /* added */
        static const int dec64table[] = { 8, 8, 8, 7, 8, 9,10,11 };   /* subtracted */
        int const sub2 = dec64table[offset];
        (*op)[0] = (*ip)[0];
        (*op)[1] = (*ip)[1];
        (*op)[2] = (*ip)[2];
        (*op)[3] = (*ip)[3];
        *ip += dec32table[offset];
        ZSTD_copy4(*op+4, *ip);
        *ip -= sub2;
    } else {
        ZSTD_copy8(*op, *ip);
    }
    *ip += 8;
    *op += 8;
    assert(*op - *ip >= 8);
}

/*! ZSTD_safecopy() :
 *  Specialized version of memcpy() that is allowed to READ up to WILDCOPY_OVERLENGTH past the input buffer
 *  and write up to 16 bytes past oend_w (op >= oend_w is allowed).
 *  This function is only called in the uncommon case where the sequence is near the end of the block. It
 *  should be fast for a single long sequence, but can be slow for several short sequences.
 *
 *  @param ovtype controls the overlap detection
 *         - ZSTD_no_overlap: The source and destination are guaranteed to be at least WILDCOPY_VECLEN bytes apart.
 *         - ZSTD_overlap_src_before_dst: The src and dst may overlap and may be any distance apart.
 *           The src buffer must be before the dst buffer.
 */
static void ZSTD_safecopy(BYTE* op, BYTE* const oend_w, BYTE const* ip, ptrdiff_t length, ZSTD_overlap_e ovtype) {
    ptrdiff_t const diff = op - ip;
    BYTE* const oend = op + length;

    assert((ovtype == ZSTD_no_overlap && (diff <= -8 || diff >= 8 || op >= oend_w)) ||
           (ovtype == ZSTD_overlap_src_before_dst && diff >= 0));

    if (length < 8) {
        /* Handle short lengths. */
        while (op < oend) *op++ = *ip++;
        return;
    }
    if (ovtype == ZSTD_overlap_src_before_dst) {
        /* Copy 8 bytes and ensure the offset >= 8 when there can be overlap. */
        assert(length >= 8);
        ZSTD_overlapCopy8(&op, &ip, diff);
        assert(op - ip >= 8);
        assert(op <= oend);
    }

    if (oend <= oend_w) {
        /* No risk of overwrite. */
        ZSTD_wildcopy(op, ip, length, ovtype);
        return;
    }
    if (op <= oend_w) {
        /* Wildcopy until we get close to the end. */
        assert(oend > oend_w);
        ZSTD_wildcopy(op, ip, oend_w - op, ovtype);
        ip += oend_w - op;
        op = oend_w;
    }
    /* Handle the leftovers. */
    while (op < oend) *op++ = *ip++;
}

/* ZSTD_execSequenceEnd():
 * This version handles cases that are near the end of the output buffer. It requires
 * more careful checks to make sure there is no overflow. By separating out these hard
 * and unlikely cases, we can speed up the common cases.
 *
 * NOTE: This function needs to be fast for a single long sequence, but doesn't need
 * to be optimized for many small sequences, since those fall into ZSTD_execSequence().
 */
FORCE_NOINLINE
size_t ZSTD_execSequenceEnd(BYTE* op,
                            BYTE* const oend, seq_t sequence,
                            const BYTE** litPtr, const BYTE* const litLimit,
                            const BYTE* const prefixStart, const BYTE* const virtualStart, const BYTE* const dictEnd)
{
    BYTE* const oLitEnd = op + sequence.litLength;
    size_t const sequenceLength = sequence.litLength + sequence.matchLength;
    const BYTE* const iLitEnd = *litPtr + sequence.litLength;
    const BYTE* match = oLitEnd - sequence.offset;
    BYTE* const oend_w = oend - WILDCOPY_OVERLENGTH;

    /* bounds checks : careful of address space overflow in 32-bit mode */
    RETURN_ERROR_IF(sequenceLength > (size_t)(oend - op), dstSize_tooSmall, "last match must fit within dstBuffer");
    RETURN_ERROR_IF(sequence.litLength > (size_t)(litLimit - *litPtr), corruption_detected, "try to read beyond literal buffer");
    assert(op < op + sequenceLength);
    assert(oLitEnd < op + sequenceLength);

    /* copy literals */
    ZSTD_safecopy(op, oend_w, *litPtr, sequence.litLength, ZSTD_no_overlap);
    op = oLitEnd;
    *litPtr = iLitEnd;

    /* copy Match */
    if (sequence.offset > (size_t)(oLitEnd - prefixStart)) {
        /* offset beyond prefix */
        RETURN_ERROR_IF(sequence.offset > (size_t)(oLitEnd - virtualStart), corruption_detected, "");
        match = dictEnd - (prefixStart-match);
        if (match + sequence.matchLength <= dictEnd) {
            memmove(oLitEnd, match, sequence.matchLength);
            return sequenceLength;
        }
        /* span extDict & currentPrefixSegment */
        {   size_t const length1 = dictEnd - match;
            memmove(oLitEnd, match, length1);
            op = oLitEnd + length1;
            sequence.matchLength -= length1;
            match = prefixStart;
    }   }
    ZSTD_safecopy(op, oend_w, match, sequence.matchLength, ZSTD_overlap_src_before_dst);
    return sequenceLength;
}

HINT_INLINE
size_t ZSTD_execSequence(BYTE* op,
                         BYTE* const oend, seq_t sequence,
                         const BYTE** litPtr, const BYTE* const litLimit,
                         const BYTE* const prefixStart, const BYTE* const virtualStart, const BYTE* const dictEnd)
{
    BYTE* const oLitEnd = op + sequence.litLength;
    size_t const sequenceLength = sequence.litLength + sequence.matchLength;
    BYTE* const oMatchEnd = op + sequenceLength;   /* risk : address space overflow (32-bits) */
    BYTE* const oend_w = oend - WILDCOPY_OVERLENGTH;   /* risk : address space underflow on oend=NULL */
    const BYTE* const iLitEnd = *litPtr + sequence.litLength;
    const BYTE* match = oLitEnd - sequence.offset;

    assert(op != NULL /* Precondition */);
    assert(oend_w < oend /* No underflow */);
    /* Handle edge cases in a slow path:
     *   - Read beyond end of literals
     *   - Match end is within WILDCOPY_OVERLIMIT of oend
     *   - 32-bit mode and the match length overflows
     */
    if (UNLIKELY(
            iLitEnd > litLimit ||
            oMatchEnd > oend_w ||
            (MEM_32bits() && (size_t)(oend - op) < sequenceLength + WILDCOPY_OVERLENGTH)))
        return ZSTD_execSequenceEnd(op, oend, sequence, litPtr, litLimit, prefixStart, virtualStart, dictEnd);

    /* Assumptions (everything else goes into ZSTD_execSequenceEnd()) */
    assert(op <= oLitEnd /* No overflow */);
    assert(oLitEnd < oMatchEnd /* Non-zero match & no overflow */);
    assert(oMatchEnd <= oend /* No underflow */);
    assert(iLitEnd <= litLimit /* Literal length is in bounds */);
    assert(oLitEnd <= oend_w /* Can wildcopy literals */);
    assert(oMatchEnd <= oend_w /* Can wildcopy matches */);

    /* Copy Literals:
     * Split out litLength <= 16 since it is nearly always true. +1.6% on gcc-9.
     * We likely don't need the full 32-byte wildcopy.
     */
    assert(WILDCOPY_OVERLENGTH >= 16);
    ZSTD_copy16(op, (*litPtr));
    if (UNLIKELY(sequence.litLength > 16)) {
        ZSTD_wildcopy(op+16, (*litPtr)+16, sequence.litLength-16, ZSTD_no_overlap);
    }
    op = oLitEnd;
    *litPtr = iLitEnd;   /* update for next sequence */

    /* Copy Match */
    if (sequence.offset > (size_t)(oLitEnd - prefixStart)) {
        /* offset beyond prefix -> go into extDict */
        RETURN_ERROR_IF(UNLIKELY(sequence.offset > (size_t)(oLitEnd - virtualStart)), corruption_detected, "");
        match = dictEnd + (match - prefixStart);
        if (match + sequence.matchLength <= dictEnd) {
            memmove(oLitEnd, match, sequence.matchLength);
            return sequenceLength;
        }
        /* span extDict & currentPrefixSegment */
        {   size_t const length1 = dictEnd - match;
            memmove(oLitEnd, match, length1);
            op = oLitEnd + length1;
            sequence.matchLength -= length1;
            match = prefixStart;
    }   }
    /* Match within prefix of 1 or more bytes */
    assert(op <= oMatchEnd);
    assert(oMatchEnd <= oend_w);
    assert(match >= prefixStart);
    assert(sequence.matchLength >= 1);

    /* Nearly all offsets are >= WILDCOPY_VECLEN bytes, which means we can use wildcopy
     * without overlap checking.
     */
    if (LIKELY(sequence.offset >= WILDCOPY_VECLEN)) {
        /* We bet on a full wildcopy for matches, since we expect matches to be
         * longer than literals (in general). In silesia, ~10% of matches are longer
         * than 16 bytes.
         */
        ZSTD_wildcopy(op, match, (ptrdiff_t)sequence.matchLength, ZSTD_no_overlap);
        return sequenceLength;
    }
    assert(sequence.offset < WILDCOPY_VECLEN);

    /* Copy 8 bytes and spread the offset to be >= 8. */
    ZSTD_overlapCopy8(&op, &match, sequence.offset);

    /* If the match length is > 8 bytes, then continue with the wildcopy. */
    if (sequence.matchLength > 8) {
        assert(op < oMatchEnd);
        ZSTD_wildcopy(op, match, (ptrdiff_t)sequence.matchLength-8, ZSTD_overlap_src_before_dst);
    }
    return sequenceLength;
}

static void
ZSTD_initFseState(ZSTD_fseState* DStatePtr, BIT_DStream_t* bitD, const ZSTD_seqSymbol* dt)
{
    const void* ptr = dt;
    const ZSTD_seqSymbol_header* const DTableH = (const ZSTD_seqSymbol_header*)ptr;
    DStatePtr->state = BIT_readBits(bitD, DTableH->tableLog);
    DEBUGLOG(6, "ZSTD_initFseState : val=%u using %u bits",
                (U32)DStatePtr->state, DTableH->tableLog);
    BIT_reloadDStream(bitD);
    DStatePtr->table = dt + 1;
}

FORCE_INLINE_TEMPLATE void
ZSTD_updateFseState(ZSTD_fseState* DStatePtr, BIT_DStream_t* bitD)
{
    ZSTD_seqSymbol const DInfo = DStatePtr->table[DStatePtr->state];
    U32 const nbBits = DInfo.nbBits;
    size_t const lowBits = BIT_readBits(bitD, nbBits);
    DStatePtr->state = DInfo.nextState + lowBits;
}

FORCE_INLINE_TEMPLATE void
ZSTD_updateFseStateWithDInfo(ZSTD_fseState* DStatePtr, BIT_DStream_t* bitD, ZSTD_seqSymbol const DInfo)
{
    U32 const nbBits = DInfo.nbBits;
    size_t const lowBits = BIT_readBits(bitD, nbBits);
    DStatePtr->state = DInfo.nextState + lowBits;
}

/* We need to add at most (ZSTD_WINDOWLOG_MAX_32 - 1) bits to read the maximum
 * offset bits. But we can only read at most (STREAM_ACCUMULATOR_MIN_32 - 1)
 * bits before reloading. This value is the maximum number of bytes we read
 * after reloading when we are decoding long offsets.
 */
#define LONG_OFFSETS_MAX_EXTRA_BITS_32                       \
    (ZSTD_WINDOWLOG_MAX_32 > STREAM_ACCUMULATOR_MIN_32       \
        ? ZSTD_WINDOWLOG_MAX_32 - STREAM_ACCUMULATOR_MIN_32  \
        : 0)

typedef enum { ZSTD_lo_isRegularOffset, ZSTD_lo_isLongOffset=1 } ZSTD_longOffset_e;
typedef enum { ZSTD_p_noPrefetch=0, ZSTD_p_prefetch=1 } ZSTD_prefetch_e;

FORCE_INLINE_TEMPLATE seq_t
ZSTD_decodeSequence(seqState_t* seqState, const ZSTD_longOffset_e longOffsets, const ZSTD_prefetch_e prefetch)
{
    seq_t seq;
    ZSTD_seqSymbol const llDInfo = seqState->stateLL.table[seqState->stateLL.state];
    ZSTD_seqSymbol const mlDInfo = seqState->stateML.table[seqState->stateML.state];
    ZSTD_seqSymbol const ofDInfo = seqState->stateOffb.table[seqState->stateOffb.state];
    U32 const llBase = llDInfo.baseValue;
    U32 const mlBase = mlDInfo.baseValue;
    U32 const ofBase = ofDInfo.baseValue;
    BYTE const llBits = llDInfo.nbAdditionalBits;
    BYTE const mlBits = mlDInfo.nbAdditionalBits;
    BYTE const ofBits = ofDInfo.nbAdditionalBits;
    BYTE const totalBits = llBits+mlBits+ofBits;

    /* sequence */
    {   size_t offset;
        if (ofBits > 1) {
            ZSTD_STATIC_ASSERT(ZSTD_lo_isLongOffset == 1);
            ZSTD_STATIC_ASSERT(LONG_OFFSETS_MAX_EXTRA_BITS_32 == 5);
            assert(ofBits <= MaxOff);
            if (MEM_32bits() && longOffsets && (ofBits >= STREAM_ACCUMULATOR_MIN_32)) {
                U32 const extraBits = ofBits - MIN(ofBits, 32 - seqState->DStream.bitsConsumed);
                offset = ofBase + (BIT_readBitsFast(&seqState->DStream, ofBits - extraBits) << extraBits);
                BIT_reloadDStream(&seqState->DStream);
                if (extraBits) offset += BIT_readBitsFast(&seqState->DStream, extraBits);
                assert(extraBits <= LONG_OFFSETS_MAX_EXTRA_BITS_32);   /* to avoid another reload */
            } else {
                offset = ofBase + BIT_readBitsFast(&seqState->DStream, ofBits/*>0*/);   /* <=  (ZSTD_WINDOWLOG_MAX-1) bits */
                if (MEM_32bits()) BIT_reloadDStream(&seqState->DStream);
            }
            seqState->prevOffset[2] = seqState->prevOffset[1];
            seqState->prevOffset[1] = seqState->prevOffset[0];
            seqState->prevOffset[0] = offset;
        } else {
            U32 const ll0 = (llBase == 0);
            if (LIKELY((ofBits == 0))) {
                if (LIKELY(!ll0))
                    offset = seqState->prevOffset[0];
                else {
                    offset = seqState->prevOffset[1];
                    seqState->prevOffset[1] = seqState->prevOffset[0];
                    seqState->prevOffset[0] = offset;
                }
            } else {
                offset = ofBase + ll0 + BIT_readBitsFast(&seqState->DStream, 1);
                {   size_t temp = (offset==3) ? seqState->prevOffset[0] - 1 : seqState->prevOffset[offset];
                    temp += !temp;   /* 0 is not valid; input is corrupted; force offset to 1 */
                    if (offset != 1) seqState->prevOffset[2] = seqState->prevOffset[1];
                    seqState->prevOffset[1] = seqState->prevOffset[0];
                    seqState->prevOffset[0] = offset = temp;
        }   }   }
        seq.offset = offset;
    }

    seq.matchLength = mlBase;
    if (mlBits > 0)
        seq.matchLength += BIT_readBitsFast(&seqState->DStream, mlBits/*>0*/);

    if (MEM_32bits() && (mlBits+llBits >= STREAM_ACCUMULATOR_MIN_32-LONG_OFFSETS_MAX_EXTRA_BITS_32))
        BIT_reloadDStream(&seqState->DStream);
    if (MEM_64bits() && UNLIKELY(totalBits >= STREAM_ACCUMULATOR_MIN_64-(LLFSELog+MLFSELog+OffFSELog)))
        BIT_reloadDStream(&seqState->DStream);
    /* Ensure there are enough bits to read the rest of data in 64-bit mode. */
    ZSTD_STATIC_ASSERT(16+LLFSELog+MLFSELog+OffFSELog < STREAM_ACCUMULATOR_MIN_64);

    seq.litLength = llBase;
    if (llBits > 0)
        seq.litLength += BIT_readBitsFast(&seqState->DStream, llBits/*>0*/);

    if (MEM_32bits())
        BIT_reloadDStream(&seqState->DStream);

    DEBUGLOG(6, "seq: litL=%u, matchL=%u, offset=%u",
                (U32)seq.litLength, (U32)seq.matchLength, (U32)seq.offset);

    if (prefetch == ZSTD_p_prefetch) {
        size_t const pos = seqState->pos + seq.litLength;
        const BYTE* const matchBase = (seq.offset > pos) ? seqState->dictEnd : seqState->prefixStart;
        seq.match = matchBase + pos - seq.offset;  /* note : this operation can overflow when seq.offset is really too large, which can only happen when input is corrupted.
                                                    * No consequence though : no memory access will occur, offset is only used for prefetching */
        seqState->pos = pos + seq.matchLength;
    }

    /* ANS state update
     * gcc-9.0.0 does 2.5% worse with ZSTD_updateFseStateWithDInfo().
     * clang-9.2.0 does 7% worse with ZSTD_updateFseState().
     * Naturally it seems like ZSTD_updateFseStateWithDInfo() should be the
     * better option, so it is the default for other compilers. But, if you
     * measure that it is worse, please put up a pull request.
     */
    {
#if defined(__GNUC__) && !defined(__clang__)
        const int kUseUpdateFseState = 1;
#else
        const int kUseUpdateFseState = 0;
#endif
        if (kUseUpdateFseState) {
            ZSTD_updateFseState(&seqState->stateLL, &seqState->DStream);    /* <=  9 bits */
            ZSTD_updateFseState(&seqState->stateML, &seqState->DStream);    /* <=  9 bits */
            if (MEM_32bits()) BIT_reloadDStream(&seqState->DStream);    /* <= 18 bits */
            ZSTD_updateFseState(&seqState->stateOffb, &seqState->DStream);  /* <=  8 bits */
        } else {
            ZSTD_updateFseStateWithDInfo(&seqState->stateLL, &seqState->DStream, llDInfo);    /* <=  9 bits */
            ZSTD_updateFseStateWithDInfo(&seqState->stateML, &seqState->DStream, mlDInfo);    /* <=  9 bits */
            if (MEM_32bits()) BIT_reloadDStream(&seqState->DStream);    /* <= 18 bits */
            ZSTD_updateFseStateWithDInfo(&seqState->stateOffb, &seqState->DStream, ofDInfo);  /* <=  8 bits */
        }
    }

    return seq;
}

#ifdef FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION
MEM_STATIC int ZSTD_dictionaryIsActive(ZSTD_DCtx const* dctx, BYTE const* prefixStart, BYTE const* oLitEnd)
{
    size_t const windowSize = dctx->fParams.windowSize;
    /* No dictionary used. */
    if (dctx->dictContentEndForFuzzing == NULL) return 0;
    /* Dictionary is our prefix. */
    if (prefixStart == dctx->dictContentBeginForFuzzing) return 1;
    /* Dictionary is not our ext-dict. */
    if (dctx->dictEnd != dctx->dictContentEndForFuzzing) return 0;
    /* Dictionary is not within our window size. */
    if ((size_t)(oLitEnd - prefixStart) >= windowSize) return 0;
    /* Dictionary is active. */
    return 1;
}

MEM_STATIC void ZSTD_assertValidSequence(
        ZSTD_DCtx const* dctx,
        BYTE const* op, BYTE const* oend,
        seq_t const seq,
        BYTE const* prefixStart, BYTE const* virtualStart)
{
#if DEBUGLEVEL >= 1
    size_t const windowSize = dctx->fParams.windowSize;
    size_t const sequenceSize = seq.litLength + seq.matchLength;
    BYTE const* const oLitEnd = op + seq.litLength;
    DEBUGLOG(6, "Checking sequence: litL=%u matchL=%u offset=%u",
            (U32)seq.litLength, (U32)seq.matchLength, (U32)seq.offset);
    assert(op <= oend);
    assert((size_t)(oend - op) >= sequenceSize);
    assert(sequenceSize <= ZSTD_BLOCKSIZE_MAX);
    if (ZSTD_dictionaryIsActive(dctx, prefixStart, oLitEnd)) {
        size_t const dictSize = (size_t)((char const*)dctx->dictContentEndForFuzzing - (char const*)dctx->dictContentBeginForFuzzing);
        /* Offset must be within the dictionary. */
        assert(seq.offset <= (size_t)(oLitEnd - virtualStart));
        assert(seq.offset <= windowSize + dictSize);
    } else {
        /* Offset must be within our window. */
        assert(seq.offset <= windowSize);
    }
#else
    (void)dctx, (void)op, (void)oend, (void)seq, (void)prefixStart, (void)virtualStart;
#endif
}
#endif

#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG
FORCE_INLINE_TEMPLATE size_t
DONT_VECTORIZE
ZSTD_decompressSequences_body( ZSTD_DCtx* dctx,
                               void* dst, size_t maxDstSize,
                         const void* seqStart, size_t seqSize, int nbSeq,
                         const ZSTD_longOffset_e isLongOffset,
                         const int frame)
{
    const BYTE* ip = (const BYTE*)seqStart;
    const BYTE* const iend = ip + seqSize;
    BYTE* const ostart = (BYTE* const)dst;
    BYTE* const oend = ostart + maxDstSize;
    BYTE* op = ostart;
    const BYTE* litPtr = dctx->litPtr;
    const BYTE* const litEnd = litPtr + dctx->litSize;
    const BYTE* const prefixStart = (const BYTE*) (dctx->prefixStart);
    const BYTE* const vBase = (const BYTE*) (dctx->virtualStart);
    const BYTE* const dictEnd = (const BYTE*) (dctx->dictEnd);
    DEBUGLOG(5, "ZSTD_decompressSequences_body");
    (void)frame;

    /* Regen sequences */
    if (nbSeq) {
        seqState_t seqState;
        size_t error = 0;
        dctx->fseEntropy = 1;
        { U32 i; for (i=0; i<ZSTD_REP_NUM; i++) seqState.prevOffset[i] = dctx->entropy.rep[i]; }
        RETURN_ERROR_IF(
            ERR_isError(BIT_initDStream(&seqState.DStream, ip, iend-ip)),
            corruption_detected, "");
        ZSTD_initFseState(&seqState.stateLL, &seqState.DStream, dctx->LLTptr);
        ZSTD_initFseState(&seqState.stateOffb, &seqState.DStream, dctx->OFTptr);
        ZSTD_initFseState(&seqState.stateML, &seqState.DStream, dctx->MLTptr);
        assert(dst != NULL);

        ZSTD_STATIC_ASSERT(
                BIT_DStream_unfinished < BIT_DStream_completed &&
                BIT_DStream_endOfBuffer < BIT_DStream_completed &&
                BIT_DStream_completed < BIT_DStream_overflow);

#if defined(__GNUC__) && defined(__x86_64__)
        /* Align the decompression loop to 32 + 16 bytes.
         *
         * zstd compiled with gcc-9 on an Intel i9-9900k shows 10% decompression
         * speed swings based on the alignment of the decompression loop. This
         * performance swing is caused by parts of the decompression loop falling
         * out of the DSB. The entire decompression loop should fit in the DSB,
         * when it can't we get much worse performance. You can measure if you've
         * hit the good case or the bad case with this perf command for some
         * compressed file test.zst:
         *
         *   perf stat -e cycles -e instructions -e idq.all_dsb_cycles_any_uops \
         *             -e idq.all_mite_cycles_any_uops -- ./zstd -tq test.zst
         *
         * If you see most cycles served out of the MITE you've hit the bad case.
         * If you see most cycles served out of the DSB you've hit the good case.
         * If it is pretty even then you may be in an okay case.
         *
         * I've been able to reproduce this issue on the following CPUs:
         *   - Kabylake: Macbook Pro (15-inch, 2019) 2.4 GHz Intel Core i9
         *               Use Instruments->Counters to get DSB/MITE cycles.
         *               I never got performance swings, but I was able to
         *               go from the good case of mostly DSB to half of the
         *               cycles served from MITE.
         *   - Coffeelake: Intel i9-9900k
         *
         * I haven't been able to reproduce the instability or DSB misses on any
         * of the following CPUS:
         *   - Haswell
         *   - Broadwell: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GH
         *   - Skylake
         *
         * If you are seeing performance stability this script can help test.
         * It tests on 4 commits in zstd where I saw performance change.
         *
         *   https://gist.github.com/terrelln/9889fc06a423fd5ca6e99351564473f4
         */
        __asm__(".p2align 5");
        __asm__("nop");
        __asm__(".p2align 4");
#endif
        for ( ; ; ) {
            seq_t const sequence = ZSTD_decodeSequence(&seqState, isLongOffset, ZSTD_p_noPrefetch);
            size_t const oneSeqSize = ZSTD_execSequence(op, oend, sequence, &litPtr, litEnd, prefixStart, vBase, dictEnd);
#if defined(FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION) && defined(FUZZING_ASSERT_VALID_SEQUENCE)
            assert(!ZSTD_isError(oneSeqSize));
            if (frame) ZSTD_assertValidSequence(dctx, op, oend, sequence, prefixStart, vBase);
#endif
            DEBUGLOG(6, "regenerated sequence size : %u", (U32)oneSeqSize);
            BIT_reloadDStream(&(seqState.DStream));
            /* gcc and clang both don't like early returns in this loop.
             * gcc doesn't like early breaks either.
             * Instead save an error and report it at the end.
             * When there is an error, don't increment op, so we don't
             * overwrite.
             */
            if (UNLIKELY(ZSTD_isError(oneSeqSize))) error = oneSeqSize;
            else op += oneSeqSize;
            if (UNLIKELY(!--nbSeq)) break;
        }

        /* check if reached exact end */
        DEBUGLOG(5, "ZSTD_decompressSequences_body: after decode loop, remaining nbSeq : %i", nbSeq);
        if (ZSTD_isError(error)) return error;
        RETURN_ERROR_IF(nbSeq, corruption_detected, "");
        RETURN_ERROR_IF(BIT_reloadDStream(&seqState.DStream) < BIT_DStream_completed, corruption_detected, "");
        /* save reps for next block */
        { U32 i; for (i=0; i<ZSTD_REP_NUM; i++) dctx->entropy.rep[i] = (U32)(seqState.prevOffset[i]); }
    }

    /* last literal segment */
    {   size_t const lastLLSize = litEnd - litPtr;
        RETURN_ERROR_IF(lastLLSize > (size_t)(oend-op), dstSize_tooSmall, "");
        if (op != NULL) {
            memcpy(op, litPtr, lastLLSize);
            op += lastLLSize;
        }
    }

    return op-ostart;
}

static size_t
ZSTD_decompressSequences_default(ZSTD_DCtx* dctx,
                                 void* dst, size_t maxDstSize,
                           const void* seqStart, size_t seqSize, int nbSeq,
                           const ZSTD_longOffset_e isLongOffset,
                           const int frame)
{
    return ZSTD_decompressSequences_body(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
}
#endif /* ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG */

#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT
FORCE_INLINE_TEMPLATE size_t
ZSTD_decompressSequencesLong_body(
                               ZSTD_DCtx* dctx,
                               void* dst, size_t maxDstSize,
                         const void* seqStart, size_t seqSize, int nbSeq,
                         const ZSTD_longOffset_e isLongOffset,
                         const int frame)
{
    const BYTE* ip = (const BYTE*)seqStart;
    const BYTE* const iend = ip + seqSize;
    BYTE* const ostart = (BYTE* const)dst;
    BYTE* const oend = ostart + maxDstSize;
    BYTE* op = ostart;
    const BYTE* litPtr = dctx->litPtr;
    const BYTE* const litEnd = litPtr + dctx->litSize;
    const BYTE* const prefixStart = (const BYTE*) (dctx->prefixStart);
    const BYTE* const dictStart = (const BYTE*) (dctx->virtualStart);
    const BYTE* const dictEnd = (const BYTE*) (dctx->dictEnd);
    (void)frame;

    /* Regen sequences */
    if (nbSeq) {
#define STORED_SEQS 4
#define STORED_SEQS_MASK (STORED_SEQS-1)
#define ADVANCED_SEQS 4
        seq_t sequences[STORED_SEQS];
        int const seqAdvance = MIN(nbSeq, ADVANCED_SEQS);
        seqState_t seqState;
        int seqNb;
        dctx->fseEntropy = 1;
        { int i; for (i=0; i<ZSTD_REP_NUM; i++) seqState.prevOffset[i] = dctx->entropy.rep[i]; }
        seqState.prefixStart = prefixStart;
        seqState.pos = (size_t)(op-prefixStart);
        seqState.dictEnd = dictEnd;
        assert(dst != NULL);
        assert(iend >= ip);
        RETURN_ERROR_IF(
            ERR_isError(BIT_initDStream(&seqState.DStream, ip, iend-ip)),
            corruption_detected, "");
        ZSTD_initFseState(&seqState.stateLL, &seqState.DStream, dctx->LLTptr);
        ZSTD_initFseState(&seqState.stateOffb, &seqState.DStream, dctx->OFTptr);
        ZSTD_initFseState(&seqState.stateML, &seqState.DStream, dctx->MLTptr);

        /* prepare in advance */
        for (seqNb=0; (BIT_reloadDStream(&seqState.DStream) <= BIT_DStream_completed) && (seqNb<seqAdvance); seqNb++) {
            sequences[seqNb] = ZSTD_decodeSequence(&seqState, isLongOffset, ZSTD_p_prefetch);
            PREFETCH_L1(sequences[seqNb].match); PREFETCH_L1(sequences[seqNb].match + sequences[seqNb].matchLength - 1); /* note : it's safe to invoke PREFETCH() on any memory address, including invalid ones */
        }
        RETURN_ERROR_IF(seqNb<seqAdvance, corruption_detected, "");

        /* decode and decompress */
        for ( ; (BIT_reloadDStream(&(seqState.DStream)) <= BIT_DStream_completed) && (seqNb<nbSeq) ; seqNb++) {
            seq_t const sequence = ZSTD_decodeSequence(&seqState, isLongOffset, ZSTD_p_prefetch);
            size_t const oneSeqSize = ZSTD_execSequence(op, oend, sequences[(seqNb-ADVANCED_SEQS) & STORED_SEQS_MASK], &litPtr, litEnd, prefixStart, dictStart, dictEnd);
#if defined(FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION) && defined(FUZZING_ASSERT_VALID_SEQUENCE)
            assert(!ZSTD_isError(oneSeqSize));
            if (frame) ZSTD_assertValidSequence(dctx, op, oend, sequences[(seqNb-ADVANCED_SEQS) & STORED_SEQS_MASK], prefixStart, dictStart);
#endif
            if (ZSTD_isError(oneSeqSize)) return oneSeqSize;
            PREFETCH_L1(sequence.match); PREFETCH_L1(sequence.match + sequence.matchLength - 1); /* note : it's safe to invoke PREFETCH() on any memory address, including invalid ones */
            sequences[seqNb & STORED_SEQS_MASK] = sequence;
            op += oneSeqSize;
        }
        RETURN_ERROR_IF(seqNb<nbSeq, corruption_detected, "");

        /* finish queue */
        seqNb -= seqAdvance;
        for ( ; seqNb<nbSeq ; seqNb++) {
            size_t const oneSeqSize = ZSTD_execSequence(op, oend, sequences[seqNb&STORED_SEQS_MASK], &litPtr, litEnd, prefixStart, dictStart, dictEnd);
#if defined(FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION) && defined(FUZZING_ASSERT_VALID_SEQUENCE)
            assert(!ZSTD_isError(oneSeqSize));
            if (frame) ZSTD_assertValidSequence(dctx, op, oend, sequences[seqNb&STORED_SEQS_MASK], prefixStart, dictStart);
#endif
            if (ZSTD_isError(oneSeqSize)) return oneSeqSize;
            op += oneSeqSize;
        }

        /* save reps for next block */
        { U32 i; for (i=0; i<ZSTD_REP_NUM; i++) dctx->entropy.rep[i] = (U32)(seqState.prevOffset[i]); }
    }

    /* last literal segment */
    {   size_t const lastLLSize = litEnd - litPtr;
        RETURN_ERROR_IF(lastLLSize > (size_t)(oend-op), dstSize_tooSmall, "");
        if (op != NULL) {
            memcpy(op, litPtr, lastLLSize);
            op += lastLLSize;
        }
    }

    return op-ostart;
}

static size_t
ZSTD_decompressSequencesLong_default(ZSTD_DCtx* dctx,
                                 void* dst, size_t maxDstSize,
                           const void* seqStart, size_t seqSize, int nbSeq,
                           const ZSTD_longOffset_e isLongOffset,
                           const int frame)
{
    return ZSTD_decompressSequencesLong_body(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
}
#endif /* ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT */



#if DYNAMIC_BMI2

#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG
static TARGET_ATTRIBUTE("bmi2") size_t
DONT_VECTORIZE
ZSTD_decompressSequences_bmi2(ZSTD_DCtx* dctx,
                                 void* dst, size_t maxDstSize,
                           const void* seqStart, size_t seqSize, int nbSeq,
                           const ZSTD_longOffset_e isLongOffset,
                           const int frame)
{
    return ZSTD_decompressSequences_body(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
}
#endif /* ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG */

#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT
static TARGET_ATTRIBUTE("bmi2") size_t
ZSTD_decompressSequencesLong_bmi2(ZSTD_DCtx* dctx,
                                 void* dst, size_t maxDstSize,
                           const void* seqStart, size_t seqSize, int nbSeq,
                           const ZSTD_longOffset_e isLongOffset,
                           const int frame)
{
    return ZSTD_decompressSequencesLong_body(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
}
#endif /* ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT */

#endif /* DYNAMIC_BMI2 */

typedef size_t (*ZSTD_decompressSequences_t)(
                            ZSTD_DCtx* dctx,
                            void* dst, size_t maxDstSize,
                            const void* seqStart, size_t seqSize, int nbSeq,
                            const ZSTD_longOffset_e isLongOffset,
                            const int frame);

#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG
static size_t
ZSTD_decompressSequences(ZSTD_DCtx* dctx, void* dst, size_t maxDstSize,
                   const void* seqStart, size_t seqSize, int nbSeq,
                   const ZSTD_longOffset_e isLongOffset,
                   const int frame)
{
    DEBUGLOG(5, "ZSTD_decompressSequences");
#if DYNAMIC_BMI2
    if (dctx->bmi2) {
        return ZSTD_decompressSequences_bmi2(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
    }
#endif
  return ZSTD_decompressSequences_default(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
}
#endif /* ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG */


#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT
/* ZSTD_decompressSequencesLong() :
 * decompression function triggered when a minimum share of offsets is considered "long",
 * aka out of cache.
 * note : "long" definition seems overloaded here, sometimes meaning "wider than bitstream register", and sometimes meaning "farther than memory cache distance".
 * This function will try to mitigate main memory latency through the use of prefetching */
static size_t
ZSTD_decompressSequencesLong(ZSTD_DCtx* dctx,
                             void* dst, size_t maxDstSize,
                             const void* seqStart, size_t seqSize, int nbSeq,
                             const ZSTD_longOffset_e isLongOffset,
                             const int frame)
{
    DEBUGLOG(5, "ZSTD_decompressSequencesLong");
#if DYNAMIC_BMI2
    if (dctx->bmi2) {
        return ZSTD_decompressSequencesLong_bmi2(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
    }
#endif
  return ZSTD_decompressSequencesLong_default(dctx, dst, maxDstSize, seqStart, seqSize, nbSeq, isLongOffset, frame);
}
#endif /* ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT */



#if !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT) && \
    !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG)
/* ZSTD_getLongOffsetsShare() :
 * condition : offTable must be valid
 * @return : "share" of long offsets (arbitrarily defined as > (1<<23))
 *           compared to maximum possible of (1<<OffFSELog) */
static unsigned
ZSTD_getLongOffsetsShare(const ZSTD_seqSymbol* offTable)
{
    const void* ptr = offTable;
    U32 const tableLog = ((const ZSTD_seqSymbol_header*)ptr)[0].tableLog;
    const ZSTD_seqSymbol* table = offTable + 1;
    U32 const max = 1 << tableLog;
    U32 u, total = 0;
    DEBUGLOG(5, "ZSTD_getLongOffsetsShare: (tableLog=%u)", tableLog);

    assert(max <= (1 << OffFSELog));  /* max not too large */
    for (u=0; u<max; u++) {
        if (table[u].nbAdditionalBits > 22) total += 1;
    }

    assert(tableLog <= OffFSELog);
    total <<= (OffFSELog - tableLog);  /* scale to OffFSELog */

    return total;
}
#endif

size_t
ZSTD_decompressBlock_internal(ZSTD_DCtx* dctx,
                              void* dst, size_t dstCapacity,
                        const void* src, size_t srcSize, const int frame)
{   /* blockType == blockCompressed */
    const BYTE* ip = (const BYTE*)src;
    /* isLongOffset must be true if there are long offsets.
     * Offsets are long if they are larger than 2^STREAM_ACCUMULATOR_MIN.
     * We don't expect that to be the case in 64-bit mode.
     * In block mode, window size is not known, so we have to be conservative.
     * (note: but it could be evaluated from current-lowLimit)
     */
    ZSTD_longOffset_e const isLongOffset = (ZSTD_longOffset_e)(MEM_32bits() && (!frame || (dctx->fParams.windowSize > (1ULL << STREAM_ACCUMULATOR_MIN))));
    DEBUGLOG(5, "ZSTD_decompressBlock_internal (size : %u)", (U32)srcSize);

    RETURN_ERROR_IF(srcSize >= ZSTD_BLOCKSIZE_MAX, srcSize_wrong, "");

    /* Decode literals section */
    {   size_t const litCSize = ZSTD_decodeLiteralsBlock(dctx, src, srcSize);
        DEBUGLOG(5, "ZSTD_decodeLiteralsBlock : %u", (U32)litCSize);
        if (ZSTD_isError(litCSize)) return litCSize;
        ip += litCSize;
        srcSize -= litCSize;
    }

    /* Build Decoding Tables */
    {
        /* These macros control at build-time which decompressor implementation
         * we use. If neither is defined, we do some inspection and dispatch at
         * runtime.
         */
#if !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT) && \
    !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG)
        int usePrefetchDecoder = dctx->ddictIsCold;
#endif
        int nbSeq;
        size_t const seqHSize = ZSTD_decodeSeqHeaders(dctx, &nbSeq, ip, srcSize);
        if (ZSTD_isError(seqHSize)) return seqHSize;
        ip += seqHSize;
        srcSize -= seqHSize;

        RETURN_ERROR_IF(dst == NULL && nbSeq > 0, dstSize_tooSmall, "NULL not handled");

#if !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT) && \
    !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG)
        if ( !usePrefetchDecoder
          && (!frame || (dctx->fParams.windowSize > (1<<24)))
          && (nbSeq>ADVANCED_SEQS) ) {  /* could probably use a larger nbSeq limit */
            U32 const shareLongOffsets = ZSTD_getLongOffsetsShare(dctx->OFTptr);
            U32 const minShare = MEM_64bits() ? 7 : 20; /* heuristic values, correspond to 2.73% and 7.81% */
            usePrefetchDecoder = (shareLongOffsets >= minShare);
        }
#endif

        dctx->ddictIsCold = 0;

#if !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT) && \
    !defined(ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG)
        if (usePrefetchDecoder)
#endif
#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT
            return ZSTD_decompressSequencesLong(dctx, dst, dstCapacity, ip, srcSize, nbSeq, isLongOffset, frame);
#endif

#ifndef ZSTD_FORCE_DECOMPRESS_SEQUENCES_LONG
        /* else */
        return ZSTD_decompressSequences(dctx, dst, dstCapacity, ip, srcSize, nbSeq, isLongOffset, frame);
#endif
    }
}


void ZSTD_checkContinuity(ZSTD_DCtx* dctx, const void* dst)
{
    if (dst != dctx->previousDstEnd) {   /* not contiguous */
        dctx->dictEnd = dctx->previousDstEnd;
        dctx->virtualStart = (const char*)dst - ((const char*)(dctx->previousDstEnd) - (const char*)(dctx->prefixStart));
        dctx->prefixStart = dst;
        dctx->previousDstEnd = dst;
    }
}


size_t ZSTD_decompressBlock(ZSTD_DCtx* dctx,
                            void* dst, size_t dstCapacity,
                      const void* src, size_t srcSize)
{
    size_t dSize;
    ZSTD_checkContinuity(dctx, dst);
    dSize = ZSTD_decompressBlock_internal(dctx, dst, dstCapacity, src, srcSize, /* frame */ 0);
    dctx->previousDstEnd = (char*)dst + dSize;
    return dSize;
}
/**** ended inlining decompress/zstd_decompress_block.c ****/
