;;; Test JIT optimization of opcodes 0x89 and 0x8b

BITS 32

    mov eax, 0xcafed00d
    mov ecx, 0xbeefc0de
    mov edx, 0
    mov ebx, 0

    ;; The following db's are used since "mov reg, reg" can be accomplished with several opcodes but
    ;; we want to test these specific ones

    ;; mov ecx, esi
    db 0x89
    db 0xf1
    ;; mov edx, edi
    db 0x89
    db 0xfa

    ;; mov edx, eax
    db 0x8b
    db 0xd0
    ;; mov eax, ecx
    db 0x8b
    db 0xc1

    hlt
