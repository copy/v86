// AArch32 EL0 debug cases of docs/aarch32-plan.md Q1.5
// (tests/a64/aarch32_el0.mjs, A64_AARCH32_DRIVER=debug
// A64_AARCH32_CASES=qdebug): software step through A32 and T32 code (an IT
// block, a 32-bit instruction, a load exclusive: ESR's EX), breakpoints on an
// A32 instruction and on either halfword of a T32 word, watchpoints on loads
// and stores (FAR, WnR), a breakpoint on an instruction that fails its
// condition. The table: count, then per case offset (+1: T32), resumes, the
// control word (tests/a64/aarch32/debug.c), the breakpoint's offset.
    .syntax unified
    .arm
base:
    .word   9
    .word   a32_steps - base, 6, 0x10, 0
    .word   t32_steps - base + 1, 9, 0x10, 0
    .word   a32_ldrex - base, 3, 0x10, 0
    .word   a32_steps - base, 1, 0x20, a32_target - base
    .word   t32_steps - base + 1, 1, 0x60, t32_low - base       @ BAS 0011
    .word   t32_steps - base + 1, 1, 0xA0, t32_high - base - 2  @ BAS 1100
    .word   a32_watch - base, 1, 0x300, 0                       @ LSC 01: loads
    .word   a32_watch - base, 1, 0x500, 0                       @ LSC 10: stores
    .word   a32_cond - base, 1, 0x26, a32_cond_target - base    @ Z, C

a32_steps:
    mov     r0, #1
    add     r0, r0, #2
a32_target:
    lsl     r0, r0, #3
    nop
    svc     #1

    .thumb
    .balign 4
t32_steps:
    movs    r2, #5
    cmp     r2, #5
    itte    eq
    moveq   r3, #1
t32_low:
    addeq   r3, r3, #1
t32_high:
    movne   r4, #9
    add.w   r5, r3, r2, lsl #2
    nop
    svc     #2
    .arm
    .balign 4

a32_ldrex:
    ldrex   r2, [r1]
    strex   r3, r2, [r1]
    svc     #3

a32_watch:
    ldr     r2, [r1, #4]
    str     r2, [r1, #16]
    strh    r2, [r1, #6]
    ldrb    r3, [r1, #20]
    svc     #4

a32_cond:
a32_cond_target:
    movne   r0, #5
    moveq   r0, #6
    svc     #5
