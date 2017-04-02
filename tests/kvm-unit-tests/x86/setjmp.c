#include "libcflat.h"
#include "setjmp.h"

int main()
{
    volatile int i;
    jmp_buf j;

    if (setjmp(j) == 0) {
	    i = 0;
    }
    printf("%d\n", i);
    if (++i < 10) {
	    longjmp(j, 1);
    }

    printf("done\n");
    return 0;
}
