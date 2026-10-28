// AArch32 EL0 cases for v86's choices among CONSTRAINED UNPREDICTABLE
// behaviours (tests/a64/aarch32_unpredictable.mjs, which knows the values:
// QEMU 9.2 takes some of these as UNDEFINED). T32's LDM and STM (encoding
// T2) of one register transfer it, as Cortex-A cores do: IA and DB, with
// and without writeback, LR and the PC (a return), in an IT block, in a
// loop; A32's LDM of one register (not UNPREDICTABLE) the same. The other
// UNPREDICTABLE lists stay UNDEFINED: the base in the list with writeback,
// an empty list, SP in the list, STM of the PC. The instructions are words
// (.inst.w) so that the assembler cannot turn them into LDR and STR.
// The table: count, then per case offset (+1: T32), resumes, NZCV.
    .syntax unified
    .arm
base:
    .word   15
    .word   t32_ldm_wb - base + 1, 0, 0
    .word   t32_ldm - base + 1, 0, 0
    .word   t32_stm_wb - base + 1, 0, 0
    .word   t32_stm - base + 1, 0, 0
    .word   t32_ldmdb_wb - base + 1, 0, 0
    .word   t32_stmdb_wb - base + 1, 0, 0
    .word   t32_ldm_lr - base + 1, 0, 0
    .word   t32_ldm_pc - base + 1, 0, 0
    .word   t32_ldm_it - base + 1, 0, 0
    .word   t32_ldm_loop - base + 1, 0, 0
    .word   a32_ldm_wb - base, 0, 0
    .word   t32_ldm_base_wb - base + 1, 0, 0
    .word   t32_ldm_empty - base + 1, 0, 0
    .word   t32_ldm_sp - base + 1, 0, 0
    .word   t32_stm_pc - base + 1, 0, 0

    .thumb
// (each: r8 a buffer below SP, r9 its address, r10 how far r8 moved)
t32_ldm_wb:
    sub     r8, sp, #64
    mov     r9, r8
    movw    r1, #0x3344
    movt    r1, #0x1122
    str     r1, [r8]
    .inst.w 0xe8b80001          @ ldm.w r8!, {r0}
    sub     r10, r8, r9
    svc     #1

t32_ldm:
    sub     r8, sp, #64
    mov     r9, r8
    movw    r1, #0x7788
    movt    r1, #0x5566
    str     r1, [r8]
    .inst.w 0xe8980001          @ ldm.w r8, {r0}
    sub     r10, r8, r9
    svc     #2

t32_stm_wb:
    sub     r8, sp, #64
    mov     r9, r8
    movs    r0, #0
    str     r0, [r8]
    str     r0, [r8, #4]
    movw    r1, #0xBBCC
    movt    r1, #0x99AA
    .inst.w 0xe8a80002          @ stm.w r8!, {r1}
    ldr     r0, [r9]
    ldr     r2, [r9, #4]
    sub     r10, r8, r9
    svc     #3

t32_stm:
    sub     r8, sp, #64
    mov     r9, r8
    movs    r0, #0
    str     r0, [r8]
    movw    r1, #0xFF00
    movt    r1, #0xDDEE
    .inst.w 0xe8880002          @ stm.w r8, {r1}
    ldr     r0, [r9]
    sub     r10, r8, r9
    svc     #4

t32_ldmdb_wb:
    sub     r8, sp, #64
    mov     r9, r8
    movw    r1, #0x2468
    movt    r1, #0x1357
    str     r1, [r8, #-4]
    .inst.w 0xe9380001          @ ldmdb r8!, {r0}
    sub     r10, r8, r9
    svc     #5

t32_stmdb_wb:
    sub     r8, sp, #64
    mov     r9, r8
    movs    r0, #0
    str     r0, [r8, #-4]
    str     r0, [r8]
    movw    r1, #0x8642
    movt    r1, #0x7531
    .inst.w 0xe9280002          @ stmdb r8!, {r1}
    ldr     r0, [r9, #-4]
    ldr     r2, [r9]
    sub     r10, r8, r9
    svc     #6

t32_ldm_lr:
    sub     r8, sp, #64
    mov     r9, r8
    movw    r1, #0xCAFE
    movt    r1, #0xC0DE
    str     r1, [r8]
    .inst.w 0xe8b84000          @ ldm.w r8!, {lr}
    sub     r10, r8, r9
    svc     #7

t32_ldm_pc:
    sub     r8, sp, #64
    mov     r9, r8
    adr     r1, 1f + 1
    str     r1, [r8]
    .inst.w 0xe8988000          @ ldm.w r8, {pc}
    udf     #1
    .balign 4
1:  movs    r0, #0x42
    sub     r10, r8, r9
    svc     #8

t32_ldm_it:
    sub     r8, sp, #64
    mov     r9, r8
    movw    r1, #0x1111
    movt    r1, #0x2222
    str     r1, [r8]
    str     r1, [r8, #4]
    movs    r0, #0
    movs    r2, #0
    cmp     r0, #0
    .inst.n 0xbf08              @ it eq
    .inst.w 0xe8b80001          @ ldmeq.w r8!, {r0}
    .inst.n 0xbf18              @ it ne
    .inst.w 0xe8b80004          @ ldmne.w r8!, {r2} (not taken)
    sub     r10, r8, r9
    svc     #9

t32_ldm_loop:
    sub     r8, sp, #64
    mov     r9, r8
    movs    r0, #1
    str     r0, [r8]
    movs    r0, #2
    str     r0, [r8, #4]
    movs    r0, #3
    str     r0, [r8, #8]
    movs    r5, #3
    movs    r6, #0
1:  .inst.w 0xe8b80001          @ ldm.w r8!, {r0}
    add     r6, r0
    subs    r5, #1
    bne     1b
    sub     r10, r8, r9
    svc     #10

    .arm
    .balign 4
a32_ldm_wb:
    sub     r8, sp, #64
    mov     r9, r8
    movw    r1, #0x5A5A
    movt    r1, #0xA5A5
    str     r1, [r8]
    .inst   0xe8b80001          @ ldm r8!, {r0}
    sub     r10, r8, r9
    svc     #11

    .thumb
    .balign 2
// (UNDEFINED: the driver prints the exit, ELR at the instruction)
t32_ldm_base_wb:
    sub     r8, sp, #64
    .inst.w 0xe8b80100          @ ldm.w r8!, {r8}
    svc     #12

t32_ldm_empty:
    sub     r8, sp, #64
    .inst.w 0xe8980000          @ ldm.w r8, {}
    svc     #13

t32_ldm_sp:
    sub     r8, sp, #64
    .inst.w 0xe8982000          @ ldm.w r8, {sp}
    svc     #14

t32_stm_pc:
    sub     r8, sp, #64
    .inst.w 0xe8888000          @ stm.w r8, {pc}
    svc     #15
