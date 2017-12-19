global _start

section .data
	align 16

quad0:
	dq	0x1234567890abcdef
quad1:
	dq	0xffffffffffffffff
mask0:
	dq	0x8080808080808080
mask1:
	dq	0x10203080405080ff

%include "header.inc"

	movq	mm0, [quad0]
	movq	mm1, [quad1]
	movq	mm2, [quad0]
	movq	mm3, [quad1]
	movq	mm6, [mask0]
	movq	mm7, [mask1]

	;; Look out for size of extracted memory region
	mov esp, stack_top - 16

	mov		edi, esp
	maskmovq	mm0, mm6
	sub		esp, 8

	mov		edi, esp
	maskmovq	mm1, mm6
	sub		esp, 8

	mov		edi, esp
	maskmovq	mm2, mm7
	sub		esp, 8

	mov		edi, esp
	maskmovq	mm3, mm7
	sub		esp, 8

%include "footer.inc"
