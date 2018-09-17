global _start

section .data
	align 16
myfloat0:
	dd	1.234567e20
myfloat1:
	dd	2.345678e20
myfloat2:
	dd	3.456789e20
myfloat3:
	dd	4.567891e20
myaddress:
	dd	0xdeadbeef
%include "header.inc"

	movaps	xmm0, [myfloat0]
    movaps	[myaddress], xmm0
    movaps	xmm1, [myaddress]

%include "footer.inc"
