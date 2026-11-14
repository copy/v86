// Accumulating extensions: sign, rotation, wrapping, overlap and IT.
    .syntax unified
    .arm
base:
    .word 14
    .word aa - base, 0, 3
    .word ab - base, 0, 3
    .word ac - base, 0, 3
    .word ad - base, 0, 3
    .word ae - base, 0, 3
    .word af - base, 0, 3
    .word ta - base + 1, 0, 3
    .word tb - base + 1, 0, 3
    .word tc - base + 1, 0, 3
    .word td - base + 1, 0, 3
    .word te - base + 1, 0, 3
    .word tf - base + 1, 0, 3
    .word tit - base + 1, 0, 3
    .word plain - base + 1, 0, 3
    .macro extension name, instruction:vararg
\name:
    movw r12, #128
1:  \instruction
    ror r1, r1, #3
    mrs r11, apsr
    subs r12, r12, #1
    bne 1b
    svc #0
    .endm
    extension aa, sxtab r0, r0, r1
    extension ab, sxtah r0, r0, r1, ror #8
    extension ac, uxtabne r0, r0, r1, ror #16
    extension ad, uxtah r0, r0, r1, ror #24
    extension ae, uxtah r0, r0, r1
    extension af, uxtah r0, r0, r0
    .thumb
    extension ta, sxtab r0, r0, r1
    extension tb, sxtah r0, r0, r1, ror #8
    extension tc, uxtab r0, r0, r1, ror #16
    extension td, uxtah r0, r0, r1, ror #24
    extension te, uxtah r0, r0, r1
    extension tf, uxtah r0, r0, r0
tit:
    movw r12, #128
1:  cmp r12, #64
    ite ne
    sxtahne r0, r0, r1, ror #8
    uxtabeq r2, r0, r1, ror #24
    mrs r11, apsr
    subs r12, r12, #1
    bne 1b
    svc #0
    extension plain, sxth r0, r1, ror #24
