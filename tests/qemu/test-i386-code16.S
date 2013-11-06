        .code16
        .globl code16_start
        .globl code16_end

CS_SEG = 0xf

code16_start:

        .globl code16_func1

        /* basic test */
code16_func1 = . - code16_start
        mov $1, %eax
        data32 lret

/* test push/pop in 16 bit mode */
        .globl code16_func2
code16_func2 = . - code16_start
        xor %eax, %eax
        mov $0x12345678, %ebx
        movl %esp, %ecx
        push %bx
        subl %esp, %ecx
        pop %ax
        data32 lret

/* test various jmp opcodes */
        .globl code16_func3
code16_func3 = . - code16_start
        jmp 1f
        nop
1:
        mov $4, %eax
        mov $0x12345678, %ebx
        xor %bx, %bx
        jz 2f
        add $2, %ax
2:

        call myfunc

        lcall $CS_SEG, $(myfunc2 - code16_start)

        ljmp $CS_SEG, $(myjmp1 - code16_start)
myjmp1_next:

        cs lcall *myfunc2_addr - code16_start

        cs ljmp *myjmp2_addr - code16_start
myjmp2_next:

        data32 lret

myfunc2_addr:
        .short myfunc2 - code16_start
        .short CS_SEG

myjmp2_addr:
        .short myjmp2 - code16_start
        .short CS_SEG

myjmp1:
        add $8, %ax
        jmp myjmp1_next

myjmp2:
        add $16, %ax
        jmp myjmp2_next

myfunc:
        add $1, %ax
        ret

myfunc2:
        add $4, %ax
        lret


code16_end:
