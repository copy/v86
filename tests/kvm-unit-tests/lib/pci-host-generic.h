#ifndef PCI_HOST_GENERIC_H
#define PCI_HOST_GENERIC_H
/*
 * PCI host bridge supporting structures and constants
 *
 * Copyright (C) 2016, Red Hat Inc, Alexander Gordeev <agordeev@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

struct pci_addr_space {
	phys_addr_t		pci_start;
	phys_addr_t		start;
	phys_addr_t		size;
	phys_addr_t		allocated;
	int			type;
};

struct pci_host_bridge {
	phys_addr_t		start;
	phys_addr_t		size;
	int			bus;
	int			bus_max;
	int			nr_addr_spaces;
	struct pci_addr_space	addr_space[];
};

/*
 * The following constants are derived from Linux, see this source:
 *
 *         drivers/pci/host/pci-host-generic.c
 *                 struct gen_pci_cfg_bus_ops::bus_shift
 *                 int gen_pci_parse_map_cfg_windows(struct gen_pci *pci)
 *
 * Documentation/devicetree/bindings/pci/host-generic-pci.txt describes
 * ECAM Configuration Space is be memory-mapped by concatenating the various
 * components to form an offset:
 *
 *	cfg_offset(bus, device, function, register) =
 *		   bus << 20 | device << 15 | function << 12 | register
 */
#define PCI_ECAM_BUS_SHIFT	20
#define PCI_ECAM_DEVFN_SHIFT	12

#endif
