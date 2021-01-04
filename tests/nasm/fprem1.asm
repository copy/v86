global _start

%include "header.inc"

    fld1
    fldz
    fprem1

    fld1
    fldpi
    fprem1

    fld1
    fldl2t
    fprem1

    fldz
    fldz
    fprem1

%include "footer.inc"
