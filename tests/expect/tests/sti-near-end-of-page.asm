BITS 32

    ; jmp target is at page offset 0xFEF, which passes the is_near_end_of_page
    ; guard, but the instruction after sti is at 0xFF0, which doesn't. The block
    ; must still be created (sti is a block boundary) and no entry point may be
    ; registered for the instruction after sti.
    jmp .sti_at_fef

    times 0xFEF - ($ - $$) db 0x90

.sti_at_fef:
    sti
    cli
    hlt
