/*
 * Edu PCI device.
 *
 * Copyright (C) 2016 Red Hat, Inc.
 *
 * Authors:
 *   Peter Xu <peterx@redhat.com>,
 *
 * This work is licensed under the terms of the GNU LGPL, version 2 or
 * later.
 */

#include "pci-edu.h"
#include "asm/barrier.h"

/* Return true if alive */
static inline bool edu_check_alive(struct pci_edu_dev *dev)
{
	static uint32_t live_count = 1;
	uint32_t value;

	edu_reg_writel(dev, EDU_REG_ALIVE, live_count++);
	value = edu_reg_readl(dev, EDU_REG_ALIVE);
	return (live_count - 1 == ~value);
}

bool edu_init(struct pci_edu_dev *dev)
{
	pcidevaddr_t dev_addr;

	dev_addr = pci_find_dev(PCI_VENDOR_ID_QEMU, PCI_DEVICE_ID_EDU);
	if (dev_addr == PCIDEVADDR_INVALID)
		return false;

	pci_dev_init(&dev->pci_dev, dev_addr);
	pci_enable_defaults(&dev->pci_dev);
	dev->reg_base = ioremap(dev->pci_dev.resource[EDU_BAR], PAGE_SIZE);
	assert(edu_check_alive(dev));
	return true;
}

void edu_dma(struct pci_edu_dev *dev, iova_t iova,
	     size_t size, unsigned int dev_offset, bool from_device)
{
	uint64_t from, to;
	uint32_t cmd = EDU_CMD_DMA_START;

	assert(size <= EDU_DMA_SIZE_MAX);
	assert(dev_offset < EDU_DMA_SIZE_MAX);

	printf("edu device DMA start %s addr 0x%" PRIx64 " size 0x%lu off 0x%x\n",
	       from_device ? "FROM" : "TO",
	       iova, (ulong)size, dev_offset);

	if (from_device) {
		from = dev_offset + EDU_DMA_START;
		to = iova;
		cmd |= EDU_CMD_DMA_FROM;
	} else {
		from = iova;
		to = EDU_DMA_START + dev_offset;
		cmd |= EDU_CMD_DMA_TO;
	}

	edu_reg_writeq(dev, EDU_REG_DMA_SRC, from);
	edu_reg_writeq(dev, EDU_REG_DMA_DST, to);
	edu_reg_writeq(dev, EDU_REG_DMA_COUNT, size);
	edu_reg_writel(dev, EDU_REG_DMA_CMD, cmd);

	/* Wait until DMA finished */
	while (edu_reg_readl(dev, EDU_REG_DMA_CMD) & EDU_CMD_DMA_START)
		cpu_relax();
}
