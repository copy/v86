#ifndef _KBUILD_H_
#define _KBUILD_H_
#define DEFINE(sym, val) \
	asm volatile("\n->" #sym " %0 " #val : : "i" (val))
#define OFFSET(sym, str, mem)	DEFINE(sym, offsetof(struct str, mem))
#define COMMENT(x)		asm volatile("\n->#" x)
#define BLANK()			asm volatile("\n->" : : )
#endif
