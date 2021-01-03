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
    bts dword [esp], eax
    mov eax, -5
    bts dword [esp + 4], eax
    mov eax, 1
    bts dword [esp], eax
    mov eax, 31
    bts dword [esp], eax
    mov eax, 32
    bts dword [esp], eax
    mov eax, 63
    bts dword [esp], eax
    mov eax, 99
    bts dword [esp], eax

%include "footer.inc"
