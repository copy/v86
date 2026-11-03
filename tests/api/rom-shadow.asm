; Boot sector checking that the shadow ram at 0xC0000-0xFFFFF is write-protected after SeaBIOS
; locked it through the i440FX PAM registers, and writable again once PAM enables writes.
;
; Each check stores the byte read before and after a write attempt at RESULTS (2 bytes per
; check), then DONE is set to DONE_MAGIC. tests/api/rom-shadow.js evaluates the results and may
; set GO to run the checks again (after a state restore).

bits 16
org 0x7C00

RESULTS equ 0x0600
DONE equ 0x0700
DONE_MAGIC equ 0xA5
GO equ 0x0701

PCI_ADDR equ 0xCF8
PAM1_PORT equ 0xCFE                     ; byte 2 of dword 0x58: PAM1 (0xC0000-0xC7FFF)

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    mov es, ax
    mov byte [DONE], 0
    mov byte [GO], 0
    mov di, RESULTS                     ; es:di: next result slot
    cld

    mov ax, 0xC000
    mov fs, ax
    mov ax, 0xF000
    mov gs, ax

    ; 1: byte store into the vga bios
    mov al, [fs:0x2000]
    stosb
    not al
    mov [fs:0x2000], al
    mov al, [fs:0x2000]
    stosb

    ; 2: dword store into the system bios
    mov al, [gs:0x0000]
    stosb
    mov eax, [gs:0x0000]
    not eax
    mov [gs:0x0000], eax
    mov al, [gs:0x0000]
    stosb

    ; 3: read-modify-write
    mov al, [fs:0x2010]
    stosb
    xor byte [fs:0x2010], 0xFF
    mov al, [fs:0x2010]
    stosb

    ; 4: rep stosw with 32-bit addressing (string fast path)
    mov al, [fs:0x3000]
    stosb
    push es
    push di
    mov ax, fs
    mov es, ax
    mov edi, 0x3000
    mov ecx, 0x100
    mov ax, 0x5A5A
    a32 rep stosw
    pop di
    pop es
    mov al, [fs:0x3000]
    stosb

    ; 5: hot loop (compiled by the jit), stores and read-modify-writes
    mov al, [fs:0x2020]
    stosb
    mov dx, 8
.outer:
    mov cx, 0xFFFF
.inner:
    inc byte [fs:0x2020]
    mov [fs:0x2021], cl
    dec cx
    jnz .inner
    dec dx
    jnz .outer
    mov al, [fs:0x2020]
    stosb

    ; 6: control: conventional memory is writable
    mov al, [0x0500]
    stosb
    not al
    mov [0x0500], al
    mov al, [0x0500]
    stosb

    ; 7: enable writes to 0xC0000-0xC3FFF through PAM1, write, restore PAM1
    mov eax, 0x80000058
    mov dx, PCI_ADDR
    out dx, eax
    mov dx, PAM1_PORT
    in al, dx
    mov bl, al                          ; original PAM1
    or al, 0x02
    out dx, al

    mov al, [fs:0x2030]
    stosb
    not al
    mov [fs:0x2030], al
    mov al, [fs:0x2030]
    stosb

    mov al, bl
    out dx, al

    ; 8: protected again after restoring PAM1
    mov al, [fs:0x2040]
    stosb
    not al
    mov [fs:0x2040], al
    mov al, [fs:0x2040]
    stosb

    ; 9: SeaBIOS leaves the upper memory above the option roms and its own allocations writable
    push fs
    mov ax, 0xE000
    mov fs, ax
    mov al, [fs:0x0000]
    stosb
    not al
    mov [fs:0x0000], al
    mov al, [fs:0x0000]
    stosb
    pop fs

    mov byte [DONE], DONE_MAGIC
.wait:
    cmp byte [GO], 0
    je .wait
    jmp start

    times 510 - ($ - $$) db 0
    dw 0xAA55
