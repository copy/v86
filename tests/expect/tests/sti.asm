BITS 32
    sti
    mov eax, 42424242
    ; the mov above runs interpreted inside instr_FB, which then calls handle_irqs
    mov eax, 53535353

    hlt

