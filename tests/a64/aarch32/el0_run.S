// AArch32 EL0 from the bare-metal EL1 (docs/aarch32-plan.md Q0.2):
// a32_run(entry, spsr, regs) ERETs to `entry` with SPSR_EL1 `spsr` and
// R0-R14 (W0-W14) from regs[15]; the lower-EL handler (el0.c) makes the
// exception that comes back return to a32_resume_el1, which returns from
// a32_run with the callee-saved registers and the stack it had.
// a32_run_fp(entry, spsr, regs, fp) also sets V0-V15, FPSR and FPCR from
// fp (16 Q registers, then FPSR, FPCR) and stores them back there on the
// way out (the EL1 code in between uses no FP or SIMD register).

    .text
    .global a32_run_fp
a32_run_fp:
    adrp    x9, a32_fp_state
    str     x3, [x9, :lo12:a32_fp_state]
    ldp     q0, q1, [x3, #0]
    ldp     q2, q3, [x3, #32]
    ldp     q4, q5, [x3, #64]
    ldp     q6, q7, [x3, #96]
    ldp     q8, q9, [x3, #128]
    ldp     q10, q11, [x3, #160]
    ldp     q12, q13, [x3, #192]
    ldp     q14, q15, [x3, #224]
    ldr     x10, [x3, #256]
    msr     fpsr, x10
    ldr     x10, [x3, #264]
    msr     fpcr, x10
    b       1f

    .global a32_run
a32_run:
    adrp    x9, a32_fp_state
    str     xzr, [x9, :lo12:a32_fp_state]
1:  adrp    x9, a32_context
    add     x9, x9, :lo12:a32_context
    stp     x19, x20, [x9, #0]
    stp     x21, x22, [x9, #16]
    stp     x23, x24, [x9, #32]
    stp     x25, x26, [x9, #48]
    stp     x27, x28, [x9, #64]
    stp     x29, x30, [x9, #80]
    mov     x10, sp
    str     x10, [x9, #96]
    msr     elr_el1, x0
    msr     spsr_el1, x1
    mov     x16, x2
    ldp     w0, w1, [x16, #0]
    ldp     w2, w3, [x16, #8]
    ldp     w4, w5, [x16, #16]
    ldp     w6, w7, [x16, #24]
    ldp     w8, w9, [x16, #32]
    ldp     w10, w11, [x16, #40]
    ldp     w12, w13, [x16, #48]
    ldr     w14, [x16, #56]
    mov     x16, #0
    isb
    eret

    .global a32_resume_el1
a32_resume_el1:
    adrp    x9, a32_fp_state
    ldr     x3, [x9, :lo12:a32_fp_state]
    cbz     x3, 1f
    stp     q0, q1, [x3, #0]
    stp     q2, q3, [x3, #32]
    stp     q4, q5, [x3, #64]
    stp     q6, q7, [x3, #96]
    stp     q8, q9, [x3, #128]
    stp     q10, q11, [x3, #160]
    stp     q12, q13, [x3, #192]
    stp     q14, q15, [x3, #224]
    mrs     x10, fpsr
    str     x10, [x3, #256]
    mrs     x10, fpcr
    str     x10, [x3, #264]
1:  adrp    x9, a32_context
    add     x9, x9, :lo12:a32_context
    ldp     x19, x20, [x9, #0]
    ldp     x21, x22, [x9, #16]
    ldp     x23, x24, [x9, #32]
    ldp     x25, x26, [x9, #48]
    ldp     x27, x28, [x9, #64]
    ldp     x29, x30, [x9, #80]
    ldr     x10, [x9, #96]
    mov     sp, x10
    ret

    .bss
    .balign 16
a32_context:
    .space  112
a32_fp_state:
    .space  8
