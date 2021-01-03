#include "kvmxx.hh"
#include "exception.hh"
#include "memmap.hh"
#include "identity.hh"
#include <stdlib.h>
#include <stdio.h>
#include <sys/time.h>

namespace {

const int page_size	= 4096;
int64_t nr_total_pages	= 256 * 1024;
int64_t nr_slot_pages	= 256 * 1024;

// Return the current time in nanoseconds.
uint64_t time_ns()
{
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * (uint64_t)1000000000 + ts.tv_nsec;
}

// Update nr_to_write pages selected from nr_pages pages.
void write_mem(void* slot_head, int64_t nr_to_write, int64_t nr_pages)
{
    char* var = static_cast<char*>(slot_head);
    int64_t interval = nr_pages / nr_to_write;

    for (int64_t i = 0; i < nr_to_write; ++i) {
        ++(*var);
        var += interval * page_size;
    }
}

// Let the guest update nr_to_write pages selected from nr_pages pages.
void do_guest_write(kvm::vcpu& vcpu, void* slot_head,
                    int64_t nr_to_write, int64_t nr_pages)
{
    identity::vcpu guest_write_thread(vcpu, std::bind(write_mem, slot_head,
                                                      nr_to_write, nr_pages));
    vcpu.run();
}

// Check how long it takes to update dirty log.
void check_dirty_log(kvm::vcpu& vcpu, mem_slot& slot, void* slot_head)
{
    slot.set_dirty_logging(true);
    slot.update_dirty_log();

    for (int64_t i = 1; i <= nr_slot_pages; i *= 2) {
        do_guest_write(vcpu, slot_head, i, nr_slot_pages);

        uint64_t start_ns = time_ns();
        int n = slot.update_dirty_log();
        uint64_t end_ns = time_ns();

        printf("get dirty log: %10lld ns for %10d dirty pages (expected %lld)\n",
               end_ns - start_ns, n, i);
    }

    slot.set_dirty_logging(false);
}

}

void parse_options(int ac, char **av)
{
    int opt;
    char *endptr;

    while ((opt = getopt(ac, av, "n:m:")) != -1) {
        switch (opt) {
        case 'n':
            errno = 0;
            nr_slot_pages = strtol(optarg, &endptr, 10);
            if (errno || endptr == optarg) {
                printf("dirty-log-perf: Invalid number: -n %s\n", optarg);
                exit(1);
            }
            if (*endptr == 'k' || *endptr == 'K') {
                nr_slot_pages *= 1024;
            }
            break;
        case 'm':
            errno = 0;
            nr_total_pages = strtol(optarg, &endptr, 10);
            if (errno || endptr == optarg) {
                printf("dirty-log-perf: Invalid number: -m %s\n", optarg);
                exit(1);
            }
            if (*endptr == 'k' || *endptr == 'K') {
                nr_total_pages *= 1024;
            }
            break;
        default:
            printf("dirty-log-perf: Invalid option\n");
            exit(1);
        }
    }

    if (nr_slot_pages > nr_total_pages) {
        printf("dirty-log-perf: Invalid setting: slot %lld > mem %lld\n",
               nr_slot_pages, nr_total_pages);
        exit(1);
    }
    printf("dirty-log-perf: %lld slot pages / %lld mem pages\n",
           nr_slot_pages, nr_total_pages);
}

int test_main(int ac, char **av)
{
    kvm::system sys;
    kvm::vm vm(sys);
    mem_map memmap(vm);

    parse_options(ac, av);

    void* mem_head;
    int64_t mem_size = nr_total_pages * page_size;
    if (posix_memalign(&mem_head, page_size, mem_size)) {
        printf("dirty-log-perf: Could not allocate guest memory.\n");
        exit(1);
    }
    uint64_t mem_addr = reinterpret_cast<uintptr_t>(mem_head);

    identity::hole hole(mem_head, mem_size);
    identity::vm ident_vm(vm, memmap, hole);
    kvm::vcpu vcpu(vm, 0);

    uint64_t slot_size = nr_slot_pages * page_size;
    uint64_t next_size = mem_size - slot_size;
    uint64_t next_addr = mem_addr + slot_size;
    mem_slot slot(memmap, mem_addr, slot_size, mem_head);
    mem_slot other_slot(memmap, next_addr, next_size, (void *)next_addr);

    // pre-allocate shadow pages
    do_guest_write(vcpu, mem_head, nr_total_pages, nr_total_pages);
    check_dirty_log(vcpu, slot, mem_head);
    return 0;
}

int main(int ac, char** av)
{
    return try_main(test_main, ac, av);
}
