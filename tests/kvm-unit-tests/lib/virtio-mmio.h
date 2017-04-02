#ifndef _VIRTIO_MMIO_H_
#define _VIRTIO_MMIO_H_
/*
 * A minimal implementation of virtio-mmio. Adapted from the Linux Kernel.
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "asm/page.h"
#include "virtio.h"

#define VIRTIO_MMIO_MAGIC_VALUE		0x000
#define VIRTIO_MMIO_VERSION		0x004
#define VIRTIO_MMIO_DEVICE_ID		0x008
#define VIRTIO_MMIO_VENDOR_ID		0x00c
#define VIRTIO_MMIO_HOST_FEATURES	0x010
#define VIRTIO_MMIO_HOST_FEATURES_SEL	0x014
#define VIRTIO_MMIO_GUEST_FEATURES	0x020
#define VIRTIO_MMIO_GUEST_FEATURES_SEL	0x024
#define VIRTIO_MMIO_GUEST_PAGE_SIZE	0x028
#define VIRTIO_MMIO_QUEUE_SEL		0x030
#define VIRTIO_MMIO_QUEUE_NUM_MAX	0x034
#define VIRTIO_MMIO_QUEUE_NUM		0x038
#define VIRTIO_MMIO_QUEUE_ALIGN		0x03c
#define VIRTIO_MMIO_QUEUE_PFN		0x040
#define VIRTIO_MMIO_QUEUE_NOTIFY	0x050
#define VIRTIO_MMIO_INTERRUPT_STATUS	0x060
#define VIRTIO_MMIO_INTERRUPT_ACK	0x064
#define VIRTIO_MMIO_STATUS		0x070
#define VIRTIO_MMIO_CONFIG		0x100

#define VIRTIO_MMIO_INT_VRING		(1 << 0)
#define VIRTIO_MMIO_INT_CONFIG		(1 << 1)

#define VIRTIO_MMIO_VRING_ALIGN		PAGE_SIZE

/*
 * The minimum queue size is 2*VIRTIO_MMIO_VRING_ALIGN, which
 * means the largest queue num for the minimum queue size is 128, i.e.
 * 2*VIRTIO_MMIO_VRING_ALIGN = vring_size(128, VIRTIO_MMIO_VRING_ALIGN),
 * where vring_size is
 *
 * unsigned vring_size(unsigned num, unsigned long align)
 * {
 *     return ((sizeof(struct vring_desc) * num + sizeof(u16) * (3 + num)
 *              + align - 1) & ~(align - 1))
 *             + sizeof(u16) * 3 + sizeof(struct vring_used_elem) * num;
 * }
 */
#define VIRTIO_MMIO_QUEUE_SIZE_MIN	(2*VIRTIO_MMIO_VRING_ALIGN)
#define VIRTIO_MMIO_QUEUE_NUM_MIN	128

#define to_virtio_mmio_device(vdev_ptr) \
	container_of(vdev_ptr, struct virtio_mmio_device, vdev)

struct virtio_mmio_device {
	struct virtio_device vdev;
	void *base;
};

extern struct virtio_device *virtio_mmio_bind(u32 devid);

#endif /* _VIRTIO_MMIO_H_ */
