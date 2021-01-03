global _start

%include "header.inc"

    mov dword [esp], 0x03479aef
    mov dword [esp+4], 0x03479aef
    mov dword [esp+8], 0x03479aef
    mov dword [esp+12], 0x03479aef
    mov dword [esp+16], 0x03479aef
    mov dword [esp+20], 0x03479aef
    mov dword [esp+24], 0x03479aef
    mov dword [esp+28], 0x03479aef

    mov eax, 0
    btc dword [esp], eax
    mov eax, -5
    btc dword [esp + 4], eax
    mov eax, 1
    btc dword [esp], eax
    mov eax, 31
    btc dword [esp], eax
    mov eax, 32
    btc dword [esp], eax
    mov eax, 63
    btc dword [esp], eax
    mov eax, 99
    btc dword [esp], eax

%include "footer.inc"
