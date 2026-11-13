// Original probe tables, using the formats documented by envytools/nouveau.
// Describes the single CRT, software-initialized hardware and PLL limits.
// Included in SeaVGABIOS's .rom.header, immediately after the IBM signature.
// Offset 0x36 must be reserved at link time, never patched over existing code.
        .org 0x36
        .word nv40_dcb
        .org 0x40
nv40_bit:
        .byte 0xff, 0xb8
        .ascii "BIT"
        .byte 0
        .word 0x0100
        .byte 12, 6, 3, 0 // header size, entry size, entry count, checksum
        .byte 'i', 1
        .word 6, nv40_info
        .byte 'I', 1
        .word 14, nv40_init
        .byte 'C', 1
        .word 10, nv40_clock
nv40_info:
        .byte 0, 0, 0x40, 5, 0, 0 // v86 05.40.00.00.00, not a vendor ROM version
nv40_init:
        .word nv40_init_scripts, 0, 0, 0, 0, 0, 0
nv40_init_scripts:
        .word nv40_init_done, 0
nv40_init_done:
        .byte 0x71 // INIT_DONE: the emulator initializes its own hardware
nv40_clock:
        .long 0, 0
        .word nv40_pll
nv40_pll:
        .byte 0x20, 4, 35, 4 // version, header, record length, record count
        .macro nv40_pll_entry reg
        .long \reg
        .word 100, 500, 100, 500 // VCO1/2 frequency bounds, MHz
        .word 1, 1, 27, 27 // divided reference input bounds, MHz
        .byte 1, 255, 1, 31, 1, 255, 1, 31 // N1/M1/N2/M2 bounds
        .byte 0, 7, 0 // reserved, maximum log2P, post-divider bias
        .long 13500 // reference frequency, kHz
        .endm
        nv40_pll_entry 0x004000
        nv40_pll_entry 0x004020
        nv40_pll_entry 0x680508
        nv40_pll_entry 0x680520
nv40_dcb:
        .byte 0x30, 10, 1, 8
        .word nv40_i2c
        .long 0x4edcbdcb
        .long 0x01000100 // analog CRT, head 0, DDC bus 0, DAC 0
        .long 350000 // maximum pixel clock in kHz
nv40_i2c:
        .byte 0x30, 4, 1, 4
        .byte 0x3e, 0x3e, 0, 0 // NV04 CRTC bit-banged DDC
