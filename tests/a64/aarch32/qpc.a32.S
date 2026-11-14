// PIC uses the halfword PC + 4, including at instruction addresses 2 mod 4.
// Repeat both alignments until their blocks are hot for native compilation.
    .syntax unified
    .thumb
base:
    .word 8
    .word add0 - base + 1, 0, 3
    .word add2 - base + 1, 0, 3
    .word mov0 - base + 1, 0, 3
    .word mov2 - base + 1, 0, 3
    .word high0 - base + 1, 0, 3
    .word high2 - base + 1, 0, 3
    .word it_true - base + 1, 0, 3
    .word it_false - base + 1, 0, 3
    .macro pc_loop name, operation, pad, destination=r0
\name:
    movw r12, #128
    .balign 4
    .if \pad
    nop
    .endif
1:  \operation \destination, pc
    mrs r11, apsr
    subs.w r12, r12, #1
    bne 1b
    nop
    nop
    svc #0
    .endm
    pc_loop add0, add, 0
    pc_loop add2, add, 1
    pc_loop mov0, mov, 0
    pc_loop mov2, mov, 1
    pc_loop high0, add, 0, r8
    pc_loop high2, mov, 1, r8
it_true:
    movw r12, #128
1:  cmp r12, #0
    itt ne
    addne r0, pc
    movne r8, pc
    mrs r11, apsr
    subs.w r12, r12, #1
    bne 1b
    svc #0
it_false:
    movw r12, #128
1:  cmp r12, #0
    itt eq
    addeq r0, pc
    moveq r8, pc
    mrs r11, apsr
    subs.w r12, r12, #1
    bne 1b
    svc #0
