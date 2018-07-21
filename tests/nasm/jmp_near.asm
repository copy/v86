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

    jmp page_start

    ; NOPs until the beginning of the next page minus two bytes
    times ($$-$) % 0x10000 - 2 nop
    jmp fail

    ; Next page starts here

page_start:
    ; should jump to absolute address 0xfffe and #gp, as 16-bit eip wraps around
    ; jumps to "fail" if 32-bit eip is used
    db 0x66
    jmp ($-3)

fail:
    ; this should never be executed

%include "footer.inc"
