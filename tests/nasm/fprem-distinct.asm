global _start

%include "header.inc"

    ; FPREM1 rounds the quotient: round(5 / 3) = 2, remainder = -1.
    mov dword [esp], 3
    fild dword [esp]
    mov dword [esp], 5
    fild dword [esp]
    fprem1

    ; FPREM truncates the quotient: trunc(5 / 3) = 1, remainder = 2.
    mov dword [esp], 3
    fild dword [esp]
    mov dword [esp], 5
    fild dword [esp]
    fprem

%include "footer.inc"
