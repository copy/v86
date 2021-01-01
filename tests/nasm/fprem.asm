global _start

%include "header.inc"

    fld1
    fldz
    fprem

    fld1
    fldpi
    fprem

    fld1
    fldl2t
    fprem

    fldz
    fldz
    fprem

%include "footer.inc"
