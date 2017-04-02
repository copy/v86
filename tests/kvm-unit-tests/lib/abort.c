/*
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

/*
 * When exit(code) is invoked, qemu will exit with ((code << 1) | 1),
 * leaving us 128 exit status codes. To avoid confusion with signal
 * status, we further limit exit codes to those resulting in qemu
 * exiting with a status < 128. We give abort() the highest (127),
 * leaving the lower status codes for unit tests.
 */
#define ABORT_EXIT_STATUS 63	/* 127 exit status from qemu */

void abort(void)
{
	exit(ABORT_EXIT_STATUS);
}
