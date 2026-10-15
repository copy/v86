#ifndef A64_STDIO_H
#define A64_STDIO_H
#include <stdarg.h>
#include <stddef.h>
int printf(const char *format, ...) __attribute__((format(printf, 1, 2)));
int sprintf(char *out, const char *format, ...) __attribute__((format(printf, 2, 3)));
int snprintf(char *out, size_t size, const char *format, ...) __attribute__((format(printf, 3, 4)));
int asprintf(char **out, const char *format, ...) __attribute__((format(printf, 2, 3)));
int vprintf(const char *format, va_list args);
int vsnprintf(char *out, size_t size, const char *format, va_list args);
int vasprintf(char **out, const char *format, va_list args);
int puts(const char *s);
int putchar(int c);
#endif
