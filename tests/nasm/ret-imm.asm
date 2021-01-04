global _start

%include "header.inc"

    jmp start
foo:
    mov eax, esp
    ret 123

start:
    call foo
    mov dword [eax], 0 ; clear the address pushed by the call instruction


%include "footer.inc"
