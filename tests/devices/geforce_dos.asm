; DOS/VDD round trip: enter real mode 13h, write/read a VGA pixel, return to
; mode 3, then leave a marker for the native Win98 parent probe.
BITS 16
ORG 0x100
    push cs
    pop ds
    mov ax,0x13
    int 0x10
    mov ax,0xA000
    mov es,ax
    mov byte [es:0],0x5A
    mov ax,0x0D00
    xor bx,bx
    xor cx,cx
    xor dx,dx
    int 0x10
    cmp al,0x5A
    je .good
    mov byte [status],'1'
.good:
    xor ah,ah
    int 0x1A
    mov [ticks],dx
.wait:
    xor ah,ah
    int 0x1A
    sub dx,[ticks]
    cmp dx,36
    jb .wait
    mov ax,3
    int 0x10
    mov dx,name
    xor cx,cx
    mov ah,0x3C
    int 0x21
    jc .error
    mov bx,ax
    mov dx,marker
    mov cx,8
    mov ah,0x40
    int 0x21
    mov ah,0x3E
    int 0x21
    mov ax,0x4C00
    cmp byte [status],'0'
    je .exit
.error:
    mov ax,0x4C01
.exit:
    int 0x21
ticks dw 0
name db 'NVDOS.TXT',0
marker db 'NV40DOS'
status db '0'
