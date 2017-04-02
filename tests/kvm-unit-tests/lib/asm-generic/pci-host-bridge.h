#ifndef _ASM_PCI_HOST_BRIDGE_H_
#define _ASM_PCI_HOST_BRIDGE_H_
/*
 * Copyright (C) 2016, Red Hat Inc, Alexander Gordeev <agordeev@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

phys_addr_t pci_host_bridge_get_paddr(uint64_t addr);

static inline
phys_addr_t pci_translate_addr(pcidevaddr_t dev __unused, uint64_t addr)
{
	/*
	 * Assume we only have single PCI host bridge in a system.
	 */
	return pci_host_bridge_get_paddr(addr);
}

uint8_t pci_config_readb(pcidevaddr_t dev, uint8_t reg);
uint16_t pci_config_readw(pcidevaddr_t dev, uint8_t reg);
uint32_t pci_config_readl(pcidevaddr_t dev, uint8_t reg);
void pci_config_writeb(pcidevaddr_t dev, uint8_t reg, uint8_t val);
void pci_config_writew(pcidevaddr_t dev, uint8_t reg, uint16_t val);
void pci_config_writel(pcidevaddr_t dev, uint8_t reg, uint32_t val);

#endif
