; Benchmark entry for x86-64 PE32+ images (lib/long_mode.asm boots them).
; Parameter block as in lib/crt0.asm: [0x600] iterations (in), [0x604]
; checksum (out), [0x608] status (0 running, 1 done, 0x80000000|vector on
; exception), [0x60C] faulting RIP (a qword). Interrupts stay disabled.
; bench_main(iterations) follows the Microsoft x64 convention: the argument
; in ECX, 32 bytes of shadow space above the return address.
bits 64
default rel
global _start
global ___chkstk_ms
extern bench_main
section .text
_start:
    ; (16-byte aligned at the call, which the shadow space keeps)
    mov rsp, 0x3F0000
    sub rsp, 32
    mov ecx, [abs 0x600]
    call bench_main
    mov [abs 0x604], eax
    mov dword [abs 0x608], 1
    hlt
    jmp $
; MinGW probes stack frames above 4 KiB; the benchmark stack is fully mapped.
___chkstk_ms:
    ret
