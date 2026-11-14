// Boundary widths, sign extension, overlapping registers and IT conditions.
    .syntax unified
    .arm
base:
    .word 17
    .word au32 - base, 0, 3
    .word au1 - base, 0, 3
    .word as32 - base, 0, 3
    .word as5 - base, 0, 3
    .word ai - base, 0, 3
    .word ac - base, 0, 3
    .word ac32 - base, 0, 3
    .word ao - base, 0, 3
    .word tu32 - base + 1, 0, 3
    .word tu1 - base + 1, 0, 3
    .word ts32 - base + 1, 0, 3
    .word ts5 - base + 1, 0, 3
    .word ti - base + 1, 0, 3
    .word tc - base + 1, 0, 3
    .word tc32 - base + 1, 0, 3
    .word to - base + 1, 0, 3
    .word tit - base + 1, 0, 3
    .macro field name, instruction:vararg
\name:
    movw r12, #128
1:  \instruction
    ror r1, r1, #3
    mrs r11, apsr
    subs r12, r12, #1
    bne 1b
    svc #0
    .endm
    field au32, ubfx r0, r1, #0, #32
    field au1, ubfx r0, r1, #31, #1
    field as32, sbfx r0, r1, #0, #32
    field as5, sbfx r0, r1, #27, #5
    field ai, bfi r0, r1, #12, #20
    field ac, bfc r0, #12, #20
    field ac32, bfc r0, #0, #32
    field ao, bfi r0, r0, #1, #31
    .thumb
    field tu32, ubfx r0, r1, #0, #32
    field tu1, ubfx r0, r1, #31, #1
    field ts32, sbfx r0, r1, #0, #32
    field ts5, sbfx r0, r1, #27, #5
    field ti, bfi r0, r1, #12, #20
    field tc, bfc r0, #12, #20
    field tc32, bfc r0, #0, #32
    field to, bfi r0, r0, #1, #31
tit:
    movw r12, #128
1:  cmp r12, #64
    itt ne
    bfcne r0, #3, #5
    ubfxne r2, r0, #4, #7
    mrs r11, apsr
    subs r12, r12, #1
    bne 1b
    svc #0
