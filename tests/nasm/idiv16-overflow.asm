global _start

%include "header.inc"

    mov ax, 0000h
    mov dx, 8000h
    mov bx, -1
    idiv bx

%include "footer.inc"
