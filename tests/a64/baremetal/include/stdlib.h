#ifndef A64_STDLIB_H
#define A64_STDLIB_H
#include <stddef.h>
void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void free(void *pointer);
void abort(void) __attribute__((noreturn));
void exit(int status) __attribute__((noreturn));
#endif
