@ The A32 or T32 build's start (tests/a64/aarch32_bench.mjs): R0 the
@ iterations; bench_main's result in R0 to EL1 by an SVC.
    .syntax unified
    .section .text.start, "ax"
    .global _start
#ifdef THUMB
    .thumb
    .thumb_func
#else
    .arm
#endif
_start:
    ldr     sp, =__stack_top
    bl      bench_main
    svc     #0
    .pool
