// AArch32 EL0 cases of docs/aarch32-plan.md Q1 (tests/a64/aarch32_el0.mjs):
// the exception entry and return between AArch32 EL0 and AArch64 EL1 with
// the instructions Q1 has: NOP, B, SVC (and UDF), in A32 and T32.
// The table: count, then per case offset (+1: T32), resumes, NZCV.
    .syntax unified
    .arm
base:
    .word   10
    .word   a32_svc - base, 0, 0
    .word   a32_branch - base, 0, 0
    .word   a32_svc_imm - base, 0, 0
    .word   a32_resume - base, 2, 0
    .word   a32_udf - base, 0, 0
    .word   a32_cond - base, 0, 4       @ Z
    .word   a32_flags - base, 0, 0xA    @ N and C
    .word   t32_svc - base + 1, 0, 0
    .word   t32_resume - base + 1, 1, 0
    .word   t32_udf - base + 1, 0, 0

a32_svc:
    nop
    svc     #0
a32_branch:
    b       1f
    udf     #1
1:  svc     #1
a32_svc_imm:
    svc     #0x12abcd
a32_resume:
    svc     #2
    svc     #3
    svc     #4
a32_udf:
    udf     #0x1234
a32_cond:
    svcne   #5
    svceq   #6
a32_flags:
    svc     #7

    .thumb
t32_svc:
    nop
    svc     #8
t32_resume:
    svc     #9
    svc     #10
t32_udf:
    udf     #3
