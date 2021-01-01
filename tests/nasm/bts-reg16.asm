global _start

%include "header.inc"

    mov dword [esp], 0
    mov dword [esp+4], 0
    mov dword [esp+8], 0
    mov dword [esp+12], 0
    mov dword [esp+16], 0
    mov dword [esp+20], 0
    mov dword [esp+24], 0
    mov dword [esp+28], 0

    mov eax, 0
    bts word [esp], ax
    mov eax, -5
    bts word [esp + 4], ax
    mov eax, 1
    bts word [esp], ax
    mov eax, 31
    bts word [esp], ax
    mov eax, 32
    bts word [esp], ax
    mov eax, 63
    bts word [esp], ax
    mov eax, 99
    bts word [esp], ax

%include "footer.inc"
