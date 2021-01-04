global _start

%include "header.inc"

    xor eax, eax
    pushf
    and dword [esp], 8ffh

    test ebx, ebx
    pushf
    and dword [esp], 8ffh

    cmp ecx, 0
    pushf
    and dword [esp], 8ffh

%include "footer.inc"
