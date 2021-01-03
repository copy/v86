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

    btr word [esp], 0
    btr word [esp], 4
    btr word [esp], 9
    btr word [esp], 16
    btr word [esp], 31
    btr word [esp], 32
    btr word [esp], 55
    btr word [esp], 200

    btr dword [esp], 1
    btr dword [esp], 5
    btr dword [esp], 10
    btr dword [esp], 17
    btr dword [esp], 30
    btr dword [esp], 33
    btr dword [esp], 56
    btr dword [esp], 201

%include "footer.inc"
