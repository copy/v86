/* f2fs with fscrypt across a reboot (docs/arm64-virt-android16-plan.md P9.2;
 * Android's file-based encryption): "setup" adds a 64-byte key to the
 * filesystem, sets a v2 policy (AES-256-XTS contents, AES-256-CTS names) on
 * an empty directory and writes two files into it, one in a subdirectory;
 * the caller unmounts and reboots. "verify", after the reboot, without the
 * key: the policy is there, the key absent, the names encrypted and the
 * files refuse to open (ENOKEY); then the same key added again: its
 * identifier the policy's, the names and the contents back. Built by
 * tools/a64_kernel.mjs.
 *
 *   fscrypt_test setup|verify <mount>
 *
 * A64_FSCRYPT_SETUP id=<identifier> and A64_FSCRYPT_OK id=<identifier> ...
 * on success, A64_FSCRYPT_FAIL <why> else. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <linux/fscrypt.h>

#define SECRET "A64 fscrypt: written before the reboot\n"
#define DEEPER_BYTES (64 * 1024)

static void fail(const char *what)
{
    printf("A64_FSCRYPT_FAIL %s (errno %d)\n", what, errno);
    exit(1);
}

static void hex(char *out, const uint8_t *bytes, int n)
{
    for(int i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", bytes[i]);
}

static void add_key(int fd, uint8_t identifier[FSCRYPT_KEY_IDENTIFIER_SIZE])
{
    struct fscrypt_add_key_arg *arg = calloc(1, sizeof(*arg) + 64);
    arg->key_spec.type = FSCRYPT_KEY_SPEC_TYPE_IDENTIFIER;
    arg->raw_size = 64;
    for(int i = 0; i < 64; i++) arg->raw[i] = (uint8_t)(i * 37 + 11);
    if(ioctl(fd, FS_IOC_ADD_ENCRYPTION_KEY, arg) < 0) fail("FS_IOC_ADD_ENCRYPTION_KEY");
    memcpy(identifier, arg->key_spec.u.identifier, FSCRYPT_KEY_IDENTIFIER_SIZE);
    free(arg);
}

static uint32_t key_status(int fd, const uint8_t identifier[FSCRYPT_KEY_IDENTIFIER_SIZE])
{
    struct fscrypt_get_key_status_arg arg = { 0 };
    arg.key_spec.type = FSCRYPT_KEY_SPEC_TYPE_IDENTIFIER;
    memcpy(arg.key_spec.u.identifier, identifier, FSCRYPT_KEY_IDENTIFIER_SIZE);
    if(ioctl(fd, FS_IOC_GET_ENCRYPTION_KEY_STATUS, &arg) < 0) fail("FS_IOC_GET_ENCRYPTION_KEY_STATUS");
    return arg.status;
}

static void write_file(const char *path, const void *data, size_t size)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if(fd < 0) fail(path);
    if(write(fd, data, size) != (ssize_t)size) fail("write");
    if(fsync(fd) < 0) fail("fsync");
    close(fd);
}

static size_t read_file(const char *path, void *data, size_t size)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if(fd < 0) fail(path);
    size_t total = 0;
    for(ssize_t n; (n = read(fd, (uint8_t *)data + total, size - total)) > 0;) total += n;
    close(fd);
    return total;
}

static void deeper_contents(uint8_t *bytes)
{
    for(int i = 0; i < DEEPER_BYTES; i++) bytes[i] = (uint8_t)(i * 131 + (i >> 9));
}

/* The entries of `directory` but . and ..: how many, whether one is named `name`; each regular file's open errno in *open_errno */
static int entries(const char *directory, const char *name, int *named, int *open_errno)
{
    DIR *d = opendir(directory);
    if(!d) fail("opendir");
    int count = 0;
    *named = 0;
    *open_errno = 0;
    for(struct dirent *e; (e = readdir(d));)
    {
        if(!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        count++;
        if(!strcmp(e->d_name, name)) *named = 1;
        if(e->d_type == DT_REG)
        {
            int fd = openat(dirfd(d), e->d_name, O_RDONLY | O_CLOEXEC);
            if(fd >= 0) close(fd);
            *open_errno = fd >= 0 ? 0 : errno;
        }
    }
    closedir(d);
    return count;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if(argc < 3) fail("usage");
    const char *mount = argv[2];
    char directory[512], path[600], id[2 * FSCRYPT_KEY_IDENTIFIER_SIZE + 1];
    snprintf(directory, sizeof(directory), "%s/enc", mount);
    int root = open(mount, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if(root < 0) fail("open the mount");
    static uint8_t deeper[DEEPER_BYTES], back[DEEPER_BYTES + 1];
    deeper_contents(deeper);
    uint8_t identifier[FSCRYPT_KEY_IDENTIFIER_SIZE];
    if(!strcmp(argv[1], "setup"))
    {
        if(mkdir(directory, 0700) < 0) fail("mkdir");
        add_key(root, identifier);
        int dir = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if(dir < 0) fail("open the directory");
        struct fscrypt_policy_v2 policy = {
            .version = FSCRYPT_POLICY_V2, .contents_encryption_mode = FSCRYPT_MODE_AES_256_XTS,
            .filenames_encryption_mode = FSCRYPT_MODE_AES_256_CTS, .flags = FSCRYPT_POLICY_FLAGS_PAD_32,
        };
        memcpy(policy.master_key_identifier, identifier, FSCRYPT_KEY_IDENTIFIER_SIZE);
        if(ioctl(dir, FS_IOC_SET_ENCRYPTION_POLICY, &policy) < 0) fail("FS_IOC_SET_ENCRYPTION_POLICY");
        close(dir);
        snprintf(path, sizeof(path), "%s/secret.txt", directory);
        write_file(path, SECRET, strlen(SECRET));
        snprintf(path, sizeof(path), "%s/sub", directory);
        if(mkdir(path, 0700) < 0) fail("mkdir sub");
        snprintf(path, sizeof(path), "%s/sub/deeper.bin", directory);
        write_file(path, deeper, DEEPER_BYTES);
        if(syncfs(root) < 0) fail("syncfs");
        hex(id, identifier, FSCRYPT_KEY_IDENTIFIER_SIZE);
        printf("A64_FSCRYPT_SETUP id=%s\n", id);
        return 0;
    }
    if(strcmp(argv[1], "verify")) fail("usage");
    /* (without the key) */
    struct fscrypt_get_policy_ex_arg got = { .policy_size = sizeof(got.policy) };
    int dir = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if(dir < 0) fail("open the directory");
    if(ioctl(dir, FS_IOC_GET_ENCRYPTION_POLICY_EX, &got) < 0) fail("FS_IOC_GET_ENCRYPTION_POLICY_EX");
    close(dir);
    if(got.policy.version != FSCRYPT_POLICY_V2 || got.policy.v2.contents_encryption_mode != FSCRYPT_MODE_AES_256_XTS ||
        got.policy.v2.filenames_encryption_mode != FSCRYPT_MODE_AES_256_CTS) fail("the policy");
    if(key_status(root, got.policy.v2.master_key_identifier) != FSCRYPT_KEY_STATUS_ABSENT) fail("the key is not absent");
    int named, open_errno;
    int locked = entries(directory, "secret.txt", &named, &open_errno);
    if(locked != 2 || named) fail("the names without the key");
    if(open_errno != ENOKEY) { errno = open_errno; fail("a file opens without the key"); }
    /* (with the key) */
    add_key(root, identifier);
    if(memcmp(identifier, got.policy.v2.master_key_identifier, FSCRYPT_KEY_IDENTIFIER_SIZE)) fail("the key's identifier");
    if(key_status(root, identifier) != FSCRYPT_KEY_STATUS_PRESENT) fail("the key is not present");
    if(entries(directory, "secret.txt", &named, &open_errno) != 2 || !named || open_errno) fail("the names with the key");
    snprintf(path, sizeof(path), "%s/secret.txt", directory);
    size_t n = read_file(path, back, sizeof(back));
    if(n != strlen(SECRET) || memcmp(back, SECRET, n)) fail("secret.txt's contents");
    snprintf(path, sizeof(path), "%s/sub/deeper.bin", directory);
    n = read_file(path, back, sizeof(back));
    if(n != DEEPER_BYTES || memcmp(back, deeper, n)) fail("deeper.bin's contents");
    hex(id, identifier, FSCRYPT_KEY_IDENTIFIER_SIZE);
    printf("A64_FSCRYPT_OK id=%s locked_entries=%d enokey=1 files=2\n", id, locked);
    return 0;
}
