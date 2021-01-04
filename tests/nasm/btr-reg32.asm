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
    btr dword [esp], eax
    mov eax, -5
    btr dword [esp + 4], eax
    mov eax, 1
    btr dword [esp], eax
    mov eax, 31
    btr dword [esp], eax
    mov eax, 32
    btr dword [esp], eax
    mov eax, 63
    btr dword [esp], eax
    mov eax, 99
    btr dword [esp], eax

%include "footer.inc"
