; End-to-end test for #GP delivery on a malformed IDT entry (issue #636).
;
; Builds a 32-bit protected-mode IDT in which vector 0x80 has a deliberately
; malformed access byte (0x9E -- bit 4 of the type field set, which violates
; the reserved-zeros invariant for non-task gates). `INT 0x80` should raise
; a properly formed #GP, dispatched through a sane vector-13 handler.
;
; Per Intel SDM Vol 3 Section 6.13, an IDT-related #GP raised while
; delivering a software interrupt has error code
;   (vector << 3) | IDT(2) | EXT(0) = (0x80 << 3) | 2 = 0x00000402
; and the test prints this as "gp=00000402 OK" over COM1.

BITS 16
ORG 0x7C00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00

    lgdt [gdt_desc]

    mov eax, cr0
    or eax, 1
    mov cr0, eax

    jmp 0x08:pmode

BITS 32
pmode:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov esp, 0x9000

    ; "boot\n" so the harness sees we made it into pmode.
    mov al, 'b'
    call serout
    mov al, 'o'
    call serout
    mov al, 'o'
    call serout
    mov al, 't'
    call serout
    mov al, 0x0A
    call serout

    ; Zero a 2KB IDT region at 0x8000 (256 entries * 8 bytes).
    cld
    xor eax, eax
    mov edi, 0x8000
    mov ecx, 512
    rep stosd

    ; Vector 13 (#GP) -> gp_handler, valid 32-bit interrupt gate.
    mov edi, 0x8000 + 13 * 8
    mov eax, gp_handler
    mov [edi], ax
    mov word [edi + 2], 0x08
    mov byte [edi + 4], 0x00
    mov byte [edi + 5], 0x8E    ; P=1, DPL=0, type=0xE (32-bit int gate)
    shr eax, 16
    mov [edi + 6], ax

    ; Vector 0x80 -> dummy_handler with MALFORMED access byte 0x9E.
    ; Bit 4 of the type field is the reserved-zeros bit; setting it is
    ; precisely what reserved_zeros_are_valid() in cpu.rs flags.
    mov edi, 0x8000 + 0x80 * 8
    mov eax, dummy_handler
    mov [edi], ax
    mov word [edi + 2], 0x08
    mov byte [edi + 4], 0x00
    mov byte [edi + 5], 0x9E    ; <-- the malformed entry under test
    shr eax, 16
    mov [edi + 6], ax

    lidt [idt_desc]

    ; "int\n" so we know we reached the trigger.
    mov al, 'i'
    call serout
    mov al, 'n'
    call serout
    mov al, 't'
    call serout
    mov al, 0x0A
    call serout

    int 0x80

    ; If we get here, the malformed descriptor was somehow handled without
    ; ever invoking #GP. Print "BAD" so the harness fails loudly instead of
    ; concluding "OK" on the silence.
    mov al, 'B'
    call serout
    mov al, 'A'
    call serout
    mov al, 'D'
    call serout
    mov al, 0x0A
    call serout
.hang_unexpected:
    cli
    hlt
    jmp .hang_unexpected

; Should never run -- vector 0x80 is malformed; the descriptor walk faults
; before this code is reached.
dummy_handler:
    iretd

; #GP handler. With a 32-bit interrupt gate raising a fault that has an
; error code, the stack on entry is: ERROR_CODE (top), EIP, CS, EFLAGS.
gp_handler:
    pop eax                     ; error code into eax

    ; "gp=" prefix
    push eax
    mov al, 'g'
    call serout
    mov al, 'p'
    call serout
    mov al, '='
    call serout
    pop eax

    ; Print the 32-bit error code as 8 hex digits, MSB first.
    mov ecx, 8
.hexloop:
    rol eax, 4
    push eax
    and eax, 0x0F
    cmp al, 10
    jl .digit
    add al, 'a' - 10
    jmp .emit
.digit:
    add al, '0'
.emit:
    call serout
    pop eax
    loop .hexloop

    mov al, ' '
    call serout
    mov al, 'O'
    call serout
    mov al, 'K'
    call serout
    mov al, 0x0A
    call serout

    cli
.hang:
    hlt
    jmp .hang

; Write AL to COM1. v86's serial0 is wired to port 0x3F8.
serout:
    push edx
    mov dx, 0x3F8
    out dx, al
    pop edx
    ret

align 8
gdt:
    dq 0
    dq 0x00CF9A000000FFFF       ; CS: flat ring-0 code, 32-bit
    dq 0x00CF92000000FFFF       ; DS/ES/SS: flat ring-0 data
gdt_end:

gdt_desc:
    dw gdt_end - gdt - 1
    dd gdt

idt_desc:
    dw 256 * 8 - 1
    dd 0x8000

times 510 - ($ - $$) db 0
dw 0xAA55
