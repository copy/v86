global _start

%include "header.inc"

    mov eax, 12345678h
    fstsw ax
    push 87654321h
    fstsw [esp]

%include "footer.inc"
