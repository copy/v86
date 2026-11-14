// A32 permits SP as data in LDM/STM. Exercise the register lists used by
// Apple's memcpy, all four address modes, writeback and failed conditions.
    .syntax unified
    .arm
base:
    .word 10
    .word ia - base, 0, 3
    .word ib - base, 0, 3
    .word da - base, 0, 3
    .word db - base, 0, 3
    .word iaw - base, 0, 3
    .word ibw - base, 0, 3
    .word daw - base, 0, 3
    .word dbw - base, 0, 3
    .word one - base, 0, 3
    .word skipped - base, 0, 3
    .macro copy name, mode, delta, wb=
\name:
    sub r0, sp, #256
    add r1, r0, #128
    // Keep the original pointers outside the payload register list.
    mov r2, r0
    mov r3, r1
    movw sp, #0x5678
    movt sp, #0x1234
    movw r12, #128
    stm\mode r0, {r4-r11, sp, lr}
1:
    mov r0, r2
    mov r1, r3
    ldm\mode r0\wb, {r4-r11, sp, lr}
    stm\mode r1\wb, {r4-r11, sp, lr}
    subs r12, r12, #1
    bne 1b
    // Read back the copied SP word, including with a different base.
    ldr r2, [r3, #\delta]
    svc #0
    .endm
    copy ia, ia, 32
    copy ib, ib, 36
    copy da, da, -4
    copy db, db, -8
    copy iaw, ia, 32, !
    copy ibw, ib, 36, !
    copy daw, da, -4, !
    copy dbw, db, -8, !
one:
    sub r0, sp, #256
    movw r12, #128
1:  stmia r0, {sp}
    ldmia r0, {sp}
    subs r12, r12, #1
    bne 1b
    svc #0
skipped:
    movw r12, #128
1:  cmp r12, r12
    ldmiane r0!, {r4-r11, sp, lr}
    stmiane r1!, {r4-r11, sp, lr}
    subs r12, r12, #1
    bne 1b
    svc #0
