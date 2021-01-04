global _start

section .data

%include "header.inc"

    mov eax, foo
    jmp eax
foo:
    xor eax, eax

%include "footer.inc"
