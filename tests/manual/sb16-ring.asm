; Boot sector: SB16 8-bit auto-init DMA playback from a two-half ring.
; Every byte of a half holds that half's sequence number. The IRQ handler
; refills the half that just finished with the next sequence number and
; writes that number to COM1, so the host can check that the DAC output is
; 0, 1, 2, 3, ... with no half played twice.

bits 16
org 0x7C00

HALF        equ 2048            ; bytes per ring half (one SB16 block)
RING_SEG    equ 0x1000          ; ring at physical 0x10000 (DMA page 1)
SB          equ 0x220
COM1        equ 0x3F8

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    mov word [0x0D * 4], isr    ; IRQ 5 -> vector 0x0D
    mov word [0x0D * 4 + 2], ax

    mov ax, RING_SEG
    mov es, ax
    xor di, di
    mov cx, HALF
    xor al, al
    rep stosb                   ; half 0 = seq 0
    mov cx, HALF
    inc al
    rep stosb                   ; half 1 = seq 1

    ; DSP reset
    mov dx, SB + 6
    mov al, 1
    out dx, al
    in al, dx
    in al, dx
    xor al, al
    out dx, al
    mov dx, SB + 0xE
.wait_reset:
    in al, dx
    test al, 0x80
    jz .wait_reset
    mov dx, SB + 0xA
    in al, dx
    cmp al, 0xAA
    jne fail

    ; DMA channel 1: single mode, auto-init, memory -> device
    mov al, 0x05
    out 0x0A, al                ; mask
    out 0x0C, al                ; clear flip-flop
    mov al, 0x59
    out 0x0B, al
    xor al, al
    out 0x02, al                ; address 0x0000
    out 0x02, al
    mov al, 0x01
    out 0x83, al                ; page 1
    mov al, (2 * HALF - 1) & 0xFF
    out 0x03, al
    mov al, (2 * HALF - 1) >> 8
    out 0x03, al
    mov al, 0x01
    out 0x0A, al                ; unmask

    in al, 0x21
    and al, ~0x20
    out 0x21, al                ; unmask IRQ 5

    mov si, dsp_init
    mov cx, dsp_init_len
.dsp:
    lodsb
    call dsp_write
    loop .dsp

    sti
.idle:
    hlt
    jmp .idle

fail:
    mov dx, COM1
    mov al, 0xFF
    out dx, al
    cli
    hlt

dsp_write:
    mov dx, SB + 0xC
    mov ah, al
.busy:
    in al, dx
    test al, 0x80
    jnz .busy
    mov al, ah
    out dx, al
    ret

isr:
    push ax
    push cx
    push dx
    push di
    push es
    mov dx, SB + 0xE
    in al, dx                   ; acknowledge 8-bit IRQ
    mov ax, RING_SEG
    mov es, ax
    mov di, [cs:next_half]
    xor word [cs:next_half], HALF
    inc byte [cs:seq]
    mov al, [cs:seq]
    mov cx, HALF
    rep stosb
    mov dx, COM1
    out dx, al
    mov al, 0x20
    out 0x20, al
    pop es
    pop di
    pop dx
    pop cx
    pop ax
    iret

next_half:  dw 0
seq:        db 1

dsp_init:
    db 0x41, 22050 >> 8, 22050 & 0xFF  ; output rate
    db 0xD1                            ; speaker on
    db 0xC6, 0x00                      ; 8-bit auto-init output, mono unsigned
    db (HALF - 1) & 0xFF, (HALF - 1) >> 8
dsp_init_len equ $ - dsp_init

    times 510 - ($ - $$) db 0
    dw 0xAA55
