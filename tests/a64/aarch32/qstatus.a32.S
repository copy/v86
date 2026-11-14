// Native MRS must expose NZCVQ/GE and mode/masks, while hiding T/IT.
    .syntax unified
    .arm
base:
    .word 4
    .word aflags - base, 0, 3
    .word acond - base, 0, 3
    .word tflags - base + 1, 0, 3
    .word tit - base + 1, 0, 3
    .macro flags_loop name
\name:
    movw r12, #128
1:  msr apsr_nzcvqg, r0
    mrs r1, apsr
    ror r0, r0, #3
    eor r0, r0, r1
    subs r12, r12, #1
    bne 1b
    mrs r2, apsr
    svc #0
    .endm
    flags_loop aflags
acond:
    movw r12, #128
1:  cmp r12, #64
    mrseq r1, apsr
    mrsne r2, apsr
    subs r12, r12, #1
    bne 1b
    svc #0
    .thumb
    flags_loop tflags
tit:
    movw r12, #128
1:  cmp r12, #64
    ite eq
    mrseq r1, apsr
    mrsne r2, apsr
    subs r12, r12, #1
    bne 1b
    svc #0
