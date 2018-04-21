;;; Test JIT optimization of opcodes 0x89 and 0x8b

global _start

section .data
    align 16
mydword:
    dd  0xcafebabe
myaddress:
    dd  0xdeadbeef

%include "header.inc"

    ;; Load 32-bit values to confirm that the 16-bit movs do not overwrite existing values here
    mov eax, 0xcafeb055
    mov esi, 0x1bada551

    mov ecx, [mydword]
    mov edx, [myaddress]

    mov [myaddress], cx
    mov [mydword], dx

    ;; The following db's are used since mov reg, reg can be accomplished with several opcodes but
    ;; we want to test these specific ones

    ;; mov cx, si
    db 0x66
    db 0x89
    db 0xf1
    ;; mov dx, di
    db 0x66
    db 0x89
    db 0xfa

    ;; mov dx, ax
    db 0x66
    db 0x8b
    db 0xd0
    ;; mov ax, cx
    db 0x66
    db 0x8b
    db 0xc1

%include "footer.inc"
