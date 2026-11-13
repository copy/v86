bits 16
org 0x7C00
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00
    mov word [0x2F*4], spurious
    mov word [0x2F*4+2], 0
    mov word [0x2A*4], regular
    mov word [0x2A*4+2], 0
    mov al, 0x11
    out 0x20, al
    out 0xA0, al
    mov al, 0x20
    out 0x21, al
    mov al, 0x28
    out 0xA1, al
    mov al, 4
    out 0x21, al
    mov al, 2
    out 0xA1, al
    mov al, 1
    out 0x21, al
    out 0xA1, al
    mov al, 0xFB
    out 0x21, al
    out 0xA1, al
    mov dx, 0x4D1
    mov al, 4
    out dx, al
    xor al, al
    out 0xEE, al             ; host withdraws or masks IRQ10 before INTA
    in al, 0xEE
    test al, al
    jz .unmasked
    mov al, 0xFF
    out 0xA1, al
.unmasked:
    sti
    hlt
    cli
    mov al, 1
    out 0xEE, al             ; a real IRQ10 must remain deliverable
    sti
    hlt
    cli
    mov word [0x600A], 0xBEEF
.done:
    hlt
    jmp .done
spurious:
    mov al, 0x0B
    out 0x20, al
    out 0xA0, al
    in al, 0x20
    mov [0x6000], al
    in al, 0xA0
    mov [0x6001], al
    inc byte [0x6002]
    mov al, 2
    out 0xEE, al             ; lower the source
    mov al, 0xFB
    out 0xA1, al
    mov al, 0x20
    out 0x20, al             ; spurious IRQ15 EOIs only the cascade
    iret
regular:
    mov al, 0x0B
    out 0x20, al
    out 0xA0, al
    in al, 0x20
    mov [0x6004], al
    in al, 0xA0
    mov [0x6005], al
    inc byte [0x6006]
    mov al, 2
    out 0xEE, al
    mov al, 0x20
    out 0xA0, al
    out 0x20, al
    iret
times 510-($-$$) db 0
dw 0xAA55
