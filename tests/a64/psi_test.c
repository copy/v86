/* PSI triggers under memory pressure, with zram as swap
 * (docs/arm64-virt-android16-plan.md P9.2; what Android's lmkd waits on):
 * a trigger on /proc/pressure/memory, "some" stall of 100 ms in a 1 s
 * window; a child in the memory cgroup CGROUP (the caller limits it) writes
 * MIB MiB of compressible pages, which reclaim moves to zram, and reads them
 * back twice. The trigger must fire meanwhile, the pages come back intact.
 * Built by tools/a64_kernel.mjs.
 *
 *   psi_test <cgroup> <MiB>
 *
 * A64_PSI_CHILD swap=<bytes in swap> zram=<mm_stat> once written,
 * A64_PSI_OK events=N on success, A64_PSI_FAIL <why> else. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void fail(const char *what)
{
    printf("A64_PSI_FAIL %s (errno %d)\n", what, errno);
    exit(1);
}

static void read_line(const char *path, char *buffer, size_t size)
{
    buffer[0] = 0;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if(fd < 0) return;
    ssize_t n = read(fd, buffer, size - 1);
    close(fd);
    buffer[n > 0 ? n : 0] = 0;
    char *end = strchr(buffer, '\n');
    if(end) *end = 0;
}

static void child(const char *cgroup, long mib)
{
    char path[512], swap[64], zram[256];
    snprintf(path, sizeof(path), "%s/cgroup.procs", cgroup);
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if(fd < 0 || write(fd, "0", 1) != 1) fail("join the cgroup");
    close(fd);
    long page = sysconf(_SC_PAGESIZE), words = page / 8;
    size_t size = (size_t)mib << 20, pages = size / page;
    uint64_t *memory = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if(memory == MAP_FAILED) fail("mmap");
    /* (a 64-byte pattern that names the page: compressible, not one value repeated, which zram would keep without compressing) */
    for(size_t p = 0; p < pages; p++) for(long w = 0; w < words; w++) memory[p * words + w] = (uint64_t)p << 32 | (uint64_t)(w & 7);
    snprintf(path, sizeof(path), "%s/memory.swap.current", cgroup);
    read_line(path, swap, sizeof(swap));
    read_line("/sys/block/zram0/mm_stat", zram, sizeof(zram));
    printf("A64_PSI_CHILD swap=%s zram=%s\n", swap, zram);
    size_t bad = 0;
    for(int pass = 0; pass < 2; pass++)
    {
        for(size_t p = 0; p < pages; p++)
        {
            for(long w = 0; w < words; w++) bad += memory[p * words + w] != ((uint64_t)p << 32 | (uint64_t)(w & 7));
        }
    }
    _exit(bad ? 3 : 0);
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if(argc < 3) fail("usage");
    int trigger = open("/proc/pressure/memory", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if(trigger < 0) fail("open /proc/pressure/memory");
    const char *threshold = "some 100000 1000000";
    if(write(trigger, threshold, strlen(threshold) + 1) < 0) fail("write the trigger");
    pid_t pid = fork();
    if(pid < 0) fail("fork");
    if(pid == 0) child(argv[1], atol(argv[2]));
    int events = 0, status = 0;
    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for(;;)
    {
        struct pollfd p = { .fd = trigger, .events = POLLPRI };
        int ready = poll(&p, 1, 100);
        if(ready < 0 && errno != EINTR) fail("poll");
        if(ready > 0 && (p.revents & POLLERR)) fail("POLLERR on the trigger");
        if(ready > 0 && (p.revents & POLLPRI)) events++;
        pid_t done = waitpid(pid, &status, WNOHANG);
        if(done == pid) break;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if(now.tv_sec - start.tv_sec > 900) { kill(pid, SIGKILL); fail("the child takes more than 900 s"); }
    }
    clock_gettime(CLOCK_MONOTONIC, &now);
    if(!WIFEXITED(status) || WEXITSTATUS(status) != 0)
    {
        printf("A64_PSI_FAIL the child: %s %d\n", WIFEXITED(status) ? "exit" : "signal",
            WIFEXITED(status) ? WEXITSTATUS(status) : WTERMSIG(status));
        return 1;
    }
    if(events == 0) fail("no trigger event");
    char some[256];
    read_line("/proc/pressure/memory", some, sizeof(some));
    printf("A64_PSI_OK events=%d seconds=%ld pressure=%s\n", events, (long)(now.tv_sec - start.tv_sec), some);
    return 0;
}
