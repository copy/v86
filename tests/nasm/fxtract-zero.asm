global _start

section .data
	align 16

%include "header.inc"

    push 0
    fild dword [esp]
    fxtract

%include "footer.inc"
