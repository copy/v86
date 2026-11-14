// IT memory cache hits, false conditions and precise exception ITSTATE.
    .syntax unified
    .thumb
base:
    .word 6
    .word mixed - base + 1, 0, 0
    .word false_load - base + 1, 0, 0
    .word first_fault - base + 1, 0, 0
    .word second_fault - base + 1, 0, 0
    .word store_fault - base + 1, 0, 0
    .word writeback - base + 1, 0, 0
    .macro warm
    adr r0, data
    movs r12, #128
1:  cmp r12, #0
    itt ne
    ldrne r1, [r0]
    strne r1, [r0, #4]
    subs r12, r12, #1
    bne 1b
    .endm
mixed:
    warm
    movs r2, #0
    cmp r2, #0
    ite eq
    ldreq r3, [r0]
    strne r2, [r0, #4]
    svc #0
false_load:
    warm
    movs r0, #0
    cmp r0, #0
    itt ne
    ldrne r1, [r0]
    strne r1, [r0]
    svc #0
first_fault:
    warm
    movs r0, #0
    cmp r0, #0
    itt eq
    ldreq r1, [r0]
    addeq r2, #4
    svc #0
second_fault:
    warm
    movs r2, #0
    cmp r2, #0
    itt eq
    ldreq r1, [r0]
    ldreq r3, [r2]
    svc #0
store_fault:
    warm
    movs r0, #0
    cmp r0, #0
    ite eq
    streq r1, [r0]
    movne r3, #9
    svc #0
writeback:
    warm
    cmp r12, #0
    itt eq
    ldreq r2, [r0], #4
    streq r2, [r0]
    svc #0
    .balign 4
data:
    .word 0x12345678, 0
