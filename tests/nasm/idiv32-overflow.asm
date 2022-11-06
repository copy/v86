global _start

%include "header.inc"

    mov eax, 00000000h
    mov edx, 80000000h
    mov ebx, -1
    idiv ebx

%include "footer.inc"
