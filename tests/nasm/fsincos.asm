global _start

%include "header.inc"

    fldpi
    fsincos
    fldz
    fsincos

    fldpi
    fsin
    fldz
    fsin

    fldpi
    fcos
    fldz
    fcos

%include "footer.inc"
