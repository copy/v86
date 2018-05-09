;;; Test JIT optimization of opcodes 0x89 and 0x8b

BITS 32

    mov [myaddress+ebx], eax
    mov [mydword+edx], ecx
    mov esi, [mydword+ebx]
    mov edi, [myaddress+edx]

    hlt

section .data
mydword:
    dd  0xcafebabe
myaddress:
    dd  0xdeadbeef
