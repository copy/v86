/* Binder across cores (docs/arm64-virt-android16-plan.md P9.1): a context
 * manager and a client, each bound to its own CPU, exchange ROUNDS
 * transactions through a binderfs device with BINDER_WRITE_READ: the client
 * sends a counter (BC_TRANSACTION to handle 0), the manager answers it plus
 * one (BC_REPLY), both free the buffers the driver gave them. Built by
 * tools/a64_kernel.mjs with Alpine's GCC and musl against the kernel's UAPI
 * headers; run on the androidish kernel (tests/a64/linux_boot.mjs).
 *
 *   binder_pingpong <binderfs mount or device> [rounds] [cpu_a] [cpu_b]
 *
 * Given binderfs's mount, it adds a device "pingpong" through binder-control
 * (BINDER_CTL_ADD) and uses that.
 *
 * A64_BINDER_OK rounds=N cpus=a,b on success, A64_BINDER_FAIL <why> else. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <linux/android/binder.h>
#include <linux/android/binderfs.h>

#define MAP_BYTES (128 * 1024)

static void fail(const char *what)
{
    printf("A64_BINDER_FAIL %s (errno %d)\n", what, errno);
    fflush(stdout);
    exit(1);
}

static void pin(int cpu)
{
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if(sched_setaffinity(0, sizeof(set), &set) < 0) fail("sched_setaffinity");
}

struct conn
{
    int fd;
    uint8_t read_buffer[512];
};

static void open_binder(struct conn *c, const char *path)
{
    c->fd = open(path, O_RDWR | O_CLOEXEC);
    if(c->fd < 0) fail("open");
    struct binder_version version;
    if(ioctl(c->fd, BINDER_VERSION, &version) < 0) fail("BINDER_VERSION");
    if(version.protocol_version != BINDER_CURRENT_PROTOCOL_VERSION) fail("protocol version");
    if(mmap(NULL, MAP_BYTES, PROT_READ, MAP_PRIVATE, c->fd, 0) == MAP_FAILED) fail("mmap");
}

/* Write `write` (len bytes), then read until a command of `want` arrives: its transaction data */
static struct binder_transaction_data read_until(struct conn *c, const void *write, size_t len, uint32_t want)
{
    struct binder_write_read bwr = {
        .write_size = len, .write_consumed = 0, .write_buffer = (binder_uintptr_t)write,
    };
    for(;;)
    {
        bwr.read_size = sizeof(c->read_buffer);
        bwr.read_consumed = 0;
        bwr.read_buffer = (binder_uintptr_t)c->read_buffer;
        if(ioctl(c->fd, BINDER_WRITE_READ, &bwr) < 0)
        {
            if(errno == EINTR) continue;
            fail("BINDER_WRITE_READ");
        }
        bwr.write_size = 0;
        for(size_t at = 0; at < bwr.read_consumed;)
        {
            uint32_t command;
            memcpy(&command, c->read_buffer + at, 4);
            at += 4;
            size_t size = _IOC_SIZE(command);
            if(command == want)
            {
                struct binder_transaction_data txn;
                memcpy(&txn, c->read_buffer + at, sizeof(txn));
                return txn;
            }
            if(command == BR_DEAD_REPLY || command == BR_FAILED_REPLY) fail("dead or failed reply");
            at += size;
        }
    }
}

struct reply_and_free
{
    uint32_t free_command;
    binder_uintptr_t buffer;
    uint32_t reply_command;
    struct binder_transaction_data txn;
} __attribute__((packed));

static void manager(const char *path, int rounds, int cpu)
{
    pin(cpu);
    struct conn c;
    open_binder(&c, path);
    if(ioctl(c.fd, BINDER_SET_CONTEXT_MGR, 0) < 0) fail("BINDER_SET_CONTEXT_MGR");
    uint32_t enter = BC_ENTER_LOOPER;
    struct binder_transaction_data txn = read_until(&c, &enter, sizeof(enter), BR_TRANSACTION);
    for(int round = 0;; round++)
    {
        uint32_t value;
        if(txn.data_size != 4) fail("transaction size");
        memcpy(&value, (const void *)(uintptr_t)txn.data.ptr.buffer, 4);
        if(value != (uint32_t)round * 2) fail("transaction value");
        uint32_t answer = value + 1;
        struct reply_and_free w = {
            .free_command = BC_FREE_BUFFER, .buffer = txn.data.ptr.buffer, .reply_command = BC_REPLY,
            .txn = { .data_size = 4, .data.ptr.buffer = (binder_uintptr_t)&answer },
        };
        if(round + 1 == rounds)
        {
            /* (the last reply: written, then the manager is done) */
            struct binder_write_read bwr = { .write_size = sizeof(w), .write_buffer = (binder_uintptr_t)&w };
            if(ioctl(c.fd, BINDER_WRITE_READ, &bwr) < 0) fail("last reply");
            exit(0);
        }
        txn = read_until(&c, &w, sizeof(w), BR_TRANSACTION);
    }
}

struct transact
{
    uint32_t command;
    struct binder_transaction_data txn;
} __attribute__((packed));

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if(argc < 2) fail("usage");
    const char *path = argv[1];
    static char device[512];
    struct stat st;
    if(stat(path, &st) == 0 && S_ISDIR(st.st_mode))
    {
        snprintf(device, sizeof(device), "%s/binder-control", path);
        int control = open(device, O_RDONLY | O_CLOEXEC);
        if(control < 0) fail("open binder-control");
        struct binderfs_device add = { .name = "pingpong" };
        if(ioctl(control, BINDER_CTL_ADD, &add) < 0 && errno != EEXIST) fail("BINDER_CTL_ADD");
        close(control);
        snprintf(device, sizeof(device), "%s/pingpong", path);
        path = device;
    }
    int rounds = argc > 2 ? atoi(argv[2]) : 10000;
    int cpu_a = argc > 3 ? atoi(argv[3]) : 0, cpu_b = argc > 4 ? atoi(argv[4]) : 1;
    pid_t child = fork();
    if(child < 0) fail("fork");
    if(child == 0) manager(path, rounds, cpu_b);
    pin(cpu_a);
    /* (the manager registers first) */
    usleep(200000);
    struct conn c;
    open_binder(&c, path);
    binder_uintptr_t last = 0;
    for(int round = 0; round < rounds; round++)
    {
        uint32_t value = (uint32_t)round * 2;
        struct
        {
            uint32_t free_command;
            binder_uintptr_t buffer;
            struct transact t;
        } __attribute__((packed)) w = {
            .free_command = BC_FREE_BUFFER, .buffer = last,
            .t = { .command = BC_TRANSACTION, .txn = { .target.handle = 0, .code = 1, .data_size = 4,
                .data.ptr.buffer = (binder_uintptr_t)&value } },
        };
        const void *write = last ? (const void *)&w : (const void *)&w.t;
        size_t len = last ? sizeof(w) : sizeof(w.t);
        struct binder_transaction_data reply = read_until(&c, write, len, BR_REPLY);
        uint32_t answer;
        if(reply.data_size != 4) fail("reply size");
        memcpy(&answer, (const void *)(uintptr_t)reply.data.ptr.buffer, 4);
        if(answer != value + 1) fail("reply value");
        last = reply.data.ptr.buffer;
    }
    int status;
    if(waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) fail("manager");
    printf("A64_BINDER_OK rounds=%d cpus=%d,%d\n", rounds, cpu_a, cpu_b);
    return 0;
}
