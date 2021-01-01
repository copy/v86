global _start

section .data

%include "header.inc"

    mov eax, 123456789
    mov edx, 987654321

    mov dword [esp], 123456789
    mov dword [esp+4], 987654321

    cmpxchg8b [esp]
    push eax
    push ecx
    push ebx
    push edx
    pushf
    and dword [esp], 8ffh

%include "footer.inc"
