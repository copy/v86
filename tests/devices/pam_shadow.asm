bits 16
org 0x7C00
    cli
    xor ax,ax
    mov ds,ax
    lgdt [gdt_pointer]
    mov eax,cr0
    or al,1
    mov cr0,eax
    jmp 8:protected
bits 32
protected:
    mov ax,16
    mov ds,ax
    mov es,ax
    mov ss,ax
    mov esp,0x7000
    xor ebx,ebx
    mov al,255
    out 0x21,al
    out 0xA1,al
    mov eax,cr4
    or eax,0x200
    mov cr4,eax
    call checks
    mov edi,0x2000
    mov eax,3
    mov ecx,1024
.pages:
    stosd
    add eax,0x1000
    loop .pages
    mov dword [0x1000],0x2003
    mov eax,0x1000
    mov cr3,eax
    mov eax,cr0
    or eax,0x80000000
    mov cr0,eax
    call checks
    mov dword [0x6000],0xBEEF
.done:
    hlt
    jmp .done
%macro verify 2
    inc ebx
    cmp dword [%1],%2
    jne failed
%endmacro
checks:
    mov al,0x33
    call pam2
    mov eax,0x11223344
    call hot_write
    mov edi,0xC8000
    mov ecx,16
    rep stosd
    mov byte [0xCBFFF],0xA5
    mov dword [0xCC000],0
    mov al,0x31                 ; C8000 RO, CC000 RW
    call pam2
    mov eax,0x55667788
    call hot_write
    verify 0xC8000,0x11223344   ; same compiled stores after PAM locks
    mov byte [0xC8000],0
    mov word [0xC8000],0
    lock add dword [0xC8000],1
    xorps xmm0,xmm0
    movups [0xC8000],xmm0
    fldz
    fstp qword [0xC8000]
    verify 0xC8000,0x11223344
    mov edi,0xC8000
    xor eax,eax
    mov ecx,16
    rep stosd
    mov esi,0x6100
    mov edi,0xC8000
    mov ecx,16
    rep movsd
    verify 0xC8000,0x11223344
    verify 0xC803C,0x11223344
    mov word [0xCBFFF],0x0123
    inc ebx
    cmp byte [0xCBFFF],0xA5
    jne failed
    cmp byte [0xCC000],1
    jne failed
    mov al,0x33
    call pam2
    mov eax,0x99AABBCC
    call hot_write
    verify 0xC8000,0x99AABBCC
    mov al,0x31
    call pam2
    xor eax,eax
    call hot_write
    verify 0xC8000,0x99AABBCC
    ret
hot_write:
    mov ecx,10000
.again:
    mov [0xC8000],eax
    loop .again
    ret
pam2:
    push eax
    mov dx,0xCF8
    mov eax,0x80000058
    out dx,eax
    mov dx,0xCFF
    pop eax
    out dx,al
    ret
failed:
    mov [0x6004],ebx
    mov dword [0x6000],0xDEAD
    jmp protected.done
align 8
gdt:
    dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF
gdt_pointer:
    dw 23
    dd gdt
times 510-($-$$) db 0
dw 0xAA55
