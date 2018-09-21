global _start

section .data
	align 16
dword0:
	dd	1000.0
dword1:
	dd	5.0
dword2:
	dd	3000.0
dwNaN:
	dd	__NaN__
maskeflags
    dd  0x45

%macro  moveflags 1
    pushf
    mov         eax, [esp]
    and         eax, [maskeflags]
    movd        %1, eax
%endmacro

%include "header.inc"
    
    movd        xmm0, [dword0]
    ucomiss     xmm0, [dword0]
    moveflags   mm0
    ucomiss     xmm0, [dword1]
    moveflags   mm1
    ucomiss     xmm0, [dword2]
    moveflags   mm2
    movd        xmm1, [dwNaN]
    ucomiss     xmm1, xmm0
    moveflags   mm3

%include "footer.inc"
