global _start

%include "header.inc"

    mov ax, -1
    cmp ax, -3
    setbe bl

%include "footer.inc"
