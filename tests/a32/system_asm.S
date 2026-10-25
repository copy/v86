// The assembly half of tests/a32/system.c: what C cannot do (it needs its
// stack): the modes' banked registers, the SPSRs, LDM and STM of the User
// registers, running code in User mode, T32 exceptions.

    .syntax unified
    .arch_extension virt
    .arm
    .text

// banks(out): per mode (FIQ, IRQ, ABT, UND, SYS) its CPSR, then SP and LR
// set to markers; read back in each mode after a round through SVC, the
// originals restored there. (MRS and MSR of banked registers: QEMU's
// cortex-a15 without its Virtualization Extensions has none.)
    .global banks
banks:
    push    {r4-r11, lr}
    mov     r7, r0
    ldr     r6, =saved
    .irp m, 0x11, 0x12, 0x17, 0x1B, 0x1F
    msr     cpsr_c, #(\m | 0xC0)
    mrs     r1, cpsr
    str     r1, [r7], #4
    str     sp, [r6], #4
    str     lr, [r6], #4
    movw    sp, #(0x1000 | \m)
    movw    lr, #(0x2000 | \m)
    msr     cpsr_c, #0xD3
    .endr
    ldr     r6, =saved
    .irp m, 0x11, 0x12, 0x17, 0x1B, 0x1F
    msr     cpsr_c, #(\m | 0xC0)
    mov     r1, sp
    mov     r2, lr
    ldm     r6!, {r3-r4}
    mov     sp, r3
    mov     lr, r4
    msr     cpsr_c, #0xD3
    stm     r7!, {r1-r2}
    .endr
    // (each mode sees its own again: the difference from the saved values, 0)
    ldr     r6, =saved
    .irp m, 0x11, 0x12, 0x17, 0x1B, 0x1F
    msr     cpsr_c, #(\m | 0xC0)
    ldm     r6!, {r1-r2}
    sub     r1, sp, r1
    sub     r2, lr, r2
    msr     cpsr_c, #0xD3
    stm     r7!, {r1-r2}
    .endr
    pop     {r4-r11, pc}

// fiq_banks(out): R8-R12 of SVC (User's) and FIQ
    .global fiq_banks
fiq_banks:
    push    {r4-r11, lr}
    mov     r7, r0
    mov     r8, #0x88
    mov     r9, #0x89
    mov     r10, #0x8A
    mov     r11, #0x8B
    mov     r12, #0x8C
    msr     cpsr_c, #0xD1
    mov     r8, #0xF8
    mov     r9, #0xF9
    mov     r10, #0xFA
    mov     r11, #0xFB
    mov     r12, #0xFC
    msr     cpsr_c, #0xD3
    stm     r7!, {r8-r12}
    // (System mode's are User's, SVC's)
    msr     cpsr_c, #0xDF
    mov     r1, r8
    mov     r2, r12
    msr     cpsr_c, #0xD1
    mov     r3, r8
    mov     r4, r10
    mov     r5, r12
    msr     cpsr_c, #0xD3
    stm     r7!, {r1-r5}
    pop     {r4-r11, pc}

// spsrs(out, value): per mode with an SPSR (FIQ, IRQ, ABT, UND, SVC) MSR
// SPSR_fsxc of value + mode, its MRS; then all five again after a round
// through SVC; then MSR SPSR_f, _c, _x and _s alone in SVC
    .global spsrs
spsrs:
    push    {r4-r11, lr}
    mov     r7, r0
    mov     r5, r1
    mrs     r9, spsr
    .irp m, 0x11, 0x12, 0x17, 0x1B, 0x13
    msr     cpsr_c, #(\m | 0xC0)
    add     r2, r5, #\m
    msr     spsr_fsxc, r2
    mrs     r3, spsr
    msr     cpsr_c, #0xD3
    str     r3, [r7], #4
    .endr
    .irp m, 0x11, 0x12, 0x17, 0x1B, 0x13
    msr     cpsr_c, #(\m | 0xC0)
    mrs     r3, spsr
    msr     cpsr_c, #0xD3
    str     r3, [r7], #4
    .endr
    mov     r1, #0
    msr     spsr_fsxc, r1
    mvn     r1, #0
    msr     spsr_f, r1
    mrs     r2, spsr
    msr     spsr_c, r1
    mrs     r3, spsr
    msr     spsr_x, r1
    mrs     r4, spsr
    msr     spsr_s, r1
    mrs     r5, spsr
    stm     r7!, {r2-r5}
    msr     spsr_fsxc, r9
    pop     {r4-r11, pc}

// user_lsm(out): STM and LDM of the User registers from SVC
    .global user_lsm
user_lsm:
    push    {r4-r11, lr}
    mov     r7, r0
    // (System mode's SP and LR are User's: markers there)
    msr     cpsr_c, #0xDF
    mov     r4, sp
    mov     sp, #0x5000
    movw    lr, #0x5004
    msr     cpsr_c, #0xD3
    ldr     r1, =scratch
    stmia   r1, {r13, r14}^
    ldr     r2, [r1]
    ldr     r3, [r1, #4]
    stm     r7!, {r2-r3}
    mov     r2, #0x6000
    movw    r3, #0x6004
    stmia   r1, {r2, r3}
    ldmia   r1, {r13, r14}^
    // (SVC's SP is its own still)
    mov     r5, sp
    msr     cpsr_c, #0xDF
    mov     r2, sp
    mov     r3, lr
    mov     sp, r4
    msr     cpsr_c, #0xD3
    sub     r5, sp, r5
    stm     r7!, {r2, r3, r5}
    pop     {r4-r11, pc}

// exception_returns(out): SUBS PC, LR to SVC with an SPSR, MOVS PC, LR
// to T32, LDM with the PC and ^, RFE; each records where it arrived and its CPSR
    .global exception_returns
exception_returns:
    push    {r4-r11, lr}
    mov     r7, r0
    mrs     r9, spsr
    // SUBS PC, LR, #4: to 1f with the flags of the SPSR
    mov     r1, #0xD3
    orr     r1, r1, #0xA0000000
    msr     spsr_fsxc, r1
    adr     lr, 1f + 4
    subs    pc, lr, #4
    b       .
1:  mrs     r1, cpsr
    str     r1, [r7], #4
    // MOVS PC, LR: to the T32 code at 2f (SPSR.T)
    mov     r1, #0xF3
    msr     spsr_fsxc, r1
    adr     lr, 2f
    orr     lr, lr, #1
    movs    pc, lr
    b       .
    .thumb
2:  mrs     r1, cpsr
    str     r1, [r7], #4
    adr     r1, 3f
    bx      r1
    .balign 4
    .arm
3:  // LDM SP!, {..., PC}^: to 4f, CPSR from SPSR (V set)
    mov     r1, #0xD3
    orr     r1, r1, #0x10000000
    msr     spsr_fsxc, r1
    adr     r1, 4f
    mov     r2, #0x77
    push    {r1}
    push    {r2}
    ldmia   sp!, {r3, pc}^
    b       .
4:  mrs     r1, cpsr
    stm     r7!, {r1, r3}
    // RFE from a two-word frame: to 5f with C set
    adr     r1, 5f
    mov     r2, #0xD3
    orr     r2, r2, #0x20000000
    ldr     r3, =scratch
    stm     r3, {r1, r2}
    rfeia   r3!
    b       .
5:  mrs     r1, cpsr
    ldr     r2, =scratch
    sub     r3, r3, r2
    stm     r7!, {r1, r3}
    // SRS to SVC's stack (DB, writeback): LR and SPSR
    mov     r1, #0xD3
    orr     r1, r1, #0x40000000
    msr     spsr_fsxc, r1
    mov     r4, lr
    movw    lr, #0x1234
    mov     r5, sp
    srsdb   sp!, #0x13
    ldm     sp, {r1, r2}
    sub     r3, r5, sp
    mov     sp, r5
    mov     lr, r4
    stm     r7!, {r1-r3}
    msr     spsr_fsxc, r9
    pop     {r4-r11, pc}

// run_user(function, argument): function(argument) in User mode (T32 when
// bit 0); it returns with SVC #0xFF (user_exit), its r0 run_user's
    .global run_user
run_user:
    push    {r4-r11, lr}
    ldr     r2, =user_sp
    str     sp, [r2]
    mov     r3, #0xD0
    tst     r0, #1
    orrne   r3, r3, #0x20
    msr     spsr_fsxc, r3
    mov     lr, r0
    mov     r0, r1
    movs    pc, lr
    .global user_returned
user_returned:
    ldr     r2, =user_sp
    ldr     sp, [r2]
    pop     {r4-r11, pc}

// (User mode code) back to run_user's caller with r0
    .global user_exit
user_exit:
    svc     #0xFF

// User mode probes: each returns what it found in r0 (an exception's kind
// comes from the handler), then exits
    .global user_cpsr
user_cpsr:
    // (CPS and MSR of the control field ignored; MSR of the flags written)
    cpsid   i
    msr     cpsr_c, #0xD3
    mov     r1, #0x80000000
    msr     cpsr_f, r1
    mrs     r0, cpsr
    b       user_exit
    .global user_mrs_spsr
user_mrs_spsr:
    mrs     r0, spsr
    b       user_exit
    .global user_sctlr
user_sctlr:
    mrc     p15, 0, r0, c1, c0, 0
    b       user_exit
    .global user_tpidr
user_tpidr:
    mrc     p15, 0, r0, c13, c0, 3
    mrc     p15, 0, r1, c13, c0, 2
    add     r0, r0, r1
    b       user_exit
    .global user_tpidrprw
user_tpidrprw:
    mrc     p15, 0, r0, c13, c0, 4
    b       user_exit
    .global user_cntvct
user_cntvct:
    mrrc    p15, 1, r0, r1, c14
    b       user_exit
    .global user_svc
user_svc:
    svc     #0x21
    b       user_exit
    .global user_vfp
user_vfp:
    vmov    s0, r0
    vadd.f32 s0, s0, s0
    vmov    r0, s0
    b       user_exit
    .global user_fpexc
user_fpexc:
    vmrs    r0, fpexc
    b       user_exit
    .global user_ldm_user
user_ldm_user:
    ldr     r1, =scratch
    ldmia   r1, {r13, r14}^
    b       user_exit
    .global user_hvc
user_hvc:
    hvc     #0
    b       user_exit

// T32 exceptions: SVC, the 16-bit and 32-bit UDF; each address in r0's word
    .thumb
    .global t32_svc
    .thumb_func
t32_svc:
    // (SVC in SVC mode: LR_svc becomes the return address)
    push    {r4, lr}
    adr     r1, 1f
    str     r1, [r0]
1:  svc     #0x43
    pop     {r4, pc}
    .global t32_udf16
    .thumb_func
t32_udf16:
    adr     r1, 1f
    str     r1, [r0]
1:  udf     #1
    bx      lr
    .global t32_udf32
    .thumb_func
t32_udf32:
    .balign 4
    adr     r1, 1f
    str     r1, [r0]
1:  udf.w   #2
    bx      lr
    .global t32_cps
    .thumb_func
t32_cps:
    // CPS (16-bit) and SUBS PC, LR (T32's exception return) at PL1
    cpsie   f
    mrs     r1, cpsr
    cpsid   f
    mrs     r2, cpsr
    str     r1, [r0]
    str     r2, [r0, #4]
    mrs     r3, spsr
    movs    r1, #0xD3
    msr     spsr_fsxc, r1
    adr     r1, 2f
    adds    r1, #4
    mov     r2, lr
    mov     lr, r1
    subs    pc, lr, #4
    .balign 4
    .arm
2:  mrs     r1, cpsr
    str     r1, [r0, #8]
    msr     spsr_fsxc, r3
    bx      r2

    .data
    .balign 8
saved:  .space 64
scratch: .space 16
user_sp: .word 0
