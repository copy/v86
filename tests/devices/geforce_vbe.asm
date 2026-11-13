; Exercise v86's own NV40 ROM through the real INT 10h path.
BITS 16
ORG 0x7C00
    cli
    xor ax,ax
    mov ds,ax
    mov es,ax
    mov ss,ax
    mov sp,0x7C00
    sti
    mov ax,0x4F00
    mov di,0x5000
    int 0x10
    mov [0x6000],ax
    mov ax,0x4F01
    mov cx,0x144
    mov di,0x5200
    int 0x10
    mov [0x6002],ax
    mov ax,0x4F02
    mov bx,0xC144 ; 1024x768x32, linear, retain VRAM for clear/preserve testing
    int 0x10
    mov [0x6004],ax
    mov ax,0x4F02
    mov bx,0x8144 ; switch to the banked form of the same mode
    int 0x10
    mov [0x600C],ax
    mov ax,0x4F05
    xor bx,bx
    mov dx,4
    int 0x10
    mov [0x6006],ax
    mov ax,0xA000
    mov es,ax
    mov dword [es:0],0x00112233
    xor ax,ax
    mov es,ax
    mov ax,0x4F07
    xor bx,bx
    xor cx,cx
    mov dx,32 ; bank 4 points at framebuffer scanline 32
    int 0x10
    mov [0x6008],ax
    ; Use nontrivial 8-bit palette values before saving the VBE state.
    mov dx,0x3C8
    mov al,0x40
    out dx,al
    inc dx
    mov al,0x12
    out dx,al
    mov al,0x34
    out dx,al
    mov al,0x56
    out dx,al
    mov ax,0x4F04
    mov cx,15
    mov dx,1
    mov bx,0x7000
    int 0x10
    mov [0x600E],ax
    mov ax,0x4F02
    mov bx,0x114 ; 800x600x16, clear framebuffer
    int 0x10
    mov [0x6010],ax
    mov ax,0xA000
    mov es,ax
    mov ax,[es:0]
    mov [0x6012],ax
    xor ax,ax
    mov es,ax
    mov ax,3
    int 0x10
    mov dx,0x3C7
    mov al,0x3F
    out dx,al
    mov dx,0x3C9
    in al,dx
    mov [0x6016],al
    mov ax,0x4F04
    mov cx,15
    mov dx,2
    mov bx,0x7000
    int 0x10
    mov [0x6014],ax
    mov ax,0xA000
    mov es,ax
    mov dword [es:0],0x00112233 ; saved bank 4 was restored
    xor ax,ax
    mov es,ax
    mov word [0x600A],0xBEEF
    cli
.halt: hlt
    jmp .halt
TIMES 510-($-$$) db 0
DW 0xAA55
