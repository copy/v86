global _start

section .data
	align 16

%include "header.inc"

    push 1234
    fild dword [esp]
    push 0
    fild dword [esp]
    fyl2x

%include "footer.inc"
