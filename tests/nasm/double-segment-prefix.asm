global _start

%include "header.inc"

    cld
    mov dword [100ff8h], 0x11223344
    mov esi, 100ff8h
    mov edi, 101000h
    db 36h, 3eh ; ss ds
    movsd

%include "footer.inc"
