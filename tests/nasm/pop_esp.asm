global _start

section .data
	align 16

%include "header.inc"

    mov esp, stack_top-16
    mov dword [esp], 55aaaa55h
    pop dword [esp-12]

%include "footer.inc"
