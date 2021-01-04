global _start

section .data

%include "header.inc"

    mov eax, 123456789
    mov ebx, 123456789
    mov edx, 123456789

    cmpxchg edx, ebx
    push eax
    push edx
    push ebx
    pushf
    and dword [esp], 8ffh

    cmpxchg ax, bx
    push eax
    push edx
    push ebx
    pushf
    and dword [esp], 8ffh

    cmpxchg al, bh
    push eax
    push edx
    push ebx
    pushf
    and dword [esp], 8ffh

%include "footer.inc"
