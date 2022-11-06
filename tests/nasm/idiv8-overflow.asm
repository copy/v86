global _start

%include "header.inc"

    mov ax, 8000h
    mov bl, -1
    idiv bl

%include "footer.inc"
