#include "libcflat.h"

int main()
{
    int i;

    printf("begining port 0x80 write test\n");
    for (i = 0; i < 10000000; ++i)
	asm volatile("outb %al, $0x80");
    printf("done\n");
    return 0;
}
