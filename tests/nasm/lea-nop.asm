global _start

%include "header.inc"

    ; nops
    lea edx, [edx]
    db 8Dh, 40h, 00h
    db 8Dh, 0B6h, 00h, 00h, 00h, 00h
    db 8Dh, 0BCh, 27h, 00h, 00h, 00h, 00h

    ; non-nops, but similar encodings
    lea eax, [bx+si]
    lea cx, [bx+di]
    lea edx, [edx+42]
    lea ebp, [ebp*2]

%include "footer.inc"
