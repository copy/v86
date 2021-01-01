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

    bts word [esp], 0
    bts word [esp], 4
    bts word [esp], 9
    bts word [esp], 16
    bts word [esp], 31
    bts word [esp], 32
    bts word [esp], 55
    bts word [esp], 200

    bts dword [esp], 1
    bts dword [esp], 5
    bts dword [esp], 10
    bts dword [esp], 17
    bts dword [esp], 30
    bts dword [esp], 33
    bts dword [esp], 56
    bts dword [esp], 201

%include "footer.inc"
