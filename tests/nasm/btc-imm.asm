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

    btc word [esp], 0
    btc word [esp], 4
    btc word [esp], 9
    btc word [esp], 16
    btc word [esp], 31
    btc word [esp], 32
    btc word [esp], 55
    btc word [esp], 200

    btc dword [esp], 1
    btc dword [esp], 5
    btc dword [esp], 10
    btc dword [esp], 17
    btc dword [esp], 30
    btc dword [esp], 33
    btc dword [esp], 56
    btc dword [esp], 201

%include "footer.inc"
