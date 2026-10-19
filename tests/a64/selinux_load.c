/* SELinux enforcing on the androidish kernel (docs/arm64-virt-android16-plan.md
 * P9.2), what Android's first-stage init does before the second stage: the
 * minimal policy (tests/a64/minimal.cil, compiled by tests/a64/cil2bin.c)
 * written to selinuxfs's load in one write, then enforce. Then a check that
 * the policy is enforced: it declares process:setrlimit and allows no one
 * it, so changing a hard limit fails with EACCES (in a child, which fork and
 * sigchld, allowed, let run and report). Built by tools/a64_kernel.mjs.
 *
 *   selinux_load <policy>
 *
 * A64_SELINUX_OK enforce=1 context=<the process's> denied=setrlimit on
 * success, A64_SELINUX_FAIL <why> else. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define SELINUXFS "/sys/fs/selinux"

static void fail(const char *what)
{
    printf("A64_SELINUX_FAIL %s (errno %d)\n", what, errno);
    exit(1);
}

static int read_text(const char *path, char *buffer, size_t size)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if(fd < 0) return -1;
    ssize_t n = read(fd, buffer, size - 1);
    close(fd);
    if(n < 0) return -1;
    buffer[n] = 0;
    while(n > 0 && (buffer[n - 1] == '\n' || buffer[n - 1] == 0)) buffer[--n] = 0;
    return 0;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if(argc < 2) fail("usage");
    if(mount("selinuxfs", SELINUXFS, "selinuxfs", 0, NULL) < 0 && errno != EBUSY) fail("mount selinuxfs");
    int in = open(argv[1], O_RDONLY | O_CLOEXEC);
    if(in < 0) fail("open policy");
    struct stat st;
    if(fstat(in, &st) < 0) fail("stat policy");
    char *policy = malloc(st.st_size);
    if(read(in, policy, st.st_size) != st.st_size) fail("read policy");
    close(in);
    /* (selinuxfs takes the policy in one write from offset 0) */
    int load = open(SELINUXFS "/load", O_WRONLY | O_CLOEXEC);
    if(load < 0) fail("open load");
    if(write(load, policy, st.st_size) != st.st_size) fail("load the policy");
    close(load);
    int enforce = open(SELINUXFS "/enforce", O_RDWR | O_CLOEXEC);
    if(enforce < 0) fail("open enforce");
    if(write(enforce, "1", 1) != 1) fail("set enforce");
    close(enforce);
    char text[256], context[256], version[32];
    if(read_text(SELINUXFS "/enforce", text, sizeof(text)) < 0 || strcmp(text, "1")) fail("enforce is not 1");
    if(read_text("/proc/self/attr/current", context, sizeof(context)) < 0) fail("attr/current");
    if(read_text(SELINUXFS "/policyvers", version, sizeof(version)) < 0) fail("policyvers");
    pid_t child = fork();
    if(child < 0) fail("fork");
    if(child == 0)
    {
        struct rlimit limit;
        getrlimit(RLIMIT_NOFILE, &limit);
        limit.rlim_max = limit.rlim_cur;
        if(setrlimit(RLIMIT_NOFILE, &limit) == 0) _exit(1);
        _exit(errno == EACCES ? 0 : 2);
    }
    int status;
    if(waitpid(child, &status, 0) < 0 || !WIFEXITED(status)) fail("waitpid");
    if(WEXITSTATUS(status) == 1) fail("setrlimit of the hard limit was allowed");
    if(WEXITSTATUS(status) != 0) fail("setrlimit failed, not with EACCES");
    printf("A64_SELINUX_OK enforce=1 context=%s policy_bytes=%ld kernel_policyvers=%s denied=setrlimit\n",
        context, (long)st.st_size, version);
    return 0;
}
