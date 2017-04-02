#ifndef _CHR_TESTDEV_H_
#define _CHR_TESTDEV_H_
/*
 * chr-testdev is a driver for the chr-testdev qemu backend.
 * The chr-testdev backend exposes a simple control interface to
 * qemu for kvm-unit-tests accessible through virtio-console.
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
extern void chr_testdev_init(void);
extern void chr_testdev_exit(int code);
#endif
