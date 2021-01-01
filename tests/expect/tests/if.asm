BITS 32
    cmp eax, 5
    jg else
    inc ecx

else:
    inc ebx
    hlt
