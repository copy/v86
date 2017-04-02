/*
 * Generic PCI host controller as described in PCI Bus Binding to Open Firmware
 *
 * Copyright (C) 2016, Red Hat Inc, Alexander Gordeev <agordeev@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "devicetree.h"
#include "alloc.h"
#include "pci.h"
#include "asm/pci.h"
#include "asm/io.h"
#include "pci-host-generic.h"
#include <linux/pci_regs.h>

static struct pci_host_bridge *pci_host_bridge;

static int of_flags_to_pci_type(u32 of_flags)
{
	static int type_map[] = {
		[1] = PCI_BASE_ADDRESS_SPACE_IO,
		[2] = PCI_BASE_ADDRESS_MEM_TYPE_32,
		[3] = PCI_BASE_ADDRESS_MEM_TYPE_64
	};
	int idx = (of_flags >> 24) & 0x03;
	int res;

	assert(idx > 0);
	res = type_map[idx];

	if (of_flags & 0x40000000)
		res |= PCI_BASE_ADDRESS_MEM_PREFETCH;

	return res;
}

static int pci_bar_type(u32 bar)
{
	if (bar & PCI_BASE_ADDRESS_SPACE)
		return PCI_BASE_ADDRESS_SPACE_IO;
	else
		return bar & (PCI_BASE_ADDRESS_MEM_TYPE_MASK |
			      PCI_BASE_ADDRESS_MEM_PREFETCH);
}

/*
 * Probe DT for a generic PCI host controller
 * See kernel Documentation/devicetree/bindings/pci/host-generic-pci.txt
 * and function gen_pci_probe() in drivers/pci/host/pci-host-generic.c
 */
static struct pci_host_bridge *pci_dt_probe(void)
{
	struct pci_host_bridge *host;
	const void *fdt = dt_fdt();
	const struct fdt_property *prop;
	struct dt_pbus_reg base;
	struct dt_device dt_dev;
	struct dt_bus dt_bus;
	struct pci_addr_space *as;
	fdt32_t *data;
	u32 bus, bus_max;
	u32 nac, nsc, nac_root, nsc_root;
	int nr_range_cells, nr_addr_spaces;
	int ret, node, len, i;

	if (!dt_available()) {
		printf("No device tree found\n");
		return NULL;
	}

	dt_bus_init_defaults(&dt_bus);
	dt_device_init(&dt_dev, &dt_bus, NULL);

	node = fdt_path_offset(fdt, "/");
	assert(node >= 0);

	ret = dt_get_nr_cells(node, &nac_root, &nsc_root);
	assert(ret == 0);
	assert(nac_root == 1 || nac_root == 2);

	node = fdt_node_offset_by_compatible(fdt, node,
					     "pci-host-ecam-generic");
	if (node == -FDT_ERR_NOTFOUND) {
		printf("No PCIe ECAM compatible controller found\n");
		return NULL;
	}
	assert(node >= 0);

	prop = fdt_get_property(fdt, node, "device_type", &len);
	assert(prop && len == 4 && !strcmp((char *)prop->data, "pci"));

	dt_device_bind_node(&dt_dev, node);
	ret = dt_pbus_get_base(&dt_dev, &base);
	assert(ret == 0);

	prop = fdt_get_property(fdt, node, "bus-range", &len);
	if (prop == NULL) {
		assert(len == -FDT_ERR_NOTFOUND);
		bus		= 0x00;
		bus_max		= 0xff;
	} else {
		data		= (fdt32_t *)prop->data;
		bus		= fdt32_to_cpu(data[0]);
		bus_max		= fdt32_to_cpu(data[1]);
		assert(bus <= bus_max);
	}
	assert(bus_max < base.size / (1 << PCI_ECAM_BUS_SHIFT));

	ret = dt_get_nr_cells(node, &nac, &nsc);
	assert(ret == 0);
	assert(nac == 3 && nsc == 2);

	prop = fdt_get_property(fdt, node, "ranges", &len);
	assert(prop != NULL);

	nr_range_cells = nac + nsc + nac_root;
	nr_addr_spaces = (len / 4) / nr_range_cells;
	assert(nr_addr_spaces);

	host = malloc(sizeof(*host) +
		      sizeof(host->addr_space[0]) * nr_addr_spaces);
	assert(host != NULL);

	host->start		= base.addr;
	host->size		= base.size;
	host->bus		= bus;
	host->bus_max		= bus_max;
	host->nr_addr_spaces	= nr_addr_spaces;

	data = (fdt32_t *)prop->data;
	as = &host->addr_space[0];

	for (i = 0; i < nr_addr_spaces; i++) {
		/*
		 * The PCI binding encodes the PCI address with three
		 * cells as follows:
		 *
		 * phys.hi  cell: npt000ss bbbbbbbb dddddfff rrrrrrrr
		 * phys.mid cell: hhhhhhhh hhhhhhhh hhhhhhhh hhhhhhhh
		 * phys.lo  cell: llllllll llllllll llllllll llllllll
		 *
		 * PCI device bus address and flags are encoded into phys.high
		 * PCI 64 bit address is encoded into phys.mid and phys.low
		 */
		as->type = of_flags_to_pci_type(fdt32_to_cpu(data[0]));
		as->pci_start = ((u64)fdt32_to_cpu(data[1]) << 32) |
				fdt32_to_cpu(data[2]);

		if (nr_range_cells == 6) {
			as->start = fdt32_to_cpu(data[3]);
			as->size  = ((u64)fdt32_to_cpu(data[4]) << 32) |
				    fdt32_to_cpu(data[5]);
		} else {
			as->start = ((u64)fdt32_to_cpu(data[3]) << 32) |
				    fdt32_to_cpu(data[4]);
			as->size  = ((u64)fdt32_to_cpu(data[5]) << 32) |
				    fdt32_to_cpu(data[6]);
		}

		data += nr_range_cells;
		as++;
	}

	return host;
}

static bool pci_alloc_resource(struct pci_dev *dev, int bar_num, u64 *addr)
{
	struct pci_host_bridge *host = pci_host_bridge;
	struct pci_addr_space *as = &host->addr_space[0];
	u32 bar;
	u64 size, pci_addr;
	int type, i;

	*addr = INVALID_PHYS_ADDR;

	size = pci_bar_size(dev, bar_num);
	if (!size)
		return false;

	bar = pci_bar_get(dev, bar_num);
	type = pci_bar_type(bar);
	if (type & PCI_BASE_ADDRESS_MEM_TYPE_MASK)
		type &= ~PCI_BASE_ADDRESS_MEM_PREFETCH;

	for (i = 0; i < host->nr_addr_spaces; i++) {
		if (as->type == type)
			break;
		as++;
	}

	if (i >= host->nr_addr_spaces) {
		printf("%s: warning: can't satisfy request for ", __func__);
		pci_dev_print_id(dev);
		printf(" ");
		pci_bar_print(dev, bar_num);
		printf("\n");
		return false;
	}

	pci_addr = ALIGN(as->pci_start + as->allocated, size);
	size += pci_addr - (as->pci_start + as->allocated);
	assert(as->allocated + size <= as->size);
	*addr = pci_addr;
	as->allocated += size;

	return true;
}

bool pci_probe(void)
{
	struct pci_dev pci_dev;
	pcidevaddr_t dev;
	u8 header;
	u32 cmd;
	int i;

	assert(!pci_host_bridge);
	pci_host_bridge = pci_dt_probe();
	if (!pci_host_bridge)
		return false;

	for (dev = 0; dev < PCI_DEVFN_MAX; dev++) {
		if (!pci_dev_exists(dev))
			continue;

		pci_dev_init(&pci_dev, dev);

		/* We are only interested in normal PCI devices */
		header = pci_config_readb(dev, PCI_HEADER_TYPE);
		if ((header & PCI_HEADER_TYPE_MASK) != PCI_HEADER_TYPE_NORMAL)
			continue;

		cmd = PCI_COMMAND_SERR | PCI_COMMAND_PARITY;

		for (i = 0; i < PCI_BAR_NUM; i++) {
			u64 addr;

			if (pci_alloc_resource(&pci_dev, i, &addr)) {
				pci_bar_set_addr(&pci_dev, i, addr);

				if (pci_bar_is_memory(&pci_dev, i))
					cmd |= PCI_COMMAND_MEMORY;
				else
					cmd |= PCI_COMMAND_IO;
			}

			if (pci_bar_is64(&pci_dev, i))
				i++;
		}

		pci_config_writew(dev, PCI_COMMAND, cmd);
	}

	return true;
}

/*
 * This function is to be called from pci_translate_addr() to provide
 * mapping between this host bridge's PCI busses address and CPU physical
 * address.
 */
phys_addr_t pci_host_bridge_get_paddr(u64 pci_addr)
{
	struct pci_host_bridge *host = pci_host_bridge;
	struct pci_addr_space *as = &host->addr_space[0];
	int i;

	for (i = 0; i < host->nr_addr_spaces; i++) {
		if (pci_addr >= as->pci_start &&
		    pci_addr < as->pci_start + as->size)
			return as->start + (pci_addr - as->pci_start);
		as++;
	}

	return INVALID_PHYS_ADDR;
}

static void __iomem *pci_get_dev_conf(struct pci_host_bridge *host, int devfn)
{
	return (void __iomem *)(unsigned long)
		host->start + (devfn << PCI_ECAM_DEVFN_SHIFT);
}

u8 pci_config_readb(pcidevaddr_t dev, u8 off)
{
	void __iomem *conf = pci_get_dev_conf(pci_host_bridge, dev);
	return readb(conf + off);
}

u16 pci_config_readw(pcidevaddr_t dev, u8 off)
{
	void __iomem *conf = pci_get_dev_conf(pci_host_bridge, dev);
	return readw(conf + off);
}

u32 pci_config_readl(pcidevaddr_t dev, u8 off)
{
	void __iomem *conf = pci_get_dev_conf(pci_host_bridge, dev);
	return readl(conf + off);
}

void pci_config_writeb(pcidevaddr_t dev, u8 off, u8 val)
{
	void __iomem *conf = pci_get_dev_conf(pci_host_bridge, dev);
	writeb(val, conf + off);
}

void pci_config_writew(pcidevaddr_t dev, u8 off, u16 val)
{
	void __iomem *conf = pci_get_dev_conf(pci_host_bridge, dev);
	writew(val, conf + off);
}

void pci_config_writel(pcidevaddr_t dev, u8 off, u32 val)
{
	void __iomem *conf = pci_get_dev_conf(pci_host_bridge, dev);
	writel(val, conf + off);
}
