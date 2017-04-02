/*
 * Copyright (C) 2013, Red Hat Inc, Michael S. Tsirkin <mst@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include <linux/pci_regs.h>
#include "pci.h"
#include "asm/pci.h"

void pci_cap_walk(struct pci_dev *dev, pci_cap_handler_t handler)
{
	uint8_t cap_offset;
	uint8_t cap_id;
	int count = 0;

	cap_offset = pci_config_readb(dev->bdf, PCI_CAPABILITY_LIST);
	while (cap_offset) {
		cap_id = pci_config_readb(dev->bdf, cap_offset);
		assert(cap_id < PCI_CAP_ID_MAX + 1);
		handler(dev, cap_offset, cap_id);
		cap_offset = pci_config_readb(dev->bdf, cap_offset + 1);
		/* Avoid dead loop during cap walk */
		assert(++count <= 255);
	}
}

void pci_msi_set_enable(struct pci_dev *dev, bool enabled)
{
	uint16_t msi_control;
	uint16_t offset;

	offset = dev->msi_offset;
	msi_control = pci_config_readw(dev->bdf, offset + PCI_MSI_FLAGS);

	if (enabled)
		msi_control |= PCI_MSI_FLAGS_ENABLE;
	else
		msi_control &= ~PCI_MSI_FLAGS_ENABLE;

	pci_config_writew(dev->bdf, offset + PCI_MSI_FLAGS, msi_control);
}

bool pci_setup_msi(struct pci_dev *dev, uint64_t msi_addr, uint32_t msi_data)
{
	uint16_t msi_control;
	uint16_t offset;
	pcidevaddr_t addr;

	assert(dev);

	if (!dev->msi_offset) {
		printf("MSI: dev 0x%x does not support MSI.\n", dev->bdf);
		return false;
	}

	addr = dev->bdf;
	offset = dev->msi_offset;
	msi_control = pci_config_readw(addr, offset + PCI_MSI_FLAGS);
	pci_config_writel(addr, offset + PCI_MSI_ADDRESS_LO,
			  msi_addr & 0xffffffff);

	if (msi_control & PCI_MSI_FLAGS_64BIT) {
		pci_config_writel(addr, offset + PCI_MSI_ADDRESS_HI,
				  (uint32_t)(msi_addr >> 32));
		pci_config_writel(addr, offset + PCI_MSI_DATA_64, msi_data);
	} else {
		pci_config_writel(addr, offset + PCI_MSI_DATA_32, msi_data);
	}

	pci_msi_set_enable(dev, true);

	return true;
}

void pci_cmd_set_clr(struct pci_dev *dev, uint16_t set, uint16_t clr)
{
	uint16_t val = pci_config_readw(dev->bdf, PCI_COMMAND);

	/* No overlap is allowed */
	assert((set & clr) == 0);
	val |= set;
	val &= ~clr;

	pci_config_writew(dev->bdf, PCI_COMMAND, val);
}

bool pci_dev_exists(pcidevaddr_t dev)
{
	return (pci_config_readw(dev, PCI_VENDOR_ID) != 0xffff &&
		pci_config_readw(dev, PCI_DEVICE_ID) != 0xffff);
}

/* Scan bus look for a specific device. Only bus 0 scanned for now. */
pcidevaddr_t pci_find_dev(uint16_t vendor_id, uint16_t device_id)
{
	pcidevaddr_t dev;

	for (dev = 0; dev < PCI_DEVFN_MAX; ++dev) {
		if (pci_config_readw(dev, PCI_VENDOR_ID) == vendor_id &&
		    pci_config_readw(dev, PCI_DEVICE_ID) == device_id)
			return dev;
	}

	return PCIDEVADDR_INVALID;
}

uint32_t pci_bar_mask(uint32_t bar)
{
	return (bar & PCI_BASE_ADDRESS_SPACE_IO) ?
		PCI_BASE_ADDRESS_IO_MASK : PCI_BASE_ADDRESS_MEM_MASK;
}

uint32_t pci_bar_get(struct pci_dev *dev, int bar_num)
{
	return pci_config_readl(dev->bdf, PCI_BASE_ADDRESS_0 +
				bar_num * 4);
}

static phys_addr_t __pci_bar_get_addr(struct pci_dev *dev, int bar_num)
{
	uint32_t bar = pci_bar_get(dev, bar_num);
	uint32_t mask = pci_bar_mask(bar);
	uint64_t addr = bar & mask;
	phys_addr_t phys_addr;

	if (pci_bar_is64(dev, bar_num))
		addr |= (uint64_t)pci_bar_get(dev, bar_num + 1) << 32;

	phys_addr = pci_translate_addr(dev->bdf, addr);
	assert(phys_addr != INVALID_PHYS_ADDR);

	return phys_addr;
}

phys_addr_t pci_bar_get_addr(struct pci_dev *dev, int bar_num)
{
	return dev->resource[bar_num];
}

void pci_bar_set_addr(struct pci_dev *dev, int bar_num, phys_addr_t addr)
{
	int off = PCI_BASE_ADDRESS_0 + bar_num * 4;

	pci_config_writel(dev->bdf, off, (uint32_t)addr);
	dev->resource[bar_num] = addr;

	if (pci_bar_is64(dev, bar_num)) {
		assert(bar_num + 1 < PCI_BAR_NUM);
		pci_config_writel(dev->bdf, off + 4, (uint32_t)(addr >> 32));
		dev->resource[bar_num + 1] = dev->resource[bar_num];
	}
}

/*
 * To determine the amount of address space needed by a PCI device,
 * one must save the original value of the BAR, write a value of
 * all 1's to the register, and then read it back. The amount of
 * memory can be then determined by masking the information bits,
 * performing a bitwise NOT, and incrementing the value by 1.
 *
 * The following pci_bar_size_helper() and pci_bar_size() functions
 * implement the algorithm.
 */
static uint32_t pci_bar_size_helper(struct pci_dev *dev, int bar_num)
{
	int off = PCI_BASE_ADDRESS_0 + bar_num * 4;
	uint16_t bdf = dev->bdf;
	uint32_t bar, val;

	bar = pci_config_readl(bdf, off);
	pci_config_writel(bdf, off, ~0u);
	val = pci_config_readl(bdf, off);
	pci_config_writel(bdf, off, bar);

	return val;
}

phys_addr_t pci_bar_size(struct pci_dev *dev, int bar_num)
{
	uint32_t bar, size;

	size = pci_bar_size_helper(dev, bar_num);
	if (!size)
		return 0;

	bar = pci_bar_get(dev, bar_num);
	size &= pci_bar_mask(bar);

	if (pci_bar_is64(dev, bar_num)) {
		phys_addr_t size64 = pci_bar_size_helper(dev, bar_num + 1);
		size64 = (size64 << 32) | size;

		return ~size64 + 1;
	} else {
		return ~size + 1;
	}
}

bool pci_bar_is_memory(struct pci_dev *dev, int bar_num)
{
	uint32_t bar = pci_bar_get(dev, bar_num);

	return !(bar & PCI_BASE_ADDRESS_SPACE_IO);
}

bool pci_bar_is_valid(struct pci_dev *dev, int bar_num)
{
	return dev->resource[bar_num] != INVALID_PHYS_ADDR;
}

bool pci_bar_is64(struct pci_dev *dev, int bar_num)
{
	uint32_t bar = pci_bar_get(dev, bar_num);

	if (bar & PCI_BASE_ADDRESS_SPACE_IO)
		return false;

	return (bar & PCI_BASE_ADDRESS_MEM_TYPE_MASK) ==
		      PCI_BASE_ADDRESS_MEM_TYPE_64;
}

void pci_bar_print(struct pci_dev *dev, int bar_num)
{
	phys_addr_t size, start, end;
	uint32_t bar;

	if (!pci_bar_is_valid(dev, bar_num))
		return;

	bar = pci_bar_get(dev, bar_num);
	size = pci_bar_size(dev, bar_num);
	start = pci_bar_get_addr(dev, bar_num);
	end = start + size - 1;

	if (pci_bar_is64(dev, bar_num)) {
		printf("BAR#%d,%d [%" PRIx64 "-%" PRIx64 " ",
		       bar_num, bar_num + 1, start, end);
	} else {
		printf("BAR#%d [%02x-%02x ",
		       bar_num, (uint32_t)start, (uint32_t)end);
	}

	if (bar & PCI_BASE_ADDRESS_SPACE_IO) {
		printf("PIO");
	} else {
		printf("MEM");
		switch (bar & PCI_BASE_ADDRESS_MEM_TYPE_MASK) {
		case PCI_BASE_ADDRESS_MEM_TYPE_32:
			printf("32");
			break;
		case PCI_BASE_ADDRESS_MEM_TYPE_1M:
			printf("1M");
			break;
		case PCI_BASE_ADDRESS_MEM_TYPE_64:
			printf("64");
			break;
		default:
			assert(0);
		}
	}

	if (bar & PCI_BASE_ADDRESS_MEM_PREFETCH)
		printf("/p");

	printf("]");
}

void pci_dev_print_id(struct pci_dev *dev)
{
	pcidevaddr_t bdf = dev->bdf;

	printf("00.%02x.%1x %04x:%04x", bdf / 8, bdf % 8,
		pci_config_readw(bdf, PCI_VENDOR_ID),
		pci_config_readw(bdf, PCI_DEVICE_ID));
}

static void pci_cap_print(struct pci_dev *dev, int cap_offset, int cap_id)
{
	switch (cap_id) {
	case PCI_CAP_ID_MSI: {
		uint16_t control = pci_config_readw(dev->bdf, cap_offset + PCI_MSI_FLAGS);
		printf("\tMSI,%s-bit capability ", control & PCI_MSI_FLAGS_64BIT ? "64" : "32");
		break;
	}
	default:
		printf("\tcapability 0x%02x ", cap_id);
		break;
	}
	printf("at offset 0x%02x\n", cap_offset);
}

void pci_dev_print(struct pci_dev *dev)
{
	pcidevaddr_t bdf = dev->bdf;
	uint8_t header = pci_config_readb(bdf, PCI_HEADER_TYPE);
	uint8_t progif = pci_config_readb(bdf, PCI_CLASS_PROG);
	uint8_t subclass = pci_config_readb(bdf, PCI_CLASS_DEVICE);
	uint8_t class = pci_config_readb(bdf, PCI_CLASS_DEVICE + 1);
	int i;

	pci_dev_print_id(dev);
	printf(" type %02x progif %02x class %02x subclass %02x\n",
	       header, progif, class, subclass);

	pci_cap_walk(dev, pci_cap_print);

	if ((header & PCI_HEADER_TYPE_MASK) != PCI_HEADER_TYPE_NORMAL)
		return;

	for (i = 0; i < PCI_BAR_NUM; i++) {
		if (pci_bar_is_valid(dev, i)) {
			printf("\t");
			pci_bar_print(dev, i);
			printf("\n");
		}
		if (pci_bar_is64(dev, i))
			i++;
	}
}

void pci_print(void)
{
	pcidevaddr_t devfn;
	struct pci_dev pci_dev;

	for (devfn = 0; devfn < PCI_DEVFN_MAX; ++devfn) {
		if (pci_dev_exists(devfn)) {
			pci_dev_init(&pci_dev, devfn);
			pci_dev_print(&pci_dev);
		}
	}
}

void pci_dev_init(struct pci_dev *dev, pcidevaddr_t bdf)
{
	int i;

	memset(dev, 0, sizeof(*dev));
	dev->bdf = bdf;

	for (i = 0; i < PCI_BAR_NUM; i++) {
		if (pci_bar_size(dev, i)) {
			dev->resource[i] = __pci_bar_get_addr(dev, i);
			if (pci_bar_is64(dev, i)) {
				assert(i + 1 < PCI_BAR_NUM);
				dev->resource[i + 1] = dev->resource[i];
				i++;
			}
		} else {
			dev->resource[i] = INVALID_PHYS_ADDR;
		}
	}
}

uint8_t pci_intx_line(struct pci_dev *dev)
{
	return pci_config_readb(dev->bdf, PCI_INTERRUPT_LINE);
}

static void pci_cap_setup(struct pci_dev *dev, int cap_offset, int cap_id)
{
	switch (cap_id) {
	case PCI_CAP_ID_MSI:
		dev->msi_offset = cap_offset;
		break;
	}
}

void pci_enable_defaults(struct pci_dev *dev)
{
	/* Enable device DMA operations */
	pci_cmd_set_clr(dev, PCI_COMMAND_MASTER, 0);
	pci_cap_walk(dev, pci_cap_setup);
}
