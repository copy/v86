// AArch32 EL0 cases of docs/aarch32-plan.md Q2.3, Q3.2, Q3.3
// (tests/a64/aarch32_el0.mjs, A64_AARCH32_CASES=q3): branches and
// interworking in both directions (B, BL, BX, BLX, loads of the PC, the
// ALU's writes of it), CBZ and CBNZ, TBB and TBH, conditional branches,
// and IT blocks: conditions, the flags 16-bit instructions do not set in
// them, and an exception in the middle of one (ITSTATE in SPSR_EL1) whose
// return goes on with the block. A load-exclusive that spins (the same
// doubleword again and again: the interpreter's yield) overwriting its
// base register.
// The table: count, then per case offset (+1: T32), resumes, NZCV.
    .syntax unified
    .arm
base:
    .word   20
    .word   a32_branches - base, 0, 0
    .word   a32_bl - base, 0, 0
    .word   a32_bx_t32 - base, 0, 0
    .word   a32_blx_imm - base, 0, 0
    .word   a32_ldr_pc - base, 0, 0
    .word   a32_alu_pc - base, 0, 0
    .word   a32_ldm_pc - base, 0, 0
    .word   a32_cond_branch - base, 0, 6     @ Z, C
    .word   t32_branches - base + 1, 0, 0
    .word   t32_bl_blx - base + 1, 0, 0
    .word   t32_cbz - base + 1, 0, 0
    .word   t32_tbb - base + 1, 0, 0
    .word   t32_pop_pc - base + 1, 0, 0
    .word   t32_cond_branch - base + 1, 0, 8 @ N
    .word   t32_it - base + 1, 0, 0
    .word   t32_it_flags - base + 1, 0, 0
    .word   t32_it_svc - base + 1, 2, 0
    .word   t32_it_else - base + 1, 0, 0
    .word   a32_ldrexd_spin - base, 0, 0
    .word   t32_ldrexd_spin - base + 1, 0, 0

a32_branches:
    b       1f
    udf     #1
2:  svc     #1
1:  b       2b

a32_bl:
    bl      1f
    svc     #2
1:  mov     r0, lr
    sub     r0, r0, pc
    svc     #3

a32_bx_t32:
    adr     r1, 1f + 1
    bx      r1
    .thumb
1:  movs    r2, #42
    adr     r3, 2f
    bx      r3
    .balign 4
    .arm
2:  svc     #4

a32_blx_imm:
    blx     1f
    svc     #5
    .thumb
    .balign 2
1:  movs    r4, #7
    bx      lr
    .arm

a32_ldr_pc:
    adr     r0, 1f + 1
    str     r0, [sp, #-4]!
    ldr     pc, [sp], #4
    udf     #2
    .thumb
1:  movs    r5, #9
    svc     #6
    .arm
    .balign 4

a32_alu_pc:
    adr     r6, 1f + 1
    mov     pc, r6
    udf     #3
    .thumb
1:  movs    r7, #11
    svc     #7
    .arm
    .balign 4

a32_ldm_pc:
    adr     r3, 1f + 1
    movw    r2, #0x5678
    push    {r2, r3}
    ldm     sp!, {r2, pc}
    udf     #4
    .thumb
1:  svc     #8
    .arm
    .balign 4

a32_cond_branch:
    bne     1f
    bcc     1f
    beq     2f
1:  udf     #5
2:  svc     #9

    .thumb
    .balign 2
t32_branches:
    b       1f
    udf     #6
2:  b.w     3f
    udf     #7
1:  b       2b
3:  svc     #10

t32_bl_blx:
    bl      1f
    svc     #11
1:  mov     r8, lr
    blx     2f
    svc     #12
    .arm
    .balign 4
2:  mov     r9, lr
    bx      lr
    .thumb

t32_cbz:
    movs    r0, #0
    movs    r1, #1
    cbz     r1, 1f
    cbz     r0, 2f
1:  udf     #8
2:  cbnz    r0, 4f
    cbnz    r1, 3f
4:  udf     #9
3:  svc     #13

t32_tbb:
    movs    r0, #2
    tbb     [pc, r0]
4:  .byte   (5f - 4b) / 2, (5f - 4b) / 2, (6f - 4b) / 2, (5f - 4b) / 2
5:  udf     #10
6:  movs    r1, #1
    tbh     [pc, r1, lsl #1]
7:  .hword  (8f - 7b) / 2, (9f - 7b) / 2
8:  udf     #11
9:  svc     #14

t32_pop_pc:
    adr     r0, 1f + 1
    push    {r0}
    pop     {pc}
    udf     #12
    .balign 2
1:  adr     r3, 2f + 1
    str     r3, [sp, #-4]!
    ldr.w   pc, [sp], #4
    udf     #13
    .balign 4
2:  mov     r1, pc
    adds    r1, #4
    mov     pc, r1
    udf     #16
    svc     #15

t32_cond_branch:
    beq     1f
    bmi.w   2f
1:  udf     #14
2:  bpl     1b
    bmi     3f
    udf     #15
3:  svc     #16

t32_it:
    movs    r0, #5
    cmp     r0, #5
    ittet   eq
    moveq   r1, #1
    addeq   r1, r1, #2
    movne   r2, #3
    moveq   r3, #4
    svc     #17

t32_it_flags:
    movs    r0, #0
    cmp     r0, #1                  @ N, not Z, not C
    it      ne
    addne   r0, r0, #1              @ 16-bit ADD: no flags in the block
    svc     #18

t32_it_svc:
    movs    r0, #1
    cmp     r0, #1
    itttt   eq
    moveq   r1, #1
    svceq   #19
    moveq   r2, #2
    svceq   #20
    movs    r3, #3
    svc     #21

t32_it_else:
    movs    r0, #1
    cmp     r0, #2
    itete   eq
    moveq   r1, #1
    movne   r2, #2
    moveq   r3, #3
    movne   r4, #4
    svc     #22

t32_ldrexd_spin:
    mov     r3, sp
    movs    r4, #0x55
    movs    r5, #0x66
    strd    r4, r5, [r3]
    movs    r2, #100
1:  mov     r0, r3
    ldrexd  r4, r0, [r0]
    clrex
    subs    r2, #1
    bne     1b
    svc     #23

    .arm
    .balign 4
a32_ldrexd_spin:
    mov     r3, sp
    mov     r4, #0x77
    mov     r5, #0x88
    strd    r4, r5, [r3]
    mov     r2, #100
1:  mov     r1, r3
    ldrexd  r0, r1, [r1]
    clrex
    subs    r2, r2, #1
    bne     1b
    svc     #24
