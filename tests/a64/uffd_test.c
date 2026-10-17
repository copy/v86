/* userfaultfd on the androidish kernel (docs/arm64-virt-android16-plan.md
 * P9.2; ART's concurrent compaction uses it): a region registered for
 * missing-page faults, PAGES pages touched by a thread on another CPU, each
 * fault served by UFFDIO_COPY of a page whose words name it, the contents
 * checked; then UFFDIO_ZEROPAGE for one more page. Built by
 * tools/a64_kernel.mjs with Alpine's GCC and musl.
 *
 *   uffd_test [pages]
 *
 * A64_UFFD_OK faults=N on success, A64_UFFD_FAIL <why> else. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/userfaultfd.h>

static long page;
static int pages = 64;
static uint8_t *region;
static volatile int done;

static void fail(const char *what)
{
    printf("A64_UFFD_FAIL %s (errno %d)\n", what, errno);
    exit(1);
}

static void pin(int cpu)
{
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    sched_setaffinity(0, sizeof(set), &set);
}

static void *toucher(void *arg)
{
    (void)arg;
    pin((int)(sysconf(_SC_NPROCESSORS_ONLN) - 1));
    uint64_t sum = 0;
    for(int p = 0; p < pages; p++)
    {
        uint64_t *words = (uint64_t *)(region + p * page);
        for(long w = 0; w < page / 8; w += 64) sum += words[w] == ((uint64_t)p << 32 | (uint64_t)w) ? 0 : 1;
    }
    done = 1;
    return (void *)(uintptr_t)sum;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if(argc > 1) pages = atoi(argv[1]);
    page = sysconf(_SC_PAGESIZE);
    pin(0);
    int uffd = (int)syscall(SYS_userfaultfd, O_CLOEXEC | O_NONBLOCK);
    if(uffd < 0) fail("userfaultfd");
    struct uffdio_api api = { .api = UFFD_API, .features = 0 };
    if(ioctl(uffd, UFFDIO_API, &api) < 0) fail("UFFDIO_API");
    region = mmap(NULL, (pages + 1) * page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if(region == MAP_FAILED) fail("mmap");
    struct uffdio_register reg = {
        .range = { .start = (uintptr_t)region, .len = (pages + 1) * page }, .mode = UFFDIO_REGISTER_MODE_MISSING,
    };
    if(ioctl(uffd, UFFDIO_REGISTER, &reg) < 0) fail("UFFDIO_REGISTER");
    uint64_t *source = aligned_alloc(page, page);
    pthread_t thread;
    if(pthread_create(&thread, NULL, toucher, NULL) != 0) fail("pthread_create");
    int faults = 0;
    while(!done)
    {
        struct pollfd pfd = { .fd = uffd, .events = POLLIN };
        int ready = poll(&pfd, 1, 2000);
        if(ready < 0) fail("poll");
        if(ready == 0) { if(done) break; fail("no fault in 2 s"); }
        struct uffd_msg msg;
        ssize_t n = read(uffd, &msg, sizeof(msg));
        if(n < 0 && errno == EAGAIN) continue;
        if(n != sizeof(msg)) fail("read");
        if(msg.event != UFFD_EVENT_PAGEFAULT) fail("event");
        uintptr_t address = (uintptr_t)msg.arg.pagefault.address & ~(uintptr_t)(page - 1);
        long p = (long)(address - (uintptr_t)region) / page;
        for(long w = 0; w < page / 8; w++) source[w] = (uint64_t)p << 32 | (uint64_t)w;
        struct uffdio_copy copy = { .dst = address, .src = (uintptr_t)source, .len = page, .mode = 0 };
        if(ioctl(uffd, UFFDIO_COPY, &copy) < 0 && errno != EEXIST) fail("UFFDIO_COPY");
        faults++;
    }
    void *result;
    pthread_join(thread, &result);
    if(result != NULL) fail("contents");
    struct uffdio_zeropage zero = { .range = { .start = (uintptr_t)region + pages * page, .len = page }, .mode = 0 };
    if(ioctl(uffd, UFFDIO_ZEROPAGE, &zero) < 0) fail("UFFDIO_ZEROPAGE");
    for(long b = 0; b < page; b++) if(region[pages * page + b]) fail("zero page");
    if(faults != pages) fail("fault count");
    printf("A64_UFFD_OK faults=%d page=%ld\n", faults, page);
    return 0;
}
