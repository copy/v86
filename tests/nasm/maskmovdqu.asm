global _start

section .data
	align 16

dquad0:
	dq	0x1234567890abcdef
	dq	0xfedcba0987654321
dquad1:
	dq	0xffffffffffffffff
	dq	0xffffffffffffffff
mask0:
	dq	0x8081828384858687
	dq	0x88898a8b8c8d8e8f
mask1:
	dq	0x10203080405080ff
	dq	0x1234567890abcdef

%include "header.inc"

	movdqu	xmm0, [dquad0]
	movdqu	xmm1, [dquad1]
	movdqu	xmm2, [dquad0]
	movdqu	xmm3, [dquad1]
	movdqu	xmm6, [mask0]
	movdqu	xmm7, [mask1]

	;; Look out for size of extracted memory region
	mov esp, stack_top - 16

	mov		edi, esp
	maskmovdqu	xmm0, xmm6
	sub		esp, 16

	mov		edi, esp
	maskmovdqu	xmm1, xmm6
	sub		esp, 16

	mov		edi, esp
	maskmovdqu	xmm2, xmm7
	sub		esp, 16

	mov		edi, esp
	maskmovdqu	xmm3, xmm7
	sub		esp, 16

%include "footer.inc"
