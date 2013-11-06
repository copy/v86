        .code16
        .globl vm86_code_start
        .globl vm86_code_end

#define GET_OFFSET(x) ((x) - vm86_code_start + 0x100)

vm86_code_start:
        movw $GET_OFFSET(hello_world), %dx
        movb $0x09, %ah
        int $0x21

        /* prepare int 0x90 vector */
        xorw %ax, %ax
        movw %ax, %es
        es movw $GET_OFFSET(int90_test), 0x90 * 4
        es movw %cs, 0x90 * 4 + 2

        /* launch int 0x90 */

        int $0x90

        /* test IF support */
        movw $GET_OFFSET(IF_msg), %dx
        movb $0x09, %ah
        int $0x21

        pushf
        popw %dx
        movb $0xff, %ah
        int $0x21

        cli
        pushf
        popw %dx
        movb $0xff, %ah
        int $0x21

        sti
        pushfl
        popl %edx
        movb $0xff, %ah
        int $0x21

#if 0
        movw $GET_OFFSET(IF_msg1), %dx
        movb $0x09, %ah
        int $0x21

        pushf
        movw %sp, %bx
        andw $~0x200, (%bx)
        popf
#else
        cli
#endif

        pushf
        popw %dx
        movb $0xff, %ah
        int $0x21

        pushfl
        movw %sp, %bx
        orw $0x200, (%bx)
        popfl

        pushfl
        popl %edx
        movb $0xff, %ah
        int $0x21

        movb $0x00, %ah
        int $0x21

int90_test:
        pushf
        pop %dx
        movb $0xff, %ah
        int $0x21

        movw %sp, %bx
        movw 4(%bx), %dx
        movb $0xff, %ah
        int $0x21

        movw $GET_OFFSET(int90_msg), %dx
        movb $0x09, %ah
        int $0x21
        iret

int90_msg:
        .string "INT90 started\n$"

hello_world:
        .string "Hello VM86 world\n$"

IF_msg:
        .string "VM86 IF test\n$"

IF_msg1:
        .string "If you see a diff here, your Linux kernel is buggy, please update to 2.4.20 kernel\n$"

vm86_code_end:
