#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
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

void test_shared()
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

    uint8_t *const write_addr = mmap(0, 2 * PAGE_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    uint8_t *const exec_addr = mmap(write_addr+PAGE_SIZE, PAGE_SIZE,
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
        printf("test_shared passed\n");
    }

    munmap(write_addr, 2 * size);
    munmap(exec_addr, size);
}


void test_consecutive()
{
    uint8_t *const page0 = mmap(NULL,
            2 * PAGE_SIZE, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    // throwaway mmap to reduce likelhood of page0 and page1 mapping to consecutive physical frames
    uint8_t *const throwaway = mmap(NULL,
            PAGE_SIZE, PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    uint8_t *const page1 = mmap(page0 + PAGE_SIZE, PAGE_SIZE,
            PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);

    if(page0 == MAP_FAILED || throwaway == MAP_FAILED || page1 == MAP_FAILED)
    {
        fatal("mmap");
    }

    // Attempt to influence virtual to physical mapping - we want page0->page1 to not be contiguous
    // physically
    page0[0] = 0;
    throwaway[0] = 0;
    page1[0] = 0;

    for(int32_t i = 0; i < 100; i++)
    {
        uint8_t* start = (uint8_t*)(page1 - i - 1);
        memcpy(start, fib, PAGE_SIZE);
        int (*fun_pointer)() = (void*)start;

        for(int j = 0; j < 15000; j++)
        {
            if(fun_pointer(20) != 6765)
            {
                fatal("fibonacci");
            }
        }
    }

    printf("test_consecutive passed\n");
}

void test_consecutive_written()
{
    uint8_t *const page0 = mmap(NULL,
            2 * PAGE_SIZE, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    // throwaway mmap to reduce likelhood of page0 and page1 mapping to consecutive physical frames
    uint8_t *const throwaway = mmap(NULL,
            PAGE_SIZE, PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    uint8_t *const page1 = mmap(page0 + PAGE_SIZE, PAGE_SIZE,
            PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);

    if(page0 == MAP_FAILED || throwaway == MAP_FAILED || page1 == MAP_FAILED)
    {
        fatal("mmap");
    }

    // Attempt to influence virtual to physical mapping - we want page0->page1 to not be contiguous
    // physically
    page0[0] = 0;
    throwaway[0] = 0;
    page1[0] = 0;

    uint8_t* start = page1 - 8;
    uint8_t* ptr = start;
    const int32_t INC_COUNT = 16;

    // xor eax, eax
    *ptr++ = 0x31;
    *ptr++ = 0xc0;

    for(int i = 0; i < INC_COUNT; i++)
    {
        // inc eax
        *ptr++ = 0x40;
    }

    // ret
    *ptr++ = 0xC3;

    int (*fun_pointer)() = (void*)start;

    for(int i = 0; i < 15000; i++)
    {
        int32_t result = fun_pointer();

        if(result != INC_COUNT)
        {
            fatal("test_consecutive_written");
        }
    }

    // overwrite one INC at the start of the second page with a NOP
    *page1 = 0x90;

    int32_t result = fun_pointer();

    if(result != INC_COUNT - 1)
    {
        fatal("test_consecutive_written after overwrite");
    }

    printf("test_consecutive_written passed\n");
}

int main()
{
    test_shared();

    // disabled for now, takes long and not sure if it actually catches bugs
    //test_consecutive();

    test_consecutive_written();

    return 0;
}
