MBALIGN     equ  1<<0                   ; align loaded modules on page boundaries
MEMINFO     equ  1<<1                   ; provide memory map
FLAGS       equ  0                      ; this is the Multiboot 'flag' field
MAGIC       equ  0x1BADB002             ; 'magic number' lets bootloader find the header
CHECKSUM    equ -(MAGIC + FLAGS)        ; checksum of above, to prove we are multiboot
section .multiboot
align 4
    dd MAGIC
    dd FLAGS
    dd CHECKSUM

section .bss
    resb 2*4096   ; 0x2000

stack_top:

section .text

_start:
main:
        xor eax, eax
        xor ecx, ecx
        xor edx, edx
        xor ebx, ebx
        mov esp, stack_top
        xor ebp, ebp
        xor esi, esi
        xor edi, edi

        pxor xmm0, xmm0

        ; make space for memory operations
        sub esp, 32

        push 0
        popf
