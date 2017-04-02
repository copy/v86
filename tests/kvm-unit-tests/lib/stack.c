#include <libcflat.h>
#include <stack.h>

#define MAX_DEPTH 20

static void print_stack(const void **return_addrs, int depth,
			bool top_is_return_address)
{
	int i = 0;

	printf("\tSTACK:");

	/* @addr indicates a non-return address, as expected by the stack
	 * pretty printer script. */
	if (depth > 0 && !top_is_return_address) {
		printf(" @%lx", (unsigned long) return_addrs[0]);
		i++;
	}

	for (; i < depth; i++) {
		printf(" %lx", (unsigned long) return_addrs[i]);
	}
	printf("\n");
}

void dump_stack(void)
{
	const void *return_addrs[MAX_DEPTH];
	int depth;

	depth = backtrace(return_addrs, MAX_DEPTH);
	print_stack(&return_addrs[1], depth ? depth - 1 : 0, true);
}

void dump_frame_stack(const void *instruction, const void *frame)
{
	const void *return_addrs[MAX_DEPTH];
	int depth;

	return_addrs[0] = instruction;
	depth = backtrace_frame(frame, &return_addrs[1], MAX_DEPTH - 1);
	print_stack(return_addrs, depth + 1, false);
}

#ifndef HAVE_ARCH_BACKTRACE
int backtrace(const void **return_addrs, int max_depth)
{
	static int walking;
	int depth = 0;
	void *addr;

	if (walking) {
		printf("RECURSIVE STACK WALK!!!\n");
		return 0;
	}
	walking = 1;

	/* __builtin_return_address requires a compile-time constant argument */
#define GET_RETURN_ADDRESS(i)						\
	if (max_depth == i)						\
		goto done;						\
	addr = __builtin_return_address(i);				\
	if (!addr)							\
		goto done;						\
	return_addrs[i] = __builtin_extract_return_addr(addr);		\
	depth = i + 1;							\

	GET_RETURN_ADDRESS(0)
	GET_RETURN_ADDRESS(1)
	GET_RETURN_ADDRESS(2)
	GET_RETURN_ADDRESS(3)
	GET_RETURN_ADDRESS(4)
	GET_RETURN_ADDRESS(5)
	GET_RETURN_ADDRESS(6)
	GET_RETURN_ADDRESS(7)
	GET_RETURN_ADDRESS(8)
	GET_RETURN_ADDRESS(9)
	GET_RETURN_ADDRESS(10)
	GET_RETURN_ADDRESS(11)
	GET_RETURN_ADDRESS(12)
	GET_RETURN_ADDRESS(13)
	GET_RETURN_ADDRESS(14)
	GET_RETURN_ADDRESS(15)
	GET_RETURN_ADDRESS(16)
	GET_RETURN_ADDRESS(17)
	GET_RETURN_ADDRESS(18)
	GET_RETURN_ADDRESS(19)
	GET_RETURN_ADDRESS(20)

#undef GET_RETURN_ADDRESS

done:
	walking = 0;
	return depth;
}
#endif  /* HAVE_ARCH_BACKTRACE */
