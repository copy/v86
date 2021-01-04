global _start

%include "header.inc"

    fstcw [esp]
    and word [esp], ~0x300
    or word [esp], 0x200
    fldcw [esp]

    fldpi
    fld1
    fmul
    fstp tword [esp]

%include "footer.inc"
