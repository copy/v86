#ifndef A64_INTTYPES_H
#define A64_INTTYPES_H
#include <stdint.h>
// LP64, as glibc on aarch64
#define PRId32 "d"
#define PRIi32 "i"
#define PRIu32 "u"
#define PRIx32 "x"
#define PRIX32 "X"
#define PRId64 "ld"
#define PRIi64 "li"
#define PRIu64 "lu"
#define PRIx64 "lx"
#define PRIX64 "lX"
#endif
