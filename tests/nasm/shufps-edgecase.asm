global _start

%include "header.inc"

    mov dword [esp+0], 1
    mov dword [esp+4], 2
    mov dword [esp+8], 3
    mov dword [esp+12], 4
    movdqu xmm3, [esp]
    shufps xmm3, xmm3, 0x32

%include "footer.inc"
