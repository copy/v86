/*
 * QEMU "pci-testdev" PCI test device
 *
 * Copyright (C) 2016, Red Hat Inc, Alexander Gordeev <agordeev@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "pci.h"
#include "asm/io.h"

struct pci_testdev_ops {
	u8 (*io_readb)(const volatile void *addr);
	u16 (*io_readw)(const volatile void *addr);
	u32 (*io_readl)(const volatile void *addr);
	void (*io_writeb)(u8 value, volatile void *addr);
	void (*io_writew)(u16 value, volatile void *addr);
	void (*io_writel)(u32 value, volatile void *addr);
};

static u8 pio_readb(const volatile void *addr)
{
	return inb((unsigned long)addr);
}

static u16 pio_readw(const volatile void *addr)
{
	return inw((unsigned long)addr);
}

static u32 pio_readl(const volatile void *addr)
{
	return inl((unsigned long)addr);
}

static void pio_writeb(u8 value, volatile void *addr)
{
	outb(value, (unsigned long)addr);
}

static void pio_writew(u16 value, volatile void *addr)
{
	outw(value, (unsigned long)addr);
}

static void pio_writel(u32 value, volatile void *addr)
{
	outl(value, (unsigned long)addr);
}

static struct pci_testdev_ops pci_testdev_io_ops = {
	.io_readb	= pio_readb,
	.io_readw	= pio_readw,
	.io_readl	= pio_readl,
	.io_writeb	= pio_writeb,
	.io_writew	= pio_writew,
	.io_writel	= pio_writel
};

static u8 mmio_readb(const volatile void *addr)
{
	return *(const volatile u8 __force *)addr;
}

static u16 mmio_readw(const volatile void *addr)
{
	return *(const volatile u16 __force *)addr;
}

static u32 mmio_readl(const volatile void *addr)
{
	return *(const volatile u32 __force *)addr;
}

static void mmio_writeb(u8 value, volatile void *addr)
{
	*(volatile u8 __force *)addr = value;
}

static void mmio_writew(u16 value, volatile void *addr)
{
	*(volatile u16 __force *)addr = value;
}

static void mmio_writel(u32 value, volatile void *addr)
{
	*(volatile u32 __force *)addr = value;
}

static struct pci_testdev_ops pci_testdev_mem_ops = {
	.io_readb	= mmio_readb,
	.io_readw	= mmio_readw,
	.io_readl	= mmio_readl,
	.io_writeb	= mmio_writeb,
	.io_writew	= mmio_writew,
	.io_writel	= mmio_writel
};

static bool pci_testdev_one(struct pci_test_dev_hdr *test,
			    int test_nr,
			    struct pci_testdev_ops *ops)
{
	u8 width;
	u32 count, sig, off;
	const int nr_writes = 16;
	int i;

	ops->io_writeb(test_nr, &test->test);
	count = ops->io_readl(&test->count);
	if (count != 0)
		return false;

	width = ops->io_readb(&test->width);
	if (width != 1 && width != 2 && width != 4)
		return false;

	sig = ops->io_readl(&test->data);
	off = ops->io_readl(&test->offset);

	for (i = 0; i < nr_writes; i++) {
		switch (width) {
		case 1: ops->io_writeb(sig, (void *)test + off); break;
		case 2: ops->io_writew(sig, (void *)test + off); break;
		case 4: ops->io_writel(sig, (void *)test + off); break;
		}
	}

	count = ops->io_readl(&test->count);
	if (!count)
		return true;

	return (int)count == nr_writes;
}

void pci_testdev_print(struct pci_test_dev_hdr *test,
		       struct pci_testdev_ops *ops)
{
	bool io = (ops == &pci_testdev_io_ops);
	int i;

	printf("pci-testdev %3s: ", io ? "io" : "mem");
	for (i = 0;; ++i) {
		char c = ops->io_readb(&test->name[i]);
		if (!c)
			break;
		printf("%c", c);
	}
	printf("\n");
}

static int pci_testdev_all(struct pci_test_dev_hdr *test,
			   struct pci_testdev_ops *ops)
{
	int i;

	for (i = 0;; i++) {
		if (!pci_testdev_one(test, i, ops))
			break;
		pci_testdev_print(test, ops);
	}

	return i;
}

int pci_testdev(void)
{
	struct pci_dev pci_dev;
	pcidevaddr_t dev;
	phys_addr_t addr;
	void __iomem *mem, *io;
	int nr_tests = 0;
	bool ret;

	dev = pci_find_dev(PCI_VENDOR_ID_REDHAT, PCI_DEVICE_ID_REDHAT_TEST);
	if (dev == PCIDEVADDR_INVALID) {
		printf("'pci-testdev' device is not found, "
		       "check QEMU '-device pci-testdev' parameter\n");
		return -1;
	}
	pci_dev_init(&pci_dev, dev);

	ret = pci_bar_is_valid(&pci_dev, 0) && pci_bar_is_valid(&pci_dev, 1);
	assert(ret);

	addr = pci_bar_get_addr(&pci_dev, 0);
	mem = ioremap(addr, PAGE_SIZE);

	addr = pci_bar_get_addr(&pci_dev, 1);
	io = (void *)(unsigned long)addr;

	nr_tests += pci_testdev_all(mem, &pci_testdev_mem_ops);
	nr_tests += pci_testdev_all(io, &pci_testdev_io_ops);

	return nr_tests;
}
