#ifndef ASM_PCI_H
#define ASM_PCI_H
/*
 * Copyright (C) 2013, Red Hat Inc, Michael S. Tsirkin <mst@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "pci.h"
#include "x86/asm/io.h"

#define PCI_CONF1_ADDRESS(dev, reg)	((0x1 << 31) | (dev << 8) | reg)

static inline uint8_t pci_config_readb(pcidevaddr_t dev, uint8_t reg)
{
    outl(PCI_CONF1_ADDRESS(dev, reg), 0xCF8);
    return inb(0xCFC);
}

static inline uint16_t pci_config_readw(pcidevaddr_t dev, uint8_t reg)
{
    outl(PCI_CONF1_ADDRESS(dev, reg), 0xCF8);
    return inw(0xCFC);
}

static inline uint32_t pci_config_readl(pcidevaddr_t dev, uint8_t reg)
{
    outl(PCI_CONF1_ADDRESS(dev, reg), 0xCF8);
    return inl(0xCFC);
}

static inline void pci_config_writeb(pcidevaddr_t dev, uint8_t reg,
                                     uint8_t val)
{
    outl(PCI_CONF1_ADDRESS(dev, reg), 0xCF8);
    outb(val, 0xCFC);
}

static inline void pci_config_writew(pcidevaddr_t dev, uint8_t reg,
                                     uint16_t val)
{
    outl(PCI_CONF1_ADDRESS(dev, reg), 0xCF8);
    outw(val, 0xCFC);
}

static inline void pci_config_writel(pcidevaddr_t dev, uint8_t reg,
                                     uint32_t val)
{
    outl(PCI_CONF1_ADDRESS(dev, reg), 0xCF8);
    outl(val, 0xCFC);
}

static inline
phys_addr_t pci_translate_addr(pcidevaddr_t dev __unused, uint64_t addr)
{
    return addr;
}

#endif
