#ifndef A32_INTTYPES_H
#define A32_INTTYPES_H
#include <stdint.h>
// ILP32, as glibc on armhf
#define PRId32 "d"
#define PRIi32 "i"
#define PRIu32 "u"
#define PRIx32 "x"
#define PRIX32 "X"
#define PRId64 "lld"
#define PRIi64 "lli"
#define PRIu64 "llu"
#define PRIx64 "llx"
#define PRIX64 "llX"
#endif
