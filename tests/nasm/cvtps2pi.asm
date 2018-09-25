global _start

section .data
	align 16
float0low:
	dd	12345.678
float0high:
	dd	1234.5
float1low:
	dd	0x80000001.0
float1high:
	dd	-2147483130.0
mxcsr:
	dd	0

; Set mxcsr regiter rouding bits
%macro  setRoundingBits 1
	stmxcsr		[mxcsr]
	mov			eax, [mxcsr]
	and 		ah, 0x9F
	or			ah, %1
	mov			[mxcsr], eax
	ldmxcsr		[mxcsr]
%endmacro

%include "header.inc"

	setRoundingBits 0x00 ; Round to nearest
	cvtps2pi	mm0, [float0low]
	cvtps2pi	mm4, [float1low]
	setRoundingBits 0x20 ; Round down
	cvtps2pi	mm1, [float0low]
	cvtps2pi	mm5, [float1low]
	setRoundingBits 0x40 ; Round up
	cvtps2pi	mm2, [float0low]
	cvtps2pi	mm6, [float1low]
	setRoundingBits 0x60 ; Round toward zero
	cvtps2pi	mm3, [float0low]
	cvtps2pi	mm7, [float1low]

%include "footer.inc"
