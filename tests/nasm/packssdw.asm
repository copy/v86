global _start

section .data
	align 16
quad1:
	dq	0xffffffff0fffffff
quad2:
	dq	0x0000abcd80000000
quad3:
	dq	0xaaaaaaaaffffff00
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

%include "header.inc"

	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad3]
	movq		mm3, [quad2]

	packssdw	mm0, mm2
	packssdw	mm0, [quad1]
	packssdw	mm1, [quad3]
	packssdw	mm2, [quad1]
	packssdw	mm3, [quad1]


%include "footer.inc"
