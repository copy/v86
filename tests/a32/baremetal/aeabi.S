// The AEABI's 64-bit division helpers (the 32-bit ones are UDIV and SDIV):
// the quotient in r0:r1, the remainder in r2:r3, from a32_divmod64 (runtime.c)

    .syntax unified
    .arm
    .text
    // (functions: a T32 caller's BL becomes BLX)
    .global __aeabi_uldivmod
    .type __aeabi_uldivmod, %function
__aeabi_uldivmod:
    push    {r4, lr}
    sub     sp, sp, #16
    // (a32_divmod64(n r0:r1, d r2:r3, remainder at sp + 8, signed 0): the last two on the stack)
    add     r4, sp, #8
    str     r4, [sp]
    mov     r4, #0
    str     r4, [sp, #4]
    bl      a32_divmod64
    ldr     r2, [sp, #8]
    ldr     r3, [sp, #12]
    add     sp, sp, #16
    pop     {r4, pc}

    .global __aeabi_ldivmod
    .type __aeabi_ldivmod, %function
__aeabi_ldivmod:
    push    {r4, lr}
    sub     sp, sp, #16
    add     r4, sp, #8
    str     r4, [sp]
    mov     r4, #1
    str     r4, [sp, #4]
    bl      a32_divmod64
    ldr     r2, [sp, #8]
    ldr     r3, [sp, #12]
    add     sp, sp, #16
    pop     {r4, pc}
