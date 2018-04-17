BITS 32

start:
    cmp eax, 10
    jz end
    inc ebx
    jmp start

end:
    hlt
