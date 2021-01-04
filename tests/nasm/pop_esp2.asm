global _start

section .data
	align 16

%include "header.inc"

    ; pop esp encoded using 8F
    mov esp, stack_top-16
    db 8Fh, 0C4h

%include "footer.inc"
