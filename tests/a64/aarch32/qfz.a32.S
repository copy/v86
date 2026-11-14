// FZ/DN ordinary arithmetic, exact signed zeros, and exception fallbacks.
    .syntax unified
    .fpu crypto-neon-fp-armv8
    .arm
base:
    .word 22
    .word af32 - base, 0, 0x130
    .word af64 - base, 0, 0x130
    .word azero - base, 0, 0x130
    .word atiny32f - base, 0, 0x130
    .word atiny32 - base, 0, 0x130
    .word atiny64f - base, 0, 0x130
    .word atiny64 - base, 0, 0x130
    .word asub - base, 0, 0x130
    .word aup - base, 0, 0x130
    .word aover - base, 0, 0x130
    .word anan - base, 0, 0x130
    .word tf32 - base + 1, 0, 0x130
    .word tf64 - base + 1, 0, 0x130
    .word tzero - base + 1, 0, 0x130
    .word ttiny32f - base + 1, 0, 0x130
    .word ttiny32 - base + 1, 0, 0x130
    .word ttiny64f - base + 1, 0, 0x130
    .word ttiny64 - base + 1, 0, 0x130
    .word tsub - base + 1, 0, 0x130
    .word tup - base + 1, 0, 0x130
    .word tover - base + 1, 0, 0x130
    .word tnan - base + 1, 0, 0x130

    .macro start name, control
\name:
    movw r0, #0x10
    movt r0, #\control
    vmsr fpscr, r0
    movw r12, #128
    .endm
    .macro f32 name, control, low=0xcccd, high=0x3dcc
    start \name, \control
    movw r1, #\low
    movt r1, #\high
    movw r2, #0
    movt r2, #0x3fc0
    vmov s0, r1
    vmov s1, r2
1:  vadd.f32 s2, s0, s1
    vmul.f32 s3, s0, s1
    vdiv.f32 s4, s1, s0
    vnmul.f32 s5, s0, s1
    vsub.f32 s6, s1, s0
    subs r12, r12, #1
    bne 1b
    vmov r4, s2
    vmov r5, s3
    vmov r6, s4
    vmov r7, s5
    vmov r8, s6
    vmrs r3, fpscr
    svc #0
    .endm
    .macro f64 name
    start \name, 0xa300
    mov r1, #0
    movw r2, #0
    movt r2, #0x3fe0
    vmov d0, r1, r2
    movt r2, #0x3ff8
    vmov d1, r1, r2
1:  vadd.f64 d2, d0, d1
    vmul.f64 d3, d0, d1
    vdiv.f64 d4, d1, d0
    vnmul.f64 d5, d0, d1
    vsub.f64 d6, d1, d0
    subs r12, r12, #1
    bne 1b
    vmov r4, r5, d2
    vmov r6, r7, d3
    vmov r8, r9, d4
    vmov r10, r11, d5
    vmrs r3, fpscr
    svc #0
    .endm
    .macro tiny32 name, control, low=0, high=0x0080, other=0x0080
    start \name, \control
    movw r1, #\low
    movt r1, #\high
    vmov s0, r1
    movw r2, #0
    movt r2, #\other
    vmov s1, r2
1:  vmul.f32 s2, s0, s1
    subs r12, r12, #1
    bne 1b
    vmov r4, s2
    vmrs r3, fpscr
    svc #0
    .endm
    .macro tiny64 name, control
    start \name, \control
    mov r1, #0
    movw r2, #0
    movt r2, #0x0010
    vmov d0, r1, r2
1:  vmul.f64 d2, d0, d0
    subs r12, r12, #1
    bne 1b
    vmov r4, r5, d2
    vmrs r3, fpscr
    svc #0
    .endm
    .macro zero name
    start \name, 0xa300
    movw r1, #0
    movt r1, #0x8000
    vmov s0, r1
    movt r1, #0xbf80
    vmov s1, r1
1:  vmul.f32 s2, s0, s1
    vdiv.f32 s4, s0, s1
    vnmul.f32 s6, s0, s1
    vadd.f32 s3, s0, s1
    vsub.f32 s5, s0, s0
    subs r12, r12, #1
    bne 1b
    vmov r4, s2
    vmov r5, s4
    vmov r6, s6
    vmov r7, s3
    vmov r8, s5
    vmrs r3, fpscr
    svc #0
    .endm
    f32 af32, 0xa300
    f64 af64
    zero azero
    tiny32 atiny32f, 0xa300
    tiny32 atiny32, 0xa000
    tiny64 atiny64f, 0xa300
    tiny64 atiny64, 0xa000
    tiny32 asub, 0xa300, 1, 0, 0x3fc0
    f32 aup, 0xa340
    f32 aover, 0xa300, 0xffff, 0x7f7f
    f32 anan, 0xa300, 0, 0x7fc0
    .thumb
    f32 tf32, 0xa300
    f64 tf64
    zero tzero
    tiny32 ttiny32f, 0xa300
    tiny32 ttiny32, 0xa000
    tiny64 ttiny64f, 0xa300
    tiny64 ttiny64, 0xa000
    tiny32 tsub, 0xa300, 1, 0, 0x3fc0
    f32 tup, 0xa340
    f32 tover, 0xa300, 0xffff, 0x7f7f
    f32 tnan, 0xa300, 0, 0x7fc0
