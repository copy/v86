global _start

section .data
	align 16

%include "header.inc"

    push 1
    push 0
    push 0
    fld tword [esp-8]

%include "footer.inc"
