;;; Test JIT optimization of opcodes 0x89 and 0x8b
BITS 16

    mov ax, 0xcafe

    mov cx, [mydword]
    mov dx, [myaddress]

    lea di, [myaddress]
    lea si, [mydword]
    mov [di+bx], ax
    mov [si+bx], cx

    ;; The following db's are used since "mov reg, reg" can be accomplished with several opcodes but
    ;; we want to test these specific ones.

    ;; We can skip the 0x66 prefixes because the test-runner checks for
    ;; 32 bit mode - we may need them again if these are compiled to ELF32
    ;; binaries

    ;; mov cx, si
    db 0x89
    db 0xf1
    ;; mov dx, di
    db 0x89
    db 0xfa

    ;; mov dx, ax
    db 0x8b
    db 0xd0
    ;; mov ax, cx
    db 0x8b
    db 0xc1

    hlt

section .data
mydword:
    dd  0xcafebabe
myaddress:
    dd  0xdeadbeef
