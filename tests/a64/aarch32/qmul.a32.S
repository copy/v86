// Long multiply destinations may overlap sources. Check both instruction
// sets, signedness, accumulation overflow, N/Z and preserved C/V against
// the interpreter and QEMU through aarch32_page.mjs / aarch32_el0.mjs.
    .syntax unified
    .arm
base:
    .word 14
    .word au - base, 0, 3
    .word aa - base, 0, 3
    .word as - base, 0, 3
    .word asa - base, 0, 3
    .word aua - base, 0, 3
    .word overlap - base, 0, 3
    .word conditional - base, 0, 3
    .word zero - base, 0, 3
    .word negative - base, 0, 3
    .word tu - base + 1, 0, 3
    .word ta - base + 1, 0, 3
    .word ts - base + 1, 0, 3
    .word tsa - base + 1, 0, 3
    .word tua - base + 1, 0, 3

    .macro product name, instruction
\name:
    movw r0, #0xffff
    movt r0, #0xffff
    movw r1, #0xabcd
    movt r1, #0x8000
    mov r12, #128
1:  \instruction r2, r3, r0, r1
    mrs r11, apsr
    eor r0, r0, r2
    add r1, r1, r3
    subs r12, r12, #1
    bne 1b
    svc #0
    .endm
    product au, umulls
    product aa, umlals
    product as, smulls
    product asa, smlals
    product aua, umaal
overlap:
    umull r0, r1, r0, r1
    umlal r2, r3, r2, r3
    smlal r4, r5, r5, r4
    umaal r6, r7, r6, r7
    svc #0
conditional:
    umulleq r0, r1, r2, r3
    umlalne r4, r5, r6, r7
    svc #0
zero:
    mov r0, #0
    umulls r2, r3, r0, r1
    svc #0
negative:
    mvn r0, #0
    mov r1, #1
    smulls r2, r3, r0, r1
    svc #0
    .thumb
    product tu, umull
    product ta, umlal
    product ts, smull
    product tsa, smlal
    product tua, umaal
