// AArch32 EL0 cases of docs/aarch32-plan.md Q4.4 (tests/a64/aarch32_el0.mjs,
// A64_AARCH32_CASES=q4): CPACR_EL1.FPEN traps floating point and Advanced
// SIMD at EL0 (EC 0x07, CV 1, COND 0xE) when it is 00 or 01; an encoding
// that is UNDEFINED is UNDEFINED first; an instruction that fails its
// condition does not trap; with 11 they run.
// The table: count, then per case offset (+1: T32), resumes, NZCV (bit 8:
// CPACR_EL1.FPEN from bits 5:4).
    .syntax unified
    .arm
    .fpu crypto-neon-fp-armv8
base:
    .word   10
    .word   a32_vadd - base, 0, 0x100           @ FPEN 00
    .word   t32_vmrs - base + 1, 0, 0x110       @ FPEN 01: EL1 only
    .word   a32_vadd_ne - base, 0, 0x104        @ FPEN 00, Z: VADDNE does not run
    .word   a32_vmov_scalar - base, 0, 0x100
    .word   a32_vjcvt - base, 0, 0x100          @ UNDEFINED: not in the profile
    .word   a32_vsel - base, 0, 0x100
    .word   t32_vldr - base + 1, 0, 0x110
    .word   a32_vstm - base, 0, 0x100
    .word   a32_fp_on - base, 0, 0x130          @ FPEN 11
    .word   t32_it_vmov - base + 1, 0, 0x104    @ FPEN 00, Z: in an IT block

a32_vadd:
    vadd.f32 s0, s1, s2
    svc     #1

    .thumb
    .balign 2
t32_vmrs:
    vmrs    r0, fpscr
    svc     #2
    .arm
    .balign 4

a32_vadd_ne:
    vaddne.f32 s0, s1, s2
    svc     #3

a32_vmov_scalar:
    vmov.u8 r0, d1[3]
    svc     #4

a32_vjcvt:
    .word   0xeef90bc0                          @ VJCVT.S32.F64 s1, d0
    svc     #5

a32_vsel:
    vseleq.f64 d0, d1, d2
    svc     #6

    .thumb
    .balign 2
t32_vldr:
    vldr    d0, [sp, #-8]
    svc     #7
    .arm
    .balign 4

a32_vstm:
    vpush   {d8-d9}
    svc     #8

a32_fp_on:
    vmov    s0, r1
    vmov.f32 s1, #1.5
    vadd.f32 s2, s0, s1
    vmov    r2, s2
    vmrs    r3, fpscr
    vcmp.f32 s2, s1
    vmrs    APSR_nzcv, fpscr
    svc     #9

    .thumb
    .balign 2
t32_it_vmov:
    it      ne
    vmovne  s0, r1
    vmov    r0, s0
    svc     #10
