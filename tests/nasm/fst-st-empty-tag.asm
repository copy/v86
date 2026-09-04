global _start

section .data
value:
    dd 3f800000h

%include "header.inc"

    fldz
    fst st1
    fistp word [esp]
    fadd dword [value]
    fstp dword [esp + 4]

%include "footer.inc"
