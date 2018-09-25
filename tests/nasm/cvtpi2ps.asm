global _start

section .data
    align 16
quad0low:
    dd	1
quad0high:
    dd	2
quad1low:
    dd	-1234567
quad1high:
    dd	0
myaddress:
    dd	0xdeadbeef
%include "header.inc"

	cvtpi2ps	xmm0, [quad0low]
	; fill xmm1 in order to ensure that the high quadword remain inchanged
	pshufd		xmm1, xmm0, 0    
	cvtpi2ps	xmm1, [quad1low]

%include "footer.inc"
