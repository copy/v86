global _start

section .data
	align 16

%include "header.inc"

    sub esp, 128
    fldz
    fld1
    fsave [esp]
    frstor [esp]

%include "footer.inc"
