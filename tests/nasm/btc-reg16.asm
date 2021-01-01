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
    btc word [esp], ax
    mov eax, -5
    btc word [esp + 4], ax
    mov eax, 1
    btc word [esp], ax
    mov eax, 31
    btc word [esp], ax
    mov eax, 32
    btc word [esp], ax
    mov eax, 63
    btc word [esp], ax
    mov eax, 99
    btc word [esp], ax

%include "footer.inc"
