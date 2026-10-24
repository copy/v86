// AArch32 EL0 from the bare-metal EL1 (docs/aarch32-plan.md Q0.2):
// a32_run(entry, spsr, regs) ERETs to `entry` with SPSR_EL1 `spsr` and
// R0-R14 (W0-W14) from regs[15]; the lower-EL handler (el0.c) makes the
// exception that comes back return to a32_resume_el1, which returns from
// a32_run with the callee-saved registers and the stack it had.

    .text
    .global a32_run
a32_run:
    adrp    x9, a32_context
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
    adrp    x9, a32_context
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
