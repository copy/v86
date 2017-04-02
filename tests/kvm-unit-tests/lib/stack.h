#ifndef _STACK_H_
#define _STACK_H_

#include <libcflat.h>
#include <asm/stack.h>

#ifdef HAVE_ARCH_BACKTRACE_FRAME
extern int backtrace_frame(const void *frame, const void **return_addrs,
			   int max_depth);
#else
static inline int
backtrace_frame(const void *frame __unused, const void **return_addrs __unused,
		int max_depth __unused)
{
	return 0;
}
#endif

extern int backtrace(const void **return_addrs, int max_depth);

#endif
