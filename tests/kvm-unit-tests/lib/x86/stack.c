#include <libcflat.h>
#include <stack.h>

int backtrace_frame(const void *frame, const void **return_addrs, int max_depth)
{
	static int walking;
	int depth = 0;
	const unsigned long *bp = (unsigned long *) frame;

	if (walking) {
		printf("RECURSIVE STACK WALK!!!\n");
		return 0;
	}
	walking = 1;

	for (depth = 0; bp && depth < max_depth; depth++) {
		return_addrs[depth] = (void *) bp[1];
		if (return_addrs[depth] == 0)
			break;
		bp = (unsigned long *) bp[0];
	}

	walking = 0;
	return depth;
}

int backtrace(const void **return_addrs, int max_depth)
{
	return backtrace_frame(__builtin_frame_address(0), return_addrs,
			       max_depth);
}
