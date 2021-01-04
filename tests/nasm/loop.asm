global _start

%include "header.inc"

    mov ecx, 0x10042
    mov eax, 0
start1:
    inc eax
    loop start1

    mov ecx, 0x10005
    mov ebx, 0
start2:
    inc ebx
    db 67h
    loop start2

%include "footer.inc"
