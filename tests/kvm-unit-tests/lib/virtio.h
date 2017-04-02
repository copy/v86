#ifndef _VIRTIO_H_
#define _VIRTIO_H_
/*
 * A minimal implementation of virtio.
 * Structures adapted from the Linux Kernel.
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

#define VIRTIO_ID_CONSOLE 3

struct virtio_device_id {
	u32 device;
	u32 vendor;
};

struct virtio_device {
	struct virtio_device_id id;
	const struct virtio_config_ops *config;
};

struct virtqueue {
	void (*callback)(struct virtqueue *vq);
	const char *name;
	struct virtio_device *vdev;
	unsigned int index;
	unsigned int num_free;
	void *priv;
};

typedef void vq_callback_t(struct virtqueue *);
struct virtio_config_ops {
	void (*get)(struct virtio_device *vdev, unsigned offset,
		    void *buf, unsigned len);
	void (*set)(struct virtio_device *vdev, unsigned offset,
		    const void *buf, unsigned len);
	int (*find_vqs)(struct virtio_device *vdev, unsigned nvqs,
			struct virtqueue *vqs[],
			vq_callback_t *callbacks[],
			const char *names[]);
};

static inline u8
virtio_config_readb(struct virtio_device *vdev, unsigned offset)
{
	u8 val;
	vdev->config->get(vdev, offset, &val, 1);
	return val;
}

static inline u16
virtio_config_readw(struct virtio_device *vdev, unsigned offset)
{
	u16 val;
	vdev->config->get(vdev, offset, &val, 2);
	return val;
}

static inline u32
virtio_config_readl(struct virtio_device *vdev, unsigned offset)
{
	u32 val;
	vdev->config->get(vdev, offset, &val, 4);
	return val;
}

static inline void
virtio_config_writeb(struct virtio_device *vdev, unsigned offset, u8 val)
{
	vdev->config->set(vdev, offset, &val, 1);
}

static inline void
virtio_config_writew(struct virtio_device *vdev, unsigned offset, u16 val)
{
	vdev->config->set(vdev, offset, &val, 2);
}

static inline void
virtio_config_writel(struct virtio_device *vdev, unsigned offset, u32 val)
{
	vdev->config->set(vdev, offset, &val, 4);
}

#define VRING_DESC_F_NEXT	1
#define VRING_DESC_F_WRITE	2

struct vring_desc {
	u64 addr;
	u32 len;
	u16 flags;
	u16 next;
};

struct vring_avail {
	u16 flags;
	u16 idx;
	u16 ring[];
};

struct vring_used_elem {
	u32 id;
	u32 len;
};

struct vring_used {
	u16 flags;
	u16 idx;
	struct vring_used_elem ring[];
};

struct vring {
	unsigned int num;
	struct vring_desc *desc;
	struct vring_avail *avail;
	struct vring_used *used;
};

struct vring_virtqueue {
	struct virtqueue vq;
	struct vring vring;
	unsigned int free_head;
	unsigned int num_added;
	u16 last_used_idx;
	bool (*notify)(struct virtqueue *vq);
	void *data[];
};

#define to_vvq(_vq) container_of(_vq, struct vring_virtqueue, vq)

extern void vring_init(struct vring *vr, unsigned int num, void *p,
		       unsigned long align);
extern void vring_init_virtqueue(struct vring_virtqueue *vq, unsigned index,
				 unsigned num, unsigned vring_align,
				 struct virtio_device *vdev, void *pages,
				 bool (*notify)(struct virtqueue *),
				 void (*callback)(struct virtqueue *),
				 const char *name);
extern int virtqueue_add_outbuf(struct virtqueue *vq, char *buf,
				unsigned int len);
extern bool virtqueue_kick(struct virtqueue *vq);
extern void detach_buf(struct vring_virtqueue *vq, unsigned head);
extern void *virtqueue_get_buf(struct virtqueue *_vq, unsigned int *len);

extern struct virtio_device *virtio_bind(u32 devid);

#endif /* _VIRTIO_H_ */
