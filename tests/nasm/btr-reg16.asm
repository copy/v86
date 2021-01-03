global _start

%include "header.inc"

    mov dword [esp], -1
    mov dword [esp+4], -1
    mov dword [esp+8], -1
    mov dword [esp+12], -1
    mov dword [esp+16], -1
    mov dword [esp+20], -1
    mov dword [esp+24], -1
    mov dword [esp+28], -1

    mov eax, 0
    btr word [esp], ax
    mov eax, -5
    btr word [esp + 4], ax
    mov eax, 1
    btr word [esp], ax
    mov eax, 31
    btr word [esp], ax
    mov eax, 32
    btr word [esp], ax
    mov eax, 63
    btr word [esp], ax
    mov eax, 99
    btr word [esp], ax

%include "footer.inc"
