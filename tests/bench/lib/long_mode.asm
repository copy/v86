; v86 CPU benchmark boot for x86-64 images (docs/jit-unification-plan.md
; P0.2): a multiboot kernel that enters 64-bit mode with the first 1 GiB
; identity mapped, enables x87/SSE (and XSAVE/AVX when CPUID reports them),
; installs 64-bit exception stubs that report the vector, then signals
; readiness and halts in 64-bit mode. tests/bench/run.mjs --isa x86_64 then
; loads a PE32+ image (lib/crt0_64.asm) and starts it at its entry.
;
; Memory map as with lib/boot.asm: 0x500 ready marker (0xCAFE), 0x600
; parameter block (lib/crt0_64.asm; the faulting RIP is the qword at 0x60C),
; 0x7000 IDT, 0x10000 PML4, 0x11000 PDPT, 0x12000 page directory, stack
; below 0x3F0000, benchmark images from 0x400000, this boot at 1 MiB.
;
; LARGE_PAGES (nasm -D, default 1): 2 MiB pages throughout, as the review's
; prototype and Windows' kernel mappings; 0 maps the first 64 MiB with 4 KiB
; pages (page tables at 0x13000-0x32FFF).
;
; COMPAT (nasm -D, default 0; P0.2b): 1 halts in compatibility mode instead,
; in the 32-bit code segment 8, so that run.mjs --isa compat32 starts the
; i686 images (lib/crt0.asm) there: 32-bit code under a 64-bit OS, as WOW64.
; Exceptions still go through the 64-bit IDT.
%ifndef LARGE_PAGES
%define LARGE_PAGES 1
%endif
%ifndef COMPAT
%define COMPAT 0
%endif
bits 32
org 0x100000
header:
    dd 0x1BADB002, 0x10000, -(0x1BADB002 + 0x10000)
    dd header, header, image_end, image_end, start
start:
    cli
    cld
    lgdt [gdtr]
    jmp 8:protected
protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov fs, ax
    mov gs, ax
    mov esp, 0x3F0000
    ; PML4, PDPT and page directory: zeroed, then one entry each.
    xor eax, eax
    mov edi, 0x10000
    mov ecx, 3 * 1024
    rep stosd
    mov dword [0x10000], 0x11003
    mov dword [0x11000], 0x12003
    ; Page directory: 512 large pages of 2 MiB (1 GiB).
    mov edi, 0x12000
    mov eax, 0x83
    mov ecx, 512
.pde:
    mov [edi], eax
    add eax, 0x200000
    add edi, 8
    loop .pde
%if LARGE_PAGES == 0
    ; The first 64 MiB in 4 KiB pages instead: 32 page tables.
    mov edi, 0x13000
    mov eax, 3
    mov ecx, 32 * 512
.pte:
    mov [edi], eax
    mov dword [edi + 4], 0
    add eax, 4096
    add edi, 8
    loop .pte
    mov edi, 0x12000
    mov eax, 0x13003
    mov ecx, 32
.pt:
    mov [edi], eax
    add eax, 4096
    add edi, 8
    loop .pt
%endif
    ; CR4.PAE, CR3, EFER.LME, then CR0.PG: compatibility mode until the far jump.
    mov eax, cr4
    or eax, 0x20
    mov cr4, eax
    mov eax, 0x10000
    mov cr3, eax
    mov ecx, 0xC0000080
    rdmsr
    or eax, 0x100
    wrmsr
    mov eax, cr0
    or eax, 0x80000001
    mov cr0, eax
    jmp 24:long_mode
bits 64
; (the parameter block and IDT addresses are absolute)
default abs
long_mode:
    mov rsp, 0x3F0000
    ; IDT: vectors 0-31 report the exception; the rest are absent.
    xor eax, eax
    mov edi, 0x7000
    mov ecx, 512
    rep stosq
    mov edi, 0x7000
    mov rbx, fault0
    xor ecx, ecx
.idt:
    mov rax, rbx
    mov [rdi], ax
    mov word [rdi + 2], 24
    mov word [rdi + 4], 0x8E00
    shr rax, 16
    mov [rdi + 6], ax
    shr rax, 16
    mov [rdi + 8], eax
    add rdi, 16
    add rbx, fault1 - fault0
    inc ecx
    cmp ecx, 32
    jb .idt
    lidt [idtr]
    ; CR0: NE, MP; clear EM and TS. CR4: OSFXSR, OSXMMEXCPT.
    mov rax, cr0
    or eax, 0x22
    and eax, ~0xC
    mov cr0, rax
    mov rax, cr4
    or eax, 0x600
    mov cr4, rax
    ; With XSAVE (CPUID.1:ECX bit 26): CR4.OSXSAVE and XCR0 with x87 and SSE
    ; state, and AVX state with AVX (bit 28)
    mov eax, 1
    cpuid
    bt ecx, 26
    jnc .no_xsave
    mov rax, cr4
    or eax, 1 << 18
    mov cr4, rax
    mov eax, 3
    bt ecx, 28
    jnc .no_avx
    mov eax, 7
.no_avx:
    xor ecx, ecx
    xor edx, edx
    xsetbv
.no_xsave:
    fninit
%if COMPAT
    ; (RETF with 64-bit operands: to the 32-bit code segment)
    push 8
    mov rax, compat_mode
    push rax
    o64 retf
bits 32
compat_mode:
    mov dword [0x500], 0xCAFE
    hlt
    jmp $
bits 64
%else
    mov dword [0x500], 0xCAFE
    hlt
    jmp $
%endif
    ; One 32-byte stub per vector: record 0x80000000 | vector and the
    ; faulting RIP (above the error code where the vector pushes one).
align 32
fault0:
%assign vector 0
%rep 32
    mov dword [0x608], 0x80000000 | vector
%if vector == 8 || (vector >= 10 && vector <= 14) || vector == 17 || vector == 21 || vector == 29 || vector == 30
    mov rax, [rsp + 8]
%else
    mov rax, [rsp]
%endif
    mov [0x60C], rax
    hlt
    jmp $
    align 32
%assign vector vector + 1
%endrep
fault1 equ fault0 + 32
align 8
gdt:
    dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF, 0x00AF9A000000FFFF
gdtr:
    dw 31
    dd gdt
idtr:
    dw 32 * 16 - 1
    dq 0x7000
image_end:
