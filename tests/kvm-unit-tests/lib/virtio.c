/*
 * virtqueue support adapted from the Linux kernel.
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "asm/io.h"
#include "virtio.h"
#include "virtio-mmio.h"

void vring_init(struct vring *vr, unsigned int num, void *p,
		       unsigned long align)
{
	vr->num = num;
	vr->desc = p;
	vr->avail = p + num*sizeof(struct vring_desc);
	vr->used = (void *)(((unsigned long)&vr->avail->ring[num] + sizeof(u16)
		+ align-1) & ~(align - 1));
}

void vring_init_virtqueue(struct vring_virtqueue *vq, unsigned index,
			  unsigned num, unsigned vring_align,
			  struct virtio_device *vdev, void *pages,
			  bool (*notify)(struct virtqueue *),
			  void (*callback)(struct virtqueue *),
			  const char *name)
{
	unsigned i;

	vring_init(&vq->vring, num, pages, vring_align);
	vq->vq.callback = callback;
	vq->vq.vdev = vdev;
	vq->vq.name = name;
	vq->vq.num_free = num;
	vq->vq.index = index;
	vq->notify = notify;
	vq->last_used_idx = 0;
	vq->num_added = 0;
	vq->free_head = 0;

	for (i = 0; i < num-1; i++) {
		vq->vring.desc[i].next = i+1;
		vq->data[i] = NULL;
	}
	vq->data[i] = NULL;
}

int virtqueue_add_outbuf(struct virtqueue *_vq, char *buf, unsigned int len)
{
	struct vring_virtqueue *vq = to_vvq(_vq);
	unsigned avail;
	int head;

	assert(buf != NULL);
	assert(len != 0);

	if (!vq->vq.num_free)
		return -1;

	--vq->vq.num_free;

	head = vq->free_head;

	vq->vring.desc[head].flags = 0;
	vq->vring.desc[head].addr = virt_to_phys(buf);
	vq->vring.desc[head].len = len;

	vq->free_head = vq->vring.desc[head].next;

	vq->data[head] = buf;

	avail = (vq->vring.avail->idx & (vq->vring.num-1));
	vq->vring.avail->ring[avail] = head;
	wmb();
	vq->vring.avail->idx++;
	vq->num_added++;

	return 0;
}

bool virtqueue_kick(struct virtqueue *_vq)
{
	struct vring_virtqueue *vq = to_vvq(_vq);
	mb();
	return vq->notify(_vq);
}

void detach_buf(struct vring_virtqueue *vq, unsigned head)
{
	unsigned i = head;

	vq->data[head] = NULL;

	while (vq->vring.desc[i].flags & VRING_DESC_F_NEXT) {
		i = vq->vring.desc[i].next;
		vq->vq.num_free++;
	}

	vq->vring.desc[i].next = vq->free_head;
	vq->free_head = head;
	vq->vq.num_free++;
}

void *virtqueue_get_buf(struct virtqueue *_vq, unsigned int *len)
{
	struct vring_virtqueue *vq = to_vvq(_vq);
	u16 last_used;
	unsigned i;
	void *ret;

	rmb();

	last_used = (vq->last_used_idx & (vq->vring.num-1));
	i = vq->vring.used->ring[last_used].id;
	*len = vq->vring.used->ring[last_used].len;

	ret = vq->data[i];
	detach_buf(vq, i);

	vq->last_used_idx++;

	return ret;
}

struct virtio_device *virtio_bind(u32 devid)
{
	return virtio_mmio_bind(devid);
}
