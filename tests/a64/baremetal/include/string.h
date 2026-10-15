#ifndef A64_STRING_H
#define A64_STRING_H
#include <stddef.h>
void *memcpy(void *to, const void *from, size_t n);
void *memset(void *to, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
#endif
