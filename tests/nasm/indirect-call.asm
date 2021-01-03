global _start

section .data

%include "header.inc"

    mov eax, foo
    call eax
foo:
    xor eax, eax
    ; clear stack (pushed eip is not the same between vm and gdb execution)
    mov dword [esp], 0

%include "footer.inc"
