global _start

section .data
re_entered:
    db 0

%include "header.inc"

align 0x10000

    cmp byte [re_entered], 0
    jz ok

    ; force a #gp if the code section is re-entered
    mov eax, -1
    mov cr4, eax
    hlt

ok:
    mov byte [re_entered], 1

    mov ecx, 2 ; loop counter variable

    ; NOPs until the beginning of the next page minus one byte
    times ($$-$) % 0x10000 nop

    ; Next page starts here

    ; should jump to absolute address 0xfffe and #gp, as 16-bit eip wraps around
    db 0x66
    loop ($-3)

    ; this should never be executed

%include "footer.inc"
