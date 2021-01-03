BITS 32

start:
    cmp eax, 10
    jz end
    add ebx, 1
    jmp start

end:
    hlt
