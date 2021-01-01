global _start

%include "header.inc"

    mov ecx, 0x10000
    jecxz cont1
    or eax, 1
cont1:

    mov ecx, 0
    jecxz cont2
    or eax, 2
cont2:

    mov ecx, 0x1
    jcxz cont3
    or eax, 4
cont3:

    mov ecx, 0x10000
    jcxz cont4
    or eax, 8
cont4:

%include "footer.inc"
