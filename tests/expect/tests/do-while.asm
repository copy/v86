BITS 32

start:
    inc ebx
    cmp eax, 10
    jnz start

    hlt
