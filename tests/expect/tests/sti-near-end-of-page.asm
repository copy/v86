BITS 32

    ; jmp target is at page offset 0xFEF.
    ; follow_jump records an edge to 0x1FEF (0xFEF < 0xFF0, passes the
    ; is_near_end_of_page guard). When that block is compiled, STI is the
    ; first instruction and post-STI lands at 0x1FF0 (= is_near_end_of_page),
    ; so the block is dropped with 0 instructions. The edge remains, making
    ; scc::visit dereference a missing graph key and unwrap() on None.
    jmp .sti_at_fef

    times 0xFEF - ($ - $$) db 0x90

.sti_at_fef:
    sti
    cli
    hlt
