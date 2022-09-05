global _start

%include "header.inc"

    mov eax, 1
    mov edx, 2
    cmpxchg eax, edx
    setbe  cl

%include "footer.inc"
