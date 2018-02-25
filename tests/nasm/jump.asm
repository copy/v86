global _start

section .data
	align 16

%include "header.inc"

    mov eax, 0
    mov ebx, 0
    mov ecx, 0
    mov edx, 0
    mov esi, 0
    mov edi, 0

    ; skip
    jmp .target1
    inc eax
.target1:

    ; conditional jump up
.target2:
    inc ebx
    inc ecx
    cmp ebx, 2
    jne .target2

    ; conditional jump down
.target3:
    cmp ebx, 4
    je .target4
    inc ebx
    inc edx
    jmp .target3

.target4:
    call .fun
    call .not_returning_fun
.after_call:
    jmp .after_fun

.fun:
    inc esi
    ret

.not_returning_fun:
    inc esi
    jmp .after_call
    inc esi
    ret

.after_fun:
    push .target5
    ret
.target5:

    ; clear stack (pushed eip is not the same between vm and gdb execution)
    mov dword [esp], 0
    mov dword [esp-4], 0

%include "footer.inc"
