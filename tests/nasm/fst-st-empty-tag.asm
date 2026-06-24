global _start

%include "header.inc"

    fldz
    fst st1
    fistp word [esp]
    fadd dword [value]
    fstp dword [esp + 4]

value:
    dd 3f800000h

%include "footer.inc"
