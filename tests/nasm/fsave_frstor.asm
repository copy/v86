global _start

%include "header.inc"

    sub esp, 128
    fldz
    fld1
    fsave [esp]
    frstor [esp]
    mov dword [esp + 12], 0 ; fpu eip (currently not emulated)

%include "footer.inc"
