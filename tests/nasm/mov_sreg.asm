global _start

section .data
    align 16
mydword:
    dd  0

%include "header.inc"

    ; 32-bit register move should set higher bits to zero
    mov eax, -1
    mov eax, ss
    and eax, 0xffff0000

    mov ebx, -1
    db 66h
    mov ebx, ss
    and ebx, 0xffff0000

    ; 32-bit memory move should preserver higher bits
    mov dword [mydword], 0xdeadbeef
    mov [mydword], ss
    mov ecx, [mydword]
    and ecx, 0xffff0000

    mov dword [mydword+4], 0xdeadbeef
    db 66h
    mov [mydword+4], ss
    mov edx, [mydword+4]
    and edx, 0xffff0000

%include "footer.inc"
