%include "header.inc"

section .text

    ; Check if NX is supported
    mov eax, 0x80000001
    cpuid
    test edx, 1 << 20
    jz .no_nx

    ; Enable PAE
    mov eax, cr4
    or eax, 1 << 5 ; PAE
    mov cr4, eax

    ; Set up page tables
    ; PDPT at 0x4000
    ; PD at 0x5000
    ; PT at 0x6000
    
    ; Clear page table memory (0x4000 to 0x7000)
    mov edi, 0x4000
    mov ecx, 0x3000 / 4
    xor eax, eax
    rep stosd

    ; PDPT[0] -> PD
    mov dword [0x4000], 0x5000 | 1 ; Present

    ; PD[0] -> PT
    mov dword [0x5000], 0x6000 | 1 ; Present

    ; PT[0] -> 0x00000000 (Identity map first page)
    ; PT[1] -> 0x00001000 (Identity map second page)
    mov dword [0x6000], 0x0000 | 3 ; Present, Writable
    mov dword [0x6008], 0x1000 | 3 ; Present, Writable

    ; Set NX bit on the second page (0x1000)
    ; NX is bit 63 of the PTE (bit 31 of the high dword)
    mov dword [0x600C], 0x80000000 

    ; Identity map the code page (0x80000)
    ; 0x80000 / 4096 = 128
    ; PTE index 128 is at 0x6000 + 128 * 8 = 0x6400
    mov dword [0x6400], 0x80000 | 3 ; Present, Writable

    ; Identity map the stack page (0x100000)
    ; 0x100000 / 4096 = 256
    ; PTE index 256 is at 0x6000 + 256 * 8 = 0x6800
    mov dword [0x6800], 0x100000 | 3 ; Present, Writable
    mov dword [0x6808], 0x101000 | 3 ; Present, Writable

    ; Load CR3
    mov eax, 0x4000
    mov cr3, eax

    ; Enable EFER.NXE
    mov ecx, 0xC0000080 ; EFER
    rdmsr
    or eax, 1 << 11 ; NXE
    wrmsr

    ; Enable Paging
    mov eax, cr0
    or eax, 1 << 31 ; PG
    mov cr0, eax

    ; Jump to the NX page
    ; We'll put a 'hlt' there just in case it doesn't fault
    mov byte [0x1000], 0xF4 ; hlt
    jmp 0x1000

.no_nx:
    hlt

%include "footer.inc"
