.globl setjmp
setjmp:
	mov (%esp), %ecx	// get return EIP
	mov 4(%esp), %eax	// get jmp_buf
	mov %ecx, (%eax)
	mov %esp, 4(%eax)
	mov %ebp, 8(%eax)
	mov %ebx, 12(%eax)
	mov %esi, 16(%eax)
	mov %edi, 20(%eax)
	xor %eax, %eax
	ret

.globl longjmp
longjmp:
	mov 8(%esp), %eax	// get return value
	mov 4(%esp), %ecx	// get jmp_buf
	mov 20(%ecx), %edi
	mov 16(%ecx), %esi
	mov 12(%ecx), %ebx
	mov 8(%ecx), %ebp
	mov 4(%ecx), %esp
	mov (%ecx), %ecx	// get saved EIP
	mov %ecx, (%esp)	// and store it on the stack
	ret
