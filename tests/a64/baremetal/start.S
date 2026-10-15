// Entry of the bare-metal AArch64 guests (tests/a64/guest_runner.mjs): an
// arm64 Image header (Linux Documentation/arch/arm64/booting.rst), so QEMU's
// -kernel and the v86 virt loader both load it at RAM + 0x80000 and enter at
// EL1 with the MMU off and x0 = the DTB's address. Secondary cores, started
// with PSCI CPU_ON, enter at a64_secondary with their core number in x0.

    .section .text.head, "ax"
    .global _start
_start:
    b       entry
    .word   0
    .quad   0x80000                 // text_offset
    .quad   __image_size            // image_size (with the BSS)
    .quad   0                       // flags: little-endian
    .quad   0, 0, 0
    .word   0x644d5241              // "ARM\x64"
    .word   0

entry:
    mov     x19, x0
    bl      cpu_setup
    ldr     x1, =__stack_top
    mov     sp, x1
    ldr     x1, =__bss_start
    ldr     x2, =_end
1:  cmp     x1, x2
    b.hs    2f
    str     xzr, [x1], #8
    b       1b
2:  mov     x0, x19
    bl      a64_start
3:  wfi
    b       3b

    .global a64_secondary
a64_secondary:
    mov     x19, x0
    bl      cpu_setup
    ldr     x1, =__stack_top
    lsl     x2, x19, #16            // 64 KiB of stack per core
    sub     x1, x1, x2
    mov     sp, x1
    mov     x0, x19
    bl      a64_secondary_start
4:  wfi
    b       4b

// FP and SIMD on (CPACR_EL1.FPEN), the vectors installed
cpu_setup:
    mov     x1, #(3 << 20)
    msr     cpacr_el1, x1
    adr     x1, a64_vectors
    msr     vbar_el1, x1
    isb
    ret

// Each vector saves x0-x30, ELR_EL1 and SPSR_EL1 (struct a64_frame) and calls
// a64_exception(frame, vector), which returns to the (possibly changed) ELR.
    .macro vector n
    .balign 128
    sub     sp, sp, #272
    stp     x0, x1, [sp]
    mov     x1, #\n
    b       vector_common
    .endm

    .text
    .balign 2048
    .global a64_vectors
a64_vectors:
    .irp n, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    vector \n
    .endr

vector_common:
    stp     x2, x3, [sp, #16]
    stp     x4, x5, [sp, #32]
    stp     x6, x7, [sp, #48]
    stp     x8, x9, [sp, #64]
    stp     x10, x11, [sp, #80]
    stp     x12, x13, [sp, #96]
    stp     x14, x15, [sp, #112]
    stp     x16, x17, [sp, #128]
    stp     x18, x19, [sp, #144]
    stp     x20, x21, [sp, #160]
    stp     x22, x23, [sp, #176]
    stp     x24, x25, [sp, #192]
    stp     x26, x27, [sp, #208]
    stp     x28, x29, [sp, #224]
    mrs     x2, elr_el1
    stp     x30, x2, [sp, #240]
    mrs     x2, spsr_el1
    str     x2, [sp, #256]
    mov     x0, sp
    bl      a64_exception
    ldr     x2, [sp, #256]
    msr     spsr_el1, x2
    ldp     x30, x2, [sp, #240]
    msr     elr_el1, x2
    ldp     x28, x29, [sp, #224]
    ldp     x26, x27, [sp, #208]
    ldp     x24, x25, [sp, #192]
    ldp     x22, x23, [sp, #176]
    ldp     x20, x21, [sp, #160]
    ldp     x18, x19, [sp, #144]
    ldp     x16, x17, [sp, #128]
    ldp     x14, x15, [sp, #112]
    ldp     x12, x13, [sp, #96]
    ldp     x10, x11, [sp, #80]
    ldp     x8, x9, [sp, #64]
    ldp     x6, x7, [sp, #48]
    ldp     x4, x5, [sp, #32]
    ldp     x2, x3, [sp, #16]
    ldp     x0, x1, [sp]
    add     sp, sp, #272
    eret
