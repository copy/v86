global _start

%include "header.inc"

    mov ecx, 0x10042
    mov eax, 42
start1:
    dec eax
    loopz start1

    mov ecx, 0x10005
    mov ebx, 51
start2:
    dec ebx
    db 67h
    loopz start2

    mov ecx, 0x10005
start3:
    or edx, 1
    db 67h
    loopz start3

%include "footer.inc"
