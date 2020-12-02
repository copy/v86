global _start

section .data
	align 16
dword1:
	dd	0x00000002
dword2:
	dd	0xFFFFFF11
dword3:
	dd	0xFFF00000
dword4:
	dd	0x0000FFFF
dword5:
	dd	0xFFFFFFFF
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce
qword1:
	dq	0xffffffff00000001
%include "header.inc"

	movd		mm0, [dword1]
	movd		mm1, [dword2]
	movd		mm2, [dword1]
	movd		mm3, [dword2]
	movd		mm4, [dword4]
	movd		mm5, [dword5]
	
	pmuludq	mm0, [mydword]
	pmuludq	mm2, mm1
	pmuludq	mm3, [dword3]
	pmuludq	mm4, [dword3]
	pmuludq	mm5, [dword5]

	movd	   xmm1, [dword5]
	pshufd     xmm1, xmm1, 0
	pmuludq    xmm1, xmm1

	movd	   xmm2, [dword4]
	pmuludq    xmm2, xmm1

%include "footer.inc"
