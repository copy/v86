global _start

section .data
	align 16
float0low:
	dd	2147483647.0
float0high:
	dd	-2147483648.0
float1low:
	dd	1235.678
float1high:
	dd	1325400064
float2low:
	dd	-54.321
float2high:
	dd	-12345.6
float3low:
	dd	123.456
float3high:
	dd	1234.5678
myaddress:
	dd	0xdeadbeef
%include "header.inc"

    movaps	    xmm0, [float0low]
    cvttps2pi	mm0, xmm0
	cvttps2pi	mm1, [float1low]
	cvttps2pi	mm2, [float2low]
	cvttps2pi	mm3, [float3low]

%include "footer.inc"
