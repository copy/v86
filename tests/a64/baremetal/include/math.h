#ifndef A64_MATH_H
#define A64_MATH_H
#define NAN (__builtin_nanf(""))
#define INFINITY (__builtin_inff())
#define M_E 2.7182818284590452354
#define M_PI 3.14159265358979323846
#define signbit(x) __builtin_signbit(x)
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
float fmaf(float a, float b, float c);
double fma(double a, double b, double c);
#endif
