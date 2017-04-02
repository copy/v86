/*
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "virtio.h"
#include "asm/spinlock.h"

#define TESTDEV_NAME "chr-testdev"

static struct virtio_device *vcon;
static struct virtqueue *in_vq, *out_vq;
static struct spinlock lock;

static void __testdev_send(char *buf, unsigned int len)
{
	int ret;

	ret = virtqueue_add_outbuf(out_vq, buf, len);
	virtqueue_kick(out_vq);

	if (ret < 0)
		return;

	while (!virtqueue_get_buf(out_vq, &len))
		;
}

void chr_testdev_exit(int code)
{
	unsigned int len;
	char buf[8];

	snprintf(buf, sizeof(buf), "%dq", code);
	len = strlen(buf);

	spin_lock(&lock);

	if (!vcon)
		goto out;

	__testdev_send(buf, len);

out:
	spin_unlock(&lock);
}

void chr_testdev_init(void)
{
	const char *io_names[] = { "input", "output" };
	struct virtqueue *vqs[2];
	int ret;

	vcon = virtio_bind(VIRTIO_ID_CONSOLE);
	if (vcon == NULL) {
		printf("%s: %s: can't find a virtio-console\n",
				__func__, TESTDEV_NAME);
		return;
	}

	ret = vcon->config->find_vqs(vcon, 2, vqs, NULL, io_names);
	if (ret < 0) {
		printf("%s: %s: can't init virtqueues\n",
				__func__, TESTDEV_NAME);
		vcon = NULL;
		return;
	}

	in_vq = vqs[0];
	out_vq = vqs[1];
}
