global _start

section .data
	align 16

%include "header.inc"

    fstenv [esp]

    ; zero undefined fields
    mov word [esp + 0 + 2], 0
    mov word [esp + 4 + 2], 0
    mov word [esp + 8 + 2], 0
    mov word [esp + 24 + 2], 0

%include "footer.inc"
