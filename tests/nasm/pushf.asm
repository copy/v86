global _start

%include "header.inc"

    pushf
    and dword [esp], ~0x0200 ; if

    db 66h
    pushf
    and dword [esp], ~0x0200

%include "footer.inc"
