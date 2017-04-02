#ifndef LIBCFLAT_SETJMP_H
#define LIBCFLAT_SETJMP_H 1

typedef struct jmp_buf_tag {
	long int regs[8];
} jmp_buf[1];

extern int setjmp (struct jmp_buf_tag env[1]);
extern void longjmp (struct jmp_buf_tag env[1], int val)
     __attribute__ ((__noreturn__));

#endif /* setjmp.h  */
