// Entry of the bare-metal AArch32 guests (tests/a32/runner.mjs): a raw
// image at RAM + 0x10000, entered in SVC mode with the MMU off and r2 the
// DTB's address (QEMU's -kernel of a 32-bit kernel, the v86 virt loader's
// cpu_type "arm32"). Secondary cores, started with PSCI CPU_ON, enter at
// a32_secondary with their core number in r0.
//
// Each core has 64 KiB below __stack_top - 64 KiB * core: SVC's stack at the
// top, then System's (and User's) 16 KiB down, and 4 KiB each for ABT,
// UND, IRQ and FIQ further down.

    .syntax unified
    .arm
    .section .text.head, "ax"
    .global _start
_start:
    mov     r4, r2
    mov     r0, #0
    bl      cpu_setup
    ldr     r1, =__bss_start
    ldr     r2, =_end
    mov     r3, #0
1:  cmp     r1, r2
    strlo   r3, [r1], #4
    blo     1b
    mov     r0, r4
    bl      a32_start
2:  wfi
    b       2b

    .global a32_secondary
a32_secondary:
    mov     r4, r0
    bl      cpu_setup
    mov     r0, r4
    bl      a64_secondary_start
3:  wfi
    b       3b

// the modes' stacks for core r0, VFP and Advanced SIMD on (CPACR cp10 and
// cp11 full access, FPEXC.EN), the vectors at VBAR; ends in SVC mode
cpu_setup:
    ldr     r1, =__stack_top
    sub     r1, r1, r0, lsl #16
    mov     r2, lr
    cps     #0x1F
    sub     sp, r1, #0x4000
    cps     #0x17
    sub     sp, r1, #0xC000
    cps     #0x1B
    sub     sp, r1, #0xD000
    cps     #0x12
    sub     sp, r1, #0xE000
    cps     #0x11
    sub     sp, r1, #0xF000
    cps     #0x13
    mov     sp, r1
    mov     r1, #(0xF << 20)
    mcr     p15, 0, r1, c1, c0, 2
    isb
    mov     r1, #(1 << 30)
    vmsr    fpexc, r1
    ldr     r1, =a32_vectors
    mcr     p15, 0, r1, c12, c0, 0
    isb
    bx      r2

// The vectors: each saves R0-R12, its preferred return address and SPSR
// (struct a32_frame, SRS) on its mode's stack and calls
// a32_exception(frame, kind), then returns with RFE to the (possibly
// changed) frame
    .macro vector kind, mode, adjust
    .if \adjust
    sub     lr, lr, #\adjust
    .endif
    srsdb   sp!, #\mode
    push    {r0-r12}
    mov     r0, sp
    mov     r1, #\kind
    // (AAPCS: an 8-byte aligned stack; the frame is 15 words)
    sub     sp, sp, #4
    bl      a32_exception
    add     sp, sp, #4
    pop     {r0-r12}
    rfeia   sp!
    .endm

    .balign 32
    .global a32_vectors
a32_vectors:
    b       .
    b       und_vector
    b       svc_vector
    b       pabt_vector
    b       dabt_vector
    b       .
    b       irq_vector
    b       fiq_vector

und_vector:
    vector  1, 0x1B, 0
svc_vector:
    vector  2, 0x13, 0
pabt_vector:
    vector  3, 0x17, 4
dabt_vector:
    vector  4, 0x17, 8
irq_vector:
    vector  6, 0x12, 4
fiq_vector:
    vector  7, 0x11, 4

    .ltorg
