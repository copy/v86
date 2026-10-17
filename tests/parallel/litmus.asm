; Memory-model and atomicity litmus tests for cores that really run at the
; same time (docs/multicore.md). The same kernel
; runs on cooperative cores as a reference. The BSP starts the APs with
; INIT/SIPI; then every core runs the phases below, separated by barriers:
;
; 1. counters: LOCK INC, LOCK XADD, LOCK CMPXCHG loops, CMPXCHG8B loops, and
;    plain increments inside XCHG and LOCK BTS/BTR spin locks: exact totals;
;    and mixed widths on the same bytes: a LOCK ADD of a dword that crosses
;    a dword boundary (not one aligned atomic access) and a LOCK ADD of the
;    aligned word inside it
; 2. message passing around a ring of cores: plain stores and loads, the
;    payload is always observed with (after) its flag (TSO order)
; 3. store buffering with MFENCE between each pair of cores: never both
;    loads old
; 4. cross-modifying code: core 0 rewrites a function core 1 then calls
;    after a serializing CPUID; core 1 always sees the new code
; 5. wake-ups: a fixed IPI travels around the ring of cores ROUNDS times;
;    each core waits for it in STI; HLT (a lost wake-up hangs the ring)
; 6. paging: all cores enable paging with shared page tables and touch
;    their own pages, whose entries share page-table cache lines: every
;    entry ends up with exactly the right accessed/dirty bits
; 7. long mode (when CONTROL + 0x340 is set): every core enters 64-bit mode
;    and increments a 16-byte counter with LOCK CMPXCHG16B (both halves)
;    and its low qword with LOCK ADD: low = 2 * total, high = total; then
;    in 32-bit compatibility mode (WOW64's) LOCK XADD, a LOCK CMPXCHG loop
;    and LOCK INC on dwords: total, 3 * total, total
; 8. interrupts into 64-bit code from compatibility mode (with phase 7): a
;    fixed IPI travels around the ring of cores ROUNDS times, as in phase 5,
;    but each core waits for it in compatibility-mode code with interrupts
;    enabled, and the 64-bit IDT's gates point above 4 GiB, at an alias of
;    the handlers whose low 32 bits are not mapped. Code that went on as
;    32-bit code after such an interrupt would fetch there (Windows 8.1
;    x64 in parallel mode, WOW64 processes): the fault counts as an error.
;
; Results (host reads them): CONTROL + 0 cores (input), +4 rounds (input),
; +16.. counters, +64.. errors per phase, +128 finished cores, +0x180..
; IPIs received per core, +0x1C0.. phase 8's.

bits 32
org 0x100000

MB_MAGIC equ 0x1BADB002
MB_FLAGS equ 0x10000
CONTROL equ 0x380000
CORES equ CONTROL + 0
ROUNDS equ CONTROL + 4
BARRIER_COUNT equ CONTROL + 8
BARRIER_SENSE equ CONTROL + 12
COUNTERS equ CONTROL + 16       ; 6 dwords + 64-bit at +24 (see below)
C_INC equ COUNTERS + 0
C_XADD equ COUNTERS + 4
C_CMPXCHG equ COUNTERS + 8
C_XCHG_LOCKED equ COUNTERS + 12
C_BTS_LOCKED equ COUNTERS + 16
C_CMPXCHG8B equ COUNTERS + 24   ; 64 bits, 8-aligned
ERRORS equ CONTROL + 64         ; per phase
FINISHED equ CONTROL + 128
SPIN_XCHG equ CONTROL + 0x200
SPIN_BTS equ CONTROL + 0x240
C_MIXED equ CONTROL + 0x302     ; dword at an offset of 2: its low word is also added to
C_WIDE equ CONTROL + 0x320      ; 16 bytes, 16-aligned
LONG_MODE equ CONTROL + 0x340   ; input: run phase 7
LONG_TABLES equ CONTROL + 0x344 ; core 0 built the 4-level tables
C_COMPAT equ CONTROL + 0x350    ; 3 dwords: compatibility mode's counters
LM_PML4 equ 0x3A8000            ; then PDPT, PD: 32 MiB identity mapped
LM_PDPT_HIGH equ LM_PML4 + 0x3000 ; phase 8: HIGH_ALIAS + p -> p (the same PD)
LM_PD_LAPIC equ LM_PML4 + 0x4000 ; phase 8: the local APIC's 2 MiB
HIGH_ALIAS equ 0xFFFF800080000000 ; PML4 entry 256, PDPT entry 2
IDT64 equ 0x3B8000              ; phase 8: 256 16-byte gates
RECORDS equ CONTROL + 0x400     ; 64 bytes per core: +0 barrier sense
MP_DATA equ CONTROL + 0x1000    ; per core: data, flag, ack on separate lines
SB_X equ CONTROL + 0x2000       ; per pair, separate lines
SB_Y equ CONTROL + 0x2040
SB_RESULTS equ CONTROL + 0x3000 ; per pair and round: two bytes
SMC_FLAG equ CONTROL + 0x100
SMC_ACK equ CONTROL + 0x140
SMC_CODE equ 0x3B0000
IPI_COUNT equ CONTROL + 0x180   ; per core
IPI_COUNT64 equ CONTROL + 0x1C0 ; per core, phase 8
IPI_VECTOR equ 0x40
IDT equ 0x390000
PAGE_DIRECTORY equ 0x3A0000
PAGE_TABLES equ 0x3A1000        ; 4 tables: 16 MiB identity mapped
TOUCHED equ 0xC00000            ; per core 16 pages written, 16 pages read
LAPIC equ 0xFEE00000
STACKS equ 0x300000

header:
    dd MB_MAGIC, MB_FLAGS, -(MB_MAGIC + MB_FLAGS)
    dd header, header, end, end, start

start:
    cli
    cld
    lgdt [gdtr]
    jmp 8:.protected
.protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov esp, STACKS + 0x10000
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al
    mov esi, trampoline
    mov edi, 0x8000
    mov ecx, trampoline_end - trampoline
    rep movsb
    mov dword [LAPIC + 0xF0], 0x1FF
    mov ebx, 1
.next_ap:
    cmp ebx, [CORES]
    jae .started
    mov ecx, ebx
    shl ecx, 24
    mov [LAPIC + 0x310], ecx
    mov dword [LAPIC + 0x300], 0xC500 ; INIT level assert
    mov dword [LAPIC + 0x300], 0x8500 ; INIT level deassert
    mov dword [LAPIC + 0x300], 0x608  ; SIPI vector 8
    inc ebx
    jmp .next_ap
.started:
    xor ebx, ebx
    jmp all_cores

; Position-independent 16-bit code at 0x8000
bits 16
trampoline:
    cli
    lgdt [cs:trampoline_gdtr - trampoline]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    jmp dword 8:ap_start
trampoline_gdtr:
    dw gdt_end - gdt - 1
    dd gdt
trampoline_end:
bits 32

ap_start:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov ebx, [LAPIC + 0x20]
    shr ebx, 24
    lea esp, [ebx + 1]
    shl esp, 16
    add esp, STACKS

; ebx = core id (= APIC ID) from here on
all_cores:
    call barrier
    call phase_counters
    call barrier
    call phase_message_passing
    call barrier
    call phase_store_buffering
    call barrier
    call phase_smc
    call barrier
    call phase_ipi
    call barrier
    call phase_paging
    call barrier
    cmp dword [LONG_MODE], 0
    jne phase_long_mode
    lock inc dword [FINISHED]
.halt:
    cli
    hlt
    jmp .halt

; sense-reversing barrier over all cores
barrier:
    push eax
    push ecx
    push edi
    mov edi, ebx
    shl edi, 6
    add edi, RECORDS
    mov ecx, [edi]
    xor ecx, 1
    mov [edi], ecx
    mov eax, 1
    lock xadd [BARRIER_COUNT], eax
    inc eax
    cmp eax, [CORES]
    jne .wait
    mov dword [BARRIER_COUNT], 0
    mov [BARRIER_SENSE], ecx
    jmp .done
.wait:
    pause
    cmp [BARRIER_SENSE], ecx
    jne .wait
.done:
    pop edi
    pop ecx
    pop eax
    ret

phase_counters:
    mov ecx, [ROUNDS]
.loop:
    lock inc dword [C_INC]
    mov eax, 2
    lock xadd [C_XADD], eax
    ; CMPXCHG increment
    mov eax, [C_CMPXCHG]
.retry32:
    lea edx, [eax + 1]
    lock cmpxchg [C_CMPXCHG], edx
    jnz .retry32
    ; XCHG spin lock around a plain increment
.acquire_xchg:
    mov eax, 1
    xchg [SPIN_XCHG], eax
    test eax, eax
    jz .locked_xchg
    pause
    jmp .acquire_xchg
.locked_xchg:
    mov eax, [C_XCHG_LOCKED]
    inc eax
    mov [C_XCHG_LOCKED], eax
    mov dword [SPIN_XCHG], 0
    ; LOCK BTS spin lock, released with LOCK BTR
.acquire_bts:
    lock bts dword [SPIN_BTS], 0
    jnc .locked_bts
    pause
    jmp .acquire_bts
.locked_bts:
    mov eax, [C_BTS_LOCKED]
    inc eax
    mov [C_BTS_LOCKED], eax
    lock btr dword [SPIN_BTS], 0
    ; CMPXCHG8B increment of a 64-bit counter
    push ebx
    push ecx
    mov eax, [C_CMPXCHG8B]
    mov edx, [C_CMPXCHG8B + 4]
.retry64:
    mov ebx, eax
    mov ecx, edx
    add ebx, 1
    adc ecx, 0
    lock cmpxchg8b [C_CMPXCHG8B]
    jnz .retry64
    pop ecx
    pop ebx
    ; mixed widths: both add to the low word, which wraps for large totals;
    ; only the dword add carries into the upper word (litmus.mjs bounds it)
    lock add dword [C_MIXED], 1
    lock add word [C_MIXED], 1
    dec ecx
    jnz .loop
    ret

; core k sends 1..ROUNDS to core (k + 1) % cores, which checks each payload
phase_message_passing:
    mov esi, ebx                    ; my producer slot
    shl esi, 8
    add esi, MP_DATA
    mov eax, ebx                    ; predecessor slot
    test eax, eax
    jnz .has_previous
    mov eax, [CORES]
.has_previous:
    dec eax
    mov edi, eax
    shl edi, 8
    add edi, MP_DATA
    mov ecx, 1
.round:
    ; produce: payload, then flag
    lea eax, [ecx * 3]
    mov [esi], eax
    mov [esi + 64], ecx
    ; consume the predecessor's round
.wait_flag:
    mov eax, [edi + 64]
    cmp eax, ecx
    jae .consume
    pause
    jmp .wait_flag
.consume:
    mov eax, [edi]
    lea edx, [ecx * 3]
    cmp eax, edx
    je .payload_ok
    lock inc dword [ERRORS + 4]
.payload_ok:
    mov [edi + 128], ecx            ; ack
    ; wait until my consumer took this round before overwriting the payload
.wait_ack:
    mov eax, [esi + 128]
    cmp eax, ecx
    jae .next
    pause
    jmp .wait_ack
.next:
    inc ecx
    cmp ecx, [ROUNDS]
    jbe .round
    ret

; pairs (2p, 2p+1): x = r; MFENCE; read y — never both old in one round
phase_store_buffering:
    mov eax, [CORES]
    and eax, ~1
    cmp ebx, eax
    jae .spectator
    mov esi, ebx
    shr esi, 1
    shl esi, 7                      ; pair offset
    lea ebp, [esi + SB_X]
    lea edi, [esi + SB_Y]
    test ebx, 1
    jz .roles
    xchg ebp, edi
.roles:
    ; ebp: my variable, edi: the other one
    mov ecx, 1
.sb_round:
    call barrier
    mov [ebp], ecx
    mfence
    mov eax, [edi]
    cmp eax, ecx
    setb al                         ; the other store was still invisible
    ; byte SB_RESULTS + pair * 4096 + 2 * (round % 2048) + (id & 1)
    mov edx, ebx
    shr edx, 1
    shl edx, 12
    add edx, SB_RESULTS
    push ecx
    and ecx, 2047
    lea edx, [edx + ecx * 2]
    mov ecx, ebx
    and ecx, 1
    add edx, ecx
    pop ecx
    mov [edx], al
    call barrier
    ; the even core checks this round
    test ebx, 1
    jnz .checked
    mov edx, ebx
    shr edx, 1
    shl edx, 12
    add edx, SB_RESULTS
    push ecx
    and ecx, 2047
    lea edx, [edx + ecx * 2]
    pop ecx
    mov al, [edx]
    and al, [edx + 1]
    jz .checked
    lock inc dword [ERRORS + 8]
.checked:
    inc ecx
    cmp ecx, [ROUNDS]
    jbe .sb_round
    ret
.spectator:
    mov ecx, 1
.spectate:
    call barrier
    call barrier
    inc ecx
    cmp ecx, [ROUNDS]
    jbe .spectate
    ret

; core 0 writes "mov eax, 7 * i; ret" at SMC_CODE, core 1 calls it
phase_smc:
    cmp ebx, 1
    ja .done
    mov ecx, 1
.round:
    test ebx, ebx
    jnz .executor
    mov byte [SMC_CODE], 0xB8
    imul eax, ecx, 7
    mov [SMC_CODE + 1], eax
    mov byte [SMC_CODE + 5], 0xC3
    mov [SMC_FLAG], ecx
.wait_ack:
    cmp [SMC_ACK], ecx
    jae .next
    pause
    jmp .wait_ack
.executor:
    cmp [SMC_FLAG], ecx
    jae .execute
    pause
    jmp .executor
.execute:
    push ebx
    push ecx
    xor eax, eax
    cpuid                           ; serializing, as cross-modifying code requires
    mov eax, SMC_CODE
    call eax
    pop ecx
    pop ebx
    imul edx, ecx, 7
    cmp eax, edx
    je .fresh
    lock inc dword [ERRORS + 12]
.fresh:
    mov [SMC_ACK], ecx
.next:
    inc ecx
    cmp ecx, [ROUNDS]
    jbe .round
.done:
    ret

; core k waits for its r-th IPI, then sends one to core (k + 1) % cores;
; core 0 starts each round
phase_ipi:
    test ebx, ebx
    jnz .idt_built
    ; every vector ignores, IPI_VECTOR counts
    mov edi, IDT
    xor ecx, ecx
.gate:
    mov eax, ignore_interrupt
    cmp ecx, IPI_VECTOR
    jne .write_gate
    mov eax, ipi_interrupt
.write_gate:
    mov edx, eax
    and eax, 0xFFFF
    or eax, 8 << 16
    and edx, 0xFFFF0000
    or edx, 0x8E00                  ; present 32-bit interrupt gate
    mov [edi + ecx * 8], eax
    mov [edi + ecx * 8 + 4], edx
    inc ecx
    cmp ecx, 256
    jb .gate
.idt_built:
    call barrier
    lidt [idtr]
    mov dword [LAPIC + 0xF0], 0x1FF ; software-enable this core's APIC
    mov dword [LAPIC + 0x80], 0     ; TPR
    call barrier
    mov ecx, 1
.round:
    test ebx, ebx
    jnz .wait
    call send_ipi
.wait:
    cli
    mov eax, [IPI_COUNT + ebx * 4]
    cmp eax, ecx
    jae .received
    sti
    hlt
    jmp .wait
.received:
    test ebx, ebx
    jz .next                        ; back at core 0: the round is complete
    call send_ipi
.next:
    inc ecx
    cmp ecx, [ROUNDS]
    jbe .round
    ret

send_ipi:
    push eax
    lea eax, [ebx + 1]
    cmp eax, [CORES]
    jb .target
    xor eax, eax
.target:
    shl eax, 24
    mov [LAPIC + 0x310], eax
    mov dword [LAPIC + 0x300], 0x4000 | IPI_VECTOR ; fixed, physical, assert
    pop eax
    ret

ipi_interrupt:
    push eax
    mov eax, [LAPIC + 0x20]
    shr eax, 24
    lock inc dword [IPI_COUNT + eax * 4]
    mov dword [LAPIC + 0xB0], 0     ; EOI
    pop eax
    iretd

ignore_interrupt:
    iretd

; identity-map 16 MiB with 4 KiB pages (core 0 builds the tables)
phase_paging:
    test ebx, ebx
    jnz .wait_tables
    mov edi, PAGE_TABLES
    mov eax, 0x3                    ; present, writable
    mov ecx, 4096
.pte:
    mov [edi], eax
    add eax, 4096
    add edi, 4
    loop .pte
    mov edi, PAGE_DIRECTORY
    mov eax, PAGE_TABLES | 3
    mov ecx, 4
.pde:
    mov [edi], eax
    add eax, 4096
    add edi, 4
    loop .pde
.wait_tables:
    call barrier
    mov eax, PAGE_DIRECTORY
    mov cr3, eax
    mov eax, cr0
    or eax, 0x80000000
    mov cr0, eax
    jmp .paged
.paged:
    ; write 16 pages and read 16 pages of my own; entries of all cores
    ; interleave in the same page table (core c, page i -> TOUCHED + (i * 8 + c) * 4096)
    xor ecx, ecx
.touch:
    mov eax, ecx
    shl eax, 3
    add eax, ebx
    shl eax, 12
    add eax, TOUCHED
    mov dword [eax], 0x1234
    mov eax, ecx
    add eax, 16
    shl eax, 3
    add eax, ebx
    shl eax, 12
    add eax, TOUCHED
    mov edx, [eax]
    inc ecx
    cmp ecx, 16
    jb .touch
    call barrier
    test ebx, ebx
    jnz .paging_done
    ; core 0: check every touched entry of every core
    xor esi, esi                    ; core
.check_core:
    xor ecx, ecx
.check_page:
    mov eax, ecx
    shl eax, 3
    add eax, esi
    shl eax, 12
    add eax, TOUCHED
    mov edx, eax
    shr edx, 12
    mov edx, [PAGE_TABLES + edx * 4]
    xor edx, eax
    cmp edx, 0x63                   ; P, RW, A, D and the right frame
    je .written_ok
    lock inc dword [ERRORS + 16]
.written_ok:
    mov eax, ecx
    add eax, 16
    shl eax, 3
    add eax, esi
    shl eax, 12
    add eax, TOUCHED
    mov edx, eax
    shr edx, 12
    mov edx, [PAGE_TABLES + edx * 4]
    xor edx, eax
    cmp edx, 0x23                   ; accessed, not dirty
    je .read_ok
    lock inc dword [ERRORS + 16]
.read_ok:
    inc ecx
    cmp ecx, 16
    jb .check_page
    inc esi
    cmp esi, [CORES]
    jb .check_core
.paging_done:
    ret

; (does not return: the core finishes in 64-bit mode)
phase_long_mode:
    mov eax, cr0
    and eax, 0x7FFFFFFF             ; paging off to set EFER.LME
    mov cr0, eax
    test ebx, ebx
    jnz .wait_tables
    mov edi, LM_PML4
    xor eax, eax
    mov ecx, 5 * 1024
    rep stosd
    mov dword [LM_PML4], LM_PML4 + 0x1000 + 3
    mov dword [LM_PML4 + 0x1000], LM_PML4 + 0x2000 + 3
    mov edi, LM_PML4 + 0x2000
    mov eax, 0x83                   ; 2 MiB pages
    mov ecx, 16
.pde:
    mov [edi], eax
    add eax, 0x200000
    add edi, 8
    loop .pde
    ; phase 8: the high alias of the first 32 MiB, and the local APIC
    mov dword [LM_PML4 + 256 * 8], LM_PDPT_HIGH + 3
    mov dword [LM_PDPT_HIGH + 2 * 8], LM_PML4 + 0x2000 + 3
    mov dword [LM_PML4 + 0x1000 + 3 * 8], LM_PD_LAPIC + 3
    mov dword [LM_PD_LAPIC + (LAPIC >> 21 & 511) * 8], LAPIC | 0x93 ; (PCD)
    ; and the 64-bit IDT: the IPI at handler_ipi64, every other vector at
    ; handler_fault64, both through the high alias
    mov edi, IDT64
    xor ecx, ecx
.gate64:
    mov eax, handler_fault64 + (HIGH_ALIAS & 0xFFFFFFFF)
    cmp ecx, IPI_VECTOR
    jne .write_gate64
    mov eax, handler_ipi64 + (HIGH_ALIAS & 0xFFFFFFFF)
.write_gate64:
    mov edx, eax
    and eax, 0xFFFF
    or eax, 24 << 16                ; the 64-bit code segment
    and edx, 0xFFFF0000
    or edx, 0x8E00                  ; present 64-bit interrupt gate
    mov [edi], eax
    mov [edi + 4], edx
    mov dword [edi + 8], HIGH_ALIAS >> 32
    mov dword [edi + 12], 0
    add edi, 16
    inc ecx
    cmp ecx, 256
    jb .gate64
    mov dword [LONG_TABLES], 1
.wait_tables:
    pause
    cmp dword [LONG_TABLES], 1
    jne .wait_tables
    mov eax, cr4
    or eax, 0x20                    ; PAE
    mov cr4, eax
    mov eax, LM_PML4
    mov cr3, eax
    mov ecx, 0xC0000080
    rdmsr
    or eax, 0x100                   ; LME
    wrmsr
    mov eax, cr0
    or eax, 0x80000000
    mov cr0, eax
    jmp 24:long_mode_entry

bits 64
long_mode_entry:
    lidt [idtr64]
    mov r8d, [ROUNDS]
.loop:
    mov rax, [C_WIDE]
    mov rdx, [C_WIDE + 8]
.retry:
    lea rbx, [rax + 1]
    lea rcx, [rdx + 1]
    lock cmpxchg16b [C_WIDE]
    jnz .retry                      ; (RDX:RAX now holds the current value)
    lock add qword [C_WIDE], 1
    dec r8d
    jnz .loop
    ; (to compatibility mode: the 32-bit code segment, LMA set)
    push 8
    mov eax, compat_entry
    push rax
    o64 retf
bits 32
compat_entry:
    mov ecx, [ROUNDS]
.round:
    mov eax, 1
    lock xadd [C_COMPAT], eax
    mov eax, [C_COMPAT + 4]
.cas:
    lea edx, [eax + 3]
    lock cmpxchg [C_COMPAT + 4], edx
    jnz .cas                        ; (EAX now holds the current value)
    lock inc dword [C_COMPAT + 8]
    dec ecx
    jnz .round
    ; phase 8: core k waits in this mode, with interrupts enabled, for its
    ; r-th IPI, then sends one to core (k + 1) % cores (send_ipi); core 0
    ; starts each round
    mov ebx, [LAPIC + 0x20]
    shr ebx, 24
    call barrier                    ; (every core's IDTR holds IDT64)
    sti
    mov ecx, 1
.ipi_round:
    test ebx, ebx
    jnz .ipi_wait
    call send_ipi
.ipi_wait:
    ; (a read across a page boundary: the page tier's parallel build
    ; leaves its function for the interpreter at each one, so that IPIs
    ; also arrive between two of its activations)
    mov eax, [CONTROL + 0xFFE]
    mov eax, [IPI_COUNT64 + ebx * 4]
    cmp eax, ecx
    jae .ipi_received
    pause                           ; (cores taking turns: the next one)
    jmp .ipi_wait
.ipi_received:
    test ebx, ebx
    jz .ipi_next                    ; back at core 0: the round is complete
    call send_ipi
.ipi_next:
    inc ecx
    cmp ecx, [ROUNDS]
    jbe .ipi_round
    cli
    lock inc dword [FINISHED]
.halt:
    cli
    hlt
    jmp .halt

; Phase 8's handlers, entered through HIGH_ALIAS (64-bit code: CONTROL and
; its counters are below 2 GiB, the local APIC is not)
bits 64
handler_ipi64:
    push rax
    push rdx
    mov edx, LAPIC
    mov eax, [rdx + 0x20]
    shr eax, 24
    lock inc dword [IPI_COUNT64 + rax * 4]
    mov dword [rdx + 0xB0], 0       ; EOI
    pop rdx
    pop rax
    iretq
handler_fault64:
    lock inc dword [ERRORS + 20]
    lock inc dword [FINISHED]
.halt:
    cli
    hlt
    jmp .halt
bits 32

align 8
gdt:
    dq 0
    dq 0x00CF9A000000FFFF
    dq 0x00CF92000000FFFF
    dq 0x00AF9A000000FFFF           ; 64-bit code
gdt_end:
gdtr:
    dw gdt_end - gdt - 1
    dd gdt
idtr:
    dw 256 * 8 - 1
    dd IDT
idtr64:
    dw 256 * 16 - 1
    dq IDT64
end:
