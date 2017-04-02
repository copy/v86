/*
 * virtqueue support adapted from the Linux kernel.
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "devicetree.h"
#include "alloc.h"
#include "asm/page.h"
#include "asm/io.h"
#include "virtio.h"
#include "virtio-mmio.h"

static void vm_get(struct virtio_device *vdev, unsigned offset,
		   void *buf, unsigned len)
{
	struct virtio_mmio_device *vm_dev = to_virtio_mmio_device(vdev);
	u8 *p = buf;
	unsigned i;

	for (i = 0; i < len; ++i)
		p[i] = readb(vm_dev->base + VIRTIO_MMIO_CONFIG + offset + i);
}

static void vm_set(struct virtio_device *vdev, unsigned offset,
		   const void *buf, unsigned len)
{
	struct virtio_mmio_device *vm_dev = to_virtio_mmio_device(vdev);
	const u8 *p = buf;
	unsigned i;

	for (i = 0; i < len; ++i)
		writeb(p[i], vm_dev->base + VIRTIO_MMIO_CONFIG + offset + i);
}

static bool vm_notify(struct virtqueue *vq)
{
	struct virtio_mmio_device *vm_dev = to_virtio_mmio_device(vq->vdev);
	writel(vq->index, vm_dev->base + VIRTIO_MMIO_QUEUE_NOTIFY);
	return true;
}

static struct virtqueue *vm_setup_vq(struct virtio_device *vdev,
				     unsigned index,
				     void (*callback)(struct virtqueue *vq),
				     const char *name)
{
	struct virtio_mmio_device *vm_dev = to_virtio_mmio_device(vdev);
	struct vring_virtqueue *vq;
	void *queue;
	unsigned num = VIRTIO_MMIO_QUEUE_NUM_MIN;

	vq = calloc(1, sizeof(*vq));
	queue = memalign(PAGE_SIZE, VIRTIO_MMIO_QUEUE_SIZE_MIN);
	assert(vq && queue);

	writel(index, vm_dev->base + VIRTIO_MMIO_QUEUE_SEL);

	assert(readl(vm_dev->base + VIRTIO_MMIO_QUEUE_NUM_MAX) >= num);

	if (readl(vm_dev->base + VIRTIO_MMIO_QUEUE_PFN) != 0) {
		printf("%s: virtqueue %d already setup! base=%p\n",
				__func__, index, vm_dev->base);
		return NULL;
	}

	writel(num, vm_dev->base + VIRTIO_MMIO_QUEUE_NUM);
	writel(VIRTIO_MMIO_VRING_ALIGN,
			vm_dev->base + VIRTIO_MMIO_QUEUE_ALIGN);
	writel(virt_to_pfn(queue), vm_dev->base + VIRTIO_MMIO_QUEUE_PFN);

	vring_init_virtqueue(vq, index, num, VIRTIO_MMIO_VRING_ALIGN,
			     vdev, queue, vm_notify, callback, name);

	return &vq->vq;
}

static int vm_find_vqs(struct virtio_device *vdev, unsigned nvqs,
		       struct virtqueue *vqs[], vq_callback_t *callbacks[],
		       const char *names[])
{
	unsigned i;

	for (i = 0; i < nvqs; ++i) {
		vqs[i] = vm_setup_vq(vdev, i,
				     callbacks ? callbacks[i] : NULL,
				     names ? names[i] : "");
		if (vqs[i] == NULL)
			return -1;
	}

	return 0;
}

static const struct virtio_config_ops vm_config_ops = {
	.get = vm_get,
	.set = vm_set,
	.find_vqs = vm_find_vqs,
};

static void vm_device_init(struct virtio_mmio_device *vm_dev)
{
	vm_dev->vdev.id.device = readl(vm_dev->base + VIRTIO_MMIO_DEVICE_ID);
	vm_dev->vdev.id.vendor = readl(vm_dev->base + VIRTIO_MMIO_VENDOR_ID);
	vm_dev->vdev.config = &vm_config_ops;

	writel(PAGE_SIZE, vm_dev->base + VIRTIO_MMIO_GUEST_PAGE_SIZE);
}

/******************************************************
 * virtio-mmio device tree support
 ******************************************************/

struct vm_dt_info {
	u32 devid;
	void *base;
};

static int vm_dt_match(const struct dt_device *dev, int fdtnode)
{
	struct vm_dt_info *info = (struct vm_dt_info *)dev->info;
	struct dt_pbus_reg base;
	u32 magic;
	int ret;

	dt_device_bind_node((struct dt_device *)dev, fdtnode);

	ret = dt_pbus_get_base(dev, &base);
	assert(ret == 0);
	info->base = ioremap(base.addr, base.size);

	magic = readl(info->base + VIRTIO_MMIO_MAGIC_VALUE);
	if (magic != ('v' | 'i' << 8 | 'r' << 16 | 't' << 24))
		return false;

	return readl(info->base + VIRTIO_MMIO_DEVICE_ID) == info->devid;
}

static struct virtio_device *virtio_mmio_dt_bind(u32 devid)
{
	struct virtio_mmio_device *vm_dev;
	struct dt_device dt_dev;
	struct dt_bus dt_bus;
	struct vm_dt_info info;
	int node;

	if (!dt_available())
		return NULL;

	dt_bus_init_defaults(&dt_bus);
	dt_bus.match = vm_dt_match;

	info.devid = devid;

	dt_device_init(&dt_dev, &dt_bus, &info);

	node = dt_device_find_compatible(&dt_dev, "virtio,mmio");
	assert(node >= 0 || node == -FDT_ERR_NOTFOUND);

	if (node == -FDT_ERR_NOTFOUND)
		return NULL;

	vm_dev = calloc(1, sizeof(*vm_dev));
	assert(vm_dev != NULL);

	vm_dev->base = info.base;
	vm_device_init(vm_dev);

	return &vm_dev->vdev;
}

struct virtio_device *virtio_mmio_bind(u32 devid)
{
	return virtio_mmio_dt_bind(devid);
}
