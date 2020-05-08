#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/user.h>
#include <unistd.h>

int fib(int n)
{
    int first = 0, second = 1, next = 0, i = 0;
    while(i <= n)
    {
        if(i < 2)
        {
            next = i;
        }
        else
        {
            next = first + second;
            first = second;
            second = next;
        }
        i++;
    }
    return next;
}

int pass_test()
{
    return 0x42;
}

void fatal(char *msg)
{
    fprintf(stderr, "*** FATAL ERROR: %s\n", (msg ? msg : "no message"));
    fflush(stderr);
    abort();
}

int main()
{
    static char filename[] = "/tmp/DoubleMapXXXXXX";
    int fd = mkstemp(filename);
    if(fd == -1)
    {
        fatal("mkstemp");
    }
    if(ftruncate(fd, PAGE_SIZE) == -1)
    {
        fatal("ftruncate");
    }

    char *const write_addr = mmap(0, 2 * PAGE_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    char *const exec_addr = mmap(write_addr+PAGE_SIZE, PAGE_SIZE,
                                 PROT_READ | PROT_WRITE | PROT_EXEC, MAP_SHARED | MAP_FIXED, fd, 0);

    if(write_addr == MAP_FAILED || exec_addr == MAP_FAILED)
    {
        fatal("mmap");
    }

    size_t size = PAGE_SIZE;
    memcpy(write_addr, fib, size);

    int (*fun_pointer)() = (void*)exec_addr;

    // Give the JIT something to potentially cache
    for(int i = 0; i < 15000; i++)
    {
        if(fun_pointer(20) != 6765)
        {
            fatal("fibonacci");
        }
    }

    memcpy(write_addr, pass_test, size);
    if(fun_pointer() == 0x42)
    {
        printf("test passed\n");
    }

    munmap(write_addr, size);
    return 0;
}
