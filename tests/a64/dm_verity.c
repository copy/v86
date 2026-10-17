/* A dm-verity device through the device mapper's ioctls on
 * /dev/mapper/control (docs/arm64-virt-android16-plan.md P9.2), what
 * Android's first-stage init does with libdm, without dmsetup:
 * DM_DEV_CREATE, DM_TABLE_LOAD with one verity target, DM_DEV_SUSPEND
 * without the suspend flag (resume: the table goes live). Built by
 * tools/a64_kernel.mjs.
 *
 *   dm_verity <name> <sectors> <verity's parameters...>
 *
 * Prints the device's node, /dev/dm-<minor>; A64_VERITY_FAIL <why> on stderr else. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/sysmacros.h>
#include <unistd.h>
#include <linux/dm-ioctl.h>

static void fail(const char *what)
{
    fprintf(stderr, "A64_VERITY_FAIL %s (errno %d)\n", what, errno);
    exit(1);
}

static union
{
    struct dm_ioctl io;
    uint8_t bytes[16384];
} buffer;

static void prepare(const char *name, size_t data_size)
{
    memset(&buffer, 0, sizeof(buffer));
    buffer.io.version[0] = DM_VERSION_MAJOR;
    buffer.io.data_size = sizeof(struct dm_ioctl) + data_size;
    buffer.io.data_start = sizeof(struct dm_ioctl);
    /* (verity's table must be read-only: its devices are opened without write) */
    buffer.io.flags = DM_READONLY_FLAG;
    snprintf(buffer.io.name, sizeof(buffer.io.name), "%s", name);
}

int main(int argc, char **argv)
{
    if(argc < 4) fail("usage");
    const char *name = argv[1];
    char parameters[8192] = "";
    for(int i = 3; i < argc; i++)
    {
        if(strlen(parameters) + strlen(argv[i]) + 2 > sizeof(parameters)) fail("parameters too long");
        if(i > 3) strcat(parameters, " ");
        strcat(parameters, argv[i]);
    }
    int control = open("/dev/mapper/control", O_RDWR | O_CLOEXEC);
    if(control < 0) fail("open /dev/mapper/control");
    prepare(name, 0);
    if(ioctl(control, DM_DEV_CREATE, &buffer) < 0) fail("DM_DEV_CREATE");
    unsigned minor_number = minor(buffer.io.dev);
    /* (one target spec, its parameters after it, 8-byte aligned) */
    size_t spec_bytes = (sizeof(struct dm_target_spec) + strlen(parameters) + 1 + 7) & ~(size_t)7;
    prepare(name, spec_bytes);
    buffer.io.target_count = 1;
    struct dm_target_spec *spec = (struct dm_target_spec *)(buffer.bytes + sizeof(struct dm_ioctl));
    spec->sector_start = 0;
    spec->length = strtoull(argv[2], NULL, 10);
    spec->next = spec_bytes;
    snprintf(spec->target_type, sizeof(spec->target_type), "verity");
    strcpy((char *)(spec + 1), parameters);
    if(ioctl(control, DM_TABLE_LOAD, &buffer) < 0) fail("DM_TABLE_LOAD");
    prepare(name, 0);
    if(ioctl(control, DM_DEV_SUSPEND, &buffer) < 0) fail("DM_DEV_SUSPEND (resume)");
    printf("/dev/dm-%u\n", minor_number);
    return 0;
}
