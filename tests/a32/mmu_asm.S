// The probes of tests/a32/mmu.c: one access each, its fault (if any)
// recorded by the runtime's expected exception (a32_expect(4) skips it)

    .syntax unified
    .arm
    .text
    .global probe_ldr, probe_str, probe_ldrt, probe_strt, probe_exec, probe_return
probe_ldr:
    ldr     r0, [r0]
    bx      lr
probe_str:
    str     r1, [r0]
    bx      lr
probe_ldrt:
    // (Rt and Rn apart: LDRT writes Rn back)
    ldrt    r1, [r0]
    mov     r0, r1
    bx      lr
probe_strt:
    strt    r1, [r0]
    bx      lr
// probe_exec(va): calls the code at va (mov r0, #0x77; bx lr); a prefetch
// abort returns to probe_return (tests/a32/mmu.c's hook)
probe_exec:
    push    {r4, lr}
    mov     r1, r0
    mov     r0, #0
    blx     r1
probe_return:
    pop     {r4, pc}
