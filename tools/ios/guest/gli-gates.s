// Preserve Darwin ARM's register and stack arguments when a native GLI
// object shares an entry point with the experimental host provider.
.syntax unified
.arm
.text
.macro gate slot
.globl _n90_gli_\slot
.private_extern _n90_gli_\slot
_n90_gli_\slot:
    push {r0-r3, r4, lr}
    mov r1, sp
    mov r0, #\slot
    bl _n90_gli_target
    mov r12, r0
    pop {r0-r3, r4, lr}
    bx r12
.endm
gate 5
gate 7
gate 8
gate 9
gate 10
gate 11
gate 12
gate 13
gate 14
gate 16
gate 17
