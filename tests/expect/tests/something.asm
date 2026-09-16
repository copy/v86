BITS 32

start:
    jz .foo
    add eax, eax
.foo
    add ebx, ebx
    hlt
