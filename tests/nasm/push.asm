global _start

section .data
    align 16
myaddress:
    dd  0xdeadbeef

%include "header.inc"

    ;; push r/m - push edx
    db      0xff
    db      0xf2

    ;; push r/m - push bx
    db      0x66
    db      0xff
    db      0xf3

    ;; push imm
    push    0xdeadbeef
    push    WORD 0xd00d

    ;; push r/m - mem
    push    DWORD [myaddress]
    lea     eax, [myaddress]
    push    WORD [eax]

    ;; push reg
    mov     ecx, 0xcafe
    push    cx
    push    ecx

    xor     eax, eax

    pop     ax
    pop     eax
    pop     cx
    pop     ecx
    pop     dx
    pop     ebx
    pop     si
    pop     di

%include "footer.inc"
