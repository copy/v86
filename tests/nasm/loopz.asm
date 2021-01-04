global _start

%include "header.inc"

    mov ecx, 0x10042
    mov eax, -1
start1:
    inc eax
    loopz start1

    mov ecx, 0x10005
    mov ebx, -1
start2:
    inc ebx
    db 67h
    loopz start2

    mov ecx, 0x10005
start3:
    xor edx, edx
    db 67h
    loopz start3

%include "footer.inc"
