#include <asm-generic/ioctls.h>
#define _XOPEN_SOURCE 700
#include <fcntl.h> /* open */
#include <pty.h>
#include <stdint.h> /* uint64_t  */
#include <stdio.h>  /* printf */
#include <stdlib.h> /* size_t */
#include <sys/mman.h>
#include <sys/select.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h> /* pread, sysconf */

#define SHARED_BUFFER_MAX_SIZE 1024

typedef struct {
  uint64_t pfn : 55;
  unsigned int soft_dirty : 1;
  unsigned int file_page : 1;
  unsigned int swapped : 1;
  unsigned int present : 1;
} PagemapEntry;

typedef struct {
  int master;
  int slave;
} pty_t;

/* Parse the pagemap entry for the given virtual address.
 *
 * @param[out] entry      the parsed entry
 * @param[in]  pagemap_fd file descriptor to an open /proc/pid/pagemap file
 * @param[in]  vaddr      virtual address to get entry for
 * @return 0 for success, 1 for failure
 */
int pagemap_get_entry(PagemapEntry *entry, int pagemap_fd, uintptr_t vaddr) {
  size_t nread;
  ssize_t ret;
  uint64_t data;
  uintptr_t vpn;

  vpn = vaddr / sysconf(_SC_PAGE_SIZE);
  nread = 0;
  while (nread < sizeof(data)) {
    ret = pread(pagemap_fd, ((uint8_t *)&data) + nread, sizeof(data) - nread,
                vpn * sizeof(data) + nread);
    nread += ret;
    if (ret <= 0) {
      return 1;
    }
  }
  entry->pfn = data & (((uint64_t)1 << 55) - 1);
  entry->soft_dirty = (data >> 55) & 1;
  entry->file_page = (data >> 61) & 1;
  entry->swapped = (data >> 62) & 1;
  entry->present = (data >> 63) & 1;
  return 0;
}

/* Convert the given virtual address to physical using /proc/PID/pagemap.
 *
 * @param[out] paddr physical address
 * @param[in]  pid   process to convert for
 * @param[in] vaddr virtual address to get entry for
 * @return 0 for success, 1 for failure
 */
int virt_to_phys_user(uintptr_t *paddr, pid_t pid, uintptr_t vaddr) {
  char pagemap_file[BUFSIZ];
  int pagemap_fd;

  snprintf(pagemap_file, sizeof(pagemap_file), "/proc/%ju/pagemap",
           (uintmax_t)pid);
  pagemap_fd = open(pagemap_file, O_RDONLY);
  if (pagemap_fd < 0) {
    return 1;
  }
  PagemapEntry entry;
  if (pagemap_get_entry(&entry, pagemap_fd, vaddr)) {
    return 1;
  }
  close(pagemap_fd);
  *paddr =
      (entry.pfn * sysconf(_SC_PAGE_SIZE)) + (vaddr % sysconf(_SC_PAGE_SIZE));
  return 0;
}
pty_t alloc_aty(char *argv[], char *envp[]) {
  int master, slave;
  openpty(&master, &slave, NULL, NULL, NULL);

  pid_t child = fork();
  if (child == 0) {

    // printf("child: %u\n", child);
    // int _stdout = dup(STDOUT_FILENO);
    // int _stdout = dup(STDOUT_FILENO);
    dup2(slave, STDOUT_FILENO);
    dup2(slave, STDIN_FILENO);
    dup2(slave, STDERR_FILENO);
    execve(argv[0], argv, envp);
  }
  pty_t pty;
  pty.master = master;
  pty.slave = slave;

  return pty;
}

int main() {
  pid_t pid = getpid();
  // printf("pid: %u\n", pid);

  char *argv[] = {"/bin/bash", NULL};

  pty_t expty = alloc_aty(argv, NULL);

  pty_t *ptys[] = {&expty};

  size_t count = 0;
  while (1) {
    ioctl(STDIN_FILENO, FIONREAD, &count);
    if (count > 0) {
      // the main input loop. the host will write to the serial console what
      // pty# it wants to write to, then the size of the data it wants to write

      char req;
      scanf("%c", &req);
      if (req == 'w') {
        int pty_index;
        scanf("%i", &pty_index);
        int in_count;
        scanf("%i", &in_count);

        char *shared_in_buffer = malloc(in_count);
        // this is the buffer that will now be written to by the host after this

        uintptr_t buffer_phys_addr;
        virt_to_phys_user(&buffer_phys_addr, pid, (uintptr_t)shared_in_buffer);

        printf("\005w %lu\n", buffer_phys_addr);
        req = ' ';
        do {
          scanf("%c", &req);
        } while (req != '\006');
        write(ptys[pty_index]->master, shared_in_buffer, in_count);
        free(shared_in_buffer);
      }
    }

    int n_ptys = sizeof(ptys) / sizeof(unsigned long);
    // printf("iterating %i ptys\n", n_ptys);
    for (int i = 0; i < n_ptys; i++) {
      pty_t *pty = ptys[i];

      ioctl(pty->master, FIONREAD, &count);
      if (count < 1)
        continue;
      if (count > SHARED_BUFFER_MAX_SIZE)
        count = SHARED_BUFFER_MAX_SIZE;
      int fd = open("/dev/zero", O_RDWR);
      char shared_out_buffer[count];
      // shared_buffer is the pointer that can be read by the host

      count = read(pty->master, shared_out_buffer, count);
      // printf("#: %i --- slave: %i --- master: %i\n", i, pty->slave,
      //        pty->master);
      //
      uintptr_t buffer_phys_addr;
      virt_to_phys_user(&buffer_phys_addr, pid, (uintptr_t)shared_out_buffer);

      // printf("%lu bytes available at %p, phys addr %lu", count,
      //        shared_out_buffer, buffer_phys_addr);
      printf("\005r %i %lu %lu\n", i, count, buffer_phys_addr);
      char ack;
      do {
        scanf("%c", &ack);
      } while (ack != '\006');
      // free(shared_out_buffer);
    }
  }
}
