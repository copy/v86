#include "vm.h"
#include "libcflat.h"

int sieve(char* data, int size)
{
    int i, j, r = 0;

    for (i = 0; i < size; ++i)
	data[i] = 1;

    data[0] = data[1] = 0;

    for (i = 2; i < size; ++i)
	if (data[i]) {
	    ++r;
	    for (j = i*2; j < size; j += i)
		data[j] = 0;
	}
    return r;
}

void test_sieve(const char *msg, char *data, int size)
{
    int r;

    printf("%s:", msg);
    r = sieve(data, size);
    printf("%d out of %d\n", r, size);
}

#define STATIC_SIZE 1000000
#define VSIZE 2000000
char static_data[STATIC_SIZE];

int main()
{
    void *v;
    int i;

    printf("starting sieve\n");
    test_sieve("static", static_data, STATIC_SIZE);
    setup_vm();
    test_sieve("mapped", static_data, STATIC_SIZE);
    for (i = 0; i < 3; ++i) {
	v = vmalloc(VSIZE);
	test_sieve("virtual", v, VSIZE);
	vfree(v);
    }

    return 0;
}
